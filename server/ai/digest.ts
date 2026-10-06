/**
 * 计划输入摘要层（PRD-v2 V3）——「训练画像 + 本周切片」。
 *
 * 为什么需要它：旧版把整份 AnalysisReport 直接喂给 AI（实测 66.5 KB ≈ 19,500 tokens），
 * 其中 `candidate_pool`（254 个动作全量目录）47.7 KB + `movement_trends`（45 条）11.5 KB，
 * **两项合计 89%** —— 而一次真正要排的计划只会用到 15 个左右的动作。
 *
 * 本模块的输出是 AI 的唯一合法输入（`AiGateway.generatePlan({ digest })`）：
 *   ① profile  长期画像：训练习惯 / 各部位基线 / 长期结构问题（本地统计，不是 AI 生成）
 *   ② week     本周切片：周期第几周、减量周、上周实际、待补 / 过量 / 该练没练到
 *   ③ candidate_pool  精选 ≤30 条（在练的 + 覆盖目标肌群），每条自带趋势判定
 *   ④ findings 只保留 6 条真正会触发的规则结论
 *
 * 纪律：
 *  - **不在本地做判断以外的事**：所有数字都来自 analysis 层既有统计，这里只做筛选与压缩，
 *    不重算口径（有效组判据仍然全局只有 metrics.isEffectiveSet 一处）。
 *  - **不喂原始数据**：没有组序列、没有备注原文、没有 session/movement 句柄。
 *  - 报告快照可能是旧版本（V3 之前生成的），所有新增字段都按「可能不存在」处理。
 */
import { prepare, type Db } from '../db/index.js';
import { shiftDays } from '../util/dates.js';
import { ANALYSIS_WINDOW_WEEKS } from '../analysis/window.js';
import {
  computeMuscleVolume,
  isEffectiveSet,
  loadMuscleGroups,
  loadMuscleMaps,
  loadSessions,
  loadSetRows,
  type MuscleGroupInfo,
  type WindowInfo,
} from '../analysis/metrics.js';
import type {
  AnalysisReport,
  CandidatePoolItem,
  GoalConstraints,
  HardRule,
  MovementVerdict,
  MuscleVerdict,
  WritingRules,
} from '../analysis/reportSchema.js';
import type { PlanCycleContext, PlanTemplate, WeeklyReview } from './schemas.js';
import { filterCandidatePool } from './poolFilter.js';
import { muscleDayDemand } from '../plan/splits.js';
import { computeProgression, type ProgressionAdvice } from '../plan/progression.js';
import type { RawTemplate } from '../plan/cycleTemplate.js';
import { datestrForDow, dowOfDateStr } from '../util/dates.js';
import { loadPlanActual } from '../plan/actual.js';
import { loadWeekNote, weekNoteForDigest } from '../week/weekNoteService.js';
import { loadBodyForDigest } from '../body/bodyService.js';

/** 3.0 → 3.1（V5+V6）：候选池每条新增 `progression`（本周建议重量），week 新增 `last_plan_actual`。 */
/** 3.1 → 3.2（V9）：profile 新增 `body`（体重 + 旧伤/基础疾病，只作背景参考）。 */
/**
 * 3.2 → 3.3（2026-09-30）：`week.last_review` 换源 ——
 * 由「最近一次 4 周周期总结」改为「**计划周前一周**的周总结」，字段
 * `period_start/period_end/suggestions` → `week_start/week_end/verdict/adjustments`。
 */
/**
 * 3.3 → 3.4（2026-09-30）：`profile.body` 扩为「个人基础信息」——
 * 在 `weight_kg / delta_30d_kg / conditions` 之外新增
 * `gender / age / height_cm / training_years`（全部可空、全部只作背景参考）。
 */
export const PLAN_INPUT_SCHEMA_VERSION = '3.4';
/** 候选池上限：一次计划约用 15 个动作，给 30 个是留出「换变体」的余地（PRD §10.3 V3）。 */
export const MAX_DIGEST_POOL = 30;
/** 轮转挑动作的轮数：每轮每个待补肌群补 1 个动作，保证池子不被某个肌群吃光。 */
const POOL_ROUNDS = 3;

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

/** 画像里的一条肌群基线。`verdict=null` = 窗口内一组都没有（该练没练到）。 */
export interface DigestMuscle {
  code: string;
  name: string;
  /** 近 4 周周均有效组（primary ×1 / secondary ×0.5）。 */
  weekly_sets: number;
  verdict: MuscleVerdict | null;
}

