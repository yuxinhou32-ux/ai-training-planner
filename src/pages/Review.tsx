/**
 * 周复盘页（PRD-v2 §10.3 V8）：手账式的一周回顾。
 *
 * 自上而下（2026-09-30 第 4 轮定稿）：
 *   ① 顶部条   周选择器（新→旧）+ 完成率 —— 就这两样，不再有 4 张统计小卡
 *   ② AI 总结  「本周总结」卡：未生成时缩成一行（标题 + 生成按钮），
 *              已生成展示 verdict / adjustments / note_reply；draft 时给琥珀提示
 *   ③ 逐日手账 **只列这一周真的练了的那些天**，手账式大卡：当天每个动作做了几组、
 *              逐组重量×次数，下面一个给足空间的感受输入框
 *
 * 2026-09-30 用户定案（第 3 轮）：
 *   - 「没有排训练的日期，你就不要有那个训练感受填了……只有有训练的日期，你才有那个感受。
 *      没有训练的，你就直接给它删了。」→ 逐日列表按**实际有训练记录**过滤（判据：
 *      有效组 > 0，来自全局唯一的 isEffectiveSet 口径）。没练的天整行不渲染，
 *      连感受框一起不出现 —— 不给「没练的那天」留一个空输入框勾着人写。
 *   - 「它这个总结是每周生成一次，不是四周生成一次」→ **删掉本页底部那个「4 周中期总结」
 *      折叠块**（连同 reviewService 整条链路）。这一页的总结只有一种节奏：**每周一次**。
 *   - 「你不用把它收起来了……这块要展开」→ AI 总结区直接展开显示，不做折叠。
 *
 * 默认落点：**最近一个已结束的周**。本周（今天所在的那一周）永远 `is_over = false`，
 * 默认停在它上面只会看到一个禁用的按钮 —— 而那正是用户要复盘的那一周的下一周。
 *
 * 红线：感受（daily_note）只写本地库，**不同步回训记**（§6 决策 1）。
 *       与 train_session.note 不是一回事 —— 后者实测 91% 是训记自动写入的「calorie:284」这类
 *       机器字段，不能当主观信号（PRD-v2 砍除清单 C11）。所以这一页的感受只服务本地复盘。
 *
 * 数据口径：周级数字由服务端取自 V6 的 loadPlanActual（与排计划时看到的是同一份），
 *           前端只做展示，不重算完成率、不另写一套「算不算练了」。
 */
import { Fragment, useEffect, useRef, useState } from 'react';
import {
  useGenerateWeeklyReview,
  useReviewWeeks,
  useSaveDailyNote,
  useWeekView,
  type WeekDayRow,
  type WeekView,
} from '../api/client.js';
import { DOW_ZH, muscleZh } from '../api/labels.js';
import { PaneHead, SectionCard } from '../components/common/ui.js';

// ---------------------------------------------------------------------------
// 常量与小组件
// ---------------------------------------------------------------------------

/**
 * 每天的状态徽章。
 *
 * 过滤掉「没训练的天」之后，实际会渲染出来的只有 done / partial / extra 三种；
 * missed / rest / upcoming 仍是服务端的合法状态（周视图接口照旧返回 7 天），
 * 这里保留定义是为了类型完整 —— 别以为它们已经废弃了。
 */
const DAY_STATUS: Record<WeekDayRow['status'], { label: string; cls: string }> = {
  done: { label: '达标', cls: 'bg-emerald-100 text-emerald-700' },
  partial: { label: '未完成', cls: 'bg-amber-100 text-amber-700' },
  missed: { label: '没练', cls: 'bg-red-100 text-red-700' },
  extra: { label: '额外加练', cls: 'bg-sky-100 text-sky-700' },
  rest: { label: '休息', cls: 'bg-slate-200 text-slate-600' },
  upcoming: { label: '未到', cls: 'bg-slate-100 text-slate-400' },
};

type SaveStatus = 'saving' | 'saved' | { error: string };

