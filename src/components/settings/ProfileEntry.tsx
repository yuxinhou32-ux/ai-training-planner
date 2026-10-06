/**
 * 「用户画像」入口 —— PRD-v2 §6 决策 6 / §10.3 V9。
 *
 * 🔴 用户原话：**「放设置页，只给一个『用户画像』入口，点进去才展开，不平铺」**。
 * 所以这里默认是**折叠**的：只显示一段说明 + 一个按钮，展开前**不发任何请求**。
 * 这不是省流量的强迫症 —— 画像要现场拼一遍摘要层（digest），
 * 而设置页每次打开都白算一遍，等于每次改个训练基础都顺手跑一遍统计分析。
 *
 * 展示的是**系统实际喂给 AI 的那份长期画像**（`buildPlanDigest().profile` +
 * 报告里的动作趋势），与「排计划」走同一条装配路径 ——
 * 页面看到的和 AI 看到的是同一份，用户点进来是为了**核对**，不是为了看一份好看的文档。
 */
import { useState } from 'react';
import { useProfile, type ProfileView } from '../../api/client.js';
import { DOW_ZH, MUSCLE_VERDICT, MOVEMENT_VERDICT } from '../../api/labels.js';
import { Badge, CollapsibleCard } from '../common/ui.js';

export function ProfileEntry(): React.ReactNode {
  const [open, setOpen] = useState(false);
  const profile = useProfile(open);

  return (
    <CollapsibleCard
      title="用户画像"
      summary="AI 排计划时眼里的「你」—— 训练习惯 / 各部位基线 / 当前重量与趋势"
      open={open}
      onToggle={setOpen}
    >
      <div className="space-y-4">
        <p className="text-xs leading-relaxed text-slate-500">
          AI 排计划时眼里的「你」。它<span className="font-medium text-slate-600">看不到</span>你的原始训练记录，
          只能看到这一份 —— 觉得「AI 排得不对」时，先来这里核对数字。
        </p>
        {profile.isPending ? (
          <div className="py-6 text-center text-sm text-slate-400">加载中…</div>
        ) : profile.isError ? (
          <div className="py-6 text-center text-sm text-rose-600">画像读取失败：{String(profile.error)}</div>
        ) : profile.data === null || profile.data === undefined ? (
          <div className="py-6 text-center text-sm text-slate-400">
            还没有分析报告 —— 画像的全部数字都来自报告，先到下方「诊断与维护」里重新分析一次
          </div>
        ) : (
          <ProfileBody p={profile.data} />
        )}
      </div>
    </CollapsibleCard>
  );
}

function Figure(props: { label: string; value: React.ReactNode; hint?: string }): React.ReactNode {
  return (
    <div className="rounded-lg border border-slate-200 px-3 py-2" title={props.hint}>
      <div className="text-[11px] text-slate-500">{props.label}</div>
      <div className="mt-0.5 text-sm font-medium tabular-nums text-slate-900">{props.value}</div>
    </div>
  );
}