/**
 * 个人基础信息（V9，2026-09-30 扩展）—— 用户手动填的那些字段。
 *
 * 🔴 `conditions`（旧伤 / 基础疾病）**只是背景文本**：
 *    这里没有、也不允许有「据它禁用动作 / 降容量 / 过滤候选池」的任何字段。
 *    PRD-v2 §5 原话：「旧伤：只作参考，不自动禁用相关动作」。
 *    一条「腰突（已痊愈）」不该让系统从此不排硬拉 —— 陈旧伤已好，
 *    而急性发作期本来就谈不上训练。真正要响应的临时状况写在**计划周特殊情况**里
 *    （`week.special_note`，用户事前在首页填，优先级最高）。
 *
 * 🔴 **全部可空**：任何一个字段为 `null` 都表示「用户没告诉我这件事」，
 *    prompt 里明确要求「不许提起、不许追问、不许假设」——
 *    留空不是「数据缺失待补」，不该让 AI 显出一副要补全资料的样子。
 */
export interface DigestBody {
  /** 最新一次体重（kg）。 */
  weight_kg: number | null;
  weight_date: string | null;
  /** 相对 30 天前最近一次的变化（kg），正 = 涨。不足两条记录 → null。 */
  delta_30d_kg: number | null;
  /** 旧伤 / 基础疾病原话；null = 用户没填。 */
  conditions: string | null;
  /** 性别（`女` / `男`）；null = 没填。 */
  gender: string | null;
  /** 年龄；null = 没填。 */
  age: number | null;
  /** 身高（cm）；null = 没填。 */
  height_cm: number | null;
  /** 训练年限（`不到 1 年` / `1~3 年` / `3 年以上`）；null = 没填。 */
  training_years: string | null;
}

/** 候选池条目：在 v2 的池字段上直接并入趋势判定，避免「池 + 趋势数组」两处按 id 手工对齐。 */
export interface DigestPoolItem {
  catalog_id: number;
  name: string;
  primary_muscles: string[];
  /**
   * 关节压力标记（只有少量动作有）。保留它有两个用处：
   * ① `filterCandidatePool` 的 limit_load 过滤在模板路径上仍可复用；
   * ② 校验器 V4 的关节检查仍然有据可查（不靠「池已经过滤过」这一句口头保证）。
   */
  joint_flags?: Array<{ joint: string; level: number }>;
  last_weight: number | null;
  last_sets_reps: string | null;
  /** 12 周窗口内的趋势判定（数据不足 3 周 → insufficient_data）。 */
  trend: MovementVerdict;
  /** 近 2 周 vs 最早 2 周的最大重量变化（%），正 = 涨。 */
  delta_pct: number | null;
  /** 有数据的周数。 */
  weeks: number;
  last_performed: string | null;
  used_recently: boolean;
  mapping_confidence: 'high' | 'medium' | 'low';
  /**
   * 本周建议重量（V5）：**本地算好的渐进超负荷结论**，AI 只做裁决与例外。
   *
   * 为什么不把计算交给 AI：递增是确定性规则，而 AI 看不到「上周计划 vs 实际」，
   * 也没法保证每周稳定地加。这 3 个字段（`suggest_kg` / `delta_kg` / `action`）
   * 合起来约 75 字节 × 30 条 ≈ 2.2 KB，是 payload 里最值钱的那部分。
   */
  progression: ProgressionAdvice;
}

export interface DigestConstraints {
  goal: GoalConstraints | null;
  hard_rules: HardRule[];
}

