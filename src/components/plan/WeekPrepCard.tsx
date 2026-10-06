/**
 * 首页「排计划」卡（2026-09-30 用户第 4 轮定稿）—— 把原来两张独立的卡合并成一张，左右两栏。
 *
 * 为什么要合（用户原话）：
 *   「这个训练周期和这个下周特殊情况不能用统一的模块吗？这一个长一个一个短，
 *     然后一个有两行，一个只有一行的。太臭了，太臭了，实在是。」
 *   「这太丑了，这中间隔这么大，真的不好看。」
 * 原来两张卡各有一个头栏、内容长短不一（周期卡 4 行/约 200px、特殊情况卡 2 行/约 140px），
 * 中间还空着 16px。合并后：**一个头栏 + 一条竖线分两栏**，卡高由高的那栏决定，
 * 「一长一短」从结构上消失。
 *
 * 左右分工：
 *   左 = 训练周期（4 周的框架：目标 / 第几周 / 进度 / 起止）
 *   右 = 下周特殊情况（这周要交代的事，每周都写，所以给它更宽）
 *
 * 🔴 标题保留「训练周期」四个字：改版前锁定后标题会整个变成「本周期第 N/4 周」，
 *    「训练周期」消失、认不出这一块是什么。现在写「训练周期 第 N/4 周」，两边都在。
 */
import { CYCLE_WEEKS, useCycle } from '../../api/client.js';
import { CyclePane } from './CycleCard.js';
import { WeekNotePane } from './WeekNoteForm.js';

export function WeekPrepCard(): React.ReactNode {
  const cycle = useCycle();
  const c = cycle.data?.cycle ?? null;
  const expired = cycle.data?.plan_week.expired ?? false;
  /** 只有「有周期且没过期」才谈得上第几周 */
  const weekNo = c !== null && !expired ? (cycle.data?.plan_week.week_no ?? null) : null;

  return (
    <section className="overflow-hidden rounded-2xl border border-slate-200/80 bg-white shadow-[0_1px_3px_rgba(15,23,42,0.05)]">
      <div className="flex items-center justify-between gap-3 border-b border-slate-100 px-5 py-3.5">
        <h2 className="flex min-w-0 items-center gap-2.5 text-[15px] font-semibold tracking-tight text-slate-800">
          <span aria-hidden="true" className="h-4 w-1 shrink-0 rounded-full bg-gradient-to-b from-indigo-500 to-violet-500" />
          <span className="truncate">
            训练周期
            {weekNo !== null && (
              <span className="ml-2 text-[13px] font-medium text-slate-500">
                第 {weekNo}/{CYCLE_WEEKS} 周
              </span>
            )}
          </span>
        </h2>
        <span className="shrink-0 text-xs text-slate-400">{CYCLE_WEEKS} 周 = 3 周渐进 + 1 周减量</span>
      </div>

      {/*
        两栏**等宽**（`grid-cols-2` = `repeat(2, minmax(0, 1fr))`）——
        用户对未开周期态的明确要求是「周期目标和下周特殊情况的文本框要一样大」，
        所以这里不能用 46/54。`minmax(0, …)` 顺带保证长内容不会把栏撑破。
      */}
      <div className="grid grid-cols-2 items-stretch">
        <CyclePane />
        <WeekNotePane />
      </div>
    </section>
  );
}
