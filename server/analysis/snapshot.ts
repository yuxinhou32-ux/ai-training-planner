/**
 * 画像快照（周期末的**画像版本**）。
 *
 * 产品语义（2026-10 用户定案）：
 *  - 第一次建立画像 = **版本 0**；之后**每个训练周期末**产出一份新快照，版本号 +1；
 *  - 每份快照**互相独立**，都从原始数据（有界窗口）重算 —— **不是增量链**；
 *  - 用户看到的画像一个周期只变一次（本模块落库的快照就是画像页的数据源）；
 *    排计划的输入则永远是现算的最新数据（`runAnalysis(persist:false)`），不吃快照。
 *
 * 与 `analysis_report.kind` 的对应关系：
 *  - `kind='snapshot'` → 本模块产出，用户可见，保留 3 年；
 *  - `kind='adhoc'`    → 手动刷新/诊断的过程产物，无人看，只留最近 3 份（见 prune.ts）。
 */
import type { Db } from '../db/index.js';
import { prepare } from '../db/index.js';
import { nextSnapshotVersionNo, runAnalysis } from './analysisService.js';
import type { AnalysisReport, Finding } from './reportSchema.js';
import { ANALYSIS_WINDOW_WEEKS } from './window.js';

/** 一份画像快照的元信息（不含庞大的 payload）。 */
export interface SnapshotMeta {
  report_id: number;
  version_no: number;
  generated_at: string;
  window_start: string;
  window_end: string;
  weeks: number;
  active_weeks: number | null;
  finding_count: number;
  high_count: number;
}

interface SnapshotRow {
  id: number;
  version_no: number | null;
  generated_at: string;
  window_start: string;
  window_end: string;
  payload_json: string;
  params_json: string;
  finding_count: number;
  high_count: number;
}

/**
 * 一条 SQL 取快照行 + findings 计数（LEFT JOIN 保证零 finding 的快照也在列表里）。
 * `GROUP BY r.id` 固定每份快照一行。
 */
const SNAPSHOT_SELECT = `
  SELECT r.id AS id, r.version_no AS version_no, r.generated_at AS generated_at,
         r.window_start AS window_start, r.window_end AS window_end,
         r.payload_json AS payload_json, r.params_json AS params_json,
         COUNT(f.id) AS finding_count,
         COALESCE(SUM(CASE WHEN f.severity = 'high' THEN 1 ELSE 0 END), 0) AS high_count
  FROM analysis_report r
  LEFT JOIN analysis_finding f ON f.report_id = r.id
  WHERE r.kind = 'snapshot'`;

/** 快照版本号：第一份 = 0（真正的取号 SQL 在 analysisService，见那里的注释）。 */
export function nextVersionNo(db: Db): number {
  return nextSnapshotVersionNo(db);
}

/** payload 损坏时**不抛错**（老库/手改都可能遇到），拿不到就给 null。 */
function parseActiveWeeks(payloadJson: string): number | null {
  try {
    const r = JSON.parse(payloadJson) as {
      basic_stats?: { active_weeks?: unknown };
      window?: { active_weeks?: unknown };
    };
    const v = r.basic_stats?.active_weeks ?? r.window?.active_weeks;
    return typeof v === 'number' ? v : null;
  } catch {
    return null;
  }
}

/** 窗口周数优先取 payload（报告自己的口径），退 params 快照，再退全局常量。 */
function parseWeeks(payloadJson: string, paramsJson: string): number {
  try {
    const r = JSON.parse(payloadJson) as { window?: { weeks?: unknown } };
    if (typeof r.window?.weeks === 'number') return r.window.weeks;
  } catch {
    // payload 坏了 → 退 params
  }
  try {
    const p = JSON.parse(paramsJson) as { weeks?: unknown };
    if (typeof p.weeks === 'number') return p.weeks;
  } catch {
    // params 也坏了 → 退常量
  }
  return ANALYSIS_WINDOW_WEEKS;
}

function rowToMeta(row: SnapshotRow): SnapshotMeta {
  return {
    report_id: Number(row.id),
    version_no: Number(row.version_no ?? 0),
    generated_at: row.generated_at,
    window_start: row.window_start,
    window_end: row.window_end,
    weeks: parseWeeks(row.payload_json, row.params_json),
    active_weeks: parseActiveWeeks(row.payload_json),
    finding_count: Number(row.finding_count),
    high_count: Number(row.high_count),
  };
}

/**
 * 产出一份画像快照（从原始数据现算 + 落库，kind='snapshot'）。返回落库后的元信息。
 *
 * `nowMs` 目前不改变结果（报告时间戳由 runAnalysis 取真实时钟），保留它是为了让
 * 调用方有统一的时钟入口，便于日后再把时间注入往下打通。
 */