export interface PlanInputDigest {
  schema_version: typeof PLAN_INPUT_SCHEMA_VERSION;
  generated_at: string;
  profile: {
    window: { start: string; end: string; weeks: number; active_weeks?: number };
    habit: {
      sessions_per_week: number;
      goal_sessions_per_week: number | null;
      avg_duration_min: number | null;
      duration_median_min: number | null;
      trained_dows: number[];
    };
    muscles: DigestMuscle[];
    structure: { push_pull_ratio: number | null; upper_lower_ratio: number | null };
    /** V9：体重与旧伤 / 基础疾病（手动填，不是从训记推的）。 */
    body: DigestBody;
  };
  week: {
    week_start: string;
    week_end: string;
    week_no: number | null;
    total_weeks: number | null;
    is_deload: boolean;
    cycle_goal: string | null;
    long_term_goal: string | null;
    /** 长期不足、本周该补的肌群（R-AG-03）。 */
    focus_muscles: string[];
    /** 量偏高且无进步、本周该减的肌群（R-AG-04）。 */
    reduce_muscles: string[];
    /** 12 周窗口内 0 有效组 —— 事实陈述，不代表必须补。 */
    untrained_muscles: string[];
    last_week: {
      start: string;
      end: string;
      sessions: number;
      effective_sets: number;
      by_muscle: Record<string, number>;
    } | null;
    last_session: { datestr: string; title: string; sets: number; movements: string[] } | null;
    /**
     * **上一周（计划周的前一周）的复盘结论**。
     *
     * 来源是 `weekly_review`（每周一次），不是 4 周周期总结 —— 2026-09-30 用户定案
     * 「它这个总结是每周生成一次，不是四周生成一次」，4 周那条链路已整体删除。
     */
    last_review: { week_start: string; week_end: string; verdict: string; adjustments: string[] } | null;
    /**
     * V12：这一周**实际还能排**的日期（严格晚于今天，升序）。
     * 起始周（残缺周）时它会短于训练日全集 —— AI 必须只在这些日期里排。
     */
    available_datestrs: string[];
    /**
     * 上周「计划 vs 实际」（V6）：上周没排过计划时为 null。
     * 只放**结论性摘要**，不放逐动作明细——明细已经在 candidate_pool[*].progression 里生效了。
     */
    last_plan_actual: {
      week_start: string;
      week_end: string;
      /**
       * 那一周是否已经过完。
       *
       * 🔴 没这个标记 AI 一定会误判：今天周三排下周计划时，「上一周」才走到第 3 天，
       * 完成率必然很低（实测真实库 31%、8 个动作「没做」）—— AI 看到就会以为
       * 「用户练不动」，然后把计划砍薄。有了这个标记，它可以区分
       * 「确实没完成」和「那周还没走到」。
       */
      complete: boolean;
      /** 有效组完成率（实际 / 计划） */
      completion: number;
      planned_days: number;
      trained_days: number;
      /** 计划了但完全没练的天数 */
      missed_days: number;
      /** 做了但没达到计划重量的动作名 */
      missed_weight: string[];
      /** 一次都没做的动作名 */
      skipped: string[];
    } | null;
    /** 计划周特殊情况（`week_note`）：用户事前手写的一句话，排计划时优先级最高。null = 没填。 */
    special_note: string | null;
  };
  findings: Array<{ code: string; severity: 'info' | 'warn' | 'high'; title: string; detail: string; suggestion?: string }>;
  constraints: DigestConstraints;
  candidate_pool: DigestPoolItem[];
  writing_rules: WritingRules;
}

export interface BuildDigestOptions {
  /** analysis_report 快照（可能是 V3 之前生成的旧版本）。 */
  report: AnalysisReport;
  /** 训练基础（实时值，不是报告里的冻结值）。 */
  constraints: { goal: GoalConstraints | null; hard_rules: HardRule[] };
  /** 计划周起始（周一/周日，由训练基础决定）。 */
  weekStart: string;
  /** 周期上下文；未开周期时为 null。 */
  cycle?: PlanCycleContext | null;
  /**
   * 「现在」的时间戳（默认 `Date.now()`）。
   * 存在的理由：摘要层里有几处**依赖当前日期**的窗口（感受取最近 14 天、
   * `last_plan_actual.complete` 判定），没有它这些行为就只能靠跑测试那天恰好是几号来赌。
   */
  nowMs?: number;
}

// ---------------------------------------------------------------------------
// 组装
// ---------------------------------------------------------------------------

/**
 * 聚合码与 cardio / stretch 不是可训练肌群，不进画像。
 *
 * ⚠️ `muscle_group.parent_code` 里有**自引用**（chest→chest、core→core），
 * 所以「谁是父码」必须排除自引用，否则胸和核心会被当成聚合码丢掉。
 */
/**
 * V12：这一周**实际还能排**的日期（严格晚于 todayStr，升序）。
 *
 * - 有 `preferred_dows` → 只保留落在这些星期、且日期 > 今天的那些天
 * - 无 `preferred_dows` → 整周 7 天里还没过的（由 AI 自己挑需要几天）
 *
 * 完整周（还没开始）时返回的集合与「该周全部训练日」一致，与 V12 之前等价。
 */
function availableDatestrs(
  weekStart: string,
  goal: GoalConstraints | null,
  todayStr: string,
): string[] {
  const dows = goal?.preferred_dows ?? [];
  const out: string[] = [];
  for (let off = 0; off < 7; off++) {
    const ds = shiftDays(weekStart, off);
    if (ds <= todayStr) continue; // 今天与过去一律不排（与 PlanConfirm 的写回窗口同一条红线）
    if (dows.length > 0 && !dows.includes(dowOfDateStr(ds))) continue;
    out.push(ds);
  }
  return out;
}

