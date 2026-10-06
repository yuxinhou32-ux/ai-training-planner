/**
 * 训练基础表单（PRD-v2 V1，§8.1 设置页）。
 *
 * 这是 AI 排计划的**常驻基准值**：一周几练 / 每次时长 / 训练日 / 一周起始日 / 长期目标。
 * 保存后立刻生效 —— 后端不再读报告快照里的旧 goal，排计划直接用当前值。
 *
 * 🔴 用户定案的表单设计：**只留「训练日」一个控件**。
 * 「一周几练」不单独给输入框，而是由选中的天数推导（选 3 天 = 一周 3 练）。
 * 这样「一周 4 练」与「偏好周一/三/五」那种自相矛盾在结构上就不可能出现。
 */
import { useEffect, useState } from 'react';
import { DOW_ORDER_MON_FIRST, DOW_ZH } from '../../api/labels.js';
import { useGoal, useSaveGoal, type GoalPayload } from '../../api/client.js';
import { CollapsibleCard } from '../common/ui.js';

interface FormState {
  days: number[];
  minDur: number;
  maxDur: number;
  weekStartDow: number;
  goalType: string;
}

const EMPTY: FormState = { days: [1, 3, 5, 0], minDur: 60, maxDur: 90, weekStartDow: 1, goalType: '' };

const LONG_TERM_SUGGESTIONS = ['减脂保肌', '增肌', '力量提升', '体态改善'];

/**
 * 早期数据里的英文枚举 → 中文展示（**只在收起态摘要上翻译，不动数据**）。
 *
 * `user_goal.goal_type` 是自由文本（schema 里只有一句注释，没有 CHECK），
 * 早期的种子写过 `fatloss_keep_strength` 这类英文枚举值。收起态的摘要会把它顶到
 * 一级可见位置，直接显示 `fatloss_keep_strength` 太怪，所以这里做一次展示层翻译。
 * 展开后的输入框仍显示库里的原值 —— 用户改一下并保存，就会自然写成中文。
 */
const GOAL_TYPE_ZH: Record<string, string> = {
  fatloss_keep_strength: '减脂保肌',
  hypertrophy: '增肌',
  strength: '力量提升',
  general: '综合提升',
};

function goalTypeZh(v: string): string {
  return GOAL_TYPE_ZH[v] ?? v;
}

function toForm(g: {
  preferredDows: number[];
  minDurationMin: number;
  maxDurationMin: number;
  weekStartDow: number;
  goalType: string;
}): FormState {
  return {
    days: [...g.preferredDows],
    minDur: g.minDurationMin,
    maxDur: g.maxDurationMin,
    weekStartDow: g.weekStartDow,
    goalType: g.goalType,
  };
}

function sameForm(a: FormState, b: FormState): boolean {
  return (
    a.minDur === b.minDur &&
    a.maxDur === b.maxDur &&
    a.weekStartDow === b.weekStartDow &&
    a.goalType === b.goalType &&
    [...a.days].sort((x, y) => x - y).join(',') === [...b.days].sort((x, y) => x - y).join(',')
  );
}

