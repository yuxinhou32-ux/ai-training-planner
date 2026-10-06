/**
 * 写回编排服务（T4，§6.3.3 确认流程 / §7 写入任务表）。
 *
 * 双栏杆（D11，代码级保证）：
 *   draft --approve--> approved --preview(纯本地校验)--> awaiting_confirm
 *   --confirm(confirmed===true)--> writing --> written | partial | failed | uncertain
 * 真实写入只发生在 confirmWrite / beginWrite+runWriteBatches 内部；不存在自动写入路径。
 *
 * 异步作业（2026-10-06 改造）：confirm 不再同步阻塞 ~263s。HTTP 段只跑 beginWrite
 * （准入检查 + 快照 + 状态转 writing + 取批次清单，秒级返回 job_id）；批次循环在
 * runWriteBatches 后台跑，前端轮询 job 进度。准入红线（confirmed===true / approved|uncertain /
 * awaiting_confirm）全部留在 beginWrite 同步段——用户点确认后立刻知道是否被拒。
 * 组合入口 confirmWrite（= beginWrite + runWriteBatches）保留原签名，测试与 CLI 走这条。
 * 崩溃兜底 recordWriteCrash、开机恢复 recoverStuckWrites 收纳 writing 悬空状态。
 *
 * 预演改为纯本地（2026-09-29 实测：服务端 dry_run 不生效，会真实写入）：
 *   选日 + C1~C10 校验 + payload 构造展示 → awaiting_confirm
 *   预演阶段零网络请求。
 *
 * 三态归并（2026-09-30 实测驱动）：实写响应 res.trains 恒为空数组——成功不回显
 * 与限频静默丢弃不可区分。批次落定规则：
 *   响应回显 localid → success（旧形态，防御保留）
 *   响应为空 → 等 WRITE_VERIFY_DELAY_MS 后 full 读回验证：
 *     命中同标题训练 → success（localid 从读回回填）
 *     该日无任何训练 → failed（确认被静默丢弃）
 *     读回限频/异常/形态异常 → uncertain（人工到 App 核实，绝不自动重写）
 *
 * 逃逸出口：plan 状态为 uncertain 时允许重新预演与确认（如用户核实后确有缺日）；
 * 已写入日期由 skip_existing（本地 train_session）与服务端拒绝兜底防护。
 *
 * 窗口约束（用户规则，2026-09-29 拍板）：
 *   只写 [max(plan.week_start, 明天), plan.week_end] 的训练日；已有训记记录的日期
 *   一律跳过不覆盖（不碰历史/既存事实）；本服务不生成计划，只消费已有 plan。
 *
 * 限频：写侧 65s（WRITE_COOL_DOWN_MS，实测 45s 整会静默丢请求，取 65s 余量）；
 * 批次严格串行；sleep 可注入（测试零等待）。
 */
import type { Db } from '../db/index.js';
import { inTransaction, prepare } from '../db/index.js';
import { PlanServiceError } from './planService.js';
import { backupDb, defaultBackupPath } from '../db/backup.js';
import { READ_PATH, WRITE_COOL_DOWN_MS, WRITE_VERIFY_DELAY_MS } from '../config/constants.js';
import {
  buildTrainFromPlanDay,
  clientRequestId,
  sendBatch,
  validateTrain,
  type BatchSendResult,
  type Violation,
  type WriteTrain,
} from '../xunji/writer.js';
import type { XunjiHttpClient } from '../xunji/client.js';
import { NotificationRepo } from '../repo/notificationRepo.js';

const nowIso = (): string => new Date().toISOString();