function leafMuscles(groups: Map<string, MuscleGroupInfo>): MuscleGroupInfo[] {
  const parents = new Set<string>();
  for (const g of groups.values()) if (g.parentCode && g.parentCode !== g.code) parents.add(g.parentCode);
  return [...groups.values()]
    .filter((g) => !parents.has(g.code) && g.region !== 'other')
    .sort((a, b) => a.code.localeCompare(b.code));
}

function buildMuscles(report: AnalysisReport, groups: Map<string, MuscleGroupInfo>): DigestMuscle[] {
  const verdictByCode = new Map(report.muscle_trends?.map((m) => [m.muscle_code, m.verdict]) ?? []);
  return leafMuscles(groups).map((g) => ({
    code: g.code,
    name: g.nameZh,
    weekly_sets: report.muscle_volume?.[g.code]?.sets_per_week_seg0 ?? 0,
    verdict: verdictByCode.get(g.code) ?? null,
  }));
}

/**
 * 精选候选池（≤MAX_DIGEST_POOL）。
 *
 * 轮转法：按「重点肌群 → 近期量大的肌群」排序，每轮给每个还没挑够的肌群补 1 个动作，
 * 一个动作可以同时满足它映射到的所有肌群。这样既保证目标肌群有多样选择，又不会让
 * 某个肌群把 30 个名额吃光（旧版 254 个动作里绝大多数与本次计划无关）。
 */
/**
 * 精选候选池（≤MAX_DIGEST_POOL）。
 *
 * 轮转法：按「本周分化要练的肌群 → 重点肌群 → 近期量大的肌群」排序，每轮给每个还没挑够的
 * 肌群补 1 个动作，一个动作可以同时满足它映射到的所有肌群。这样既保证目标肌群有多样选择，
 * 又不会让某个肌群把 30 个名额吃光（旧版 254 个动作里绝大多数与本次计划无关）。
 *
 * 每个肌群的名额按「本周出现几个训练日」定，而不是均摊：
 * 同一个动作一周内不会排两次，所以「两天都要练 glutes」实际需要两批不同的动作。
 * 均摊（每肌群 2 个）曾让 4 练模板的第 4 天（全身 = glutes/chest/back_lats）
 * 一个动作都挑不出来 —— 池子里看起来覆盖了全部肌群，但那三个肌群的动作已被前三天用完。
 */
