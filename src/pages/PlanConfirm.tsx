/**
 * 计划确认与写回页（T4，§8.2 P4）。双栏杆 UI：
 *   ① approve（draft → approved）→ ② 预演（dry_run diff）→ ③ 确认写入（第二道栏杆）。
 * 窗口：只写 [明天, 本周日]；已有训记记录的日期显示「跳过」且不发送。
 * 红线：本页每个写回动作都需要用户显式点击；无任何自动写入。
 */
import { useCurrentPlan, usePlanById, useApprovePlan, useWriteConfirm, useWriteJob, useWritePreview } from '../api/client.js';

const STATUS_LABEL: Record<string, { label: string; cls: string }> = {
  draft: { label: '草稿待确认', cls: 'bg-amber-100 text-amber-700' },
  approved: { label: '已批准（待预演）', cls: 'bg-blue-100 text-blue-700' },
  writing: { label: '写入中…', cls: 'bg-indigo-100 text-indigo-700' },
  written: { label: '已写入训记', cls: 'bg-emerald-100 text-emerald-700' },
  partial: { label: '部分写入', cls: 'bg-orange-100 text-orange-700' },
  failed: { label: '写入失败', cls: 'bg-red-100 text-red-700' },
  uncertain: { label: '写入待核实（响应为空，请到训记 App 确认）', cls: 'bg-yellow-100 text-yellow-700' },
  archived: { label: '已归档', cls: 'bg-slate-200 text-slate-500' },
};

const BATCH_ICON: Record<string, string> = {
  pending: '⏳', dry_run: '⏳', dry_run_ok: '✅', success: '✅', failed: '❌', uncertain: '❓', skipped: '⏭️',
};

/** 作业终态（不再变化）：用于渲染写入结果面板。 */
const JOB_TERMINAL_STATUSES = new Set(['success', 'partial', 'failed', 'uncertain']);

