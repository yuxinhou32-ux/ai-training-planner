/**
 * 「用户画像」视图（PRD-v2 §10.3 V9 / §3）。
 *
 * 这是什么：**系统实际喂给 AI 的那份长期画像**，原样展示给用户看。
 *
 * 刻意的取舍（重要）：
 *  - §3 旧描述是「由 AI 通读全部历史后产出的说明书」。v2 改成了**本地摘要层**
 *    （AI 只做裁决，不做统计），所以这份画像**不是 AI 生成的文本**，而是
 *    `buildPlanDigest` 算出来的 `profile` 那一段——加上报告里的动作趋势明细。
 *  - 只读不写、不缓存、不落库：每次打开现算（纯本地统计，毫秒级）。
 *  - 与「排计划」走同一条 `buildPlanDigest`，所以页面上看到的和 AI 看到的是**同一份**，
 *    不存在「页面说 A、AI 用的是 B」。
 *
 * 展示目的不是好看，而是**可核对**：用户点进来就能看到「AI 眼里我是什么样」，
 * 觉得不对就去改训练基础 / 补体重 / 写感受，而不是怀疑 AI 在瞎排。
 */
import type { Db } from '../db/index.js';
import type { AnalysisReport, MovementVerdict } from '../analysis/reportSchema.js';
import { buildPlanDigest, type DigestMuscle, type PlanInputDigest } from '../ai/digest.js';
import { getBodyInfo } from '../body/bodyService.js';
import { currentWeekStart } from '../cycle/cycleService.js';
import { loadGoal } from '../analysis/analysisService.js';
import { latestSnapshot } from '../analysis/snapshot.js';
import { activeWeekStartDow, cycleContextFor, todayLocal, withLiveGoal } from '../plan/planService.js';

/** 画像里最多列多少个动作趋势（报告里通常 40~50 条，全列出来没人看）。 */
const MAX_PROFILE_MOVEMENTS = 24;

export interface ProfileMovement {
  name: string;
  last_weight: number | null;
  verdict: MovementVerdict;
  delta_pct: number | null;
  weeks: number;
  last_performed: string | null;
}

export interface ProfileView {
  /** 这份画像的生成时间（每次打开现算）。 */
  generated_at: string;
  /** 画像所依赖的分析报告 id —— 用户要知道它是不是旧的。 */
  report_id: number;
  /** 画像对应的计划周起点（动作趋势的窗口与它对齐）。 */
  week_start: string;
  window: PlanInputDigest['profile']['window'];
  habit: PlanInputDigest['profile']['habit'];
  muscles: DigestMuscle[];
  structure: { push_pull_ratio: number | null; upper_lower_ratio: number | null };
  /** 个人基础信息（V9 手动填的那部分）。`conditions` 空串 = 没填（设置页输入框要好编辑）。 */
  body: {
    weight_kg: number | null;
    weight_date: string | null;
    delta_30d_kg: number | null;
    conditions: string;
    gender: string | null;
    age: number | null;
    height_cm: number | null;
    training_years: string | null;
  };
  /** 动作趋势明细（报告里的 `movement_trends`，按最近训练倒序取前 N 条）。 */
  movements: ProfileMovement[];
  cycle: { week_no: number; total_weeks: number; goal_text: string; is_deload: boolean } | null;
  goal: {
    goal_type: string;
    sessions_per_week: number;
    preferred_dows: number[];
    min_duration_min: number;
    max_duration_min: number;
  } | null;
}

/**
 * 当前状态下的画像；**还没有分析报告时返回 null**（画像的全部数字都来自报告）。
 * 调用方负责把 null 渲染成「先去数据分析页生成报告」。
 */
export function buildProfileView(db: Db, nowMs: number = Date.now()): ProfileView | null {
  // 画像页展示的必须是**冻结的快照版本**（kind='snapshot'），不能是 adhoc 过程产物 ——
  // 否则「一个周期只变一次」的画像会被手动刷新悄悄改掉。
  const snap = latestSnapshot(db);
  if (!snap) return null;

  const weekStart = currentWeekStart(todayLocal(), activeWeekStartDow(db));
  const constraints = withLiveGoal(db, snap.report.constraints);
  const cycle = cycleContextFor(db, weekStart);
  // 🔴 与 createPlanFromAi 走同一个装配路径：页面上看到的画像必须就是 AI 会拿到的那一份
  const digest = buildPlanDigest(db, {
    report: snap.report,
    constraints: { goal: constraints.goal, hard_rules: constraints.hard_rules },
    weekStart,
    cycle,
    nowMs,
  });

  const bodyInfo = getBodyInfo(db, nowMs);
  const live = loadGoal(db);

  return {
    generated_at: digest.generated_at,
    report_id: snap.meta.report_id,
    week_start: weekStart,
    window: digest.profile.window,
    habit: digest.profile.habit,
    muscles: digest.profile.muscles,
    structure: digest.profile.structure,
    body: {
      ...digest.profile.body,
      // 摘要层把没填统一成 null（给 AI 的信号是「没有这回事」），
      // 但设置页的输入框需要拿到空串才好编辑。
      conditions: bodyInfo.conditions,
    },
    movements: pickMovements(snap.report),
    cycle: cycle
      ? { week_no: cycle.weekNo, total_weeks: cycle.totalWeeks, goal_text: cycle.goalText, is_deload: cycle.isDeload }
      : null,
    goal: live
      ? {
          goal_type: live.goalType,
          sessions_per_week: live.sessionsPerWeek,
          preferred_dows: live.preferredDows,
          min_duration_min: live.minDurationMin,
          max_duration_min: live.maxDurationMin,
        }
      : null,
  };
}

/** 动作趋势：按「最近训练日期」倒序，取前 N 条。没日期的排最后（12 周没练的）。 */
function pickMovements(report: AnalysisReport): ProfileMovement[] {
  const rows = report.movement_trends ?? [];
  return [...rows]
    .sort((a, b) => (b.last_performed ?? '').localeCompare(a.last_performed ?? '') || a.name.localeCompare(b.name))
    .slice(0, MAX_PROFILE_MOVEMENTS)
    .map((m) => ({
      name: m.name,
      last_weight: m.last_weight,
      verdict: m.verdict,
      delta_pct: m.delta_weight_pct,
      weeks: m.weeks_with_data,
      last_performed: m.last_performed,
    }));
}
