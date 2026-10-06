/**
 * 动作趋势（§4.2.1）。
 *
 * v3：RPE 全链路移除（PRD-v2 §11 决策 A）——没有 RPE 就没有 `fatigue` 判定，
 * 也没有 `delta_rpe`。判定只在「重量 / 次数」两个可闭环的维度上做。
 *
 * 窗口语义（实现口径，与 §4.2.1 伪代码对齐）：
 *   recent2 = 有数据周中 weeks_ago <= 1 的周（最近 2 周）
 *   early2  = 有数据周中最早的 2 周（weeks_ago 最大的两个）
 *   —— 比字面上的 `weeks_ago >= W-2` 更稳健：W=3 时二者不会重叠。
 */
import type { MovementTrend, MovementVerdict } from './reportSchema.js';
import { isEffectiveSet, mean, round2, type MuscleMapRow, type SessionRow, type SetRow } from './metrics.js';
import type { MovementTrendThresholds } from './thresholds.js';

interface WeekAcc {
  best: number | null;
  sets: number;
  reps: number;
}

export interface MovementTrendParams {
  setRows: SetRow[];
  sessions: SessionRow[];
  maps: Map<number, MuscleMapRow[]>;
  catalogNames: Map<number, string>;
  trendEnd: string;
  weeks: number;
  /** 实际覆盖周数（周均类的分母）；缺省回退到名义窗口 weeks。 */
  activeWeeks?: number;
  th: MovementTrendThresholds;
}

/** 最小二乘斜率；<2 点返回 null。x 升序。 */
function linSlope(points: Array<{ x: number; y: number }>): number | null {
  if (points.length < 2) return null;
  const n = points.length;
  const mx = points.reduce((a, p) => a + p.x, 0) / n;
  const my = points.reduce((a, p) => a + p.y, 0) / n;
  let num = 0;
  let den = 0;
  for (const p of points) {
    num += (p.x - mx) * (p.y - my);
    den += (p.x - mx) * (p.x - mx);
  }
  return den === 0 ? null : num / den;
}

