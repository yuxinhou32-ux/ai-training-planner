/**
 * 写回链路测试（T4）：writer 校验 + writeService 双栏杆编排。
 * 红线：零真实网络——传输层用 MockTransport；写入动作只在 mock 里发生。
 */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { describe, it } from 'node:test';
import {
  buildTrainFromPlanDay,
  clientRequestId,
  parseWriteResponse,
  validateTrain,
  WRITE_FUTURE_DAYS_LIMIT,
  type WriteTrain,
} from '../server/xunji/writer.js';
import { READ_PATH, WRITE_COOL_DOWN_MS, WRITE_VERIFY_DELAY_MS } from '../server/config/constants.js';
import { XunjiHttpClient } from '../server/xunji/client.js';
import { MockTransport, makeTempDb, makeEnvelope, makeTrain } from './fixtures.js';
import type { Db } from '../server/db/index.js';
import {
  approvePlan,
  beginWrite,
  confirmWrite,
  createPreview,
  getWriteJob,
  recordWriteCrash,
  recoverStuckWrites,
  runWriteBatches,
} from '../server/plan/writeService.js';
import { PlanServiceError } from '../server/plan/planService.js';
import { NotificationRepo } from '../server/repo/notificationRepo.js';

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

const NOW = new Date('2026-09-29T12:00:00+08:00'); // 周二；today=2026-09-29，明天=2026-09-30
const instantSleep = async (): Promise<void> => {};
/** 记录 sleep 调用（冷却/验证延迟断言用），零真实等待。 */
const recordingSleep = (log: number[]) => async (ms: number): Promise<void> => {
  log.push(ms);
};

interface SeedDay {
  datestr: string;
  title?: string;
  est?: number;
  exercises?: Array<{ name: string; sets: number; reps: number | null; weight: number | null }>;
}

