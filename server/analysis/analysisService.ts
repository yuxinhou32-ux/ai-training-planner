/**
 * 分析服务（T2 第二阶段编排层）。
 *
 * 输入：本地 SQLite（第 1 层数据 + 映射）；输出：§4.4 AnalysisReport
 * （AI 的唯一合法输入），落 analysis_report / analysis_finding（第 2 层数据）。
 *
 * 纪律：
 *  - 报告里没有任何训练明细/组序列/备注原文（§4.5 注意）；
 *  - 报告不可变：每次分析生成新行（§4.6）；
 *  - params_json 记录阈值快照，事后可解释「当时为什么这么判」。
 */
import { createHash } from 'node:crypto';
import type { Db } from '../db/index.js';
import { prepare, inTransaction } from '../db/index.js';
import { todayStr } from '../util/dates.js';
import { sessionsFromDows } from '../goal/goalService.js';
import {
  computeWindow,
  loadSessions,
  loadSetRows,
  loadMuscleMaps,
  loadMuscleGroups,
  computeMuscleVolume,
  computeDataQuality,
  computeBasicStats,
  computeDurationStats,
  computeActiveWeeks,
  weeksAgoOf,
  isEffectiveSet,
  round2,
  type WindowInfo,
  type SessionRow,
  type SetRow,
  type MuscleMapRow,
  type MuscleGroupInfo,
} from './metrics.js';
import { computeMovementTrends } from './trendMovement.js';
import { computeMuscleTrends } from './trendMuscle.js';
import { computeStructure } from './trendStructure.js';
import { runRules, sortFindings, type ConstraintRow, type GoalRow, type JointFlagRow } from './rules.js';
import { loadThresholds, type Thresholds } from './thresholds.js';
import { ANALYSIS_WINDOW_WEEKS, ANALYSIS_WINDOW_PRESET } from './window.js';
import { validateReport, type AnalysisReport, type CandidatePoolItem, type Finding, type GoalConstraints, type MovementVerdict } from './reportSchema.js';

export interface RunAnalysisOptions {
  /** 窗口终点（含当天），缺省 = 本地今天。测试可注入固定日期。 */
  trendEnd?: string;
  weeks?: number;
  /** 是否落库（默认 true；dry 统计场景可关）。 */
  persist?: boolean;
  /** 注入阈值（缺省读 config/default.json）。 */
  thresholds?: Thresholds;
  /** 落库类型：'adhoc'（默认，过程产物/诊断） | 'snapshot'（周期末的画像版本，用户可见）。 */
  kind?: 'snapshot' | 'adhoc';
  /** 仅 kind='snapshot' 时使用；不传则自动取「下一个版本号」（第一份 = 0）。 */
  versionNo?: number;
}

export interface RunAnalysisResult {
  report: AnalysisReport;
  reportId: number | null;
  thresholds: Thresholds;
}

interface CatalogRow {
  id: number;
  name: string;
}

function loadCatalogNames(db: Db): Map<number, string> {
  const rows = prepare(db, 'SELECT id, name FROM movement_catalog').all() as unknown as CatalogRow[];
  return new Map(rows.map((r) => [Number(r.id), r.name]));
}

function loadPatterns(db: Db): Map<number, string[]> {
  const rows = prepare(db, 'SELECT catalog_id, pattern FROM movement_pattern_map').all() as unknown as Array<{
    catalog_id: number;
    pattern: string;
  }>;
  const out = new Map<number, string[]>();
  for (const r of rows) {
    const cid = Number(r.catalog_id);
    const list = out.get(cid) ?? [];
    list.push(r.pattern);
    out.set(cid, list);
  }
  return out;
}

function loadJointFlags(db: Db): Map<number, JointFlagRow[]> {
  const rows = prepare(db, 'SELECT catalog_id, joint_code, stress_level FROM movement_joint_flag').all() as unknown as Array<{
    catalog_id: number;
    joint_code: string;
    stress_level: number;
  }>;
  const out = new Map<number, JointFlagRow[]>();
  for (const r of rows) {
    const cid = Number(r.catalog_id);
    const list = out.get(cid) ?? [];
    list.push({ catalogId: cid, joint: r.joint_code, level: Number(r.stress_level) });
    out.set(cid, list);
  }
  return out;
}