function selectPool(
  pool: CandidatePoolItem[],
  trendById: Map<number, { verdict: MovementVerdict; delta_weight_pct: number | null; weeks_with_data: number; last_performed: string | null }>,
  focusMuscles: string[],
  muscles: DigestMuscle[],
  dayDemand: Map<string, number>,
  limit: number,
  progById: Map<number, ProgressionAdvice>,
): DigestPoolItem[] {
  const rank = (m: CandidatePoolItem): number =>
    (m.used_recently ? 0 : 100) + (m.mapping_confidence === 'low' ? 40 : 0) + (m.last_weight === null ? 10 : 0);
  const byMuscle = new Map<string, CandidatePoolItem[]>();
  for (const m of pool) {
    for (const mu of m.primary_muscles) {
      const list = byMuscle.get(mu) ?? [];
      list.push(m);
      byMuscle.set(mu, list);
    }
  }
  for (const list of byMuscle.values()) {
    list.sort((a, b) => {
      const ta = trendById.get(a.catalog_id);
      const tb = trendById.get(b.catalog_id);
      // 涨得多的优先（有进步空间的先给 AI），其次是数据多的
      const da = ta?.delta_weight_pct ?? -999;
      const db = tb?.delta_weight_pct ?? -999;
      return rank(a) - rank(b) || db - da || a.catalog_id - b.catalog_id;
    });
  }

  /** 名额：本周要练 1 天给 2 个（当天要挑得出动作，还要留一个变体），练 2 天以上给 3 个。 */
  const quota = (code: string): number => {
    const days = dayDemand.get(code) ?? 0;
    return days === 0 ? 1 : Math.min(POOL_ROUNDS, 1 + days);
  };

  const focusSet = new Set(focusMuscles);
  const byWeekly = (a: DigestMuscle, b: DigestMuscle): number => b.weekly_sets - a.weekly_sets;
  const needOrder = [
    // 重点肌群无条件优先（R-AG-03 的「该补」），其次是本周分化真正会用到的肌群，
    // 再次才按近期量排序的非目标肌群，最后是一组都没有的肌群。
    ...muscles.filter((m) => focusSet.has(m.code)),
    ...muscles
      .filter((m) => !focusSet.has(m.code) && dayDemand.has(m.code))
      .sort((a, b) => (dayDemand.get(b.code) ?? 0) - (dayDemand.get(a.code) ?? 0) || byWeekly(a, b)),
    ...muscles.filter((m) => !focusSet.has(m.code) && !dayDemand.has(m.code) && m.weekly_sets > 0).sort(byWeekly),
    ...muscles.filter((m) => !focusSet.has(m.code) && !dayDemand.has(m.code) && m.weekly_sets === 0),
  ].map((m) => m.code);

  const chosen: CandidatePoolItem[] = [];
  const chosenIds = new Set<number>();
  const usedQuota = new Map<string, number>();
  for (let round = 0; round < POOL_ROUNDS && chosen.length < limit; round++) {
    for (const mu of needOrder) {
      if (chosen.length >= limit) break;
      if ((usedQuota.get(mu) ?? 0) >= quota(mu)) continue;
      const pick = (byMuscle.get(mu) ?? []).find((c) => !chosenIds.has(c.catalog_id));
      if (!pick) continue;
      chosen.push(pick);
      chosenIds.add(pick.catalog_id);
      // 一个动作同时占用它所有主肌群的名额，否则多肌群动作会被重复计入
      for (const mu2 of pick.primary_muscles) usedQuota.set(mu2, (usedQuota.get(mu2) ?? 0) + 1);
    }
  }
  // 兜底：上面挑不满（例如池子整体很小时）按全局排序补足
  if (chosen.length < limit) {
    for (const m of [...pool].sort((a, b) => rank(a) - rank(b) || a.catalog_id - b.catalog_id)) {
      if (chosen.length >= limit) break;
      if (chosenIds.has(m.catalog_id)) continue;
      chosen.push(m);
      chosenIds.add(m.catalog_id);
    }
  }

  return chosen.map((m) => {
    const t = trendById.get(m.catalog_id);
    return {
      catalog_id: m.catalog_id,
      name: m.name,
      primary_muscles: m.primary_muscles,
      ...(m.joint_flags && m.joint_flags.length > 0 ? { joint_flags: m.joint_flags } : {}),
      last_weight: m.last_weight,
      last_sets_reps: m.last_sets_reps,
      trend: t?.verdict ?? 'insufficient_data',
      delta_pct: t?.delta_weight_pct ?? null,
      weeks: t?.weeks_with_data ?? 0,
      last_performed: t?.last_performed ?? null,
      used_recently: m.used_recently,
      mapping_confidence: m.mapping_confidence,
      progression: progById.get(m.catalog_id) ?? { suggest_kg: null, delta_kg: null, action: 'establish' },
    };
  });
}

/** 上一周（相对计划周）的实际训练：次数 / 有效组 / 各肌群组数。 */
function buildLastWeek(
  db: Db,
  weekStart: string,
): PlanInputDigest['week']['last_week'] {
  const start = shiftDays(weekStart, -7);
  const end = shiftDays(weekStart, -1);
  const w: WindowInfo = { trendStart: start, trendEnd: end, recentStart: start, recentEnd: end, weeks: 1 };
  const sessions = loadSessions(db, w);
  if (sessions.length === 0) return null;
  const setRows = loadSetRows(db, w);
  const maps = loadMuscleMaps(db);
  const { volume } = computeMuscleVolume(setRows, maps);
  const byMuscle: Record<string, number> = {};
  for (const [code, v] of Object.entries(volume)) {
    if (v.sets_total > 0) byMuscle[code] = v.sets_total;
  }
  return {
    start,
    end,
    sessions: sessions.length,
    effective_sets: setRows.filter(isEffectiveSet).length,
    by_muscle: byMuscle,
  };
}

/**
 * 上一周的复盘结论 —— 读 `weekly_review`，**只看计划周的前一周**。
 *
 * 🔴 为什么是「前一周」而不是「最近一次已完成的」：
 *    排的永远是下一周，刚刚结束的那一周（week_start - 7）才是最相关的。
 *    取「最近一次」的话，用户跳过一周没复盘时，两周前那句结论会被当成上周的话喂给 AI。
 *
 * 🔴 为什么从 `review` 表改成 `weekly_review`：
 *    用户 2026-09-30 定案「它这个总结是每周生成一次，不是四周生成一次」，
 *    4 周周期总结（T5 / R-14）整条链路已删除。
 */
