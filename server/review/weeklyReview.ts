/**
 * 周复盘（PRD-v2 §10.3 V8）。
 *
 * 页面是手账式的：上半部是这一周**实际发生了什么**（每天练没练、跟计划比完成度如何），
 * 下半部是每天一个感受输入框（`daily_note`）。周结束后可以点一次 AI 复盘，
 * 输出被强制写得很短（达标吗 / 下周微调）。
 *
 * ⚠️ 这里**照旧返回完整 7 天**（它是数据视图，也是「计划 vs 实际」的唯一口径）。
 *    「只显示练了的那些天」是**页面层**的取舍 —— 用户 2026-09-30：
 *    「没有训练的，你就直接给它删了」。判据只有一条、且与全局同源：
 *    `actual.effective_sets > 0`（派生自 `isEffectiveSet`）。别在这一层再过滤，
 *    否则将来做「哪些天该练没练」的视图就没数据可用了。
 *
 * 三条口径纪律：
 *   ① 周级数字一律取自 `loadPlanActual`（V6）——**和排计划时 V5/V6 看到的是同一份数据**，
 *      复盘页和 AI 不会各说一套。逐日完成度只统计 `catalog_id` 非空的计划条目，
 *      与 `loadPlanActual` 的 `items` 口径完全一致。
 *   ② 「算不算练了」永远走 `isEffectiveSet`，本模块不另写一套。
 *   ③ 感受只存本地库，**不同步回训记**（§6 决策 1）。
 */
import type { Db } from '../db/index.js';
import { prepare } from '../db/index.js';
import { isoSeconds } from '../util/clock.js';
import { shiftDays, todayStr } from '../util/dates.js';
import { isEffectiveSet, loadSessions, loadSetRows, round2, type WindowInfo } from '../analysis/metrics.js';
import { loadPlanActual } from '../plan/actual.js';
import { getActiveCycle, weekNoOf, CYCLE_WEEKS } from '../cycle/cycleService.js';
import { loadDailyNotes } from './dailyNote.js';
import { getTakeover } from './takeover.js';
import type { AiGateway, WeeklyReview } from '../ai/schemas.js';

/**
 * 逐动作明细（2026-09-30 手账式展示）。
 *
 * 🔴 2026-09-30 晚简化：用户指出**每组次数基本固定在 8~10**，逐组 `kg×次数` 太占位置，
 *    复盘时只想回忆「这个重量做了几组、当时什么感受」。所以只留**重量摘要**，
 *    次数不再输出（前端渲染成 `4 组 · 34kg`）。原来这里叫 `detail`（逐组 `80kg×8 / …`）。
 */
export interface WeekMovementItem {
  /** 动作名（训记原始名） */
  name: string;
  /** 有效组数（isEffectiveSet 口径） */
  sets: number;
  /** 重量摘要（去重后按首见顺序），如 `80kg` / `80kg / 82.5kg`；所有组都没记重量则为空串 */
  weight: string;
}

/** 逐日完成度「达标」线，与 plan/actual.ts 的 DONE_THRESHOLD 同义（完成 8 成就行）。 */
const DONE_THRESHOLD = 0.8;

export interface WeekDayRow {
  datestr: string;
  dow: number;
  /** 计划侧；这天没排训练日 → null */
  planned: {
    plan_day_id: number;
    title: string;
    target_muscles: string[];
    planned_sets: number;
    est_duration_min: number | null;
  } | null;
  /** 实际侧；没有有效组时各项为 0 / null */
  actual: {
    sessions: number;
    movements: number;
    effective_sets: number;
    duration_min: number | null;
    /** 逐动作明细（替代原 movement_names —— 那个截到 6 个且没有组数，不够手账用） */
    items: WeekMovementItem[];
  };
  /** 实际有效组 / 计划组；没有计划 → null */
  completion: number | null;
  /**
   * done     = 计划了且完成 ≥80%
   * partial  = 计划了但完成 <80%
   * missed   = 计划了但一个有效组都没有
   * extra    = 没计划但练了（额外收益，不算欠账）
   * rest     = 没计划也没练
   * upcoming = 这天还没到（今天及以后）
   */
  status: 'done' | 'partial' | 'missed' | 'extra' | 'rest' | 'upcoming';
  /** 用户写的当日感受 */
  note: string | null;
}

