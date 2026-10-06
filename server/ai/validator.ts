/**
 * 防幻觉校验（M20，§5.6）。AI 输出写入数据库前必须通过 V1~V5。
 *
 * - V5（schema strict 校验）由 zod planDraftSchema 完成，不在此重复；
 *   zod 的 maxItems(15)/max(20) 同时覆盖了 V4 表中的写侧上限两条。
 * - V2 超限不浪费重试：直接钳制到 ±10% 并记录（§5.6.1 V2 注）。
 * - V4 分 BLOCK / WARN 两类（§5.6.2）：WARN 仅时长一类，熔断时可放行。
 * - A3 的解释输出单独走 validateExplanation（basis / 依据不足 纪律）。
 */
import type { AnalysisReport, CandidatePoolItem, GoalConstraints, HardRule } from '../analysis/reportSchema.js';
import type { PlanInputDigest } from './digest.js';
import type {
  PlanDraft,
  PlanExplanation,
  Violation,
  ViolationCheck,
} from './schemas.js';

/**
 * V3 可解析性索引。
 *
 * `evidence_refs` 的 ref 只能指向「AI 这份输入里真实存在的东西」——旧版直接拿整份
 * AnalysisReport 做主表，V3 之后 AI 的输入是摘要层（digest），所以这里把它抽成一个
 * 只含三组 id 的索引，两种来源各有一个适配器。
 */
export interface RefIndex {
  movementIds: ReadonlySet<string>;
  muscleCodes: ReadonlySet<string>;
  findingCodes: ReadonlySet<string>;
}

export function refIndexFromDigest(d: PlanInputDigest): RefIndex {
  return {
    movementIds: new Set(d.candidate_pool.map((p) => String(p.catalog_id))),
    muscleCodes: new Set(d.profile.muscles.map((m) => m.code)),
    findingCodes: new Set(d.findings.map((f) => f.code)),
  };
}

export function refIndexFromReport(r: AnalysisReport): RefIndex {
  return {
    movementIds: new Set((r.movement_trends ?? []).map((t) => String(t.catalog_id))),
    muscleCodes: new Set((r.muscle_trends ?? []).map((t) => t.muscle_code)),
    findingCodes: new Set((r.findings ?? []).map((f) => f.code)),
  };
}

export interface ValidateContext {
  pool: CandidatePoolItem[];
  /** 只读 goal 与 hard_rules 两项（soft_rules 不参与校验）。 */
  constraints: { goal: GoalConstraints | null; hard_rules: HardRule[] };
  refs: RefIndex;
  /**
   * V12：今天（YYYY-MM-DD）。传了才启用「不得排过去日期」校验。
   * 起始周（残缺周）时，AI 容易把已过的训练日也排上 —— prompt 已经交代，
   * 这里是服务端兜底（`DATE_IN_PAST` → 走纠错重试，而不是静默写入一条昨天的计划）。
   */
  todayStr?: string;
}

/**
 * 候选池条目 + V5 的本地建议重量。
 *
 * `ValidateContext.pool` 声明的仍是 `CandidatePoolItem[]`（摘要层条目结构兼容，可直接传），
 * 这里把 `progression` 当**可选**字段读 —— 不带的夹具/老调用自动回退到 `last_weight`。
 */
type PoolItemWithAdvice = CandidatePoolItem & { progression?: { suggest_kg: number | null } };

export interface ValidateOutcome {
  violations: Violation[];
  /** 可能含 V2 钳制后的重量（与入参非同一对象时才替换）。 */
  draft: PlanDraft;
  /** V2 钳制记录（审计，不算违规）。 */
  clamped: string[];
}

function v(check: ViolationCheck, level: 'BLOCK' | 'WARN', code: string, message: string): Violation {
  return { check, level, code, message };
}

/** ref 形如 "movement_trend:812"；返回 [kind, id 部分]。 */
function parseRef(ref: string): [string, string] {
  const i = ref.indexOf(':');
  return i === -1 ? [ref, ''] : [ref.slice(0, i), ref.slice(i + 1)];
}

/** V3 的 ref 可解析性（§5.6.1）：structure/basic_stat/generic 为自由文本，宽松通过。 */
function refResolvable(type: string, ref: string, refs: RefIndex): boolean {
  const [kind, id] = parseRef(ref);
  switch (type) {
    case 'movement_trend':
      return kind === 'movement_trend' && refs.movementIds.has(id);
    case 'muscle_trend':
      return kind === 'muscle_trend' && refs.muscleCodes.has(id);
    case 'finding':
      return kind === 'finding' && refs.findingCodes.has(id);
    case 'structure':
    case 'basic_stat':
    case 'generic':
      return true;
    default:
      return false;
  }
}

