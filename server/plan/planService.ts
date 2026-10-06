/**
 * 计划服务（M21，§5.8 草稿队列）。
 *
 * 职责：调 AiGateway 生成计划 → 落库（plan / plan_day / plan_exercise，status=draft）
 * → 手动编辑 → 规则模板降级。
 *
 * 边界：AI 输入只来自 analysis_report 快照 **经摘要层压缩后**的 digest（v3；D12）；
 * 本模块是 L3，只通过 AiGateway 接口触 AI，自身不做任何网络调用。
 * 单版本覆盖（v2）：同周已有草稿 → 原地覆盖（plan id 不变），不再堆积 v1/v2/v3。
 */
import type { Db } from '../db/index.js';
import { prepare } from '../db/index.js';
import type { AiGateway, PlanCycleContext, PlanDraft, PlanGenerationResult, PlanSummary } from '../ai/schemas.js';
import { buildSummary } from '../ai/summaryBuilder.js';
import { buildPlanDigest, buildTemplateDigest, type PlanInputDigest } from '../ai/digest.js';
import type { AnalysisReport, Constraints } from '../analysis/reportSchema.js';
import { goalToConstraints, loadGoal, runAnalysis } from '../analysis/analysisService.js';
import { latestSnapshot } from '../analysis/snapshot.js';
import { hasTrainingData } from '../repo/trainRepo.js';
import { CYCLE_WEEKS, getActiveCycle, weekNoOf } from '../cycle/cycleService.js';
import { templateFor } from './cycleTemplate.js';
import { buildDraftFromCycleTemplate, buildTemplateDraft } from './template.js';
import { logEdit } from './editLog.js';

/** 计划业务错误（路由层翻译为 HTTP 状态码）。 */
export class PlanServiceError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
  }
}

// ---------------------------------------------------------------------------
// 报告快照
// ---------------------------------------------------------------------------

interface ReportRow {
  id: number;
  payload_json: string;
}

export function latestReportSnapshot(db: Db): { reportId: number; report: AnalysisReport } | null {
  const row = prepare(
    db,
    `SELECT id, payload_json FROM analysis_report ORDER BY generated_at DESC, id DESC LIMIT 1`,
  ).get() as unknown as ReportRow | undefined;
  if (!row) return null;
  return { reportId: Number(row.id), report: JSON.parse(row.payload_json) as AnalysisReport };
}

function reportSnapshotById(db: Db, reportId: number | null): { reportId: number; report: AnalysisReport } | null {
  if (reportId === null || reportId === undefined) return null;
  const row = prepare(db, `SELECT id, payload_json FROM analysis_report WHERE id = ?`).get(reportId) as unknown as
    | ReportRow
    | undefined;
  if (!row) return null;
  return { reportId: Number(row.id), report: JSON.parse(row.payload_json) as AnalysisReport };
}

// ---------------------------------------------------------------------------
// 日期工具（全部按 UTC 日期串处理，与探针/落库口径一致）
// ---------------------------------------------------------------------------

