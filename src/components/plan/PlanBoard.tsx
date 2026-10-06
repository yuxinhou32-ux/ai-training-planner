/**
 * 计划主区（PRD-v2 §2① 的核心）—— 首页里「生成 → 调整 → 导入」的那一段。
 *
 * 2026-09-30 用户定案（「我觉得下面有点太丑了」）后删掉的东西：
 *   - **周概要 4 个统计卡**（训练次数 / 总有效组 / 预计时长 / 肌群分布 Top3）
 *     —— 用户：「训练次数、总有效组、预计时长不用写在里面，太丑了，不要」。
 *     那些数字在每个训练日卡片上本来就有（几分钟 / 几个动作）。
 *   - **两个重复的重新生成按钮**（「重新生成（模板）」+「AI 重新生成」）
 *     —— 用户：「下面直接就是生成计划就行了，就有一个那个生成的那个按钮就行了」。
 *     AI 生成失败时系统本来就会自动降级到规则模板，不需要一个手动兜底按钮。
 *
 * 还有一条硬门控：**周期目标没锁定就不给生成**（用户：「如果没有设置周期目标的时候，
 * 就锁定，不要给它生成 AI 模板」）。这也是"周期内同一个模板"这个想法的前提 ——
 * 没有周期目标，就没有可以沿用的东西。
 *
 * 保留的行为：
 *  - 无计划：空态 + 「生成计划」
 *  - 有计划：状态徽章 + 熔断橙条（warnings）+ DayCard 列表
 *  - 手动编辑：防抖 800ms PATCH → 服务端重算 summary
 *  - V7 挪训练日：整个训练日挪到另一天（目标日占用则交换）
 *
 * 2026-09-30 增补：**周期第 2~4 周默认沿用上一周模板**（省 token，进度体现在重量上）。
 * 沿用时不加第二个按钮，只在标题旁写一行「本次沿用周期第 N 周模板」+ 一个「重新全量生成」文字链接
 * （用户明确：「下面直接就是生成计划就行了，就有一个生成的那个按钮就行了」）。
 *
 * 🔴 红线：**这块里没有 approve / confirm**。写回训记仍是双栏杆，要点「导入训记」
 *    进到确认页，由用户显式点两次才发生。这里的按钮一个字节都写不到训记。
 */
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  deleteExercise as deleteExerciseApi,
  qk,
  useCurrentPlan,
  useCycle,
  useDeleteExercise,
  useGeneratePlan,
  useGoal,
  useMovePlanDay,
  useUpdateExercise,
  type PlanDetail,
} from '../../api/client.js';
import { currentWeekStart, dowOf, remainingTrainingDows, weekDates } from '../../api/labels.js';
import { DayCard, type MoveOption } from './DayCard.js';
import { SectionCard } from '../common/ui.js';

const SOURCE_LABEL: Record<string, { label: string; cls: string }> = {
  ai: { label: 'AI 生成', cls: 'bg-indigo-100 text-indigo-700' },
  rule_fallback: { label: '规则模板（非 AI）', cls: 'bg-slate-200 text-slate-600' },
  manual: { label: '手动', cls: 'bg-slate-200 text-slate-600' },
};

const STATUS_LABEL: Record<string, { label: string; cls: string }> = {
  draft: { label: '草稿待确认', cls: 'bg-amber-100 text-amber-700' },
  approved: { label: '已批准', cls: 'bg-emerald-100 text-emerald-700' },
  written: { label: '已写入', cls: 'bg-emerald-100 text-emerald-700' },
  uncertain: { label: '写入待核实', cls: 'bg-yellow-100 text-yellow-700' },
  archived: { label: '已归档', cls: 'bg-slate-200 text-slate-500' },
};

/** 可进「导入训记」流程的状态（其余状态没有下一步动作）。 */
const IMPORTABLE = new Set(['draft', 'approved', 'uncertain']);

function WarningsBanner(props: {
  warnings: Array<Record<string, unknown>>;
  onTrim: () => void;
  trimming: boolean;
}): React.ReactNode {
  if (props.warnings.length === 0) return null;
  return (
    <div className="rounded-xl border border-orange-300 bg-orange-50 p-4">
      <div className="text-sm font-semibold text-orange-800">计划经多次尝试仍未完全满足约束，已放行（熔断）</div>
      <ul className="mt-1.5 space-y-1">
        {props.warnings.map((w, i) => {
          const range = w.range as [number, number] | undefined;
          return (
            <li key={i} className="text-sm text-orange-900">
              {String(w.datestr ?? '')} 预计 {String(w.value ?? '?')} 分钟，超出你设定的{' '}
              {range ? `${range[0]}–${range[1]}` : '目标'} 分钟区间。
            </li>
          );
        })}
      </ul>
      <button
        className="mt-2 rounded-lg bg-orange-600 px-3 py-1.5 text-xs text-white hover:bg-orange-700 disabled:opacity-50"
        disabled={props.trimming}
        onClick={props.onTrim}
      >
        {props.trimming ? '正在删…' : '一键删到区间内（从辅助动作开始删）'}
      </button>
    </div>
  );
}

