/**
 * 训记 Open API 响应类型（T1）。
 *
 * ⚠️ 设计原则：服务端字段一律 `unknown` + 解析器防御性收窄。
 * 依据 docs/probe-report.md §3（真实字段结构）：
 *  - sets[].weight / reps / rpe / leftWeight 实测均为 **字符串**（"30"、"10"）；
 *  - cardio 组的 metrics（distance/kcal/bpm）同样是字符串，且在组层级有平铺副本；
 *  - 所有「full 模式独有」字段可能缺失 —— 任何访问都必须判空。
 */
export interface XunjiLimits {
  maxTrainsPerDay: number;
  maxMovesPerTrain: number;
  maxSetsPerMove: number;
  maxWriteMovesPerTrain: number;
  maxWriteSetsPerMove: number;
  maxPayloadBytes: number;
  maxResponseBytes: number;
  readRateLimitSeconds: number;
  readRateLimitSecondsLight: number;
  readRateLimitSecondsFull: number;
  writeRateLimitSeconds: number;
}

/** res 外壳（§6.2.1：成功时核心数据在 res，训练列表在 res.trains）。 */
export interface ResBody {
  datestr?: unknown;
  includeFullData?: unknown;
  include_full_data?: unknown;
  limits?: unknown;
  mode?: unknown;
  movementCatalogUrl?: unknown;
  movement_catalog_url?: unknown;
  schema?: unknown;
  schema_version?: unknown;
  trains?: unknown;
  truncated?: unknown;
  version?: unknown;
  [key: string]: unknown;
}

/** trains[] 元素（实测字段见 probe-report §3.3）。 */
export interface TrainRaw {
  localid?: unknown;
  datestr?: unknown;
  title?: unknown;
  note?: unknown;
  start?: unknown;
  end?: unknown;
  started_at?: unknown;
  ended_at?: unknown;
  movements?: unknown;
  truncated?: unknown;
  [key: string]: unknown;
}

/** movements[] 元素。 */
export interface MovementRaw {
  index?: unknown;
  name?: unknown;
  type?: unknown;
  exetype?: unknown;
  sets?: unknown;
  truncated?: unknown;
  note?: unknown;
  singleSide?: unknown;
  restTime?: unknown;
  warn_restTime?: unknown;
  [key: string]: unknown;
}

/** sets[] 元素。 */
export interface SetRaw {
  index?: unknown;
  done?: unknown;
  weight?: unknown;
  unit?: unknown;
  reps?: unknown;
  time?: unknown;
  timeLabel?: unknown;
  selfWeight?: unknown;
  rpe?: unknown;
  note?: unknown;
  comment?: unknown;
  setType?: unknown;
  leftWeight?: unknown;
  metrics?: unknown;
  items?: unknown;
  [key: string]: unknown;
}

/** 响应信封：{ success: true, res: {...} } 或 { success: false, res|error: "..." }。 */
export interface XunjiEnvelope {
  success?: unknown;
  res?: unknown;
  error?: unknown;
  [key: string]: unknown;
}

/**
 * 防御性解析 res.limits（结构变化时返回 null，而不是抛错 —— 触发三源之③兜底）。
 */
export function parseLimits(raw: unknown): XunjiLimits | null {
  if (raw === null || raw === undefined || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const num = (v: unknown): number | null =>
    typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null;
  const readFull = num(o.readRateLimitSecondsFull);
  const readAny = num(o.readRateLimitSeconds);
  // 冷却字段一个都读不出来 = 响应结构变化 → null（上游走 90s 兜底）
  if (readFull === null && readAny === null) return null;
  return {
    maxTrainsPerDay: num(o.maxTrainsPerDay) ?? 4,
    maxMovesPerTrain: num(o.maxMovesPerTrain) ?? 40,
    maxSetsPerMove: num(o.maxSetsPerMove) ?? 60,
    maxWriteMovesPerTrain: num(o.maxWriteMovesPerTrain) ?? 15,
    maxWriteSetsPerMove: num(o.maxWriteSetsPerMove) ?? 20,
    maxPayloadBytes: num(o.maxPayloadBytes) ?? 131_072,
    maxResponseBytes: num(o.maxResponseBytes) ?? 196_608,
    readRateLimitSeconds: readAny ?? readFull ?? 30,
    readRateLimitSecondsLight: num(o.readRateLimitSecondsLight) ?? 15,
    readRateLimitSecondsFull: readFull ?? readAny ?? 30,
    writeRateLimitSeconds: num(o.writeRateLimitSeconds) ?? 45,
  };
}