export interface WeekSummaryNumbers {
  planned_sessions: number;
  trained_days: number;
  planned_sets: number;
  effective_sets: number;
  /** 计划侧完成率（实际有效组 / 计划组），0~1；无计划 → 0 */
  completion: number;
  missed_days: string[];
  /** 计划了但一次都没做的动作名 */
  skipped_movements: string[];
  /** 做了但没到计划重量的动作名 */
  missed_weight: string[];
  notes_count: number;
}

export interface WeekView {
  week_start: string;
  week_end: string;
  today: string;
  /** 该周是否已结束（week_end < today）。未结束不允许做 AI 复盘。 */
  is_over: boolean;
  /**
   * 接管起点（第一个由本软件规划的训练周，YYYY-MM-DD）；尚未接管 → null。
   * 早于它的周属于「接管前的历史周」，只进训练画像、不做周复盘。
   */
  takeover_start_week: string | null;
  /**
   * 复盘锁定（唯一判据，服务端 400 与前端按钮同源）；null = 可复盘。
   * 前端据此决定按钮是否放行、pre_takeover/no_takeover 时是否整页只显示说明卡。
   */
  lock: ReviewLock | null;
  plan: { id: number; status: string; source: string } | null;
  /** 周期目标（这 4 周的焦点），无周期时 null —— AI 复盘要带一句「是否朝目标推进」。 */
  cycle: { week_no: number; total_weeks: number; goal_text: string; is_deload: boolean } | null;
  days: WeekDayRow[];
  summary: WeekSummaryNumbers;
  review: {
    status: string;
    ai_summary: WeeklyReview | null;
    data_summary: WeekSummaryNumbers | null;
    generated_at: string;
  } | null;
}

export class WeeklyReviewError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

// ---------------------------------------------------------------------------
// 复盘锁定判据（唯一一处）
// ---------------------------------------------------------------------------

export type ReviewLockCode = 'no_takeover' | 'pre_takeover' | 'not_over' | 'no_content';

export interface ReviewLock {
  code: ReviewLockCode;
  /** 完整原因：服务端 400 的错误文案，也是 UI 的 title 与说明正文 */
  reason: string;
  /** 锁定态下生成按钮上的短标签（长原因放不下） */
  label: string;
}

/**
 * 「这一周能不能做周复盘」的**唯一判据** —— 服务端 400 与前端按钮锁定共用这一处。
 *
 * 🔴 为什么要收敛到函数里：以前服务端两条硬规则（周未结束 / 无计划无训练）在
 *    `src/pages/Review.tsx` 里被手工镜像了一份，两边随时可能漂移
 *    （UI 看着能点、点下去吃 400）。现在前端只读服务端返回的 `WeekView.lock`。
 *
 * 🔴 接管起点（`takeover_start_week`）是产品模型的核心界碑：
 *    历史训练数据只进画像、不进复盘；`weekStart < 接管起点` 的周一律并入画像。
 *
 * 判定顺序（**顺序即优先级，别调换**）：
 *    ① 尚未接管      → no_takeover
 *    ② 早于接管起点  → pre_takeover
 *    ③ 本周没结束    → not_over
 *    ④ 无计划也无训练 → no_content
 *    否则 null（可复盘）。
 */
export function reviewLockReason(i: {
  weekStart: string;
  weekEnd: string;
  isOver: boolean;
  hasPlan: boolean;
  hasTraining: boolean;
  takeoverStartWeek: string | null;
}): ReviewLock | null {
  if (i.takeoverStartWeek === null) {
    return {
      code: 'no_takeover',
      label: '尚未接管',
      reason: '你还没有把训练交给本软件规划 —— 开一个训练周期之后，这里才会有可复盘的周。',
    };
  }
  if (i.weekStart < i.takeoverStartWeek) {
    return {
      code: 'pre_takeover',
      label: '已并入画像',
      reason: `这一周（${i.weekStart} ~ ${i.weekEnd}）在你开始用本软件规划训练之前，它的训练记录已并入训练画像，不做周复盘。`,
    };
  }
  if (!i.isOver) {
    return {
      code: 'not_over',
      label: '本周结束后才能生成',
      reason: `本周还没结束（${i.weekStart} ~ ${i.weekEnd}），周末过后才能生成`,
    };
  }
  if (!i.hasPlan && !i.hasTraining) {
    return {
      code: 'no_content',
      label: '无可复盘内容',
      reason: '这一周既没有计划也没有训练数据，没有可复盘的内容',
    };
  }
  return null;
}

