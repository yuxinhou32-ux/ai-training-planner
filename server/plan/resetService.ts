/**
 * 计划重置服务（2026-10-05 用户定案）。
 *
 * 用户原话：「我觉得可以添加一个清空功能（我后面正常使用可能不会长期使用这个功能，
 * 但现在在测试阶段还是很有必要的。就是清空这个项目里的所有关于本次生成的计划的内容——
 * 周期我没改的话可以不用清空，但如果我选择解锁清空需要保证真的清空，不要出现两条周期目标在后台）」
 *
 * 边界（🔴 用户明确划线）：
 *   - **只删「本次生成的计划」**：plan 及其级联（plan_day / plan_exercise / plan_edit_log /
 *     sync_write_job 级联 / write_batch / write_item）、weekly_review。
 *   - **绝不动**：`user_goal`（用户的长期训练基础设置）、`training_cycle`（除非显式勾选）、
 *     同步来的训练数据（train_session / session_movement / movement_set）、
 *     分析报告（analysis_report，它来自真实训练数据不是本次计划）、
 *     `week_note` / `daily_note` / `weight_log` / `body_info`（用户自己写的东西）。
 *   - **不做快照备份**（用户明确：「我觉得这个功能本身不需要做快照备份的处理，
 *     因为我们只是删除本次的计划而已，用户可以重新生成」）。
 *
 * 🔴 「两条周期目标在后台」这个坑的根因：`training_cycle` 有 `UNIQUE(first_week_start)`，
 *    旧周期不删的话，如果它处于 `active` 就永远挡着新周期 —— 而界面上不显示，
 *    表现就是「解锁了却开不了新周期」。所以勾选清周期时**必须连旧周期一起删干净**
 *    （而不是只 close），否则下次开周期撞唯一约束或 `getActiveCycle` 拿到旧的那条。
 */
import type { Db } from '../db/index.js';
import { prepare } from '../db/index.js';

/** 一次重置影响的表 → 删除行数。返回给前端做「真的删了」的证据。 */
export interface ResetPlanResult {
  /** 删掉的 plan 行数（含历次版本） */
  plans: number;
  plan_days: number;
  plan_exercises: number;
  plan_edit_logs: number;
  /** sync_write_job 及其级联的 write_batch / write_item */
  write_jobs: number;
  write_batches: number;
  write_items: number;
  weekly_reviews: number;
  /** 勾选了清周期时才有：清掉的 training_cycle 行数 */
  cycles: number;
  /** 是否连周期一起清了（回显给前端确认） */
  cleared_cycle: boolean;
}

interface CountRow {
  n: number;
}

function countOf(db: Db, sql: string): number {
  const row = prepare(db, sql).get() as unknown as CountRow | undefined;
  return row ? Number(row.n) : 0;
}

/**
 * 清空「本次生成的计划」。
 *
 * @param opts.clearCycle 是否连训练周期一起清（用户勾选；默认 false = 保留周期）
 *
 * 全部在一个事务里做 —— 中途失败不能留下「计划删了但周期还在」的半截状态。
 * 删除顺序**从叶子往根**：外键有 ON DELETE CASCADE，但显式按序删能拿到每张表的行数
 * （用于回显），也避免不同 SQLite 版本对 CASCADE 深度处理不一致。
 */
export function resetPlans(db: Db, opts: { clearCycle: boolean }): ResetPlanResult {
  const clearCycle = opts.clearCycle === true;

  // 先数（删完就数不到了）
  const plans = countOf(db, `SELECT COUNT(*) AS n FROM plan`);
  const plan_days = countOf(db, `SELECT COUNT(*) AS n FROM plan_day`);
  const plan_exercises = countOf(db, `SELECT COUNT(*) AS n FROM plan_exercise`);
  const plan_edit_logs = countOf(db, `SELECT COUNT(*) AS n FROM plan_edit_log`);
  const write_jobs = countOf(db, `SELECT COUNT(*) AS n FROM sync_write_job`);
  const write_batches = countOf(db, `SELECT COUNT(*) AS n FROM write_batch`);
  const write_items = countOf(db, `SELECT COUNT(*) AS n FROM write_item`);
  const weekly_reviews = countOf(db, `SELECT COUNT(*) AS n FROM weekly_review`);
  const cycles = clearCycle ? countOf(db, `SELECT COUNT(*) AS n FROM training_cycle`) : 0;

  db.exec('BEGIN IMMEDIATE');
  try {
    // ---- 写回链路（叶子 → 根）----
    prepare(db, `DELETE FROM write_item`).run();
    prepare(db, `DELETE FROM write_batch`).run();
    prepare(db, `DELETE FROM sync_write_job`).run();

    // ---- 计划本体（plan_exercise → plan_day → plan_edit_log → plan）----
    prepare(db, `DELETE FROM plan_exercise`).run();
    prepare(db, `DELETE FROM plan_day`).run();
    prepare(db, `DELETE FROM plan_edit_log`).run();
    // plan.parent_plan_id 是 `ON DELETE SET NULL` 自引用：一次性全删没有先后问题，
    // 但显式先清父指针更稳（避免删除中途某行还指着同批被删的行）。
    prepare(db, `UPDATE plan SET parent_plan_id = NULL`).run();
    prepare(db, `DELETE FROM plan`).run();

    // ---- 周复盘（基于计划的实际执行结果，计划没了它就失去意义）----
    prepare(db, `DELETE FROM weekly_review`).run();

    // ---- 周期（只在勾选时清）----
    if (clearCycle) {
      prepare(db, `DELETE FROM training_cycle`).run();
    }

    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }

  return {
    plans,
    plan_days,
    plan_exercises,
    plan_edit_logs,
    write_jobs,
    write_batches,
    write_items,
    weekly_reviews,
    cycles,
    cleared_cycle: clearCycle,
  };
}

/** 重置前的「有什么可删」预览 —— 让用户在确认框里看到具体会删掉多少。 */
export interface ResetPreview {
  plans: number;
  plan_days: number;
  plan_exercises: number;
  write_jobs: number;
  weekly_reviews: number;
  cycles: number;
  /** 受保护的、**不会被删**的东西 —— 明写在界面上，避免用户担心训练记录被一起清掉 */
  protected: {
    training_sessions: number;
    training_sets: number;
    active_goals: number;
    daily_notes: number;
    week_notes: number;
    weight_logs: number;
  };
}

export function previewReset(db: Db): ResetPreview {
  return {
    plans: countOf(db, `SELECT COUNT(*) AS n FROM plan`),
    plan_days: countOf(db, `SELECT COUNT(*) AS n FROM plan_day`),
    plan_exercises: countOf(db, `SELECT COUNT(*) AS n FROM plan_exercise`),
    write_jobs: countOf(db, `SELECT COUNT(*) AS n FROM sync_write_job`),
    weekly_reviews: countOf(db, `SELECT COUNT(*) AS n FROM weekly_review`),
    cycles: countOf(db, `SELECT COUNT(*) AS n FROM training_cycle`),
    protected: {
      training_sessions: countOf(db, `SELECT COUNT(*) AS n FROM train_session`),
      training_sets: countOf(db, `SELECT COUNT(*) AS n FROM movement_set`),
      active_goals: countOf(db, `SELECT COUNT(*) AS n FROM user_goal WHERE is_active = 1`),
      daily_notes: countOf(db, `SELECT COUNT(*) AS n FROM daily_note`),
      week_notes: countOf(db, `SELECT COUNT(*) AS n FROM week_note`),
      weight_logs: countOf(db, `SELECT COUNT(*) AS n FROM weight_log`),
    },
  };
}
