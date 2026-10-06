/**
 * 分析报告类型定义 + 最小结构校验（§4.4 JSON Schema 的 TS 转录）。
 *
 * §4.4 是「AI 的唯一合法输入」的权威形态；本文件只转录字段与枚举，
 * 不引入第三方 JSON-Schema 校验器（反对过度设计）——validateReport 做
 * required 字段存在性 + 枚举合法性检查，足够在入库前拦住组装错误。
 */

/**
 * 动作趋势判定（v3）。
 * ⚠️ 没有 `fatigue`：判定疲劳需要 RPE，而 RPE 填充率实测 0%（PRD-v2 §11）——
 *    一个永不触发的分支就是纯噪声，已随报告侧 RPE 一起清掉。
 */
export type MovementVerdict =
  | 'progress'
  | 'plateau'
  | 'regress'
  | 'unstable'
  | 'insufficient_data';

export type MuscleVerdict = 'rising' | 'falling' | 'stable' | 'insufficient' | 'excess';

export interface ReportWindow {
  trend_start: string;
  trend_end: string;
  recent_start: string;
  recent_end: string;
  weeks: number;
  /** 实际被数据覆盖的周数（可选：V3 之前旧报告无此字段）。周均类指标的分母。 */
  active_weeks?: number;
  last_session: {
    datestr: string;
    title: string;
    movements: Array<{
      name: string;
      sets: number;
      best_weight: number | null;
    }>;
  } | null;
}

export interface ExcludedOutlier {
  datestr: string;
  duration_min: number | null;
  reason: 'too_short' | 'too_long' | 'missing_duration';
}

export interface DataQuality {
  duration_coverage: number;
  unmapped_set_ratio: number;
  total_sessions: number;
  synced_days: number;
  server_type_coverage?: number;
  excluded_outliers?: ExcludedOutlier[];
  warmup_source: 'server_set_type' | 'heuristic' | 'mixed';
  warnings: string[];
}

export interface BasicStats {
  total_sessions: number;
  /** 周均训练次数 = total_sessions / active_weeks（**不是** / window.weeks）。 */
  sessions_per_week: number;
  /**
   * 窗口内实际被数据覆盖的周数（分母）。
   * 可选：V3 之前生成的旧报告没有这个字段；新报告由 runAnalysis 填（无训练时 = 1）。
   */
  active_weeks?: number;
  avg_duration_min: number | null;
  /** 时长中位数（分钟）——排期应围绕中位数而不是上限（R-AG-16）。 */
  duration_median_min: number | null;
  strength_sessions: number;
  cardio_sessions: number;
  total_effective_sets: number;
  preferred_dows: number[];
}

export interface MuscleVolumeEntry {
  /** 整个分析窗口的有效组总量（窗口 = ANALYSIS_WINDOW_WEEKS 周）。 */
  sets_total: number;
  /** 近 4 周（seg0）周均有效组。口径：固定最近 12 周分段，与画像窗口无关。 */
  sets_per_week_seg0: number;
  /** 5-8 周（seg1）周均有效组。 */
  sets_per_week_seg1: number;
  /** 9-12 周（seg2）周均有效组。 */
  sets_per_week_seg2: number;
}

export interface MovementTrend {
  catalog_id: number;
  name: string;
  verdict: MovementVerdict;
  weeks_with_data: number;
  first_weight: number | null;
  last_weight: number | null;
  delta_weight_pct: number | null;
  slope_weight_per_week: number | null;
  avg_sets_per_week: number;
  last_performed: string | null;
  volume_load_last: number | null;
}

export interface MuscleTrend {
  muscle_code: string;
  verdict: MuscleVerdict;
  seg0: number;
  seg1: number;
  seg2: number;
  delta_recent_pct: number | null;
}

export interface RepeatedMovement {
  catalog_id: number;
  name: string;
  appear_rate: number;
}

export interface StructureStats {
  push_sets: number;
  pull_sets: number;
  push_pull_ratio: number | null;
  upper_lower_ratio: number | null;
  large_muscle_freq: Record<string, number>;
  top_repeated_movements: RepeatedMovement[];
}

export interface FindingEvidence {
  metric: string;
  value: unknown;
  baseline?: unknown;
  compare?: string;
  window: string;
}

export interface Finding {
  code: string;
  severity: 'info' | 'warn' | 'high';
  title: string;
  detail: string;
  evidence: FindingEvidence;
  suggestion?: string;
}

