/**
 * 设置页的「诊断」折叠区（默认收起）。
 *
 * 这里装的全是**日常不该看见的东西**：手动备份、任务历史、提醒、分析报告、
 * 254 条动作映射表、未识别动作清单。它们都有用 —— 但都是「出问题时才来翻」，
 * 平铺在设置页就是噪音（用户原话：「现在全部在页面上太乱了」）。
 *
 * 🔴 折叠 ≠ 删除。里面有唯一的分析报告入口，排计划依赖它，所以必须可达。
 *    原始 PRD §2③ 把设置页列了 9 项，这 6 项不在其中 —— 所以它们收敛到这里，
 *    而不是占着导航位（v1 的「数据分析」曾是一个顶级导航项）。
 *
 * ⚠️ 同步入口**不在这里**（2026-10-01 移走）：它属于「训记接入」卡片，
 *    跟 XUNJI_API_KEY 放一起，用户要同步时眼睛才找得到。此处若再放一个，
 *    同一件事就有两个入口，说不清哪个算数。
 */
import { useState } from 'react';
import {
  useJobsRecent,
  useLatestAnalysis,
  useMappings,
  useMarkNotificationsRead,
  useNotifications,
  useRefreshAnalysis,
  useTriggerJob,
  useUnresolved,
} from '../../api/client.js';
import { EFFECTIVE_SETS_HINT, MAP_SOURCE, muscleZh } from '../../api/labels.js';
import { Badge, CollapsibleCard } from '../common/ui.js';

const JOB_STATUS_CLS: Record<string, string> = {
  running: 'bg-indigo-100 text-indigo-700',
  success: 'bg-emerald-100 text-emerald-700',
  partial: 'bg-amber-100 text-amber-700',
  failed: 'bg-red-100 text-red-700',
  pending: 'bg-slate-100 text-slate-600',
  cancelled: 'bg-slate-100 text-slate-500',
};

const TRIGGERED_BY_ZH: Record<string, string> = {
  manual: '手动',
  startup: '开机',
  auto: '自动',
  catchup: '补跑',
};

function fmtTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function DiagnosticsEntry(): React.ReactNode {
  const jobs = useJobsRecent();
  const trigger = useTriggerJob();
  const notifications = useNotifications();
  const markRead = useMarkNotificationsRead();
  const analysis = useLatestAnalysis();
  const refresh = useRefreshAnalysis();
  const mappings = useMappings();
  const unresolved = useUnresolved();

  const [actionError, setActionError] = useState<string | null>(null);

  const unread = (notifications.data?.notifications ?? []).filter((n) => n.is_read === 0);
  const runnerBusy = jobs.data?.runner.busy ?? false;
  const movements = mappings.data?.movements ?? [];
  const items = unresolved.data?.unresolved ?? [];

  return (
    <CollapsibleCard
      title="诊断与维护"
      summary={
        <>
          备份 / 任务记录 / 分析报告 / 动作映射表 —— 平时不用看
          {unread.length > 0 && `（有 ${unread.length} 条未处理提醒）`}
        </>
      }
    >
      <div className="space-y-4">
        {actionError && <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-600">{actionError}</div>}

        {/* ---------- 手动操作 ---------- */}
        <div>
          <div className="mb-2 text-sm font-medium text-slate-800">
            手动操作
            <span className="ml-2 text-xs font-normal text-slate-400">系统不做任何定时写入</span>
          </div>
          {/* 同步入口已上移到「训记接入」卡片 —— 那里才是它该出现的地方（跟 Key 配置在一起）。
              这里不再重复放一个，避免同一件事有两个入口、说不清哪个算数。 */}
          <div className="grid gap-2 sm:grid-cols-2">
            <button
              disabled={runnerBusy || trigger.isPending}
              className="rounded-lg border border-indigo-200 bg-indigo-50 p-3 text-left text-sm text-indigo-700 hover:bg-indigo-100 disabled:opacity-50"
              onClick={() => trigger.mutate('plan_draft')}
            >
              后台生成下周草稿
              <span className="block text-[10px] text-indigo-400">只到待确认，不写入</span>
            </button>
            <button
              disabled={runnerBusy || trigger.isPending}
              className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-left text-sm text-slate-600 hover:bg-slate-100 disabled:opacity-50"
              onClick={() => trigger.mutate('db_backup')}
            >
              立即备份
              <span className="block text-[10px] text-slate-400">本地库 VACUUM 快照</span>
            </button>
          </div>
        </div>

        {/* ---------- 分析报告 ---------- */}
        <div>
          <div className="mb-2 text-sm font-medium text-slate-800">
            分析报告
            <span className="ml-2 text-xs font-normal text-slate-400">
              AI 排计划只吃这一层 —— 它看不到你的原始训练记录
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-3 rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-600">
            {analysis.isPending ? (
              <span className="text-slate-400">加载中…</span>
            ) : analysis.data?.exists && analysis.data.report ? (
              <span>
                报告 #{analysis.data.reportId} · 窗口 {analysis.data.report.window.trend_start} ~{' '}
                {analysis.data.report.window.trend_end}（{analysis.data.report.window.weeks} 周） ·{' '}
                {analysis.data.report.findings.length} 条结论 · 生成于 {fmtTime(analysis.data.generatedAt)}
              </span>
            ) : (
              <span className="text-amber-700">
                还没有分析报告 —— 先在上面「训记接入」里同步一次数据，再点「重新分析」
              </span>
            )}
            <div className="ml-auto flex gap-2">
              <button
                className="rounded-md border border-slate-300 px-2 py-1 text-xs text-slate-600 hover:bg-white disabled:opacity-50"
                disabled={refresh.isPending}
                onClick={() =>
                  refresh.mutate(undefined, {
                    onError: (e) => setActionError(`重新分析失败：${e.message}`),
                  })
                }
              >
                {refresh.isPending ? '分析中…' : '重新分析'}
              </button>
              <a
                href="#/analysis"
                className="rounded-md border border-slate-300 px-2 py-1 text-xs text-slate-600 hover:bg-white"
              >
                查看报告详情 →
              </a>
            </div>
          </div>
        </div>

        {/* ---------- 未处理提醒 ---------- */}
        {unread.length > 0 && (
          <div>
            <div className="mb-2 flex items-center justify-between">
              <span className="text-sm font-medium text-slate-800">未处理提醒（{unread.length}）</span>
              <button
                className="text-xs text-indigo-600 hover:underline"
                onClick={() => markRead.mutate(unread.map((n) => n.id))}
              >
                全部标为已读
              </button>
            </div>
            <div className="space-y-1">
              {unread.slice(0, 8).map((n) => (
                <div key={n.id} className="flex items-start gap-2 rounded-md px-2 py-1.5 text-xs hover:bg-slate-50">
                  <span
                    className={`mt-0.5 shrink-0 rounded px-1.5 py-0.5 text-[10px] ${
                      n.level === 'error'
                        ? 'bg-red-100 text-red-700'
                        : n.level === 'warn'
                          ? 'bg-amber-100 text-amber-700'
                          : 'bg-sky-100 text-sky-700'
                    }`}
                  >
                    {n.level}
                  </span>
                  <span className="min-w-0">
                    <span className="text-slate-700">{n.title}</span>
                    {n.body && <span className="ml-2 text-slate-400">{n.body}</span>}
                  </span>
                  <span className="ml-auto shrink-0 tabular-nums text-slate-400">{fmtTime(n.created_at)}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ---------- 最近任务 ---------- */}
        <div>
          <div className="mb-2 text-sm font-medium text-slate-800">最近任务</div>
          {(jobs.data?.jobs.length ?? 0) === 0 ? (
            <div className="py-2 text-center text-xs text-slate-400">还没有任务记录</div>
          ) : (
            <div className="space-y-1">
              {(jobs.data?.jobs ?? []).slice(0, 8).map((j) => (
                <div key={j.id} className="flex items-center justify-between rounded-md px-2 py-1.5 text-xs hover:bg-slate-50">
                  <span className="text-slate-700">
                    {j.label}
                    <span className="ml-2 text-[10px] text-slate-400">
                      {TRIGGERED_BY_ZH[j.triggered_by] ?? j.triggered_by}
                    </span>
                  </span>
                  <span className="flex items-center gap-2">
                    {j.progress?.message && (
                      <span className="hidden text-slate-400 sm:inline">{j.progress.message}</span>
                    )}
                    <span className={`rounded px-1.5 py-0.5 text-[10px] ${JOB_STATUS_CLS[j.status] ?? 'bg-slate-100 text-slate-600'}`}>
                      {j.status}
                    </span>
                    <span className="tabular-nums text-slate-400">{fmtTime(j.finished_at ?? j.started_at)}</span>
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* ---------- 动作映射（254 条，收在自己的折叠里） ---------- */}
        <details className="rounded-lg border border-slate-200">
          <summary className="cursor-pointer select-none px-3 py-2 text-xs text-slate-500 hover:text-slate-700">
            动作 → 肌群映射（{mappings.isPending ? '…' : movements.length} 个动作）
            <span className="ml-2 text-slate-400">来源优先级：人工 &gt; 服务端 &gt; 规则 &gt; 区间</span>
          </summary>
          <div className="border-t border-slate-100 px-3 py-2">
            {mappings.isPending ? (
              <div className="py-4 text-center text-xs text-slate-400">加载中…</div>
            ) : movements.length === 0 ? (
              <div className="py-4 text-center text-xs text-slate-400">还没有映射数据</div>
            ) : (
              <div className="max-h-96 space-y-1 overflow-y-auto">
                {movements.map((m) => (
                  <div key={m.catalogId} className="flex flex-wrap items-center gap-2 rounded px-1 py-1 hover:bg-slate-50">
                    <span className="w-48 shrink-0 truncate text-xs font-medium text-slate-800" title={m.name}>
                      {m.name}
                    </span>
                    <div className="flex min-w-0 flex-1 flex-wrap gap-1">
                      {m.muscles.map((mu, i) => {
                        const src = MAP_SOURCE[mu.source] ?? MAP_SOURCE.segment;
                        return (
                          <span key={i} className="inline-flex items-center gap-1 rounded border border-slate-200 px-1 py-0.5 text-[11px]">
                            <span className={mu.role === 'primary' ? 'font-medium text-slate-800' : 'text-slate-500'}>
                              {muscleZh(mu.code)}
                              <span className="ml-0.5 text-[10px] text-slate-400">{mu.role === 'primary' ? '主' : '次'}</span>
                            </span>
                            <span className="tabular-nums text-slate-400">×{mu.weight}</span>
                            <Badge cls={src.cls} title={`置信度 ${mu.confidence}`}>
                              {src.label}
                            </Badge>
                            {!mu.confirmed && <span className="text-[10px] text-slate-300">未确认</span>}
                          </span>
                        );
                      })}
                      {m.muscles.length === 0 && <span className="text-[11px] text-slate-300">未映射</span>}
                    </div>
                  </div>
                ))}
              </div>
            )}
            <p className="mt-2 text-[11px] text-slate-400">权重口径：{EFFECTIVE_SETS_HINT}</p>
          </div>
        </details>

        {/* ---------- 未识别动作 ---------- */}
        <details className="rounded-lg border border-slate-200">
          <summary className="cursor-pointer select-none px-3 py-2 text-xs text-slate-500 hover:text-slate-700">
            未识别动作（{unresolved.isPending ? '…' : items.length} 条）
          </summary>
          <div className="border-t border-slate-100 px-3 py-2">
            {unresolved.isPending ? (
              <div className="py-4 text-center text-xs text-slate-400">加载中…</div>
            ) : items.length === 0 ? (
              <div className="py-3 text-center text-xs text-slate-400">
                没有未识别的动作 —— 全部训练动作都已成功映射
              </div>
            ) : (
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-slate-200 text-left text-slate-500">
                    <th className="py-1.5 pr-3 font-medium">原始名称</th>
                    <th className="py-1.5 pr-3 font-medium">归一化</th>
                    <th className="py-1.5 pr-3 font-medium">出现次数</th>
                    <th className="py-1.5 pr-3 font-medium">首次出现</th>
                    <th className="py-1.5 font-medium">最近出现</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((it) => (
                    <tr key={it.nameNorm} className="border-b border-slate-100 last:border-0">
                      <td className="py-1.5 pr-3 text-slate-700">{it.nameRaw}</td>
                      <td className="py-1.5 pr-3 text-slate-500">{it.nameNorm}</td>
                      <td className="py-1.5 pr-3 tabular-nums text-slate-600">{it.hitCount}</td>
                      <td className="py-1.5 pr-3 tabular-nums text-slate-500">{it.firstSeen}</td>
                      <td className="py-1.5 tabular-nums text-slate-500">{it.lastSeen}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </details>
      </div>
    </CollapsibleCard>
  );
}