function dowOf(datestr: string): number {
  return new Date(`${datestr}T00:00:00Z`).getUTCDay();
}

/** 该周 7 天的日期。 */
export function weekDatesOf(weekStart: string): string[] {
  return Array.from({ length: 7 }, (_, i) => shiftDays(weekStart, i));
}

// ---------------------------------------------------------------------------
// 周视图
// ---------------------------------------------------------------------------

/** 取该周生效的计划（与 loadPlanActual 同一规则：排除 archived，多份取最新）。 */
function planOfWeek(db: Db, weekStart: string): { id: number; status: string; source: string } | null {
  const row = prepare(
    db,
    `SELECT id, status, source FROM plan WHERE week_start = ? AND status != 'archived' ORDER BY id DESC LIMIT 1`,
  ).get(weekStart) as { id: number; status: string; source: string } | undefined;
  return row === undefined ? null : { id: Number(row.id), status: row.status, source: row.source };
}

/**
 * 逐日计划侧：该计划每天排了几组（只算 catalog_id 非空，与 loadPlanActual.items 同口径）。
 *
 * 🔴 2026-10-05 修复：这里原本只返回 `planned_sets`，导致逐日完成率的分子用了
 *    「该天全部有效组」—— 用户那天要是顺手加练了几个计划外的动作，分子就会超过分母。
 *    实测 2026-09-28：计划 13 组、实际 26 组 → 页面显示「完成率 200%」。
 *    现在额外返回该天的 **计划内动作 catalog_id 集合**，让分子只统计命中计划的那些组。
 */
function plannedByDay(db: Db, planId: number): Map<
  string,
  {
    plan_day_id: number;
    title: string;
    target_muscles: string[];
    planned_sets: number;
    /** 该天计划里出现过的动作 catalog_id */
    planned_catalog_ids: Set<number>;
    /** catalog_id → 该动作当天的计划组数（用于超量截断） */
    planned_sets_by_catalog: Map<number, number>;
    est_duration_min: number | null;
  }
> {
  const dayRows = prepare(
    db,
    `SELECT id, datestr, title, target_muscles_json, est_duration_min FROM plan_day WHERE plan_id = ?`,
  ).all(planId) as unknown as Array<{
    id: number;
    datestr: string;
    title: string;
    target_muscles_json: string | null;
    est_duration_min: number | null;
  }>;
  const out = new Map<
    string,
    {
      plan_day_id: number;
      title: string;
      target_muscles: string[];
      planned_sets: number;
      planned_catalog_ids: Set<number>;
      planned_sets_by_catalog: Map<number, number>;
      est_duration_min: number | null;
    }
  >();
  for (const d of dayRows) {
    const exRows = prepare(
      db,
      `SELECT catalog_id, sets FROM plan_exercise WHERE plan_day_id = ? AND catalog_id IS NOT NULL`,
    ).all(Number(d.id)) as unknown as Array<{ catalog_id: number; sets: number }>;
    out.set(d.datestr, {
      plan_day_id: Number(d.id),
      title: d.title,
      target_muscles: d.target_muscles_json === null ? [] : (JSON.parse(d.target_muscles_json) as string[]),
      planned_sets: exRows.reduce((s, e) => s + Number(e.sets), 0),
      /** 该天计划里出现过的动作（catalog_id → 计划组数）。逐日完成率的分子只认这些。 */
      planned_catalog_ids: new Set(exRows.map((e) => Number(e.catalog_id))),
      planned_sets_by_catalog: new Map(exRows.map((e) => [Number(e.catalog_id), Number(e.sets)])),
      est_duration_min: d.est_duration_min === null ? null : Number(d.est_duration_min),
    });
  }
  return out;
}

