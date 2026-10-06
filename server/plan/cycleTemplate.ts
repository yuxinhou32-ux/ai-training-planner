/**
 * 周期模板提取（2026-09-30 用户定案：「周期内同一个模板」）。
 *
 * 用户原话：「周期内是不是同一个模板，这个事情我觉得可以考虑，因为这也会比较省 token……
 * 我们可以第一次生成之后把那个模板写进去，然后第二次生成就直接基于模板上改了。」
 *
 * 设计要点（详见 docs/plan-template-reuse.md）：
 *   ① **不建新表**：模板就是「同一周期上一周那份 plan」。用户会在第 1 周把草稿改成自己要的样子，
 *      **那份改完的计划本身就是模板** —— 另存一份 JSON 只会跟用户的修改脱钩（改完还得记得「更新模板」）。
 *   ② 模板只描述**结构**（哪天练、练什么、几组几次、休息多久），
 *      重量一律不在模板里定 —— 它必须由 V5 的 progression 现算（减量周、上周未达成都会让旧重量过时）。
 *   ③ 日期**由服务端平移到目标周**（按模板那天的星期几映射），AI 不需要做任何日期算术。
 *
 * 本模块只从库里读，不写任何东西；也没有 AI 调用。
 */
import type { Db } from '../db/index.js';
import { prepare } from '../db/index.js';
import { dowOfDateStr, shiftDays } from '../util/dates.js';
import { CYCLE_WEEKS, cycleStatusFor } from '../cycle/cycleService.js';

/** 模板里的一个动作（还没有本周建议重量 —— 那要等摘要层算完 progression 才填得上）。 */
export interface RawTemplateExercise {
  name: string;
  catalog_id: number;
  sets: number;
  reps: number | null;
  rest_s: number | null;
  /** 有氧动作标记（模板路径的「有氧日」要靠它还原，否则用户上周的有氧会被当成力量动作）。 */
  is_cardio: boolean;
  /** 上一周写的重量。**只作上下文**，任何情况下都不许照抄。 */
  last_week_weight_kg: number | null;
}

export interface RawTemplateDay {
  /** 上一周那天的星期几（0=周日）。**不是日期** —— 日期要平移到目标周再算。 */
  dow: number;
  day_type: string;
  title: string;
  target_muscles: string[];
  exercises: RawTemplateExercise[];
}

export interface RawTemplate {
  source_week_start: string;
  source_week_end: string;
  source_week_no: number;
  days: RawTemplateDay[];
}

function dowOf(datestr: string): number {
  return dowOfDateStr(datestr);
}

/**
 * 取「该计划周应该沿用的模板」——同周期上一周那份计划；没有就返回 null。
 *
 * 返回 null 的五种情况（都**不是错误**，调用方一律回落全量生成）：
 *   ① 该周不在周期内（没开周期 / 跳出了 4 周范围）
 *   ② 该周是周期第 1 周（本来就没有可以沿用的东西）
 *   ③ 上一周没有计划（用户没生成，或计划被归档 / 取消）
 *   ④ 上一周的计划一天都没有（空壳）
 *   ⑤ 上一周的计划全是有氧 / 没有 catalog_id 的动作（模板对力量计划没有意义）
 */
export function templateFor(db: Db, weekStart: string): RawTemplate | null {
  const status = cycleStatusFor(db, weekStart);
  if (status.cycle === null || status.weekNo === null) return null;
  if (status.weekNo <= 1) return null;

  const prevStart = shiftDays(weekStart, -7);
  const prevEnd = shiftDays(weekStart, -1);

  const planRow = prepare(
    db,
    `SELECT id, status FROM plan
     WHERE week_start = ? AND status NOT IN ('archived', 'cancelled')
     ORDER BY id DESC LIMIT 1`,
  ).get(prevStart) as { id: number; status: string } | undefined;
  if (planRow === undefined) return null;

  const dayRows = prepare(
    db,
    `SELECT id, datestr, day_type, title, target_muscles_json
     FROM plan_day WHERE plan_id = ? ORDER BY ord, datestr`,
  ).all(Number(planRow.id)) as unknown as Array<{
    id: number;
    datestr: string;
    day_type: string | null;
    title: string;
    target_muscles_json: string | null;
  }>;
  if (dayRows.length === 0) return null;

  const days: RawTemplateDay[] = [];
  for (const d of dayRows) {
    const exRows = prepare(
      db,
      `SELECT catalog_id, name, sets, reps, rest_s, is_cardio, weight_kg
       FROM plan_exercise WHERE plan_day_id = ? AND catalog_id IS NOT NULL ORDER BY ord`,
    ).all(Number(d.id)) as unknown as Array<{
      catalog_id: number;
      name: string;
      sets: number;
      reps: number | null;
      rest_s: number | null;
      is_cardio: number;
      weight_kg: number | null;
    }>;
    if (exRows.length === 0) continue;
    days.push({
      dow: dowOf(d.datestr),
      day_type: d.day_type ?? '训练',
      title: d.title,
      target_muscles: d.target_muscles_json === null ? [] : (JSON.parse(d.target_muscles_json) as string[]),
      exercises: exRows.map((e) => ({
        name: e.name,
        catalog_id: Number(e.catalog_id),
        sets: Number(e.sets),
        reps: e.reps === null ? null : Number(e.reps),
        rest_s: e.rest_s === null ? null : Number(e.rest_s),
        is_cardio: Number(e.is_cardio) === 1,
        last_week_weight_kg: e.weight_kg === null ? null : Number(e.weight_kg),
      })),
    });
  }
  if (days.length === 0) return null;

  // 模板只对周期内相邻的一周有意义（week_no > 1 已由上面保证，这里再确认上一周确实在周期里）
  if (status.weekNo > CYCLE_WEEKS) return null;

  return {
    source_week_start: prevStart,
    source_week_end: prevEnd,
    source_week_no: status.weekNo - 1,
    days,
  };
}

/**
 * 把模板里「上一周那天」平移到目标周的同一天。
 * 实现落在 `util/dates.ts`（digest 也要用，放这里会形成 cycleTemplate → planService 的环）。
 */
export { datestrForDow } from '../util/dates.js';