/** 单个动作的完整趋势计算。 */
export function computeOneMovementTrend(cid: number, p: MovementTrendParams): MovementTrend {
  const { th, weeks, trendEnd } = p;
  const rows = p.setRows.filter((r) => r.catalogId === cid);
  const eff = rows.filter(isEffectiveSet);

  // --- 周序列（Q-D 口径 + §4.1.1 有效组排除） ---
  const weekly = new Map<number, WeekAcc>();
  for (const r of eff) {
    let a = weekly.get(r.weeksAgo);
    if (!a) {
      a = { best: null, sets: 0, reps: 0 };
      weekly.set(r.weeksAgo, a);
    }
    if (r.weightKg !== null && (a.best === null || r.weightKg > a.best)) a.best = r.weightKg;
    a.sets += 1;
    if (r.reps !== null) a.reps += r.reps;
  }
  const weeksWithData = [...weekly.keys()].sort((a, b) => a - b); // 升序 = 由远及近
  const W = weeksWithData.length;

  const totalEffSets = eff.length;
  const lastPerformed = eff.length === 0 ? null : eff.reduce((m, r) => (r.datestr > m ? r.datestr : m), eff[0].datestr);
  // 🔴 分母是「实际覆盖周数」而不是名义窗口 weeks（只练了 12 周的人不能被 26 除）。
  const avgDenom = p.activeWeeks !== undefined && p.activeWeeks > 0 ? p.activeWeeks : weeks;
  const avgSetsPerWeek = round2(totalEffSets / avgDenom);

  const base: MovementTrend = {
    catalog_id: cid,
    name: p.catalogNames.get(cid) ?? String(cid),
    verdict: 'insufficient_data',
    weeks_with_data: W,
    first_weight: null,
    last_weight: null,
    delta_weight_pct: null,
    slope_weight_per_week: null,
    avg_sets_per_week: avgSetsPerWeek,
    last_performed: lastPerformed,
    volume_load_last: null,
  };
  if (W === 0) return base;

  const recentWeeks = weeksWithData.filter((w) => w <= 1);
  const earlyWeeks = weeksWithData.slice(-2); // 最早 2 个有数据周

  const bestOf = (ws: number[]): number | null => {
    const vals = ws.map((w) => weekly.get(w)?.best).filter((v): v is number => v !== null && v !== undefined);
    return mean(vals);
  };
  const repsPerSetOf = (ws: number[]): number | null => {
    const vals = ws
      .map((w) => weekly.get(w))
      .filter((a): a is WeekAcc => a !== undefined && a.sets > 0)
      .map((a) => a.reps / a.sets);
    return mean(vals);
  };
  const recentBest = bestOf(recentWeeks);
  const earlyBest = bestOf(earlyWeeks);
  const deltaWeightPct =
    recentBest !== null && earlyBest !== null && earlyBest > 0 ? round2(((recentBest - earlyBest) / earlyBest) * 100) : null;
  const recentRps = repsPerSetOf(recentWeeks);
  const earlyRps = repsPerSetOf(earlyWeeks);
  const deltaReps = recentRps !== null && earlyRps !== null ? round2(recentRps - earlyRps) : null;

  // 斜率：近 slope_lookback_weeks 周，时间正向（kg/周，正 = 涨）
  const slopePoints = weeksWithData
    .filter((w) => w <= th.slope_lookback_weeks && weekly.get(w)!.best !== null)
    .map((w) => ({ x: w, y: weekly.get(w)!.best as number }));
  const slopeRaw = linSlope(slopePoints);
  base.slope_weight_per_week = slopeRaw === null ? null : round2(-slopeRaw);
  base.first_weight = earlyBest === null ? null : round2(earlyBest);
  base.last_weight = recentBest === null ? null : round2(recentBest);
  base.delta_weight_pct = deltaWeightPct;

  // --- 判定（命中即停；无 RPE 即无 fatigue 分支） ---
  let verdict: MovementVerdict;
  if (W < th.min_weeks_with_data) {
    verdict = 'insufficient_data';
  } else if (deltaWeightPct !== null && deltaWeightPct <= -th.regress_weight_drop_pct) {
    verdict = 'regress';
  } else if (
    (deltaWeightPct !== null && deltaWeightPct >= th.progress_weight_pct) ||
    (deltaReps !== null &&
      deltaReps >= th.progress_reps_delta &&
      (deltaWeightPct === null || deltaWeightPct >= -th.progress_weight_pct))
  ) {
    verdict = 'progress';
  } else if (
    W >= th.plateau_min_weeks &&
    (deltaWeightPct !== null
      ? Math.abs(deltaWeightPct) < th.plateau_weight_pct
      : deltaReps !== null && Math.abs(deltaReps) < th.progress_reps_delta)
  ) {
    // 无重量数据（纯自重）时按 §4.1.2 降级口径：次数平稳 → plateau
    verdict = 'plateau';
  } else {
    verdict = 'unstable';
  }
  base.verdict = verdict;

  // volume_load_last：仅纵向可比（§4.1.2）；近 2 周内任一组缺重量/次数则置 null
  const recentRows = eff.filter((r) => r.weeksAgo <= 1);
  if (recentRows.length > 0 && recentRows.every((r) => r.weightKg !== null && r.reps !== null)) {
    base.volume_load_last = round2(recentRows.reduce((a, r) => a + (r.weightKg as number) * (r.reps as number), 0));
  }
  return base;
}

export function computeMovementTrends(p: MovementTrendParams): MovementTrend[] {
  const cids = [...new Set(p.setRows.filter(isEffectiveSet).map((r) => r.catalogId))].filter(
    (v): v is number => v !== null,
  );
  return cids.sort((a, b) => a - b).map((cid) => computeOneMovementTrend(cid, p));
}
