/**
 * 计划周特殊情况分栏（首页排计划卡 · 右栏）。
 *
 * 🔴 它是排计划时**优先级最高**的输入，**不是**复盘页的感受：
 *   用户原话：「本周特殊情况不应该是复盘里面感受里面的……本周特殊情况是需要做计划的时候
 *   需要考虑的。比如说我在经期，他给我排计划的时候就应该给我减量。临时不舒服也是一样。」
 *   以及「要有一个小的文本框可以给我输入，它的优先级应该是最高的，因为你需要考虑本周的
 *   特殊情况，因为比如说周期内我可能需要练胸……但是我这周来了经期，所以你要先考虑我在
 *   经期内，然后再考虑我这周练胸，这是一个优先级的问题。」
 *
 * 所以它是**独立存储**（`week_note`，按计划周一行）——
 * 与复盘页的 `daily_note`（逐日感受）完全分开：
 *   这边 = 事前、给排计划；那边 = 事后、给复盘（→ 复盘建议 → 绕一圈才回到计划）。
 *
 * 2026-09-30 用户第 4 轮定稿：与「训练周期」合并进同一张卡（见 `WeekPrepCard`），
 * 这里只负责卡内右栏内容。布局必须与左栏**同构**（标签 + 框 + 操作行），
 * 输入框都是 `flex-1` 撑满 —— 用户原话「周期目标跟下周特殊情况的文本框要一样大」。
 */
import { useState } from 'react';
import { useSaveWeekNote, useWeekNote } from '../../api/client.js';
import { PaneHead } from '../common/ui.js';

/** 卡内右栏容器 —— 与左栏（`CyclePane`）同构，只多一条分隔线。 */
const PANE = 'flex min-w-0 flex-col gap-2.5 border-l border-slate-100 px-5 py-[18px]';

/** 与左栏一致的输入框样式。 */
const PANE_INPUT = 'min-h-[84px] w-full flex-1 resize-none rounded-lg border border-slate-200 px-2.5 py-2 text-sm leading-relaxed text-slate-800 placeholder:text-slate-300 focus:border-indigo-400 focus:outline-none';

export function WeekNotePane(): React.ReactNode {
  const note = useWeekNote();
  const save = useSaveWeekNote();

  // ⚠️ 初值必须在**渲染期**派生（`draft === null` 时直接读服务端值），不能只靠 useEffect ——
  //    否则 SSR 会永远停在空框（V1 的 GoalForm 踩过同一个坑）。
  //    draft 只在用户开始打字后才存在；保存成功后置回 null = 重新跟随服务端。
  const serverText = note.data?.text ?? '';
  const [draft, setDraft] = useState<string | null>(null);
  const value = draft ?? serverText;
  const dirty = draft !== null && draft !== serverText;

  return (
    <div className={PANE}>
      {/* 栏头备注（2026-09-30 用户第 6 轮）：原来写「2026-10-05 那一周 · 排计划时优先级最高」，
          用户嫌啰嗦 ——「这个后面备注的字有点太啰嗦了，你就直接写优先级最高就好了」。
          周次信息本来就由左边那条竖长条的日期承担，这里不必再重复。 */}
      <PaneHead text="下周特殊情况" note="优先级最高" />

      <textarea
        rows={3}
        maxLength={500}
        value={value}
        onChange={(e) => setDraft(e.target.value)}
        placeholder="例如：周三开始来经期，整体减量"
        className={PANE_INPUT}
      />

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <button
          type="button"
          disabled={!dirty || save.isPending}
          onClick={() => save.mutate(value, { onSuccess: () => setDraft(null) })}
          className="rounded-lg bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-700 disabled:cursor-not-allowed disabled:bg-slate-200 disabled:text-slate-400"
        >
          {save.isPending ? '保存中…' : '保存'}
        </button>
        {dirty && <span className="text-xs text-amber-600">有未保存的修改</span>}
        {!dirty && !save.isPending && serverText !== '' && (
          <span className="text-xs text-emerald-600">已保存，生成计划时 AI 会看到</span>
        )}
        {save.isError && <span className="text-xs text-rose-600">保存失败：{String(save.error)}</span>}
        {note.isError && <span className="text-xs text-rose-600">读取失败：{String(note.error)}</span>}
      </div>
    </div>
  );
}
