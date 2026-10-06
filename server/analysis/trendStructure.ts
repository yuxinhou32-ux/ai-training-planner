/**
 * 训练结构趋势（§4.2.3）。
 *
 * ✅ 架构已确认：全部指标按「当天动作的肌群/动作模式聚合」计算，
 * 从不读取 train_session.title（title 86% 为空对本算法无影响）。
 *
 * 实现口径说明：push_sets/pull_sets 计的是「有效组数」（该组所属动作含
 * push/pull 模式即计入），与 Q-C 的权重加权版本相比分母同源，比值有效且
 * 更易在 UI 上解释（"推 X 组 / 拉 Y 组"）。
 */
import type { StructureStats, RepeatedMovement } from './reportSchema.js';
import { isEffectiveSet, type MuscleGroupInfo, type MuscleMapRow, type SetRow } from './metrics.js';

export interface StructureParams {
  setRows: SetRow[];
  maps: Map<number, MuscleMapRow[]>;
  patterns: Map<number, string[]>;
  muscleGroups: Map<string, MuscleGroupInfo>;
  weeks: number;
  catalogNames: Map<number, string>;
  repeatRateHigh: number;
}

export function computeStructure(p: StructureParams): StructureStats {
  const eff = p.setRows.filter(isEffectiveSet);

  let pushSets = 0;
  let pullSets = 0;
  let upperSets = 0;
  let lowerSets = 0;

  const datesByCatalog = new Map<number, Set<string>>();
  const datesByParent = new Map<string, Set<string>>();
  const trainDays = new Set<string>();

  for (const r of eff) {
    trainDays.add(r.datestr);
    if (r.catalogId === null) continue;
    const cid = r.catalogId;
    const pats = p.patterns.get(cid) ?? [];
    const maps4 = p.maps.get(cid) ?? [];

    if (pats.includes('push')) pushSets += 1;
    if (pats.includes('pull')) pullSets += 1;

    const regions = new Set(
      maps4.map((m) => p.muscleGroups.get(m.muscleCode)?.region).filter((x): x is 'upper' | 'lower' => x === 'upper' || x === 'lower'),
    );
    if (regions.has('upper')) upperSets += 1;
    if (regions.has('lower')) lowerSets += 1;

    let dc = datesByCatalog.get(cid);
    if (!dc) {
      dc = new Set();
      datesByCatalog.set(cid, dc);
    }
    dc.add(r.datestr);

    // 大肌群训练频率（Q-E：primary 映射到 size=large 肌群，按聚合父码计）
    for (const m of maps4) {
      if (m.role !== 'primary') continue;
      const g = p.muscleGroups.get(m.muscleCode);
      if (!g || g.size !== 'large') continue;
      const parent = g.parentCode ?? g.code;
      let dp = datesByParent.get(parent);
      if (!dp) {
        dp = new Set();
        datesByParent.set(parent, dp);
      }
      dp.add(r.datestr);
    }
  }

  const largeMuscleFreq: Record<string, number> = {};
  for (const [parent, ds] of datesByParent) {
    largeMuscleFreq[parent] = Math.round((ds.size / p.weeks) * 100) / 100;
  }

  const topRepeated: RepeatedMovement[] = [...datesByCatalog.entries()]
    .map(([cid, ds]) => ({
      catalog_id: cid,
      name: p.catalogNames.get(cid) ?? String(cid),
      appear_rate: trainDays.size === 0 ? 0 : Math.round((ds.size / trainDays.size) * 100) / 100,
    }))
    .filter((x) => x.appear_rate >= Math.min(0.3, p.repeatRateHigh))
    .sort((a, b) => b.appear_rate - a.appear_rate || a.catalog_id - b.catalog_id)
    .slice(0, 8);

  return {
    push_sets: pushSets,
    pull_sets: pullSets,
    push_pull_ratio: pullSets > 0 ? Math.round((pushSets / pullSets) * 1000) / 1000 : null,
    upper_lower_ratio: lowerSets > 0 ? Math.round((upperSets / lowerSets) * 1000) / 1000 : null,
    large_muscle_freq: largeMuscleFreq,
    top_repeated_movements: topRepeated,
  };
}
