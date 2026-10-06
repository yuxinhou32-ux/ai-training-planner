/**
 * 首次使用引导弹窗 —— 2026-10-06 新增（方案见 docs/onboarding-plan.md）。
 *
 * 价值不是「帮他填表单」，而是**告诉他顺序**：先配 Key 才有数据，先有目标才能排计划。
 * 设置页 7 个区块全部默认收起，新用户看不出该先填哪个。
 *
 * 🔴 硬约束（项目已经吃过一次亏，见 src/pages/Settings.tsx:9-11 的注释）：
 *    弹窗**绝不自建写路径**，三步分别调用既有的
 *    `useSaveXunjiConfig` / `useSaveGoal` / `useSaveBody` —— 「两个地方能改同一个东西，
 *    正是『说不清哪个才算数』的来源」。本文件里没有任何 fetch。
 *
 * 🔴 完成位写入时机：**任何退出路径**（完成 / 跳过 / X / ESC / 点遮罩）都写 `done = true`，
 *    只在整体退出时写一次 —— 每步成功就写会让「第 2 步后关页面」导致第 3 步再也不弹。
 *
 * 不做可持久化的常驻形态（用户对视图形开关敏感）：「办完事就走」。
 * 「重新运行首次引导」只做前端强制打开（`reopenOnboarding`），不改服务端完成位。
 */
import { useEffect, useState } from 'react';
import {
  AGE_RANGE,
  GENDERS,
  HEIGHT_RANGE,
  TRAINING_YEARS,
  useCompleteOnboarding,
  useGoal,
  useJobsRecent,
  useOnboarding,
  useSaveBody,
  useSaveGoal,
  useSaveXunjiConfig,
  useXunjiConfig,
  type BodyPatch,
  type GoalPayload,
} from '../../api/client.js';
import { DOW_ORDER_MON_FIRST, DOW_ZH } from '../../api/labels.js';
import { Modal } from '../common/Modal.js';

/** 设置页「重新运行首次引导」→ 派发事件 → 这里强制打开。用事件而非全局状态，避免加 Provider。 */
const ONBOARDING_REOPEN_EVENT = 'atp:reopen-onboarding';

/** 供设置页调用的入口（纯前端重开，不写服务端完成位）。 */
export function reopenOnboarding(): void {
  window.dispatchEvent(new Event(ONBOARDING_REOPEN_EVENT));
}

type Step = 1 | 2 | 3;

const STEPS: Array<{ n: Step; label: string }> = [
  { n: 1, label: '训记接入' },
  { n: 2, label: '训练基础' },
  { n: 3, label: '个人基础信息' },
];

// 与设置页一致的两套按钮类名（主按钮 indigo，次按钮 slate）
const BTN_PRIMARY =
  'rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:cursor-not-allowed disabled:bg-slate-200 disabled:text-slate-400';
const BTN_SECONDARY = 'rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600';

// 表单控件类名（逐字照抄 GoalForm / BodyForm / XunjiKeyForm）
const INPUT_TEXT =
  'w-full max-w-xs rounded-lg border border-slate-200 px-2.5 py-1.5 text-sm text-slate-800 placeholder:text-slate-300 focus:border-sky-400 focus:outline-none';
const INPUT_PASSWORD =
  'w-full max-w-md rounded-lg border border-slate-200 px-2.5 py-1.5 text-sm text-slate-800 placeholder:text-slate-300 focus:border-sky-400 focus:outline-none disabled:bg-slate-50';
const INPUT_NUM = 'w-20 rounded-lg border border-slate-200 px-2 py-1.5 text-sm tabular-nums text-slate-800 focus:border-sky-400 focus:outline-none';
const INPUT_BOX =
  'rounded-lg border border-slate-200 px-2 py-1.5 text-sm tabular-nums text-slate-800 placeholder:text-slate-300 focus:border-sky-400 focus:outline-none';
const TEXTAREA =
  'w-full rounded-lg border border-slate-200 px-2.5 py-1.5 text-sm text-slate-800 placeholder:text-slate-300 focus:border-sky-400 focus:outline-none';

/** 点选按钮（训练日 / 周起始 / 性别 / 训练年限）：选中态与 GoalForm、BodyForm 完全一致。 */
function chipCls(on: boolean): string {
  return (
    'rounded-lg border px-3 py-1.5 text-sm transition ' +
    (on
      ? 'border-sky-500 bg-sky-50 font-medium text-sky-700'
      : 'border-slate-200 bg-white text-slate-600 hover:border-slate-300 hover:bg-slate-50')
  );
}

