/**
 * 问题发现规则库（v3 精简版）。
 *
 * 只保留会真实触发、且对「排下周计划」有直接指导意义的规则：
 *   R-AG-03 肌群长期不足 / R-AG-04 肌群过量无进步
 *   R-AG-05 动作长期停滞
 *   R-AG-07 推拉失衡 / R-AG-08 上下肢失衡 / R-AG-16 时长离散度过大
 *
 * v3 又删两条（PRD-v2 §11 决策 A：AI 完全不看 RPE）：
 *   R-AG-06 动作疲劳累积——判定依赖 RPE，覆盖率 0% 时永不触发
 *   R-AG-15 RPE 缺失提示——每次必命中的噪声，等于永远在刷「你该记 RPE」
 *
 * 更早删除（v1 的过度建设，从未真实触发或依赖已砍机制）：
 *   R-AG-01/02 单肌群细分失衡、R-AG-09 动作重复率、R-AG-10 大肌群频率、
 *   R-AG-11/12 目标频率/时长偏差、R-AG-13 关节硬约束、
 *   R-AG-14 未识别动作告警、R-AG-17 决策卡。
 *
 * 每条规则产出结构化 Finding（evidence 可量化、可追溯），不做决策卡——
 * 结论只作陈述，取舍交给用户与 AI 教练。
 */
import type { DataQuality, Finding, MuscleTrend, MovementTrend, StructureStats } from './reportSchema.js';
import { round2, median, stdev, type MuscleGroupInfo } from './metrics.js';
import type { StructureTrendThresholds } from './thresholds.js';

export interface GoalRow {
  goalType: string;
  sessionsPerWeek: number;
  minDurationMin: number;
  maxDurationMin: number;
  weekStartDow: number;
  preferredDows: number[];
  notes: string | null;
}

export interface ConstraintRow {
  id: number;
  kind: 'keep' | 'avoid' | 'dislike' | 'limit_volume' | 'limit_load';
  targetType: 'movement' | 'muscle' | 'pattern' | 'joint';
  targetValue: string;
  severity: 'hard' | 'soft';
  param: Record<string, unknown> | null;
  reason: string | null;
}

export interface JointFlagRow {
  catalogId: number;
  joint: string;
  level: number;
}

/** R-AG-16 时长离散度样本下限（样本过少时比率不稳定，不判定）。 */
export const RAG16_MIN_SAMPLES = 5;

export interface RulesContext {
  muscleGroups: Map<string, MuscleGroupInfo>;
  muscleTrends: MuscleTrend[];
  movementTrends: MovementTrend[];
  structure: StructureStats;
  quality: DataQuality;
  /** 整个分析窗口的可用时长（R-AG-16 用），窗口周数见 weeks。 */
  durationsAllWindow: number[];
  trendEnd: string;
  /** 分析窗口周数（用于把「近 N 周」文案渲染成真实口径，而不是写死 12）。 */
  weeks: number;
  th: StructureTrendThresholds;
}

