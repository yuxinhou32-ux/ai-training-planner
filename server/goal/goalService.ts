/**
 * 训练基础（user_goal）读写服务 —— PRD-v2 V1。
 *
 * 「训练日 / 每次时长 / 一周起始日 / 长期目标」是 AI 排计划的**常驻基准值**。
 * 本次是首次提供写入入口：此前只有 `analyze.ts --ensure-default-goal` 的 CLI 种子能写，
 * 而那一行的 notes 自己写着「可在 UI 修改」—— 这个 UI 从来没做过。
 *
 * 🔴 写入语义（重要）
 * `user_goal` 是**带 effective_from 的历史表**（有 idx_goal_active 索引，且
 * `plan.goal_id` 外键指向具体行）。所以「改设置」= **新增一行 + 旧行 is_active=0**，
 * 绝不 UPDATE 旧行 —— 这样历史计划仍指向它生成时的那个目标，语义正确。
 *
 * 🔴 sessions_per_week 由 preferred_dows 长度**推导**，不接受外部传入
 * （用户明确：「我选了几个训练日，你就能选几个一周几练」）。这样「4 次」与
 * 「偏好周一/三/五」这种自相矛盾在数据结构层面就不可能出现 —— 旧种子正是踩了这个坑。
 */
import type { Db } from '../db/index.js';
import { prepare, inTransaction } from '../db/index.js';
import { todayStr } from '../util/dates.js';

export class GoalServiceError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = 'GoalServiceError';
  }
}

/** 设置页要展示/编辑的完整训练基础。 */
export interface GoalSettings {
  id: number;
  goalType: string;
  /** 由 preferredDows.length 推导，只读 */
  sessionsPerWeek: number;
  minDurationMin: number;
  maxDurationMin: number;
  /** 0=周日 1=周一 */
  weekStartDow: number;
  /** 0=周日 … 6=周六 */
  preferredDows: number[];
  effectiveFrom: string;
}

/** PUT 入参：不含 sessions_per_week（推导得出）。 */
export interface GoalInput {
  goalType: string;
  minDurationMin: number;
  maxDurationMin: number;
  weekStartDow: number;
  preferredDows: number[];
}

const LIMITS = {
  minDuration: [10, 300] as const,
  maxDuration: [10, 600] as const,
  goalTypeMaxLen: 40,
  dows: [0, 6] as const,
};

interface GoalDbRow {
  id: number;
  goal_type: string;
  sessions_per_week: number;
  min_duration_min: number;
  max_duration_min: number;
  week_start_dow: number;
  preferred_dows: string | null;
  effective_from: string;
}

function parseDows(raw: string | null): number[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.map(Number).filter((n) => Number.isInteger(n));
  } catch {
    return [];
  }
}

/** `.env` 之外的第二个共享规则入口：一周几练 = 选中的训练日数量。 */
/**
 * 一周几练 = 选中的训练日数量（`dows` 为空时退回存储值）。
 *
 * 🔴 **这条规则只有一个来源**：写入（`validateGoalInput`）、设置页读取（`getGoalSettings`）、
 * 计划链路（`analysisService.loadGoal`）必须全部走这里。
 *
 * 为什么值得单独抽一个函数：这条规则曾被写了两份，后果是历史数据里
 * `sessions_per_week=4` 与 `preferred_dows=[1,3,5]` 并存，而**计划链路读的是存储值**，
 * 于是 AI 收到「必须排 4 天 + 偏好周一/三/五」这种自相矛盾的输入 —— 实测后果有两个：
 * ① 模板把第 4 天排到用户没选的周六；② AI 路径的第 4 天日期落回周起始日，
 * 与第 1 天撞 `plan_day(plan_id, datestr)` 唯一约束，生成计划直接 500。
 */
export function sessionsFromDows(dows: number[], fallback: number): number {
  return dows.length > 0 ? dows.length : fallback;
}

function rowToSettings(r: GoalDbRow): GoalSettings {
  const preferredDows = parseDows(r.preferred_dows);
  return {
    id: Number(r.id),
    goalType: r.goal_type,
    // 读取时按训练日归一，兜住历史行（只归一结果，不回写数据库）
    sessionsPerWeek: sessionsFromDows(preferredDows, Number(r.sessions_per_week)),
    minDurationMin: Number(r.min_duration_min),
    maxDurationMin: Number(r.max_duration_min),
    weekStartDow: Number(r.week_start_dow),
    preferredDows,
    effectiveFrom: r.effective_from,
  };
}