export function todayLocal(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function addDays(datestr: string, n: number): string {
  const d = new Date(`${datestr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function dowOf(datestr: string): number {
  return new Date(`${datestr}T00:00:00Z`).getUTCDay();
}

/** 下一个周一（今天是周一则取下周一——当天开始训练来不及走草稿确认流程）。 */
export function nextMonday(todayStr: string): string {
  return nextWeekStart(todayStr, 1);
}

/**
 * 下一个周起点（V1：周起点可由设置页选周一/周日）。
 * 同样是「下一个」——今天正好是周起点就顺延一周，理由同上。
 *
 * ⚠️ 这个函数**永远 +7**，适合「周期从下一个完整周开始」这类场景。
 *    排计划该用 `planningWeekStart`（本周还有训练日就排本周）。
 */
export function nextWeekStart(todayStr: string, weekStartDow: number): string {
  const target = weekStartDow === 0 ? 0 : 1;
  const offset = ((target - dowOf(todayStr) + 7) % 7) || 7;
  return addDays(todayStr, offset);
}

/**
 * 排计划该用哪一周的 week_start。
 *
 * 规则（V12 用户定案）：
 *   ① 本周起算点**还没到**（今天在周起点之前）→ 用本周起算点。
 *   ② 本周起算点**已过**，但本周还有**尚未过去的训练日** → 仍排**本周**（残缺周）。
 *      例：周三打开、训练日周二/周四 → 排本周，实际只会排到周四。
 *   ③ 本周已经没有可用的训练日（全过完 / 一个都没配）→ 顺延到下周起算点。
 *
 * 🔴 与 `nextWeekStart` 的区别就在 ①②：老函数无条件 +7，导致「周一打开也只能排下周」，
 *    把用户本周剩余的训练日全部浪费掉。
 *
 * ⚠️ 只返回 week_start；「哪些训练日还没过」由调用方（排计划时按 training day 过滤）处理。
 */
export function planningWeekStart(todayStr: string, weekStartDow: number, trainingDows: number[]): string {
  const target = weekStartDow === 0 ? 0 : 1;
  const todayDow = dowOf(todayStr);
  // 本周起算点距今天几天（0 = 今天就是起算点；1~6 = 起算点已过几天）
  const back = (todayDow - target + 7) % 7;
  const weekStart = addDays(todayStr, -back);

  // ① 今天就是周起点，或本周还剩没过去的训练日 → 排本周
  if (back === 0) return weekStart;
  if (remainingTrainingDows(todayStr, weekStartDow, trainingDows).length > 0) return weekStart;

  // ② 本周没有可用训练日 → 顺延到下一个起算点
  return addDays(weekStart, 7);
}

/**
 * 落在 [今天+1, 本周起算点+6] 区间内的训练日（0=周日..6=周六 的星期值）。
 *
 * 「今天」不算：`PlanConfirm` 的硬规则是**只写明天开始到本周日**（今天与过去一律不碰）。
 * 返回按星期值升序，去重。
 */
export function remainingTrainingDows(todayStr: string, weekStartDow: number, trainingDows: number[]): number[] {
  if (trainingDows.length === 0) return [];
  const target = weekStartDow === 0 ? 0 : 1;
  const todayDow = dowOf(todayStr);
  const back = (todayDow - target + 7) % 7;
  const weekStart = addDays(todayStr, -back);
  const set = new Set<number>();
  for (let i = 1; i <= 6; i++) {
    const day = addDays(weekStart, i);
    // 必须严格晚于今天（明天起）
    if (day <= todayStr) continue;
    const d = dowOf(day);
    if (trainingDows.includes(d)) set.add(d);
  }
  return [...set].sort((a, b) => a - b);
}


/** 当前生效的一周起始日（0=周日 1=周一）；无激活目标时按周一。 */
export function activeWeekStartDow(db: Db): number {
  const live = loadGoal(db);
  return live?.weekStartDow === 0 ? 0 : 1;
}

/** 当前生效的训练日（0=周日..6=周六）；无激活目标时返回空数组。 */
export function activeTrainingDows(db: Db): number[] {
  const live = loadGoal(db);
  return live?.preferredDows ?? [];
}

/**
 * 排计划该用哪一周 —— 便捷版，自动读「一周起始日 + 训练日」。
 * 这是**排计划窗口的唯一入口**：别再直接调 `nextWeekStart`（那个永远 +7）。
 */
export function currentPlanningWeekStart(db: Db): string {
  return planningWeekStart(todayLocal(), activeWeekStartDow(db), activeTrainingDows(db));
}

/**
 * 排该周计划时给 AI 的周期上下文（V2）；未开周期或该周不在周期内 → null。
 * 周次由日期现算（不落库），长期目标从实时训练基础取。
 */
export function cycleContextFor(db: Db, weekStart: string): PlanCycleContext | null {
  const cycle = getActiveCycle(db);
  if (!cycle) return null;
  const weekNo = weekNoOf(cycle, weekStart);
  if (weekNo === null) return null;
  const live = loadGoal(db);
  return {
    goalText: cycle.goalText,
    longTermGoal: live?.goalType ?? null,
    weekNo,
    totalWeeks: CYCLE_WEEKS,
    isDeload: weekNo === CYCLE_WEEKS,
  };
}

// ---------------------------------------------------------------------------
// 库读取
// ---------------------------------------------------------------------------

export interface PlanRow {
  id: number;
  week_start: string;
  week_end: string;
  version_no: number;
  parent_plan_id: number | null;
  status: string;
  source: string;
  ai_model_tag: string | null;
  goal_id: number | null;
  report_id: number | null;
  summary_json: string | null;
  warnings_json: string | null;
  ai_attempts: number;
  /** 周期模板来源周次（1~4）；null = 全量生成（schema v8）。 */
  template_week_no: number | null;
  created_at: string;
  updated_at: string;
}

function getPlanRow(db: Db, planId: number): PlanRow {
  const row = prepare(
    db,
    `SELECT id, week_start, week_end, version_no, parent_plan_id, status, source, ai_model_tag,
            goal_id, report_id, summary_json, warnings_json, ai_attempts, template_week_no,
            created_at, updated_at
     FROM plan WHERE id = ?`,
  ).get(planId) as unknown as PlanRow | undefined;
  if (!row) throw new PlanServiceError(404, `计划 #${planId} 不存在`);
  return row;
}

function parseSummary(json: string | null): PlanSummary | null {
  if (!json) return null;
  try {
    return JSON.parse(json) as PlanSummary;
  } catch {
    return null;
  }
}

/**
 * 用**实时训练基础**覆盖报告快照里的 goal（PRD-v2 V1）。
 *
 * 为什么必须覆盖：报告是生成计划时的输入快照，`constraints.goal` 冻结着「几次/多久/
 * 哪几天」。用户在设置页改了训练基础后，若排计划仍读快照，就会出现「设置说 3 练、
 * 报告说 4 练」——表现就是改完设置看不出任何变化。排计划必须读当前生效的那一行。
 *
 * 降级：库里没有激活目标时保留快照值（非回归；两者本就读同一张表）。
 */
export function withLiveGoal(db: Db, c: Constraints): Constraints {
  const live = loadGoal(db);
  if (!live) return c;
  return { ...c, goal: goalToConstraints(live) };
}

/** 计划生效的约束：优先其生成时的报告快照，退化为最新报告；goal 用实时训练基础覆盖。 */
function constraintsForPlan(db: Db, row: PlanRow): Constraints {
  const snap = reportSnapshotById(db, row.report_id) ?? latestReportSnapshot(db);
  if (snap) return withLiveGoal(db, snap.report.constraints);
  const live = loadGoal(db);
  return { goal: live ? goalToConstraints(live) : null, hard_rules: [], soft_rules: [] };
}

/** 从库行重建 PlanDraft（AI 调整 / 冲突检查 / summary 重算共用）。 */
export function rebuildDraftFromDb(db: Db, planId: number): PlanDraft {
  const plan = getPlanRow(db, planId);
  const dayRows = prepare(
    db,
    `SELECT id, datestr, day_type, title, target_muscles_json, est_duration_min, why_json
     FROM plan_day WHERE plan_id = ? ORDER BY ord`,
  ).all(planId) as unknown as Array<{
    id: number;
    datestr: string;
    day_type: string | null;
    title: string;
    target_muscles_json: string | null;
    est_duration_min: number | null;
    why_json: string | null;
  }>;

  const days = dayRows.map((d) => {
    const exRows = prepare(
      db,
      `SELECT ord, catalog_id, name, sets, reps, weight_kg, weight_source, rest_s, is_cardio, record_preset, why_json
       FROM plan_exercise WHERE plan_day_id = ? ORDER BY ord`,
    ).all(Number(d.id)) as unknown as Array<{
      ord: number;
      catalog_id: number | null;
      name: string;
      sets: number;
      reps: number | null;
      weight_kg: number | null;
      weight_source: string | null;
      rest_s: number | null;
      is_cardio: number;
      record_preset: string | null;
      why_json: string | null;
    }>;

    return {
      datestr: d.datestr,
      day_type: d.day_type ?? '训练',
      title: d.title,
      target_muscles: d.target_muscles_json ? (JSON.parse(d.target_muscles_json) as string[]) : undefined,
      est_duration_min: d.est_duration_min ?? 60,
      exercises: exRows.map((e) => ({
        ord: Number(e.ord),
        catalog_id: Number(e.catalog_id ?? 0),
        name: e.name,
        sets: Number(e.sets),
        reps: e.reps === null ? null : Number(e.reps),
        weight_kg: e.weight_kg === null ? undefined : Number(e.weight_kg),
        weight_source: (e.weight_source ?? undefined) as 'history_best' | 'history_avg' | 'estimate' | 'user_input' | undefined,
        rest_s: e.rest_s === null ? undefined : Number(e.rest_s),
        is_cardio: Number(e.is_cardio) === 1,
        record_preset: e.record_preset ?? undefined,
        why: e.why_json ? (JSON.parse(e.why_json) as string) : '',
      })),
      why: d.why_json
        ? (JSON.parse(d.why_json) as PlanDraft['days'][number]['why'])
        : { summary: '', evidence_refs: [] },
    };
  });

  return { week_start: plan.week_start, week_end: plan.week_end, days };
}

// ---------------------------------------------------------------------------
// 落库
// ---------------------------------------------------------------------------

function activeGoalId(db: Db): number | null {
  const row = prepare(db, `SELECT id FROM user_goal WHERE is_active = 1 ORDER BY effective_from DESC, id DESC LIMIT 1`).get() as
    | { id: number }
    | undefined;
  return row ? Number(row.id) : null;
}

interface PersistOptions {
  weekStart: string;
  draft: PlanDraft;
  summary: PlanSummary;
  source: 'ai' | 'rule_fallback';
  aiModelTag: string;
  warnings: Array<Record<string, unknown>>;
  attempts: number;
  reportId: number | null;
  goalId: number | null;
  /** 周期模板来源周次；null = 全量生成。 */
  templateWeekNo: number | null;
}

function persistDraft(db: Db, o: PersistOptions): number {
  const now = new Date().toISOString();
  db.exec('BEGIN');
  try {
    const planId = persistDraftInner(db, o, now);
    db.exec('COMMIT');
    return planId;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

/**
 * 单版本覆盖（v2）：同周已有草稿 → 原地清空并重写（plan id 不变）。
 * 已 approved/写入中的计划不动，另起一条新草稿（version_no 接着往下排）。
 */
function persistDraftInner(db: Db, o: PersistOptions, now: string): number {
  const existing = prepare(db, `SELECT id FROM plan WHERE week_start = ? AND status = 'draft' ORDER BY id DESC LIMIT 1`).get(
    o.weekStart,
  ) as unknown as { id: number } | undefined;

  let planId: number;
  if (existing) {
    planId = Number(existing.id);
    // 清掉旧的天与动作，避免残留（plan_exercise 靠 plan_day 级联删除）
    prepare(db, `DELETE FROM plan_day WHERE plan_id = ?`).run(planId);
    prepare(
      db,
      `UPDATE plan SET status = 'draft', source = ?, ai_model_tag = ?, goal_id = ?, report_id = ?,
                       summary_json = ?, warnings_json = ?, ai_attempts = ?, template_week_no = ?, updated_at = ?
       WHERE id = ?`,
    ).run(
      o.source,
      o.aiModelTag,
      o.goalId,
      o.reportId,
      JSON.stringify(o.summary),
      o.warnings.length > 0 ? JSON.stringify(o.warnings) : null,
      o.attempts,
      o.templateWeekNo,
      now,
      planId,
    );
  } else {
    // 🔴 version_no 必须接着同周已有行往下排，不能写死 1。
    //    `plan` 有 `UNIQUE (week_start, version_no)`。v2「单版本覆盖」只覆盖 **draft**，
    //    已 approved / 写入中 / 已写入的那份要留着（用户还能回看），所以这里必然新起一行。
    //    写死 1 的后果：用户导入训记后再点「重新生成」→ 直接 500（实测踩到）。
    const nextVer =
      Number(
        (
          prepare(db, `SELECT COALESCE(MAX(version_no), 0) AS v FROM plan WHERE week_start = ?`).get(o.weekStart) as {
            v: number;
          }
        ).v,
      ) + 1;
    const planResult = prepare(
      db,
      `INSERT INTO plan (week_start, week_end, version_no, status, source, ai_model_tag,
                         goal_id, report_id, summary_json, warnings_json, ai_attempts, template_week_no,
                         created_at, updated_at)
       VALUES (?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      o.weekStart,
      addDays(o.weekStart, 6),
      nextVer,
      o.source,
      o.aiModelTag,
      o.goalId,
      o.reportId,
      JSON.stringify(o.summary),
      o.warnings.length > 0 ? JSON.stringify(o.warnings) : null,
      o.attempts,
      o.templateWeekNo,
      now,
      now,
    );
    planId = Number(planResult.lastInsertRowid);
  }

  for (const [di, day] of o.draft.days.entries()) {
    const dayResult = prepare(
      db,
      `INSERT INTO plan_day (plan_id, datestr, dow, ord, day_type, title, target_muscles_json,
                             est_duration_min, est_sets, why_json, lock_state)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'planned')`,
    ).run(
      planId,
      day.datestr,
      dowOf(day.datestr),
      di + 1,
      day.day_type,
      day.title,
      day.target_muscles ? JSON.stringify(day.target_muscles) : null,
      day.est_duration_min,
      day.exercises.length,
      JSON.stringify(day.why),
    );
    const dayId = Number(dayResult.lastInsertRowid);

    for (const e of day.exercises) {
      prepare(
        db,
        `INSERT INTO plan_exercise (plan_day_id, ord, catalog_id, name, sets, reps, weight_kg, weight_source,
                                    rest_s, is_cardio, record_preset, why_json, source)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        dayId,
        e.ord,
        e.catalog_id > 0 ? e.catalog_id : null,
        e.name,
        e.sets,
        e.reps,
        e.weight_kg ?? null,
        e.weight_source ?? null,
        e.rest_s ?? null,
        e.is_cardio ? 1 : 0,
        e.record_preset ?? null,
        JSON.stringify(e.why),
        'ai', // 手动新增动作（T4 前不开放）才标 'manual'；此处全部来自 AI/模板产出
      );
    }
  }
  return planId;
}

// ---------------------------------------------------------------------------
// 前端渲染结构
// ---------------------------------------------------------------------------

export interface PlanDetail {
  plan: {
    id: number;
    week_start: string;
    week_end: string;
    version_no: number;
    status: string;
    source: string;
    ai_model_tag: string | null;
    ai_attempts: number;
    warnings: Array<Record<string, unknown>>;
    summary: PlanSummary | null;
    report_id: number | null;
    /** 周期模板来源周次（1~4）；null = 全量生成。 */
    template_week_no: number | null;
    created_at: string;
    updated_at: string;
  };
  days: Array<{
    id: number;
    datestr: string;
    dow: number;
    ord: number;
    day_type: string | null;
    title: string;
    target_muscles: string[];
    est_duration_min: number | null;
    why: { summary: string; evidence_refs: Array<{ type: string; ref: string; text: string }> } | null;
    exercises: Array<{
      id: number;
      ord: number;
      catalog_id: number | null;
      name: string;
      sets: number;
      reps: number | null;
      weight_kg: number | null;
      weight_source: string | null;
      rest_s: number | null;
      is_cardio: boolean;
      why: string;
      source: string;
    }>;
  }>;
}

export function getPlanDetail(db: Db, planId: number): PlanDetail {
  const row = getPlanRow(db, planId);
  const dayRows = prepare(
    db,
    `SELECT id, datestr, dow, ord, day_type, title, target_muscles_json, est_duration_min, why_json
     FROM plan_day WHERE plan_id = ? ORDER BY ord`,
  ).all(planId) as unknown as Array<{
    id: number;
    datestr: string;
    dow: number;
    ord: number;
    day_type: string | null;
    title: string;
    target_muscles_json: string | null;
    est_duration_min: number | null;
    why_json: string | null;
  }>;

  return {
    plan: {
      id: Number(row.id),
      week_start: row.week_start,
      week_end: row.week_end,
      version_no: Number(row.version_no),
      status: row.status,
      source: row.source,
      ai_model_tag: row.ai_model_tag,
      ai_attempts: Number(row.ai_attempts),
      warnings: row.warnings_json ? (JSON.parse(row.warnings_json) as Array<Record<string, unknown>>) : [],
      summary: parseSummary(row.summary_json),
      report_id: row.report_id === null ? null : Number(row.report_id),
      template_week_no: row.template_week_no === null ? null : Number(row.template_week_no),
      created_at: String(row.created_at ?? ''),
      updated_at: String(row.updated_at ?? ''),
    },
    days: dayRows.map((d) => {
      const exRows = prepare(
        db,
        `SELECT id, ord, catalog_id, name, sets, reps, weight_kg, weight_source, rest_s, is_cardio, why_json, source
         FROM plan_exercise WHERE plan_day_id = ? ORDER BY ord`,
      ).all(Number(d.id)) as unknown as Array<{
        id: number;
        ord: number;
        catalog_id: number | null;
        name: string;
        sets: number;
        reps: number | null;
        weight_kg: number | null;
        weight_source: string | null;
        rest_s: number | null;
        is_cardio: number;
        why_json: string | null;
        source: string;
      }>;
      return {
        id: Number(d.id),
        datestr: d.datestr,
        dow: Number(d.dow),
        ord: Number(d.ord),
        day_type: d.day_type,
        title: d.title,
        target_muscles: d.target_muscles_json ? (JSON.parse(d.target_muscles_json) as string[]) : [],
        est_duration_min: d.est_duration_min === null ? null : Number(d.est_duration_min),
        why: d.why_json ? (JSON.parse(d.why_json) as PlanDetail['days'][number]['why']) : null,
        exercises: exRows.map((e) => ({
          id: Number(e.id),
          ord: Number(e.ord),
          catalog_id: e.catalog_id === null ? null : Number(e.catalog_id),
          name: e.name,
          sets: Number(e.sets),
          reps: e.reps === null ? null : Number(e.reps),
          weight_kg: e.weight_kg === null ? null : Number(e.weight_kg),
          weight_source: e.weight_source,
          rest_s: e.rest_s === null ? null : Number(e.rest_s),
          is_cardio: Number(e.is_cardio) === 1,
          why: e.why_json ? (JSON.parse(e.why_json) as string) : '',
          source: e.source,
        })),
      };
    }),
  };
}

/**
 * 某个**计划周**的那一份计划 id（排除 archived）；同周多行取 id 最大。
 *
 * 🔴 为什么不是「最新一份计划」：首页整页讲的是**下一周**，确认页导入的也是下一周那份。
 *    按「最新一份」取的话，用户隔一周没生成时端上来的会是上一周那份 ——
 *    卡片标题写着「下周计划 · <上周日期>」，而且「重新生成」是按下一周排的，
 *    看到的和会改的差一周。（单版本覆盖后同周只有一行，`id DESC` 只是历史数据兜底。）
 */
export function getPlanIdForWeek(db: Db, weekStart: string): number | null {
  const row = prepare(
    db,
    `SELECT id FROM plan WHERE week_start = ? AND status != 'archived' ORDER BY id DESC LIMIT 1`,
  ).get(weekStart) as unknown as { id: number } | undefined;
  return row ? Number(row.id) : null;
}

// ---------------------------------------------------------------------------
// 生成 / 降级 / 调整 / 编辑
// ---------------------------------------------------------------------------

/**
 * 模板路径写入前的重量覆盖（docs/plan-template-reuse.md §8）。
 *
 * 为什么必须覆盖：模板里的 `weight_kg` 是**上一周**的数字，而 AI 也可能「看着差不多」自己写一个。
 * 两者都可能过时（减量周要 −10%、上周没达成要回退），而 `progression.suggest_kg` 是本地
 * 按「历史趋势 + 上周计划 vs 实际」现算的**唯一权威值**。这里直接以它为准，不采信任何一方的数字。
 *
 * 放在校验**之后**：V2 已经用它当基准做过 ±10% 钳制，这里只负责把剩下的偏差归零。
 */
function applySuggestedWeights(draft: PlanDraft, pool: PlanInputDigest['candidate_pool']): PlanDraft {
  const suggestById = new Map(pool.map((m) => [m.catalog_id, m.progression.suggest_kg]));
  return {
    ...draft,
    days: draft.days.map((d) => ({
      ...d,
      exercises: d.exercises.map((e) => {
        const suggest = suggestById.get(e.catalog_id);
        // 动作不在池里（理论上已被 V1 拦掉）→ 不碰，交给后续流程
        if (suggest === undefined) return e;
        if (suggest === null) return { ...e, weight_kg: null, weight_source: 'estimate' as const };
        return { ...e, weight_kg: suggest, weight_source: 'history_best' as const };
      }),
    })),
  };
}

export interface CreatePlanOptions {
  weekStart?: string;
  /**
   * `'auto'`（默认）= 周期第 2~4 周且上一周有计划 → 沿用模板；
   * `'full'` = 用户显式要求重新全量生成（跳过模板，任何情况下都走完整摘要层）。
   */
  mode?: 'auto' | 'full';
}

export interface CreatePlanResult {
  planId: number;
  result: PlanGenerationResult;
  detail: PlanDetail;
  /** 本次沿用的模板来源周次（1~4）；null = 全量生成。 */
  templateWeekNo: number | null;
}

/** AI 生成一周计划草稿（accept 或规则模板降级，两者都会落库）。 */
export async function createPlanFromAi(
  db: Db,
  gw: AiGateway,
  aiModelTag: string,
  opts: CreatePlanOptions,
): Promise<CreatePlanResult> {
  if (!hasTrainingData(db)) throw new PlanServiceError(400, '暂无训练数据 —— 先同步训记或导入历史数据，再排计划');
  // 现算：永远新鲜，重量递增不断档（不再吃库里的报告快照 —— 那会让重量基准定格在几周前）
  const { report } = runAnalysis(db, { persist: false });

  const weekStart = opts.weekStart ?? currentPlanningWeekStart(db);
  // 训练基础（几次/多久/哪几天）取设置页当前值，而不是报告生成时的冻结值 ——
  // 否则用户改完设置必须等下一次刷新报告才生效（PRD-v2 V1）。
  const constraints = withLiveGoal(db, report.constraints);
  const cycle = cycleContextFor(db, weekStart);

  // ------------------------------------------------------------------
  // 模板复用分叉（2026-09-30「周期内同一个模板」）
  //
  // `templateFor` 自己处理全部「不该沿用」的情况并返回 null（不在周期内 / 第 1 周 /
  // 上一周没计划或计划被归档 / 上一周没有力量动作）—— 一律回落全量生成，不报错。
  // `mode='full'` 是首页「重新全量生成」：用户显式否决模板，连取都不取。
  // ------------------------------------------------------------------
  const rawTemplate = opts.mode === 'full' ? null : templateFor(db, weekStart);
  const built =
    rawTemplate === null
      ? null
      : buildTemplateDigest(db, {
          report,
          constraints: { goal: constraints.goal, hard_rules: constraints.hard_rules },
          weekStart,
          cycle,
          template: rawTemplate,
        });
  // V3：AI 吃摘要层，不吃整份报告（66.5 KB → ~11 KB；模板路径再降到 ~6 KB）
  const digest =
    built?.digest ??
    buildPlanDigest(db, {
      report,
      constraints: { goal: constraints.goal, hard_rules: constraints.hard_rules },
      weekStart,
      cycle,
    });
  const result = await gw.generatePlan(built ? { digest, template: built.template } : { digest });

  // 沿用的模板来源周次（全量生成与「模板缺失回落」都是 null）
  const templateWeekNo = built?.template.source_week_no ?? null;

  let draft: PlanDraft;
  let summary: PlanSummary;
  let warnings: Array<Record<string, unknown>>;
  let source: PersistOptions['source'];
  let aiModelTagUsed: string;
  if (result.status === 'accepted') {
    draft = built ? applySuggestedWeights(result.draft, digest.candidate_pool) : result.draft;
    // 模板路径改了重量，summary 重算一次（重量不进 summary，但「重算一次」比「论证它没变」便宜）
    summary = built ? buildSummary(db, draft) : result.summary;
    warnings = result.warnings.map((w) => ({ ...w }));
    source = 'ai';
    aiModelTagUsed = aiModelTag;
  } else {
    // 降级：有模板就机械平移模板（至少保住用户上周挑好的动作），否则退回规则模板
    draft = built
      ? buildDraftFromCycleTemplate(weekStart, built.template, constraints)
      : buildTemplateDraft(weekStart, digest.candidate_pool, constraints, cycle, todayLocal());
    summary = buildSummary(db, draft);
    warnings = [];
    source = 'rule_fallback';
    aiModelTagUsed = 'rule_fallback';
  }

  const planId = persistDraft(db, {
    weekStart,
    draft,
    summary,
    source,
    aiModelTag: aiModelTagUsed,
    warnings,
    attempts: result.attempts,
    // 「这份计划是在哪个画像版本下做的」—— 优先记**快照版本**（用户可见的画像），
    // 没有快照（尚未建立画像）才退回任意最新报告；两者都没有 → null。
    reportId: latestSnapshot(db)?.meta.report_id ?? latestReportSnapshot(db)?.reportId ?? null,
    goalId: activeGoalId(db),
    templateWeekNo,
  });
  const tmplNote = templateWeekNo === null ? '' : `，沿用周期第 ${templateWeekNo} 周模板`;
  logEdit(db, {
    plan_id: planId,
    actor: 'system',
    action: 'create',
    target_type: 'plan',
    instruction:
      result.status === 'accepted'
        ? `AI 生成${tmplNote}（尝试 ${result.attempts} 次）`
        : `AI 生成未通过校验，降级${built ? '模板平移' : '规则模板'}${tmplNote}（${result.reason}，尝试 ${result.attempts} 次）`,
  });
  return { planId, result, detail: getPlanDetail(db, planId), templateWeekNo };
}

/**
 * 用户手动点「用规则模板生成」或重试兜底。
 *
 * ⚠️ 这里**故意不走模板复用**：这个入口的语义是「给我一份确定性的、从白名单里挑的规则模板」，
 *    与「沿用我上周那份」是两件事。要沿用上周就点「生成计划」（mode='auto'）。
 */
export function regenerateTemplate(db: Db, opts: { weekStart?: string }): PlanDetail {
  if (!hasTrainingData(db)) throw new PlanServiceError(400, '暂无训练数据 —— 先同步训记或导入历史数据，再排计划');
  // 现算：与 createPlanFromAi 同源，保证候选池/趋势判断不吃几周前的快照
  const { report } = runAnalysis(db, { persist: false });
  const weekStart = opts.weekStart ?? currentPlanningWeekStart(db);
  const constraints = withLiveGoal(db, report.constraints);
  const cycle = cycleContextFor(db, weekStart);
  // 与 AI 路径共用同一份精选候选池：降级不该变成「从 254 个动作里瞎挑」
  const pool = buildPlanDigest(db, {
    report,
    constraints: { goal: constraints.goal, hard_rules: constraints.hard_rules },
    weekStart,
    cycle,
  }).candidate_pool;
  const draft = buildTemplateDraft(weekStart, pool, constraints, cycle, todayLocal());
  const summary = buildSummary(db, draft);
  const planId = persistDraft(db, {
    weekStart,
    draft,
    summary,
    source: 'rule_fallback',
    aiModelTag: 'rule_fallback',
    warnings: [],
    attempts: 0,
    reportId: latestSnapshot(db)?.meta.report_id ?? latestReportSnapshot(db)?.reportId ?? null,
    goalId: activeGoalId(db),
    templateWeekNo: null,
  });
  logEdit(db, { plan_id: planId, actor: 'system', action: 'regenerate', target_type: 'plan', instruction: '手动触发规则模板生成' });
  return getPlanDetail(db, planId);
}

export interface ExercisePatch {
  name?: string;
  catalog_id?: number | null;
  sets?: number;
  reps?: number | null;
  weight_kg?: number | null;
  rest_s?: number | null;
}

const PATCH_LIMITS = {
  sets: [1, 20],
  reps: [1, 100],
  rest_s: [0, 600],
} as const;

function assertNum(field: string, v: unknown, min: number, max: number): number {
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max) {
    throw new PlanServiceError(400, `${field} 需为 ${min}~${max} 的数字`);
  }
  return n;
}

/**
 * 编辑后重估每日时长（与规则模板同公式：10 + 总组数×3，夹在 goal 区间）。
 * 不重算的话冲突检查会拿生成时的旧时长做判断，编辑减组后时长告警失真。
 */
function recalcDayEstimates(db: Db, planId: number, draft: PlanDraft, goal: { min_duration_min: number; max_duration_min: number } | null): PlanDraft {
  if (!goal) return draft;
  const days = draft.days.map((d) => {
    const totalSets = d.exercises.reduce((s, e) => s + e.sets, 0);
    const est = Math.max(goal.min_duration_min, Math.min(goal.max_duration_min, 10 + totalSets * 3));
    prepare(db, `UPDATE plan_day SET est_duration_min = ? WHERE plan_id = ? AND datestr = ?`).run(est, planId, d.datestr);
    return { ...d, est_duration_min: est };
  });
  return { ...draft, days };
}

/** 手动编辑单个动作 → editLog(user) → 重估时长 → 更新 summary_json。 */
export function updateExercise(db: Db, planId: number, exerciseId: number, patch: ExercisePatch): PlanDetail {
  const row = getPlanRow(db, planId);
  if (row.status !== 'draft') throw new PlanServiceError(409, `计划状态为「${row.status}」，只有草稿可以编辑`);
  const ex = prepare(
    db,
    `SELECT pe.* FROM plan_exercise pe JOIN plan_day pd ON pd.id = pe.plan_day_id
     WHERE pe.id = ? AND pd.plan_id = ?`,
  ).get(exerciseId, planId) as unknown as
    | { id: number; name: string; catalog_id: number | null; sets: number; reps: number | null; weight_kg: number | null; rest_s: number | null }
    | undefined;
  if (!ex) throw new PlanServiceError(404, `动作 #${exerciseId} 不存在（或不属于计划 #${planId}）`);

  const sets: string[] = [];
  const vals: Array<string | number | null> = [];
  if (patch.name !== undefined) {
    const name = String(patch.name).trim();
    if (name === '') throw new PlanServiceError(400, '动作名不能为空');
    sets.push('name = ?');
    vals.push(name);
  }
  if (patch.catalog_id !== undefined) {
    sets.push('catalog_id = ?');
    vals.push(patch.catalog_id === null ? null : assertNum('catalog_id', patch.catalog_id, 1, 10_000_000));
  }
  if (patch.sets !== undefined) {
    sets.push('sets = ?');
    vals.push(assertNum('sets', patch.sets, PATCH_LIMITS.sets[0], PATCH_LIMITS.sets[1]));
  }
  if (patch.reps !== undefined) {
    sets.push('reps = ?');
    vals.push(patch.reps === null ? null : assertNum('reps', patch.reps, PATCH_LIMITS.reps[0], PATCH_LIMITS.reps[1]));
  }
  if (patch.weight_kg !== undefined) {
    sets.push('weight_kg = ?');
    vals.push(patch.weight_kg === null ? null : assertNum('weight_kg', patch.weight_kg, 0, 1000));
    // 重量被手动改过 → 来源改标 user_input（清空则来源一并清空）
    sets.push('weight_source = ?');
    vals.push(patch.weight_kg === null ? null : 'user_input');
  }
  if (patch.rest_s !== undefined) {
    sets.push('rest_s = ?');
    vals.push(patch.rest_s === null ? null : assertNum('rest_s', patch.rest_s, PATCH_LIMITS.rest_s[0], PATCH_LIMITS.rest_s[1]));
  }
  if (sets.length === 0) throw new PlanServiceError(400, '没有可更新的字段');
  prepare(db, `UPDATE plan_exercise SET ${sets.join(', ')} WHERE id = ?`).run(...vals, exerciseId);

  logEdit(db, {
    plan_id: planId,
    actor: 'user',
    action: 'update',
    target_type: 'exercise',
    target_id: exerciseId,
    field: sets.map((s) => s.replace(' = ?', '')).join(','),
    before: { name: ex.name, sets: ex.sets, reps: ex.reps, weight_kg: ex.weight_kg, rest_s: ex.rest_s },
    after: patch,
  });

  const draftRaw = rebuildDraftFromDb(db, planId);
  const constraints = constraintsForPlan(db, row);
  const draft = recalcDayEstimates(db, planId, draftRaw, constraints.goal);
  const summary = buildSummary(db, draft);
  prepare(db, `UPDATE plan SET summary_json = ?, updated_at = ? WHERE id = ?`).run(
    JSON.stringify(summary),
    new Date().toISOString(),
    planId,
  );

  return getPlanDetail(db, planId);
}

/**
 * 把整个训练日挪到另一天（V7）。
 *
 * 语义要点：
 *  - 日期是训练日的「位置」，`ord` 是它在计划里的显示顺序。两者都要动 —— 只改 datestr
 *    会留下「周一那天 ord=3、周五那天 ord=1」这种顺序错乱，详情页看起来就是乱的。
 *    （`plan_day` 的唯一约束只有 `(plan_id, datestr)`，`ord` 可以自由重排。）
 *  - 目标日已被占用时**交换**两个训练日，而不是报错。一周 3 练最常见的操作是
 *    「周三有事，和周五换一下」—— 只允许移到空日的话用户得挪两次。
 *  - 交换要走「中间态日期」，否则第二次 UPDATE 会撞 `UNIQUE(plan_id, datestr)`。
 *
 * 不做的事：不动动作内容、不重算 est_duration_min（组数没变，时长公式只吃组数）。
 * summary 仍然重算一次，保证 `plan.summary_json` 与库里的真实分布一致。
 */
export function movePlanDay(db: Db, planId: number, dayId: number, targetDatestr: string): PlanDetail {
  const row = getPlanRow(db, planId);
  if (row.status !== 'draft') throw new PlanServiceError(409, `计划状态为「${row.status}」，只有草稿可以调整训练日`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(targetDatestr)) {
    throw new PlanServiceError(400, '目标日期需为 YYYY-MM-DD');
  }
  if (targetDatestr < row.week_start || targetDatestr > row.week_end) {
    throw new PlanServiceError(400, `目标日期 ${targetDatestr} 不在计划周 ${row.week_start}~${row.week_end} 内`);
  }
  const day = prepare(db, `SELECT id, datestr FROM plan_day WHERE id = ? AND plan_id = ?`).get(dayId, planId) as unknown as
    | { id: number; datestr: string }
    | undefined;
  if (!day) throw new PlanServiceError(404, `训练日 #${dayId} 不存在（或不属于计划 #${planId}）`);
  if (day.datestr === targetDatestr) return getPlanDetail(db, planId);

  db.exec('BEGIN');
  try {
    const occupant = prepare(db, `SELECT id FROM plan_day WHERE plan_id = ? AND datestr = ?`).get(planId, targetDatestr) as
      | { id: number }
      | undefined;
    const swapped = occupant !== undefined;
    if (swapped) {
      // 三步走：A → 中间态；B → A 原来的日期；A → 目标日期
      prepare(db, `UPDATE plan_day SET datestr = ? WHERE id = ?`).run(SWAP_TEMP_DATE, dayId);
      prepare(db, `UPDATE plan_day SET datestr = ?, dow = ? WHERE id = ?`).run(
        day.datestr,
        dowOf(day.datestr),
        Number(occupant.id),
      );
      prepare(db, `UPDATE plan_day SET datestr = ?, dow = ? WHERE id = ?`).run(targetDatestr, dowOf(targetDatestr), dayId);
    } else {
      prepare(db, `UPDATE plan_day SET datestr = ?, dow = ? WHERE id = ?`).run(targetDatestr, dowOf(targetDatestr), dayId);
    }

    // ord 按日期整体重排（1..n）
    const dayRows = prepare(db, `SELECT id FROM plan_day WHERE plan_id = ? ORDER BY datestr`).all(planId) as unknown as Array<{
      id: number;
    }>;
    dayRows.forEach((d, i) => prepare(db, `UPDATE plan_day SET ord = ? WHERE id = ?`).run(i + 1, Number(d.id)));

    logEdit(db, {
      plan_id: planId,
      actor: 'user',
      action: 'update',
      target_type: 'day',
      target_id: dayId,
      field: 'datestr',
      before: { datestr: day.datestr },
      after: { datestr: targetDatestr, swapped },
    });

    const draftRaw = rebuildDraftFromDb(db, planId);
    const constraints = constraintsForPlan(db, row);
    const draft = recalcDayEstimates(db, planId, draftRaw, constraints.goal);
    const summary = buildSummary(db, draft);
    prepare(db, `UPDATE plan SET summary_json = ?, updated_at = ? WHERE id = ?`).run(
      JSON.stringify(summary),
      new Date().toISOString(),
      planId,
    );
    const detail = getPlanDetail(db, planId);
    db.exec('COMMIT');
    return detail;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

/** 交换两天时的中间态日期：不可能是任何真实计划周内的日期（周起点最早也是 2000 年之后）。 */
const SWAP_TEMP_DATE = '0001-01-01';

/** 手动删除动作 → editLog(user, delete)。整体事务化：不留半态。 */
export function deleteExercise(db: Db, planId: number, exerciseId: number): PlanDetail {
  const row = getPlanRow(db, planId);
  if (row.status !== 'draft') throw new PlanServiceError(409, `计划状态为「${row.status}」，只有草稿可以编辑`);
  const ex = prepare(
    db,
    `SELECT pe.* FROM plan_exercise pe JOIN plan_day pd ON pd.id = pe.plan_day_id
     WHERE pe.id = ? AND pd.plan_id = ?`,
  ).get(exerciseId, planId) as unknown as Record<string, unknown> | undefined;
  if (!ex) throw new PlanServiceError(404, `动作 #${exerciseId} 不存在（或不属于计划 #${planId}）`);

  db.exec('BEGIN');
  try {
    prepare(db, `DELETE FROM plan_exercise WHERE id = ?`).run(exerciseId);

    // 每天独立重排 1..n（ord 语义是「天内顺序」；UNIQUE(plan_day_id, ord) 用两段式避开换位冲突）
    const dayRows = prepare(db, `SELECT id FROM plan_day WHERE plan_id = ? ORDER BY ord`).all(planId) as unknown as Array<{
      id: number;
    }>;
    for (const d of dayRows) {
      const rows = prepare(db, `SELECT id FROM plan_exercise WHERE plan_day_id = ? ORDER BY ord`).all(
        Number(d.id),
      ) as unknown as Array<{ id: number }>;
      rows.forEach((r, i) => prepare(db, `UPDATE plan_exercise SET ord = ? WHERE id = ?`).run(-(i + 1), Number(r.id)));
      rows.forEach((r, i) => prepare(db, `UPDATE plan_exercise SET ord = ? WHERE id = ?`).run(i + 1, Number(r.id)));
    }

    logEdit(db, {
      plan_id: planId,
      actor: 'user',
      action: 'delete',
      target_type: 'exercise',
      target_id: exerciseId,
      before: ex,
    });

    const draftRaw = rebuildDraftFromDb(db, planId);
    const constraints = constraintsForPlan(db, row);
    const draft = recalcDayEstimates(db, planId, draftRaw, constraints.goal);
    const summary = buildSummary(db, draft);
    prepare(db, `UPDATE plan SET summary_json = ?, updated_at = ? WHERE id = ?`).run(
      JSON.stringify(summary),
      new Date().toISOString(),
      planId,
    );
    const detail = getPlanDetail(db, planId);
    db.exec('COMMIT');
    return detail;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}
