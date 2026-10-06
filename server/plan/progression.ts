/**
 * 渐进超负荷：**本地先把「本周该用多少重量」算好**，AI 只做裁决与例外（PRD-v2 §10.3 V5）。
 *
 * 为什么这件事必须在本地做：
 *   ① 递增是确定性规则（趋势 × 上周达成情况 × 周期周次 → 一个具体数字），交给模型只会不稳定；
 *   ② 用户要的是「进步」，不是「每周随便给个数」——建议值必须能追溯到一个理由（`action`）；
 *   ③ 「上周没达成 → 下周不递增 / 回退」要对比**计划 vs 实际**（V6），那是本地数据的事，
 *      模型看不到训记原始记录，也不该看到。
 *
 * 与 analysis 层的关系：本模块**不重算任何统计口径**，只把已有事实翻译成建议 ——
 *   `MovementTrend.last_weight`（近 2 周最大重量均值，作为上期实际基准）
 *   `MovementTrend.slope_weight_per_week` / `verdict`（12 周窗口内的趋势判定）
 *   `CandidatePoolItem.last_weight`（历史最佳，仅作兜底基准）
 *
 * 重量归一：全部落到 **0.5 kg 刻度**（可用的最小配重组合）。递增方向永远向下取整到刻度，
 * 避免 90 × 0.9 = 81 被四舍五入成 81.5 —— 减量的方向只能是更轻。
 */
import type { MovementVerdict } from '../analysis/reportSchema.js';

/**
 * 建议类型。**枚举值本身就是依据**，所以不再单列一个 basis 字段 ——
 * AI 看 action 就知道为什么，前端/日志用 `PROGRESSION_LABEL` 翻译成中文。
 */
export type ProgressionAction =
  /** 趋势在进步 → 按步长递增 */
  | 'increase_progress'
  /** 停滞多周 → 加负荷打破平台（继续维持只会继续停滞） */
  | 'increase_plateau'
  /** 数据不足或不稳定 → 维持上期重量，不猜 */
  | 'hold'
  /** 上周有计划但没达成目标重量 → 回到实际完成的水平，下次再冲 */
  | 'backoff_actual'
  /** 趋势在退步 → 回退一档 */
  | 'reduce_regress'
  /** 周期减量周（第 4 周）→ 重量降到上期的 90% */
  | 'deload'
  /** 无任何重量数据 → 本次只建立基线，不猜数字 */
  | 'establish';

export const PROGRESSION_LABEL: Record<ProgressionAction, string> = {
  increase_progress: '趋势在进步，按步长递增',
  increase_plateau: '停滞多周，加负荷打破平台',
  hold: '数据不足或不稳定，维持上期重量',
  backoff_actual: '上周未达成计划重量，回到实际完成的水平',
  reduce_regress: '趋势在退步，回退一档',
  deload: '减量周，重量降到上期的 90%',
  establish: '无历史重量，本次只建立基线',
};

/** 上周「计划 vs 实际」中与本动作有关的那一部分（V6 反哺 V5）。 */
export interface ProgressionLastPlan {
  /** 上周计划的目标重量 */
  targetWeight: number | null;
  /** 上周实际做到的最好重量；null = 该动作上周一次都没做 */
  actualBestWeight: number | null;
}

export interface ProgressionInput {
  /** 上期实际基准：近 2 周最大重量均值。null = 近 2 周没练过这个动作 */
  recentWeight: number | null;
  /** 历史最佳重量（兜底基准） */
  bestWeight: number | null;
  verdict: MovementVerdict;
  weeksWithData: number;
  /** 周增重斜率（kg/周，正 = 涨）；当前仅作输入保留，判定走 verdict */
  slopePerWeek: number | null;
  /** 上周计划 vs 实际；上周没排计划或该动作不在上周计划里时 undefined */
  lastPlan?: ProgressionLastPlan;
  /** 是否周期减量周 */
  isDeload: boolean;
}

/** 摘要层里每个候选动作携带的建议（字段名刻意短：30 条 × 100 字节会推高 payload）。 */
export interface ProgressionAdvice {
  /** 本周建议重量（kg，0.5 刻度）；null = 无历史数据 */
  suggest_kg: number | null;
  /** 相对上期实际基准的变化（kg，正 = 加） */
  delta_kg: number | null;
  action: ProgressionAction;
}

function round05(x: number): number {
  return Math.round(x * 2) / 2;
}

function floor05(x: number): number {
  return Math.floor(x * 2) / 2;
}

/**
 * 递增步长：小重量走小步（哑铃 8kg 加 1.5kg 就是 +19%，太狠），
 * 中大重量按 2.5% 计算并向下取到 0.5 刻度，夹在 [1.5, 5]。
 *
 * 60kg → 1.5（正好是用户举例的「每周增加 1.5kg」）；100kg → 2.5；200kg → 5。
 */
export function stepKg(base: number): number {
  if (base < 10) return 0.5;
  if (base < 25) return 1;
  return Math.min(5, Math.max(1.5, floor05(base * 0.025)));
}

function hold(base: number): ProgressionAdvice {
  const w = round05(base);
  return { suggest_kg: w, delta_kg: round05(w - base), action: 'hold' };
}

function increase(base: number, action: ProgressionAction): ProgressionAdvice {
  const w = round05(base + stepKg(base));
  return { suggest_kg: w, delta_kg: round05(w - base), action };
}

/**
 * 单动作建议。判定顺序即优先级：
 *   减量周 > 无数据 > 上周实际反馈 > 趋势。
 */
export function computeProgression(input: ProgressionInput): ProgressionAdvice {
  const base = input.recentWeight ?? input.bestWeight;

  // ① 减量周优先于一切（PRD §10.1 V5「第 4 周减量：重量不变或 −10%」，取 −10%）
  if (input.isDeload && base !== null && base > 0) {
    const w = floor05(base * 0.9);
    return { suggest_kg: w, delta_kg: round05(w - base), action: 'deload' };
  }

  // ② 没练过也没记录过 → 只建立基线，绝不猜数字
  if (base === null || base <= 0) {
    return { suggest_kg: null, delta_kg: null, action: 'establish' };
  }

  // ③ 上周计划里有这个动作 → 先看实际做得怎么样（V6 反哺 V5，优先级高于趋势）
  const last = input.lastPlan;
  if (last && last.targetWeight !== null && last.targetWeight > 0) {
    const target = last.targetWeight;
    const actual = last.actualBestWeight;
    if (actual === null || actual <= 0) {
      // 上周压根没做：没做不等于做不到，重量原样保留（真做不到会体现在下一次实际里）
      return hold(base);
    }
    // 容差 2%：磅片换算 / 1.25kg 小片造成的微小差不算未达成
    if (actual < target * 0.98) {
      const w = round05(actual);
      return { suggest_kg: w, delta_kg: round05(w - base), action: 'backoff_actual' };
    }
    // 达成或超额 → 继续往上走，落到 ④
  }

  // ④ 按趋势判定
  switch (input.verdict) {
    case 'progress':
      return increase(base, 'increase_progress');
    case 'plateau':
      return increase(base, 'increase_plateau');
    case 'regress': {
      // 回退 5% 并向下取刻度：退步时先减一档找回落点，不一次砍太多
      const w = floor05(base * 0.95);
      return { suggest_kg: w, delta_kg: round05(w - base), action: 'reduce_regress' };
    }
    case 'unstable':
    case 'insufficient_data':
    default:
      return hold(base);
  }
}
