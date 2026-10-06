/**
 * 训练周期分栏（首页排计划卡 · 左栏）。
 *
 * 2026-09-30 用户第 4 轮定稿：这一块与「下周特殊情况」**合并进同一张卡**（见 `WeekPrepCard`），
 * 所以这里只负责卡内左栏内容，不再自带卡片外壳与头栏。
 *
 * 🔴 布局纪律（用户明确要求「周期目标跟下周特殊情况的文本框要一样大」）：
 *    两栏都是 `flex flex-col` + 输入框 `flex-1` 撑满，结构必须**同构**（标签 + 框 + 操作行），
 *    否则两个框永远齐不了。为此：
 *      - 「周期目标」从单行 `<input>` 换成同高的 `<textarea>`（只要还是 input 就齐不了）
 *      - 原来那段「锁定后这 4 周内不会变 —— 想改要点卡片上的『解锁』（会问一次）…」
 *        的长说明**删掉了**：它只在未锁定态出现，会让左栏比右栏高出一截、把左边输入框压矮。
 *        锁定规则本来就是用户自己定的，卡片头「4 周 = 3 周渐进 + 1 周减量」+「解锁」按钮
 *        已经足够表达。
 *
 * 状态与交互零改动：
 *   ① 没开周期 → 填目标 + 「锁定」
 *   ② 已锁定 → 目标 + 起止 + 第 N/4 周进度条 + 红色「解锁」（二次确认，只改文案不动周期起止）
 */
import { useState } from 'react';
import { CYCLE_WEEKS, useCycle, useForceEditCycleGoal, useOpenCycle } from '../../api/client.js';
import { addDays } from '../../api/labels.js';
import { PaneHead } from '../common/ui.js';

/** 周期的最后一天 = 最后一周年起日 + 6 天（用户要「写清楚起止时间」）。 */
function cycleRange(firstWeekStart: string, lastWeekStart: string): string {
  return `${firstWeekStart} ~ ${addDays(lastWeekStart, 6)}`;
}

/**
 * 卡内左栏容器 —— 与右栏（`WeekNotePane`）同构，只有底色/分隔线不同。
 * 底色比右栏淡一档，让「长期框架」与「这周要交代的事」一眼分得开。
 *
 * 🔴 `border-r border-transparent` 不是多余的：竖线画在右栏的 `border-l` 上，
 *    哪一栏有边框，哪一栏的内容盒就窄 1px。左栏补一条同宽的透明边框，
 *    两栏内容宽度才严格相等 —— 用户要求「两个文本框要一样大」。
 */
const PANE = 'flex min-w-0 flex-col gap-2.5 border-r border-transparent bg-gradient-to-b from-[#fbfcff] to-white px-5 py-[18px]';

/** 两栏共用的输入框样式：flex-1 撑满 + 不可拖拽（拖拽会破坏两栏等高）。 */
const PANE_INPUT = 'min-h-[84px] w-full flex-1 resize-none rounded-lg border border-slate-200 px-2.5 py-2 text-sm leading-relaxed text-slate-800 placeholder:text-slate-300 focus:border-indigo-400 focus:outline-none';

