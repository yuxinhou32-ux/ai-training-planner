/**
 * V5 渐进超负荷（本地计算）测试。
 *
 * 这一层的价值全在「判定优先级」和「边界数字」上，所以每条 action 分支都单独断言，
 * 并且刻意覆盖几个容易写错的点：
 *   - 减量周必须压过「上周未达成」的反馈（周期语义 > 单周波动）
 *   - 上周「没做」与「做了但不够」是两回事（前者 hold，后者回退）
 *   - 小重量不能套用大重量的百分比步长（8kg 加 1.5kg 是 +19%）
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { computeProgression, stepKg, PROGRESSION_LABEL, type ProgressionInput } from '../server/plan/progression.js';

function input(over: Partial<ProgressionInput> = {}): ProgressionInput {
  return {
    recentWeight: 60,
    bestWeight: 80,
    verdict: 'progress',
    weeksWithData: 6,
    slopePerWeek: 1,
    isDeload: false,
    ...over,
  };
}

describe('V5：递增步长阶梯', () => {
  it('小重量走小步，中大重量按 2.5% 取整到 0.5 刻度，上限 5kg', () => {
    assert.equal(stepKg(5), 0.5, '5kg 哑铃 → 0.5');
    assert.equal(stepKg(9.9), 0.5);
    assert.equal(stepKg(10), 1, '10~25kg → 1kg');
    assert.equal(stepKg(24), 1);
    assert.equal(stepKg(25), 1.5, '25kg 起按 2.5%，但下限 1.5');
    assert.equal(stepKg(30), 1.5, '30 × 2.5% = 0.75 → 抬到下限 1.5');
    assert.equal(stepKg(60), 1.5, '60 × 2.5% = 1.5 —— 正是用户举例的「每周增加 1.5kg」');
    assert.equal(stepKg(100), 2.5);
    assert.equal(stepKg(200), 5);
    assert.equal(stepKg(400), 5, '再重也不超过 5kg/周');
  });
});

describe('V5：建议类型分支', () => {
  it('完全没有重量数据 → establish，不猜数字', () => {
    const r = computeProgression(input({ recentWeight: null, bestWeight: null }));
    assert.equal(r.action, 'establish');
    assert.equal(r.suggest_kg, null);
    assert.equal(r.delta_kg, null);
  });

  it('只有历史最佳、近 2 周没练 → 以历史最佳为基准', () => {
    const r = computeProgression(input({ recentWeight: null, bestWeight: 80 }));
    assert.equal(r.action, 'increase_progress');
    assert.equal(r.suggest_kg, 82, '80 + stepKg(80)=2.0');
  });

  it('trend=progress → increase_progress，加一个步长', () => {
    const r = computeProgression(input({ verdict: 'progress' }));
    assert.equal(r.action, 'increase_progress');
    assert.equal(r.suggest_kg, 61.5);
    assert.equal(r.delta_kg, 1.5);
  });

  it('trend=plateau → increase_plateau（停滞要继续加负荷，不是维持）', () => {
    const r = computeProgression(input({ verdict: 'plateau' }));
    assert.equal(r.action, 'increase_plateau');
    assert.equal(r.suggest_kg, 61.5);
  });

  it('trend=regress → reduce_regress，回退 5% 并向下取刻度', () => {
    const r = computeProgression(input({ verdict: 'regress' }));
    assert.equal(r.action, 'reduce_regress');
    assert.equal(r.suggest_kg, 57, '60 × 0.95 = 57');
    assert.ok(r.delta_kg !== null && r.delta_kg < 0);
  });

  it('trend=unstable / insufficient_data → hold，维持上期', () => {
    for (const v of ['unstable', 'insufficient_data'] as const) {
      const r = computeProgression(input({ verdict: v }));
      assert.equal(r.action, 'hold', v);
      assert.equal(r.suggest_kg, 60);
      assert.equal(r.delta_kg, 0);
    }
  });
});

describe('V5：减量周', () => {
  it('isDeload → deload，重量降到上期 90%（向下取刻度，方向只能是更轻）', () => {
    const r = computeProgression(input({ isDeload: true, verdict: 'progress' }));
    assert.equal(r.action, 'deload');
    assert.equal(r.suggest_kg, 54, '60 × 0.9 = 54');
  });

  it('非 0.5 整数倍时向下取，不会因为取整反而变重', () => {
    const r = computeProgression(input({ isDeload: true, recentWeight: 61 }));
    assert.equal(r.suggest_kg, 54.5, '61 × 0.9 = 54.9 → 向下取到 54.5（而不是 55）');
  });

  it('减量周优先于「上周未达成」的反馈（周期语义 > 单周波动）', () => {
    const r = computeProgression(
      input({ isDeload: true, lastPlan: { targetWeight: 62.5, actualBestWeight: 60 } }),
    );
    assert.equal(r.action, 'deload');
  });

  it('减量周但完全没有重量数据 → 仍走 establish', () => {
    const r = computeProgression(input({ isDeload: true, recentWeight: null, bestWeight: null }));
    assert.equal(r.action, 'establish');
  });
});

describe('V5：上周计划 vs 实际的反哺（V6 → V5）', () => {
  it('上周做了但没到计划重量 → backoff_actual，回到实际做到的水平', () => {
    const r = computeProgression(input({ lastPlan: { targetWeight: 62.5, actualBestWeight: 60 } }));
    assert.equal(r.action, 'backoff_actual');
    assert.equal(r.suggest_kg, 60);
  });

  it('上周压根没做这个动作 → hold（没做不等于做不到）', () => {
    const r = computeProgression(input({ lastPlan: { targetWeight: 62.5, actualBestWeight: null } }));
    assert.equal(r.action, 'hold');
    assert.equal(r.suggest_kg, 60);
  });

  it('上周达成了计划重量 → 继续按趋势递增', () => {
    const r = computeProgression(input({ lastPlan: { targetWeight: 62.5, actualBestWeight: 62.5 } }));
    assert.equal(r.action, 'increase_progress');
    assert.equal(r.suggest_kg, 61.5, '仍以上期实际基准 60 起算');
  });

  it('超额完成（实际 > 计划）同样算达成', () => {
    const r = computeProgression(input({ lastPlan: { targetWeight: 60, actualBestWeight: 65 } }));
    assert.equal(r.action, 'increase_progress');
  });

  it('2% 容差内算达成（吸收磅片换算 / 1.25kg 小片的小差）', () => {
    const r = computeProgression(input({ lastPlan: { targetWeight: 62.5, actualBestWeight: 61.5 } }));
    assert.equal(r.action, 'increase_progress', '61.5 / 62.5 = 98.4% ≥ 98% → 算达成');
  });

  it('上周达成但趋势退步 → 仍按趋势回退（趋势是更长窗口的判断）', () => {
    const r = computeProgression(
      input({ verdict: 'regress', lastPlan: { targetWeight: 60, actualBestWeight: 60 } }),
    );
    assert.equal(r.action, 'reduce_regress');
  });
});

describe('V5：每种 action 都有中文依据', () => {
  it('PROGRESSION_LABEL 覆盖全部取值且非空', () => {
    const actions = [
      'increase_progress',
      'increase_plateau',
      'hold',
      'backoff_actual',
      'reduce_regress',
      'deload',
      'establish',
    ] as const;
    for (const a of actions) {
      assert.ok(PROGRESSION_LABEL[a] && PROGRESSION_LABEL[a].length > 0, a);
    }
  });
});
