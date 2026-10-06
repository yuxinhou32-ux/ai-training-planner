/**
 * 训记写回客户端（T4，§6.3）。M02 writer。
 *
 * 职责：payload 构造、写前校验（C1~C10）、发送与响应解析。
 * 不做编排（批次串行/限频/落库在 plan/writeService）——本模块保持纯函数 + 单批发送。
 *
 * 实测事实（probe-report §写回）：
 * - 端点 POST /api_upsert_trains_for_llm_v2，请求体 {schema_version, client_request_id, dry_run, res:[train]}
 * - 响应顶层 `res`（不保证 success 字段）；限频错误在 `error` 字段（/too frequent/i）
 * - sets 的 weight/reps 用字符串；dry_run 参数无效（每个请求都是真实 upsert，2026-09-29 实测）
 * - 实写成功响应 res.trains 恒为空数组（不回显）→ 解析为 uncertain，须读回验证（2026-09-30 实测）
 * - 写侧上限：单请求 ≤4 条且同一天 / 每条 ≤15 动作 / 每动作 ≤20 组（读侧 40/60 勿混用）
 * - payload ≤128KB；未来日期接受上限 91~119 天（取保守 91）
 */
import { createHash } from 'node:crypto';
import {
  SCHEMA_VERSION,
  WRITE_PATH,
  WRITE_COOL_DOWN_MS,
} from '../config/constants.js';
import { XunjiHttpClient } from './client.js';
import { XunjiError } from './errors.js';

/** 单条训练的写回 payload（§6.3 探针验证格式）。 */
export interface WriteSet {
  done: boolean;
  weight: string;
  unit: string;
  reps: string;
  rpe?: string;
}

export interface WriteMovement {
  name: string;
  sets?: WriteSet[];
  /** 有氧分支（C6）：不传 sets。当前生成器不产出有氧动作，保留类型位。 */
  cardio?: true;
}

export interface WriteTrain {
  datestr: string;
  title: string;
  /** ms 时间戳（本地 +08:00 上午锚点）。 */
  start: number;
  end: number;
  movements: WriteMovement[];
  /** 更新已有训练时必带（C7）；新增不带。 */
  localid?: string;
}

export interface WriteRequestBody {
  schema_version: string;
  client_request_id: string;
  dry_run: boolean;
  res: WriteTrain[];
}

/** 写前校验违例（C1~C10）。 */
export interface Violation {
  code: string;
  message: string;
}

/** 单批发送结果（已解析）。 */
export interface BatchSendResult {
  ok: boolean;
  /**
   * 实写响应形态合法但内容为空（res.trains: []）——2026-09-30 实测：这既可能是
   * 「成功但不回显」，也可能是「限频静默丢弃」，语义未知。调用方必须 full 读回验证，
   * 绝不能直接判 success 或 failed（误判 failed 会诱发危险的重写→重复计划）。
   */
  uncertain: boolean;
  rateLimited: boolean;
  /** 响应解析出的 localid（成功时，顺序对应请求 trains）。 */
  localids: string[];
  errorCode: string | null;
  errorMessage: string | null;
  raw: unknown;
}

const MAX_TRAINS_PER_REQUEST = 4;
export const MAX_WRITE_MOVES_PER_TRAIN = 15;
export const MAX_WRITE_SETS_PER_MOVE = 20;
const MAX_PAYLOAD_BYTES = 128 * 1024;
/** 未来日期保守上限（实测 91~119，取下界；§6.3.4 C9）。 */
export const WRITE_FUTURE_DAYS_LIMIT = 91;

/** 当天上午 10:00（+08:00）锚点时间戳（与探针一致，避免凌晨歧义）。 */
export function dayStartTs(datestr: string, durationMin: number): { start: number; end: number } {
  const start = Date.parse(`${datestr}T10:00:00+08:00`);
  if (Number.isNaN(start)) throw new XunjiError({ code: 'UNKNOWN_API_ERROR', kind: 'fatal', message: `非法日期：${datestr}` });
  return { start, end: start + durationMin * 60_000 };
}

/**
 * 从 plan_day + plan_exercise 构造单条训练 payload（C4/C5/C6）。
 * 输入为已查询好的行结构，避免本模块依赖 repo。
 */
export interface PlanDayForWrite {
  datestr: string;
  title: string;
  estDurationMin: number | null;
  exercises: Array<{
    name: string;
    sets: number;
    reps: number | null;
    weight_kg: number | null;
    is_cardio: 0 | 1 | boolean;
  }>;
}

