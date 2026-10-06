/**
 * plan_summary 确定性计算（§5.6.1「配套设计」）。
 *
 * 原则：展示给用户的数字，要么是 AI 对输入的逐字引用，要么来自确定性代码，
 * 绝不来自 AI 自己的算术。AI 的 PlanDraft 只含 days；本模块在 V1~V5 全部
 * 通过后从 days 计算 summary 并随计划落库（plan.summary_json）。
 *
 * 口径：total_sets / muscle_distribution 只统计力量动作（is_cardio=0），
 * 与有效组口径一致（有氧不计组数）；肌群分摊按 movement_muscle_map 的
 * weight 列（primary 1.0 / secondary 0.5）。
 */
import { prepare, type Db } from '../db/index.js';
import type { PlanDraft } from './schemas.js';
import type { PlanSummary } from './schemas.js';

interface MuscleMapRow {
  catalog_id: number;
  muscle_code: string;
  weight: number;
}

export function buildSummary(db: Db, draft: PlanDraft): PlanSummary {
  const rows = prepare(
    db,
    'SELECT catalog_id, muscle_code, weight FROM movement_muscle_map',
  ).all() as unknown as MuscleMapRow[];

  const byCatalog = new Map<number, MuscleMapRow[]>();
  for (const r of rows) {
    const list = byCatalog.get(r.catalog_id) ?? [];
    list.push(r);
    byCatalog.set(r.catalog_id, list);
  }

  let totalSets = 0;
  let estTotalMin = 0;
  const distribution = new Map<string, number>();

  for (const day of draft.days) {
    estTotalMin += day.est_duration_min;
    for (const ex of day.exercises) {
      if (ex.is_cardio) continue;
      totalSets += ex.sets;
      const maps = byCatalog.get(ex.catalog_id);
      if (!maps || maps.length === 0) continue; // 未映射动作不计入肌群分布（数据质量问题走 analysis 报警）
      for (const m of maps) {
        distribution.set(m.muscle_code, (distribution.get(m.muscle_code) ?? 0) + ex.sets * m.weight);
      }
    }
  }

  const muscle_distribution: Record<string, number> = {};
  for (const [code, val] of distribution) {
    muscle_distribution[code] = Math.round(val * 100) / 100;
  }

  return {
    total_sessions: draft.days.length,
    total_sets: totalSets,
    est_total_min: estTotalMin,
    muscle_distribution,
  };
}