export function PlanConfirmPage(): React.ReactNode {
  // 支持 #/plan/confirm?plan=N：确认指定计划（current 按 week_start 排序，不一定是刚生成的那份）
  const requestedId = Number(new URLSearchParams(window.location.hash.split('?')[1] ?? '').get('plan')) || null;
  const current = useCurrentPlan();
  const byId = usePlanById(requestedId);
  const detail = requestedId !== null ? byId : current;
  const { data, isPending, error } = detail;
  const planId = data?.plan?.id ?? null;
  const job = useWriteJob(planId);
  const approve = useApprovePlan();
  const preview = useWritePreview();
  const confirm = useWriteConfirm();

  if (isPending) return <div className="py-20 text-center text-sm text-slate-400">加载中…</div>;
  if (!data?.plan || error) {
    return (
      <div className="rounded-xl border border-dashed border-slate-300 bg-white px-6 py-14 text-center">
        <div className="text-base font-medium text-slate-700">还没有可确认的计划</div>
        <div className="mt-1 text-sm text-slate-400">
          先回<a href="#/" className="text-indigo-600 underline">首页 · 下周</a>生成并调整训练草稿。
        </div>
      </div>
    );
  }

  const plan = data.plan;
  const pid: number = plan.id;
  const status = STATUS_LABEL[plan.status] ?? { label: plan.status, cls: 'bg-slate-200 text-slate-600' };
  const j = job.data ?? null;
  const writableDays = j?.days.filter((d) => d.action === 'create') ?? [];
  const skippedDays = j?.days.filter((d) => d.action === 'skip_existing') ?? [];
  // 实写节奏：批间冷却 65s（WRITE_COOL_DOWN_MS）+ 每批写后 15s 读回（WRITE_VERIFY_DELAY_MS）。
  // n=0 → 0；n=1 → 15s；n≥2 → (n-1)*65 + n*15。
  const estSeconds = writableDays.length > 0 ? (writableDays.length - 1) * 65 + writableDays.length * 15 : 0;
  const busy = approve.isPending || preview.isPending || confirm.isPending;
  const jobActive = j !== null && (j.status === 'writing' || j.status === 'dry_running');
  const terminalProblems = j?.batches.filter((b) => b.status === 'failed' || b.status === 'uncertain') ?? [];
  // 终态结果面板：由 plan.status 驱动；再加 job 终态门槛——否则 uncertain 计划重新预演后
  // （job 回到 awaiting_confirm、plan 仍是 uncertain），会拿新作业的 dry_run 批次当旧结果误报。
  const planTerminal =
    plan.status === 'written' ||
    plan.status === 'partial' ||
    plan.status === 'failed' ||
    plan.status === 'uncertain'
      ? j !== null && JOB_TERMINAL_STATUSES.has(j.status)
      : false;

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-lg font-semibold text-slate-900">计划确认 · 写回训记</h1>
        <p className="mt-0.5 flex items-center gap-2 text-xs text-slate-500">
          <span className={`${status.cls} rounded px-1.5 py-0.5 text-[10px] font-medium`}>{status.label}</span>
          <span>{plan.week_start} ~ {plan.week_end}</span>
        </p>
      </div>

      <div className="rounded-xl border border-slate-200 bg-white p-4 text-sm text-slate-600">
        <div className="font-medium text-slate-800">写回范围（防误写规则）</div>
        <ul className="mt-1.5 list-disc space-y-1 pl-5 text-xs">
          <li>只写 <b>明天开始到本周日</b> 的训练日；今天与过去的日期一律不碰（历史事实不可改）。</li>
          <li>该日期在训记里已有记录的，<b>跳过不覆盖</b>（下方会列出）。</li>
          <li>写入前自动做本地数据库快照；训记侧没有删除接口，写入后如需撤销只能在 App 手动删。</li>
          <li>预演是纯本地校验，零网络请求、即时完成；实写受训记限频影响，每批间隔约 65 秒，且每批写后需约 15 秒读回验证，批次数越多耗时越长。</li>
        </ul>
      </div>

      {/* 第一道栏杆：approve */}
      {plan.status === 'draft' && (
        <div className="rounded-xl border border-amber-300 bg-amber-50 p-4">
          <div className="text-sm font-semibold text-amber-800">第一步：批准这份计划</div>
          <p className="mt-1 text-xs text-amber-700">批准后才能预演写入内容。批准不会写入任何数据。</p>
          <button
            className="mt-2 rounded-lg bg-amber-600 px-4 py-2 text-sm text-white hover:bg-amber-700 disabled:opacity-50"
            disabled={busy}
            onClick={() => approve.mutate(pid)}
          >
            {approve.isPending ? '批准中…' : '批准（进入预演阶段）'}
          </button>
        </div>
      )}

      {/* 批准失败提示（必须放在 draft 分支之外）：
          否则批准成功后状态变为 approved，红字会变成「孤儿」——
          按钮和标题都消失了，只剩一行「计划当前状态为 approved，只有草稿可以批准」，
          看起来像自相矛盾。成功时 useApprovePlan 会 invalidate 计划查询并重置本 mutation。 */}
      {approve.error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-600">
          {(approve.error as Error).message}
        </div>
      )}

      {/* 预演 */}
      {(plan.status === 'approved' || plan.status === 'writing' || plan.status === 'written' || plan.status === 'partial' || plan.status === 'failed' || plan.status === 'uncertain') && (
        <div className="rounded-xl border border-slate-200 bg-white p-4">
          <div className="flex items-center justify-between">
            <div className="text-sm font-semibold text-slate-800">写入预览（纯本地校验，零网络请求）</div>
            {(plan.status === 'approved' || plan.status === 'uncertain') && (
              <button
                className="rounded-lg bg-indigo-600 px-3 py-1.5 text-xs text-white hover:bg-indigo-700 disabled:opacity-50"
                disabled={busy}
                onClick={() => preview.mutate(pid)}
              >
                {preview.isPending ? '预演中…' : j?.status === 'awaiting_confirm' ? '重新预演' : '开始预演'}
              </button>
            )}
          </div>

          {preview.isPending && (
            <div className="mt-3 rounded-lg bg-indigo-50 px-3 py-2 text-xs text-indigo-700">
              预演中（纯本地校验，零网络请求，即时完成）…
            </div>
          )}
          {jobActive && (
            <div className="mt-3 rounded-lg bg-indigo-50 px-3 py-2 text-xs text-indigo-700">
              <div className="flex items-center justify-between">
                <span>写入进行中…可以关闭页面，服务端会在后台继续执行。</span>
                <span className="tabular-nums">{j?.finished_batches ?? 0} / {j?.total_batches ?? 0} 批</span>
              </div>
              <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-indigo-100">
                <div
                  className="h-full rounded-full bg-indigo-600 transition-all"
                  style={{ width: `${j !== null && j.total_batches > 0 ? Math.round((j.finished_batches / j.total_batches) * 100) : 0}%` }}
                />
              </div>
            </div>
          )}
          {preview.error && <div className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-600">{(preview.error as Error).message}</div>}

          {/* 日期清单 */}
          {j && j.days.length > 0 && (
            <table className="mt-3 w-full text-left text-xs">
              <thead className="text-slate-400">
                <tr><th className="py-1">日期</th><th>训练</th><th>动作/组</th><th>动作</th></tr>
              </thead>
              <tbody>
                {j.days.map((d) => (
                  <tr key={d.plan_day_id} className="border-t border-slate-100">
                    <td className="py-1.5 font-medium text-slate-700">{d.datestr}</td>
                    <td className="text-slate-600">{d.title}</td>
                    <td className="text-slate-500">{d.moves} 动作 / {d.sets} 组</td>
                    <td>
                      {d.action === 'create' ? (
                        <span className="rounded bg-emerald-50 px-1.5 py-0.5 text-emerald-700">新增</span>
                      ) : (
                        <span className="rounded bg-slate-100 px-1.5 py-0.5 text-slate-500">跳过（已有记录 {d.existing_localid}）</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {/* 批次结果 */}
          {j && j.batches.length > 0 && (
            <div className="mt-3 space-y-1.5">
              {j.batches.map((b) => (
                <div key={b.batch_no} className="flex items-center justify-between rounded-lg bg-slate-50 px-3 py-1.5 text-xs">
                  <span className="text-slate-600">{BATCH_ICON[b.status] ?? '·'} {b.datestr} {b.title}</span>
                  <span className={b.status === 'failed' ? 'text-red-600' : b.status === 'uncertain' ? 'text-yellow-700' : 'text-slate-500'}>
                    {b.status === 'success'
                      ? `已写入（localid ${b.localid_after}）`
                      : b.status === 'dry_run_ok'
                        ? '预演通过'
                        : b.status === 'uncertain'
                          ? '待核实：写入响应为空且读回未确认——请到训记 App 查看该日，缺了再重新预演'
                          : b.error ?? b.status}
                  </span>
                </div>
              ))}
            </div>
          )}

          {/* 第二道栏杆：confirm */}
          {(plan.status === 'approved' || plan.status === 'uncertain') && j?.status === 'awaiting_confirm' && (
            <div className="mt-4 rounded-lg border border-red-200 bg-red-50 p-3">
              <div className="text-sm font-semibold text-red-700">第二步：确认写入训记</div>
              <p className="mt-1 text-xs text-red-600">
                将向训记写入 {writableDays.length} 天训练（{writableDays.map((d) => d.datestr).join('、')}），
                预计约 {estSeconds} 秒跑完。提交后立即在后台执行（可关闭页面）；写入后无法在本系统远程删除。
              </p>
              <button
                className="mt-2 rounded-lg bg-red-600 px-4 py-2 text-sm text-white hover:bg-red-700 disabled:opacity-50"
                disabled={busy}
                onClick={() => confirm.mutate(pid)}
              >
                {confirm.isPending ? '提交中…' : '确认写入（第二道栏杆）'}
              </button>
              {confirm.error && <div className="mt-2 text-xs text-red-600">{(confirm.error as Error).message}</div>}
            </div>
          )}

          {/* 受理回执：confirm 已改为异步作业，这里只表示「已开始」，终态看下方结果面板 */}
          {confirm.data && (
            <div className="mt-3 rounded-lg bg-emerald-50 px-3 py-2 text-xs text-emerald-700">
              已开始写入，共 {confirm.data.total_batches} 批 —— 可以关闭页面，服务端会继续执行。本地快照：{confirm.data.backup_path ?? '（未生成）'}
            </div>
          )}

          {/* 终态结果：由 plan.status 驱动（was confirm.data.plan_status），附失败/待核实批次明细 */}
          {planTerminal && (
            <div className="mt-4 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs">
              <div className="font-medium text-slate-700">写入结果：{status.label}</div>
              {terminalProblems.length > 0 ? (
                <ul className="mt-1 space-y-0.5">
                  {terminalProblems.map((b) => (
                    <li key={b.batch_no} className={b.status === 'failed' ? 'text-red-600' : 'text-yellow-700'}>
                      {b.datestr} {b.title}：{b.status === 'uncertain' ? `待核实（${b.error ?? '结果未知'}）` : (b.error ?? '失败')}
                    </li>
                  ))}
                </ul>
              ) : (
                <div className="mt-0.5 text-emerald-700">全部批次已写入。</div>
              )}
              {plan.status === 'uncertain' && (
                <div className="mt-1 text-yellow-700">请到训记 App 核实该周实际写入情况；如有缺日可重新预演。</div>
              )}
            </div>
          )}
        </div>
      )}

      <div className="rounded-xl border border-dashed border-slate-300 bg-white px-4 py-3 text-center text-xs text-slate-400">
        双栏杆红线：approve（批准）与 confirm（确认写入）都必须由你手动点击；本页不存在自动写入路径。
      </div>
    </div>
  );
}