export function createSnapshot(
  db: Db,
  opts: { nowMs?: number; trendEnd?: string; weeks?: number } = {},
): SnapshotMeta {
  const versionNo = nextVersionNo(db);
  const res = runAnalysis(db, {
    persist: true,
    kind: 'snapshot',
    versionNo,
    trendEnd: opts.trendEnd,
    weeks: opts.weeks,
  });
  if (res.reportId === null) throw new Error('画像快照未落库（runAnalysis 未返回 reportId）');
  const snap = snapshotByVersion(db, versionNo);
  if (snap === null) throw new Error(`画像快照落库后未能读回：version_no=${versionNo}`);
  return snap.meta;
}

/** 全部快照，新 → 旧（按版本号倒序；generated_at 可能同毫秒，版本号才是权威序）。 */
export function listSnapshots(db: Db): SnapshotMeta[] {
  const rows = prepare(db, `${SNAPSHOT_SELECT} GROUP BY r.id ORDER BY r.version_no DESC`).all() as unknown as SnapshotRow[];
  return rows.map(rowToMeta);
}

/** 最新快照的完整报告；一份都没有 → null（**adhoc 不算**：画像不能被过程产物污染）。 */
export function latestSnapshot(db: Db): { meta: SnapshotMeta; report: AnalysisReport } | null {
  const row = prepare(db, `${SNAPSHOT_SELECT} GROUP BY r.id ORDER BY r.version_no DESC LIMIT 1`).get() as unknown as
    | SnapshotRow
    | undefined;
  if (!row) return null;
  return { meta: rowToMeta(row), report: JSON.parse(row.payload_json) as AnalysisReport };
}

/** 按 version_no 取快照报告；不存在 → null。 */
export function snapshotByVersion(
  db: Db,
  versionNo: number,
): { meta: SnapshotMeta; report: AnalysisReport } | null {
  const row = prepare(db, `${SNAPSHOT_SELECT} AND r.version_no = ? GROUP BY r.id`).get(versionNo) as unknown as
    | SnapshotRow
    | undefined;
  if (!row) return null;
  return { meta: rowToMeta(row), report: JSON.parse(row.payload_json) as AnalysisReport };
}

// ---------------------------------------------------------------------------
// 版本对比（冻结契约，字段名不得改）
// ---------------------------------------------------------------------------

export interface CompareSide {
  version_no: number;
  generated_at: string;
  window_start: string;
  window_end: string;
  weeks: number;
  active_weeks: number | null;
}

export interface MovementMovement {
  name: string;
  from_weight: number | null;
  to_weight: number | null;
  delta_pct: number | null;
  from_verdict: string | null;
  to_verdict: string | null;
  changed: boolean;
}

export interface MuscleMovement {
  code: string;
  name: string;
  from_weekly_sets: number;
  to_weekly_sets: number;
  delta_pct: number | null;
  from_verdict: string | null;
  to_verdict: string | null;
}

export interface FindingRef {
  code: string;
  severity: string;
  title: string;
}

