/**
 * 危险区：清空「本次生成的计划」（设置页最底部，2026-10-05 用户定案）。
 *
 * 用户原话：「我觉得可以添加一个清空功能（我后面正常使用可能不会长期使用这个功能，
 * 但现在在测试阶段还是很有必要的。就是清空这个项目里的所有关于本次生成的计划的内容——
 * 周期我没改的话可以不用清空，但如果我选择解锁清空需要保证真的清空，不要出现两条周期目标在后台）」
 *
 * 设计纪律：
 *  1. **默认收起** + 卡片头写「危险区」，收起态摘要显示「会删掉 N 份计划 · M 个训练日」——
 *     与设置页其它卡同一套 `CollapsibleCard` 语言。
 *  2. 展开后**先列清楚会删什么、什么不会删**（后者是用户的定心丸：训练记录不动）。
 *  3. 执行要**开二级确认**：勾选后才解锁按钮，点了再弹一次明确确认。
 *     ⚠️ 不做快照备份 —— 用户明确「不需要做快照备份的处理，因为我们只是删除本次的计划而已」。
 *  4. `clear_cycle` 是**独立勾选项**，默认不勾：用户说「周期我没改的话可以不用清空」。
 *
 * 🔴 为什么「清周期」要真删而不是 close：`training_cycle` 有 `UNIQUE(first_week_start)`，
 *    旧周期留着又没关的话会挡着新周期，界面上看不出来 —— 就是用户说的
 *    「不要出现两条周期目标在后台」。所以这里勾了就整表删干净。
 */
import { useState } from 'react';
import { useResetPlan, useResetPreview } from '../../api/client.js';
import { CollapsibleCard } from '../common/ui.js';