/** week_start + 6 天 = week_end（YYYY-MM-DD）。 */
function weekEndOf(weekStart: string): string {
  const base = new Date(`${weekStart}T00:00:00Z`);
  return new Date(base.getTime() + 6 * 86_400_000).toISOString().slice(0, 10);
}

/** 本地今天（YYYY-MM-DD）。服务端也返回 today，但它在数据到达前就要用来选默认周。 */
function todayLocalStr(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * 默认看哪一周：**最近一个已结束的周**（week_end < today），找不到才退回第一项。
 *
 * 为什么不是第一项：列表第一项是「本周」，而本周永远还没结束（`is_over=false`），
 * 停在它上面只会看到一个禁用的按钮 —— 用户要复盘的永远是刚过完的那一周。
 */
function defaultWeek(weeks: string[], today: string): string | null {
  return weeks.find((w) => weekEndOf(w) < today) ?? weeks[0] ?? null;
}

/** 选择器里的显示形态：2026-09-28 ~ 10-04。 */
function weekLabel(weekStart: string): string {
  return `${weekStart} ~ ${weekEndOf(weekStart).slice(5)}`;
}

function pctOf(n: number | null): string {
  return n === null ? '—' : `${Math.round(n * 100)}%`;
}

/**
 * 「这一周算不算练了」的唯一判据 —— 与服务端 `isEffectiveSet` 同源：
 * 只有实际有效组 > 0 的日子才进逐日列表。会话数也带上，兜住「有会话但一组都没算数」的边角。
 */
function hasTraining(row: WeekDayRow): boolean {
  return row.actual.effective_sets > 0 || row.actual.sessions > 0;
}

// ---------------------------------------------------------------------------
// 每日感受输入框：本地 state + 防抖 800ms 自动保存
// ---------------------------------------------------------------------------

/**
 * 感受输入框。
 *
 * 关键点：**本地值只在挂载时从服务端初始化一次**，之后不再用 effect 回灌 ——
 * 保存成功后父级会就地更新缓存并重渲染，若在这里 `useEffect([initial])` 把服务端值写回
 * 本地 state，用户正在输入的光标/内容就会被回灌打断。组件按 `datestr` 作 key，
 * 切换周时整体重挂载，自然拿到新一周的值，无需回灌。
 */
function DayNoteEditor(props: {
  datestr: string;
  initial: string;
  onSave: (datestr: string, text: string) => void;
  status: SaveStatus | undefined;
}): React.ReactNode {
  const { datestr, initial, onSave, status } = props;
  const [value, setValue] = useState(initial);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** 上一次已提交给服务端的值，避免重复提交。 */
  const saved = useRef(initial);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const submit = (next: string): void => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    if (next === saved.current) return;
    saved.current = next;
    onSave(datestr, next);
  };

  return (
    /**
     * 🔴 2026-09-30 用户第 4 轮定稿的板块逻辑：
     *   「训练感受和动作和组数不是同一个板块，但动作和组数是同一个板块里面的两个小内容。」
     * 所以这里用 flex 列 + textarea flex-1 撑满 —— 感受框的高度自动等于左栏动作列表的高度，
     * 中间不会塌出一条空档（旧版把感受整段放下面，中间空一大截）。
     */
    <div className="flex min-h-0 flex-1 flex-col">
      <textarea
        rows={4}
        value={value}
        placeholder="这天练得怎么样 / 哪个动作没做到位 / 下次要不要加重量"
        onChange={(e) => {
          const next = e.target.value;
          setValue(next);
          if (timer.current) clearTimeout(timer.current);
          timer.current = setTimeout(() => {
            timer.current = null;
            if (next === saved.current) return;
            saved.current = next;
            onSave(datestr, next);
          }, 800);
        }}
        onBlur={() => submit(value)}
        className="min-h-[110px] w-full flex-1 resize-none rounded-xl border border-slate-200 bg-white px-3.5 py-3 text-sm leading-relaxed text-slate-800 placeholder:text-slate-300 focus:border-indigo-400 focus:outline-none"
      />
      <div className="mt-0.5 h-4 text-right text-[11px] text-slate-400">
        {status === 'saving' && '保存中…'}
        {status === 'saved' && <span className="text-emerald-600">已保存</span>}
        {status !== undefined && typeof status === 'object' && (
          <span className="text-red-500">保存失败：{status.error}</span>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 逐日手账行（只渲染「这一周真的练了」的那些天）
// ---------------------------------------------------------------------------

function DayRow(props: {
  row: WeekDayRow;
  onSave: (datestr: string, text: string) => void;
  status: SaveStatus | undefined;
}): React.ReactNode {
  const { row, onSave, status } = props;
  const st = DAY_STATUS[row.status];
  const muscles = row.planned?.target_muscles ?? [];

  return (
    <section className="overflow-hidden rounded-2xl border border-slate-200/80 bg-white shadow-[0_1px_3px_rgba(15,23,42,0.05)]">
      {/* 头：日期 · 标题 · 状态徽章 | 右侧该天完成率 */}
      <div className="flex items-start justify-between gap-3 border-b border-slate-100 px-5 py-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="rounded-md bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-500">
              {row.datestr.slice(5)} {DOW_ZH[row.dow]}
            </span>
            <span className="truncate text-[15px] font-semibold text-slate-900">
              {row.planned?.title ?? '计划外加练'}
            </span>
            <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${st.cls}`}>{st.label}</span>
          </div>

          {muscles.length > 0 && (
            <div className="mt-1.5 flex flex-wrap gap-1">
              {muscles.map((m) => (
                <span key={m} className="rounded bg-indigo-50 px-1.5 py-0.5 text-[10px] text-indigo-600">
                  {muscleZh(m)}
                </span>
              ))}
            </div>
          )}

          <div className="mt-1.5 text-xs text-slate-500">
            实际 {row.actual.movements} 个动作 · {row.actual.effective_sets} 有效组
            {row.actual.duration_min !== null && ` · ${row.actual.duration_min} 分钟`}
          </div>
        </div>

        <div className="shrink-0 text-right">
          <div className="text-lg font-bold tracking-tight text-slate-900">{pctOf(row.completion)}</div>
          <div className="text-[11px] text-slate-400">完成率</div>
        </div>
      </div>

      {/*
        下半部 = 左右两栏（2026-09-30 用户第 4 轮定稿）。
        左：动作名 ｜ 竖线 ｜ 「N 组 · XXkg」—— 动作与组数是**同一个板块的两个小内容，必须靠紧**；
        右：训练感受 —— **另一个板块**，与左边之间允许留一段间隔。
        竖线位置固定跟在「最长动作名 + 固定间隔」后面：两列都是 max-content，
        所以每行的竖线与组数天然对齐成一列，动作名后面不会再拖出一大片空白。
        次数不展示（用户：每组次数基本固定在 8~10，写出来太占位置）。
      */}
      <div className="flex items-stretch">
        <div className="min-w-0 flex-1 px-5 py-4">
          {row.actual.items.length > 0 && (
            <div className="grid grid-cols-[minmax(0,max-content)_max-content]">
              {row.actual.items.map((it) => (
                <Fragment key={it.name}>
                  <div className="truncate py-1 pr-5 text-sm font-medium text-slate-800">{it.name}</div>
                  <div className="whitespace-nowrap border-l border-slate-100 py-1 pl-3.5 text-xs text-slate-400">
                    <span className="font-medium text-slate-600">{it.sets} 组</span>
                    {it.weight !== '' && <span className="ml-1.5">· {it.weight}</span>}
                  </div>
                </Fragment>
              ))}
            </div>
          )}
        </div>

        <div className="flex flex-[0_0_60%] flex-col gap-2.5 border-l border-slate-100 bg-gradient-to-b from-[#fbfcff] to-white px-5 py-4">
          <div className="shrink-0">
            <PaneHead text="训练感受" />
          </div>
          <DayNoteEditor datestr={row.datestr} initial={row.note ?? ''} onSave={onSave} status={status} />
        </div>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// AI 总结区（每周一次；直接展开，不折叠）
// ---------------------------------------------------------------------------

/**
 * 「生成总结」的放行条件取自**服务端下发的 `view.lock`**（`reviewLockReason`，唯一判据）。
 *
 * 🔴 以前这里手工镜像了服务端的两条硬规则，两边随时可能漂移（UI 看着能点、点下去吃 400）。
 *    现在只读 `lock`：非 null = 锁定（灰掉 + 不可点），`lock.reason` 作 title 与说明，
 *    `lock.label` 作按钮短文案。`pre_takeover` / `no_takeover` 这两种由页面层整页拦下，
 *    根本不会走到这里（见 ReviewPage）。
 */
function AiSummarySection(props: {
  view: WeekView;
  generating: boolean;
  onGenerate: () => void;
}): React.ReactNode {
  const { view, generating, onGenerate } = props;
  const review = view.review;
  /** 非 null = 锁定（灰掉 + 不可点），reason 就是原因。 */
  const lock = view.lock;
  const lockLabel = lock !== null ? lock.label : '生成总结';

  // 未生成：只有「本周总结」标题 + 旁边一个生成按钮，正文一行带过（用户定稿：缩到最小）。
  if (review === null) {
    return (
      <SectionCard
        title="本周总结"
        extra={
          <button
            className="rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-700 disabled:cursor-not-allowed disabled:bg-slate-200 disabled:text-slate-400"
            disabled={generating || lock !== null}
            title={lock?.reason ?? '生成这一周的总结，它会成为下一周排计划的参考'}
            onClick={onGenerate}
          >
            {generating ? '生成中…' : lockLabel}
          </button>
        }
      >
        <div className="py-1 text-sm text-slate-400">
          {lock !== null ? `🔒 ${lock.reason}` : '还没生成 —— 点右上「生成」做一次这一周的复盘。'}
        </div>
      </SectionCard>
    );
  }

  const ai = review.ai_summary;
  return (
    <SectionCard
      title={
        <span>
          本周总结
          <span
            className={`ml-2 rounded px-1.5 py-0.5 text-[10px] ${
              review.status === 'done' ? 'bg-emerald-100 text-emerald-700' : 'bg-amber-100 text-amber-700'
            }`}
          >
            {review.status === 'done' ? '数据 + AI' : '仅数据'}
          </span>
        </span>
      }
      extra={
        review.status === 'draft' ? (
          <button
            className="rounded-lg border border-indigo-300 bg-white px-3 py-1.5 text-xs text-indigo-700 hover:bg-indigo-50 disabled:cursor-not-allowed disabled:border-slate-200 disabled:bg-slate-100 disabled:text-slate-400"
            disabled={generating || lock !== null}
            title={lock?.reason}
            onClick={onGenerate}
          >
            {generating ? '生成中…' : '补齐 AI 部分'}
          </button>
        ) : (
          <button
            className="text-xs text-indigo-600 hover:underline disabled:cursor-not-allowed disabled:text-slate-400 disabled:no-underline"
            disabled={generating || lock !== null}
            title={lock?.reason}
            onClick={onGenerate}
          >
            {generating ? '生成中…' : '重新生成'}
          </button>
        )
      }
    >
      {ai !== null ? (
        <div className="space-y-2">
          <div className="text-base font-semibold text-slate-900">{ai.verdict}</div>
          {ai.adjustments.length > 0 && (
            <ul className="list-inside list-disc space-y-0.5 text-sm text-slate-700">
              {ai.adjustments.slice(0, 4).map((a, i) => (
                <li key={i}>{a}</li>
              ))}
            </ul>
          )}
          {ai.note_reply.trim() !== '' && (
            <div className="border-l-2 border-slate-200 pl-3 text-sm text-slate-500">{ai.note_reply}</div>
          )}
          <div className="pt-1 text-[11px] text-slate-400">
            上面的「下周微调」会作为输入喂给下周的排计划（和你的感受一起）。
          </div>
        </div>
      ) : (
        <div className="text-sm text-slate-400">只有数据部分，AI 结论暂缺。</div>
      )}

      {review.status === 'draft' && (
        <div className="mt-3 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-700">
          AI 部分暂缺，可点右上「补齐 AI 部分」重试（数据部分照常可信）。
        </div>
      )}
    </SectionCard>
  );
}

// ---------------------------------------------------------------------------
// 页面
// ---------------------------------------------------------------------------

export function ReviewPage(): React.ReactNode {
  const weeksQ = useReviewWeeks();
  const weeks = weeksQ.data ?? [];

  const [selected, setSelected] = useState<string | null>(null);
  // 未手动选择时默认「最近一个已结束的周」（本周永远没结束，停在它上面只能看到禁用按钮）。
  const weekStart = selected ?? defaultWeek(weeks, todayLocalStr());

  const view = useWeekView(weekStart);
  const saveNote = useSaveDailyNote();
  const generateWeek = useGenerateWeeklyReview();

  const [noteStatus, setNoteStatus] = useState<Record<string, SaveStatus>>({});
  const [genMsg, setGenMsg] = useState<{ kind: 'ok' | 'warn' | 'err'; text: string } | null>(null);

  const data = view.data ?? null;

  /**
   * 保存一天感受。成功/失败只改这一天的轻量状态文字；
   * 缓存由 useSaveDailyNote 就地更新，不触发整页 refetch（否则会打断其他输入框）。
   */
  const handleSaveDay = (datestr: string, text: string): void => {
    if (weekStart === null) return;
    setNoteStatus((s) => ({ ...s, [datestr]: 'saving' }));
    saveNote.mutate(
      { weekStart, datestr, text },
      {
        onSuccess: () => setNoteStatus((s) => ({ ...s, [datestr]: 'saved' })),
        onError: (e) => setNoteStatus((s) => ({ ...s, [datestr]: { error: e.message } })),
      },
    );
  };

  const handleGenerateWeek = (): void => {
    if (weekStart === null) return;
    setGenMsg(null);
    generateWeek.mutate(weekStart, {
      onSuccess: (r) =>
        setGenMsg(
          r.status === 'done'
            ? { kind: 'ok', text: '总结已生成 —— 下周排计划时会作为参考' }
            : { kind: 'warn', text: r.detail ?? 'AI 部分暂缺，数据部分已生成，可重试' },
        ),
      onError: (e) => setGenMsg({ kind: 'err', text: `生成失败：${e.message}` }),
    });
  };

  const cycle = data?.cycle ?? null;

  // 逐日列表：只留真的练了的那几天（没练的整行不渲染，连感受框一起去掉）。
  const trainedRows = (data?.days ?? []).filter(hasTraining);

  // 周完成率（2026-09-30 用户定稿：4 张小卡删掉，只把完成率放在顶部时间旁边；
  // 「训练日完成 / 有效组 / 练过的天」全部不再展示 —— 数字在手账里每天都有）。
  const completionText =
    data !== null && data.plan !== null && data.summary.planned_sets > 0 ? pctOf(data.summary.completion) : '—';

  /**
   * 接管前历史周 / 尚未接管：整页只给一张说明卡。
   *
   * 🔴 产品模型：历史训练数据只进训练画像、不进复盘；只有「接管之后」练完的周才复盘。
   *    判定用服务端下发的 `lock.code`（唯一判据），前端不再自己镜像规则。
   */
  const takeoverBlocked = data?.lock?.code === 'pre_takeover' || data?.lock?.code === 'no_takeover';

  return (
    <div className="space-y-5">
      {/* ① 顶部条：时间（周选择器）+ 完成率，就这两样 */}
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h1>复盘 · 本周</h1>
          <p className="mt-0.5 text-xs text-slate-500">
            一周结束后同步训记的历史，这里只列<b>练了的那些天</b>，每天写一句感受，然后生成一次总结。
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div
            className="flex items-center gap-1.5 rounded-xl border border-slate-200/80 bg-white px-3 py-1.5 shadow-[0_1px_2px_rgba(15,23,42,0.04)]"
            title="实际有效组 / 计划组；这一周没排计划时为 —"
          >
            <span className="text-xs text-slate-500">完成率</span>
            <span className="text-sm font-semibold text-slate-900">{completionText}</span>
          </div>
          <select
            className="rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-sm text-slate-700 focus:border-indigo-400 focus:outline-none disabled:opacity-50"
            value={weekStart ?? ''}
            disabled={weeksQ.isPending || weeks.length === 0}
            onChange={(e) => {
              setSelected(e.target.value);
              setGenMsg(null);
            }}
          >
            {weeks.length === 0 && <option value="">—</option>}
            {weeks.map((w) => (
              <option key={w} value={w}>
                {weekLabel(w)}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* 周期标签 */}
      {cycle !== null && (
        <div className="flex items-center gap-2 text-xs text-slate-500">
          <span>
            本周期第 {cycle.week_no}/{cycle.total_weeks} 周 · 目标「{cycle.goal_text}」
          </span>
          {cycle.is_deload && (
            <span className="rounded bg-orange-100 px-1.5 py-0.5 text-[10px] font-medium text-orange-700">减量周</span>
          )}
        </div>
      )}

      {/* 生成结果提示 */}
      {genMsg !== null && (
        <div
          className={`rounded-lg border px-3 py-2 text-sm ${
            genMsg.kind === 'ok'
              ? 'border-emerald-300 bg-emerald-50 text-emerald-700'
              : genMsg.kind === 'warn'
                ? 'border-amber-300 bg-amber-50 text-amber-700'
                : 'border-red-300 bg-red-50 text-red-700'
          }`}
        >
          {genMsg.text}
        </div>
      )}

      {view.error && (
        <div className="rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700">
          {String(view.error)}
        </div>
      )}

      {view.isPending && <div className="py-20 text-center text-sm text-slate-400">加载中…</div>}

      {/* 接管前的历史周 / 尚未接管：整页只有这张说明卡（不渲染总结、手账、感受框） */}
      {data !== null && takeoverBlocked && (
        <SectionCard title="这一周不做复盘">
          <div className="py-1 text-sm leading-relaxed text-slate-600">{data.lock!.reason}</div>
        </SectionCard>
      )}

      {data !== null && !takeoverBlocked && (
        <>
          {/* ② AI 总结（直接展开；未生成时缩成一行 —— 2026-09-30 用户定稿） */}
          <AiSummarySection view={data} generating={generateWeek.isPending} onGenerate={handleGenerateWeek} />

          {/* ③ 逐日手账：只有练了的天（分节标题与 SectionCard 同语言，纯装饰不加字） */}
          <div className="flex items-center justify-between gap-3">
            <h2 className="flex items-center gap-2.5 text-[15px] font-semibold tracking-tight text-slate-800">
              <span aria-hidden="true" className="h-4 w-1 shrink-0 rounded-full bg-gradient-to-b from-indigo-500 to-violet-500" />
              这一周练过的那些天
            </h2>
            <span className="text-xs text-slate-400">没有训练的日子不显示 · 感受只存本地，给下一周参考</span>
          </div>
          {trainedRows.length === 0 ? (
            <div className="rounded-xl border border-dashed border-slate-300 bg-white px-6 py-10 text-center text-sm text-slate-400">
              {data.is_over
                ? '这一周训记里没有任何训练记录。'
                : '这一周还没有训练记录（也可能还没同步过来）。'}
            </div>
          ) : (
            <div className="space-y-3">
              {trainedRows.map((row) => (
                <DayRow key={row.datestr} row={row} onSave={handleSaveDay} status={noteStatus[row.datestr]} />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