export function loadGoal(db: Db): GoalRow | null {
  const rows = prepare(
    db,
    `SELECT goal_type, sessions_per_week, min_duration_min, max_duration_min, week_start_dow, preferred_dows, notes
     FROM user_goal WHERE is_active = 1
     ORDER BY effective_from DESC, id DESC LIMIT 1`,
  ).all() as unknown as Array<{
    goal_type: string;
    sessions_per_week: number;
    min_duration_min: number;
    max_duration_min: number;
    week_start_dow: number;
    preferred_dows: string | null;
    notes: string | null;
  }>;
  const r = rows[0];
  if (!r) return null;
  let dows: number[] = [];
  if (r.preferred_dows) {
    try {
      const parsed = JSON.parse(r.preferred_dows) as unknown;
      if (Array.isArray(parsed)) dows = parsed.map(Number).filter((n) => Number.isInteger(n));
    } catch {
      dows = [];
    }
  }
  return {
    goalType: r.goal_type,
    // 🔴 一周几练必须由「选中的训练日」推导（与设置页读的是同一条规则，见 sessionsFromDows）。
    // 直接读存储值会把历史行的自相矛盾（4 练 + 只选一/三/五）喂给 AI 与模板，
    // 实测后果：模板把第 4 天排到没选的周六；AI 路径第 4 天日期落回周起始日，
    // 与第 1 天撞 plan_day 唯一约束 → 生成计划 500。
    sessionsPerWeek: sessionsFromDows(dows, Number(r.sessions_per_week)),
    minDurationMin: Number(r.min_duration_min),
    maxDurationMin: Number(r.max_duration_min),
    weekStartDow: Number(r.week_start_dow),
    preferredDows: dows,
    notes: r.notes,
  };
}

/**
 * GoalRow → 报告 GoalConstraints 形状。
 * 分析与计划服务共用，避免两处映射各自漂移（改了字段只改这一处）。
 */
export function goalToConstraints(g: GoalRow): GoalConstraints {
  return {
    goal_type: g.goalType,
    sessions_per_week: g.sessionsPerWeek,
    min_duration_min: g.minDurationMin,
    max_duration_min: g.maxDurationMin,
    week_start_dow: g.weekStartDow,
    preferred_dows: g.preferredDows,
    notes: g.notes ?? undefined,
  };
}

function loadConstraintRules(db: Db): ConstraintRow[] {
  const rows = prepare(
    db,
    `SELECT id, kind, target_type, target_value, severity, param_json, reason
     FROM constraint_rule WHERE is_active = 1 ORDER BY id`,
  ).all() as unknown as Array<{
    id: number;
    kind: string;
    target_type: string;
    target_value: string;
    severity: string;
    param_json: string | null;
    reason: string | null;
  }>;
  return rows.map((r) => ({
    id: Number(r.id),
    kind: r.kind as ConstraintRow['kind'],
    targetType: r.target_type as ConstraintRow['targetType'],
    targetValue: r.target_value,
    severity: r.severity as ConstraintRow['severity'],
    param: r.param_json ? (JSON.parse(r.param_json) as Record<string, unknown>) : null,
    reason: r.reason,
  }));
}