function seedPlan(db: Db, weekStart: string, days: SeedDay[]): number {
  const weekEnd = new Date(new Date(`${weekStart}T00:00:00Z`).getTime() + 6 * 86_400_000).toISOString().slice(0, 10);
  const ins = db
    .prepare(
      `INSERT INTO plan (week_start, week_end, version_no, status, source, created_at, updated_at)
       VALUES (?, ?, 1, 'draft', 'rule_fallback', '2026-09-29T00:00:00Z', '2026-09-29T00:00:00Z')`,
    ) as unknown as { run: (...a: unknown[]) => { lastInsertRowid: number | bigint } };
  const planId = Number(ins.run(weekStart, weekEnd).lastInsertRowid);
  let ord = 0;
  for (const d of days) {
    const dow = new Date(`${d.datestr}T00:00:00Z`).getUTCDay();
    const dayIns = db.prepare(
      `INSERT INTO plan_day (plan_id, datestr, dow, ord, title, est_duration_min)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ) as unknown as { run: (...a: unknown[]) => { lastInsertRowid: number | bigint } };
    const dayId = Number(dayIns.run(planId, d.datestr, dow, ord, d.title ?? '训练', d.est ?? 60).lastInsertRowid);
    ord += 1;
    let eord = 0;
    for (const e of d.exercises ?? []) {
      db.prepare(
        `INSERT INTO plan_exercise (plan_day_id, ord, name, sets, reps, weight_kg, is_cardio, why_json, source)
         VALUES (?, ?, ?, ?, ?, ?, 0, '{}', 'manual')`,
      ).run(dayId, eord, e.name, e.sets, e.reps, e.weight);
      eord += 1;
    }
  }
  return planId;
}

function seedExistingSession(db: Db, datestr: string, localid: string): void {
  db.prepare(
    `INSERT INTO train_session (datestr, localid, content_hash, synced_at) VALUES (?, ?, 'hash', '2026-09-29T00:00:00Z')`,
  ).run(datestr, localid);
}

interface MockOpts {
  failDatestrs?: Set<string>;
  rateLimitDatestrs?: Set<string>;
  /** 实写响应改为线上真实形态：{res:{trains:[]}} 空数组不回显（2026-09-30 实测）。 */
  emptyEchoDatestrs?: Set<string>;
  /** 读回验证行为（emptyEcho 触发读回时）：默认 'found'（命中同标题训练）。 */
  readback?: Map<string, 'found' | 'empty' | 'mismatch' | 'rateLimited'>;
}

function makeWriteEnv(db: Db, mock: MockOpts = {}): {
  transport: MockTransport;
  deps: { client: XunjiHttpClient; dbPath: string };
  file: string;
  dir: string;
  /** 读请求（读回验证）的请求体列表，供断言 include_full_data。 */
  readCalls: Array<{ datestr: string; include_full_data: boolean }>;
} {
  const { dir, file } = makeTempDb();
  void dir;
  const readCalls: Array<{ datestr: string; include_full_data: boolean }> = [];
  const writtenTitles = new Map<string, string>();
  const transport = new MockTransport((req) => {
    // 读回验证请求（读接口）
    if (req.url.endsWith(READ_PATH)) {
      const body = JSON.parse(req.body) as { datestr: string; include_full_data: boolean };
      readCalls.push({ datestr: body.datestr, include_full_data: body.include_full_data });
      const mode = mock.readback?.get(body.datestr) ?? 'found';
      if (mode === 'rateLimited') return MockTransport.jsonResponse({ error: 'request too frequent, retry after 30s' });
      if (mode === 'empty') return MockTransport.jsonResponse(makeEnvelope(body.datestr, []));
      if (mode === 'mismatch') {
        return MockTransport.jsonResponse(makeEnvelope(body.datestr, [makeTrain({ localid: 999, datestr: body.datestr, title: '别人的训练' })]));
      }
      // found：返回同标题训练（localid 与写回回显形态一致，便于断言）
      return MockTransport.jsonResponse(
        makeEnvelope(body.datestr, [makeTrain({ localid: `lid-${body.datestr}`, datestr: body.datestr, title: writtenTitles.get(body.datestr) ?? '训练' })]),
      );
    }
    // 写请求
    const body = JSON.parse(req.body) as { dry_run: boolean; res: Array<{ datestr: string; title: string }> };
    const datestr = body.res[0]?.datestr ?? '';
    writtenTitles.set(datestr, body.res[0]?.title ?? '');
    // 预演纯本地不再发请求，此处只处理实写（dry_run=false）
    if (body.dry_run === false && mock.rateLimitDatestrs?.has(datestr)) {
      return MockTransport.jsonResponse({ error: 'request too frequent, retry after 45s' });
    }
    if (body.dry_run === false && mock.failDatestrs?.has(datestr)) {
      return MockTransport.jsonResponse({ error: 'mock injected failure' });
    }
    if (body.dry_run === false && mock.emptyEchoDatestrs?.has(datestr)) {
      // 线上真实形态：成功但不回显（与限频静默丢弃同形，writeService 须读回验证）
      return MockTransport.jsonResponse({ res: { schema_version: 'train_open_api_v2', datestr, truncated: false, trains: [] } });
    }
    // 响应形态：实写回显 trains 带 localid（旧形态，防御保留）
    return MockTransport.jsonResponse({ res: [{ localid: `lid-${datestr}`, datestr }] });
  });
  const client = new XunjiHttpClient({ baseUrl: 'https://mock.local', apiKey: 'test-key', transport: transport.transport });
  return { transport, deps: { client, dbPath: file }, file, dir, readCalls };
}

// ---------------------------------------------------------------------------
// writer：payload 构造与校验
// ---------------------------------------------------------------------------

describe('writer: buildTrainFromPlanDay', () => {
  it('组数据转为字符串、**不带 rpe**、时间锚点 10:00+08:00', () => {
    const { train } = buildTrainFromPlanDay({
      datestr: '2026-10-01',
      title: '下肢力量',
      estDurationMin: 49,
      exercises: [{ name: '杠铃深蹲', sets: 3, reps: 12, weight_kg: 100, is_cardio: 0 }],
    });
    assert.equal(train.title, '下肢力量');
    assert.equal(train.movements[0].name, '杠铃深蹲');
    // 决策 A（PRD-v2 §11.4）：只写重量 × 组数 × 次数，不写 RPE
    assert.deepEqual(train.movements[0].sets, [
      { done: false, weight: '100', unit: 'kg', reps: '12' },
      { done: false, weight: '100', unit: 'kg', reps: '12' },
      { done: false, weight: '100', unit: 'kg', reps: '12' },
    ]);
    assert.ok(!('rpe' in (train.movements[0].sets?.[0] ?? {})), '写回 payload 不得带 rpe 字段');
    assert.equal(train.start, Date.parse('2026-10-01T10:00:00+08:00'));
    assert.equal(train.end - train.start, 49 * 60_000);
  });

  it('weight/reps 为 null 时组含空串（触发 C5 由 validate 判定）', () => {
    const { train } = buildTrainFromPlanDay({
      datestr: '2026-10-01',
      title: 't',
      estDurationMin: null,
      exercises: [{ name: '平板支撑', sets: 2, reps: null, weight_kg: null, is_cardio: 0 }],
    });
    assert.equal(train.movements[0].sets?.[0].weight, '');
    assert.equal(train.movements[0].sets?.[0].reps, '');
    assert.equal(train.end - train.start, 45 * 60_000); // 默认 45 分钟
  });
});

describe('writer: validateTrain（C1~C10）', () => {
  const base: WriteTrain = {
    datestr: '2026-10-01',
    title: 't',
    start: 0,
    end: 1,
    movements: [{ name: '深蹲', sets: [{ done: false, weight: '60', unit: 'kg', reps: '5' }] }],
  };
  const today = '2026-09-29';

  it('C2：15 动作通过，16 动作阻断（写侧 15，非读侧 40）', () => {
    const ok = validateTrain({ ...base, movements: Array.from({ length: 15 }, (_, i) => ({ name: `m${i}`, sets: [] })) }, { todayLocal: today, trainCount: 1 });
    assert.ok(!ok.some((v) => v.code === 'C2_TOO_MANY_MOVES'));
    const bad = validateTrain({ ...base, movements: Array.from({ length: 16 }, (_, i) => ({ name: `m${i}`, sets: [] })) }, { todayLocal: today, trainCount: 1 });
    assert.ok(bad.some((v) => v.code === 'C2_TOO_MANY_MOVES'));
  });

  it('C3：20 组通过，21 组阻断（写侧 20，非读侧 60）', () => {
    const sets = Array.from({ length: 21 }, () => ({ done: false, weight: '60', unit: 'kg', reps: '5' }));
    const bad = validateTrain({ ...base, movements: [{ name: '深蹲', sets }] }, { todayLocal: today, trainCount: 1 });
    assert.ok(bad.some((v) => v.code === 'C3_TOO_MANY_SETS'));
  });

  it('C5：重量与次数全空的组阻断；rpe 不算训练内容', () => {
    const bad = validateTrain(
      { ...base, movements: [{ name: '深蹲', sets: [{ done: false, weight: '', unit: 'kg', reps: '', rpe: '8' }] }] },
      { todayLocal: today, trainCount: 1 },
    );
    assert.ok(bad.some((v) => v.code === 'C5_EMPTY_SET'));
  });

  it('C9：过去日期阻断；今天/明天通过；超过 91 天阻断', () => {
    const past = validateTrain({ ...base, datestr: '2026-09-28' }, { todayLocal: today, trainCount: 1 });
    assert.ok(past.some((v) => v.code === 'C9_PAST_DATE'));
    const todayOk = validateTrain({ ...base, datestr: '2026-09-29' }, { todayLocal: today, trainCount: 1 });
    assert.ok(!todayOk.some((v) => v.code.startsWith('C9')));
    const far = validateTrain({ ...base, datestr: '2027-01-15' }, { todayLocal: today, trainCount: 1 });
    assert.ok(far.some((v) => v.code === 'C9_TOO_FAR'));
    assert.ok(WRITE_FUTURE_DAYS_LIMIT === 91);
  });

  it('C10：超过 128KB 的 payload 阻断', () => {
    const big = validateTrain(
      { ...base, movements: [{ name: 'x'.repeat(140_000), sets: [] }] },
      { todayLocal: today, trainCount: 1 },
    );
    assert.ok(big.some((v) => v.code === 'C10_PAYLOAD_TOO_LARGE'));
  });

  it('clientRequestId：内容不变则同键，内容变则换键', () => {
    const id1 = clientRequestId(3, '2026-10-01', 1, [base]);
    const id2 = clientRequestId(3, '2026-10-01', 1, [base]);
    const id3 = clientRequestId(3, '2026-10-01', 1, [{ ...base, title: '改了' }]);
    assert.equal(id1, id2);
    assert.notEqual(id1, id3);
    assert.match(id1, /^3-2026-10-01-b1-[0-9a-f]{8}$/);
  });
});

// 实测响应形态（scripts/tmp_write_raw.mjs + data/probe_write/ 落盘 + 2026-09-30 修正）：
// 实写成功 = {"res": {..., "trains": []}}（不回显内容）；与限频静默丢弃同形 → 空数组 = uncertain。
describe('writer: parseWriteResponse（实写空数组 = uncertain 三态语义）', () => {
  const emptyEchoShape = {
    res: { schema: 'train_open_api_v2', datestr: '2026-09-30', truncated: false, trains: [] },
  };

  it('实写：res.trains 空数组 = uncertain（成功不回显与静默丢弃不可区分，须读回验证）', () => {
    const r = parseWriteResponse(emptyEchoShape, { dryRun: false });
    assert.equal(r.ok, false);
    assert.equal(r.uncertain, true);
    assert.equal(r.errorCode, 'EMPTY_RES_TRAINS');
  });

  it('res 形态缺失（两种模式）都是确定性失败（uncertain=false）', () => {
    for (const dryRun of [true, false]) {
      const r = parseWriteResponse({ success: false }, { dryRun });
      assert.equal(r.ok, false);
      assert.equal(r.uncertain, false);
      assert.equal(r.errorCode, 'NO_RES_TRAINS');
    }
    const r = parseWriteResponse({ res: { noTrainsHere: 1 } }, { dryRun: true });
    assert.equal(r.ok, false);
    assert.equal(r.uncertain, false);
  });

  it('实写：res 数组形态带 localid → 成功（旧形态，防御保留）', () => {
    const r = parseWriteResponse({ res: [{ localid: 'lid-1', datestr: '2026-09-30' }] }, { dryRun: false });
    assert.equal(r.ok, true);
    assert.equal(r.uncertain, false);
    assert.deepEqual(r.localids, ['lid-1']);
  });

  it('限频错误在 error 字段（两种模式一致识别，uncertain=false）', () => {
    for (const dryRun of [true, false]) {
      const r = parseWriteResponse({ error: 'request too frequent, retry after 45s' }, { dryRun });
      assert.equal(r.ok, false);
      assert.equal(r.rateLimited, true);
      assert.equal(r.uncertain, false);
      assert.equal(r.errorCode, 'RATE_LIMITED');
    }
  });
});

// ---------------------------------------------------------------------------
// writeService：双栏杆编排
// ---------------------------------------------------------------------------

const WEEK_DAYS: SeedDay[] = [
  { datestr: '2026-09-28', title: '下肢（周一，过去）', exercises: [{ name: '杠铃深蹲', sets: 3, reps: 12, weight: 100 }] },
  { datestr: '2026-09-30', title: '上肢推（周三）', exercises: [{ name: '杠铃卧推', sets: 4, reps: 8, weight: 40 }] },
  { datestr: '2026-10-02', title: '上肢拉（周五）', exercises: [{ name: '杠铃划船', sets: 3, reps: 12, weight: 40 }] },
  { datestr: '2026-10-03', title: '全身（周六）', exercises: [{ name: '杠铃深蹲', sets: 3, reps: 12, weight: 100 }] },
];

describe('writeService: approvePlan（第一道栏杆）', () => {
  it('draft → approved；非 draft 409；不存在 404', () => {
    const { db } = makeTempDb();
    const planId = seedPlan(db, '2026-09-28', WEEK_DAYS);
    const out = approvePlan(db, planId, { now: NOW });
    assert.equal(out.status, 'approved');
    assert.throws(() => approvePlan(db, planId, { now: NOW }), (e: unknown) => e instanceof PlanServiceError && e.status === 409);
    assert.throws(() => approvePlan(db, 9999, { now: NOW }), (e: unknown) => e instanceof PlanServiceError && e.status === 404);
  });
});

describe('writeService: createPreview（预演，纯本地零网络）', () => {
  it('draft 计划预演 → 409（必须先 approve）', () => {
    const { db } = makeTempDb();
    const planId = seedPlan(db, '2026-09-28', WEEK_DAYS);
    const { deps } = makeWriteEnv(db);
    assert.throws(
      () => createPreview(db, deps, planId, { now: NOW }),
      (e: unknown) => e instanceof PlanServiceError && e.status === 409,
    );
  });

  it('窗口过滤：过去日排除、已存在训记记录的日期跳过；纯本地校验全过 → awaiting_confirm（零网络调用）', () => {
    const { db } = makeTempDb();
    const planId = seedPlan(db, '2026-09-28', WEEK_DAYS);
    seedExistingSession(db, '2026-10-02', 'existing-1'); // 周五已有训记记录 → 跳过
    approvePlan(db, planId, { now: NOW });
    const { transport, deps } = makeWriteEnv(db);

    const job = createPreview(db, deps, planId, { now: NOW });

    assert.equal(job.status, 'awaiting_confirm');
    assert.equal(job.window.start, '2026-09-30'); // max(week_start, 明天)
    assert.equal(job.window.end, '2026-10-04');
    // 周一(过去)不在 days 里；周五 skip_existing；周三/周六 create
    const byDate = new Map(job.days.map((d) => [d.datestr, d]));
    assert.equal(byDate.get('2026-09-28'), undefined);
    assert.equal(byDate.get('2026-10-02')?.action, 'skip_existing');
    assert.equal(byDate.get('2026-10-02')?.existing_localid, 'existing-1');
    assert.equal(byDate.get('2026-09-30')?.action, 'create');
    assert.equal(byDate.get('2026-10-03')?.action, 'create');
    assert.equal(job.total_batches, 2);
    // 预演零网络调用（纯本地模式）
    assert.equal(transport.calls.length, 0);
  });

  it('写前校验违例（空组）→ 400 且不发出任何请求', () => {
    const { db } = makeTempDb();
    const planId = seedPlan(db, '2026-09-28', [
      { datestr: '2026-09-30', exercises: [{ name: '平板支撑', sets: 2, reps: null, weight: null }] },
    ]);
    approvePlan(db, planId, { now: NOW });
    const { transport, deps } = makeWriteEnv(db);
    assert.throws(
      () => createPreview(db, deps, planId, { now: NOW }),
      (e: unknown) => e instanceof PlanServiceError && e.status === 400 && e.message.includes('C5'),
    );
    assert.equal(transport.calls.length, 0);
  });
});

describe('writeService: confirmWrite（第二道栏杆）', () => {
  it('confirmed!==true → 400；未预演 → 409', async () => {
    const { db } = makeTempDb();
    const planId = seedPlan(db, '2026-09-28', WEEK_DAYS);
    const { deps } = makeWriteEnv(db);
    approvePlan(db, planId, { now: NOW });

    await assert.rejects(() => confirmWrite(db, deps, planId, false, { now: NOW, sleep: instantSleep }), (e: unknown) => e instanceof PlanServiceError && e.status === 400);
    await assert.rejects(() => confirmWrite(db, deps, planId, true, { now: NOW, sleep: instantSleep }), (e: unknown) => e instanceof PlanServiceError && e.status === 409);
  });

  it('实写成功：localid 回填、write_item 落库、计划 written、幂等键与预演一致、备份文件生成', async () => {
    const { db, dir } = makeTempDb();
    const planId = seedPlan(db, '2026-09-28', WEEK_DAYS);
    seedExistingSession(db, '2026-10-02', 'existing-1'); // 周五已有记录 → 跳过，可写 = 周三+周六
    const { transport, deps } = makeWriteEnv(db);
    approvePlan(db, planId, { now: NOW });
    const preview = createPreview(db, deps, planId, { now: NOW });
    // 预演零网络调用
    assert.equal(transport.calls.length, 0);

    const out = await confirmWrite(db, deps, planId, true, { now: NOW, sleep: instantSleep });

    assert.equal(out.plan_status, 'written');
    assert.equal(out.batches.length, 2);
    assert.ok(out.backup_path !== null && existsSync(out.backup_path));
    void dir;
    const plan = db.prepare(`SELECT status FROM plan WHERE id = ?`).get(planId) as unknown as { status: string };
    assert.equal(plan.status, 'written');
    const days = db.prepare(`SELECT datestr, localid, write_status FROM plan_day WHERE plan_id = ? ORDER BY datestr`).all(planId) as unknown as Array<{
      datestr: string;
      localid: string | null;
      write_status: string | null;
    }>;
    const wed = days.find((d) => d.datestr === '2026-09-30');
    assert.equal(wed?.localid, 'lid-2026-09-30');
    assert.equal(wed?.write_status, 'success');
    // 实写请求 dry_run=false，client_request_id 与预演一致
    assert.equal(transport.calls.length, 2);
    const previewIds = preview.batches.map((b) => b.client_request_id).sort();
    const confirmIds = transport.calls
      .map((r) => (JSON.parse(r.body) as { client_request_id: string }).client_request_id)
      .sort();
    assert.deepEqual(confirmIds, previewIds);
    for (const r of transport.calls) assert.equal((JSON.parse(r.body) as { dry_run: boolean }).dry_run, false);
    const items = db.prepare(`SELECT COUNT(*) AS n FROM write_item WHERE result = 'success'`).get() as unknown as { n: number };
    assert.equal(items.n, 2);
  });

  it('部分失败 → 计划 partial；失败日 write_status=failed 可单独重试', async () => {
    const { db } = makeTempDb();
    const planId = seedPlan(db, '2026-09-28', WEEK_DAYS);
    const { deps } = makeWriteEnv(db, { failDatestrs: new Set(['2026-10-03']) });
    approvePlan(db, planId, { now: NOW });
    createPreview(db, deps, planId, { now: NOW });

    const out = await confirmWrite(db, deps, planId, true, { now: NOW, sleep: instantSleep });
    assert.equal(out.plan_status, 'partial');
    const job = getWriteJob(db, planId);
    assert.equal(job?.status, 'partial');
    const sat = out.batches.find((b) => b.datestr === '2026-10-03');
    assert.equal(sat?.status, 'failed');
    assert.ok(sat?.error?.includes('mock injected failure'));
  });

  it('限频响应（too frequent）被正确识别为失败而非崩溃', async () => {
    const { db } = makeTempDb();
    const planId = seedPlan(db, '2026-09-28', WEEK_DAYS);
    const { deps } = makeWriteEnv(db, { rateLimitDatestrs: new Set(['2026-10-03']) });
    approvePlan(db, planId, { now: NOW });
    createPreview(db, deps, planId, { now: NOW });
    const out = await confirmWrite(db, deps, planId, true, { now: NOW, sleep: instantSleep });
    assert.equal(out.plan_status, 'partial');
  });

  it('实写空响应 + 读回命中 → success（localid 从读回回填），full 模式读回已发出', async () => {
    const { db } = makeTempDb();
    const planId = seedPlan(db, '2026-09-28', WEEK_DAYS);
    seedExistingSession(db, '2026-10-02', 'existing-1'); // 周五跳过，可写 = 周三+周六
    const { transport, deps, readCalls } = makeWriteEnv(db, { emptyEchoDatestrs: new Set(['2026-09-30', '2026-10-03']) });
    approvePlan(db, planId, { now: NOW });
    createPreview(db, deps, planId, { now: NOW });

    const sleeps: number[] = [];
    const out = await confirmWrite(db, deps, planId, true, { now: NOW, sleep: recordingSleep(sleeps) });

    assert.equal(out.plan_status, 'written');
    for (const b of out.batches) {
      assert.equal(b.status, 'success');
      assert.equal(b.error, null);
    }
    assert.equal(out.batches.find((b) => b.datestr === '2026-09-30')?.localid_after, 'lid-2026-09-30');
    // 读回验证：2 次 full 模式读请求（light 模式看不到未来计划，实测假象之源）
    assert.equal(readCalls.length, 2);
    for (const c of readCalls) assert.equal(c.include_full_data, true);
    // 节奏：批间冷却 65s + 每批读回前等待 15s
    assert.ok(sleeps.includes(WRITE_COOL_DOWN_MS));
    assert.equal(sleeps.filter((ms) => ms === WRITE_VERIFY_DELAY_MS).length, 2);
    // 请求序：2 写 + 2 读
    assert.equal(transport.calls.length, 4);
    const plan = db.prepare(`SELECT status FROM plan WHERE id = ?`).get(planId) as unknown as { status: string };
    assert.equal(plan.status, 'written');
  });

  it('实写空响应 + 读回该日为空 → failed（READBACK_ABSENT，确认被静默丢弃）', async () => {
    const { db } = makeTempDb();
    const planId = seedPlan(db, '2026-09-28', WEEK_DAYS);
    const rb = new Map<string, 'found' | 'empty' | 'mismatch' | 'rateLimited'>([['2026-09-30', 'empty']]);
    const { deps } = makeWriteEnv(db, { emptyEchoDatestrs: new Set(['2026-09-30', '2026-10-03']), readback: rb });
    approvePlan(db, planId, { now: NOW });
    createPreview(db, deps, planId, { now: NOW });

    const out = await confirmWrite(db, deps, planId, true, { now: NOW, sleep: instantSleep });
    assert.equal(out.plan_status, 'partial'); // 周三确认丢弃，周六读回命中
    const wed = out.batches.find((b) => b.datestr === '2026-09-30');
    assert.equal(wed?.status, 'failed');
    assert.ok(wed?.error?.includes('READBACK_ABSENT'));
    const sat = out.batches.find((b) => b.datestr === '2026-10-03');
    assert.equal(sat?.status, 'success');
  });

  it('实写空响应 + 读回限频 → uncertain（人工核实，绝不自动重写）；uncertain 计划可重新预演+确认', async () => {
    const { db } = makeTempDb();
    const planId = seedPlan(db, '2026-09-28', WEEK_DAYS);
    const uncertainDays = ['2026-09-30', '2026-10-02', '2026-10-03'];
    const rb = new Map<string, 'found' | 'empty' | 'mismatch' | 'rateLimited'>(uncertainDays.map((d) => [d, 'rateLimited' as const]));
    const { deps } = makeWriteEnv(db, { emptyEchoDatestrs: new Set(uncertainDays), readback: rb });
    approvePlan(db, planId, { now: NOW });
    createPreview(db, deps, planId, { now: NOW });

    const out = await confirmWrite(db, deps, planId, true, { now: NOW, sleep: instantSleep });
    assert.equal(out.plan_status, 'uncertain');
    assert.equal(out.batches.length, 3);
    for (const b of out.batches) {
      assert.equal(b.status, 'uncertain');
      assert.ok(b.error?.includes('READBACK_INCONCLUSIVE'));
    }
    const plan = db.prepare(`SELECT status FROM plan WHERE id = ?`).get(planId) as unknown as { status: string };
    assert.equal(plan.status, 'uncertain');
    const day = db.prepare(`SELECT write_status FROM plan_day WHERE plan_id = ? AND datestr = '2026-09-30'`).get(planId) as unknown as { write_status: string };
    assert.equal(day.write_status, 'uncertain');
    const item = db.prepare(`SELECT result FROM write_item WHERE result = 'uncertain'`).get() as unknown as { result: string };
    assert.equal(item.result, 'uncertain');

    // 逃逸出口：uncertain 计划可重新预演（生成新的 awaiting_confirm 作业）并再次确认
    const nextJob = createPreview(db, deps, planId, { now: NOW });
    assert.equal(nextJob.status, 'awaiting_confirm');
  });

  it('读回该日有训练但标题不匹配 → uncertain（他日数据不冒认）', async () => {
    const { db } = makeTempDb();
    const planId = seedPlan(db, '2026-09-28', [
      { datestr: '2026-09-30', title: '上肢推（模板）', exercises: [{ name: '杠铃卧推', sets: 4, reps: 8, weight: 40 }] },
    ]);
    const rb = new Map<string, 'found' | 'empty' | 'mismatch' | 'rateLimited'>([['2026-09-30', 'mismatch']]);
    const { deps } = makeWriteEnv(db, { emptyEchoDatestrs: new Set(['2026-09-30']), readback: rb });
    approvePlan(db, planId, { now: NOW });
    createPreview(db, deps, planId, { now: NOW });

    const out = await confirmWrite(db, deps, planId, true, { now: NOW, sleep: instantSleep });
    assert.equal(out.plan_status, 'uncertain');
    const wed = out.batches.find((b) => b.datestr === '2026-09-30');
    assert.equal(wed?.status, 'uncertain');
    assert.ok(wed?.error?.includes('标题均非'));
  });

  it('窗口外没有任何可写日 → 400', () => {
    const { db } = makeTempDb();
    const planId = seedPlan(db, '2026-09-28', [
      { datestr: '2026-09-29', title: '今天', exercises: [{ name: '杠铃深蹲', sets: 3, reps: 12, weight: 100 }] },
    ]);
    approvePlan(db, planId, { now: NOW });
    const { deps } = makeWriteEnv(db);
    assert.throws(
      () => createPreview(db, deps, planId, { now: NOW }),
      (e: unknown) => e instanceof PlanServiceError && e.status === 400 && e.message.includes('没有可写入的训练日'),
    );
  });
});

// 异步作业拆分（2026-10-06）：beginWrite（同步准入） + runWriteBatches（后台批次循环）。
// 夹具照旧：NOW 注入 opts.now、instantSleep、makeWriteEnv、seedPlan；绝不写绝对「今天」。
describe('writeService: beginWrite / runWriteBatches（异步作业拆分）', () => {
  it('beginWrite 同步返回 job_id/total_batches/backup_path，返回时 plan 与 job 已是 writing，且零网络请求', () => {
    const { db } = makeTempDb();
    const planId = seedPlan(db, '2026-09-28', WEEK_DAYS);
    const { transport, deps } = makeWriteEnv(db);
    approvePlan(db, planId, { now: NOW });
    const preview = createPreview(db, deps, planId, { now: NOW });

    const { result, batches } = beginWrite(db, deps, planId, true, { now: NOW });

    assert.equal(result.job_id, preview.job_id);
    assert.equal(result.plan_id, planId);
    assert.equal(result.total_batches, 3); // 窗口内 3 天可写（周三/周五/周六，无既存记录）
    assert.equal(result.plan_status, 'writing');
    assert.ok(result.backup_path !== null && existsSync(result.backup_path));
    assert.equal(batches.length, 3);
    // 返回前状态已落定（HTTP 段结束即是 writing，前端轮询立刻能看到）
    const plan = db.prepare(`SELECT status FROM plan WHERE id = ?`).get(planId) as unknown as { status: string };
    assert.equal(plan.status, 'writing');
    const job = db.prepare(`SELECT status, started_at FROM sync_write_job WHERE id = ?`).get(result.job_id) as unknown as {
      status: string;
      started_at: string | null;
    };
    assert.equal(job.status, 'writing');
    assert.ok(job.started_at !== null);
    // beginWrite 只做准入+快照+取清单，绝不发网络请求
    assert.equal(transport.calls.length, 0);
  });

  it('beginWrite 后 getWriteJob 显示 writing；runWriteBatches 跑完后 plan=written、finished_batches 到总数', async () => {
    const { db } = makeTempDb();
    const planId = seedPlan(db, '2026-09-28', WEEK_DAYS);
    const { deps } = makeWriteEnv(db);
    approvePlan(db, planId, { now: NOW });
    createPreview(db, deps, planId, { now: NOW });

    const { result, batches } = beginWrite(db, deps, planId, true, { now: NOW });
    const during = getWriteJob(db, planId, { now: NOW });
    assert.equal(during?.status, 'writing');
    assert.equal(during?.finished_batches, 0);
    assert.equal(during?.total_batches, 3);

    const out = await runWriteBatches(db, deps, planId, result.job_id, batches, { now: NOW, sleep: instantSleep });

    assert.equal(out.plan_status, 'written');
    const after = getWriteJob(db, planId, { now: NOW });
    assert.equal(after?.status, 'success');
    assert.equal(after?.finished_batches, after?.total_batches);
    assert.equal(after?.total_batches, 3);
    const plan = db.prepare(`SELECT status FROM plan WHERE id = ?`).get(planId) as unknown as { status: string };
    assert.equal(plan.status, 'written');
  });

  it('beginWrite 准入：confirmed!==true→400；无 awaiting_confirm 作业→409；plan 非 approved/uncertain→409', () => {
    const { db } = makeTempDb();
    const planId = seedPlan(db, '2026-09-28', WEEK_DAYS);
    const { deps } = makeWriteEnv(db);

    // plan 仍是 draft → 409（confirmed 检查在前，此处传 true 才走到状态检查）
    assert.throws(
      () => beginWrite(db, deps, planId, true, { now: NOW }),
      (e: unknown) => e instanceof PlanServiceError && e.status === 409,
    );

    approvePlan(db, planId, { now: NOW });
    // 未预演 → 没有 awaiting_confirm 作业 → 409
    assert.throws(
      () => beginWrite(db, deps, planId, true, { now: NOW }),
      (e: unknown) => e instanceof PlanServiceError && e.status === 409,
    );
    // confirmed !== true → 400（第二道栏杆；严格 === true）
    for (const bad of [false, undefined, 'true', 1, null]) {
      assert.throws(
        () => beginWrite(db, deps, planId, bad, { now: NOW }),
        (e: unknown) => e instanceof PlanServiceError && e.status === 400,
      );
    }
    // 预演后正常准入成功
    createPreview(db, deps, planId, { now: NOW });
    const { result } = beginWrite(db, deps, planId, true, { now: NOW });
    assert.equal(result.plan_status, 'writing');
  });
});

describe('writeService: recoverStuckWrites（开机恢复中断写入）', () => {
  it('无残留 → 返回 0 且不产生通知', () => {
    const { db } = makeTempDb();
    const planId = seedPlan(db, '2026-09-28', WEEK_DAYS);
    const { deps } = makeWriteEnv(db);
    approvePlan(db, planId, { now: NOW });
    createPreview(db, deps, planId, { now: NOW }); // awaiting_confirm，非 writing

    assert.equal(recoverStuckWrites(db), 0);
    assert.equal(new NotificationRepo(db).listRecent().length, 0);
  });

  it('把悬空的 writing job+plan 恢复为 uncertain（返回条数正确、有 warn 通知，绝不自动重写）', () => {
    const { db } = makeTempDb();
    const planA = seedPlan(db, '2026-09-28', WEEK_DAYS);
    // 第二份计划用不同周（plan 上有 UNIQUE(week_start, version_no) 约束）
    const planB = seedPlan(db, '2026-10-05', [
      { datestr: '2026-10-06', title: '上肢推（下周二）', exercises: [{ name: '杠铃卧推', sets: 4, reps: 8, weight: 40 }] },
    ]);
    const { deps } = makeWriteEnv(db);
    for (const pid of [planA, planB]) {
      approvePlan(db, pid, { now: NOW });
      createPreview(db, deps, pid, { now: NOW });
    }
    // 手工把作业与计划置为 writing（模拟进程在写入中途被杀），不走 beginWrite 以免备份撞名
    db.prepare(`UPDATE sync_write_job SET status = 'writing' WHERE plan_id IN (?, ?)`).run(planA, planB);
    db.prepare(`UPDATE plan SET status = 'writing' WHERE id IN (?, ?)`).run(planA, planB);

    const n = recoverStuckWrites(db);
    assert.equal(n, 2);

    const jobs = db
      .prepare(`SELECT status, error_json FROM sync_write_job WHERE plan_id IN (?, ?)`)
      .all(planA, planB) as unknown as Array<{ status: string; error_json: string | null }>;
    for (const jb of jobs) {
      assert.equal(jb.status, 'uncertain');
      assert.ok(jb.error_json !== null && jb.error_json.includes('PROCESS_INTERRUPTED'));
    }
    const plans = db.prepare(`SELECT status FROM plan WHERE id IN (?, ?)`).all(planA, planB) as unknown as Array<{ status: string }>;
    for (const p of plans) assert.equal(p.status, 'uncertain');

    const notes = new NotificationRepo(db).listRecent();
    assert.equal(notes.length, 1);
    assert.equal(notes[0].level, 'warn');
    assert.ok(notes[0].title.includes('2'));
  });

  it('逃逸出口：恢复为 uncertain 后该计划可重新预演', () => {
    const { db } = makeTempDb();
    const planId = seedPlan(db, '2026-09-28', WEEK_DAYS);
    const { deps } = makeWriteEnv(db);
    approvePlan(db, planId, { now: NOW });
    createPreview(db, deps, planId, { now: NOW });
    db.prepare(`UPDATE sync_write_job SET status = 'writing' WHERE plan_id = ?`).run(planId);
    db.prepare(`UPDATE plan SET status = 'writing' WHERE id = ?`).run(planId);

    assert.equal(recoverStuckWrites(db), 1);
    const next = createPreview(db, deps, planId, { now: NOW }); // uncertain 可重新预演
    assert.equal(next.status, 'awaiting_confirm');
  });
});

describe('writeService: recoverStuckWrites 不对称残留（plan 与 job 是两条相邻 UPDATE，崩溃可卡中间）', () => {
  // 🔴 复现旧缺陷的核心用例：plan=writing 而 job 不是 writing。
  //    旧实现只按 job 反查 → 返回 0 且完全不处理该 plan → 永久死锁（准入只收 approved/uncertain）。
  for (const jobStatus of ['awaiting_confirm', 'success', 'uncertain']) {
    it(`plan=writing + 最新 job=${jobStatus} → 恢复 1 个 plan 并可重新预演（解死锁）`, () => {
      const { db } = makeTempDb();
      const planId = seedPlan(db, '2026-09-28', WEEK_DAYS);
      const { deps } = makeWriteEnv(db);
      approvePlan(db, planId, { now: NOW });
      createPreview(db, deps, planId, { now: NOW });
      // 手工制造不对称：plan 卡在 writing，job 停在别的状态（模拟 beginWrite/批次收尾半途被杀）
      db.prepare(`UPDATE plan SET status = 'writing' WHERE id = ?`).run(planId);
      db.prepare(`UPDATE sync_write_job SET status = ? WHERE plan_id = ?`).run(jobStatus, planId);

      assert.equal(recoverStuckWrites(db), 1);
      const plan = db.prepare(`SELECT status FROM plan WHERE id = ?`).get(planId) as unknown as { status: string };
      assert.equal(plan.status, 'uncertain');
      // 解死锁的关键断言：恢复后 createPreview 不再 409
      const next = createPreview(db, deps, planId, { now: NOW });
      assert.equal(next.status, 'awaiting_confirm');
    });
  }

  it('对照：两侧都 writing → 恢复 1 个 plan，job 与 plan 同置 uncertain，带 PROCESS_INTERRUPTED', () => {
    const { db } = makeTempDb();
    const planId = seedPlan(db, '2026-09-28', WEEK_DAYS);
    const { deps } = makeWriteEnv(db);
    approvePlan(db, planId, { now: NOW });
    createPreview(db, deps, planId, { now: NOW });
    db.prepare(`UPDATE plan SET status = 'writing' WHERE id = ?`).run(planId);
    db.prepare(`UPDATE sync_write_job SET status = 'writing' WHERE plan_id = ?`).run(planId);

    assert.equal(recoverStuckWrites(db), 1);
    const plan = db.prepare(`SELECT status FROM plan WHERE id = ?`).get(planId) as unknown as { status: string };
    assert.equal(plan.status, 'uncertain');
    const job = db.prepare(`SELECT status, error_json FROM sync_write_job WHERE plan_id = ?`).get(planId) as unknown as {
      status: string;
      error_json: string | null;
    };
    assert.equal(job.status, 'uncertain');
    assert.ok(job.error_json !== null && job.error_json.includes('PROCESS_INTERRUPTED'));
  });

  it('混合：两侧都 writing（A）+ 只有 plan writing（B）→ 返回去重 plan 数 2（非 job 行数 1）', () => {
    const { db } = makeTempDb();
    const planA = seedPlan(db, '2026-09-28', WEEK_DAYS);
    const planB = seedPlan(db, '2026-10-05', [
      { datestr: '2026-10-06', title: '上肢推（下周二）', exercises: [{ name: '杠铃卧推', sets: 4, reps: 8, weight: 40 }] },
    ]);
    const { deps } = makeWriteEnv(db);
    for (const pid of [planA, planB]) {
      approvePlan(db, pid, { now: NOW });
      createPreview(db, deps, pid, { now: NOW });
      db.prepare(`UPDATE plan SET status = 'writing' WHERE id = ?`).run(pid);
    }
    // A 的 job 也 writing（两侧都卡）；B 的 job 停在 awaiting_confirm（只有 plan 卡）
    db.prepare(`UPDATE sync_write_job SET status = 'writing' WHERE plan_id = ?`).run(planA);

    // 旧实现只看 job 行 → 会返回 1 且漏掉 planB；新语义返回去重 plan 数 2
    assert.equal(recoverStuckWrites(db), 2);
    const plans = db.prepare(`SELECT id, status FROM plan WHERE id IN (?, ?)`).all(planA, planB) as unknown as Array<{
      id: number;
      status: string;
    }>;
    for (const p of plans) assert.equal(p.status, 'uncertain');
    const notes = new NotificationRepo(db).listRecent();
    assert.equal(notes.length, 1);
    assert.ok(notes[0].title.includes('2')); // 通知按 plan 数计数
  });
});

describe('writeService: 终态通知（异步后用户可能不在场，终态必须留痕）', () => {
  it('success → 无通知', async () => {
    const { db } = makeTempDb();
    const planId = seedPlan(db, '2026-09-28', WEEK_DAYS);
    const { deps } = makeWriteEnv(db);
    approvePlan(db, planId, { now: NOW });
    createPreview(db, deps, planId, { now: NOW });

    const out = await confirmWrite(db, deps, planId, true, { now: NOW, sleep: instantSleep });
    assert.equal(out.plan_status, 'written');
    assert.equal(new NotificationRepo(db).listRecent().length, 0);
  });

  it('failed → error 通知，detail 含批次摘要', async () => {
    const { db } = makeTempDb();
    const planId = seedPlan(db, '2026-09-28', WEEK_DAYS);
    const allFails = new Set(['2026-09-30', '2026-10-02', '2026-10-03']);
    const { deps } = makeWriteEnv(db, { failDatestrs: allFails });
    approvePlan(db, planId, { now: NOW });
    createPreview(db, deps, planId, { now: NOW });

    const out = await confirmWrite(db, deps, planId, true, { now: NOW, sleep: instantSleep });
    assert.equal(out.plan_status, 'failed');
    const notes = new NotificationRepo(db).listRecent();
    assert.equal(notes.length, 1);
    assert.equal(notes[0].level, 'error');
    assert.ok(notes[0].title.includes('失败'));
    assert.ok(notes[0].body !== null && notes[0].body.includes('已完成 0/3 批'));
  });

  it('uncertain → warn 通知', async () => {
    const { db } = makeTempDb();
    const planId = seedPlan(db, '2026-09-28', WEEK_DAYS);
    const days = ['2026-09-30', '2026-10-02', '2026-10-03'];
    const rb = new Map<string, 'found' | 'empty' | 'mismatch' | 'rateLimited'>(days.map((d) => [d, 'rateLimited' as const]));
    const { deps } = makeWriteEnv(db, { emptyEchoDatestrs: new Set(days), readback: rb });
    approvePlan(db, planId, { now: NOW });
    createPreview(db, deps, planId, { now: NOW });

    const out = await confirmWrite(db, deps, planId, true, { now: NOW, sleep: instantSleep });
    assert.equal(out.plan_status, 'uncertain');
    const notes = new NotificationRepo(db).listRecent();
    assert.equal(notes.length, 1);
    assert.equal(notes[0].level, 'warn');
    assert.ok(notes[0].title.includes('待核实'));
  });

  it('partial → warn 通知', async () => {
    const { db } = makeTempDb();
    const planId = seedPlan(db, '2026-09-28', WEEK_DAYS);
    const { deps } = makeWriteEnv(db, { failDatestrs: new Set(['2026-10-03']) });
    approvePlan(db, planId, { now: NOW });
    createPreview(db, deps, planId, { now: NOW });

    const out = await confirmWrite(db, deps, planId, true, { now: NOW, sleep: instantSleep });
    assert.equal(out.plan_status, 'partial');
    const notes = new NotificationRepo(db).listRecent();
    assert.equal(notes.length, 1);
    assert.equal(notes[0].level, 'warn');
    assert.ok(notes[0].title.includes('部分完成'));
  });
});

describe('writeService: recordWriteCrash（后台循环未捕获异常兜底）', () => {
  it('落定 job=failed / plan=failed 并加 error 通知，自身不抛', async () => {
    const { db } = makeTempDb();
    const planId = seedPlan(db, '2026-09-28', WEEK_DAYS);
    const { deps } = makeWriteEnv(db);
    approvePlan(db, planId, { now: NOW });
    createPreview(db, deps, planId, { now: NOW });
    const { result } = beginWrite(db, deps, planId, true, { now: NOW });

    recordWriteCrash(db, planId, result.job_id, new Error('boom'));

    const job = db.prepare(`SELECT status, error_json FROM sync_write_job WHERE id = ?`).get(result.job_id) as unknown as {
      status: string;
      error_json: string | null;
    };
    assert.equal(job.status, 'failed');
    assert.ok(job.error_json !== null && job.error_json.includes('UNEXPECTED_CRASH'));
    const plan = db.prepare(`SELECT status FROM plan WHERE id = ?`).get(planId) as unknown as { status: string };
    assert.equal(plan.status, 'failed');
    const notes = new NotificationRepo(db).listRecent();
    assert.equal(notes.length, 1);
    assert.equal(notes[0].level, 'error');
  });
});

describe('writeService: getWriteJob', () => {
  it('无作业返回 null；有作业返回 days+batches 汇总', () => {
    const { db } = makeTempDb();
    const planId = seedPlan(db, '2026-09-28', WEEK_DAYS);
    seedExistingSession(db, '2026-10-02', 'existing-1'); // 周五跳过
    assert.equal(getWriteJob(db, planId), null);
    const { deps } = makeWriteEnv(db);
    approvePlan(db, planId, { now: NOW });
    createPreview(db, deps, planId, { now: NOW });
    const job = getWriteJob(db, planId, { now: NOW });
    assert.equal(job?.status, 'awaiting_confirm');
    assert.equal(job?.days.length, 3); // 窗口内 3 天：周三/周五/周六
    assert.equal(job?.batches.length, 2); // 周五跳过后实际可写 2 天
  });
});
