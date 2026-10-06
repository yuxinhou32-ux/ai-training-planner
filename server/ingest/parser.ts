/**
 * 结构化解析器 ingest/parser（T1，§6.2.4 逐字段映射表）。
 *
 * 一手依据：docs/probe-report.md §1（填充率）+ §3（真实字段结构）。
 * 关键实测事实（写代码时不可更改）：
 *  - sets[].weight / reps / rpe / leftWeight 实测是 **字符串**（"30"、"10"、"266.71"）；
 *  - `setType === '热'` = 热身组（实测 57/912），直接落 is_warmup，不用启发式；
 *  - exetype 仅 'cardio' 语义已确认（→ is_cardio），help/plus_weight/weight 只落库留证；
 *  - movements[].type 是服务端粗粒度肌群标签（背/腿/胸/…），空串按 NULL；
 *  - 有氧组 metrics（distance/kcal/bpm）为字符串，distance 单位为 km（×1000 落 distance_m）；
 *  - 未知字段一律进 raw_json 兜底（不静默丢弃，红线 §6.2.4）；
 *  - 任一 truncated=true → 该天 ParsedDay.truncated，引擎据此发 data_quality 告警。
 */
import {
  MAX_READ_MOVES_PER_TRAIN,
  MAX_READ_SETS_PER_MOVE,
  OUTLIER_MAX_MINUTES,
  OUTLIER_MIN_MINUTES,
} from '../config/constants.js';
import { isValidDateStr, msToIsoUtc } from '../util/dates.js';
import { sha256Hex, stableStringify } from '../util/json.js';
import { normalizeName } from './normalize.js';
import type { MovementRaw, ResBody, SetRaw, TrainRaw } from '../xunji/types.js';

export interface ParsedSetRow {
  serverIndex: number | null;
  done: 0 | 1;
  setType: string | null;
  isWarmup: 0 | 1;
  warmupSource: 'server_set_type' | 'heuristic' | null;
  weightKg: number | null;
  weightUnit: string | null;
  reps: number | null;
  rpe: number | null;
  timeS: number | null;
  timeLabel: string | null;
  leftWeightKg: number | null;
  isSelfWeight: 0 | 1 | null;
  distanceM: number | null;
  kcal: number | null;
  avgHeartRate: number | null;
  maxHeartRate: number | null;
  side: 'left' | 'right' | null;
  note: string | null;
  comment: string | null;
  /** 未知字段兜底（未知字段的 JSON 文本；无未知字段为 null）。 */
  rawJson: string | null;
  /** 超级组/递减组子项（递归解析）。 */
  children: ParsedSetRow[];
}

export interface ParsedMovementRow {
  serverIndex: number | null;
  ord: number;
  nameRaw: string;
  nameNorm: string;
  serverType: string | null;
  exetype: string | null;
  singleSide: 0 | 1 | null;
  restTimeS: number | null;
  warnRestTime: number | null;
  isCardio: 0 | 1;
  isStretch: 0 | 1;
  /** movement 级有氧指标 + 未知字段兜底（`__unknown_fields__` 键）。 */
  metricsJson: string | null;
  /** 超级组/递减组子动作原始结构（首个含 items 的组）。 */
  itemsJson: string | null;
  notes: string | null;
  sets: ParsedSetRow[];
}

export interface ParsedSessionRow {
  datestr: string;
  localid: string;
  title: string | null;
  titleSource: 'server' | null;
  note: string | null;
  startMs: number | null;
  endMs: number | null;
  startedAt: string | null;
  endedAt: string | null;
  serverTruncated: 0 | 1 | null;
  durationMin: number | null;
  durationSrc: 'start_end' | 'declared' | 'estimated' | null;
  isOutlier: 0 | 1;
  outlierReason: 'too_short' | 'too_long' | 'missing_duration' | null;
  isCardio: 0 | 1;
  isRest: 0 | 1;
  sessionType: 'strength' | 'cardio' | 'mixed' | 'rest' | 'other';
  contentHash: string;
  movements: ParsedMovementRow[];
}