export function PlanBoard(): React.ReactNode {
  const qc = useQueryClient();
  const { data, isPending, error } = useCurrentPlan();
  const cycle = useCycle();
  const goal = useGoal();
  const generate = useGeneratePlan();

  const [trimming, setTrimming] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const planId = data?.plan?.id ?? null;
  const editable = data?.plan?.status === 'draft';
  const updateEx = useUpdateExercise(planId ?? 0);
  const deleteEx = useDeleteExercise(planId ?? 0);
  const moveDay = useMovePlanDay(planId ?? 0);

  /**
   * 空态时这一页讲的是哪一周 —— 决定标题写「本周计划」还是「下周计划」。
   *
   * 判据与服务端 `planningWeekStart` 一致：今天所在周若还有没过的训练日，
   * 排计划就落在**本周**（起始周）；否则顺延到下周。这里没有服务端字段可用
   * （空态时 `plan_week_start` 还是有的，但用它更直接）。
   */
  const cycleGoal = goal.data?.goal ?? null;
  const isStarterWeekEmpty =
    cycleGoal !== null && remainingTrainingDows(cycleGoal.preferredDows).length > 0;

  // ---- 门控：周期目标必须先锁定 ----
  // `plan_week.expired`（不是顶层的 `expired`）：判的是**下一周**还在不在周期里。
  const cycleLocked = (cycle.data?.cycle ?? null) !== null && cycle.data?.plan_week.expired !== true;
  const lockedGoalText = cycle.data?.cycle?.goalText ?? null;

  /** 唯一的生成按钮（文案随「有没有计划」变，全过程只有这一个动作入口）。 */
  const generateButton = (label: string, small: boolean, mode?: 'auto' | 'full'): React.ReactNode => (
    <button
      className={
        small
          ? 'rounded-lg border border-indigo-300 bg-white px-3 py-1.5 text-xs text-indigo-700 hover:bg-indigo-50 disabled:opacity-50'
          : 'rounded-lg bg-indigo-600 px-4 py-2 text-sm text-white hover:bg-indigo-700 disabled:opacity-50'
      }
      disabled={!cycleLocked || generate.isPending}
      title={cycleLocked ? undefined : '先在上面填周期目标并点「锁定」'}
      onClick={() => {
        setActionError(null);
        generate.mutate(mode ? { mode } : undefined, { onError: (e) => setActionError(`生成失败：${e.message}`) });
      }}
    >
      {generate.isPending ? '生成中…（可能要等一会儿）' : label}
    </button>
  );

  // 2026-09-30 用户第 6 轮：原来这里那条琥珀色提示条（「先在上面第一块填好周期目标并点锁定…」）
  // 整条删掉了 —— 改成「周期目标」栏头后面的一串灰字（见 `CycleCard` 的 `PaneHead note`）。
  // 理由：它是「这一块没配好」的说明，放在这一块的**栏头**上最省地方，也不必在空态和有计划态
  // 各挂一次。生成按钮本身仍是禁用的，鼠标悬停有 title 提示。

  if (isPending) {
    return (
      <SectionCard title="下周计划">
        <div className="py-10 text-center text-sm text-slate-400">加载中…</div>
      </SectionCard>
    );
  }

  // ------------------------------------------------------------------
  // 空态：还没有计划
  // ------------------------------------------------------------------
  // 形状防御：data 存在但 plan 缺失（如服务端异常返回 {}）时同样走空态，避免白屏
  if (error || !data?.plan) {
    const msg = error instanceof Error ? error.message : '';
    const isNoPlan = msg.includes('还没有计划') || msg.includes('404');
    return (
      <SectionCard title={isStarterWeekEmpty ? '本周计划' : '下周计划'} extra={<span className="text-xs text-slate-400">每周手点一次，确认后才写入训记</span>}>
        {actionError && <div className="mb-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-600">{actionError}</div>}
        <div className="flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-slate-300 px-6 py-12 text-center">
          <div className="text-base font-medium text-slate-700">
            {isNoPlan ? (isStarterWeekEmpty ? '本周还没有计划' : '还没有下周计划') : '计划加载失败'}
          </div>
          <div className="max-w-md text-sm text-slate-500">
            {isNoPlan
              ? isStarterWeekEmpty
                ? '本周还剩训练日，可以现在就排剩下的几天（这周算「起始周」，不占周期第 1 周，下周才正式进入第 1 周）。会带上上面的周期目标与特殊情况。'
                : '基于你的分析报告生成下一周的训练草稿，会带上上面的周期目标与特殊情况。生成后可以调整动作与重量，确认无误再导入训记。'
              : msg}
          </div>
          <div className="mt-1">{generateButton('生成计划', false)}</div>
        </div>
      </SectionCard>
    );
  }

  const plan = data.plan;
  const source = SOURCE_LABEL[plan.source] ?? { label: plan.source, cls: 'bg-slate-200 text-slate-600' };
  const status = STATUS_LABEL[plan.status] ?? { label: plan.status, cls: 'bg-slate-200 text-slate-600' };
  const canImport = IMPORTABLE.has(plan.status);

  /**
   * 起始周（Week 0）—— 计划周 === 用户今天所在周。
   * 用户中途开始用、本周还剩训练日时就会这样：本轮只排「剩下那几天」，不占周期第 1 周。
   * 标题写死「下周计划」会骗人，所以这里按日期现算，不依赖服务端字段。
   */
  const isStarterWeek = plan.week_start === currentWeekStart();

  // ------------------------------------------------------------------
  // 一键删到区间内：对超时长的天从最后一个动作往前删，服务端每次重估 est，落回区间即停
  // ------------------------------------------------------------------
  const trimToRange = async (): Promise<void> => {
    if (planId === null || !data) return;
    setTrimming(true);
    try {
      let current: PlanDetail = data;
      for (let round = 0; round < 10; round++) {
        const overDay = current.days.find((d) => {
          const w = current.plan.warnings.find((ww) => ww.datestr === d.datestr);
          if (!w) return false;
          const range = w.range as [number, number] | undefined;
          return range !== undefined && (d.est_duration_min ?? 0) > range[1];
        });
        if (!overDay || overDay.exercises.length <= 1) break;
        const victim = overDay.exercises[overDay.exercises.length - 1];
        current = await deleteExerciseApi(planId, victim.id);
      }
      qc.setQueryData(qk.plan, current);
    } catch (e) {
      setActionError(`删到区间失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setTrimming(false);
    }
  };

  // ------------------------------------------------------------------
  // V7：挪训练日的候选目标（草稿态才给）。7 天里除自己以外全部可点 ——
  // 有训练日的那些标成「交换」，让用户点之前就知道会动到别的天。
  // ------------------------------------------------------------------
  const titleByDate = new Map(data.days.map((d) => [d.datestr, d.title]));
  const moveOptions: MoveOption[] = editable
    ? weekDates(plan.week_start).map((ds) => ({
        datestr: ds,
        dow: dowOf(ds),
        occupiedTitle: titleByDate.get(ds) ?? null,
      }))
    : [];

  return (
    <div className="space-y-4">
      {/* 计划头：周次 + 状态 + 唯一的生成按钮（2026-09-30 视觉改版：包进卡片，与下方 DayCard 同语言） */}
      <div className="rounded-2xl border border-slate-200/80 bg-white px-5 py-4 shadow-[0_1px_3px_rgba(15,23,42,0.05)]">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold tracking-tight text-slate-900">
              {isStarterWeek ? '本周计划（起始周）' : '下周计划'} · {plan.week_start} ~ {plan.week_end}
            </h2>
            <p className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-slate-500">
              <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${status.cls}`}>{status.label}</span>
              <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${source.cls}`}>{source.label}</span>
              {/* 起始周徽章：明确告诉用户「这一周不算周期的第 1 周」，避免误以为是程序算错 */}
              {isStarterWeek && (
                <span
                  className="rounded bg-indigo-100 px-1.5 py-0.5 text-[10px] font-medium text-indigo-700"
                  title="本周只排剩下的训练日，不占周期第 1 周；下周起才是「第 1 周」"
                >
                  起始周（Week 0）
                </span>
              )}
              {lockedGoalText !== null && <span>· 周期目标「{lockedGoalText}」</span>}
              {plan.template_week_no !== null && <span>· 本次沿用周期第 {plan.template_week_no} 周模板</span>}
              {/* 2026-09-30 用户第 9 轮：原文案「可以直接改动作 / 组数 / 重量，也可以把整天挪到别的日期」
                  太啰嗦 ——「就可以说动作、组数、重量和日期都可以手动调整，精简一点」。 */}
              {editable && <span className="text-slate-400">· 动作、组数、重量、日期都可以手动改</span>}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-3">
            {/* 「重新全量生成」不做第二个大按钮（用户：「就有一个生成的那个按钮就行了」）。
                只在确实沿用了模板时出现 —— 否则它和「重新生成」是同一件事。 */}
            {plan.template_week_no !== null && (
              <button
                className="text-xs text-slate-500 underline decoration-dotted hover:text-indigo-600 disabled:opacity-50"
                disabled={generate.isPending}
                title="忽略上一周的模板，按完整画像重新排（动作可能大改）"
                onClick={() => {
                  setActionError(null);
                  generate.mutate({ mode: 'full' }, { onError: (e) => setActionError(`生成失败：${e.message}`) });
                }}
              >
                重新全量生成
              </button>
            )}
            {generateButton('重新生成', true)}
          </div>
        </div>
      </div>

      {actionError && <div className="rounded-lg bg-red-50 px-4 py-2 text-sm text-red-600">{actionError}</div>}

      {generate.isPending && (
        <div className="rounded-xl border border-indigo-200 bg-indigo-50 px-4 py-3 text-sm text-indigo-700">
          正在基于分析报告 + 周期目标 + 下周特殊情况生成计划……AI 调用可能要一到几分钟，生成完本页会自动刷新。
        </div>
      )}

      {/* 熔断放行橙条 */}
      <WarningsBanner warnings={plan.warnings} onTrim={() => void trimToRange()} trimming={trimming} />

      {/* DayCards —— 一周的训练日并排成**竖长条**并**整体居中**（2026-09-30 用户第 6/7 轮定稿）。
          起因：单列横卡时「动作名 + 四个输入框」中间空出 300+px，用户原话
          「如果后面都是空白的话，我们可以考虑把其他的调上来……这一行就出现两个训练日的内容」。

          🔴 这里**不能用 `grid-cols-4`**：grid 的第四列会一直占着，3 个训练日时三条只落在
             左边三格 → 靠左摆。用户第 7 轮明确要求「无论怎么样都要居中，如果三个训练日也应该居中」。
             所以用 flex + `justify-center`：条宽由 `DayCard` 自己算成「容器的四分之一」，
             剩下的空隙交给 `justify-center`，3 条 / 4 条都居中、且单条宽度完全一样。
          条与条默认等高（flex 的 align-items: stretch）。 */}
      <div className="flex flex-wrap justify-center gap-2.5">
        {data.days.map((d) => (
          <DayCard
            key={d.id}
            day={d}
            totalSessions={data.days.length}
            goalRange={null}
            disabled={!editable || updateEx.isPending || deleteEx.isPending}
            onPatchExercise={(exerciseId, patch) => {
              if (planId === null) return;
              updateEx.mutate(
                { exerciseId, patch },
                { onError: (e) => setActionError(`保存失败：${e.message}`) },
              );
            }}
            onDeleteExercise={(exerciseId) => {
              if (planId === null) return;
              deleteEx.mutate(exerciseId, {
                onError: (e) => setActionError(`删除失败：${e.message}`),
              });
            }}
            moveOptions={moveOptions}
            moving={moveDay.isPending}
            onMoveDay={(dayId, datestr) => {
              if (planId === null) return;
              setActionError(null);
              moveDay.mutate(
                { dayId, datestr },
                { onError: (e) => setActionError(`挪动失败：${e.message}`) },
              );
            }}
          />
        ))}
      </div>

      {plan.source === 'rule_fallback' && (
        <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-xs text-slate-500">
          {plan.template_week_no === null ? (
            <>
              本计划由规则模板生成（确定性算法）：动作全部来自候选白名单，why 为通用训练原则。配好 LLM 后点「重新生成」可获得数据驱动的版本。
            </>
          ) : (
            <>
              本计划是规则兜底：沿用了周期第 {plan.template_week_no} 周的动作结构（非 AI），重量换成系统算好的本周建议值。
              <b className="text-slate-600">本次没有 AI 参与，本周特殊情况没有被处理</b>，请自行核对组数与强度；配好 LLM 后点「重新生成」可获得 AI 版本。
            </>
          )}
        </div>
      )}

      {/* 导入入口（PRD §2①：确认无误后导入训记）。双栏杆在下一页，本页不写入。
          2026-09-30 用户定稿：不要那条「调整好了就导入训记」的说明条，就一个居中按钮。 */}
      {canImport && (
        <div className="flex justify-center pt-2">
          <a
            href="#/plan/confirm"
            className="rounded-xl bg-indigo-600 px-8 py-2.5 text-sm font-medium text-white shadow-[0_2px_8px_rgba(79,70,229,0.35)] transition-colors hover:bg-indigo-700"
          >
            导入训记 →
          </a>
        </div>
      )}
    </div>
  );
}