function buildLastReview(db: Db, weekStart: string): PlanInputDigest['week']['last_review'] {
  const prevStart = shiftDays(weekStart, -7);
  const row = prepare(
    db,
    `SELECT week_start, week_end, ai_summary_json FROM weekly_review
     WHERE week_start = ? AND status = 'done'`,
  ).get(prevStart) as unknown as
    | { week_start: string; week_end: string; ai_summary_json: string | null }
    | undefined;
  if (!row || !row.ai_summary_json) return null;
  let parsed: Partial<WeeklyReview>;
  try {
    parsed = JSON.parse(row.ai_summary_json) as Partial<WeeklyReview>;
  } catch {
    return null;
  }
  const adjustments = Array.isArray(parsed.adjustments)
    ? parsed.adjustments.filter((a): a is string => typeof a === 'string')
    : [];
  const verdict = typeof parsed.verdict === 'string' ? parsed.verdict : '';
  // 两者都空 → 等于没有可用结论，不要塞一个空壳给 AI
  if (verdict === '' && adjustments.length === 0) return null;
  return { week_start: row.week_start, week_end: row.week_end, verdict, adjustments };
}

export function buildPlanDigest(db: Db, opts: BuildDigestOptions): PlanInputDigest {
  const { report, constraints, weekStart } = opts;
  const cycle = opts.cycle ?? null;
  const nowMs = opts.nowMs ?? Date.now();
  const generatedAt = new Date(nowMs).toISOString();

  const groups = loadMuscleGroups(db);
  const muscles = buildMuscles(report, groups);
  const trendById = new Map(report.movement_trends?.map((t) => [t.catalog_id, t]) ?? []);

  const focusMuscles = muscles.filter((m) => m.verdict === 'insufficient').map((m) => m.code);
  const reduceMuscles = muscles.filter((m) => m.verdict === 'excess').map((m) => m.code);
  const untrainedMuscles = muscles.filter((m) => m.verdict === null).map((m) => m.code);

  // 硬约束先物理剔除，再精选 —— 否则精选出来的名额会被违禁动作占掉
  const { filtered } = filterCandidatePool(report.candidate_pool ?? [], constraints);
  // 本周分化要练哪些肌群、各出现在几天：决定池子给每个肌群留几个名额。
  // 一周几练以「选中的训练日」为准（与设置页推导方式一致）。
  const sessions = constraints.goal?.preferred_dows?.length || constraints.goal?.sessions_per_week || 3;

  // ---- V5 + V6：先看上周做到多少（V6），再算本周该加多少（V5） ----
  // 顺序不能反：V5 的「上周未达成 → 回退到实际水平」正是靠 V6 的结果。
  const lastWeekStart = shiftDays(weekStart, -7);
  const planActual = loadPlanActual(db, lastWeekStart);
  const actualById = new Map((planActual?.items ?? []).map((i) => [i.catalog_id, i]));
  const isDeload = cycle?.isDeload === true;
  const progById = new Map<number, ProgressionAdvice>();
  for (const m of filtered) {
    const t = trendById.get(m.catalog_id);
    const a = actualById.get(m.catalog_id);
    progById.set(
      m.catalog_id,
      computeProgression({
        recentWeight: t?.last_weight ?? null,
        bestWeight: m.last_weight,
        verdict: t?.verdict ?? 'insufficient_data',
        weeksWithData: t?.weeks_with_data ?? 0,
        slopePerWeek: t?.slope_weight_per_week ?? null,
        lastPlan: a ? { targetWeight: a.plan_weight_kg, actualBestWeight: a.actual_best_kg } : undefined,
        isDeload,
      }),
    );
  }

  const pool = selectPool(filtered, trendById, focusMuscles, muscles, muscleDayDemand(sessions), MAX_DIGEST_POOL, progById);

  const lastSession = report.window?.last_session ?? null;
  const basic = report.basic_stats;

  return {
    schema_version: PLAN_INPUT_SCHEMA_VERSION,
    generated_at: generatedAt,
    profile: {
      window: {
        start: report.window?.trend_start ?? weekStart,
        end: report.window?.trend_end ?? shiftDays(weekStart, -1),
        weeks: report.window?.weeks ?? ANALYSIS_WINDOW_WEEKS,
        // 实际覆盖周数：让 AI 能区分「窗口 26 周 vs 实际只覆盖 12 周」——
        // 否则它会把 sessions_per_week 当成「长期频率」而误判用户欠练。
        active_weeks: report.basic_stats?.active_weeks ?? report.window?.weeks ?? ANALYSIS_WINDOW_WEEKS,
      },
      habit: {
        sessions_per_week: basic?.sessions_per_week ?? 0,
        goal_sessions_per_week: constraints.goal?.sessions_per_week ?? null,
        avg_duration_min: basic?.avg_duration_min ?? null,
        // 旧快照没有 duration_median_min → 回退平均时长（宁可给个近似值也不给 null）
        duration_median_min: basic?.duration_median_min ?? basic?.avg_duration_min ?? null,
        trained_dows: basic?.preferred_dows ?? [],
      },
      muscles,
      structure: {
        push_pull_ratio: report.structure?.push_pull_ratio ?? null,
        upper_lower_ratio: report.structure?.upper_lower_ratio ?? null,
      },
      // V9：体重与旧伤。**只进文本**，不参与任何筛选/禁用（见 DigestBody 注释）。
      body: loadBodyForDigest(db, nowMs),
    },
    week: {
      week_start: weekStart,
      week_end: shiftDays(weekStart, 6),
      week_no: cycle?.weekNo ?? null,
      total_weeks: cycle?.totalWeeks ?? null,
      is_deload: cycle?.isDeload === true,
      cycle_goal: cycle?.goalText ?? null,
      long_term_goal: cycle?.longTermGoal ?? constraints.goal?.goal_type ?? null,
      focus_muscles: focusMuscles,
      reduce_muscles: reduceMuscles,
      untrained_muscles: untrainedMuscles,
      last_week: buildLastWeek(db, weekStart),
      last_session: lastSession
        ? {
            datestr: lastSession.datestr,
            title: lastSession.title,
            sets: lastSession.movements.reduce((s, m) => s + m.sets, 0),
            movements: lastSession.movements.map((m) => m.name).slice(0, 12),
          }
        : null,
      last_review: buildLastReview(db, weekStart),
      // V6：上周计划 vs 实际的**结论**（明细已经通过 progression 作用到每个动作上了）
      last_plan_actual: planActual
        ? {
            week_start: planActual.week_start,
            week_end: planActual.week_end,
            // generatedAt 就是「现在」；计划周最后一天还没到今天 → 那周仍在进行中
            complete: planActual.week_end < generatedAt.slice(0, 10),
            completion: planActual.completion,
            planned_days: planActual.planned_days,
            trained_days: planActual.trained_days,
            missed_days: planActual.missed_days.length,
            missed_weight: planActual.items
              .filter((i) => i.weight_hit === false)
              .map((i) => i.name)
              .slice(0, 8),
            skipped: planActual.items
              .filter((i) => i.status === 'missed')
              .map((i) => i.name)
              .slice(0, 8),
          }
        : null,
      // 计划周特殊情况（`week_note`，2026-09-30 用户定案）：用户**事前**写的一句话，
      // 描述这一周的特殊情况（经期 / 临时不舒服）。它是排计划输入里**优先级最高**的一项
      // —— 高于周期目标（「先考虑我在经期内，再考虑我这周练胸」）。
      //
      // ⚠️ 以前这里读的是「最近 14 天的 daily_note（日感受）」，那是错的：
      //    日感受是**事后**记录（练完感觉怎么样），用途是**复盘**（→ 周复盘 AI →
      //    `week.last_review` → 绕一圈才回到排计划）。用户原话：
      //    「它就是用来复盘的，只关乎下一周的计划，跟这一周的计划是没有关系的」。
      //    所以两者分表、分用途，不要合并读取。
      special_note: weekNoteForDigest(loadWeekNote(db, weekStart)),
      /**
       * V12：这一周**实际还能排**的日期（严格晚于今天，升序）。
       *
       * 存在的理由：起始周（残缺周）里，AI 拿 `week_start` + `preferredDows` 自己算日期，
       * 会把已经过去的训练日也排进去 —— 用户周三打开、训练日周二/周四，AI 就会生成
       * 一条落在周二的计划（`validator` 只查「在本周范围内」，拦不住）。
       * 给了这份清单，AI 直接照着排，不用做日期算术。
       *
       * 完整周（一周都没过）时它就是 7 天里的训练日全集，与老行为等价。
       */
      available_datestrs: availableDatestrs(weekStart, constraints.goal, generatedAt.slice(0, 10)),
    },
    findings: (report.findings ?? []).map((f) => ({
      code: f.code,
      severity: f.severity,
      title: f.title,
      detail: f.detail,
      ...(f.suggestion ? { suggestion: f.suggestion } : {}),
    })),
    constraints: { goal: constraints.goal, hard_rules: constraints.hard_rules ?? [] },
    candidate_pool: pool,
    writing_rules: report.writing_rules,
  };
}

