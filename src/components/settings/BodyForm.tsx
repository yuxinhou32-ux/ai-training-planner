/**
 * 个人基础信息（性别 / 年龄 / 身高 / 训练年限 + 体重 + 旧伤 · 基础疾病）
 * —— PRD-v2 §10.3 V9，2026-09-30 从「身体信息」扩为「个人基础信息」。
 *
 * 这些全是**手动填**的：训记里没有体重、性别、病史，只能用户自己告诉系统。
 * 填了之后走 `digest.profile.body` 进 AI 输入（验收标准：「体重与旧伤进入 AI 输入」）。
 *
 * 🔴 **全部非必填**（用户定案：「他填了就保存，不填就默认为空」）：
 *    所以界面上**不写「可以不填」这种标注** —— 留空就是没填，这是默认状态，
 *    专门标注反而会让人以为「这里是不是必须点什么」。留空的语义是
 *    「用户没告诉我这件事」，prompt 里明确要求 AI 不许提起、不许追问、不许假设。
 *
 * 🔴 旧伤只作背景参考 —— 界面上也必须说清楚，否则用户填了「腰突」却发现系统照排硬拉，
 *    第一反应会是「功能坏了」。所以输入框下面写明白：
 *    ① 系统不会因此禁用动作（陈旧伤已痊愈）；
 *    ② 临时的不舒服请写在**首页的「下周特殊情况」**里，那个优先级最高（§5 优先级）；
 *      复盘页的逐日感受是**事后**记录，用途是复盘，不进排计划输入。
 *
 * 保存方式：**改了就存**（用户原话「填了就保存」）——
 *   - 性别 / 训练年限是点选按钮：点一下立刻提交，再点一下取消（＝不填）；
 *   - 年龄 / 身高是输入框：失焦或回车时提交，值没变就不发请求；
 *   - 体重与旧伤保留显式「保存」按钮（一个是日期 + 数值的组合，一个是长文本，
 *     边打字边提交只会产生一堆半成品记录）。
 */
import { useEffect, useState } from 'react';
import {
  AGE_RANGE,
  GENDERS,
  HEIGHT_RANGE,
  TRAINING_YEARS,
  useBody,
  useSaveBody,
  type WeightPoint,
} from '../../api/client.js';
import { CollapsibleCard } from '../common/ui.js';

/** 趋势图最多画多少个点（半年记录全画出来会糊成一片）。 */
const CHART_POINTS = 30;
/** 「最近记录」最多列几条（要能一眼扫到、并且点得到删除）。 */
const RECENT_CHIPS = 8;

/** 点选按钮（性别 / 训练年限）：选中态与 GoalForm 的训练日完全一致。 */
function chipCls(on: boolean): string {
  return (
    'rounded-lg border px-3 py-1.5 text-sm transition ' +
    (on
      ? 'border-sky-500 bg-sky-50 font-medium text-sky-700'
      : 'border-slate-200 bg-white text-slate-600 hover:border-slate-300 hover:bg-slate-50')
  );
}

const INPUT_CLS =
  'rounded-lg border border-slate-200 px-2 py-1.5 text-sm tabular-nums text-slate-800 placeholder:text-slate-300 focus:border-sky-400 focus:outline-none';