export function validateDraft(draft: PlanDraft, ctx: ValidateContext): ValidateOutcome {
  const { pool, constraints, refs } = ctx;
  const violations: Violation[] = [];
  const clamped: string[] = [];

  const poolById = new Map<number, CandidatePoolItem>(pool.map((p) => [p.catalog_id, p]));
  const goal = constraints.goal;
  const rules = constraints.hard_rules ?? [];

  // ---- V1 白名单：catalog_id 存在且 name 逐字相等（防脏数据的最后一道闸） ----
  for (const day of draft.days) {
    for (const ex of day.exercises) {
      const item = poolById.get(ex.catalog_id);
      if (!item) {
        violations.push(v('V1', 'BLOCK', 'CATALOG_NOT_IN_POOL', `动作 ${ex.name}(catalog_id=${ex.catalog_id}) 不在候选池`));
        continue;
      }
      if (ex.name !== item.name) {
        violations.push(
          v('V1', 'BLOCK', 'NAME_NOT_VERBATIM', `动作名不逐字：输出"${ex.name}" vs 池内"${item.name}"（catalog_id=${ex.catalog_id}）`),
        );
      }
    }
  }

  // ---- V2 数值溯源：围绕「本周建议重量」±10% 内；超限钳制并记录；无重量基准必须有依据 ----
  //
  // V5 改动：基准从 `item.last_weight`（**历史最佳**）换成 `progression.suggest_kg`（**本地算好的本周建议**）。
  // 为什么必须换：历史最佳会把进步空间锁死。实测场景 —— 90 天前最高 100kg，近 2 周实际只用 60kg，
  // 本地按趋势算出建议 61.5kg（+1.5）；若仍拿 100kg 当基准，61.5kg 会被判成「低于基准 38.5%」
  // 直接钳到 90kg —— 等于让 AI 跳过四个月的恢复过程，还可能压伤人。
  const clampedDraft: PlanDraft = {
    ...draft,
    days: draft.days.map((day) => ({
      ...day,
      exercises: day.exercises.map((ex) => {
        const item = poolById.get(ex.catalog_id);
        if (!item) return ex;
        if (ex.weight_kg !== null && ex.weight_kg !== undefined) {
          const baseline = (item as PoolItemWithAdvice).progression?.suggest_kg ?? item.last_weight;
          if (baseline !== null && baseline > 0) {
            const ratio = Math.abs(ex.weight_kg - baseline) / baseline;
            if (ratio > 0.1) {
              const capped = ex.weight_kg > baseline ? baseline * 1.1 : baseline * 0.9;
              const fixed = Math.round(capped * 100) / 100;
              clamped.push(`${ex.name}: ${ex.weight_kg}kg 超出本周建议 ${baseline}kg ±10%，钳制为 ${fixed}kg`);
              return { ...ex, weight_kg: fixed };
            }
          } else if (baseline === null) {
            if (ex.weight_source !== 'estimate' || !ex.why.includes('估计')) {
              violations.push(
                v('V2', 'BLOCK', 'WEIGHT_WITHOUT_HISTORY', `${ex.name} 无历史重量但给出了 ${ex.weight_kg}kg；weight_source 必须为 estimate 且 why 含"估计"`),
              );
            }
          }
        }
        return ex;
      }),
    })),
  };

  // ---- V3 evidence 完整性（day 级）：refs 非空 + ref 可解析 ----
  for (const day of clampedDraft.days) {
    if (day.why.evidence_refs.length === 0) {
      violations.push(v('V3', 'BLOCK', 'EMPTY_EVIDENCE_REFS', `训练日 ${day.datestr} 的 why.evidence_refs 为空`));
    }
    for (const ref of day.why.evidence_refs) {
      if (!refResolvable(ref.type, ref.ref, refs)) {
        violations.push(v('V3', 'BLOCK', 'REF_UNRESOLVABLE', `训练日 ${day.datestr} 引用不可解析：type=${ref.type} ref=${ref.ref}`));
      }
    }
  }

  // ---- V4 硬约束（§5.6.2） ----
  const allExercises = clampedDraft.days.flatMap((d) => d.exercises);

  if (goal) {
    if (clampedDraft.days.length !== goal.sessions_per_week) {
      violations.push(
        v('V4', 'BLOCK', 'DAY_COUNT_MISMATCH', `训练日数 ${clampedDraft.days.length} ≠ 目标 ${goal.sessions_per_week}`),
      );
    }
  }

  for (const rule of rules) {
    if (rule.target_type !== 'movement') continue;
    const name = typeof rule.target_value === 'string' ? rule.target_value : null;
    if (name === null) continue;
    if (rule.kind === 'keep') {
      const hit = allExercises.some((ex) => ex.name === name);
      if (!hit) violations.push(v('V4', 'BLOCK', 'KEEP_MISSING', `keep 动作「${name}」未出现在计划中`));
    }
    if (rule.kind === 'avoid' || rule.kind === 'dislike') {
      const hit = allExercises.find((ex) => ex.name === name);
      if (hit) violations.push(v('V4', 'BLOCK', 'FORBIDDEN_MOVEMENT', `avoid/dislike 动作「${name}」出现在 ${hit.name}`));
    }
  }

  for (const rule of rules) {
    if (rule.kind !== 'limit_load' || rule.target_type !== 'joint') continue;
    const maxLevel = Number((rule.param as Record<string, unknown> | undefined)?.max_joint_stress_level);
    if (!Number.isFinite(maxLevel)) continue;
    const joint = String(rule.target_value);
    for (const ex of allExercises) {
      const item = poolById.get(ex.catalog_id);
      const flag = item?.joint_flags?.find((f) => f.joint === joint);
      if (flag && flag.level > maxLevel) {
        violations.push(
          v('V4', 'BLOCK', 'JOINT_STRESS_EXCEEDED', `${ex.name} 的 ${joint} 压力等级 ${flag.level} 超过上限 ${maxLevel}`),
        );
      }
    }
  }

  for (const rule of rules) {
    if (rule.kind !== 'limit_volume' || rule.target_type !== 'muscle') continue;
    const maxSets = Number((rule.param as Record<string, unknown> | undefined)?.max_weekly_sets);
    if (!Number.isFinite(maxSets)) continue;
    const muscle = String(rule.target_value);
    const total = allExercises
      .filter((ex) => poolById.get(ex.catalog_id)?.primary_muscles.includes(muscle))
      .reduce((sum, ex) => sum + ex.sets, 0);
    if (total > maxSets) {
      violations.push(v('V4', 'BLOCK', 'VOLUME_EXCEEDED', `肌群 ${muscle} 周组数 ${total} 超过上限 ${maxSets}`));
    }
  }

  // ---- V4 附加：日期必须落在 [week_start, week_end] 区间（防 AI 给出漂移日期） ----
  for (const day of clampedDraft.days) {
    if (day.datestr < draft.week_start || day.datestr > draft.week_end) {
      violations.push(
        v('V4', 'BLOCK', 'DATE_OUT_OF_RANGE', `训练日 ${day.datestr} 不在计划周 ${draft.week_start}~${draft.week_end} 内`),
      );
    }
    // V12：起始周（残缺周）不得排「今天与之前」—— 与 PlanConfirm 的写回窗口同一条红线。
    // 只在调用方传了 todayStr 时启用，老调用与夹具行为不变。
    if (ctx.todayStr !== undefined && day.datestr <= ctx.todayStr) {
      violations.push(
        v('V4', 'BLOCK', 'DATE_IN_PAST', `训练日 ${day.datestr} 已过去（今天 ${ctx.todayStr}）；本周只剩 ${ctx.todayStr} 之后的日期可排`),
      );
    }
  }

  // ---- V4 附加：同一天不得出现两个训练日 ----
  // 这里挡的不是「模型粗心」，而是数据库层会直接炸：plan_day 有 UNIQUE(plan_id, datestr)，
  // 一旦重复日期落库就是 500（实测踩过：AI 被要求排 4 天但只给了 3 个训练日，
  // 第 4 天日期就落回了周起始日，与第 1 天同日期）。放在校验里 → 走纠错重试而不是崩。
  const seenDates = new Set<string>();
  for (const day of clampedDraft.days) {
    if (seenDates.has(day.datestr)) {
      violations.push(v('V4', 'BLOCK', 'DUPLICATE_DATE', `训练日日期重复：${day.datestr}`));
    }
    seenDates.add(day.datestr);
  }

  if (goal) {
    const range: [number, number] = [goal.min_duration_min, goal.max_duration_min];
    for (const day of clampedDraft.days) {
      if (day.est_duration_min < range[0] || day.est_duration_min > range[1]) {
        violations.push({
          check: 'V4',
          level: 'WARN',
          code: 'DURATION_OUT_OF_RANGE',
          message: `训练日 ${day.datestr} 预计 ${day.est_duration_min} 分钟，超出 ${range[0]}~${range[1]} 区间`,
          detail: { datestr: day.datestr, value: day.est_duration_min, range },
        });
      }
    }
  }

  return { violations, draft: clampedDraft, clamped };
}

