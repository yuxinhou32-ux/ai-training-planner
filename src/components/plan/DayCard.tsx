/**
 * 训练日竖长条（2026-09-30 用户第 6 轮定稿）。
 *
 * 🔴 形态变了：原来是一张横贯整行的卡片（头栏左右分列），现在首页把一周
 *    **4 个训练日并排成 4 条竖长条**，所以这里也变成一个窄列（约 228px）：
 *    头部三行（日期+周几 / 标题 / 组数）→ 动作列表。
 *
 * 🔴 「挪到别的天」按钮**删掉了**（用户原话：「那个最右边的那个挪到别天给删掉……直接在那个
 *    时间里面做一个修订和那个滚轮……滚轮里面只有周一到周天……那个日期就不让他改了，
 *    日期到时候就是他选到周一到周天之后，它自动那个固定上」）→ 换成 `DowPicker`：
 *    日期只读（由「本周起点 + 星期几」算出来），能改的只有星期几，且只有本周 7 天。
 *    目标日已经有训练日时，服务端语义仍是**对调**（内容都保留），下拉里用 `⇄` 标出来。
 */
import { useState } from 'react';
import type { PlanDay } from '../../api/client.js';
import { DOW_ZH as DOW_LABEL, muscleZh } from '../../api/labels.js';
import { ExerciseRow } from './ExerciseRow.js';

/** 改日期控件要用的候选（本周 7 天各一条）。 */
export interface MoveOption {
  datestr: string;
  dow: number;
  /** 该日已被另一个训练日占用时给出它的标题 —— 选了就是交换。null = 空日。 */
  occupiedTitle: string | null;
}

function MuscleChips({ muscles }: { muscles: string[] }): React.ReactNode {
  if (muscles.length === 0) return null;
  return (
    <span className="flex min-w-0 shrink items-center gap-1 overflow-hidden">
      {muscles.map((m) => (
        <span key={m} className="shrink-0 rounded bg-indigo-50 px-1.5 py-0.5 text-[10px] text-indigo-600" title={m}>
          {muscleZh(m)}
        </span>
      ))}
    </span>
  );
}

/**
 * 「改到本周哪一天」。
 *
 * 用原生 `<select>` 而不是自绘下拉：移动端原生 select 就是**滚轮**，桌面端是一张列表 ——
 * 两种形态正好都是用户要的，而且自绘下拉还得自己处理「点外面关闭」。
 *
 * ⚠️ 显示层单独画：select 收起时会把选中项的**完整文字**显示出来
 *    （「周三 ⇄ 背 + 二头　10-07」），在 228px 的竖条里太长。所以 chip 是独立画的，
 *    真正那个 select 用 `opacity-0 absolute inset-0` 盖在它上面，只负责弹出列表。
 */
function DowPicker(props: {
  options: MoveOption[];
  currentDatestr: string;
  dow: number;
  busy: boolean;
  onPick: (datestr: string) => void;
}): React.ReactNode {
  return (
    <span className="relative inline-flex shrink-0 items-center">
      <span className="flex items-center gap-1 rounded-md bg-indigo-50 px-1.5 py-0.5 text-[11px] font-medium text-indigo-700">
        {DOW_LABEL[props.dow]}
        <span aria-hidden="true" className="text-[8px] leading-none opacity-60">
          ▼
        </span>
      </span>
      <select
        aria-label="把这天的内容改到本周的哪一天"
        title="改到本周的哪一天（日期会跟着变，不会跨周）"
        value={props.currentDatestr}
        disabled={props.busy}
        onChange={(e) => {
          // 选回当前那天什么都不做 —— 否则会白发一次「挪动」请求
          if (e.target.value !== props.currentDatestr) props.onPick(e.target.value);
        }}
        className="absolute inset-0 w-full cursor-pointer opacity-0 disabled:cursor-wait"
      >
        {props.options.map((o) => (
          <option key={o.datestr} value={o.datestr}>
            {DOW_LABEL[o.dow]} {o.datestr.slice(5)}
            {o.datestr === props.currentDatestr
              ? '（当前）'
              : o.occupiedTitle !== null
                ? ` ⇄ ${o.occupiedTitle}`
                : ' 空'}
          </option>
        ))}
      </select>
    </span>
  );
}