export interface CompareResult {
  from: CompareSide;
  to: CompareSide;
  movements: MovementMovement[];
  muscles: MuscleMovement[];
  findings: { added: FindingRef[]; removed: FindingRef[] };
  summary: {
    movements_changed: number;
    muscles_changed: number;
    findings_added: number;
    findings_removed: number;
  };
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/** 变化率：基准为 0/null 时无意义 → null。 */
function pct(from: number | null, to: number | null): number | null {
  if (from === null || from === 0 || to === null) return null;
  return round1(((to - from) / from) * 100);
}

function sideOf(meta: SnapshotMeta): CompareSide {
  return {
    version_no: meta.version_no,
    generated_at: meta.generated_at,
    window_start: meta.window_start,
    window_end: meta.window_end,
    weeks: meta.weeks,
    active_weeks: meta.active_weeks,
  };
}

function loadMuscleNames(db: Db): Map<string, string> {
  const rows = prepare(db, `SELECT code, name_zh FROM muscle_group`).all() as unknown as Array<{
    code: string;
    name_zh: string;
  }>;
  return new Map(rows.map((r) => [r.code, r.name_zh]));
}

/**
 * 纯逻辑对比（不碰库，除肌肉中文名外）。拆出来是为了能脱离快照直接用两份报告单测。
 */
function buildComparison(
  from: { meta: SnapshotMeta; report: AnalysisReport },
  to: { meta: SnapshotMeta; report: AnalysisReport },
  muscleNames: Map<string, string>,
): CompareResult {
  // ---- 动作：以 catalog_id 对齐（报告内部用 id），对外只输名字 ----
  const fromTrends = new Map(from.report.movement_trends.map((m) => [m.catalog_id, m]));
  const toTrends = new Map(to.report.movement_trends.map((m) => [m.catalog_id, m]));
  const allIds = new Set<number>([...fromTrends.keys(), ...toTrends.keys()]);

  const movements: MovementMovement[] = [...allIds].map((id) => {
    const a = fromTrends.get(id);
    const b = toTrends.get(id);
    const fromWeight = a?.last_weight ?? null;
    const toWeight = b?.last_weight ?? null;
    const fromVerdict = a?.verdict ?? null;
    const toVerdict = b?.verdict ?? null;
    return {
      name: b?.name ?? a?.name ?? String(id),
      from_weight: fromWeight,
      to_weight: toWeight,
      delta_pct: pct(fromWeight, toWeight),
      from_verdict: fromVerdict,
      to_verdict: toVerdict,
      // 「变了」= 重量变了（含 null↔有值）或判定变了
      changed: fromWeight !== toWeight || fromVerdict !== toVerdict,
    };
  });
  movements.sort((x, y) => {
    if (x.changed !== y.changed) return x.changed ? -1 : 1;
    // 变化率绝对值降序；无变化率（null）排最后
    const ax = x.delta_pct === null ? -1 : Math.abs(x.delta_pct);
    const ay = y.delta_pct === null ? -1 : Math.abs(y.delta_pct);
    return ay - ax;
  });

  // ---- 肌群：**全量列出**（不只变化的），按 to 的周均组数降序 ----
  const codes = new Set<string>([
    ...Object.keys(from.report.muscle_volume),
    ...Object.keys(to.report.muscle_volume),
    ...from.report.muscle_trends.map((m) => m.muscle_code),
    ...to.report.muscle_trends.map((m) => m.muscle_code),
  ]);
  const fromMuscleVerdict = new Map(from.report.muscle_trends.map((m) => [m.muscle_code, m.verdict]));
  const toMuscleVerdict = new Map(to.report.muscle_trends.map((m) => [m.muscle_code, m.verdict]));

  const muscles: MuscleMovement[] = [...codes].map((code) => {
    const fromSets = from.report.muscle_volume[code]?.sets_per_week_seg0 ?? 0;
    const toSets = to.report.muscle_volume[code]?.sets_per_week_seg0 ?? 0;
    return {
      code,
      name: muscleNames.get(code) ?? code,
      from_weekly_sets: fromSets,
      to_weekly_sets: toSets,
      delta_pct: pct(fromSets, toSets),
      from_verdict: fromMuscleVerdict.get(code) ?? null,
      to_verdict: toMuscleVerdict.get(code) ?? null,
    };
  });
  muscles.sort((a, b) => b.to_weekly_sets - a.to_weekly_sets);

  // ---- findings：同一 code 可能多条 → 用 code + '|' + title 作键 ----
  const keyOf = (f: Finding): string => `${f.code}|${f.title}`;
  const fromFindings = new Map(from.report.findings.map((f) => [keyOf(f), f]));
  const toFindings = new Map(to.report.findings.map((f) => [keyOf(f), f]));
  const added: FindingRef[] = [...toFindings.entries()]
    .filter(([k]) => !fromFindings.has(k))
    .map(([, f]) => ({ code: f.code, severity: f.severity, title: f.title }));
  const removed: FindingRef[] = [...fromFindings.entries()]
    .filter(([k]) => !toFindings.has(k))
    .map(([, f]) => ({ code: f.code, severity: f.severity, title: f.title }));

  return {
    from: sideOf(from.meta),
    to: sideOf(to.meta),
    movements,
    muscles,
    findings: { added, removed },
    summary: {
      movements_changed: movements.filter((m) => m.changed).length,
      // 「肌群变了」看周均组数（量的变化），判定变化已在 movements/verdict 侧表达
      muscles_changed: muscles.filter((m) => m.from_weekly_sets !== m.to_weekly_sets).length,
      findings_added: added.length,
      findings_removed: removed.length,
    },
  };
}

/** 两个版本（version_no）的差异；任一版本不存在 → null（路由层翻 404）。 */
export function compareSnapshots(db: Db, fromVersion: number, toVersion: number): CompareResult | null {
  const from = snapshotByVersion(db, fromVersion);
  const to = snapshotByVersion(db, toVersion);
  if (from === null || to === null) return null;
  return buildComparison(from, to, loadMuscleNames(db));
}