function todayLocal(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function OnboardingDialog(): React.ReactNode {
  const state = useOnboarding();
  const complete = useCompleteOnboarding();
  const [forceOpen, setForceOpen] = useState(false);
  /** 关闭后立刻隐藏（不等完成位 mutation 回来，避免弹窗在 pending 期间闪回）。 */
  const [dismissed, setDismissed] = useState(false);
  const [step, setStep] = useState<Step>(1);

  useEffect(() => {
    const onReopen = (): void => {
      setStep(1);
      setDismissed(false);
      setForceOpen(true);
    };
    window.addEventListener(ONBOARDING_REOPEN_EVENT, onReopen);
    return () => window.removeEventListener(ONBOARDING_REOPEN_EVENT, onReopen);
  }, []);

  // 只在服务端明确说「未完成」时才弹（加载中 / 已完成都不弹）
  const show = !dismissed && (forceOpen || state.data?.done === false);
  if (!show) return null;

  /** 🔴 唯一的退出动作：任何路径都走这里，保证写 done = true。 */
  const close = (): void => {
    setDismissed(true);
    setForceOpen(false);
    complete.mutate();
  };

  return (
    <Modal
      title={`首次使用引导 · 第 ${step}/3 步`}
      onClose={close}
      footer={<span className="text-xs text-slate-400">随时可以关闭，之后再从设置页补。</span>}
    >
      <div className="space-y-5">
        <StepDots step={step} />
        {step === 1 && <StepXunji onNext={() => setStep(2)} />}
        {step === 2 && <StepGoal onPrev={() => setStep(1)} onNext={() => setStep(3)} />}
        {step === 3 && <StepBody onPrev={() => setStep(2)} onFinish={close} />}
      </div>
    </Modal>
  );
}

function StepDots({ step }: { step: Step }): React.ReactNode {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
      {STEPS.map((s, i) => (
        <div key={s.n} className="flex items-center gap-3">
          {i > 0 && <span aria-hidden="true" className="h-px w-4 bg-slate-200" />}
          <span
            className={
              'flex items-center gap-1.5 text-xs ' +
              (s.n === step ? 'font-medium text-indigo-600' : s.n < step ? 'text-slate-500' : 'text-slate-400')
            }
          >
            <span
              className={
                'flex h-5 w-5 items-center justify-center rounded-full text-[11px] ' +
                (s.n === step
                  ? 'bg-indigo-600 text-white'
                  : s.n < step
                    ? 'bg-slate-200 text-slate-600'
                    : 'border border-slate-200 text-slate-400')
              }
            >
              {s.n}
            </span>
            {s.label}
          </span>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step 1：训记接入（复用 useSaveXunjiConfig）
// ---------------------------------------------------------------------------

function StepXunji({ onNext }: { onNext: () => void }): React.ReactNode {
  const cfg = useXunjiConfig();
  const save = useSaveXunjiConfig();
  const jobs = useJobsRecent();
  const [keyInput, setKeyInput] = useState('');

  const hasKey = cfg.data?.config.has_key ?? false;
  const keyHint = cfg.data?.config.key_hint ?? null;
  // 保存 Key 后服务端会自动入队首次全量（实测约 9 秒），用 runner.busy 现出真实进行态
  const importing = jobs.data?.runner.busy ?? false;
  const saved = save.isSuccess || hasKey;

  const submit = (): void => {
    const key = keyInput.trim();
    if (key === '') return;
    save.mutate({ api_key: key }, { onSuccess: () => setKeyInput('') });
  };

  return (
    <div className="space-y-4">
      <p className="text-xs leading-relaxed text-slate-500">
        填上<span className="font-medium text-slate-600">训记</span>的 API Key，软件才能读到你的训练记录 ——
        没配 Key 的话，后面所有功能都没有数据可用。
      </p>

      <div>
        <div className="mb-2 flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <span className="text-sm font-medium text-slate-800">训记 API Key</span>
          <span className="text-xs text-slate-500">
            {hasKey ? `已配置 ${keyHint ?? ''}，不填则保持不变` : '未配置'}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <input
            type="password"
            autoComplete="off"
            value={keyInput}
            onChange={(e) => setKeyInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submit();
            }}
            placeholder={hasKey ? '••••••••（留空 = 不改）' : '粘贴你的训记 API Key'}
            className={INPUT_PASSWORD}
          />
          <button type="button" onClick={submit} disabled={keyInput.trim() === '' || save.isPending} className={BTN_PRIMARY}>
            {save.isPending ? '保存中…' : '保存'}
          </button>
        </div>
        <p className="mt-1.5 text-xs text-slate-400">
          Key 只写进本机 <span className="font-medium text-slate-500">.env</span>（已被 git 忽略），不入库、不写日志。
        </p>
        {save.isError && <p className="mt-1.5 text-xs text-rose-600">保存失败：{String(save.error)}</p>}
      </div>

      {saved && (
        <div className="rounded-lg border border-slate-200 bg-slate-50/70 px-3 py-2.5 text-xs leading-relaxed text-slate-500">
          {importing
            ? '正在导入历史数据…（首次约 9 秒，可以先点「下一步」继续，导入会在后台跑完）'
            : '已接入。历史数据在后台导入，不影响继续下一步。'}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-3 border-t border-slate-100 pt-3">
        <button type="button" onClick={onNext} className={BTN_PRIMARY}>
          下一步
        </button>
        <span className="text-xs text-slate-400">没配 Key 也能先继续，之后到设置页补上即可</span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step 2：训练基础（复用 useSaveGoal）
//
// 🔴 长期目标不能为空、训练日至少一天（后端有 CHECK 与 savedGoalTypeEmpty 校验），
//    所以本步**不提供整步跳过**，只提供「上一步」。
// ---------------------------------------------------------------------------

const LONG_TERM_SUGGESTIONS = ['减脂保肌', '增肌', '力量提升', '体态改善'];
const EMPTY_DAYS = [1, 3, 5, 0];

function StepGoal({ onPrev, onNext }: { onPrev: () => void; onNext: () => void }): React.ReactNode {
  const goal = useGoal();
  const save = useSaveGoal();

  const [days, setDays] = useState<number[]>(EMPTY_DAYS);
  const [minDur, setMinDur] = useState(60);
  const [maxDur, setMaxDur] = useState(90);
  const [weekStartDow, setWeekStartDow] = useState(1);
  const [goalType, setGoalType] = useState('');
  /** 已有生效值时预填一次；之后用户改动不再被覆盖（重新运行引导的场景）。 */
  const [prefilled, setPrefilled] = useState(false);

  useEffect(() => {
    if (prefilled) return;
    const g = goal.data?.goal;
    if (!g) return;
    setDays([...g.preferredDows]);
    setMinDur(g.minDurationMin);
    setMaxDur(g.maxDurationMin);
    setWeekStartDow(g.weekStartDow);
    setGoalType(g.goalType);
    setPrefilled(true);
  }, [goal.data, prefilled]);

  const toggleDay = (d: number): void => {
    const has = days.includes(d);
    if (has && days.length === 1) return; // 至少留一天（后端同样拒绝空数组）
    setDays(has ? days.filter((x) => x !== d) : [...days, d]);
  };

  const durationInvalid = maxDur < minDur;
  const goalTypeEmpty = goalType.trim() === '';
  const canSave = goalTypeEmpty === false && days.length >= 1 && !durationInvalid && !save.isPending;

  const submit = (): void => {
    const payload: GoalPayload = {
      goal_type: goalType.trim(),
      min_duration_min: minDur,
      max_duration_min: maxDur,
      week_start_dow: weekStartDow,
      preferred_dows: days,
    };
    save.mutate(payload, { onSuccess: () => onNext() });
  };

  return (
    <div className="space-y-4">
      <p className="text-xs leading-relaxed text-slate-500">
        这是 AI 排计划的<span className="font-medium text-slate-600">常驻基准</span>：先有目标，才能排计划。
      </p>

      {/* 训练日 */}
      <div>
        <div className="mb-2 flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <span className="text-sm font-medium text-slate-800">训练日</span>
          <span className="text-xs text-slate-500">点选周几，选中的天数就是一周几练</span>
        </div>
        {/* 🔴 训练日按钮单独追加 `min-w-14` —— 设置页 GoalForm.tsx:170 的训练日就是这个宽度。
            不能把它并进 `chipCls()`：同一个函数还供「一周起始日」用，而设置页的周起始按钮
            **没有** min-w（窄按钮才排得下 7 个），并进去会让那一行跟着变宽。 */}
        <div className="flex flex-wrap gap-2">
          {DOW_ORDER_MON_FIRST.map((d) => (
            <button key={d} type="button" onClick={() => toggleDay(d)} aria-pressed={days.includes(d)} className={chipCls(days.includes(d)) + ' min-w-14'}>
              {DOW_ZH[d]}
            </button>
          ))}
        </div>
        <div className="mt-2 text-sm text-slate-600">
          一周 <span className="font-semibold text-slate-900">{days.length}</span> 练
          <span className="mx-2 text-slate-300">·</span>
          每次{' '}
          <span className="font-semibold text-slate-900">{`${minDur}~${maxDur}`}</span> 分钟
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
            value={minDur}
            onChange={(e) => setMinDur(Number(e.target.value))}
            className={INPUT_NUM}
          />
          <span className="text-slate-400">~</span>
          <input
            type="number"
            min={10}
            max={600}
            step={5}
            value={maxDur}
            onChange={(e) => setMaxDur(Number(e.target.value))}
            className={INPUT_NUM}
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
          ].map((o) => (
            <button
              key={o.v}
              type="button"
              onClick={() => setWeekStartDow(o.v)}
              aria-pressed={weekStartDow === o.v}
              className={chipCls(weekStartDow === o.v)}
            >
              {o.label}
            </button>
          ))}
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
          value={goalType}
          onChange={(e) => setGoalType(e.target.value)}
          placeholder="例如：减脂保肌"
          className={INPUT_TEXT}
        />
        <div className="mt-2 flex flex-wrap gap-1.5">
          {LONG_TERM_SUGGESTIONS.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setGoalType(s)}
              className="rounded-md border border-slate-200 px-2 py-0.5 text-xs text-slate-500 hover:border-slate-300 hover:bg-slate-50"
            >
              {s}
            </button>
          ))}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3 border-t border-slate-100 pt-3">
        <button type="button" onClick={onPrev} className={BTN_SECONDARY}>
          上一步
        </button>
        <button type="button" onClick={submit} disabled={!canSave} className={BTN_PRIMARY}>
          {save.isPending ? '保存中…' : '保存并下一步'}
        </button>
        {goalTypeEmpty && <span className="text-xs text-rose-600">长期目标不能为空</span>}
        {save.isError && <span className="text-xs text-rose-600">保存失败：{String(save.error)}</span>}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step 3：个人基础信息（复用 useSaveBody）—— 全部字段可空，可整步跳过
//
// 只提交用户**填了**的字段（局部 patch）：留空 = 不动，避免在「重新运行引导」时误清空已有值。
// ---------------------------------------------------------------------------

function StepBody({ onPrev, onFinish }: { onPrev: () => void; onFinish: () => void }): React.ReactNode {
  const save = useSaveBody();
  const [gender, setGender] = useState<string | null>(null);
  const [age, setAge] = useState('');
  const [height, setHeight] = useState('');
  const [trainingYears, setTrainingYears] = useState<string | null>(null);
  const [conditions, setConditions] = useState('');
  const [weight, setWeight] = useState('');
  const [datestr, setDatestr] = useState(() => todayLocal());

  const ageNum = age.trim() === '' ? null : Number(age);
  const heightNum = height.trim() === '' ? null : Number(height);
  const weightNum = weight.trim() === '' ? null : Number(weight);
  const ageOk = ageNum !== null && Number.isInteger(ageNum) && ageNum >= AGE_RANGE.min && ageNum <= AGE_RANGE.max;
  const heightOk =
    heightNum !== null && Number.isInteger(heightNum) && heightNum >= HEIGHT_RANGE.min && heightNum <= HEIGHT_RANGE.max;
  const weightOk = weightNum !== null && Number.isFinite(weightNum) && weightNum >= 20 && weightNum <= 400;

  const buildPatch = (): BodyPatch => {
    const patch: BodyPatch = {};
    if (gender !== null) patch.gender = gender;
    if (ageOk) patch.age = ageNum;
    if (heightOk) patch.height_cm = heightNum;
    if (trainingYears !== null) patch.training_years = trainingYears;
    if (conditions.trim() !== '') patch.conditions = conditions.trim();
    if (weightOk) {
      patch.weight_kg = weightNum;
      patch.datestr = datestr;
    }
    return patch;
  };

  const submit = (): void => {
    const patch = buildPatch();
    if (Object.keys(patch).length === 0) {
      onFinish(); // 什么都没填 = 跳过
      return;
    }
    save.mutate(patch, { onSuccess: () => onFinish() });
  };

  return (
    <div className="space-y-5">
      <p className="text-xs leading-relaxed text-slate-500">
        这些是<span className="font-medium text-slate-600">手动填</span>的（训记里没有体重、性别、病史），
        全部可以留空 —— 填了会作为 AI 排计划的背景参考。留空就是「没告诉我」。
      </p>

      <div className="grid gap-x-6 gap-y-4 sm:grid-cols-2">
        <div>
          <div className="mb-1.5 text-sm text-slate-700">性别</div>
          <div className="flex flex-wrap gap-2">
            {GENDERS.map((g) => (
              <button
                key={g}
                type="button"
                onClick={() => setGender(gender === g ? null : g)}
                aria-pressed={gender === g}
                className={chipCls(gender === g)}
              >
                {g}
              </button>
            ))}
          </div>
        </div>

        <div>
          <div className="mb-1.5 text-sm text-slate-700">年龄</div>
          <div className="flex items-center gap-2">
            <input
              type="number"
              min={AGE_RANGE.min}
              max={AGE_RANGE.max}
              step={1}
              value={age}
              onChange={(e) => setAge(e.target.value)}
              placeholder="例如 30"
              className={`w-24 ${INPUT_BOX}`}
            />
            <span className="text-sm text-slate-500">岁</span>
          </div>
        </div>

        <div>
          <div className="mb-1.5 text-sm text-slate-700">身高</div>
          <div className="flex items-center gap-2">
            <input
              type="number"
              min={HEIGHT_RANGE.min}
              max={HEIGHT_RANGE.max}
              step={1}
              value={height}
              onChange={(e) => setHeight(e.target.value)}
              placeholder="例如 163"
              className={`w-24 ${INPUT_BOX}`}
            />
            <span className="text-sm text-slate-500">cm</span>
          </div>
        </div>

        <div>
          <div className="mb-1.5 text-sm text-slate-700">训练年限</div>
          <div className="flex flex-wrap gap-2">
            {TRAINING_YEARS.map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => setTrainingYears(trainingYears === t ? null : t)}
                aria-pressed={trainingYears === t}
                className={chipCls(trainingYears === t)}
              >
                {t}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div>
        <div className="mb-2 flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <span className="text-sm font-medium text-slate-800">体重</span>
          <span className="text-xs text-slate-500">一天一条；同一天再保存就是覆盖那天的值</span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <input type="date" value={datestr} max={todayLocal()} onChange={(e) => setDatestr(e.target.value)} className={INPUT_BOX} />
          <input
            type="number"
            min={20}
            max={400}
            step={0.1}
            value={weight}
            onChange={(e) => setWeight(e.target.value)}
            placeholder="例如 58.5"
            className={`w-28 ${INPUT_BOX}`}
          />
          <span className="text-sm text-slate-500">kg</span>
          {weight.trim() !== '' && !weightOk && <span className="text-xs text-rose-600">体重需在 20~400 kg</span>}
        </div>
      </div>

      <div>
        <div className="mb-2 flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <span className="text-sm font-medium text-slate-800">旧伤 / 基础疾病</span>
          <span className="text-xs text-slate-500">例如「腰突（2020 年，已痊愈）」</span>
        </div>
        <textarea
          rows={2}
          maxLength={500}
          value={conditions}
          onChange={(e) => setConditions(e.target.value)}
          placeholder="没填就留空"
          className={TEXTAREA}
        />
        <p className="mt-1.5 text-xs text-slate-400">
          <span className="font-medium text-slate-500">只作背景参考</span>
          ：系统不会因为你填了「腰突」就不排用腰的动作。临时状况请写在首页的「下周特殊情况」里。
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-3 border-t border-slate-100 pt-3">
        <button type="button" onClick={onPrev} className={BTN_SECONDARY}>
          上一步
        </button>
        <button type="button" onClick={submit} disabled={save.isPending} className={BTN_PRIMARY}>
          {save.isPending ? '保存中…' : '完成'}
        </button>
        <button type="button" onClick={onFinish} disabled={save.isPending} className={BTN_SECONDARY}>
          跳过，直接开始用
        </button>
        {save.isError && <span className="text-xs text-rose-600">保存失败：{String(save.error)}</span>}
      </div>
    </div>
  );
}