export function DayCard(props: {
  day: PlanDay;
  totalSessions: number;
  goalRange: [number, number] | null;
  disabled?: boolean;
  /** 传了才给「改到本周哪一天」的下拉（草稿态才有）。 */
  moveOptions?: MoveOption[];
  moving?: boolean;
  onMoveDay?: (dayId: number, datestr: string) => void;
  onPatchExercise: (exerciseId: number, patch: Record<string, unknown>) => void;
  onDeleteExercise: (exerciseId: number) => void;
}): React.ReactNode {
  const { day, totalSessions, goalRange, disabled, moveOptions, moving, onMoveDay, onPatchExercise, onDeleteExercise } =
    props;
  const [showWhy, setShowWhy] = useState(false);
  const totalSets = day.exercises.reduce((s, e) => s + e.sets, 0);
  const est = day.est_duration_min;
  const outOfRange = goalRange !== null && est !== null && (est < goalRange[0] || est > goalRange[1]);
  const canMove = moveOptions !== undefined && moveOptions.length > 0 && onMoveDay !== undefined;
  // 「为什么这样安排？」：没有内容就整块不出现（留 null 收窄类型，别用 boolean）
  const dayWhy =
    day.why !== null && (day.why.summary !== '' || day.why.evidence_refs.length > 0) ? day.why : null;

  return (
    /*
     * 🔴 条宽是「容器的四分之一」而不是固定像素（2026-09-30 用户第 7 轮）：
     *    - `gap-2.5` = 10px，四个之间共 3 条间隙 = 30px = `1.875rem`，所以要减掉它再除 4
     *    - 不设 `flex-grow`，所以 3 个训练日时三条**不会**被拉宽，多出来的空间由列表的
     *      `justify-center` 平分在两侧 → 3 条 / 4 条都是居中的，且单条宽度完全一致
     *    - `max-w-[228px]`：宽屏下内容区撑到 944px 时单条正好 228px，再宽也不继续长
     *    - `min-w-[160px]`：窄屏的兜底 —— 比这个还窄时训练量那行（62+60+间隔+内边距 ≈ 156px）
     *      就放不下了，所以让它换行而不是继续压
     */
    <section className="flex w-[calc((100%-1.875rem)/4)] min-w-[160px] max-w-[228px] flex-col rounded-xl border border-slate-200 bg-white">
      {/* 头部三行：日期 + 周几下拉 / 标题 / 组数 */}
      <div className="rounded-t-xl border-b border-slate-100 bg-gradient-to-b from-[#fbfcff] to-white px-3 py-2.5">
        <div className="flex items-center gap-1.5">
          <span className="shrink-0 text-xs font-semibold tabular-nums text-slate-600">{day.datestr.slice(5)}</span>
          {canMove ? (
            <DowPicker
              options={moveOptions}
              currentDatestr={day.datestr}
              dow={day.dow}
              busy={moving === true}
              onPick={(datestr) => onMoveDay(day.id, datestr)}
            />
          ) : (
            <span className="shrink-0 rounded-md bg-slate-100 px-1.5 py-0.5 text-[11px] font-medium text-slate-500">
              {DOW_LABEL[day.dow]}
            </span>
          )}
          <span
            className={`ml-auto shrink-0 text-[11px] tabular-nums ${outOfRange ? 'font-medium text-amber-600' : 'text-slate-400'}`}
          >
            {est === null ? '—' : `${est} 分钟`}
            {outOfRange && goalRange !== null && (
              <span title={`目标 ${goalRange[0]}–${goalRange[1]} 分钟`}> ⚠</span>
            )}
          </span>
        </div>

        <div className="mt-1 flex min-w-0 items-center gap-1.5">
          {day.title !== '' && (
            <h3 className="truncate text-[13px] font-semibold text-slate-900" title={day.title}>
              {day.title}
            </h3>
          )}
          <MuscleChips muscles={day.target_muscles} />
        </div>

        <div className="mt-0.5 text-[11px] text-slate-400">
          {totalSets} 组 · 第 {day.ord}/{totalSessions} 练
        </div>
      </div>

      {/* 动作列表：项目内 6px、项目间 20px（py-1.5 ×2 + space-y-2） */}
      <div className="flex-1 space-y-2 px-1.5 py-2">
        {day.exercises.map((e) => (
          <ExerciseRow key={e.id} exercise={e} disabled={disabled} onPatch={onPatchExercise} onDelete={onDeleteExercise} />
        ))}
        {day.exercises.length === 0 && (
          <div className="px-2 py-4 text-center text-xs text-slate-400">这一天没有动作了（可让 AI 重新平衡）</div>
        )}
      </div>

      {dayWhy !== null && (
        <div className="border-t border-slate-100 px-3 py-2">
          <button className="text-[11px] text-indigo-600 hover:underline" onClick={() => setShowWhy((v) => !v)}>
            {showWhy ? '收起为什么' : '为什么这样安排？'}
          </button>
          {showWhy && (
            <div className="mt-2 rounded-lg bg-slate-50 p-2.5 text-[11px] leading-snug text-slate-600">
              <p>{dayWhy.summary}</p>
              {dayWhy.evidence_refs.length > 0 && (
                <ul className="mt-2 space-y-1">
                  {dayWhy.evidence_refs.map((ref, i) => (
                    <li key={i} className="flex gap-1.5">
                      <span className="shrink-0 rounded bg-white px-1 text-[10px] text-slate-400" title={`引用类型 ${ref.type}`}>
                        {ref.type}
                      </span>
                      <span className="text-slate-500">{ref.text}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
