/**
 * 肌群趋势（§4.2.2，4 周分段）。
 *
 * 判定优先级：insufficient → excess → rising → falling → stable。
 * - insufficient：seg0 与 seg1 连续两段低于阈值（大肌群 8 / 小肌群 4 组每周）
 * - excess：seg0 超阈值（大 22 / 小 14）且 该肌群关联动作趋势 ∈ {plateau, regress}
 *   —— 单纯量大但持续进步不算问题（§4.2.2 表注）
 */
import type { MuscleTrend, MuscleVerdict, MovementTrend, MuscleVolumeEntry } from './reportSchema.js';
import type { MuscleGroupInfo, MuscleMapRow } from './metrics.js';
import type { MuscleTrendThresholds } from './thresholds.js';

export interface MuscleTrendParams {
  volume: Record<string, MuscleVolumeEntry>;
  muscleGroups: Map<string, MuscleGroupInfo>;
  movementTrends: MovementTrend[];
  maps: Map<number, MuscleMapRow[]>;
  th: MuscleTrendThresholds;
}

function thresholdsFor(size: string, th: MuscleTrendThresholds): { ins: number; exc: number } {
  return size === 'large'
    ? { ins: th.insufficient_large_sets_per_week, exc: th.excess_large_sets_per_week }
    : { ins: th.insufficient_small_sets_per_week, exc: th.excess_small_sets_per_week };
}

/** 该肌群的关联动作中是否存在趋势判定为 verdicts 的动作（按 primary 映射关联）。 */
function hasPrimaryMovementWithVerdict(
  muscleCode: string,
  movementTrends: MovementTrend[],
  maps: Map<number, MuscleMapRow[]>,
  verdicts: MovementTrend['verdict'][],
): boolean {
  return movementTrends.some(
    (mt) =>
      verdicts.includes(mt.verdict) &&
      (maps.get(mt.catalog_id) ?? []).some((m) => m.role === 'primary' && m.muscleCode === muscleCode),
  );
}

export function computeMuscleTrends(p: MuscleTrendParams): MuscleTrend[] {
  const out: MuscleTrend[] = [];
  for (const [code, v] of Object.entries(p.volume)) {
    const g = p.muscleGroups.get(code);
    const size = g?.size ?? 'small';
    const { ins, exc } = thresholdsFor(size, p.th);

    const seg0 = v.sets_per_week_seg0;
    const seg1 = v.sets_per_week_seg1;
    const seg2 = v.sets_per_week_seg2;
    const deltaRecent = seg1 > 0 ? Math.round(((seg0 - seg1) / seg1) * 10000) / 100 : null;

    let verdict: MuscleVerdict;
    if (seg0 < ins && seg1 < ins) {
      verdict = 'insufficient';
    } else if (
      seg0 > exc &&
      hasPrimaryMovementWithVerdict(code, p.movementTrends, p.maps, ['plateau', 'regress'])
    ) {
      verdict = 'excess';
    } else if (deltaRecent !== null && deltaRecent >= p.th.rise_pct) {
      verdict = 'rising';
    } else if (deltaRecent !== null && deltaRecent <= p.th.drop_pct) {
      verdict = 'falling';
    } else if (deltaRecent === null && seg0 > 0) {
      // seg1 为 0 而 seg0 有量 → 从无到有，视为上升
      verdict = 'rising';
    } else {
      verdict = 'stable';
    }

    out.push({ muscle_code: code, verdict, seg0, seg1, seg2, delta_recent_pct: deltaRecent });
  }
  return out.sort((a, b) => a.muscle_code.localeCompare(b.muscle_code));
}