export function buildWeekView(db: Db, weekStart: string, nowMs: number = Date.now()): WeekView {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(weekStart)) throw new WeeklyReviewError(400, 'week_start 需为 YYYY-MM-DD');
  const today = todayStr(nowMs);
  const dates = weekDatesOf(weekStart);
  const weekEnd = dates[6];
  const isOver = weekEnd < today;

  const win: WindowInfo = { trendStart: weekStart, trendEnd: weekEnd, recentStart: weekStart, recentEnd: weekEnd, weeks: 1 };

  // 实际侧：逐日聚合（会话数 / 有效组 / 时长 / 逐动作明细）
  const sessions = loadSessions(db, win);
  const setRows = loadSetRows(db, win);
  const perDay = new Map<
    string,
    {
      sessions: number;
      effective_sets: number;
      duration_min: number | null;
      /** 动作名 → { 组数, 出现过的重量（首见顺序去重） }；保持首见顺序（训记里动作的排练顺序） */
      movements: Map<string, { sets: number; weights: Set<string> }>;
      /** catalog_id → 该天该动作的有效组数。逐日完成率的分子只统计命中计划的部分。 */
      byCatalog: Map<number, number>;
    }
  >();
  for (const s of sessions) {
    const cur =
      perDay.get(s.datestr) ??
      { sessions: 0, effective_sets: 0, duration_min: null, movements: new Map(), byCatalog: new Map() };
    cur.sessions += 1;
    if (cur.duration_min === null && s.durationMin !== null && s.isOutlier === 0) cur.duration_min = s.durationMin;
    perDay.set(s.datestr, cur);
  }
  /** 只取重量（2026-09-30 简化：次数基本固定，不再输出逐组 `kg×次数`）。 */
  const weightLabel = (r: (typeof setRows)[number]): string =>
    r.weightKg === null ? '' : `${r.weightKg}kg`;
  for (const r of setRows) {
    if (!isEffectiveSet(r)) continue;
    const cur =
      perDay.get(r.datestr) ??
      { sessions: 0, effective_sets: 0, duration_min: null, movements: new Map(), byCatalog: new Map() };
    cur.effective_sets += 1;
    const mv = cur.movements.get(r.nameRaw) ?? { sets: 0, weights: new Set<string>() };
    mv.sets += 1;
    const w = weightLabel(r);
    if (w !== '') mv.weights.add(w);
    cur.movements.set(r.nameRaw, mv);
    if (r.catalogId !== null) cur.byCatalog.set(r.catalogId, (cur.byCatalog.get(r.catalogId) ?? 0) + 1);
    perDay.set(r.datestr, cur);
  }

  const plan = planOfWeek(db, weekStart);
  const planned = plan === null ? new Map<string, never>() : plannedByDay(db, plan.id);
  const notes = loadDailyNotes(db, weekStart, weekEnd);

  /**
   * 逐日完成率的分子：**只算命中该天计划动作的有效组，且每个动作截断到计划组数**。
   *
   * 🔴 2026-10-05 修：「完成率 200%」的根因就在这里。旧写法分子是 `a.effective_sets`
   *    （该天全部有效组），9/28 计划 13 组、实际 26 组 —— 用户那天练的动作一个都不在
   *    当天计划里（计划写的是下肢，实际练的上肢），于是算出 200%。
   *    现在的口径：
   *      ① 只有 catalog_id 出现在该天计划里的组才计入分子；
   *      ② 单个动作最多贡献它的计划组数（练 6 组而计划 4 组 → 只算 4 组），完成率因此封顶 100%。
   *    与 `loadPlanActual` 的 items 口径同源（都按 catalog_id 对齐、只认计划内动作）。
   *
   * ⚠️ 副作用（有意为之）：像 9/28 这种「计划下肢、实际练上肢」的日子，完成率会变成 0% ——
   *    这是**正确**的：那天确实没有执行计划。原来那个 200% 才是错的。
   */
  const plannedInDay = (p: {
    planned_sets_by_catalog: Map<number, number>;
  }, byCatalog: Map<number, number> | undefined): number => {
    if (byCatalog === undefined) return 0;
    let hit = 0;
    for (const [cid, planSets] of p.planned_sets_by_catalog) {
      const actual = byCatalog.get(cid) ?? 0;
      hit += Math.min(actual, planSets);
    }
    return hit;
  };

  const days: WeekDayRow[] = dates.map((ds) => {
    const p = (planned as Map<string, {
      plan_day_id: number;
      title: string;
      target_muscles: string[];
      planned_sets: number;
      planned_catalog_ids: Set<number>;
      planned_sets_by_catalog: Map<number, number>;
      est_duration_min: number | null;
    }>).get(ds) ?? null;
    const a = perDay.get(ds);
    const effectiveSets = a?.effective_sets ?? 0;
    // 完成率的分子 = 命中计划的组（截断到计划组数）；分母 = 该天计划组数。
    const matchedSets = p === null ? 0 : plannedInDay(p, a?.byCatalog);
    const completion = p !== null && p.planned_sets > 0 ? round2(matchedSets / p.planned_sets) : null;

    let status: WeekDayRow['status'];
    // 「今天」也是 upcoming —— 手账是给人看的，下午三点显示「今天没练」纯属添堵。
    // 今天已经练了的话照常判 done/partial（下面的分支够用，所以只在没有有效组时兜成 upcoming）。
    if (ds > today || (ds === today && effectiveSets === 0)) status = 'upcoming';
    else if (p !== null) {
      if (effectiveSets === 0) status = 'missed';
      else if (completion !== null && completion >= DONE_THRESHOLD) status = 'done';
      else status = 'partial';
    } else {
      status = effectiveSets > 0 ? 'extra' : 'rest';
    }

    return {
      datestr: ds,
      dow: dowOf(ds),
      planned: p,
      actual: {
        sessions: a?.sessions ?? 0,
        movements: a?.movements.size ?? 0,
        effective_sets: effectiveSets,
        duration_min: a?.duration_min ?? null,
        items: [...(a?.movements ?? [])].map(([name, mv]) => ({
          name,
          sets: mv.sets,
          weight: [...mv.weights].join(' / '),
        })),
      },
      completion,
      status,
      note: notes.get(ds) ?? null,
    };
  });

  // 周级数字：从上面那份 `days` 现算 —— 它就是页面逐日显示的那份事实，两处不可能不一致。
  //
  // 🔴 为什么不再拿 V6 的 loadPlanActual（pa）算这几个数字：pa 的口径是「**计划** vs 实际」，
  //    只统计**计划里出现过的动作**。用户没排计划的那一周（历史周基本都是这样）pa 全是 0，
  //    于是页面上出现「有效组 0 / 练过的天 0」，而每张日卡都写着「26 有效组」——自相矛盾。
  //    pa 现在只用来算下面三个「与计划相关的清单」（没计划时本来就是空清单，语义正确）。
  const plannedSets = days.reduce((s, d) => s + (d.planned?.planned_sets ?? 0), 0);
  const effectiveSetsTotal = days.reduce((s, d) => s + d.actual.effective_sets, 0);
  const pa = loadPlanActual(db, weekStart);
  const summary: WeekSummaryNumbers = {
    planned_sessions: days.filter((d) => d.planned !== null).length,
    trained_days: days.filter((d) => d.actual.sessions > 0 || d.actual.effective_sets > 0).length,
    planned_sets: plannedSets,
    effective_sets: effectiveSetsTotal,
    /**
     * 🔴 周级完成率同样只认「命中计划的组」并逐动作截断（与逐日 completion 同源）。
     *    旧写法分子是 effectiveSetsTotal（含计划外加练），9/28 那种「练了但没照计划练」
     *    的日子会把周完成率一起抬上去。现在与逐日口径一致：52 组计划 / 命中 26 组 → 50%。
     */
    completion: plannedSets > 0 ? round2(days.reduce((s, d) => s + (d.completion ?? 0) * (d.planned?.planned_sets ?? 0), 0) / plannedSets) : 0,
    // 🔴 不用 pa.missed_days：那个口径把「今天」和「还没到的计划日」也算作欠账，
    // 手账页在周中打开会看到一串红色「没练」。这里只算**已经过去且确实没练**的日子，
    // 与逐日 status 完全同源。周已结束时两者等价（没有未来日期）。
    missed_days: days.filter((d) => d.status === 'missed').map((d) => d.datestr),
    skipped_movements: pa?.items.filter((i) => i.status === 'missed').map((i) => i.name) ?? [],
    missed_weight: pa?.items.filter((i) => i.actual_sets > 0 && i.weight_hit === false).map((i) => i.name) ?? [],
    notes_count: notes.size,
  };

  const cycle = getActiveCycle(db);
  const weekNo = cycle === null ? null : weekNoOf(cycle, weekStart);

  // 复盘锁定判据（唯一一处，见 reviewLockReason）。接管起点缺失 = 尚未接管。
  const takeoverStartWeek = getTakeover(db)?.start_week ?? null;
  const lock = reviewLockReason({
    weekStart,
    weekEnd,
    isOver,
    hasPlan: plan !== null,
    hasTraining: days.some((d) => d.actual.effective_sets > 0),
    takeoverStartWeek,
  });

  const rev = prepare(
    db,
    `SELECT status, ai_summary_json, data_summary_json, generated_at FROM weekly_review WHERE week_start = ?`,
  ).get(weekStart) as { status: string; ai_summary_json: string | null; data_summary_json: string; generated_at: string } | undefined;

  return {
    week_start: weekStart,
    week_end: weekEnd,
    today,
    is_over: isOver,
    takeover_start_week: takeoverStartWeek,
    lock,
    plan,
    cycle:
      cycle !== null && weekNo !== null
        ? { week_no: weekNo, total_weeks: CYCLE_WEEKS, goal_text: cycle.goalText, is_deload: weekNo === CYCLE_WEEKS }
        : null,
    days,
    summary,
    review:
      rev === undefined
        ? null
        : {
            status: rev.status,
            ai_summary: parseJsonLoose<WeeklyReview>(rev.ai_summary_json),
            data_summary: parseJsonLoose<WeekSummaryNumbers>(rev.data_summary_json),
            generated_at: rev.generated_at,
          },
  };
}