/** 摘要的字节数（UTF-8）—— 用于「payload ≤ 15 KB」这条验收红线的实测。 */
export function digestByteSize(d: PlanInputDigest): number {
  return Buffer.byteLength(JSON.stringify(d), 'utf8');
}

// ---------------------------------------------------------------------------
// 模板路径的摘要（周期第 2~4 周）
// ---------------------------------------------------------------------------

export interface BuildTemplateDigestOptions extends BuildDigestOptions {
  template: RawTemplate;
}

export interface TemplateDigest {
  /** 精简版摘要（不含 profile.muscles / findings，池子只含模板用到的动作）。 */
  digest: PlanInputDigest;
  /** 最终模板：结构 + **本周**建议重量 + **平移后**的日期。 */
  template: PlanTemplate;
}

/**
 * 模板路径的输入构造（2026-09-30「周期内同一个模板」）。
 *
 * 砍掉的三块，以及为什么敢砍：
 *   ① `profile.muscles`（1.2 KB / 22 条肌群基线条目）—— 模板路径**不做结构调整**，
 *      该补该减已经浓缩在保留的 `week.focus_muscles` / `reduce_muscles` 里。
 *      ⚠️ 代价：`muscle_trend:` 类型的 evidence ref 不再可解析，prompt 里明确禁用了它。
 *   ② `findings`（1.7 KB）—— 每一条都会诱导 AI 去**改结构**，而这条路径要的正是「别乱改」。
 *   ③ 候选池里没被模板用到的动作 —— 池子在这里只剩两个用途：
 *      给出 catalog_id（V1 逐字校验）、给出本周建议重量（V5）。模板已经把
 *      「哪天练什么、几组几次」写全了，30 个候选动作在模板路径下没有决策价值。
 *
 * 不砍的：`week`（特殊情况 / 周期目标 / 上周实况 / 上周复盘结论）、`constraints`
 * （硬约束必须给）、`writing_rules`。这三样加起来还不到 1.6 KB。
 *
 * 尺寸实测：全量 14.0 KB → 模板路径 ~6 KB（发给 AI 的 payload 还会把池条目压到 4 个字段）。
 */
