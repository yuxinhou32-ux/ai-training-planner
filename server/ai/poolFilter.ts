/**
 * 三段式之①：candidate_pool 物理前置过滤（§5.3）。
 *
 * 「AI 看不到违禁动作」是硬约束注入的第一道，比 prompt 里写一句「禁止 XX」可靠得多。
 * 单独成模块（v3）：gateway / 规则模板 / 摘要层（digest）三处都要用同一条过滤，
 * 放在 gateway 里会让 digest → gateway 形成循环依赖。
 */
import type { HardRule } from '../analysis/reportSchema.js';

/** 过滤只读 hard_rules 一个字段，因此不要求调用方给完整 Constraints（soft_rules 用不上）。 */
export interface PoolFilterConstraints {
  hard_rules?: HardRule[];
}

interface FilterableMovement {
  name: string;
  joint_flags?: Array<{ joint: string; level: number }>;
}

/** 泛型保留调用方的元素类型（摘要层的池子过滤后仍是摘要层的类型）。 */
export function filterCandidatePool<T extends FilterableMovement>(
  pool: T[],
  constraints: PoolFilterConstraints,
): { filtered: T[]; note: string } {
  const avoidNames = new Set<string>();
  const jointLimits = new Map<string, number>();
  for (const r of constraints.hard_rules ?? []) {
    if ((r.kind === 'avoid' || r.kind === 'dislike') && r.target_type === 'movement' && typeof r.target_value === 'string') {
      avoidNames.add(r.target_value);
    }
    if (r.kind === 'limit_load' && r.target_type === 'joint') {
      const max = Number((r.param as Record<string, unknown> | undefined)?.max_joint_stress_level);
      if (Number.isFinite(max)) jointLimits.set(String(r.target_value), max);
    }
  }
  const excluded: string[] = [];
  const filtered = pool.filter((item) => {
    if (avoidNames.has(item.name)) {
      excluded.push(`${item.name}（avoid/dislike）`);
      return false;
    }
    for (const [joint, max] of jointLimits) {
      const flag = item.joint_flags?.find((f) => f.joint === joint);
      if (flag && flag.level > max) {
        excluded.push(`${item.name}（${joint} 压力 ${flag.level} > ${max}）`);
        return false;
      }
    }
    return true;
  });
  const note =
    excluded.length > 0
      ? `以下动作因违反硬约束已被系统移出候选池，你不需要也不得使用它们：${excluded.join('、')}。`
      : '本次没有动作因硬约束被移除。';
  return { filtered, note };
}