function sha256(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

/** candidate_pool（§4.4）：AI 选动作的唯一合法来源。 */
function buildCandidatePool(
  db: Db,
  setRows: SetRow[],
  maps: Map<number, MuscleMapRow[]>,
  patterns: Map<number, string[]>,
  jointFlags: Map<number, JointFlagRow[]>,
  catalogNames: Map<number, string>,
  trendById: Map<number, MovementVerdict>,
  trendEnd: string,
): CandidatePoolItem[] {
  const rows = prepare(db, 'SELECT id, name FROM movement_catalog ORDER BY id').all() as unknown as CatalogRow[];
  const eff = setRows.filter(isEffectiveSet);
  const out: CandidatePoolItem[] = [];
  for (const c of rows) {
    const cid = Number(c.id);
    const rowsCid = eff.filter((r) => r.catalogId === cid);
    const primary = (maps.get(cid) ?? []).filter((m) => m.role === 'primary');
    const pats = (patterns.get(cid) ?? []).filter((x) => x !== 'other');
    const recent = rowsCid.filter((r) => weeksAgoOf(trendEnd, r.datestr) < 4);

    let lastWeight: number | null = null;
    for (const r of rowsCid) {
      if (r.weightKg !== null && (lastWeight === null || r.weightKg > lastWeight)) lastWeight = r.weightKg;
    }

    let lastSetsReps: string | null = null;
    if (rowsCid.length > 0) {
      const lastDate = rowsCid.reduce((m, r) => (r.datestr > m ? r.datestr : m), rowsCid[0].datestr);
      const lastRows = rowsCid.filter((r) => r.datestr === lastDate);
      const repsVals = lastRows.map((r) => r.reps).filter((v): v is number => v !== null);
      if (repsVals.length > 0) lastSetsReps = `${lastRows.length}x${Math.max(...repsVals)}`;
    }

    const conf = primary[0]?.confidence;
    out.push({
      catalog_id: cid,
      name: c.name,
      primary_muscles: primary.map((m) => m.muscleCode),
      pattern: pats[0],
      joint_flags: (jointFlags.get(cid) ?? []).map((f) => ({ joint: f.joint, level: f.level })),
      last_weight: lastWeight,
      last_sets_reps: lastSetsReps,
      history_trend: trendById.get(cid),
      used_recently: recent.length > 0,
      mapping_confidence: conf === 'high' || conf === 'medium' || conf === 'low' ? conf : 'low',
    });
  }
  return out;
}

/** window.last_session（§4.4）：最近一次训练的概览。 */
function buildLastSession(
  sessions: SessionRow[],
  setRows: SetRow[],
  catalogNames: Map<number, string>,
): AnalysisReport['window']['last_session'] {
  if (sessions.length === 0) return null;
  const last = sessions[sessions.length - 1];
  const rows = setRows.filter((r) => r.sessionId === last.id);
  const bySm = new Map<number, SetRow[]>();
  for (const r of rows) {
    const list = bySm.get(r.smId) ?? [];
    list.push(r);
    bySm.set(r.smId, list);
  }
  const movements = [...bySm.values()].map((rs) => {
    const effRs = rs.filter(isEffectiveSet);
    const weights = effRs.map((r) => r.weightKg).filter((v): v is number => v !== null);
    return {
      // last_session 是「当天实际做了什么」的概览，优先原始记录名（如 暂停卧推），
      // 避免与目录名（杠铃卧推）重名造成两行同名的歧义；未识别时回退目录名
      name: rs[0].nameRaw || catalogNames.get(rs[0].catalogId ?? -1) || rs[0].nameRaw,
      sets: effRs.length,
      best_weight: weights.length === 0 ? null : round2(Math.max(...weights)),
    };
  });
  // 未识别动作的 nameRaw 与目录名兜底均取不到时保持原样 —— movements 不暴露内部 id
  return {
    datestr: last.datestr,
    title: last.title ?? '',
    movements,
  };
}

/**
 * 下一个画像快照版本号：**第一份 = 0**。只数 kind='snapshot' 的行，
 * adhoc 过程产物不占号（否则每次手动刷新都会把版本号推高，用户看到的画像版本就失去意义）。
 *
 * 实现在这里而不是 snapshot.ts：runAnalysis 自身要支持「不传 versionNo 时自动取号」，
 * 若让它反向 import snapshot.ts 会成环（snapshot → analysisService）。
 * 语义上的唯一入口仍是 snapshot.ts 的 `nextVersionNo`（它转调本函数）。
 */
export function nextSnapshotVersionNo(db: Db): number {
  const row = prepare(
    db,
    `SELECT COALESCE(MAX(version_no), -1) + 1 AS v FROM analysis_report WHERE kind = 'snapshot'`,
  ).get() as unknown as { v: number };
  return Number(row.v);
}

export function runAnalysis(db: Db, opts: RunAnalysisOptions = {}): RunAnalysisResult {
  const weeks = opts.weeks ?? ANALYSIS_WINDOW_WEEKS;
  const trendEnd = opts.trendEnd ?? todayStr();
  const w: WindowInfo = computeWindow(trendEnd, weeks);
  const { thresholds: th, warning } = opts.thresholds
    ? { thresholds: opts.thresholds, warning: null as string | null }
    : loadThresholds();

  const sessions = loadSessions(db, w);
  const setRows = loadSetRows(db, w);
  // 实际覆盖周数（周均类指标的分母）—— 只练了 12 周的人不能被 26 周除成「欠练一半」
  const activeWeeks = computeActiveWeeks(w.trendEnd, weeks, sessions);
  w.activeWeeks = activeWeeks;
  const maps = loadMuscleMaps(db);
  const muscleGroups = loadMuscleGroups(db);
  const patterns = loadPatterns(db);
  const jointFlags = loadJointFlags(db);
  const catalogNames = loadCatalogNames(db);

  const syncedDaysRow = prepare(
    db,
    'SELECT COUNT(DISTINCT datestr) AS c FROM train_session WHERE datestr BETWEEN ? AND ?',
  ).get(w.trendStart, w.trendEnd) as unknown as { c: number };
  const syncedDays = Number(syncedDaysRow.c);

  const { volume } = computeMuscleVolume(setRows, maps);
  const quality = computeDataQuality({ sessions, setRows, syncedDays });
  if (warning) quality.warnings.push(warning);

  const basic = computeBasicStats(sessions, setRows, weeks, activeWeeks);
  const movementTrends = computeMovementTrends({
    setRows,
    sessions,
    maps,
    catalogNames,
    trendEnd,
    weeks,
    activeWeeks,
    th: th.movement_trend,
  });
  const muscleTrends = computeMuscleTrends({
    volume,
    muscleGroups,
    movementTrends,
    maps,
    th: th.muscle_trend,
  });
  const structure = computeStructure({
    setRows,
    maps,
    patterns,
    muscleGroups,
    weeks,
    catalogNames,
    repeatRateHigh: th.structure_trend.movement_repeat_rate_high,
  });

  const goal = loadGoal(db);
  const constraintRules = loadConstraintRules(db);

  const durations = computeDurationStats(sessions);

  const ruleFindings: Finding[] = runRules({
    muscleGroups,
    muscleTrends,
    movementTrends,
    structure,
    quality,
    durationsAllWindow: durations.allWindow,
    trendEnd,
    weeks,
    th: th.structure_trend,
  });

  const trendById = new Map<number, MovementVerdict>(movementTrends.map((m) => [m.catalog_id, m.verdict]));
  const candidatePool = buildCandidatePool(db, setRows, maps, patterns, jointFlags, catalogNames, trendById, trendEnd);

  const hardRules = constraintRules
    .filter((c) => c.severity === 'hard')
    .map((c) => ({
      kind: c.kind,
      target_type: c.targetType,
      target_value: c.targetValue,
      ...(c.param ? { param: c.param } : {}),
      ...(c.reason ? { reason: c.reason } : {}),
    }));
  const softRules = constraintRules
    .filter((c) => c.severity === 'soft')
    .map((c) => ({ kind: c.kind, target_type: c.targetType, target_value: c.targetValue, ...(c.param ? { param: c.param } : {}) }));

  const report: AnalysisReport = {
    schema_version: '1.0',
    generated_at: new Date().toISOString(),
    window: {
      trend_start: w.trendStart,
      trend_end: w.trendEnd,
      recent_start: w.recentStart,
      recent_end: w.recentEnd,
      weeks,
      active_weeks: activeWeeks,
      last_session: buildLastSession(sessions, setRows, catalogNames),
    },
    data_quality: quality,
    subjective_state: [], // P1（S7 备注抽取，T3 接入）；MVP 恒为空数组
    basic_stats: basic,
    muscle_volume: volume,
    movement_trends: movementTrends,
    muscle_trends: muscleTrends,
    structure,
    findings: sortFindings(ruleFindings),
    constraints: {
      goal: goal ? goalToConstraints(goal) : null,
      hard_rules: hardRules,
      soft_rules: softRules,
    },
    candidate_pool: candidatePool,
    writing_rules: {
      max_trains_per_batch: 4,
      max_movements_per_train: 15,
      max_sets_per_movement: 20,
      same_day_per_batch: true,
      movement_name_must_come_from: 'candidate_pool',
      name_language: 'zh-CN 标准名',
    },
  };

  const problems = validateReport(report);
  if (problems.length > 0) {
    throw new Error(`分析报告未通过 §4.4 结构校验：${problems.join('；')}`);
  }

  if (opts.persist === false) {
    return { report, reportId: null, thresholds: th };
  }

  // 落库类型与版本号：adhoc 是过程产物（version_no 恒 NULL），snapshot 是用户可见的画像版本。
  const kind: 'snapshot' | 'adhoc' = opts.kind ?? 'adhoc';
  const versionNo = kind === 'snapshot' ? (opts.versionNo ?? nextSnapshotVersionNo(db)) : null;

  const payloadJson = JSON.stringify(report);
  const paramsJson = JSON.stringify({
    thresholds: th,
    weeks,
    calib: 'v2',
    // 记进 params_json 是为了事后能解释「这份报告当时是当画像版本还是过程产物」——
    // kind/version_no 单独成列供查询，但仍然留一份在快照参数里，避免两处口径对不上。
    kind,
    version_no: versionNo,
  });
  const reportId = inTransaction(db, () => {
    const res = prepare(
      db,
      `INSERT INTO analysis_report
       (window_start, window_end, window_preset, params_json, payload_json, payload_hash, schema_version, generated_at, kind, version_no)
       VALUES (?, ?, ?, ?, ?, ?, '1.0', ?, ?, ?)`,
    ).run(
      w.trendStart,
      w.trendEnd,
      ANALYSIS_WINDOW_PRESET,
      paramsJson,
      payloadJson,
      sha256(payloadJson),
      report.generated_at,
      kind,
      versionNo,
    );
    const rid = Number(res.lastInsertRowid);
    const insFinding = prepare(
      db,
      `INSERT INTO analysis_finding
       (report_id, code, severity, title, detail, evidence_json, suggestion, sort_no, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    report.findings.forEach((f, i) => {
      insFinding.run(
        rid,
        f.code,
        f.severity,
        f.title,
        f.detail,
        JSON.stringify(f.evidence),
        f.suggestion ?? null,
        i + 1,
        report.generated_at,
      );
    });
    return rid;
  });

  return { report, reportId, thresholds: th };
}
