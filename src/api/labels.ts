/**
 * 展示层标签与配色映射（verdict 徽章配色）。
 * 前后端共享的事实只在服务端 reportSchema；这里是纯 UI 映射。
 */

export interface BadgeStyle {
  label: string;
  cls: string;
}

/** 动作趋势判定徽章（无「疲劳」——判定疲劳需要 RPE，实测填充率 0%，PRD-v2 §11）。 */
export const MOVEMENT_VERDICT: Record<string, BadgeStyle> = {
  progress: { label: '进步', cls: 'bg-emerald-100 text-emerald-700' },
  plateau: { label: '平台', cls: 'bg-slate-200 text-slate-600' },
  regress: { label: '退步', cls: 'bg-red-100 text-red-700' },
  unstable: { label: '波动', cls: 'bg-violet-100 text-violet-700' },
  insufficient_data: { label: '数据不足', cls: 'bg-slate-100 text-slate-400' },
};

/** 肌群趋势判定徽章。 */
export const MUSCLE_VERDICT: Record<string, BadgeStyle> = {
  rising: { label: '上升', cls: 'bg-emerald-100 text-emerald-700' },
  stable: { label: '平稳', cls: 'bg-slate-200 text-slate-600' },
  falling: { label: '下降', cls: 'bg-red-100 text-red-700' },
  insufficient: { label: '长期不足', cls: 'bg-amber-100 text-amber-700' },
  excess: { label: '过量', cls: 'bg-orange-100 text-orange-700' },
};

/** 结论严重度。 */
export const SEVERITY: Record<string, BadgeStyle> = {
  high: { label: '高', cls: 'bg-red-100 text-red-700' },
  warn: { label: '提醒', cls: 'bg-amber-100 text-amber-700' },
  info: { label: '信息', cls: 'bg-sky-100 text-sky-700' },
};

/** 映射来源徽章（§3.4 优先级 manual > server > rule > segment）。 */
export const MAP_SOURCE: Record<string, BadgeStyle> = {
  manual: { label: '人工', cls: 'bg-indigo-100 text-indigo-700' },
  server: { label: '服务端', cls: 'bg-teal-100 text-teal-700' },
  rule: { label: '规则', cls: 'bg-slate-200 text-slate-600' },
  segment: { label: '区间', cls: 'bg-slate-100 text-slate-400' },
};

/** 肌群码 → 中文名（seeds/muscle_groups.json 的展示映射）。 */
export const MUSCLE_ZH: Record<string, string> = {
  chest: '胸',
  back_upper: '上背',
  back_lats: '背阔',
  shoulder_front: '肩前束',
  shoulder_side: '肩中束',
  shoulder_rear: '肩后束',
  biceps: '肱二头',
  triceps: '肱三头',
  forearm: '前臂',
  quads: '股四头',
  hamstrings: '腘绳',
  glutes: '臀',
  adductors: '内收肌',
  hip_abductors: '髋外展',
  calves: '小腿',
  core: '核心',
  cardio: '有氧',
  stretch: '拉伸放松',
  back: '背',
  shoulder: '肩',
  arms: '手臂',
  lower: '下肢',
};

export function muscleZh(code: string): string {
  return MUSCLE_ZH[code] ?? code;
}

/** 有效组口径一句话（§4.1.1，UI hover 说明统一文案）。 */
export const EFFECTIVE_SETS_HINT = '有效组 = 已完成且非热身组；主肌群计 1、次肌群计 0.5；有氧/拉伸不计';

/** 星期码 → 中文名（下标 = JS getUTCDay()，0=周日）。全站唯一来源，勿再各页各写一份。 */
export const DOW_ZH = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'] as const;

/** 周内展示顺序（周一在前），元素是 DOW_ZH 的下标。 */
export const DOW_ORDER_MON_FIRST = [1, 2, 3, 4, 5, 6, 0] as const;

/**
 * 从 week_start 展开本周 7 个日期（YYYY-MM-DD）。
 *
 * 「周」的构成由 week_start 决定而不由周几决定 —— 设置页可以把周起点选成周日，
 * 所以这里不能假设 week_start 一定是周一（V7 挪训练日的候选日必须落在这 7 天里，
 * 算错一天就会出现「挪过去服务端 400」的死按钮）。
 */
export function weekDates(weekStart: string): string[] {
  const base = new Date(`${weekStart}T00:00:00Z`);
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(base.getTime() + i * 86_400_000);
    return d.toISOString().slice(0, 10);
  });
}

/** 日期的周几（0=周日），与 DOW_ZH 下标一致。 */
export function dowOf(datestr: string): number {
  return new Date(`${datestr}T00:00:00Z`).getUTCDay();
}

/** 日期加减天数（YYYY-MM-DD）。纯 UTC 算术 —— 与 weekDates/dowOf 同一套口径，不引入本地时区。 */
export function addDays(datestr: string, n: number): string {
  const d = new Date(`${datestr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** 浏览器本地的「今天」（YYYY-MM-DD）。不能用 `toISOString()` —— 那会按 UTC 算，东八区夜里就少一天。 */
export function todayLocal(): string {
  const d = new Date();
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * 今天所在那一周的起点（按给定的周起点日）。
 *
 * 用途：判断某份计划是不是「起始周（Week 0）」—— 计划周 === 今天所在周。
 * 起始周会被服务端排成「本周剩下的训练日」，`week_no` 为 null，标题写「下周计划」就骗人了。
 */
export function currentWeekStart(weekStartDow: number = 1): string {
  const today = todayLocal();
  const target = weekStartDow === 0 ? 0 : 1;
  const back = (dowOf(today) - target + 7) % 7;
  return addDays(today, -back);
}

/**
 * 本周「还没到」的训练日（严格晚于今天），升序。
 *
 * 与服务端 `remainingTrainingDows` 同一套判据 —— UI 放行条件必须与服务端规则逐字一致，
 * 否则会出现「按钮能点但服务端拒绝」的死按钮。
 */
export function remainingTrainingDows(trainingDows: readonly number[], today: string = todayLocal()): number[] {
  const set = new Set(trainingDows);
  const out: number[] = [];
  for (let i = 1; i <= 6; i++) {
    const ds = addDays(today, i);
    const dow = dowOf(ds);
    if (set.has(dow) && !out.includes(dow)) out.push(dow);
  }
  return out.sort((a, b) => a - b);
}