function addDays(datestr: string, n: number): string {
  const d = new Date(`${datestr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export interface WriteDeps {
  client: XunjiHttpClient;
  /** SQLite 库文件路径（确认写入前自动 VACUUM INTO 快照，§6.3.6）。null=跳过备份（仅测试）。 */
  dbPath: string | null;
}

export interface SleepFn {
  (ms: number): Promise<void>;
}

const realSleep: SleepFn = (ms) => new Promise((r) => setTimeout(r, ms));

export interface Opts {
  now?: Date;
  sleep?: SleepFn;
}

// ---------------------------------------------------------------------------
// 库读取
// ---------------------------------------------------------------------------

interface PlanStatusRow {
  id: number;
  week_start: string;
  week_end: string;
  status: string;
}

function getPlanStatus(db: Db, planId: number): PlanStatusRow {
  const row = prepare(db, `SELECT id, week_start, week_end, status FROM plan WHERE id = ?`).get(planId) as unknown as
    | PlanStatusRow
    | undefined;
  if (!row) throw new PlanServiceError(404, `计划 #${planId} 不存在`);
  return row;
}

interface ExerciseForWrite {
  name: string;
  sets: number;
  reps: number | null;
  weight_kg: number | null;
  is_cardio: 0 | 1;
}

interface DayForWrite {
  plan_day_id: number;
  datestr: string;
  title: string;
  est_duration_min: number | null;
  exercises: ExerciseForWrite[];
}

function loadWindowDays(db: Db, planId: number, windowStart: string, windowEnd: string): DayForWrite[] {
  const rows = prepare(
    db,
    `SELECT pd.id AS plan_day_id, pd.datestr, pd.title, pd.est_duration_min, pe.name, pe.sets,
            pe.reps, pe.weight_kg, pe.is_cardio
     FROM plan_day pd JOIN plan_exercise pe ON pe.plan_day_id = pd.id
     WHERE pd.plan_id = ? AND pd.datestr >= ? AND pd.datestr <= ?
     ORDER BY pd.datestr, pd.ord, pe.ord`,
  ).all(planId, windowStart, windowEnd) as unknown as Array<{
    plan_day_id: number;
    datestr: string;
    title: string;
    est_duration_min: number | null;
    name: string;
    sets: number;
    reps: number | null;
    weight_kg: number | null;
    is_cardio: 0 | 1;
  }>;
  const byDay = new Map<number, DayForWrite>();
  for (const r of rows) {
    let day = byDay.get(Number(r.plan_day_id));
    if (!day) {
      day = {
        plan_day_id: Number(r.plan_day_id),
        datestr: r.datestr,
        title: r.title,
        est_duration_min: r.est_duration_min === null ? null : Number(r.est_duration_min),
        exercises: [],
      };
      byDay.set(Number(r.plan_day_id), day);
    }
    day.exercises.push({
      name: r.name,
      sets: Number(r.sets),
      reps: r.reps === null ? null : Number(r.reps),
      weight_kg: r.weight_kg === null ? null : Number(r.weight_kg),
      is_cardio: r.is_cardio,
    });
  }
  return [...byDay.values()];
}

function existingLocalid(db: Db, datestr: string): string | null {
  const row = prepare(db, `SELECT localid FROM train_session WHERE datestr = ? AND localid IS NOT NULL LIMIT 1`).get(
    datestr,
  ) as unknown as { localid: string | null } | undefined;
  return row?.localid != null ? String(row.localid) : null;
}

// ---------------------------------------------------------------------------
// 第一道栏杆：approve（draft → approved）
// ---------------------------------------------------------------------------

/**
 * 计划状态的中文标签。用于错误文案 —— 直接把英文状态码插进中文句子
 * （如「计划当前状态为 approved」）会造成中英混排，用户看着费解。
 * 前端 `PlanConfirm.tsx` 的 STATUS_LABEL 是展示用（带配色），这里是文案用（纯文本）。
 */
const PLAN_STATUS_CN: Record<string, string> = {
  draft: '草稿',
  approved: '已批准',
  writing: '写入中',
  written: '已写入',
  partial: '部分写入',
  failed: '写入失败',
  uncertain: '待核实',
  archived: '已归档',
};

function statusCn(status: string): string {
  const cn = PLAN_STATUS_CN[status];
  return cn === undefined ? status : `${cn}（${status}）`;
}

export function approvePlan(db: Db, planId: number, opts: Opts = {}): { planId: number; status: string } {
  const plan = getPlanStatus(db, planId);
  if (plan.status !== 'draft') {
    throw new PlanServiceError(409, `计划当前状态为「${statusCn(plan.status)}」，只有草稿（draft）可以批准`);
  }
  const ts = (opts.now ?? new Date()).toISOString();
  prepare(db,`UPDATE plan SET status = 'approved', approved_at = ?, updated_at = ? WHERE id = ?`).run(ts, ts, planId);
  return { planId, status: 'approved' };
}

// ---------------------------------------------------------------------------
// 预演：窗口选日 → 构造 payload → 校验 → 逐批 dry_run → awaiting_confirm
// ---------------------------------------------------------------------------

export interface DayPreview {
  plan_day_id: number;
  datestr: string;
  title: string;
  action: 'create' | 'skip_existing';
  moves: number;
  sets: number;
  existing_localid: string | null;
}

export interface BatchOutcome {
  batch_no: number;
  datestr: string;
  title: string;
  client_request_id: string;
  status: string;
  error: string | null;
  localid_after: string | null;
}

export interface JobSummary {
  job_id: number;
  plan_id: number;
  status: string;
  total_batches: number;
  finished_batches: number;
  window: { start: string; end: string };
  days: DayPreview[];
  batches: BatchOutcome[];
}

function summarize(db: Db, jobId: number, planId: number, window: { start: string; end: string }, days: DayPreview[]): JobSummary {
  const job = prepare(db, `SELECT status, total_batches, finished_batches FROM sync_write_job WHERE id = ?`).get(jobId) as unknown as {
    status: string;
    total_batches: number;
    finished_batches: number;
  };
  const batches = prepare(
    db,
    `SELECT wb.batch_no, wb.datestr, wb.client_request_id, wb.status, wb.error_msg,
            pd.title, wi.localid_after
     FROM write_batch wb
     JOIN plan_day pd ON pd.plan_id = ? AND pd.datestr = wb.datestr
     LEFT JOIN write_item wi ON wi.batch_id = wb.id
     WHERE wb.job_id = ? ORDER BY wb.batch_no`,
  ).all(planId, jobId) as unknown as Array<{
    batch_no: number;
    datestr: string;
    client_request_id: string;
    status: string;
    error_msg: string | null;
    title: string;
    localid_after: string | null;
  }>;
  return {
    job_id: jobId,
    plan_id: planId,
    status: job.status,
    total_batches: Number(job.total_batches),
    finished_batches: Number(job.finished_batches),
    window,
    days,
    batches: batches.map((b) => ({
      batch_no: Number(b.batch_no),
      datestr: b.datestr,
      title: b.title,
      client_request_id: b.client_request_id,
      status: b.status,
      error: b.error_msg,
      localid_after: b.localid_after,
    })),
  };
}

export function createPreview(db: Db, deps: WriteDeps, planId: number, opts: Opts = {}): JobSummary {
  void deps; // 预演纯本地，不发网络请求；deps 仅供 confirmWrite 使用
  const plan = getPlanStatus(db, planId);
  if (plan.status !== 'approved' && plan.status !== 'uncertain') {
    throw new PlanServiceError(409, `计划当前状态为「${statusCn(plan.status)}」，请先批准（approve）再预演；待核实（uncertain）计划核实后可直接重新预演`);
  }
  // 清掉同计划旧的待确认/失败预演（幂等键随内容走；writing/success/uncertain 作业不动，保留审计）
  prepare(db,`DELETE FROM sync_write_job WHERE plan_id = ? AND status IN ('awaiting_confirm','failed','cancelled')`).run(planId);

  const now = opts.now ?? new Date();
  const today = now.toISOString().slice(0, 10);
  const tomorrow = addDays(today, 1);
  const window = { start: plan.week_start > tomorrow ? plan.week_start : tomorrow, end: plan.week_end };

  const candidates = loadWindowDays(db, planId, window.start, window.end);
  const days: DayPreview[] = [];
  const toWrite: Array<{ day: DayForWrite; train: WriteTrain }> = [];
  for (const day of candidates) {
    const exist = existingLocalid(db, day.datestr);
    const sets = day.exercises.reduce((acc, e) => acc + (e.is_cardio ? 0 : e.sets), 0);
    if (exist !== null) {
      // 用户规则：已有训记记录的日期一律跳过，绝不覆盖（防误改历史/既存事实）
      days.push({
        plan_day_id: day.plan_day_id,
        datestr: day.datestr,
        title: day.title,
        action: 'skip_existing',
        moves: day.exercises.length,
        sets,
        existing_localid: exist,
      });
      continue;
    }
    days.push({
      plan_day_id: day.plan_day_id,
      datestr: day.datestr,
      title: day.title,
      action: 'create',
      moves: day.exercises.length,
      sets,
      existing_localid: null,
    });
    const { train } = buildTrainFromPlanDay({
      datestr: day.datestr,
      title: day.title,
      estDurationMin: day.est_duration_min,
      exercises: day.exercises,
    });
    toWrite.push({ day, train });
  }

  if (toWrite.length === 0) {
    throw new PlanServiceError(400, `窗口 ${window.start}~${window.end} 内没有可写入的训练日（无计划日，或日期已有训记记录被跳过）`);
  }
  const cardioDays = toWrite.filter((w) => w.train.movements.some((m) => m.cardio));
  if (cardioDays.length > 0) {
    throw new PlanServiceError(
      400,
      `有氧动作的写入格式（C6）尚未经真实写入验证，本期阻断：${cardioDays.map((w) => w.day.datestr).join('、')}。如需有氧请先在训记 App 手动建卡。`,
    );
  }

  // 写前校验 C1~C10（任一违例 → 整体阻断，不发送）
  const violations: Violation[] = [];
  for (const w of toWrite) violations.push(...validateTrain(w.train, { todayLocal: today, trainCount: 1 }));
  if (violations.length > 0) {
    throw new PlanServiceError(400, `写前校验未通过：${violations.map((x) => `${x.code}: ${x.message}`).join('；')}`);
  }

  // 建作业 + 批次（每批 = 1 天 1 条；「同批必须同天」天然满足）
  // 预演 = 纯本地：选日 + 校验已通过，批次直接标 dry_run_ok（零网络请求）
  const createdAt = now.toISOString();
  const jobIns = prepare(
    db,
    `INSERT INTO sync_write_job (plan_id, status, total_batches, finished_batches, created_at, finished_at)
     VALUES (?, 'awaiting_confirm', ?, ?, ?, ?)`,
  ).run(planId, toWrite.length, toWrite.length, createdAt, createdAt);
  const jobId = Number(jobIns.lastInsertRowid);

  let batchNo = 0;
  for (const w of toWrite) {
    batchNo += 1;
    const requestId = clientRequestId(planId, w.day.datestr, batchNo, [w.train]);
    prepare(
      db,
      `INSERT INTO write_batch (job_id, batch_no, datestr, client_request_id, status, train_count, request_json, attempts, created_at, finished_at)
       VALUES (?, ?, ?, ?, 'dry_run_ok', 1, ?, 0, ?, ?)`,
    ).run(jobId, batchNo, w.day.datestr, requestId, JSON.stringify([w.train]), createdAt, createdAt);
    prepare(db,`UPDATE plan_day SET write_status = 'dry_run_ok' WHERE id = ? AND write_status IS NULL`).run(w.day.plan_day_id);
  }

  return summarize(db, jobId, planId, window, days);
}

// ---------------------------------------------------------------------------
// 读回验证（2026-09-30 实测：实写响应空数组语义未知，full 读回是唯一可信判定）
// ---------------------------------------------------------------------------

type ReadBackState = 'confirmed' | 'absent' | 'inconclusive';

interface ReadBackResult {
  state: ReadBackState;
  localid: string | null;
  detail: string | null;
}

/** full 模式读回指定日期，按训练标题判定写入是否落库。 */
async function readBackVerify(client: XunjiHttpClient, datestr: string, title: string): Promise<ReadBackResult> {
  let r;
  try {
    // buildReadBody 固定 include_full_data:true（light 模式看不到未来计划，实测假象之源）
    r = await client.post(READ_PATH, client.buildReadBody(datestr));
  } catch (e) {
    return { state: 'inconclusive', localid: null, detail: `读回请求异常：${e instanceof Error ? e.message : String(e)}` };
  }
  if (r.parseError !== null) return { state: 'inconclusive', localid: null, detail: `读回响应解析失败：${r.parseError}` };
  if (r.httpStatus >= 400) return { state: 'inconclusive', localid: null, detail: `读回 HTTP ${r.httpStatus}` };
  const obj = (r.json ?? {}) as { res?: unknown; error?: unknown };
  const errText = obj.error === undefined || obj.error === null ? null : String(obj.error);
  if (errText && /too frequent/i.test(errText)) {
    return { state: 'inconclusive', localid: null, detail: `读回被限频：${errText}` };
  }
  const res = obj.res;
  const trains: Array<Record<string, unknown>> | null = Array.isArray(res)
    ? (res as Array<Record<string, unknown>>)
    : res && typeof res === 'object' && Array.isArray((res as { trains?: unknown }).trains)
      ? ((res as { trains: Array<Record<string, unknown>> }).trains)
      : null;
  if (trains === null) return { state: 'inconclusive', localid: null, detail: '读回响应形态异常（缺 res.trains）' };
  const hit = trains.find((t) => String(t.title ?? '') === title);
  if (hit !== undefined) {
    const lid = hit.localid === undefined || hit.localid === null ? null : String(hit.localid);
    return { state: 'confirmed', localid: lid, detail: null };
  }
  if (trains.length === 0) return { state: 'absent', localid: null, detail: '读回该日无任何训练——判定写入被服务端静默丢弃' };
  return { state: 'inconclusive', localid: null, detail: `该日存在 ${trains.length} 条训练但标题均非「${title}」` };
}

// ---------------------------------------------------------------------------
// 第二道栏杆：confirm（approved/uncertain + awaiting_confirm + confirmed===true → 真实写入）
// ---------------------------------------------------------------------------

export interface ConfirmResult {
  job_id: number;
  plan_id: number;
  plan_status: string;
  backup_path: string | null;
  batches: BatchOutcome[];
}

/** 批次清单行（beginWrite 取出、runWriteBatches 消费）。 */
export interface WriteBatchRow {
  batch_no: number;
  datestr: string;
  client_request_id: string;
  request_json: string;
  plan_day_id: number;
  title: string;
}

/** beginWrite 的同步返回：立即回给前端的作业摘要（终态由轮询 job 得到）。 */
export interface BeginWriteResult {
  job_id: number;
  plan_id: number;
  total_batches: number;
  backup_path: string | null;
  plan_status: 'writing';
}

/**
 * 第一段（同步，在 HTTP 请求内跑完）：全部准入检查 → 快照 → 状态转 writing → 取出批次清单。
 * 绝不跑批次循环——批次循环在 runWriteBatches（后台）。准入检查全部留在同步段：
 * 用户点确认后必须立刻知道他这一步有没有被拒（400/409 仍是同步 HTTP 错误）。
 */
export function beginWrite(
  db: Db,
  deps: WriteDeps,
  planId: number,
  confirmed: unknown,
  opts: Opts = {},
): { result: BeginWriteResult; batches: WriteBatchRow[] } {
  if (confirmed !== true) throw new PlanServiceError(400, '缺少 confirmed=true，拒绝写入（第二道栏杆）');
  const plan = getPlanStatus(db, planId);
  if (plan.status !== 'approved' && plan.status !== 'uncertain') {
    throw new PlanServiceError(409, `计划当前状态为「${statusCn(plan.status)}」，只有已批准（approved）或待核实（uncertain）的计划可以确认写入`);
  }
  const jobRow = prepare(
    db,
    `SELECT id, status FROM sync_write_job WHERE plan_id = ? ORDER BY id DESC LIMIT 1`,
  ).get(planId) as unknown as { id: number; status: string } | undefined;
  if (!jobRow || jobRow.status !== 'awaiting_confirm') {
    throw new PlanServiceError(409, '没有通过预演的写入作业（先执行预演，且预演全部通过）');
  }

  // 写入前自我保护：VACUUM INTO 快照（§6.3.6）
  let backupPath: string | null = null;
  if (deps.dbPath !== null) {
    backupPath = defaultBackupPath(deps.dbPath, opts.now ?? new Date());
    backupDb(db, backupPath);
  }

  // 🔴 plan 与 sync_write_job 的状态必须原子更新：两条相邻 UPDATE 若被杀在中间，
  //    会留下 plan=writing 而 job=awaiting_confirm 的不对称，使该 plan 被 createPreview/
  //    beginWrite 的准入永久拒绝（准入只收 approved/uncertain）→ 死锁。
  //    快照 VACUUM INTO 已在上方事务外完成（VACUUM 不能在事务内执行）。
  const startedAt = nowIso();
  inTransaction(db, () => {
    prepare(db, `UPDATE plan SET status = 'writing', updated_at = ? WHERE id = ?`).run(startedAt, planId);
    // finished_batches 归零：createPreview 把它预置成 total_batches（预演即「完成」），
    // 若不归零，写入一启动进度条就显示 100%。进入 writing 应以 0 起步。
    prepare(
      db,
      `UPDATE sync_write_job SET status = 'writing', started_at = ?, finished_batches = 0 WHERE id = ?`,
    ).run(startedAt, jobRow.id);
  });

  const batches = prepare(
    db,
    `SELECT wb.batch_no, wb.datestr, wb.client_request_id, wb.request_json, pd.id AS plan_day_id, pd.title
     FROM write_batch wb JOIN plan_day pd ON pd.plan_id = ? AND pd.datestr = wb.datestr
     WHERE wb.job_id = ? AND wb.status = 'dry_run_ok'
     ORDER BY wb.batch_no`,
  ).all(planId, jobRow.id) as unknown as WriteBatchRow[];

  return {
    result: {
      job_id: jobRow.id,
      plan_id: planId,
      total_batches: batches.length,
      backup_path: backupPath,
      plan_status: 'writing',
    },
    batches,
  };
}

/**
 * 第二段（异步，后台跑）：批次循环 + 收尾（job/plan 状态、终态通知）。
 *
 * 快照已在 beginWrite 完成，此处不重复备份：返回值的 backup_path 恒为 null，
 * 权威值见 BeginWriteResult（路由）与 confirmWrite 的组合覆盖（测试/CLI）。
 */
export async function runWriteBatches(
  db: Db,
  deps: WriteDeps,
  planId: number,
  jobId: number,
  batches: WriteBatchRow[],
  opts: Opts = {},
): Promise<ConfirmResult> {
  const sleep = opts.sleep ?? realSleep;

  let okCount = 0;
  let uncertainCount = 0;
  const outcomes: BatchOutcome[] = [];
  for (let i = 0; i < batches.length; i++) {
    const b = batches[i];
    if (i > 0) await sleep(WRITE_COOL_DOWN_MS);
    const trains = JSON.parse(b.request_json) as WriteTrain[];
    let result: BatchSendResult;
    try {
      result = await sendBatch(deps.client, trains, b.client_request_id, false);
    } catch (e) {
      result = { ok: false, uncertain: false, rateLimited: false, localids: [], errorCode: 'EXCEPTION', errorMessage: e instanceof Error ? e.message : String(e), raw: null };
    }

    // 三态归并：回显 localid → success；空响应 → 读回验证；其余 → failed
    let status: 'success' | 'failed' | 'uncertain';
    let errorCode: string | null = null;
    let errorMsg: string | null = null;
    let localidAfter: string | null = null;
    let rawForDb: unknown = result.raw;
    let itemMessage: string | null = null;

    if (result.ok) {
      status = 'success';
      localidAfter = result.localids.length > 0 ? result.localids[0] || null : null;
    } else if (result.uncertain) {
      // 实写响应为空：等一个保守间隔后 full 读回验证（写→读限频关系未实测）
      await sleep(WRITE_VERIFY_DELAY_MS);
      const rb = await readBackVerify(deps.client, b.datestr, trains[0]?.title ?? '');
      if (rb.state === 'confirmed') {
        status = 'success';
        localidAfter = rb.localid;
        rawForDb = { write_response: result.raw, readback: 'confirmed' };
        itemMessage = '实写响应为空，full 读回命中同标题训练，判定成功';
      } else if (rb.state === 'absent') {
        status = 'failed';
        errorCode = 'READBACK_ABSENT';
        errorMsg = rb.detail;
      } else {
        status = 'uncertain';
        errorCode = 'READBACK_INCONCLUSIVE';
        errorMsg = rb.detail;
      }
    } else {
      status = 'failed';
      errorCode = result.errorCode;
      errorMsg = result.errorMessage;
    }

    const finishedAt = nowIso();
    if (status === 'success') {
      okCount += 1;
prepare(
      db,
        `UPDATE write_batch SET status = 'success', response_json = ?, attempts = attempts + 1, finished_at = ? WHERE job_id = ? AND batch_no = ?`,
      ).run(JSON.stringify(rawForDb).slice(0, 32_000), finishedAt, jobId, b.batch_no);
      prepare(db,`UPDATE plan_day SET localid = ?, write_status = 'success' WHERE id = ?`).run(localidAfter, b.plan_day_id);
prepare(
      db,
        `INSERT INTO write_item (batch_id, plan_day_id, ord, action, localid_before, localid_after, result, message, created_at)
         SELECT id, ?, 1, 'create', NULL, ?, 'success', ?, ? FROM write_batch WHERE job_id = ? AND batch_no = ?`,
      ).run(b.plan_day_id, localidAfter, itemMessage, finishedAt, jobId, b.batch_no);
    } else if (status === 'uncertain') {
      // 结果未知：绝不自动重写（重写有重复计划风险），留给人工核实
      uncertainCount += 1;
prepare(
      db,
        `UPDATE write_batch SET status = 'uncertain', error_code = ?, error_msg = ?, response_json = ?, attempts = attempts + 1, finished_at = ? WHERE job_id = ? AND batch_no = ?`,
      ).run(errorCode, errorMsg, JSON.stringify(rawForDb).slice(0, 32_000), finishedAt, jobId, b.batch_no);
      prepare(db,`UPDATE plan_day SET write_status = 'uncertain' WHERE id = ? AND write_status IS NOT 'success'`).run(b.plan_day_id);
prepare(
      db,
        `INSERT INTO write_item (batch_id, plan_day_id, ord, action, localid_before, localid_after, result, message, created_at)
         SELECT id, ?, 1, 'create', NULL, NULL, 'uncertain', ?, ? FROM write_batch WHERE job_id = ? AND batch_no = ?`,
      ).run(b.plan_day_id, `${errorCode}: ${errorMsg}`, finishedAt, jobId, b.batch_no);
    } else {
prepare(
      db,
        `UPDATE write_batch SET status = 'failed', error_code = ?, error_msg = ?, response_json = ?, attempts = attempts + 1, finished_at = ? WHERE job_id = ? AND batch_no = ?`,
      ).run(errorCode, errorMsg, JSON.stringify(rawForDb).slice(0, 32_000), finishedAt, jobId, b.batch_no);
      prepare(db,`UPDATE plan_day SET write_status = 'failed' WHERE id = ?`).run(b.plan_day_id);
prepare(
      db,
        `INSERT INTO write_item (batch_id, plan_day_id, ord, action, localid_before, localid_after, result, message, created_at)
         SELECT id, ?, 1, 'create', NULL, NULL, 'failed', ?, ? FROM write_batch WHERE job_id = ? AND batch_no = ?`,
      ).run(b.plan_day_id, `${errorCode}: ${errorMsg}`, finishedAt, jobId, b.batch_no);
    }
    outcomes.push({
      batch_no: Number(b.batch_no),
      datestr: b.datestr,
      title: b.title,
      client_request_id: b.client_request_id,
      status,
      error: status === 'success' ? null : `${errorCode}: ${errorMsg}`,
      localid_after: localidAfter,
    });
    prepare(db,`UPDATE sync_write_job SET finished_batches = ? WHERE id = ?`).run(i + 1, jobId);
  }

  const total = batches.length;
  const finalStatus =
    okCount === total && total > 0 ? 'success'
    : okCount === 0 && uncertainCount === total ? 'uncertain'
    : okCount === 0 && uncertainCount === 0 ? 'failed'
    : 'partial'; // 混合结果（含 uncertain 的混合）统一按 partial 呈现，批次明细看三态
  const planStatus = finalStatus === 'success' ? 'written' : finalStatus; // success|partial|failed|uncertain
  const finishedAt = nowIso();
  // 🔴 job 与 plan 的终态必须原子落地：两条相邻 UPDATE 若被杀在中间，会留下
  //    plan=writing 而 job 已终态的不对称。通知在事务外（附加信息，状态一致优先）。
  inTransaction(db, () => {
    prepare(db, `UPDATE sync_write_job SET status = ?, finished_at = ? WHERE id = ?`).run(finalStatus, finishedAt, jobId);
    prepare(db, `UPDATE plan SET status = ?, confirmed_at = ?, updated_at = ? WHERE id = ?`).run(planStatus, finishedAt, finishedAt, planId);
  });

  notifyWriteTerminal(db, jobId, finalStatus, outcomes);

  return { job_id: jobId, plan_id: planId, plan_status: planStatus, backup_path: null, batches: outcomes };
}

/**
 * 终态通知：异步后用户可能已关页面/合盖，终态必须留痕（success 沿用项目惯例不打扰）。
 * detail 拼批次摘要，失败/待核实的批次逐个列出，便于事后人工核实。
 */
function notifyWriteTerminal(db: Db, jobId: number, finalStatus: string, outcomes: BatchOutcome[]): void {
  if (finalStatus === 'success') return;
  const level = finalStatus === 'failed' ? 'error' : 'warn';
  const title =
    finalStatus === 'partial' ? '写入训记部分完成'
    : finalStatus === 'uncertain' ? '写入训记结果待核实'
    : '写入训记失败';
  const done = outcomes.filter((o) => o.status === 'success').length;
  const problems = outcomes.filter((o) => o.status !== 'success');
  const detail =
    problems.length === 0
      ? `已完成 ${done}/${outcomes.length} 批`
      : `已完成 ${done}/${outcomes.length} 批；失败：${problems.map((p) => `${p.datestr} ${p.error ?? p.status}`).join('；')}`;
  new NotificationRepo(db).add(level, title, detail, 'plan_write_job', String(jobId));
}

/**
 * 组合（保持既有 confirmWrite 对外签名，测试与 CLI 走这条）。
 * backup_path 覆盖：快照在 beginWrite 生成，runWriteBatches 不掌握该值，故此处回填权威路径。
 */
export async function confirmWrite(
  db: Db,
  deps: WriteDeps,
  planId: number,
  confirmed: unknown,
  opts: Opts = {},
): Promise<ConfirmResult> {
  const { result, batches } = beginWrite(db, deps, planId, confirmed, opts);
  const out = await runWriteBatches(db, deps, planId, result.job_id, batches, opts);
  return { ...out, backup_path: result.backup_path };
}

/**
 * 后台批次循环抛出未预期异常时，把作业与计划落定并通知，绝不让状态悬空。
 * 自身必须 try/catch 不抛（否则 .catch 里再抛会变成 unhandled rejection）。
 *
 * job 与 plan 的两条 UPDATE 包事务：这是第三处 plan↔job 相邻状态变更，
 * 若被杀在中间会留下 plan=writing 而 job=failed 的不对称（recoverStuckWrites 第二层可兜，
 * 但源头同样要堵）。通知留在事务外。
 */
export function recordWriteCrash(db: Db, planId: number, jobId: number, err: unknown): void {
  try {
    const msg = err instanceof Error ? err.message : String(err);
    const finishedAt = nowIso();
    inTransaction(db, () => {
      prepare(
        db,
        `UPDATE sync_write_job SET status = 'failed', error_json = ?, finished_at = ? WHERE id = ?`,
      ).run(JSON.stringify({ code: 'UNEXPECTED_CRASH', message: msg }).slice(0, 32_000), finishedAt, jobId);
      prepare(db, `UPDATE plan SET status = 'failed', updated_at = ? WHERE id = ?`).run(finishedAt, planId);
    });
    new NotificationRepo(db).add(
      'error',
      '写入训记失败',
      `后台批次循环异常中断：${msg}`,
      'plan_write_job',
      String(jobId),
    );
  } catch {
    // 兜底自身绝不能再抛
  }
}

// ---------------------------------------------------------------------------
// 开机恢复（异步改造后：进程在写入中途被杀是常见场景——用户合上笔记本）
// ---------------------------------------------------------------------------

/**
 * 🔴 开机恢复：上次进程在写入中途被杀，sync_write_job 与 plan 会永久停在 'writing'，
 * 而 createPreview / beginWrite 的准入只接受 approved/uncertain → 用户被死锁，
 * 既不能重新预演也不能重新确认，只能手改数据库。
 *
 * 两侧独立扫描（关键）：plan 与 sync_write_job 的状态是两条相邻 UPDATE，崩溃可卡在中间
 * 留下不对称 —— `plan=writing` 而 job 仍是 `awaiting_confirm`（beginWrite 半途被杀），
 * 或 job 已终态（runWriteBatches 半途被杀）。只按 job 反查会永久漏掉这些 plan（旧实现即此缺陷）。
 * 恢复函数自身也曾先改 job 后改 plan，故其内部 UPDATE 也必须包事务，否则恢复途中被杀会重现不对称。
 *
 * 恢复为 'uncertain'（不是 failed）：部分批次可能已写成功，结果未知，
 * 按既有哲学「结果未知绝不自动重写」交人工核实；uncertain 可重新预演（逃逸出口）。
 * 返回**去重后的 plan 数**（不是 job 行数）；为 0 时不写通知。
 *
 * 注：sync_write_job 无 error_code/error_msg 列（见 schema v3），错误信息落入 error_json。
 */
export function recoverStuckWrites(db: Db): number {
  const jobRows = prepare(
    db,
    `SELECT id, plan_id FROM sync_write_job WHERE status = 'writing'`,
  ).all() as unknown as Array<{ id: number; plan_id: number }>;
  const planRows = prepare(db, `SELECT id FROM plan WHERE status = 'writing'`).all() as unknown as Array<{ id: number }>;

  // 两侧并集：job 侧捞出「job 卡在 writing」的 plan，plan 侧捞出「plan 卡在 writing」的 plan（无论 job 何状态）
  const planIds = new Set<number>();
  for (const r of jobRows) planIds.add(Number(r.plan_id));
  for (const r of planRows) planIds.add(Number(r.id));
  if (planIds.size === 0) return 0;

  const finishedAt = nowIso();
  const errJson = JSON.stringify({
    code: 'PROCESS_INTERRUPTED',
    message: '进程在写入中途退出，结果未知；请到训记 App 核实该周，缺日再重新预演',
  }).slice(0, 32_000);

  // 每个 plan 的 job（若仍 writing）与 plan 一起置 uncertain —— 同一事务，杜绝再次不对称。
  // job 侧条件 status='writing'：不对称残留中 job 可能已是终态/awaiting_confirm，此时不动它。
  inTransaction(db, () => {
    for (const planId of planIds) {
      prepare(
        db,
        `UPDATE sync_write_job SET status = 'uncertain', error_json = ?, finished_at = ? WHERE plan_id = ? AND status = 'writing'`,
      ).run(errJson, finishedAt, planId);
      prepare(
        db,
        `UPDATE plan SET status = 'uncertain', updated_at = ? WHERE id = ? AND status = 'writing'`,
      ).run(finishedAt, planId);
    }
  });

  const n = planIds.size;
  new NotificationRepo(db).add(
    'warn',
    `恢复 ${n} 个中断的写入计划`,
    '上次进程在写入中途退出，相关计划已置为「待核实」。请到训记 App 核实该周实际写入情况，再决定是否重新预演。',
    'plan_write_job',
    null,
  );
  return n;
}

// ---------------------------------------------------------------------------
// 作业查询（UI 轮询用）
// ---------------------------------------------------------------------------

export function getWriteJob(db: Db, planId: number, opts: Opts = {}): JobSummary | null {
  const job = prepare(
    db,
    `SELECT id, status, total_batches, finished_batches FROM sync_write_job WHERE plan_id = ? ORDER BY id DESC LIMIT 1`,
  ).get(planId) as unknown as { id: number; status: string; total_batches: number; finished_batches: number } | undefined;
  if (!job) return null;
  const plan = getPlanStatus(db, planId);
  const today = (opts.now ?? new Date()).toISOString().slice(0, 10);
  const tomorrow = addDays(today, 1);
  const window = { start: plan.week_start > tomorrow ? plan.week_start : tomorrow, end: plan.week_end };
  const dayRows = loadWindowDays(db, planId, window.start, window.end);
  const days: DayPreview[] = dayRows.map((d) => {
    const exist = existingLocalid(db, d.datestr);
    const written = prepare(db, `SELECT localid, write_status FROM plan_day WHERE id = ?`).get(d.plan_day_id) as unknown as {
      localid: string | null;
      write_status: string | null;
    };
    return {
      plan_day_id: d.plan_day_id,
      datestr: d.datestr,
      title: d.title,
      action: exist !== null ? 'skip_existing' : 'create',
      moves: d.exercises.length,
      sets: d.exercises.reduce((acc, e) => acc + (e.is_cardio ? 0 : e.sets), 0),
      existing_localid: written.write_status === 'success' && written.localid ? written.localid : exist,
    };
  });
  return summarize(db, Number(job.id), planId, window, days);
}
