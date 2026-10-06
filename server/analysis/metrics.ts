/**
 * 分析指标层（§4.1 指标口径 + §4.4 data_quality/basic_stats/muscle_volume）。
 *
 * 设计：一次性把 12 周窗口内的「扁平组行」拉进内存（实测规模 912 行/12周，
 * 量级无关紧要），后续所有统计在 TS 里做——避免为每个指标写一条 SQL 变体，
 * 也保证「有效组」判据全局只有一处定义（§4.1.1 口径一句话定义）。
 */
import type { Db } from '../db/index.js';
import { prepare } from '../db/index.js';
import { shiftDays } from '../util/dates.js';
import { ANALYSIS_WINDOW_WEEKS } from './window.js';
import type { BasicStats, DataQuality, ExcludedOutlier, MuscleVolumeEntry } from './reportSchema.js';

export interface WindowInfo {
  trendStart: string;
  trendEnd: string;
  recentStart: string;
  recentEnd: string;
  weeks: number;
  /**
   * 窗口内「实际被数据覆盖的周数」（可选：`computeWindow` 不碰数据，由 runAnalysis 用 sessions 填）。
   * 周均类指标的分母用它，而不是名义的 `weeks` —— 见 computeActiveWeeks。
   */
  activeWeeks?: number;
}

/** 窗口：[trendEnd-(weeks*7-1), trendEnd]，含两端，共 weeks*7 天。 */
export function computeWindow(trendEnd: string, weeks: number = ANALYSIS_WINDOW_WEEKS): WindowInfo {
  return {
    trendEnd,
    trendStart: shiftDays(trendEnd, -(weeks * 7 - 1)),
    recentEnd: trendEnd,
    recentStart: shiftDays(trendEnd, -27),
    weeks,
  };
}

/**
 * 窗口内「实际被数据覆盖的周数」—— 从窗口内最早一次训练到 trendEnd（含首尾所在周），
 * 下限 1、上限 = 窗口周数。没有训练时返回 1。
 *
 * 🔴 为什么不能用名义窗口当分母：只练了 12 周的人放在 26 周窗口里，
 *    被 26 除会把「周均 2.58 次」算成「1.19 次」——这个数会进 digest 喂给 AI。
 *    自检：(2026-09-27 − 2026-07-06) = 83 天 → floor(83/7)=11 → +1 = 12 → 31/12 = 2.58 ✅
 */
export function computeActiveWeeks(trendEnd: string, weeks: number, sessions: SessionRow[]): number {
  if (sessions.length === 0) return 1;
  let earliest = sessions[0].datestr;
  for (const s of sessions) if (s.datestr < earliest) earliest = s.datestr;
  const active = Math.floor((datestrToMs(trendEnd) - datestrToMs(earliest)) / (DAY_MS * 7)) + 1;
  return Math.max(1, Math.min(weeks, active));
}

export interface SessionRow {
  id: number;
  datestr: string;
  title: string | null;
  durationMin: number | null;
  durationSrc: string | null;
  isOutlier: 0 | 1;
  outlierReason: string | null;
  sessionType: string | null;
  /** 0=周日 … 6=周六 */
  dow: number;
}

export interface SetRow {
  smId: number;
  sessionId: number;
  datestr: string;
  weeksAgo: number;
  catalogId: number | null;
  nameRaw: string;
  isCardio: 0 | 1;
  isStretch: 0 | 1;
  restTimeS: number | null;
  serverType: string | null;
  done: 0 | 1;
  isWarmup: 0 | 1;
  warmupSource: string | null;
  rpe: number | null;
  weightKg: number | null;
  reps: number | null;
  timeS: number | null;
}

export interface MuscleMapRow {
  catalogId: number;
  muscleCode: string;
  role: 'primary' | 'secondary';
  weight: number;
  source: string;
  confidence: string;
}

export interface MuscleGroupInfo {
  code: string;
  nameZh: string;
  parentCode: string | null;
  region: 'upper' | 'lower' | 'core' | 'other';
  size: 'large' | 'small' | 'other';
}

const DAY_MS = 86_400_000;

/** datestr（本地时区）→ 当日零点 epoch ms。 */
export function datestrToMs(datestr: string): number {
  const [y, m, d] = datestr.split('-').map(Number);
  return new Date(y, m - 1, d).getTime();
}