export function DangerZone(): React.ReactNode {
  const [open, setOpen] = useState(false);
  const preview = useResetPreview(open);
  const reset = useResetPlan();

  const [clearCycle, setClearCycle] = useState(false);
  const [ack, setAck] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [done, setDone] = useState<string | null>(null);

  const p = preview.data ?? null;
  const hasPlans = (p?.plans ?? 0) > 0 || (p?.weekly_reviews ?? 0) > 0;
  const canRun = ack && !reset.isPending;

  const run = (): void => {
    setDone(null);
    reset.mutate(
      { clearCycle },
      {
        onSuccess: (data) => {
          const r = data.result;
          setDone(
            `已清空：${r.plans} 份计划 / ${r.plan_days} 个训练日 / ${r.plan_exercises} 个动作` +
              (r.cleared_cycle ? ` / ${r.cycles} 个周期` : '') +
              `（训练记录未动）`,
          );
          setConfirming(false);
          setAck(false);
        },
      },
    );
  };

  const summary =
    p === null
      ? '展开查看会清掉什么'
      : hasPlans
        ? `会删掉 ${p.plans} 份计划 · ${p.plan_days} 个训练日 · ${p.plan_exercises} 个动作`
        : '当前没有可清空的计划';

  return (
    <CollapsibleCard
      title={<span className="text-rose-700">危险区 · 清空本次生成的计划</span>}
      summary={summary}
      open={open}
      onToggle={(next) => {
        setOpen(next);
        setDone(null);
        setConfirming(false);
        setAck(false);
      }}
    >
      <div className="space-y-3 border-t border-slate-100 px-5 py-4">
        <p className="text-xs leading-relaxed text-slate-500">
          只删<span className="font-medium text-slate-700">本次生成的计划</span>（计划本身、训练日、动作、写回记录、周复盘），
          删完可以直接重新生成。训练数据、长期目标、你自己写的备注都<span className="font-medium text-slate-700">不会</span>被动。
        </p>

        {preview.isPending && <div className="text-xs text-slate-400">正在统计…</div>}
        {preview.isError && (
          <div className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">
            统计失败：{String(preview.error)}
          </div>
        )}

        {p !== null && (
          <>
            {/* 会删的东西 */}
            <div className="rounded-lg border border-rose-200 bg-rose-50/60 px-3 py-2.5">
              <div className="mb-1.5 text-xs font-medium text-rose-800">将被删除</div>
              <ul className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-rose-700 sm:grid-cols-3">
                <li>计划：{p.plans} 份</li>
                <li>训练日：{p.plan_days} 个</li>
                <li>动作：{p.plan_exercises} 个</li>
                <li>写回任务：{p.write_jobs} 条</li>
                <li>周复盘：{p.weekly_reviews} 条</li>
                {clearCycle && <li>训练周期：{p.cycles} 个</li>}
              </ul>
              {p.plans === 0 && p.weekly_reviews === 0 && (
                <div className="mt-1.5 text-xs text-rose-600">（当前没有可清空的计划）</div>
              )}
            </div>

            {/* 不会删的东西 —— 定心丸 */}
            <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2.5">
              <div className="mb-1.5 text-xs font-medium text-slate-600">不会被删除</div>
              <ul className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-slate-500 sm:grid-cols-3">
                <li>训练记录：{p.protected.training_sessions} 次</li>
                <li>训练组：{p.protected.training_sets} 组</li>
                <li>长期目标：{p.protected.active_goals} 条</li>
                <li>日感受：{p.protected.daily_notes} 条</li>
                <li>下周情况：{p.protected.week_notes} 条</li>
                <li>体重记录：{p.protected.weight_logs} 条</li>
              </ul>
            </div>

            {/* 勾选项 */}
            <label className="flex cursor-pointer items-start gap-2.5 rounded-lg border border-slate-200 px-3 py-2.5 hover:bg-slate-50">
              <input
                type="checkbox"
                checked={clearCycle}
                onChange={(e) => setClearCycle(e.target.checked)}
                className="mt-0.5"
              />
              <span className="text-xs text-slate-600">
                <span className="font-medium text-slate-800">同时清空训练周期</span>
                <span className="mt-0.5 block text-slate-400">
                  勾上会连周期一起删掉（含周期目标），下次可以重新开一个新周期。
                  不勾则保留周期 —— 只是把生成过的计划清掉。
                </span>
              </span>
            </label>

            <label className="flex cursor-pointer items-start gap-2.5 rounded-lg border border-slate-200 px-3 py-2.5 hover:bg-slate-50">
              <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} className="mt-0.5" />
              <span className="text-xs text-slate-600">
                <span className="font-medium text-slate-800">我知道删除后无法恢复</span>
                <span className="mt-0.5 block text-slate-400">
                  这个功能不做快照备份（删掉的只是计划，随时可以重新生成）。
                </span>
              </span>
            </label>

            {/* 执行 / 二次确认 */}
            {!confirming ? (
              <button
                type="button"
                disabled={!canRun || !hasPlans}
                onClick={() => setConfirming(true)}
                className="rounded-lg bg-rose-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-rose-700 disabled:cursor-not-allowed disabled:bg-slate-200 disabled:text-slate-400"
              >
                清空计划
              </button>
            ) : (
              <div className="flex flex-wrap items-center gap-3 rounded-lg border border-rose-300 bg-rose-50 px-3 py-2.5">
                <span className="text-xs text-rose-800">
                  确定要清空吗？
                  {clearCycle && <b>（包含训练周期，周期目标也会没）</b>}
                </span>
                <button
                  type="button"
                  disabled={reset.isPending}
                  onClick={run}
                  className="rounded-lg bg-rose-600 px-3 py-1 text-xs font-medium text-white hover:bg-rose-700 disabled:cursor-not-allowed disabled:bg-rose-300"
                >
                  {reset.isPending ? '清空中…' : '确认清空'}
                </button>
                <button
                  type="button"
                  onClick={() => setConfirming(false)}
                  className="rounded-lg border border-slate-300 bg-white px-3 py-1 text-xs text-slate-600 hover:bg-slate-50"
                >
                  取消
                </button>
              </div>
            )}

            {reset.isError && (
              <div className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">
                清空失败：{String(reset.error)}
              </div>
            )}
            {done !== null && (
              <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-700">
                {done}
              </div>
            )}
          </>
        )}
      </div>
    </CollapsibleCard>
  );
}