export function buildTrainFromPlanDay(day: PlanDayForWrite, durationFallbackMin = 45): { train: WriteTrain } {
  const movements: WriteMovement[] = day.exercises.map((ex) => {
    if (ex.is_cardio) {
      // C6：有氧分支探针未实测真实写入，保守阻断（见 validateBatch 的 CARDIO_UNVERIFIED）。
      return { name: ex.name, cardio: true };
    }
    const sets: WriteSet[] = [];
    for (let i = 0; i < ex.sets; i++) {
      // 只写重量 × 组数 × 次数：不给 RPE（PRD-v2 §11.4 决策 A —— 定了 RPE 也不看、不验证、
      // 调整用不上，不闭环的东西不进训记）。WriteSet.rpe 保留是 API 形状，不是本系统产出。
      sets.push({
        done: false,
        weight: ex.weight_kg === null ? '' : String(ex.weight_kg),
        unit: 'kg',
        reps: ex.reps === null ? '' : String(ex.reps),
      });
    }
    return { name: ex.name, sets };
  });
  const { start, end } = dayStartTs(day.datestr, day.estDurationMin ?? durationFallbackMin);
  return { train: { datestr: day.datestr, title: day.title, start, end, movements } };
}

/** 写前校验（§6.3.4 C1~C10 中适用于本系统单天单条的子集）。 */
export function validateTrain(train: WriteTrain, opts: { todayLocal: string; trainCount: number }): Violation[] {
  const v: Violation[] = [];
  // C1 单请求 ≤4 条且同一天（本系统每批固定 1 条；防御性保留计数校验）
  if (opts.trainCount > MAX_TRAINS_PER_REQUEST) {
    v.push({ code: 'C1_TOO_MANY_TRAINS', message: `单批训练条数 ${opts.trainCount} 超过上限 ${MAX_TRAINS_PER_REQUEST}` });
  }
  // C2 动作数（写侧 15，非读侧 40）
  if (train.movements.length > MAX_WRITE_MOVES_PER_TRAIN) {
    v.push({ code: 'C2_TOO_MANY_MOVES', message: `动作数 ${train.movements.length} 超过写侧上限 ${MAX_WRITE_MOVES_PER_TRAIN}（${train.datestr}）` });
  }
  for (const mv of train.movements) {
    if (!mv.name || !mv.name.trim()) {
      v.push({ code: 'C4_EMPTY_NAME', message: `存在空动作名（${train.datestr}）——动作名必须来自 movement_catalog 中文标准名` });
    }
    if (mv.cardio) continue; // 有氧无 sets；真实性由调用方阻断（CARDIO_UNVERIFIED）
    // C3 组数（写侧 20，非读侧 60）
    if ((mv.sets?.length ?? 0) > MAX_WRITE_SETS_PER_MOVE) {
      v.push({ code: 'C3_TOO_MANY_SETS', message: `「${mv.name}」组数 ${mv.sets?.length} 超过写侧上限 ${MAX_WRITE_SETS_PER_MOVE}（${train.datestr}）` });
    }
    for (const s of mv.sets ?? []) {
      // C5 每组至少有重量或次数（rpe 不算训练内容——Q29 结论）
      if (s.weight === '' && s.reps === '') {
        v.push({ code: 'C5_EMPTY_SET', message: `「${mv.name}」存在既无重量又无次数的组（${train.datestr}）` });
        break;
      }
    }
  }
  // C9 日期窗口：today ≤ datestr ≤ today+91（防误改历史 + 防超远期被拒）
  const dayTs = Date.parse(`${train.datestr}T00:00:00`);
  const todayTs = Date.parse(`${opts.todayLocal}T00:00:00`);
  if (Number.isNaN(dayTs) || dayTs < todayTs) {
    v.push({ code: 'C9_PAST_DATE', message: `日期 ${train.datestr} 早于今天 ${opts.todayLocal}——严禁写历史（事实）记录` });
  } else if (dayTs > todayTs + WRITE_FUTURE_DAYS_LIMIT * 86_400_000) {
    v.push({ code: 'C9_TOO_FAR', message: `日期 ${train.datestr} 超出未来 ${WRITE_FUTURE_DAYS_LIMIT} 天上限` });
  }
  // C10 payload ≤128KB
  const bytes = Buffer.byteLength(JSON.stringify(train), 'utf8');
  if (bytes > MAX_PAYLOAD_BYTES) {
    v.push({ code: 'C10_PAYLOAD_TOO_LARGE', message: `单条 payload ${bytes}B 超过 ${MAX_PAYLOAD_BYTES}B 上限` });
  }
  return v;
}