/** weeks_ago = floor((w_end - datestr)/7 天)，与 Q-B/Q-D 的 julianday 口径一致（0=最近一周）。 */
export function weeksAgoOf(trendEnd: string, datestr: string): number {
  return Math.floor((datestrToMs(trendEnd) - datestrToMs(datestr)) / DAY_MS / 7);
}

export function dowOf(datestr: string): number {
  return new Date(datestrToMs(datestr)).getDay();
}

/**
 * 有效组判据（§4.1.1 定稿口径，全局唯一）：
 * done=1 且 非热身 且 动作非有氧/非拉伸。
 * 超级组父组在 T1 解析时已只落子项为可统计行，无需额外判断。
 */
export function isEffectiveSet(r: SetRow): boolean {
  return r.done === 1 && r.isWarmup === 0 && r.isCardio === 0 && r.isStretch === 0;
}

interface SessionDbRow {
  id: number;
  datestr: string;
  title: string | null;
  duration_min: number | null;
  duration_src: string | null;
  is_outlier: number;
  outlier_reason: string | null;
  session_type: string | null;
}

export function loadSessions(db: Db, w: WindowInfo): SessionRow[] {
  const rows = prepare(
    db,
    `SELECT id, datestr, title, duration_min, duration_src, is_outlier, outlier_reason, session_type
     FROM train_session
     WHERE datestr BETWEEN ? AND ? AND is_rest = 0
     ORDER BY datestr, id`,
  ).all(w.trendStart, w.trendEnd) as unknown as SessionDbRow[];
  return rows.map((r) => ({
    id: Number(r.id),
    datestr: r.datestr,
    title: r.title,
    durationMin: r.duration_min === null ? null : Number(r.duration_min),
    durationSrc: r.duration_src,
    isOutlier: Number(r.is_outlier) === 1 ? 1 : 0,
    outlierReason: r.outlier_reason,
    sessionType: r.session_type,
    dow: dowOf(r.datestr),
  }));
}

interface SetDbRow {
  sm_id: number;
  session_id: number;
  datestr: string;
  catalog_id: number | null;
  name_raw: string;
  is_cardio: number;
  is_stretch: number;
  rest_time_s: number | null;
  server_type: string | null;
  done: number;
  is_warmup: number;
  warmup_source: string | null;
  rpe: number | null;
  weight_kg: number | null;
  reps: number | null;
  time_s: number | null;
}

/** 扁平组行（含未完成/热身组——data_quality 与疲劳信号 S6 需要全量）。 */
export function loadSetRows(db: Db, w: WindowInfo): SetRow[] {
  const rows = prepare(
    db,
    `SELECT sm.id AS sm_id, sm.session_id, s.datestr, sm.catalog_id, sm.name_raw,
            sm.is_cardio, sm.is_stretch, sm.rest_time_s, sm.server_type,
            ms.done, ms.is_warmup, ms.warmup_source, ms.rpe, ms.weight_kg, ms.reps, ms.time_s
     FROM train_session s
     JOIN session_movement sm ON sm.session_id = s.id
     JOIN movement_set ms ON ms.session_movement_id = sm.id
     WHERE s.datestr BETWEEN ? AND ? AND s.is_rest = 0
     ORDER BY s.datestr, sm.ord, ms.ord`,
  ).all(w.trendStart, w.trendEnd) as unknown as SetDbRow[];
  return rows.map((r) => ({
    smId: Number(r.sm_id),
    sessionId: Number(r.session_id),
    datestr: r.datestr,
    weeksAgo: weeksAgoOf(w.trendEnd, r.datestr),
    catalogId: r.catalog_id === null ? null : Number(r.catalog_id),
    nameRaw: r.name_raw,
    isCardio: Number(r.is_cardio) === 1 ? 1 : 0,
    isStretch: Number(r.is_stretch) === 1 ? 1 : 0,
    restTimeS: r.rest_time_s === null ? null : Number(r.rest_time_s),
    serverType: r.server_type,
    done: Number(r.done) === 1 ? 1 : 0,
    isWarmup: Number(r.is_warmup) === 1 ? 1 : 0,
    warmupSource: r.warmup_source,
    rpe: r.rpe === null ? null : Number(r.rpe),
    weightKg: r.weight_kg === null ? null : Number(r.weight_kg),
    reps: r.reps === null ? null : Number(r.reps),
    timeS: r.time_s === null ? null : Number(r.time_s),
  }));
}