export interface GoalConstraints {
  goal_type: string;
  sessions_per_week: number;
  min_duration_min: number;
  max_duration_min: number;
  week_start_dow?: number;
  preferred_dows?: number[];
  notes?: string;
}

export interface HardRule {
  kind: 'keep' | 'avoid' | 'dislike' | 'limit_volume' | 'limit_load';
  target_type: 'movement' | 'muscle' | 'pattern' | 'joint';
  target_value: unknown;
  param?: Record<string, unknown>;
  reason?: string;
}

export interface Constraints {
  goal: GoalConstraints | null;
  hard_rules: HardRule[];
  soft_rules: Array<Record<string, unknown>>;
}

export interface CandidatePoolItem {
  catalog_id: number;
  name: string;
  primary_muscles: string[];
  pattern?: string;
  joint_flags?: Array<{ joint: string; level: number }>;
  last_weight: number | null;
  last_sets_reps: string | null;
  history_trend?: MovementVerdict;
  used_recently: boolean;
  mapping_confidence: 'high' | 'medium' | 'low';
}

export interface WritingRules {
  max_trains_per_batch: 4;
  max_movements_per_train: 15;
  max_sets_per_movement: 20;
  same_day_per_batch: true;
  movement_name_must_come_from: 'candidate_pool';
  name_language: 'zh-CN 标准名';
}

export interface AnalysisReport {
  schema_version: '1.0';
  generated_at: string;
  window: ReportWindow;
  data_quality: DataQuality;
  subjective_state: Array<{
    datestr: string;
    state: 'good' | 'normal' | 'tired' | 'sore' | 'bad';
    keywords: string[];
  }>;
  basic_stats: BasicStats;
  muscle_volume: Record<string, MuscleVolumeEntry>;
  movement_trends: MovementTrend[];
  muscle_trends: MuscleTrend[];
  structure: StructureStats;
  findings: Finding[];
  constraints: Constraints;
  candidate_pool: CandidatePoolItem[];
  writing_rules: WritingRules;
}

const MOVEMENT_VERDICTS: MovementVerdict[] = [
  'progress',
  'plateau',
  'regress',
  'unstable',
  'insufficient_data',
];
const MUSCLE_VERDICTS: MuscleVerdict[] = ['rising', 'falling', 'stable', 'insufficient', 'excess'];

/**
 * 最小结构校验：required 顶层字段 + 关键枚举。
 * @returns 问题列表；空数组 = 通过。
 */
export function validateReport(r: AnalysisReport): string[] {
  const problems: string[] = [];
  const reqTop = [
    'schema_version',
    'generated_at',
    'window',
    'data_quality',
    'basic_stats',
    'muscle_volume',
    'movement_trends',
    'muscle_trends',
    'structure',
    'findings',
    'constraints',
    'candidate_pool',
    'writing_rules',
  ] as const;
  for (const k of reqTop) {
    if ((r as unknown as Record<string, unknown>)[k] === undefined) problems.push(`缺少顶层字段 ${k}`);
  }
  if (r.schema_version !== '1.0') problems.push(`schema_version 必须为 "1.0"，得到 ${r.schema_version}`);

  const w = r.window;
  if (w) {
    for (const k of ['trend_start', 'trend_end', 'recent_start', 'recent_end'] as const) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String((w as unknown as Record<string, unknown>)[k] ?? ''))) {
        problems.push(`window.${k} 非法日期`);
      }
    }
  }
  if (r.movement_trends) {
    for (const mt of r.movement_trends) {
      if (!MOVEMENT_VERDICTS.includes(mt.verdict)) {
        problems.push(`movement_trends[${mt.catalog_id}].verdict 非法: ${mt.verdict}`);
      }
    }
  }
  if (r.muscle_trends) {
    for (const mtr of r.muscle_trends) {
      if (!MUSCLE_VERDICTS.includes(mtr.verdict)) {
        problems.push(`muscle_trends[${mtr.muscle_code}].verdict 非法: ${mtr.verdict}`);
      }
    }
  }
  if (r.findings) {
    for (const f of r.findings) {
      if (!['info', 'warn', 'high'].includes(f.severity)) {
        problems.push(`findings[${f.code}].severity 非法: ${f.severity}`);
      }
      if (!f.evidence || typeof f.evidence.metric !== 'string' || !f.evidence.window) {
        problems.push(`findings[${f.code}].evidence 缺 metric/window`);
      }
    }
  }
  return problems;
}
