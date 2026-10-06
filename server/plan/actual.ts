/**
 * 计划 vs 实际（PRD-v2 §10.3 V6）。
 *
 * 回答一个问题：**上周排的计划，实际做到了多少？**
 *   ① 每个动作：计划几组 / 实际几组（完成度）、计划重量 / 实际最好重量（是否达成）
 *   ② 周级：完成率、哪些训练日一次都没练
 *
 * 这是渐进超负荷能闭环的那一环（V5 的 `lastPlan` 输入就来自这里）：
 * 计划 62.5kg 而训记里该动作最大只到 60kg → 未达成 → 下周不继续加，回到 60 巩固。
 *
 * 口径纪律：实际侧一律走 `loadSetRows` + `isEffectiveSet`（与全系统同一判据），
 * 不在这里另写一套「算不算练了」的规则。
 */
import type { Db } from '../db/index.js';
import { prepare } from '../db/index.js';
import { isEffectiveSet, loadSetRows, round2, type WindowInfo } from '../analysis/metrics.js';

export interface PlanActualItem {
  catalog_id: number;
  name: string;
  /** 计划总组数（同动作一周排多次则累加） */
  plan_sets: number;
  /** 计划里该动作的最大重量（一天内有多个重量时取最大的那个） */
  plan_weight_kg: number | null;
  actual_sets: number;
  actual_best_kg: number | null;
  /** actual_sets / plan_sets；>1 表示超量完成（保留真实值，展示层自己决定怎么显示） */
  completion: number;
  /** 是否达成计划重量（2% 容差，吸收磅片换算与 1.25kg 小片）；无计划重量时为 null */
  weight_hit: boolean | null;
  status: 'done' | 'partial' | 'missed';
}

export interface PlanActual {
  plan_id: number;
  week_start: string;
  week_end: string;
  planned_days: number;
  /** 计划周内有有效组的**不同日期**数量（不是训练次数——一天练两次算一天） */
  trained_days: number;
  /** 有效组完成率：实际有效组合计 / 计划组数合计 */
  completion: number;
  /** 计划了但当天一个有效组都没有的日子 */
  missed_days: string[];
  /** 只含「计划里出现过的动作」；计划外临时加练的动作不在此列（那是额外收益，不算欠账） */
  items: PlanActualItem[];
}

const DONE_THRESHOLD = 0.8;

/**
 * 读某个计划周（`week_start`）的「计划 vs 实际」。
 * 该周没有非 archived 的计划 → null（例如系统刚上线、或那周用户自己练的）。
 */
export function loadPlanActual(db: Db, weekStart: string): PlanActual | null {
  const plan = prepare(
    db,
    `SELECT id, week_start, week_end FROM plan
     WHERE week_start = ? AND status != 'archived'
     ORDER BY id DESC LIMIT 1`,
  ).get(weekStart) as unknown as { id: number; week_start: string; week_end: string } | undefined;
  if (!plan) return null;

  const dayRows = prepare(db, `SELECT id, datestr FROM plan_day WHERE plan_id = ? ORDER BY ord`).all(
    Number(plan.id),
  ) as unknown as Array<{ id: number; datestr: string }>;

  // ---- 计划侧：按 catalog_id 汇总。catalog_id 是唯一权威对齐键；为 null 的计划条目跳过
  //（名字匹配会在「同名不同器械」上误配，宁可算作没有这项计划） ----
  const planned = new Map<number, { name: string; sets: number; weight: number | null }>();
  for (const d of dayRows) {
    const exRows = prepare(db, `SELECT catalog_id, name, sets, weight_kg FROM plan_exercise WHERE plan_day_id = ?`).all(
      Number(d.id),
    ) as unknown as Array<{ catalog_id: number | null; name: string; sets: number; weight_kg: number | null }>;
    for (const e of exRows) {
      if (e.catalog_id === null) continue;
      const cid = Number(e.catalog_id);
      const w = e.weight_kg === null ? null : Number(e.weight_kg);
      const cur = planned.get(cid);
      if (cur) {
        cur.sets += Number(e.sets);
        if (w !== null && (cur.weight === null || w > cur.weight)) cur.weight = w;
      } else {
        planned.set(cid, { name: e.name, sets: Number(e.sets), weight: w });
      }
    }
  }

  // ---- 实际侧：该周全部有效组（isEffectiveSet 为唯一判据） ----
  const win: WindowInfo = {
    trendStart: plan.week_start,
    trendEnd: plan.week_end,
    recentStart: plan.week_start,
    recentEnd: plan.week_end,
    weeks: 1,
  };
  const setRows = loadSetRows(db, win).filter(isEffectiveSet);
  const actual = new Map<number, { sets: number; best: number | null }>();
  const trainedDays = new Set<string>();
  for (const r of setRows) {
    trainedDays.add(r.datestr);
    if (r.catalogId === null) continue;
    const cur = actual.get(r.catalogId) ?? { sets: 0, best: null };
    cur.sets += 1;
    if (r.weightKg !== null && (cur.best === null || r.weightKg > cur.best)) cur.best = r.weightKg;
    actual.set(r.catalogId, cur);
  }

  const items: PlanActualItem[] = [];
  for (const [cid, p] of planned) {
    const a = actual.get(cid);
    const actualSets = a?.sets ?? 0;
    const actualBest = a?.best ?? null;
    const completion = p.sets > 0 ? round2(actualSets / p.sets) : 0;
    items.push({
      catalog_id: cid,
      name: p.name,
      plan_sets: p.sets,
      plan_weight_kg: p.weight,
      actual_sets: actualSets,
      actual_best_kg: actualBest,
      completion,
      weight_hit: p.weight !== null && p.weight > 0 && actualBest !== null ? actualBest >= p.weight * 0.98 : null,
      status: actualSets === 0 ? 'missed' : completion < DONE_THRESHOLD ? 'partial' : 'done',
    });
  }

  const totalPlan = items.reduce((s, i) => s + i.plan_sets, 0);
  const totalActual = items.reduce((s, i) => s + i.actual_sets, 0);

  return {
    plan_id: Number(plan.id),
    week_start: plan.week_start,
    week_end: plan.week_end,
    planned_days: dayRows.length,
    trained_days: trainedDays.size,
    completion: totalPlan > 0 ? round2(totalActual / totalPlan) : 0,
    missed_days: dayRows.map((d) => d.datestr).filter((ds) => !trainedDays.has(ds)),
    items,
  };
}
