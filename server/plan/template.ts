/**
 * 规则模板计划（§5.7 降级路径）。
 *
 * 三种触发：AI 不可用 / 3 次后仍有 V4-BLOCK / 用户手动点「用规则模板生成」。
 * 确定性算法，100% 满足 V1~V4（keep 显式排入、avoid 已被池过滤剔除）；
 * 所有 why 强制 generic_principle 措辞（含「依据不足」），UI 标注「非 AI 生成」。
 */
import { filterCandidatePool } from '../ai/poolFilter.js';
import type { PlanCycleContext, PlanDraft, PlanTemplate } from '../ai/schemas.js';
import type { CandidatePoolItem, Constraints } from '../analysis/reportSchema.js';
import { splitFor } from './splits.js';
import { PROGRESSION_LABEL, type ProgressionAdvice } from './progression.js';

const GENERIC_WHY = '依据不足，按通用训练原则建议';
const DEFAULT_DOWS = [1, 3, 5, 6, 0, 2, 4]; // 周一起偏好：一三五六十日二

/**
 * 模板路径的池条目。
 *
 * 生产路径传的是摘要层的池（已带 `progression`）；老测试夹具不带 → 回退到 `last_weight`，
 * 行为与 V5 之前一致。
 */
type TemplatePoolItem = CandidatePoolItem & { progression?: ProgressionAdvice };