function ProfileBody({ p }: { p: ProfileView }): React.ReactNode {
  // 实际覆盖周数：周均频率的分母是它，不是报告的窗口周数（窗口 26 周 ≠ 真练了 26 周）
  const activeWeeks = p.window.active_weeks ?? p.window.weeks;
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-400">
        <span>
          数据窗口 {p.window.start} ~ {p.window.end}（{p.window.weeks} 周）
        </span>
        <span className="text-slate-300">·</span>
        <span>分析报告 #{p.report_id}</span>
        <span className="text-slate-300">·</span>
        <span>{p.cycle ? `周期第 ${p.cycle.week_no}/${p.cycle.total_weeks} 周` : '未开周期'}</span>
        {p.cycle?.is_deload && <Badge cls="bg-violet-100 text-violet-700">减量周</Badge>}
      </div>

      {/* ---------- 训练习惯 ---------- */}
      <div>
        <div className="mb-2 text-sm font-medium text-slate-800">训练习惯</div>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Figure
            label="实际周频"
            value={`${p.habit.sessions_per_week} 次`}
            hint={`近 ${activeWeeks} 周实际平均每周训练次数（来自训记）`}
          />
          <Figure
            label="目标周频"
            value={p.habit.goal_sessions_per_week === null ? '—' : `${p.habit.goal_sessions_per_week} 次`}
            hint="来自设置页选中的训练日数量"
          />
          <Figure label="单次时长中位数" value={p.habit.duration_median_min === null ? '—' : `${p.habit.duration_median_min} 分`} hint="排期按中位数，不按上限" />
          <Figure
            label="长期目标"
            value={p.goal?.goal_type ?? '—'}
            hint={p.goal ? `每次 ${p.goal.min_duration_min}~${p.goal.max_duration_min} 分钟` : '设置页未填'}
          />
        </div>
        <div className="mt-2 text-xs text-slate-500">
          常练日：
          {p.goal && p.goal.preferred_dows.length > 0 ? (
            <span className="text-slate-700">{p.goal.preferred_dows.map((d) => DOW_ZH[d]).join(' / ')}</span>
          ) : (
            <span className="text-slate-400">未设置</span>
          )}
          {p.habit.trained_dows.length > 0 && (
            <span className="text-slate-400">
              （实际常落在 {p.habit.trained_dows.map((d) => DOW_ZH[d]).join(' / ')}）
            </span>
          )}
          {p.cycle && <span className="ml-2 text-slate-500">周期目标：{p.cycle.goal_text}</span>}
        </div>
      </div>

      {/* ---------- 个人基础信息 ---------- */}
      <div>
        <div className="mb-2 text-sm font-medium text-slate-800">个人基础信息</div>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Figure label="性别" value={p.body.gender ?? '—'} hint="设置页未填" />
          <Figure label="年龄" value={p.body.age === null ? '—' : `${p.body.age} 岁`} hint="设置页未填" />
          <Figure label="身高" value={p.body.height_cm === null ? '—' : `${p.body.height_cm} cm`} hint="设置页未填" />
          <Figure label="训练年限" value={p.body.training_years ?? '—'} hint="设置页未填" />
        </div>
        <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Figure label="体重" value={p.body.weight_kg === null ? '—' : `${p.body.weight_kg} kg`} hint={p.body.weight_date ?? '设置页未填'} />
          <Figure
            label="近 30 天变化"
            value={p.body.delta_30d_kg === null ? '—' : `${p.body.delta_30d_kg > 0 ? '+' : ''}${p.body.delta_30d_kg} kg`}
            hint="不足两次记录时无法计算"
          />
          <Figure label="旧伤 / 基础疾病" value={p.body.conditions.trim() === '' ? '（未填）' : '已填'} hint={p.body.conditions} />
          <Figure label="这些数据的作用" value="背景参考" hint="只作参考，系统不会据此禁用任何动作" />
        </div>
        {p.body.conditions.trim() !== '' && (
          <p className="mt-2 rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-600">{p.body.conditions}</p>
        )}
      </div>

      {/* ---------- 结构比值 ---------- */}
      <div>
        <div className="mb-2 text-sm font-medium text-slate-800">长期结构</div>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Figure label="推拉比" value={fmt(p.structure.push_pull_ratio)} hint="目标区间 0.8~1.25，超出会触发 R-AG-07" />
          <Figure label="上下肢比" value={fmt(p.structure.upper_lower_ratio)} hint="目标区间 1.0~2.0，超出会触发 R-AG-08" />
        </div>
      </div>

      {/* ---------- 肌群基线 ---------- */}
      <div>
        <div className="mb-2 flex flex-wrap items-baseline gap-x-3">
          <span className="text-sm font-medium text-slate-800">各部位基线（{p.muscles.length} 个）</span>
          <span className="text-xs text-slate-400">近 4 周周均有效组 · 「该补 / 该减」就是 AI 的依据</span>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {p.muscles.map((m) => {
            const v = m.verdict === null ? null : MUSCLE_VERDICT[m.verdict];
            return (
              <span
                key={m.code}
                className={
                  'inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs ' +
                  (m.verdict === null ? 'border-dashed border-slate-300 bg-slate-50' : 'border-slate-200 bg-white')
                }
                title={m.verdict === null ? `近 ${p.window.weeks} 周内一组都没有` : undefined}
              >
                <span className={m.verdict === null ? 'text-slate-400' : 'text-slate-700'}>{m.name}</span>
                <span className="tabular-nums text-slate-500">{m.weekly_sets}</span>
                {v ? <Badge cls={v.cls}>{v.label}</Badge> : <span className="text-[10px] text-slate-400">没练到</span>}
              </span>
            );
          })}
        </div>
      </div>

      {/* ---------- 动作趋势 ---------- */}
      <div>
        <div className="mb-2 flex flex-wrap items-baseline gap-x-3">
          <span className="text-sm font-medium text-slate-800">主要动作的当前重量与趋势（前 {p.movements.length} 条）</span>
          <span className="text-xs text-slate-400">按最近练过的日期倒序 · 重量是历史最好成绩</span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-200 text-left text-xs text-slate-500">
                <th className="py-1.5 pr-3 font-medium">动作</th>
                <th className="py-1.5 pr-3 font-medium">最近重量</th>
                <th className="py-1.5 pr-3 font-medium">趋势</th>
                <th className="py-1.5 pr-3 font-medium">重量变化</th>
                <th className="py-1.5 pr-3 font-medium">有数据的周</th>
                <th className="py-1.5 font-medium">最近一次</th>
              </tr>
            </thead>
            <tbody>
              {p.movements.map((m) => {
                const v = MOVEMENT_VERDICT[m.verdict] ?? MOVEMENT_VERDICT.insufficient_data;
                return (
                  <tr key={m.name} className="border-b border-slate-100 last:border-0">
                    <td className="py-1.5 pr-3 text-slate-800">{m.name}</td>
                    <td className="py-1.5 pr-3 tabular-nums text-slate-600">{m.last_weight === null ? '—' : `${m.last_weight} kg`}</td>
                    <td className="py-1.5 pr-3">
                      <Badge cls={v.cls}>{v.label}</Badge>
                    </td>
                    <td className={'py-1.5 pr-3 tabular-nums ' + (deltaCls(m.delta_pct))}>
                      {m.delta_pct === null ? '—' : `${m.delta_pct > 0 ? '+' : ''}${m.delta_pct}%`}
                    </td>
                    <td className="py-1.5 pr-3 tabular-nums text-slate-500">{m.weeks}</td>
                    <td className="py-1.5 tabular-nums text-slate-500">{m.last_performed ?? '—'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      <p className="border-t border-slate-100 pt-3 text-xs leading-relaxed text-slate-400">
        这份画像是系统<span className="font-medium text-slate-500">本地统计</span>出来的（不是 AI 写的），每次打开现算。
        它和排计划时喂给 AI 的是同一份 —— 觉得哪里不对，就去改训练基础、补体重、或把下周特殊情况写在首页。
      </p>
    </div>
  );
}

function fmt(n: number | null): string {
  return n === null ? '—' : String(n);
}

/** 重量变化配色：训练重量涨 = 进步（绿），跌 = 退步（红）。这是训练语义，不是行情语义。 */
function deltaCls(v: number | null): string {
  if (v === null || v === 0) return 'text-slate-500';
  return v > 0 ? 'text-emerald-600' : 'text-rose-600';
}