/**
 * A3 解释输出的校验（§5.4 纪律 + V3 精神）：
 * - basis=data 的 exercise 必须带可解析 evidence_refs；
 * - basis=generic_principle 的 why 必须含「依据不足」；
 * - day 级 evidence_refs 的 ref 必须可解析。
 */
export function validateExplanation(explanation: PlanExplanation, refs: RefIndex): Violation[] {
  const violations: Violation[] = [];
  for (const day of explanation.days) {
    for (const ref of day.evidence_refs) {
      if (!refResolvable(ref.type, ref.ref, refs)) {
        violations.push(v('V3', 'BLOCK', 'REF_UNRESOLVABLE', `解释引用不可解析：type=${ref.type} ref=${ref.ref}`));
      }
    }
    for (const ex of day.exercises) {
      if (ex.basis === 'generic_principle') {
        if (!ex.why.includes('依据不足')) {
          violations.push(v('V3', 'BLOCK', 'GENERIC_BASIS_UNDISCLOSED', `ord=${ex.ord} 声明 generic_principle 但 why 未含「依据不足」`));
        }
      } else if ((ex.evidence_refs?.length ?? 0) === 0) {
        violations.push(v('V3', 'BLOCK', 'EMPTY_EVIDENCE_REFS', `ord=${ex.ord} basis=data 但 evidence_refs 为空`));
      }
    }
  }
  return violations;
}
