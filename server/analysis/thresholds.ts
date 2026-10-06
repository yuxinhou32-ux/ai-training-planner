/**
 * 分析阈值装载（§4.2：所有阈值外置到 config/default.json）。
 *
 * 内置默认值 = §4.2 初始值（与 config/default.json 逐字一致）。
 * 文件缺失/字段缺失时逐级回退到内置值，保证分析引擎在任何环境下可运行；
 * 文件存在时以文件为准（允许用户调阈值，不动代码）。
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * ⚠️ **这不是窗口来源**。真正决定分析/画像窗口周数的是
 * `server/analysis/window.ts` 的 `ANALYSIS_WINDOW_WEEKS`（全系统唯一来源）。
 * 这里保持同值（26）只是防止读代码的人被误导 —— 全仓库没有任何地方消费本字段。
 */
export interface WindowThresholds {
  trend_weeks: number;
  recent_weeks: number;
  segment_weeks: number;
}

export interface MovementTrendThresholds {
  min_weeks_with_data: number;
  progress_weight_pct: number;
  progress_reps_delta: number;
  plateau_weight_pct: number;
  plateau_min_weeks: number;
  regress_weight_drop_pct: number;
  slope_lookback_weeks: number;
}

export interface MuscleTrendThresholds {
  rise_pct: number;
  drop_pct: number;
  insufficient_large_sets_per_week: number;
  insufficient_small_sets_per_week: number;
  excess_large_sets_per_week: number;
  excess_small_sets_per_week: number;
}

export interface StructureTrendThresholds {
  push_pull_target: [number, number];
  upper_lower_target: [number, number];
  large_muscle_min_freq: number;
  movement_repeat_rate_high: number;
  same_pattern_per_day_max: number;
}

export interface Thresholds {
  window: WindowThresholds;
  movement_trend: MovementTrendThresholds;
  muscle_trend: MuscleTrendThresholds;
  structure_trend: StructureTrendThresholds;
}

export const THRESHOLD_DEFAULTS: Thresholds = {
  window: { trend_weeks: 26, recent_weeks: 4, segment_weeks: 4 },
  movement_trend: {
    min_weeks_with_data: 3,
    progress_weight_pct: 2.5,
    progress_reps_delta: 1,
    plateau_weight_pct: 2.5,
    plateau_min_weeks: 4,
    regress_weight_drop_pct: 5.0,
    slope_lookback_weeks: 6,
  },
  muscle_trend: {
    rise_pct: 20,
    drop_pct: -20,
    insufficient_large_sets_per_week: 8,
    insufficient_small_sets_per_week: 4,
    excess_large_sets_per_week: 22,
    excess_small_sets_per_week: 14,
  },
  structure_trend: {
    push_pull_target: [0.8, 1.25],
    upper_lower_target: [0.7, 1.4],
    large_muscle_min_freq: 1.5,
    movement_repeat_rate_high: 0.6,
    same_pattern_per_day_max: 4,
  },
};

/** 浅合并一段配置：文件值优先，缺省回退内置。 */
function mergeSection<T>(base: T, override: unknown): T {
  if (typeof override !== 'object' || override === null) return base;
  const out: Record<string, unknown> = { ...(base as unknown as Record<string, unknown>) };
  for (const [k, v] of Object.entries(override as Record<string, unknown>)) {
    if (v !== undefined && k in out) out[k] = v;
  }
  return out as unknown as T;
}

/**
 * 读 config/default.json 并合并默认值。
 * 解析失败不抛错：回退内置默认 + 返回 warning（调用方可记入 data_quality.warnings）。
 */
export function loadThresholds(cwd: string = process.cwd()): { thresholds: Thresholds; warning: string | null } {
  const file = path.join(cwd, 'config', 'default.json');
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    return { thresholds: THRESHOLD_DEFAULTS, warning: null }; // 无配置文件是合法状态（用内置默认）
  }
  try {
    const parsed = JSON.parse(raw) as { analysis?: unknown };
    const a = (typeof parsed.analysis === 'object' && parsed.analysis !== null ? parsed.analysis : {}) as Record<
      string,
      unknown
    >;
    const t: Thresholds = {
      window: mergeSection(THRESHOLD_DEFAULTS.window, a['window']),
      movement_trend: mergeSection(THRESHOLD_DEFAULTS.movement_trend, a['movement_trend']),
      muscle_trend: mergeSection(THRESHOLD_DEFAULTS.muscle_trend, a['muscle_trend']),
      structure_trend: mergeSection(THRESHOLD_DEFAULTS.structure_trend, a['structure_trend']),
    };
    return { thresholds: t, warning: null };
  } catch (e) {
    return {
      thresholds: THRESHOLD_DEFAULTS,
      warning: `config/default.json 解析失败，已回退内置默认阈值：${(e as Error).message}`,
    };
  }
}
