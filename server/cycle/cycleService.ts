/**
 * 训练周期服务（PRD-v2 §5 / V2）。
 *
 * 周期 = **4 周**（3 周渐进 + 第 4 周减量）。开周期时填一个**周期目标**（如「着重练胸」），
 * 周期内**锁定不可改** —— 用户明确「防止频繁改目标等于没目标」，唯一入口是设置页的
 * 「强行修改」（会留 `force_edited_at` 痕）。
 *
 * 🔴 优先级：**周期目标 ＞ 长期目标**（`user_goal.goal_type`）。两者不冲突：
 *   长期目标是背景方向（减脂保肌），周期目标是这 4 周的焦点（着重练胸）。
 *
 * 🔴 周次不落库：`weekNo = (week_start - first_week_start) / 7 + 1`，现算。
 *   落冗余列的话，周期一重开就会错。
 */
import type { Db } from '../db/index.js';
import { prepare, inTransaction } from '../db/index.js';
import { todayStr } from '../util/dates.js';
import { ensureTakeover } from '../review/takeover.js';

/** 周期长度（周）。PRD §5：3 周渐进 + 第 4 周减量。 */
export const CYCLE_WEEKS = 4;

export class CycleServiceError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = 'CycleServiceError';
  }
}

export interface CycleRow {
  id: number;
  cycleNo: number;
  firstWeekStart: string;
  lastWeekStart: string;
  goalText: string;
  status: 'active' | 'closed';
  forceEditedAt: string | null;
  createdAt: string;
  closedAt: string | null;
}

/** 当前周期状态：周期本身 + 今天/本周处于第几周。 */
export interface CycleStatus {
  cycle: CycleRow | null;
  /** 计划周（week_start）在周期内的第几周（1~4）；不在周期内 = null */
  weekNo: number | null;
  /** 该周是否为减量周（第 4 周） */
  isDeload: boolean;
  /** 周期已跑完全部 4 周（需要开新周期） */
  expired: boolean;
}

interface DbRow {
  id: number;
  cycle_no: number;
  first_week_start: string;
  last_week_start: string;
  goal_text: string;
  status: string;
  force_edited_at: string | null;
  created_at: string;
  closed_at: string | null;
}

