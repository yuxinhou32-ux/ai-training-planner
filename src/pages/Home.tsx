/**
 * 首页 · 下周（PRD-v2 §2① 主操作页）。
 *
 * 2026-09-30 用户定案后的形态 —— **从上到下就三块**：
 *   ① 训练周期 + 下周特殊情况：合成**一张卡**左右两栏（`WeekPrepCard`）
 *   ② 生成计划 →（点下去才）出现计划明细 → 调整 → 导入训记（`PlanBoard`）
 *
 * 用户原话：「这个主页面只有第一个框，本周期的目标……然后第二个就是本周的特殊情况，
 * 给一个文本框，我可以填上本周的特殊情况，然后我点了生成，它才会生成本周的计划。」
 * 后来（第 4 轮）又要求把这两块统一成一个模块：「这个训练周期和这个下周特殊情况
 * 不能用统一的模块吗？这一个长一个一个短……」
 *
 * 🔴 命名：这一页**全是「下周」**，不是「本周」。原因：`nextWeekStart` 里
 *    `offset = ((target-dow+7)%7) || 7`，今天就是周起点时也返回 +7 —— 排的永远是下一周。
 *    用户拍板：「你首页的这一部分内容就全部是下周了，复盘那一块才是本周。」
 */
import { WeekPrepCard } from '../components/plan/WeekPrepCard.js';
import { PlanBoard } from '../components/plan/PlanBoard.js';
import { useJobsRecent, useMarkNotificationsRead, useNotifications } from '../api/client.js';

function fmtTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function HomePage(): React.ReactNode {
  const notifications = useNotifications();
  const markRead = useMarkNotificationsRead();
  const jobs = useJobsRecent();

  // ⚠️ /api/notifications 默认返回全部历史（含已读），必须自己按 is_read 过滤，
  // 否则「知道了」点掉的提醒会在下次刷新时原样回来。
  const problems = (notifications.data?.notifications ?? []).filter(
    (n) => n.is_read === 0 && (n.level === 'error' || n.level === 'warn'),
  );
  // 首页只顶出最新一条；其余在设置页诊断区看。
  const alert = problems[0] ?? null;
  const extraProblems = problems.length - 1;
  const runnerBusy = jobs.data?.runner.busy ?? false;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-lg font-semibold text-slate-900">首页 · 下周</h1>
          <p className="mt-0.5 text-xs text-slate-500">
            填这周的特殊情况 → 点生成 → 调到满意 → 导入训记。系统不会自动写入任何东西。
          </p>
        </div>
        {runnerBusy && (
          <span className="animate-pulse rounded-full bg-indigo-100 px-3 py-1 text-xs text-indigo-700">
            任务执行中：{jobs.data?.runner.job_type ?? '…'}
            {jobs.data?.runner.pending ? `（还有 ${jobs.data.runner.pending} 项排队）` : ''}
          </span>
        )}
      </div>

      {/* 当下提醒：只有失败/警告才出现，且只显示最新一条（成功与信息类不进首页） */}
      {alert !== null && (
        <div
          className={`flex flex-wrap items-center justify-between gap-2 rounded-lg border px-3 py-2 text-sm ${
            alert.level === 'error'
              ? 'border-red-300 bg-red-50 text-red-800'
              : 'border-amber-300 bg-amber-50 text-amber-800'
          }`}
        >
          <div className="min-w-0">
            <span className="font-medium">{alert.title}</span>
            {alert.body && <span className="ml-2 text-xs opacity-80">{alert.body}</span>}
            <span className="ml-2 text-[10px] opacity-50">{fmtTime(alert.created_at)}</span>
            {extraProblems > 0 && <span className="ml-2 text-xs opacity-70">（另有 {extraProblems} 条未处理提醒）</span>}
          </div>
          {/* 只消掉当前这一条：若还有别的失败，下一条会自动顶上来 */}
          <button
            className="shrink-0 rounded-md border border-current px-2 py-1 text-xs hover:bg-white/60"
            onClick={() => markRead.mutate([alert.id])}
          >
            知道了
          </button>
        </div>
      )}

      {/* ① 排计划前的两个输入，合成一张卡：左＝训练周期（4 周框架），右＝下周特殊情况（优先级最高） */}
      <WeekPrepCard />

      {/* ② 生成 → 调整 → 导入 */}
      <PlanBoard />
    </div>
  );
}