function parseJsonLoose<T>(s: string | null): T | null {
  if (s === null) return null;
  try {
    return JSON.parse(s) as T;
  } catch {
    return null;
  }
}

/** 最近 n 周的 week_start（新 → 旧），当前周在前。 */
export function recentWeekStarts(db: Db, today: string, count: number): string[] {
  const row = prepare(
    db,
    `SELECT week_start_dow FROM user_goal WHERE is_active = 1 ORDER BY effective_from DESC, id DESC LIMIT 1`,
  ).get() as { week_start_dow: number } | undefined;
  const startDow = row !== undefined && Number(row.week_start_dow) === 0 ? 0 : 1;
  const dow = dowOf(today);
  const back = (dow - startDow + 7) % 7;
  const thisWeek = shiftDays(today, -back);
  return Array.from({ length: count }, (_, i) => shiftDays(thisWeek, -7 * i));
}

// ---------------------------------------------------------------------------
// AI 周复盘
// ---------------------------------------------------------------------------

export interface WeeklyReviewResult {
  status: 'done' | 'draft';
  week_start: string;
  week_end: string;
  ai_summary: WeeklyReview | null;
  detail?: string;
}

/**
 * 生成（或刷新）某一周的 AI 复盘。
 *
 * 两条硬规则：
 *   ① **周没结束不给做** —— 周中做总结，剩下几天会被当成欠账，结论必然失真。
 *   ② AI 失败不阻断：`status='draft'`，数据部分照常可看，可重试。
 */