function addDays(datestr: string, n: number): string {
  const d = new Date(`${datestr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function rowToCycle(r: DbRow): CycleRow {
  return {
    id: Number(r.id),
    cycleNo: Number(r.cycle_no),
    firstWeekStart: r.first_week_start,
    lastWeekStart: r.last_week_start,
    goalText: r.goal_text,
    status: r.status === 'closed' ? 'closed' : 'active',
    forceEditedAt: r.force_edited_at,
    createdAt: r.created_at,
    closedAt: r.closed_at,
  };
}

const SELECT_COLS = `id, cycle_no, first_week_start, last_week_start, goal_text, status,
                     force_edited_at, created_at, closed_at`;

/** 当前活动周期（没有则 null）。 */
export function getActiveCycle(db: Db): CycleRow | null {
  const r = prepare(
    db,
    `SELECT ${SELECT_COLS} FROM training_cycle WHERE status = 'active'
     ORDER BY first_week_start DESC, id DESC LIMIT 1`,
  ).get() as unknown as DbRow | undefined;
  return r ? rowToCycle(r) : null;
}

/**
 * 某计划周在周期内的周次（1~4）；不在周期范围内返回 null。
 * 只认**整周对齐**：week_start 与 first_week_start 相差必须是 7 的整数倍。
 */
export function weekNoOf(cycle: CycleRow, weekStart: string): number | null {
  const ms = Date.parse(`${weekStart}T00:00:00Z`) - Date.parse(`${cycle.firstWeekStart}T00:00:00Z`);
  if (!Number.isFinite(ms) || ms < 0) return null;
  const days = Math.round(ms / 86_400_000);
  if (days % 7 !== 0) return null;
  const n = days / 7 + 1;
  return n >= 1 && n <= CYCLE_WEEKS ? n : null;
}

export function isDeloadWeek(cycle: CycleRow, weekStart: string): boolean {
  return weekNoOf(cycle, weekStart) === CYCLE_WEEKS;
}

/** 给定计划周 → 周期上下文（供排计划与首页展示共用）。 */
export function cycleStatusFor(db: Db, weekStart: string): CycleStatus {
  const cycle = getActiveCycle(db);
  if (!cycle) return { cycle: null, weekNo: null, isDeload: false, expired: false };
  const weekNo = weekNoOf(cycle, weekStart);
  return {
    cycle,
    weekNo,
    isDeload: weekNo === CYCLE_WEEKS,
    // 计划周已越过周期最后一周 → 这个周期跑完了
    expired: weekStart > cycle.lastWeekStart,
  };
}

/** 今天所在的计划周起点（按一周起始日）——仅用于「周期是否跑完」的判断。 */
export function currentWeekStart(today: string, weekStartDow: number): string {
  const dow = new Date(`${today}T00:00:00Z`).getUTCDay();
  const start = weekStartDow === 0 ? 0 : 1;
  const back = (dow - start + 7) % 7;
  return addDays(today, -back);
}

function assertGoalText(raw: unknown): string {
  const t = typeof raw === 'string' ? raw.trim() : '';
  if (t === '') throw new CycleServiceError(400, '周期目标不能为空');
  if (t.length > 60) throw new CycleServiceError(400, '周期目标最多 60 个字');
  return t;
}

/**
 * 开一个新周期：关闭已跑完/遗留的活动周期 → 插入新周期（第 1 周 = 给定周起点）。
 * 周期内 4 周的 week_start 由 weekStartDow 决定，所以调用方必须传入**对齐过的**周起点。
 */
export function openCycle(
  db: Db,
  raw: { goal_text?: unknown; first_week_start?: unknown },
  now: Date = new Date(),
): CycleRow {
  const goalText = assertGoalText(raw.goal_text);
  const firstWeekStart =
    typeof raw.first_week_start === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw.first_week_start)
      ? raw.first_week_start
      : null;
  if (!firstWeekStart) throw new CycleServiceError(400, '缺少开始周（first_week_start 需为 YYYY-MM-DD）');

  const existing = getActiveCycle(db);
  if (existing) {
    throw new CycleServiceError(409, `已有进行中的周期（第 ${existing.firstWeekStart} 周起，目标「${existing.goalText}」）—— 请先结束它`);
  }

  const ts = now.toISOString();
  const lastWeekStart = addDays(firstWeekStart, (CYCLE_WEEKS - 1) * 7);
  const maxNo = prepare(db, `SELECT MAX(cycle_no) AS n FROM training_cycle`).get() as unknown as { n: number | null };
  const cycleNo = Number(maxNo.n ?? 0) + 1;

  inTransaction(db, () => {
    // 🔴 接管起点（第一个由本软件规划的训练周）在这里落碑 —— 必须**先于**周期行插入：
    //    ensureTakeover 只在「尚无接管记录」时写入，而它的 derived 回退是
    //    `MIN(training_cycle.first_week_start)`；若先插入本周期的行，回退就会读到它，
    //    「尚未接管」的前置条件不成立、真碑永远立不起来。两者同事务，原子生效。
    ensureTakeover(db, firstWeekStart, now.getTime());
    prepare(
      db,
      `INSERT INTO training_cycle (cycle_no, first_week_start, last_week_start, goal_text, status, created_at)
       VALUES (?, ?, ?, ?, 'active', ?)`,
    ).run(cycleNo, firstWeekStart, lastWeekStart, goalText, ts);
  });

  const created = getActiveCycle(db);
  if (!created) throw new CycleServiceError(500, '开周期后未能读回周期');
  return created;
}

/**
 * 「强行修改」周期目标 —— 唯一允许改周期目标的入口（PRD §5：默认不用）。
 * 只改文案，不动周期起止与周次（改了周次等于重开周期，语义不同）。
 */
export function forceEditCycleGoal(db: Db, raw: { goal_text?: unknown }, now: Date = new Date()): CycleRow {
  const goalText = assertGoalText(raw.goal_text);
  const cycle = getActiveCycle(db);
  if (!cycle) throw new CycleServiceError(404, '当前没有进行中的周期');
  prepare(db, `UPDATE training_cycle SET goal_text = ?, force_edited_at = ? WHERE id = ?`).run(
    goalText,
    now.toISOString(),
    cycle.id,
  );
  const updated = getActiveCycle(db);
  if (!updated) throw new CycleServiceError(500, '修改后未能读回周期');
  return updated;
}

/** 结束当前周期（用户主动，或周期跑完后开新周期时自动调用）。 */
export function closeActiveCycle(db: Db, now: Date = new Date()): CycleRow | null {
  const cycle = getActiveCycle(db);
  if (!cycle) return null;
  prepare(db, `UPDATE training_cycle SET status = 'closed', closed_at = ? WHERE id = ?`).run(now.toISOString(), cycle.id);
  return { ...cycle, status: 'closed', closedAt: now.toISOString() };
}

/** 周期是否已跑完全部 4 周（按「今天所在的周」判断）。 */
export function isCycleExpired(cycle: CycleRow, today: string, weekStartDow: number): boolean {
  return currentWeekStart(today, weekStartDow) > cycle.lastWeekStart;
}
