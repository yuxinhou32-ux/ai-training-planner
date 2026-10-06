/**
 * 一周分化表（周练次数 → 各训练日的目标肌群）。
 *
 * 为什么独立成模块：它同时被两处使用，语义必须只有一份。
 *   · `plan/template.ts`  规则模板按它分配每个训练日练什么
 *   · `ai/digest.ts`      摘要层按它算「本周需要覆盖的肌群」与「每个肌群出现在几天」，
 *                         据此决定候选池给每个肌群留几个名额
 * 若两边各写一份，池子会按一套需求挑、模板按另一套需求取，就会出现
 * 「池子里动作不少，但要练的那天一个都挑不出来」（实测过的第 4 天只剩 1 个动作）。
 */

/** day_type → 目标肌群（按优先级排序；第一个是主肌群）。 */
export const SPLITS: Record<number, Array<{ day_type: string; muscles: string[] }>> = {
  // 设置页的训练日范围是 1~7（schema CHECK），所以每个取值都要有对应分化，
  // 否则 pickMovements 会循环复用某个分化、天数与用户设定不符。
  1: [{ day_type: '全身', muscles: ['quads', 'chest', 'back_lats', 'glutes'] }],
  2: [
    { day_type: '全身', muscles: ['quads', 'chest', 'back_lats'] },
    { day_type: '全身', muscles: ['glutes', 'back_lats', 'shoulder_front'] },
  ],
  3: [
    { day_type: '下肢力量', muscles: ['quads', 'hamstrings', 'glutes'] },
    { day_type: '上肢推', muscles: ['chest', 'shoulder_front', 'triceps'] },
    { day_type: '上肢拉', muscles: ['back_lats', 'back_upper', 'biceps'] },
  ],
  4: [
    { day_type: '下肢力量', muscles: ['quads', 'hamstrings', 'glutes'] },
    { day_type: '上肢推', muscles: ['chest', 'shoulder_front', 'triceps'] },
    { day_type: '上肢拉', muscles: ['back_lats', 'back_upper', 'biceps'] },
    { day_type: '全身', muscles: ['glutes', 'chest', 'back_lats'] },
  ],
  5: [
    { day_type: '下肢力量', muscles: ['quads', 'hamstrings', 'glutes'] },
    { day_type: '上肢推', muscles: ['chest', 'shoulder_front', 'triceps'] },
    { day_type: '上肢拉', muscles: ['back_lats', 'back_upper', 'biceps'] },
    { day_type: '下肢力量', muscles: ['glutes', 'quads', 'core'] },
    { day_type: '上肢力量', muscles: ['shoulder_front', 'back_upper', 'biceps', 'triceps'] },
  ],
  6: [
    { day_type: '下肢力量', muscles: ['quads', 'hamstrings', 'glutes'] },
    { day_type: '上肢推', muscles: ['chest', 'shoulder_front', 'triceps'] },
    { day_type: '上肢拉', muscles: ['back_lats', 'back_upper', 'biceps'] },
    { day_type: '下肢力量', muscles: ['glutes', 'quads', 'hamstrings'] },
    { day_type: '上肢推', muscles: ['chest', 'shoulder_front', 'shoulder_side'] },
    { day_type: '上肢拉', muscles: ['back_lats', 'back_upper', 'biceps', 'forearm'] },
  ],
  7: [
    { day_type: '下肢力量', muscles: ['quads', 'hamstrings', 'glutes'] },
    { day_type: '上肢推', muscles: ['chest', 'shoulder_front', 'triceps'] },
    { day_type: '上肢拉', muscles: ['back_lats', 'back_upper', 'biceps'] },
    { day_type: '下肢力量', muscles: ['glutes', 'quads', 'hamstrings'] },
    { day_type: '上肢推', muscles: ['chest', 'shoulder_front', 'shoulder_side'] },
    { day_type: '上肢拉', muscles: ['back_lats', 'back_upper', 'forearm'] },
    { day_type: '核心与薄弱项', muscles: ['core', 'glutes', 'biceps', 'triceps'] },
  ],
};

/** 取 n 练的分化；n 越界时退回 3 练（与模板旧行为一致）。 */
export function splitFor(sessions: number): Array<{ day_type: string; muscles: string[] }> {
  return SPLITS[sessions] ?? SPLITS[3];
}

/**
 * 本周分化真正会用到的肌群 → 出现在几个训练日。
 *
 * 出现 2 天以上的肌群（如 4 练里的 glutes/chest/back_lats：下肢+全身 / 上肢推+全身 /
 * 上肢拉+全身）需要更多候选动作——因为同一个动作不会在一周里排两次，
 * 「两个训练日都要用 glutes 的动作」实际需要的是两批不同的动作。
 */
export function muscleDayDemand(sessions: number): Map<string, number> {
  const demand = new Map<string, number>();
  for (const spec of splitFor(sessions)) {
    for (const muscle of spec.muscles) demand.set(muscle, (demand.get(muscle) ?? 0) + 1);
  }
  return demand;
}