/** 当前生效的训练基础；没有任何激活目标时返回 null。 */
export function getGoalSettings(db: Db): GoalSettings | null {
  const r = prepare(
    db,
    `SELECT id, goal_type, sessions_per_week, min_duration_min, max_duration_min,
            week_start_dow, preferred_dows, effective_from
     FROM user_goal WHERE is_active = 1
     ORDER BY effective_from DESC, id DESC LIMIT 1`,
  ).get() as unknown as GoalDbRow | undefined;
  return r ? rowToSettings(r) : null;
}

function assertInt(name: string, v: unknown, lo: number, hi: number): number {
  const n = Number(v);
  if (!Number.isInteger(n)) throw new GoalServiceError(400, `${name} 需为整数`);
  if (n < lo || n > hi) throw new GoalServiceError(400, `${name} 需在 ${lo}~${hi} 之间`);
  return n;
}

/** 校验并规范化入参（导出供测试直接调用）。sessions_per_week 由 dows 长度推导。 */
export function validateGoalInput(raw: unknown): GoalInput & { sessionsPerWeek: number } {
  const src = (raw ?? {}) as Record<string, unknown>;

  const goalType = typeof src.goal_type === 'string' ? src.goal_type.trim() : '';
  if (goalType === '') throw new GoalServiceError(400, '长期目标不能为空');
  if (goalType.length > LIMITS.goalTypeMaxLen) {
    throw new GoalServiceError(400, `长期目标最多 ${LIMITS.goalTypeMaxLen} 个字`);
  }

  if (!Array.isArray(src.preferred_dows)) throw new GoalServiceError(400, '训练日需为数组');
  const dows = [...new Set(src.preferred_dows.map((d) => Number(d)))];
  if (dows.length === 0) throw new GoalServiceError(400, '至少要选一个训练日');
  for (const d of dows) {
    if (!Number.isInteger(d) || d < LIMITS.dows[0] || d > LIMITS.dows[1]) {
      throw new GoalServiceError(400, '训练日取值需为 0~6 的整数（0=周日）');
    }
  }

  const weekStartDow = assertInt('一周起始日', src.week_start_dow, 0, 1);
  // 按**周内时间顺序**排列（不是简单的 0~6 升序）：模板按数组下标依次排日，
  // 若周起点是周一而周日排在下标 0，第一天的分化就会落到周日 —— 顺序必须从周起点起算。
  const weekOffset = (d: number): number => (d - weekStartDow + 7) % 7;
  dows.sort((a, b) => weekOffset(a) - weekOffset(b));

  const minDurationMin = assertInt('时长下限', src.min_duration_min, LIMITS.minDuration[0], LIMITS.minDuration[1]);
  const maxDurationMin = assertInt('时长上限', src.max_duration_min, LIMITS.maxDuration[0], LIMITS.maxDuration[1]);
  if (maxDurationMin < minDurationMin) throw new GoalServiceError(400, '时长上限不能小于下限');

  return {
    goalType,
    minDurationMin,
    maxDurationMin,
    weekStartDow,
    preferredDows: dows,
    sessionsPerWeek: dows.length,
  };
}

/**
 * 保存训练基础：新增一行 + 旧激活行置 is_active=0（事务内）。
 * 返回新行；`sessions_per_week` 由训练日数量推导。
 */
export function saveGoalSettings(db: Db, raw: unknown, now: Date = new Date()): GoalSettings {
  const v = validateGoalInput(raw);
  const ts = now.toISOString();
  const today = todayStr(now.getTime());
  inTransaction(db, () => {
    prepare(db, `UPDATE user_goal SET is_active = 0 WHERE is_active = 1`).run();
    prepare(
      db,
      `INSERT INTO user_goal
       (goal_type, sessions_per_week, min_duration_min, max_duration_min, week_start_dow,
        preferred_dows, notes, is_active, effective_from, created_at)
       VALUES (?, ?, ?, ?, ?, ?, NULL, 1, ?, ?)`,
    ).run(
      v.goalType,
      v.sessionsPerWeek,
      v.minDurationMin,
      v.maxDurationMin,
      v.weekStartDow,
      JSON.stringify(v.preferredDows),
      today,
      ts,
    );
  });
  const saved = getGoalSettings(db);
  if (!saved) throw new GoalServiceError(500, '保存后未能读回训练基础');
  return saved;
}