export function GoalForm(): React.ReactNode {
  const goal = useGoal();
  const save = useSaveGoal();
  const [formState, setForm] = useState<FormState | null>(null);
  /** null = 库里还没有生效值（此时任何改动都算「待保存」） */
  const [baseline, setBaseline] = useState<FormState | null>(null);
  const [syncedKey, setSyncedKey] = useState<number | 'none' | null>(null);

  // 只在「生效行变了」时同步表单：保存会插入新行（id 变），于是自动重新同步；
  // 而后台静默 refetch（id 不变）不会覆盖用户正在编辑的内容。
  const goalData = goal.data ?? null;
  const dataKey: number | 'none' | null = goalData ? (goalData.goal?.id ?? 'none') : null;
  const pendingSync = dataKey !== null && dataKey !== syncedKey;
  // 🔴 必须先**在渲染期**派生出一份可用表单，再交给 effect 落进 state：
  // 服务端渲染不执行 effect，若只靠 effect 初始化，SSR 出来的永远是「加载中…」
  // （客户端首帧也会闪一下）。渲染期派生的另一面是首屏就有真实值，可直接断言。
  const derived: FormState | null =
    pendingSync && goalData ? (goalData.goal ? toForm(goalData.goal) : EMPTY) : null;
  const activeForm = derived ?? formState;
  const activeBaseline = derived ? (goalData?.goal ? derived : null) : baseline;

  useEffect(() => {
    if (!pendingSync || derived === null || dataKey === null) return;
    setSyncedKey(dataKey);
    setForm(derived);
    setBaseline(goalData?.goal ? derived : null);
  }, [pendingSync, derived, dataKey, goalData]);

  if (goal.isError) {
    return (
      <CollapsibleCard title="训练基础" summary={<span className="text-rose-600">读取失败</span>}>
        <div className="py-6 text-center text-sm text-rose-600">训练基础读取失败：{String(goal.error)}</div>
      </CollapsibleCard>
    );
  }
  if (goal.isPending || activeForm === null) {
    return (
      <CollapsibleCard title="训练基础" summary="加载中…">
        <div className="py-6 text-center text-sm text-slate-400">加载中…</div>
      </CollapsibleCard>
    );
  }

  const form = activeForm;
  const dirty = activeBaseline === null || !sameForm(form, activeBaseline);
  const durationInvalid = form.maxDur < form.minDur;
  const canSave = dirty && !durationInvalid && !save.isPending;

  const toggleDay = (d: number): void => {
    const has = form.days.includes(d);
    if (has && form.days.length === 1) return; // 至少留一天（后端同样拒绝空数组）
    setForm({ ...form, days: has ? form.days.filter((x) => x !== d) : [...form.days, d] });
  };

  const submit = (): void => {
    const payload: GoalPayload = {
      goal_type: form.goalType.trim(),
      min_duration_min: form.minDur,
      max_duration_min: form.maxDur,
      week_start_dow: form.weekStartDow,
      preferred_dows: form.days,
    };
    save.mutate(payload, {
      onSuccess: (data) => setBaseline(toForm(data.goal)),
    });
  };

  const savedGoalTypeEmpty = form.goalType.trim() === '';
  /** 收起态右侧的「当前值」—— 收起不等于看不见，扫一眼就知道现在是什么设定。 */
  const summary = [
    `一周 ${form.days.length} 练`,
    `每次 ${form.minDur}~${form.maxDur} 分钟`,
    `${DOW_ZH[form.weekStartDow]}起`,
    goalTypeZh(form.goalType.trim()),
  ]
    .filter((s) => s !== '')
    .join(' · ');

  return (
    <CollapsibleCard title="训练基础" summary={summary}>
      <div className="space-y-4">
        {/* 训练日 —— 唯一的输入控件；一周几练由此推导 */}
        <div>
          <div className="mb-2 flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <span className="text-sm font-medium text-slate-800">训练日</span>
            <span className="text-xs text-slate-500">点选周几，选中的天数就是一周几练</span>
          </div>
          <div className="flex flex-wrap gap-2">
            {DOW_ORDER_MON_FIRST.map((d) => {
              const on = form.days.includes(d);
              return (
                <button
                  key={d}
                  type="button"
                  onClick={() => toggleDay(d)}
                  aria-pressed={on}
                  className={
                    'min-w-14 rounded-lg border px-3 py-1.5 text-sm transition ' +
                    (on
                      ? 'border-sky-500 bg-sky-50 font-medium text-sky-700'
                      : 'border-slate-200 bg-white text-slate-600 hover:border-slate-300 hover:bg-slate-50')
                  }
                >
                  {DOW_ZH[d]}
                </button>
              );
            })}
          </div>
          <div className="mt-2 text-sm text-slate-600">
            一周 <span className="font-semibold text-slate-900">{form.days.length}</span> 练
            <span className="mx-2 text-slate-300">·</span>
            每次{' '}
            <span className="font-semibold text-slate-900">{`${form.minDur}~${form.maxDur}`}</span> 分钟
          </div>
        </div>

        {/* 每次时长 */}
        <div>
          <div className="mb-2 text-sm font-medium text-slate-800">每次时长</div>
          <div className="flex flex-wrap items-center gap-2 text-sm text-slate-600">
            <input
              type="number"
              min={10}
              max={300}
              step={5}
              value={form.minDur}
              onChange={(e) => setForm({ ...form, minDur: Number(e.target.value) })}
              className="w-20 rounded-lg border border-slate-200 px-2 py-1.5 text-sm tabular-nums text-slate-800 focus:border-sky-400 focus:outline-none"
            />
            <span className="text-slate-400">~</span>
            <input
              type="number"
              min={10}
              max={600}
              step={5}
              value={form.maxDur}
              onChange={(e) => setForm({ ...form, maxDur: Number(e.target.value) })}
              className="w-20 rounded-lg border border-slate-200 px-2 py-1.5 text-sm tabular-nums text-slate-800 focus:border-sky-400 focus:outline-none"
            />
            <span>分钟</span>
            {durationInvalid && <span className="text-xs text-rose-600">上限不能小于下限</span>}
          </div>
        </div>

        {/* 一周起始日 */}
        <div>
          <div className="mb-2 text-sm font-medium text-slate-800">一周起始日</div>
          <div className="flex gap-2">
            {[
              { v: 1, label: '周一' },
              { v: 0, label: '周日' },
            ].map((o) => {
              const on = form.weekStartDow === o.v;
              return (
                <button
                  key={o.v}
                  type="button"
                  onClick={() => setForm({ ...form, weekStartDow: o.v })}
                  aria-pressed={on}
                  className={
                    'rounded-lg border px-3 py-1.5 text-sm transition ' +
                    (on
                      ? 'border-sky-500 bg-sky-50 font-medium text-sky-700'
                      : 'border-slate-200 bg-white text-slate-600 hover:border-slate-300 hover:bg-slate-50')
                  }
                >
                  {o.label}
                </button>
              );
            })}
          </div>
          <p className="mt-1.5 text-xs text-slate-400">决定「下周计划」从哪天开始算，也决定训练日的排列顺序。</p>
        </div>

        {/* 长期目标 */}
        <div>
          <div className="mb-2 flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <span className="text-sm font-medium text-slate-800">长期目标</span>
            <span className="text-xs text-slate-500">作为 AI 的背景参考，优先级低于周期目标</span>
          </div>
          <input
            type="text"
            maxLength={40}
            value={form.goalType}
            onChange={(e) => setForm({ ...form, goalType: e.target.value })}
            placeholder="例如：减脂保肌"
            className="w-full max-w-xs rounded-lg border border-slate-200 px-2.5 py-1.5 text-sm text-slate-800 placeholder:text-slate-300 focus:border-sky-400 focus:outline-none"
          />
          <div className="mt-2 flex flex-wrap gap-1.5">
            {LONG_TERM_SUGGESTIONS.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setForm({ ...form, goalType: s })}
                className="rounded-md border border-slate-200 px-2 py-0.5 text-xs text-slate-500 hover:border-slate-300 hover:bg-slate-50"
              >
                {s}
              </button>
            ))}
          </div>
        </div>

        {/* 保存 */}
        <div className="flex flex-wrap items-center gap-3 border-t border-slate-100 pt-3">
          <button
            type="button"
            onClick={submit}
            disabled={!canSave || savedGoalTypeEmpty}
            className="rounded-lg bg-sky-600 px-4 py-1.5 text-sm font-medium text-white transition hover:bg-sky-700 disabled:cursor-not-allowed disabled:bg-slate-200 disabled:text-slate-400"
          >
            {save.isPending ? '保存中…' : '保存'}
          </button>

          {!dirty && !save.isSuccess && <span className="text-xs text-slate-400">与当前生效值一致</span>}
          {savedGoalTypeEmpty && <span className="text-xs text-rose-600">长期目标不能为空</span>}

          {save.isError && <span className="text-xs text-rose-600">保存失败：{String(save.error)}</span>}
          {save.isSuccess && !dirty && (
            <span className="text-xs text-emerald-600">已保存并生效</span>
          )}
        </div>
      </div>
    </CollapsibleCard>
  );
}