export async function generateWeeklyReview(
  db: Db,
  gw: AiGateway | null,
  aiModelTag: string,
  opts: { weekStart: string; nowMs?: number },
): Promise<WeeklyReviewResult> {
  const nowMs = opts.nowMs ?? Date.now();
  const view = buildWeekView(db, opts.weekStart, nowMs);
  // 门禁只认 view.lock（唯一判据，含接管起点两条规则）；别在这里再抄一遍规则。
  if (view.lock !== null) throw new WeeklyReviewError(400, view.lock.reason);

  const notes = view.days.filter((d) => d.note !== null).map((d) => ({ datestr: d.datestr, text: d.note as string }));

  let aiSummary: WeeklyReview | null = null;
  let status: 'done' | 'draft' = 'draft';
  let detail: string | undefined = 'AI 未配置，只有数据部分。配好 LLM 后可重试。';
  if (gw !== null) {
    try {
      aiSummary = await gw.summarizeWeek({
        weekSummary: view.summary as unknown as Record<string, unknown>,
        notes,
        cycleGoal: view.cycle?.goal_text ?? null,
      });
      status = 'done';
      detail = undefined;
    } catch (e) {
      detail = `AI 复盘失败（${(e as Error).message}），数据部分照常可用，可重试`;
    }
  }

  const now = isoSeconds(nowMs);
  prepare(
    db,
    `INSERT INTO weekly_review (week_start, week_end, data_summary_json, ai_summary_json, status, ai_model_tag, generated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(week_start) DO UPDATE SET
       week_end = excluded.week_end,
       data_summary_json = excluded.data_summary_json,
       ai_summary_json = excluded.ai_summary_json,
       status = excluded.status,
       ai_model_tag = excluded.ai_model_tag,
       generated_at = excluded.generated_at`,
  ).run(
    view.week_start,
    view.week_end,
    JSON.stringify(view.summary),
    aiSummary === null ? null : JSON.stringify(aiSummary),
    status,
    status === 'done' ? aiModelTag : null,
    now,
  );

  return { status, week_start: view.week_start, week_end: view.week_end, ai_summary: aiSummary, detail };
}