function todayLocal(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function signed(n: number): string {
  return `${n > 0 ? '+' : ''}${n}`;
}

export function BodyForm(): React.ReactNode {
  const body = useBody();
  // 三次独立的 mutation：基础信息 / 体重 / 旧伤 各有各的按钮与错误位。
  // 共用一份 isPending 会让「保存旧伤时体重按钮也转圈」，错误提示也会张冠李戴。
  const saveMetaM = useSaveBody();
  const saveWeightM = useSaveBody();
  const saveCondM = useSaveBody();

  // ---- 体重输入（不加服务端同步：填完就提交，没填完的内容不该被回灌） ----
  const [datestr, setDatestr] = useState<string>(() => todayLocal());
  const [kg, setKg] = useState('');
  // ---- 年龄 / 身高（需要同步：可能在别处被改过，且用户正打字时不能被覆盖） ----
  const [metaSynced, setMetaSynced] = useState<string | null>(null);
  const [ageDraftState, setAgeDraftState] = useState('');
  const [heightDraftState, setHeightDraftState] = useState('');
  // ---- 旧伤文本（同上） ----
  const [syncedConditions, setSyncedConditions] = useState<string | null>(null);
  const [conditionsDraft, setConditionsDraft] = useState('');
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);

  const info = body.data?.info ?? null;

  // 🔴 渲染期派生（与 GoalForm 同一套路）：服务端渲染不跑 effect，
  // 只靠 effect 初始化会永远停在「加载中…」，客户端首帧也会闪一下。
  const serverMetaKey =
    info === null ? null : `${info.gender}|${info.age}|${info.height_cm}|${info.training_years}`;
  const metaNeedSync = serverMetaKey !== null && serverMetaKey !== metaSynced;
  const ageDraft =
    metaNeedSync && info !== null ? (info.age === null ? '' : String(info.age)) : ageDraftState;
  const heightDraft =
    metaNeedSync && info !== null ? (info.height_cm === null ? '' : String(info.height_cm)) : heightDraftState;

  const serverConditions = info?.conditions ?? null;
  const condNeedSync = serverConditions !== null && serverConditions !== syncedConditions;
  const conditions = condNeedSync && serverConditions !== null ? serverConditions : conditionsDraft;

  useEffect(() => {
    if (!metaNeedSync || info === null) return;
    setMetaSynced(serverMetaKey);
    setAgeDraftState(info.age === null ? '' : String(info.age));
    setHeightDraftState(info.height_cm === null ? '' : String(info.height_cm));
  }, [metaNeedSync, serverMetaKey, info]);

  useEffect(() => {
    if (!condNeedSync || serverConditions === null) return;
    setSyncedConditions(serverConditions);
    setConditionsDraft(serverConditions);
  }, [condNeedSync, serverConditions]);

  if (body.isError) {
    return (
      <CollapsibleCard title="个人基础信息" summary={<span className="text-rose-600">读取失败</span>}>
        <div className="py-6 text-center text-sm text-rose-600">个人基础信息读取失败：{String(body.error)}</div>
      </CollapsibleCard>
    );
  }
  if (body.isPending || info === null) {
    return (
      <CollapsibleCard title="个人基础信息" summary="加载中…">
        <div className="py-6 text-center text-sm text-slate-400">加载中…</div>
      </CollapsibleCard>
    );
  }

  const weights = body.data?.weights ?? [];
  const existing = weights.find((w) => w.datestr === datestr) ?? null;
  const conditionsDirty = conditions !== (serverConditions ?? '');
  const kgNum = Number(kg);
  const kgValid = kg.trim() !== '' && Number.isFinite(kgNum) && kgNum >= 20 && kgNum <= 400;

  const saveWeight = (): void => {
    if (!kgValid) return;
    saveWeightM.mutate({ datestr, weight_kg: kgNum }, { onSuccess: () => setKg('') });
  };

  /** 点选按钮：点已选中的那个 = 取消选择（等于「没填」）。 */
  const pickGender = (v: string): void => {
    saveMetaM.mutate({ gender: info.gender === v ? null : v });
  };
  const pickYears = (v: string): void => {
    saveMetaM.mutate({ training_years: info.training_years === v ? null : v });
  };

  /** 数字输入框：失焦 / 回车提交。非法值（超范围、非整数）只提示、不提交；值没变则不发请求。 */
  const commitNumber = (
    raw: string,
    current: number | null,
    min: number,
    max: number,
    field: 'age' | 'height_cm',
  ): void => {
    const text = raw.trim();
    const next = text === '' ? null : Number(text);
    if (next !== null && (!Number.isInteger(next) || next < min || next > max)) return;
    if (next === current) return;
    // 分开写而不是 `{ [field]: next }`：后者会被推断成索引签名，跟 BodyPatch 对不上
    if (field === 'age') saveMetaM.mutate({ age: next });
    else saveMetaM.mutate({ height_cm: next });
  };

  const ageNum = ageDraft.trim() === '' ? null : Number(ageDraft);
  const ageInvalid =
    ageDraft.trim() !== '' &&
    (ageNum === null || !Number.isInteger(ageNum) || ageNum < AGE_RANGE.min || ageNum > AGE_RANGE.max);
  const heightNum = heightDraft.trim() === '' ? null : Number(heightDraft);
  const heightInvalid =
    heightDraft.trim() !== '' &&
    (heightNum === null || !Number.isInteger(heightNum) || heightNum < HEIGHT_RANGE.min || heightNum > HEIGHT_RANGE.max);

  /** 收起态右侧的「当前值」—— 收起不等于看不见。没填的项直接不出现。 */
  const summaryParts = [
    info.gender,
    info.age === null ? '' : `${info.age} 岁`,
    info.height_cm === null ? '' : `身高 ${info.height_cm} cm`,
    info.training_years,
    info.weight_kg === null ? '' : `最新 ${info.weight_kg} kg（${info.weight_date}）`,
  ].filter((s): s is string => s !== null && s !== '');
  const summary = summaryParts.length > 0 ? summaryParts.join(' · ') : '还没填';

  return (
    <CollapsibleCard title="个人基础信息" summary={summary}>
      <div className="space-y-5">
        {/* ---------- 基础信息：改了就存 ---------- */}
        <div>
          <div className="mb-2 flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <span className="text-sm font-medium text-slate-800">基础信息</span>
            <span className="text-xs text-slate-500">
              改完立刻生效，不用点保存；留空就是没填 —— 这些都是给 AI 的背景参考
            </span>
          </div>
          <div className="grid gap-x-6 gap-y-4 sm:grid-cols-2">
            <div>
              <div className="mb-1.5 text-sm text-slate-700">性别</div>
              <div className="flex flex-wrap gap-2">
                {GENDERS.map((g) => (
                  <button
                    key={g}
                    type="button"
                    onClick={() => pickGender(g)}
                    aria-pressed={info.gender === g}
                    className={chipCls(info.gender === g)}
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
                  value={ageDraft}
                  onChange={(e) => setAgeDraftState(e.target.value)}
                  onBlur={() => commitNumber(ageDraft, info.age, AGE_RANGE.min, AGE_RANGE.max, 'age')}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') commitNumber(ageDraft, info.age, AGE_RANGE.min, AGE_RANGE.max, 'age');
                  }}
                  placeholder="例如 30"
                  className={`w-24 ${INPUT_CLS}`}
                />
                <span className="text-sm text-slate-500">岁</span>
                {ageInvalid && (
                  <span className="text-xs text-rose-600">
                    请输入 {AGE_RANGE.min}~{AGE_RANGE.max} 的整数
                  </span>
                )}
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
                  value={heightDraft}
                  onChange={(e) => setHeightDraftState(e.target.value)}
                  onBlur={() =>
                    commitNumber(heightDraft, info.height_cm, HEIGHT_RANGE.min, HEIGHT_RANGE.max, 'height_cm')
                  }
                  onKeyDown={(e) => {
                    if (e.key === 'Enter')
                      commitNumber(heightDraft, info.height_cm, HEIGHT_RANGE.min, HEIGHT_RANGE.max, 'height_cm');
                  }}
                  placeholder="例如 163"
                  className={`w-24 ${INPUT_CLS}`}
                />
                <span className="text-sm text-slate-500">cm</span>
                {heightInvalid && (
                  <span className="text-xs text-rose-600">
                    请输入 {HEIGHT_RANGE.min}~{HEIGHT_RANGE.max} 的整数
                  </span>
                )}
              </div>
            </div>

            <div>
              <div className="mb-1.5 text-sm text-slate-700">训练年限</div>
              <div className="flex flex-wrap gap-2">
                {TRAINING_YEARS.map((t) => (
                  <button
                    key={t}
                    type="button"
                    onClick={() => pickYears(t)}
                    aria-pressed={info.training_years === t}
                    className={chipCls(info.training_years === t)}
                  >
                    {t}
                  </button>
                ))}
              </div>
            </div>
          </div>
          {saveMetaM.isError && (
            <p className="mt-2 text-xs text-rose-600">保存失败：{String(saveMetaM.error)}</p>
          )}
        </div>

        {/* ---------- 体重：录入 ---------- */}
        <div>
          <div className="mb-2 flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <span className="text-sm font-medium text-slate-800">体重</span>
            <span className="text-xs text-slate-500">一天一条；同一天再保存就是覆盖那天的值</span>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <input
              type="date"
              value={datestr}
              max={todayLocal()}
              onChange={(e) => setDatestr(e.target.value)}
              className={INPUT_CLS}
            />
            <input
              type="number"
              min={20}
              max={400}
              step={0.1}
              value={kg}
              onChange={(e) => setKg(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') saveWeight();
              }}
              placeholder={info.weight_kg !== null ? `最新 ${info.weight_kg}` : '例如 58.5'}
              className={`w-28 ${INPUT_CLS}`}
            />
            <span className="text-sm text-slate-500">kg</span>
            <button
              type="button"
              onClick={saveWeight}
              disabled={!kgValid || saveWeightM.isPending}
              className="rounded-lg bg-sky-600 px-4 py-1.5 text-sm font-medium text-white transition hover:bg-sky-700 disabled:cursor-not-allowed disabled:bg-slate-200 disabled:text-slate-400"
            >
              {saveWeightM.isPending ? '保存中…' : '保存'}
            </button>
            {kg.trim() !== '' && !kgValid && <span className="text-xs text-rose-600">体重需在 20~400 kg</span>}
            {saveWeightM.isError && <span className="text-xs text-rose-600">保存失败：{String(saveWeightM.error)}</span>}
          </div>
          {existing && (
            <p className="mt-1.5 text-xs text-amber-600">
              {existing.datestr} 已有记录 <span className="font-medium tabular-nums">{existing.weight_kg} kg</span>，
              保存将覆盖它。
            </p>
          )}
        </div>

        {/* ---------- 体重：趋势 ---------- */}
        <div className="rounded-xl bg-slate-50 px-3 py-3">
          {weights.length === 0 ? (
            <p className="py-2 text-center text-sm text-slate-400">还没有体重记录 —— 填一条就能看到趋势</p>
          ) : (
            <>
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <span className="text-lg font-semibold tabular-nums text-slate-900">
                  {info.weight_kg}
                  <span className="ml-0.5 text-xs font-normal text-slate-500">kg</span>
                </span>
                <span className="text-xs text-slate-500">{info.weight_date}</span>
                {info.delta_30d_kg !== null && (
                  <span
                    className={
                      'text-xs tabular-nums ' +
                      (info.delta_30d_kg > 0 ? 'text-rose-600' : info.delta_30d_kg < 0 ? 'text-emerald-600' : 'text-slate-500')
                    }
                    title="最新一次 相对 30 天前最近一次 的变化"
                  >
                    近 30 天 {signed(info.delta_30d_kg)} kg
                  </span>
                )}
                <span className="ml-auto text-xs text-slate-400">共 {weights.length} 条记录</span>
              </div>
              <WeightChart points={weights.slice(-CHART_POINTS)} />
              {weights.length === 1 && (
                <p className="mt-1 text-center text-[10px] text-slate-400">再记一条就能连成趋势线</p>
              )}
            </>
          )}

          {weights.length > 0 && (
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              <span className="text-xs text-slate-400">最近：</span>
              {[...weights]
                .reverse()
                .slice(0, RECENT_CHIPS)
                .map((p) =>
                  pendingDelete === p.datestr ? (
                    <span key={p.datestr} className="inline-flex items-center gap-1 rounded-md bg-rose-50 px-1.5 py-0.5 text-xs text-rose-700">
                      删除 {p.datestr.slice(5)}？
                      <button
                        type="button"
                        onClick={() => {
                          saveWeightM.mutate({ weight_kg: null, datestr: p.datestr });
                          setPendingDelete(null);
                        }}
                        className="font-medium underline"
                      >
                        确认
                      </button>
                      <button type="button" onClick={() => setPendingDelete(null)} className="text-slate-500 underline">
                        取消
                      </button>
                    </span>
                  ) : (
                    <span
                      key={p.datestr}
                      className="inline-flex items-center gap-1 rounded-md border border-slate-200 bg-white px-1.5 py-0.5 text-xs text-slate-600"
                    >
                      <span className="tabular-nums">
                        {p.datestr.slice(5)} · {p.weight_kg}
                      </span>
                      <button
                        type="button"
                        title={`删掉 ${p.datestr} 的记录`}
                        onClick={() => setPendingDelete(p.datestr)}
                        className="text-slate-300 transition hover:text-rose-500"
                      >
                        ×
                      </button>
                    </span>
                  ),
                )}
            </div>
          )}
        </div>

        {/* ---------- 旧伤 / 基础疾病 ---------- */}
        <div>
          <div className="mb-2 flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <span className="text-sm font-medium text-slate-800">旧伤 / 基础疾病</span>
            <span className="text-xs text-slate-500">例如「腰突（2020 年，已痊愈）」</span>
          </div>
          <textarea
            rows={2}
            maxLength={500}
            value={conditions}
            onChange={(e) => setConditionsDraft(e.target.value)}
            placeholder="没填就留空"
            className="w-full rounded-lg border border-slate-200 px-2.5 py-1.5 text-sm text-slate-800 placeholder:text-slate-300 focus:border-sky-400 focus:outline-none"
          />
          <p className="mt-1.5 text-xs text-slate-400">
            <span className="font-medium text-slate-500">只作背景参考</span>
            ：系统不会因为你填了「腰突」就不排用腰的动作 —— 陈年旧伤已痊愈，急性发作期本来也不会来训练。
            临时的状况（经期、某处不舒服）请写在
            <span className="font-medium text-slate-500">首页的「下周特殊情况」</span>里，那个优先级最高。
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={() => saveCondM.mutate({ conditions })}
              disabled={!conditionsDirty || saveCondM.isPending}
              className="rounded-lg bg-sky-600 px-4 py-1.5 text-sm font-medium text-white transition hover:bg-sky-700 disabled:cursor-not-allowed disabled:bg-slate-200 disabled:text-slate-400"
            >
              {saveCondM.isPending ? '保存中…' : '保存'}
            </button>
            {!conditionsDirty && <span className="text-xs text-slate-400">与已保存的一致</span>}
            {saveCondM.isError && <span className="text-xs text-rose-600">保存失败：{String(saveCondM.error)}</span>}
            {info.updated_at && <span className="text-xs text-slate-300">最后更新 {info.updated_at.replace('T', ' ').replace('Z', '')}</span>}
          </div>
        </div>
      </div>
    </CollapsibleCard>
  );
}

/**
 * 体重趋势（折线 + 数据点 + 渐变填充；纯 SVG/div，不引图表库 —— 全项目可视化都这么画）。
 *
 * 为什么是折线而不是柱状：体重记录**稀疏且不规律**（可能一周一次，也可能隔两个月），
 * 柱状图会把「四月量过一次、八月量过两次」画成三根各自独立的柱子，看不出中间发生了什么；
 * 折线的语义正是「连接两次测量之间的变化」，这才是看体重趋势要看的东西。
 *
 * 纵轴不按 0 起算：体重变化幅度只有几公斤，从 0 起算会画成一条直线，看不出任何趋势。
 * 用「最小值 ± 一点余量」做基线，让变化幅度占满画布。
 *
 * 实现上取了个巧但可靠：SVG 用 `viewBox="0 0 100 100"` + `preserveAspectRatio="none"`，
 * 于是**坐标本身就是百分比**，不用去测量容器宽度（也就没有首帧跳动）；
 * 线宽靠 `vector-effect="non-scaling-stroke"` 保持不变，
 * 数据点则用绝对定位的 div —— SVG 的 circle 会被非等比缩放拉成椭圆，div 不会。
 */
function WeightChart({ points }: { points: WeightPoint[] }): React.ReactNode {
  const values = points.map((p) => p.weight_kg);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min;
  const n = points.length;

  // 左右各留 2%：最边上的点才不会被容器边缘切掉一半
  const xOf = (i: number): number => (n === 1 ? 50 : 2 + (i / (n - 1)) * 96);
  // 上下各留 12%：线不贴顶贴底；全部数值相等时画在中间一条水平线上
  const yOf = (v: number): number => (span === 0 ? 50 : 88 - (76 * (v - min)) / span);
  const coords = points.map((p, i) => `${xOf(i)},${yOf(p.weight_kg)}`).join(' ');

  return (
    <div className="mt-3">
      <div className="relative h-24">
        <svg
          className="absolute inset-0 h-full w-full"
          viewBox="0 0 100 100"
          preserveAspectRatio="none"
          aria-hidden="true"
        >
          <defs>
            <linearGradient id="weight-trend-fill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#0ea5e9" stopOpacity="0.20" />
              <stop offset="100%" stopColor="#0ea5e9" stopOpacity="0.02" />
            </linearGradient>
          </defs>
          {n >= 2 && (
            <>
              <polygon points={`${xOf(0)},100 ${coords} ${xOf(n - 1)},100`} fill="url(#weight-trend-fill)" />
              <polyline
                points={coords}
                fill="none"
                stroke="#0ea5e9"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                vectorEffect="non-scaling-stroke"
              />
            </>
          )}
        </svg>
        {points.map((p, i) => (
          <span
            key={p.datestr}
            title={`${p.datestr} · ${p.weight_kg} kg`}
            className="absolute h-2 w-2 -translate-x-1/2 -translate-y-1/2 rounded-full border-[1.5px] border-white bg-sky-500"
            style={{ left: `${xOf(i)}%`, top: `${yOf(p.weight_kg)}%` }}
          />
        ))}
      </div>
      <div className="mt-1 flex justify-between text-[10px] tabular-nums text-slate-400">
        <span>{points[0]?.datestr}</span>
        {span > 0 && (
          <span>
            区间 {min} ~ {max} kg
          </span>
        )}
        <span>{points[points.length - 1]?.datestr}</span>
      </div>
    </div>
  );
}