export function buildTemplateDigest(db: Db, opts: BuildTemplateDigestOptions): TemplateDigest {
  const full = buildPlanDigest(db, opts);
  const byId = new Map(full.candidate_pool.map((m) => [m.catalog_id, m]));

  const template: PlanTemplate = {
    source_week_start: opts.template.source_week_start,
    source_week_end: opts.template.source_week_end,
    source_week_no: opts.template.source_week_no,
    days: opts.template.days.map((d) => ({
      // 日期由服务端平移：AI 拿到的是**本周**的日期，不需要做任何算术
      datestr: datestrForDow(opts.weekStart, d.dow),
      day_type: d.day_type,
      title: d.title,
      target_muscles: d.target_muscles,
      exercises: d.exercises.map((e) => {
        const advice = byId.get(e.catalog_id)?.progression;
        return {
          name: e.name,
          catalog_id: e.catalog_id,
          sets: e.sets,
          reps: e.reps,
          rest_s: e.rest_s,
          is_cardio: e.is_cardio,
          last_week_weight_kg: e.last_week_weight_kg,
          suggest_kg: advice?.suggest_kg ?? null,
          progression_action: advice?.action ?? PROGRESSION_ACTION_NONE,
        };
      }),
    })),
  };

  // 池子 = 模板用到的动作 ∪ `keep` 硬约束要求的动作。
  // keep 必须并进来：校验器 V4 会在「keep 动作没出现在计划里」时 BLOCK，
  // 而模板路径的池子决定了 AI **能**用哪些动作 —— 池子里没有 keep 动作，
  // AI 就补不进来，只能连着 3 轮失败降级。keep 通常不到 3 个，代价可忽略。
  const usedIds = new Set(template.days.flatMap((d) => d.exercises.map((e) => e.catalog_id)));
  const keepNames = new Set(
    (opts.constraints.hard_rules ?? [])
      .filter((r) => r.kind === 'keep' && r.target_type === 'movement')
      .map((r) => String(r.target_value)),
  );
  const pool = full.candidate_pool.filter((m) => usedIds.has(m.catalog_id) || keepNames.has(m.name));

  return {
    template,
    digest: {
      ...full,
      profile: { ...full.profile, muscles: [] },
      findings: [],
      // 兜底：模板动作一个都没落在候选池里（例如上一周的动作本周全被 avoid 了）。
      // 此时退回全量池 —— 继续走模板 prompt 仍有意义（结构、组数、减容纪律都还在），
      // 而给一个空池会让 AI 一个动作都输出不了、必然熔断降级。
      candidate_pool: pool.length > 0 ? pool : full.candidate_pool,
    },
  };
}

/** 模板动作在候选池里查不到 progression 时的占位（只可能是「本周不能再用这个动作」）。 */
const PROGRESSION_ACTION_NONE = 'unavailable_in_pool';