function addDays(datestr: string, n: number): string {
  const d = new Date(`${datestr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function dowOf(datestr: string): number {
  return new Date(`${datestr}T00:00:00Z`).getUTCDay();
}

/**
 * 给一个训练日挑动作。
 *
 * 三级取法，为的是「任何情况下都不出一个只有 1~2 个动作的训练日」：
 *   ① 目标肌群内、本周还没用过的动作（正常路径）；
 *   ② 目标肌群挑不满 → 池子里任何还没用过的动作（典型场景：4 练里第 4 天是「全身」，
 *      而 glutes/chest/back_lats 的动作已被前三天用完；此时用核心/小腿等没练到的部位补位，
 *      比留一个空训练日好得多，也顺手补上「该练没练到」的部位）；
 *   ③ 整个池子都用过了（池子极小或 6~7 练）→ 允许复用本周已排过的动作，
 *      宁可重复一个动作，也不给用户一个残缺的训练日。
 */
function pickMovements(
  muscles: string[],
  pool: TemplatePoolItem[],
  usedIds: Set<number>,
  keepFirst: Map<string, TemplatePoolItem>,
  count: number,
): TemplatePoolItem[] {
  const picked: TemplatePoolItem[] = [];
  // keep 动作优先进入与其主肌群匹配的训练日
  for (const muscle of muscles) {
    const keepItem = keepFirst.get(muscle);
    if (keepItem && !usedIds.has(keepItem.catalog_id) && !picked.includes(keepItem)) {
      picked.push(keepItem);
      usedIds.add(keepItem.catalog_id);
      break;
    }
  }
  const score = (m: TemplatePoolItem): number =>
    (m.used_recently ? 0 : 1) + (m.mapping_confidence === 'low' ? 10 : 0) + (m.last_weight === null ? 2 : 0);
  const unused = pool.filter((m) => !usedIds.has(m.catalog_id) && !picked.includes(m));
  const fill = (candidates: TemplatePoolItem[]): void => {
    for (const m of candidates) {
      if (picked.length >= count) return;
      if (picked.includes(m)) continue;
      picked.push(m);
      usedIds.add(m.catalog_id);
    }
  };

  fill(
    unused
      .filter((m) => muscles.some((mu) => m.primary_muscles.includes(mu)))
      .sort((a, b) => score(a) - score(b)),
  );
  if (picked.length < count) fill([...unused].sort((a, b) => score(a) - score(b)));
  if (picked.length < count) {
    fill(pool.filter((m) => !picked.includes(m)).sort((a, b) => score(a) - score(b)));
  }
  return picked;
}

/**
 * 生成一周规则模板草稿。
 * @param weekStart 计划周起始（周一/周日，由训练基础决定）
 * @param rawPool 候选池（V3 起由摘要层精选，与 AI 路径同一份）
 * @param cycle 周期上下文；`isDeload` 为真时按减量周处理（容量减半、强度 −12.5%）
 */
export function buildTemplateDraft(
  weekStart: string,
  rawPool: TemplatePoolItem[],
  constraints: Constraints,
  cycle: PlanCycleContext | null = null,
  /**
   * V12：起始周（残缺周）过滤。
   * 传了 `today` 时，**早于「明天」的训练日不再排** —— 用户周三才打开软件、
   * 训练日周二/周四，就只排周四，不生成一条落在昨天的计划。
   * 不传 = 老行为（整周都排），保持既有调用与测试夹具不变。
   */
  today?: string,
): PlanDraft {
  const goal = constraints.goal;
  // 范围与 user_goal.sessions_per_week 的 CHECK 一致（1~7）；旧代码硬夹到 2~5，
  // 导致用户选 6 天时模板只排 5 天、选 1 天时排 2 天 —— 与设定不符。
  //
  // 🔴 一周几练以「选中的训练日」为准（设置页就是这么推导的）。两者若不一致（历史数据），
  // 以训练日为准：否则多出来的那天会被 DEFAULT_DOWS 塞到用户没选的星期（实测排到过周六）。
  const preferredAll = goal?.preferred_dows ?? [];

  // V12：先按「还没过去」筛一遍训练日（起始周才需要；完整周全部保留）。
  // 判据与 `remainingTrainingDows` 同源：只留日期 > 今天的那些 dow。
  const tomorrow = today === undefined ? null : addDays(today, 1);
  const preferred =
    tomorrow === null
      ? preferredAll
      : preferredAll.filter((d) => {
          // 找该 dow 落在本周的日期，看它是否 >= 明天
          for (let off = 0; off < 7; off++) {
            const day = addDays(weekStart, off);
            if (dowOf(day) !== d) continue;
            return day >= tomorrow;
          }
          return false;
        });

  const sessions = Math.max(
    1,
    Math.min(7, preferred.length > 0 ? preferred.length : (goal?.sessions_per_week ?? 3)),
  );
  const deload = cycle?.isDeload === true;
  const { filtered } = filterCandidatePool(rawPool, constraints);

  // keep 动作映射：主肌群 → 池条目（强制排入）
  const keepFirst = new Map<string, CandidatePoolItem>();
  for (const r of constraints.hard_rules ?? []) {
    if (r.kind !== 'keep' || r.target_type !== 'movement' || typeof r.target_value !== 'string') continue;
    const item = filtered.find((m) => m.name === r.target_value);
    if (item) for (const mu of item.primary_muscles) if (!keepFirst.has(mu)) keepFirst.set(mu, item);
  }

  const dows = (preferred.length > 0 ? preferred : DEFAULT_DOWS).slice(0, sessions);
  const split = splitFor(sessions);
  const usedIds = new Set<number>();
  const days: PlanDraft['days'] = [];

  for (let i = 0; i < sessions; i++) {
    const targetDow = dows[i] ?? DEFAULT_DOWS[i];
    // 从 weekStart（周一）向后找到 targetDow 当天
    let datestr = weekStart;
    for (let off = 0; off < 7; off++) {
      if (dowOf(addDays(weekStart, off)) === targetDow) {
        datestr = addDays(weekStart, off);
        break;
      }
    }
    // V12 双保险：万一落到过去（preferred 已被筛过，这里防 DEFAULT_DOWS 兜底路径），跳过。
    if (tomorrow !== null && datestr < tomorrow) continue;
    const spec = split[i % split.length];
    const movements = pickMovements(spec.muscles, filtered, usedIds, keepFirst, 4);

    const exercises = movements.map((m, ord) => {
      const isMain = ord === 0;
      // 容量：减量周减半（PRD §5「容量减半」）
      const baseSets = isMain ? 4 : 3;
      const sets = deload ? Math.max(1, Math.round(baseSets / 2)) : baseSets;
      // 重量优先取摘要层算好的建议值（V5；减量周的 −10% 也已算在里面）。
      // 池子不带 progression 时（老调用 / 测试夹具）自己兜底算减量 ——
      // 「周期第 4 周一定变轻」是 PRD 的硬语义，不能因为少传一个字段就悄悄失效。
      const weight = m.progression
        ? m.progression.suggest_kg
        : deload && m.last_weight !== null
          ? Math.floor(m.last_weight * 0.9 * 2) / 2
          : m.last_weight;
      const basis = m.progression ? PROGRESSION_LABEL[m.progression.action] : GENERIC_WHY;
      return {
        ord: ord + 1,
        catalog_id: m.catalog_id,
        name: m.name,
        sets,
        reps: isMain ? 8 : 12,
        weight_kg: weight,
        weight_source: weight === null ? ('estimate' as const) : ('history_best' as const),
        rest_s: isMain ? 120 : 60,
        is_cardio: false,
        record_preset: null,
        why:
          weight === null
            ? `${GENERIC_WHY}（无历史重量，本次只建立基线）`
            : deload
              ? `${GENERIC_WHY}（${basis}；本周期第 ${cycle?.totalWeeks ?? 4} 周为减量周，容量减半）`
              : `${GENERIC_WHY}（${basis}）`,
      };
    });

    const totalSets = exercises.reduce((s, e) => s + e.sets, 0);
    const est = Math.max(goal?.min_duration_min ?? 45, Math.min(goal?.max_duration_min ?? 90, 10 + totalSets * 3));
    days.push({
      datestr,
      day_type: spec.day_type,
      title: deload ? `${spec.day_type}（模板·减量周）` : `${spec.day_type}（模板）`,
      target_muscles: spec.muscles,
      est_duration_min: est,
      exercises,
      why: {
        summary: deload
          ? `规则模板（减量周）：${spec.day_type}，容量减半、强度 −12.5%，让身体吸收前几周的进步；非 AI 生成。`
          : `规则模板：${spec.day_type}，按 ${spec.muscles.join('/')} 分配主项与辅助；非 AI 生成。`,
        evidence_refs: [{ type: 'generic', ref: 'generic:template', text: '规则模板生成，无数据驱动决策' }],
      },
    });
  }

  return {
    week_start: weekStart,
    week_end: addDays(weekStart, 6),
    days,
  };
}

/**
 * AI 不可用时的**模板兜底**：机械平移上一周那份计划（docs/plan-template-reuse.md §4-B）。
 *
 * 和 `buildTemplateDraft`（从候选池重新挑动作）的区别：这里**结构完全照搬**，
 * 用户看到的还是自己上周那套动作 —— 只是日期换到本周、重量换成系统算好的本周建议值。
 *
 * ⚠️ 诚实标注：**没有 AI 参与，所以本周特殊情况没被处理**。UI 上必须说清，
 *    不能让用户以为有人判断过「经期第三天最难受」。减容按统一比例也做不到 ——
 *    干脆不做，让用户自己看着改（草稿本来就可以手改）。
 *
 * 不做的事：不改组数、不换动作、不排序、不判有氧。日期已由 `buildTemplateDigest` 平移好。
 */
export function buildDraftFromCycleTemplate(
  weekStart: string,
  template: PlanTemplate,
  constraints: Constraints,
): PlanDraft {
  const goal = constraints.goal;
  const minDur = goal?.min_duration_min ?? 45;
  const maxDur = goal?.max_duration_min ?? 90;
  const srcLabel = `第 ${template.source_week_no} 周`;

  const days: PlanDraft['days'] = template.days.map((d) => {
    const exercises = d.exercises.map((e, i) => {
      const weight = e.suggest_kg;
      return {
        ord: i + 1,
        catalog_id: e.catalog_id,
        name: e.name,
        sets: e.sets,
        reps: e.reps,
        weight_kg: weight,
        weight_source: weight === null ? ('estimate' as const) : ('history_best' as const),
        rest_s: e.rest_s,
        is_cardio: e.is_cardio,
        record_preset: null,
        why:
          weight === null
            ? `${GENERIC_WHY}（沿用${srcLabel}模板；该动作无历史重量，本次只建立基线）`
            : `${GENERIC_WHY}（沿用${srcLabel}模板，重量为本系统算出的本周建议值）`,
      };
    });
    const totalSets = exercises.reduce((s, e) => s + e.sets, 0);
    return {
      datestr: d.datestr,
      day_type: d.day_type,
      title: `${d.title}（沿用${srcLabel}）`,
      target_muscles: d.target_muscles,
      est_duration_min: Math.max(minDur, Math.min(maxDur, 10 + totalSets * 3)),
      exercises,
      why: {
        summary: `规则兜底：整体沿用${srcLabel}的动作结构，重量换成系统算好的本周建议值。⚠️ 本次没有 AI 参与，本周特殊情况没有被处理，请自行核对组数与强度。`,
        evidence_refs: [
          { type: 'generic' as const, ref: 'generic:cycle_template', text: `沿用第 ${template.source_week_no} 周计划的结构，非 AI 生成` },
        ],
      },
    };
  });

  return { week_start: weekStart, week_end: addDays(weekStart, 6), days };
}