export function CyclePane(): React.ReactNode {
  const cycle = useCycle();
  const open = useOpenCycle();
  const forceEdit = useForceEditCycleGoal();

  const [goalText, setGoalText] = useState('');
  /** 解锁流程：0=锁定 1=等确认 2=已解锁可编辑 */
  const [unlockStep, setUnlockStep] = useState<0 | 1 | 2>(0);
  const [draft, setDraft] = useState('');

  if (cycle.isPending) {
    return (
      <div className={PANE}>
        <PaneHead text="周期目标" />
        <div className="flex flex-1 items-center justify-center text-sm text-slate-400">加载中…</div>
      </div>
    );
  }
  if (cycle.isError) {
    return (
      <div className={PANE}>
        <PaneHead text="周期目标" />
        <div className="flex flex-1 items-center justify-center text-center text-sm text-rose-600">
          周期读取失败：{String(cycle.error)}
        </div>
      </div>
    );
  }

  const data = cycle.data;
  const c = data?.cycle ?? null;
  // ⚠️ 用 `plan_week` 而不是顶层的 `week_no`/`expired` —— 这一页讲的是**下一周**，
  //    而周期通常从下一周起算。「今天所在周」的周次在这里必然是 null（周期还没开始），
  //    拿它渲染就会出「本周期第 —/4 周」和一个假的「不在周期范围内」告警。
  const pw = data?.plan_week ?? {
    week_no: null,
    in_cycle: false,
    is_deload: false,
    expired: false,
    is_starter_week: false,
  };
  const expired = pw.expired;

  // ------------------------------------------------------------------
  // 未开周期（或上一个周期已跑完）：填入 → 锁定
  // ------------------------------------------------------------------
  if (c === null || expired) {
    // 起止区间：开始周起点 ~ 第 4 周最后一天（= 起点 + 27 天）
    const start = data?.next_week_start ?? '';
    const rangeText = start !== '' ? `${start} ~ ${addDays(start, CYCLE_WEEKS * 7 - 1)}` : '';
    const canSubmit = goalText.trim() !== '' && !open.isPending;

    return (
      <div className={PANE}>
        {/* 未锁定周期时，栏头后面跟一串灰字（形态与右栏「下周特殊情况」后面那串一致）。
            用户原话：「你就看到这个周期目标旁边有个空位，就在那个周期目标后面写一串……
            先设定周期目标才能启动。就写一个灰色的字，就像这个特殊情况一样。」
            原先那条琥珀色提示条（挂在下面的「下周计划」卡里）已整条删掉 —— 同一句话
            放在它真正所属的栏头旁边，省地方也不必在空态 / 有计划态各写一遍。
            注：PaneHead 是固定 h-5 单行 + truncate，所以这串灰字不会把左栏撑高。 */}
        <PaneHead text="周期目标" note="先设定周期目标才能启动" />

        {c !== null && expired && (
          <div className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800">
            上一个周期（{cycleRange(c.firstWeekStart, c.lastWeekStart)}，目标「{c.goalText}」）的 4 周已经跑完。开一个新周期继续。
          </div>
        )}

        <textarea
          rows={3}
          maxLength={60}
          value={goalText}
          onChange={(e) => setGoalText(e.target.value)}
          placeholder="例如：着重练胸"
          className={PANE_INPUT}
        />

        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <button
            type="button"
            disabled={!canSubmit}
            // 多行框里可能带换行，目标得是一句话 → 空白统一压成单个空格
            onClick={() =>
              open.mutate({
                goalText: goalText.trim().replace(/\s+/g, ' '),
                firstWeekStart: data?.next_week_start,
              })
            }
            className="rounded-lg bg-indigo-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-indigo-700 disabled:cursor-not-allowed disabled:bg-slate-200 disabled:text-slate-400"
          >
            {open.isPending ? '锁定中…' : '锁定'}
          </button>
          {rangeText !== '' && <span className="text-xs text-slate-500">锁定后覆盖 {rangeText}</span>}
          {open.isError && <span className="text-xs text-rose-600">开启失败：{String(open.error)}</span>}
        </div>
      </div>
    );
  }

  // ------------------------------------------------------------------
  // 已锁定
  // ------------------------------------------------------------------
  const weekNo = pw.week_no;
  const inCycle = pw.in_cycle;

  return (
    <div className={PANE}>
      <PaneHead text="周期目标" />

      {unlockStep === 2 ? (
        /* ---- 解锁态：改文案，不动周期起止与周次 ---- */
        <>
          <div className="text-xs text-amber-700">
            已解锁 —— 只改目标文案，周期起止（{cycleRange(c.firstWeekStart, c.lastWeekStart)}）与「第几周」不变。
          </div>
          <input
            type="text"
            maxLength={60}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            className="w-full rounded-lg border border-amber-300 px-2.5 py-1.5 text-sm text-slate-800 focus:border-amber-400 focus:outline-none"
          />
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              disabled={draft.trim() === '' || forceEdit.isPending}
              onClick={() =>
                forceEdit.mutate(draft.trim(), {
                  onSuccess: () => setUnlockStep(0),
                })
              }
              className="rounded-lg bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-700 disabled:cursor-not-allowed disabled:bg-slate-200 disabled:text-slate-400"
            >
              {forceEdit.isPending ? '保存中…' : '保存并重新锁定'}
            </button>
            <button
              type="button"
              onClick={() => setUnlockStep(0)}
              className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-50"
            >
              取消
            </button>
            {forceEdit.isError && <span className="text-xs text-rose-600">保存失败：{String(forceEdit.error)}</span>}
          </div>
        </>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium text-slate-900">{c.goalText}</span>
            <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-500">🔒 已锁定</span>
            {c.forceEditedAt !== null && (
              <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] text-amber-700" title={c.forceEditedAt}>
                目标被修改过
              </span>
            )}
            {unlockStep === 0 ? (
              <button
                type="button"
                onClick={() => {
                  setDraft(c.goalText);
                  setUnlockStep(1);
                }}
                className="ml-auto rounded-lg border border-red-300 px-3 py-1 text-xs font-medium text-red-600 hover:bg-red-50"
              >
                解锁
              </button>
            ) : (
              <span className="ml-auto flex flex-wrap items-center gap-2">
                <span className="text-xs text-red-600">确定要改周期目标？</span>
                <button
                  type="button"
                  onClick={() => setUnlockStep(2)}
                  className="rounded-lg bg-red-600 px-3 py-1 text-xs font-medium text-white hover:bg-red-700"
                >
                  确认解锁
                </button>
                <button
                  type="button"
                  onClick={() => setUnlockStep(0)}
                  className="rounded-lg border border-slate-300 px-2.5 py-1 text-xs text-slate-600 hover:bg-slate-50"
                >
                  取消
                </button>
              </span>
            )}
          </div>

          {/* 4 周进度条：第 4 周是减量周，用不同颜色区分 */}
          <div className="flex gap-1.5">
            {Array.from({ length: CYCLE_WEEKS }, (_, i) => i + 1).map((n) => {
              const isDeload = n === CYCLE_WEEKS;
              const done = weekNo !== null && n < weekNo;
              const now = n === weekNo;
              const cls = now
                ? isDeload
                  ? 'border-amber-400 bg-amber-50 text-amber-800'
                  : 'border-indigo-400 bg-indigo-50 text-indigo-800'
                : done
                  ? 'border-slate-200 bg-slate-100 text-slate-500'
                  : 'border-slate-200 bg-white text-slate-400';
              return (
                <div key={n} className={`flex-1 rounded-lg border px-1.5 py-1.5 text-center text-xs ${cls}`}>
                  第 {n} 周
                  <span className="mt-0.5 block text-[10px] opacity-70">{isDeload ? '减量' : '渐进'}</span>
                </div>
              );
            })}
          </div>

          <div className="text-xs text-slate-400">
            周期期间 {cycleRange(c.firstWeekStart, c.lastWeekStart)} · 第 {c.cycleNo} 个周期
          </div>

          {/* 起始周（Week 0）：本轮只排「本周剩下的训练日」，不占周期第 1 周。
              用户原话：「练完第一个残缺周下周还是显示第一周，可以在哪里写个小提示避免用户误会是程序错误」。
              下面「不在周期范围内」那条告警会被 startsWith 起点判据挡掉（周期起点是下一周），
              两种状态靠这一条区分：起始周说「占位」，真越界才说「不在范围」。 */}
          {pw.is_starter_week && (
            <div className="rounded-lg border border-indigo-300 bg-indigo-50 px-3 py-2 text-xs text-indigo-800">
              <b>起始周（Week 0）</b>：本周还剩训练日，所以先排剩下的，<b>不算周期的第 1 周</b>；从下周起才正式进入「第 1 周」。
            </div>
          )}

          {pw.is_deload && (
            <div className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800">
              这一周是<b>减量周</b>：生成的计划会自动把容量减半、强度降 10%~15%，不加重量 —— 让身体吸收前 3 周的进步。
            </div>
          )}
          {!inCycle && (
            <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600">
              下一周（{data?.next_week_start} 起）不在这个周期的 4 周范围内 —— 生成计划时不会带周期目标。
            </div>
          )}
        </>
      )}
    </div>
  );
}