export function loadMuscleMaps(db: Db): Map<number, MuscleMapRow[]> {
  const rows = prepare(
    db,
    `SELECT catalog_id, muscle_code, role, weight, source, confidence FROM movement_muscle_map`,
  ).all() as unknown as Array<{
    catalog_id: number;
    muscle_code: string;
    role: string;
    weight: number;
    source: string;
    confidence: string;
  }>;
  const out = new Map<number, MuscleMapRow[]>();
  for (const r of rows) {
    const cid = Number(r.catalog_id);
    const list = out.get(cid) ?? [];
    list.push({
      catalogId: cid,
      muscleCode: r.muscle_code,
      role: r.role === 'primary' ? 'primary' : 'secondary',
      weight: Number(r.weight),
      source: r.source,
      confidence: r.confidence,
    });
    out.set(cid, list);
  }
  return out;
}

export function loadMuscleGroups(db: Db): Map<string, MuscleGroupInfo> {
  const rows = prepare(db, `SELECT code, name_zh, parent_code, region, size FROM muscle_group`).all() as unknown as Array<{
    code: string;
    name_zh: string;
    parent_code: string | null;
    region: string;
    size: string;
  }>;
  const out = new Map<string, MuscleGroupInfo>();
  for (const r of rows) {
    out.set(r.code, {
      code: r.code,
      nameZh: r.name_zh,
      parentCode: r.parent_code,
      region: r.region as MuscleGroupInfo['region'],
      size: r.size as MuscleGroupInfo['size'],
    });
  }
  return out;
}

/** 三段分段的段宽（周）—— 三段合计固定覆盖「最近 SEGMENT_WEEKS*3 = 12 周」。 */
export const SEGMENT_WEEKS = 4;

/**
 * 肌群训练量（Q-B 口径）：每有效组向该动作映射的每个肌群累加 map.weight
 * （primary 默认 1.0 / secondary 默认 0.5，权重已落库在 weight 列）。
 *
 * 🔴 分段口径：`sets_per_week_seg0/1/2` 固定覆盖**最近 12 周**（seg0=近 4 周 / seg1=5-8 周 /
 *    seg2=9-12 周，段宽 `SEGMENT_WEEKS`），**与 ANALYSIS_WINDOW_WEEKS 无关** ——
 *    肌群的 insufficient/excess 本质是「近期」判断（阈值 8/22 组每周也是按周设计的），
 *    把段拉长到覆盖 26 周会把 4 周的缺口摊平，反而让判定变钝。
 *    而 `sets_total` 覆盖**整个分析窗口**。两者时间跨度不同，UI 上必须分别标注。
 */