export interface ParsedDayCounts {
  trains: number;
  movements: number;
  sets: number;
}

export interface ParsedDay {
  datestr: string;
  sessions: ParsedSessionRow[];
  counts: ParsedDayCounts;
  /** 任一层（res/train/movement/超限检测）出现截断标记。 */
  truncated: boolean;
  /** 截断来源明细（供告警文案与排障）。 */
  truncatedSources: string[];
  /** 数据质量告警文案（引擎原样落 notification(level=warn)）。 */
  warnings: string[];
}

/* ------------------------------------------------------------------ */
/* 防御性取值工具                                                       */
/* ------------------------------------------------------------------ */

/** 字符串化并去空格；空串 → null。数字原样转字符串。 */
function toTrimmedString(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string') {
    const t = v.trim();
    return t === '' ? null : t;
  }
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return null;
}

/** 数字解析：number 直接用；字符串去空格后 Number()；''/非法 → null。 */
function toNullableNumber(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const t = v.trim();
    if (t === '') return null;
    const n = Number(t);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** 整数解析：四舍五入（reps "10" / bpm "133" / time 60）。 */
function toNullableInt(v: unknown): number | null {
  const n = toNullableNumber(v);
  return n === null ? null : Math.round(n);
}

function toBool01(v: unknown): 0 | 1 | null {
  if (v === true) return 1;
  if (v === false) return 0;
  return null;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** 提取不在已知集合里的字段（raw_json 兜底，§6.2.4「不静默丢弃」）。 */
function pickUnknown(obj: Record<string, unknown>, known: ReadonlySet<string>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (!known.has(k)) out[k] = v;
  }
  return out;
}

const KNOWN_SET_KEYS: ReadonlySet<string> = new Set([
  'index',
  'done',
  'weight',
  'unit',
  'reps',
  'time',
  'timeLabel',
  'selfWeight',
  'rpe',
  'note',
  'comment',
  'setType',
  'leftWeight',
  'metrics',
  'items',
  'distance',
  'kcal',
  'bpm',
]);

const KNOWN_MOVEMENT_KEYS: ReadonlySet<string> = new Set([
  'index',
  'name',
  'type',
  'exetype',
  'sets',
  'truncated',
  'note',
  'singleSide',
  'restTime',
  'warn_restTime',
]);

const KNOWN_TRAIN_KEYS: ReadonlySet<string> = new Set([
  'localid',
  'datestr',
  'title',
  'note',
  'start',
  'end',
  'started_at',
  'ended_at',
  'movements',
  'truncated',
]);

/* ------------------------------------------------------------------ */
/* 解析实现                                                             */
/* ------------------------------------------------------------------ */

/** metrics.distance 实测单位为 km（样本 "1.97" km ≈ 266 kcal 慢跑），落库 ×1000 转米。 */
const KM_TO_M = 1000;

/** 组级有氧指标字段（未在 probe §3.5 独立列出，但 90 天样本中已出现）。 */
const MOVEMENT_METRIC_KEYS = [
  'distance',
  'kcal',
  'bpm',
  'workoutTime',
  'avgHeartRate',
  'maxHeartRate',
] as const;

export function parseSet(raw: SetRaw): ParsedSetRow {
  const obj: Record<string, unknown> = isPlainObject(raw) ? raw : {};

  const metrics = isPlainObject(obj.metrics) ? obj.metrics : {};
  // 有氧指标优先取 metrics 对象，其次取组级平铺副本（实测两者同值并存）
  const distanceRaw = metrics.distance ?? obj.distance;
  const kcalRaw = metrics.kcal ?? obj.kcal;
  const bpmRaw = metrics.bpm ?? obj.bpm;

  const distanceNum = toNullableNumber(distanceRaw);
  const kcalNum = toNullableNumber(kcalRaw);
  const avgHr = toNullableInt(bpmRaw);

  const setType = toTrimmedString(obj.setType);
  const isWarmup: 0 | 1 = setType === '热' ? 1 : 0;

  const unknown = pickUnknown(obj, KNOWN_SET_KEYS);

  const items = Array.isArray(obj.items) ? (obj.items as unknown[]) : [];
  const children = items.filter(isPlainObject).map((c) => parseSet(c as SetRaw));

  return {
    serverIndex: toNullableInt(obj.index),
    done: obj.done === false ? 0 : 1, // 缺失视为已完成（DDL default 1）
    setType,
    isWarmup,
    warmupSource: isWarmup === 1 ? 'server_set_type' : null,
    weightKg: toNullableNumber(obj.weight),
    weightUnit: toTrimmedString(obj.unit),
    reps: toNullableInt(obj.reps),
    rpe: toNullableNumber(obj.rpe),
    timeS: toNullableInt(obj.time),
    timeLabel: toTrimmedString(obj.timeLabel),
    leftWeightKg: toNullableNumber(obj.leftWeight),
    isSelfWeight: toBool01(obj.selfWeight),
    distanceM: distanceNum === null ? null : distanceNum * KM_TO_M,
    kcal: kcalNum,
    avgHeartRate: avgHr,
    maxHeartRate: null, // 实测无来源字段
    side: null, // T1 无左右侧判据；left_weight_kg 单独落库（实测左右恒等重）
    note: toTrimmedString(obj.note),
    comment: toTrimmedString(obj.comment),
    rawJson: Object.keys(unknown).length > 0 ? stableStringify(unknown) : null,
    children,
  };
}

/** 展开超级组父子（含递归）；计数与落库共用。 */
export function flattenSets(sets: ParsedSetRow[]): Array<{ row: ParsedSetRow; depth: number }> {
  const out: Array<{ row: ParsedSetRow; depth: number }> = [];
  const walk = (rows: ParsedSetRow[], depth: number): void => {
    for (const r of rows) {
      out.push({ row: r, depth });
      if (r.children.length > 0) walk(r.children, depth + 1);
    }
  };
  walk(sets, 0);
  return out;
}

export function parseMovement(raw: MovementRaw, ord: number): ParsedMovementRow {
  const obj: Record<string, unknown> = isPlainObject(raw) ? raw : {};

  const nameRaw = toTrimmedString(obj.name) ?? '';
  const serverType = toTrimmedString(obj.type);
  const exetype = toTrimmedString(obj.exetype);

  // movement 级有氧指标（probe 实测未出现，防御性支持）+ 未知字段兜底
  const unknown = pickUnknown(obj, KNOWN_MOVEMENT_KEYS);
  const metricObj: Record<string, unknown> = {};
  for (const key of MOVEMENT_METRIC_KEYS) {
    if (obj[key] !== undefined) metricObj[key] = obj[key];
    else if (unknown[key] !== undefined) {
      metricObj[key] = unknown[key];
      delete unknown[key];
    }
  }
  const hasMetrics = Object.keys(metricObj).length > 0;
  const hasUnknown = Object.keys(unknown).length > 0;
  const metricsJson =
    hasMetrics || hasUnknown
      ? stableStringify(hasUnknown ? { ...metricObj, __unknown_fields__: unknown } : metricObj)
      : null;

  const setsRaw = Array.isArray(obj.sets) ? (obj.sets as unknown[]) : [];
  const sets = setsRaw.filter(isPlainObject).map((s) => parseSet(s as SetRaw));

  // 超级组/递减组：保留首个 items 的原始结构（DDL items_json 语义），供 T2 分析
  let itemsJson: string | null = null;
  for (const s of setsRaw) {
    if (isPlainObject(s) && Array.isArray(s.items)) {
      itemsJson = stableStringify(s.items);
      break;
    }
  }

  return {
    serverIndex: toNullableInt(obj.index),
    ord,
    nameRaw,
    nameNorm: normalizeName(nameRaw),
    serverType,
    exetype,
    singleSide: toBool01(obj.singleSide),
    restTimeS: toNullableInt(obj.restTime),
    warnRestTime: toNullableInt(obj.warn_restTime),
    isCardio: exetype === 'cardio' ? 1 : 0, // N4 已确认仅 cardio 语义可用
    isStretch: serverType === '拉伸' ? 1 : 0,
    metricsJson,
    itemsJson,
    notes: toTrimmedString(obj.note),
    sets,
  };
}

export function parseTrain(
  requestedDatestr: string,
  raw: TrainRaw,
  ordIdx: number,
  ctx: { truncatedSources: string[]; warnings: string[] },
): ParsedSessionRow {
  const t: Record<string, unknown> = isPlainObject(raw) ? raw : {};

  const datestr = isValidDateStr(t.datestr) ? t.datestr : requestedDatestr;
  const startMs = toNullableInt(t.start);
  const endMs = toNullableInt(t.end);
  const title = toTrimmedString(t.title);

  // localid 缺失时构造稳定替身（实测 100% 有值；防御性兜底保证幂等 upsert 键稳定）
  let localid = toTrimmedString(t.localid);
  if (localid === null) {
    localid = startMs !== null ? `start:${startMs}` : `idx:${ordIdx}`;
    ctx.warnings.push(`${datestr} train#${ordIdx} 缺少 localid，已用替身键 ${localid}`);
  }

  // 截断标志（train 级）
  const serverTruncated = t.truncated === true ? 1 : t.truncated === false ? 0 : null;
  if (serverTruncated === 1) {
    ctx.truncatedSources.push(`train#${ordIdx}(localid=${localid}).truncated`);
  }

  // 时长与离群判定（§4.1.5：20~150 min 之外为离群；缺失也算异常并留 reason）
  let durationMin: number | null = null;
  let durationSrc: 'start_end' | 'declared' | 'estimated' | null = null;
  let isOutlier: 0 | 1 = 0;
  let outlierReason: 'too_short' | 'too_long' | 'missing_duration' | null = null;
  if (startMs !== null && endMs !== null && endMs >= startMs) {
    durationMin = Math.round(((endMs - startMs) / 60000) * 100) / 100;
    durationSrc = 'start_end';
    if (durationMin < OUTLIER_MIN_MINUTES) {
      isOutlier = 1;
      outlierReason = 'too_short';
    } else if (durationMin > OUTLIER_MAX_MINUTES) {
      isOutlier = 1;
      outlierReason = 'too_long';
    }
  } else {
    isOutlier = 1;
    outlierReason = 'missing_duration';
    ctx.warnings.push(`${datestr} train#${ordIdx} 缺少有效的 start/end，无法计算时长`);
  }

  // movements 解析 + 读侧上限检测（40，§6.2.4，写侧 15 勿混用）
  const movementsRaw = Array.isArray(t.movements) ? (t.movements as unknown[]) : [];
  const validRawMovements = movementsRaw.filter(isPlainObject) as Array<Record<string, unknown>>;
  const movements = validRawMovements.map((m, i) => parseMovement(m as MovementRaw, i + 1));
  if (movements.length > MAX_READ_MOVES_PER_TRAIN) {
    ctx.truncatedSources.push(`train#${ordIdx} movements 数 ${movements.length} 超过读侧上限 ${MAX_READ_MOVES_PER_TRAIN}`);
  }

  // movement 级截断标志（§6.2.4：服务端可能在单个动作上打 truncated）
  validRawMovements.forEach((m, i) => {
    if (m.truncated === true) {
      const p = movements[i];
      ctx.truncatedSources.push(
        `train#${ordIdx} movements[${p.ord}]「${p.nameRaw}」movement.truncated=true`,
      );
    }
  });

  // sets 读侧上限检测（60）
  for (const m of movements) {
    if (m.sets.length > MAX_READ_SETS_PER_MOVE) {
      ctx.truncatedSources.push(
        `train#${ordIdx} movements[${m.ord}]「${m.nameRaw}」组数 ${m.sets.length} 超过读侧上限 ${MAX_READ_SETS_PER_MOVE}`,
      );
    }
  }

  // session_type（§6.2.4：不得依赖 title；T1 用 exetype/server_type 的退化口径，肌群占比口径归 T2）
  const cardioCount = movements.filter((m) => m.isCardio === 1).length;
  const stretchCount = movements.filter((m) => m.isStretch === 1).length;
  let sessionType: ParsedSessionRow['sessionType'];
  if (movements.length === 0) sessionType = 'other';
  else if (cardioCount === movements.length) sessionType = 'cardio';
  else if (cardioCount > 0) sessionType = 'mixed';
  else if (stretchCount === movements.length) sessionType = 'other';
  else sessionType = 'strength';

  const startedAt = typeof t.started_at === 'number' ? msToIsoUtc(t.started_at) : toTrimmedString(t.started_at);
  const endedAt = typeof t.ended_at === 'number' ? msToIsoUtc(t.ended_at) : toTrimmedString(t.ended_at);

  // 未知 train 级字段 → 汇入 content_hash 的 raw 兜底（payload 完整性由 raw_train_raw 保证）
  const unknownTrain = pickUnknown(t, KNOWN_TRAIN_KEYS);

  // 结构内容哈希：同结构同哈希，触发增量跳过（§6.2.3「内容」判定）
  const canonical = {
    localid,
    datestr,
    title,
    note: toTrimmedString(t.note),
    start: startMs,
    end: endMs,
    startedAt,
    endedAt,
    truncated: serverTruncated,
    unknown: Object.keys(unknownTrain).length > 0 ? unknownTrain : null,
    movements: movements.map((m) => ({
      index: m.serverIndex,
      name: m.nameRaw,
      type: m.serverType,
      exetype: m.exetype,
      singleSide: m.singleSide,
      restTime: m.restTimeS,
      warnRestTime: m.warnRestTime,
      note: m.notes,
      sets: flattenSets(m.sets).map(({ row: s, depth }) => ({
        index: s.serverIndex,
        depth,
        done: s.done,
        setType: s.setType,
        weight: s.weightKg,
        unit: s.weightUnit,
        reps: s.reps,
        rpe: s.rpe,
        time: s.timeS,
        timeLabel: s.timeLabel,
        leftWeight: s.leftWeightKg,
        selfWeight: s.isSelfWeight,
        distance: s.distanceM,
        kcal: s.kcal,
        avgHr: s.avgHeartRate,
        note: s.note,
        comment: s.comment,
        raw: s.rawJson,
      })),
    })),
  };

  return {
    datestr,
    localid,
    title,
    titleSource: title === null ? null : 'server',
    note: toTrimmedString(t.note),
    startMs,
    endMs,
    startedAt,
    endedAt,
    serverTruncated,
    durationMin,
    durationSrc,
    isOutlier,
    outlierReason,
    isCardio: cardioCount > 0 ? 1 : 0,
    isRest: 0, // T1 无休息日判定数据源（休息日本来就没有 train 记录）
    sessionType,
    contentHash: sha256Hex(stableStringify(canonical)),
    movements,
  };
}

/** 解析一整天：res（响应外壳）→ ParsedDay。 */
export function parseDay(requestedDatestr: string, res: ResBody): ParsedDay {
  const ctx = { truncatedSources: [] as string[], warnings: [] as string[] };

  const r: Record<string, unknown> = isPlainObject(res) ? res : {};
  if (r.truncated === true) ctx.truncatedSources.push('res.truncated');

  const trainsRaw = Array.isArray(r.trains) ? (r.trains as unknown[]) : [];
  if (r.trains !== undefined && !Array.isArray(r.trains)) {
    ctx.warnings.push(`${requestedDatestr} res.trains 字段类型异常（非数组），按空处理`);
  }

  const sessions = trainsRaw.filter(isPlainObject).map((t, i) =>
    parseTrain(requestedDatestr, t as TrainRaw, i + 1, ctx),
  );

  let movementCount = 0;
  let setCount = 0;
  for (const s of sessions) {
    movementCount += s.movements.length;
    for (const m of s.movements) setCount += flattenSets(m.sets).length;
  }

  return {
    datestr: requestedDatestr,
    sessions,
    counts: { trains: sessions.length, movements: movementCount, sets: setCount },
    truncated: ctx.truncatedSources.length > 0,
    truncatedSources: ctx.truncatedSources,
    warnings: ctx.warnings,
  };
}