export function runRules(ctx: RulesContext): Finding[] {
  const findings: Finding[] = [];
  const push = (f: Finding) => findings.push(f);

  // ---- R-AG-03 肌群长期不足（high）----
  for (const mt of ctx.muscleTrends) {
    if (mt.verdict !== 'insufficient') continue;
    const g = ctx.muscleGroups.get(mt.muscle_code);
    push({
      code: 'R-AG-03',
      severity: 'high',
      title: `${g?.nameZh ?? mt.muscle_code}长期训练不足`,
      detail: `周均有效组：近4周 ${mt.seg0}，前4周 ${mt.seg1}，连续两段低于阈值`,
      evidence: { metric: 'sets_per_week', value: mt.seg0, baseline: mt.seg1, window: '近8周' },
      suggestion: '在该肌群所在训练日 +2~4 组',
    });
  }

  // ---- R-AG-04 肌群过量无进步（warn）----
  for (const mt of ctx.muscleTrends) {
    if (mt.verdict !== 'excess') continue;
    const g = ctx.muscleGroups.get(mt.muscle_code);
    push({
      code: 'R-AG-04',
      severity: 'warn',
      title: `${g?.nameZh ?? mt.muscle_code}训练量偏高且无进步`,
      detail: `近4周周均 ${mt.seg0} 组（超阈值），且关联主项趋势为 plateau/regress`,
      evidence: { metric: 'sets_per_week', value: mt.seg0, window: '近4周' },
      suggestion: '该肌群 -20% 组数，观察 2 周',
    });
  }

  // ---- R-AG-05 动作长期停滞（warn）----
  for (const mt of ctx.movementTrends) {
    if (mt.verdict === 'plateau' && mt.weeks_with_data >= 6) {
      push({
        code: 'R-AG-05',
        severity: 'warn',
        title: `${mt.name}已停滞 ${mt.weeks_with_data} 周`,
        detail: `重量变化 ${mt.delta_weight_pct ?? '—'}%（近2周 vs 最早2周）`,
        evidence: { metric: 'delta_weight_pct', value: mt.delta_weight_pct, window: `近${mt.weeks_with_data}周` },
        suggestion: '换变体（如杠铃卧推→哑铃卧推）或改次数区间',
      });
    }
  }

  // ---- R-AG-07 推拉失衡（warn）----
  {
    const r = ctx.structure.push_pull_ratio;
    if (r !== null && (r > ctx.th.push_pull_target[1] || r < ctx.th.push_pull_target[0])) {
      push({
        code: 'R-AG-07',
        severity: 'warn',
        title: `推拉比 ${r} 超出目标区间 ${ctx.th.push_pull_target.join('~')}`,
        detail: `推 ${ctx.structure.push_sets} 组 / 拉 ${ctx.structure.pull_sets} 组（近${ctx.weeks}周有效组）`,
        evidence: { metric: 'push_pull_ratio', value: r, baseline: ctx.th.push_pull_target, window: `近${ctx.weeks}周` },
        suggestion: '调整分化，使比值回到 0.8~1.25',
      });
    }
  }

  // ---- R-AG-08 上下肢失衡（warn）----
  {
    const r = ctx.structure.upper_lower_ratio;
    if (r !== null && (r > ctx.th.upper_lower_target[1] || r < ctx.th.upper_lower_target[0])) {
      push({
        code: 'R-AG-08',
        severity: 'warn',
        title: `上下肢比 ${r} 超出目标区间 ${ctx.th.upper_lower_target.join('~')}`,
        detail: `上肢/下肢有效组比失衡（近${ctx.weeks}周）`,
        evidence: { metric: 'upper_lower_ratio', value: r, baseline: ctx.th.upper_lower_target, window: `近${ctx.weeks}周` },
        suggestion: '增加下肢/上肢训练日',
      });
    }
  }

  // ---- R-AG-16 训练时长离散度过大（info）----
  {
    const xs = ctx.durationsAllWindow;
    const sd = stdev(xs);
    const med = median(xs);
    if (sd !== null && med !== null && med > 0 && xs.length >= RAG16_MIN_SAMPLES && sd / med >= 0.35) {
      push({
        code: 'R-AG-16',
        severity: 'info',
        title: `训练时长离散度过大（σ/中位数 = ${round2(sd / med)} ≥ 0.35）`,
        detail: `近${ctx.weeks}周时长标准差 ${round2(sd)} 分钟，中位数 ${round2(med)} 分钟（n=${xs.length}）`,
        evidence: { metric: 'duration_cv', value: round2(sd / med), baseline: 0.35, window: `近${ctx.weeks}周` },
        suggestion: '与用户确认是否时间预算不稳定；计划生成时按中位数而非上限排期',
      });
    }
  }

  return sortFindings(findings);
}

/** 排序：high > warn > info，同级别按 code。 */
export function sortFindings(fs: Finding[]): Finding[] {
  const sevRank = { high: 1, warn: 2, info: 3 } as const;
  return [...fs].sort((a, b) => {
    const sa = sevRank[a.severity] - sevRank[b.severity];
    if (sa !== 0) return sa;
    return a.code.localeCompare(b.code);
  });
}