/**
 * 幂等键（§6.3.2）：`${planId}-${datestr}-b${batchNo}-${sha256(content).slice(0,8)}`
 * 内容不变 → 同 id（重试/dry_run 与实写同意图）；内容变了 → 新 id（确实要写新内容）。
 */
export function clientRequestId(planId: number, datestr: string, batchNo: number, trains: WriteTrain[]): string {
  const hash = createHash('sha256').update(JSON.stringify(trains)).digest('hex').slice(0, 8);
  return `${planId}-${datestr}-b${batchNo}-${hash}`;
}

export function buildWriteBody(trains: WriteTrain[], clientRequest_id: string, dryRun: boolean): WriteRequestBody {
  return { schema_version: SCHEMA_VERSION, client_request_id: clientRequest_id, dry_run: dryRun, res: trains };
}

/**
 * 解析写回响应：顶层 res（不保证 success）；限频在 error 字段。
 * 实测（2026-09-30 修正探针误判）：
 * - dry_run 参数无效，每个请求都是真实 upsert；
 * - 实写成功响应为 {"res": {..., "trains": []}} —— 不回显内容，trains 是空数组；
 *   但限频静默丢弃的响应同样是空数组，二者不可区分 → 实写空数组 = uncertain，
 *   最终判定交调用方 full 读回验证（writeService.readBackVerify）。
 * - res 形态完全缺失（连空 trains 都没有）才是确定性的解析/协议失败。
 */
export function parseWriteResponse(json: unknown, opts?: { dryRun?: boolean }): BatchSendResult {
  const obj = (json ?? {}) as { res?: unknown; error?: unknown };
  const errorText = obj.error === undefined || obj.error === null ? null : String(obj.error);
  if (errorText && /too frequent/i.test(errorText)) {
    return { ok: false, uncertain: false, rateLimited: true, localids: [], errorCode: 'RATE_LIMITED', errorMessage: errorText, raw: json };
  }
  const res = obj.res;
  // null = 形态缺失（既非 res[...] 也非 res.trains[...]）；[] = 形态合法但空（实写成功不回显）
  const trains: Array<Record<string, unknown>> | null = Array.isArray(res)
    ? (res as Array<Record<string, unknown>>)
    : res && typeof res === 'object' && Array.isArray((res as { trains?: unknown }).trains)
      ? ((res as { trains: Array<Record<string, unknown>> }).trains)
      : null;
  if (trains === null) {
    return {
      ok: false,
      uncertain: false,
      rateLimited: false,
      localids: [],
      errorCode: errorText ? 'API_ERROR' : 'NO_RES_TRAINS',
      errorMessage: errorText ?? '响应缺少 res.trains（形态缺失）',
      raw: json,
    };
  }
  if (opts?.dryRun !== true && trains.length === 0) {
    return {
      ok: false,
      uncertain: true,
      rateLimited: false,
      localids: [],
      errorCode: 'EMPTY_RES_TRAINS',
      errorMessage: '实写响应 res.trains 为空：可能成功不回显，也可能被限频静默丢弃——须读回验证',
      raw: json,
    };
  }
  const localids = trains.map((t) => (t.localid === undefined || t.localid === null ? '' : String(t.localid)));
  return { ok: true, uncertain: false, rateLimited: false, localids, errorCode: null, errorMessage: null, raw: json };
}

/** 单批发送（dry_run 与实写共用；限频间隔由调用方编排）。 */
export async function sendBatch(
  client: XunjiHttpClient,
  trains: WriteTrain[],
  requestId: string,
  dryRun: boolean,
): Promise<BatchSendResult> {
  const body = buildWriteBody(trains, requestId, dryRun);
  const result = await client.post(WRITE_PATH, body);
  if (result.parseError !== null) {
    return { ok: false, uncertain: false, rateLimited: false, localids: [], errorCode: 'PARSE_ERROR', errorMessage: result.parseError, raw: result.text.slice(0, 2000) };
  }
  if (result.httpStatus >= 400 && result.json === null) {
    return { ok: false, uncertain: false, rateLimited: false, localids: [], errorCode: `HTTP_${result.httpStatus}`, errorMessage: result.text.slice(0, 500), raw: null };
  }
  return parseWriteResponse(result.json, { dryRun });
}

export { WRITE_COOL_DOWN_MS, WRITE_PATH };