export function computeMuscleVolume(
  setRows: SetRow[],
  maps: Map<number, MuscleMapRow[]>,
): {
  volume: Record<string, MuscleVolumeEntry>;
} {
  const acc = new Map<string, { seg: [number, number, number]; total: number }>();
  for (const r of setRows) {
    if (!isEffectiveSet(r) || r.catalogId === null) continue;
    const maps4 = maps.get(r.catalogId);
    if (!maps4) continue;
    const segIdx = r.weeksAgo < SEGMENT_WEEKS ? 0 : r.weeksAgo < SEGMENT_WEEKS * 2 ? 1 : 2;
    for (const m of maps4) {
      let a = acc.get(m.muscleCode);
      if (!a) {
        a = { seg: [0, 0, 0], total: 0 };
        acc.set(m.muscleCode, a);
      }
      a.seg[segIdx] += m.weight;
      a.total += m.weight;
    }
  }
  const volume: Record<string, MuscleVolumeEntry> = {};
  for (const [code, a] of acc) {
    volume[code] = {
      sets_total: round2(a.total),
      sets_per_week_seg0: round2(a.seg[0] / SEGMENT_WEEKS),
      sets_per_week_seg1: round2(a.seg[1] / SEGMENT_WEEKS),
      sets_per_week_seg2: round2(a.seg[2] / SEGMENT_WEEKS),
    };
  }
  return { volume };
}

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function mean(xs: number[]): number | null {
  if (xs.length === 0) return null;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

/** 样本标准差（n-1）；不足 2 个样本返回 null。 */
export function stdev(xs: number[]): number | null {
  if (xs.length < 2) return null;
  const m = mean(xs)!;
  const v = xs.reduce((a, b) => a + (b - m) * (b - m), 0) / (xs.length - 1);
  return Math.sqrt(v);
}

export function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export interface DurationStats {
  /** 全窗口可用时长（剔除离群与缺失），供 R-AG-16 离散度与 avg_duration_min。 */
  allWindow: number[];
  avg: number | null;
}

/** 时长统计（§4.1.5：离群/缺失一律剔除出时长维度，绝不删除数据）。 */
export function computeDurationStats(sessions: SessionRow[]): DurationStats {
  const allWindow = sessions
    .filter((s) => s.durationMin !== null && s.isOutlier === 0)
    .map((s) => s.durationMin as number);
  return { allWindow, avg: mean(allWindow) };
}

/** 最近 recentWeeks 周的可用时长（R-AG-12 用）。 */
export function recentDurations(sessions: SessionRow[], trendEnd: string, recentWeeks: number): number[] {
  return sessions
    .filter((s) => s.durationMin !== null && s.isOutlier === 0 && weeksAgoOf(trendEnd, s.datestr) < recentWeeks)
    .map((s) => s.durationMin as number);
}

export interface QualityInput {
  sessions: SessionRow[];
  setRows: SetRow[];
  syncedDays: number;
}

/** data_quality 组装（§4.4；unmapped 基于有效组口径）。 */
export function computeDataQuality(input: QualityInput): DataQuality {
  const { sessions, setRows, syncedDays } = input;
  const eff = setRows.filter(isEffectiveSet);
  const effCount = eff.length;
  const unmapped = eff.filter((r) => r.catalogId === null).length;

  const smIds = new Set(setRows.map((r) => r.smId));
  const smWithServerType = new Set(setRows.filter((r) => r.serverType !== null).map((r) => r.smId));

  const outliers: ExcludedOutlier[] = sessions
    .filter((s) => s.isOutlier === 1 || s.durationMin === null)
    .map((s) => ({
      datestr: s.datestr,
      duration_min: s.durationMin,
      reason:
        s.durationMin === null
          ? 'missing_duration'
          : (s.outlierReason as ExcludedOutlier['reason']) ?? 'too_long',
    }));

  // 热身组识别依据：全程 full 模式恒为 server_set_type；出现 heuristic 即 mixed
  const warmupRows = setRows.filter((r) => r.isWarmup === 1);
  const hasHeuristic = warmupRows.some((r) => r.warmupSource === 'heuristic');
  const hasServer = warmupRows.some((r) => r.warmupSource === 'server_set_type');
  const warmupSource: DataQuality['warmup_source'] =
    warmupRows.length === 0 ? 'server_set_type' : hasHeuristic && hasServer ? 'mixed' : hasHeuristic ? 'heuristic' : 'server_set_type';

  return {
    duration_coverage: sessions.length === 0 ? 0 : round2(sessions.filter((s) => s.durationMin !== null).length / sessions.length),
    unmapped_set_ratio: effCount === 0 ? 0 : round2(unmapped / effCount),
    total_sessions: sessions.length,
    synced_days: syncedDays,
    server_type_coverage: smIds.size === 0 ? 0 : round2(smWithServerType.size / smIds.size),
    excluded_outliers: outliers,
    warmup_source: warmupSource,
    warnings: [],
  };
}

export function computeBasicStats(
  sessions: SessionRow[],
  setRows: SetRow[],
  weeks: number,
  activeWeeks?: number,
): BasicStats {
  const effCount = setRows.filter(isEffectiveSet).length;
  const cardio = sessions.filter((s) => s.sessionType === 'cardio').length;
  const strength = sessions.length - cardio;
  const durations = sessions.filter((s) => s.durationMin !== null && s.isOutlier === 0).map((s) => s.durationMin as number);

  const dowCount = new Map<number, number>();
  for (const s of sessions) dowCount.set(s.dow, (dowCount.get(s.dow) ?? 0) + 1);
  const preferred = [...dowCount.entries()]
    .sort((a, b) => b[1] - a[1] || a[0] - b[0])
    .slice(0, 4)
    .map(([d]) => d);

  // 🔴 分母是「实际覆盖周数」而不是名义窗口 weeks —— 只练了 12 周的人不能被 26 除。
  const denom = activeWeeks !== undefined && activeWeeks > 0 ? activeWeeks : 1;

  return {
    total_sessions: sessions.length,
    sessions_per_week: round2(sessions.length / denom),
    active_weeks: denom,
    avg_duration_min: durations.length === 0 ? null : round2(mean(durations)!),
    duration_median_min: median(durations) === null ? null : round2(median(durations)!),
    strength_sessions: strength,
    cardio_sessions: cardio,
    total_effective_sets: effCount,
    preferred_dows: preferred,
  };
}
