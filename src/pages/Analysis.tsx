/**
 * 数据分析页（§8.1 P2-Analysis）：画像版本 + 5 Tab + 窗口信息。
 *
 * - basic：概览 StatCard + 数据质量 + 最近一次训练；
 * - movement / muscle / structure：三个趋势视图复用既有组件；
 * - findings：结论列表（决策卡排最前），点击可跳对应趋势 Tab。
 *
 * 2026-10-01 改版：「训练画像」由「每次同步重算、只留最新」改为**快照式版本** ——
 * 版本 0 = 首次建立，之后每个训练周期末 +1。顶部因此多了版本选择器与「生成画像版本」，
 * 以及「与上一版对比」。原来那个「重新分析」是诊断用的过程产物（kind='adhoc'），
 * 不产生版本，已从主按钮位撤下 —— 它在设置页「诊断与维护」里本来就有入口。
 */
import { useState } from 'react';
import type { AnalysisReport } from '../../server/analysis/reportSchema.js';
import {
  useCreateSnapshot,
  useLatestAnalysis,
  useSnapshotVersions,
  useVersionCompare,
  type CompareFinding,
} from '../api/client.js';
import { DOW_ZH, EFFECTIVE_SETS_HINT, MOVEMENT_VERDICT, MUSCLE_VERDICT, muscleZh } from '../api/labels.js';
import { CollapsibleCard, EmptyState, SectionCard, SeverityBadge, StatCard } from '../components/common/ui.js';
import { TrendTable } from '../components/analysis/TrendTable.js';
import { MuscleBars } from '../components/analysis/MuscleBars.js';
import { StructureRatio } from '../components/analysis/StructureRatio.js';
import { FindingList, type AnalysisTab } from '../components/analysis/FindingList.js';

const TABS: Array<{ id: AnalysisTab; label: string }> = [
  { id: 'basic', label: '概览' },
  { id: 'movement', label: '动作趋势' },
  { id: 'muscle', label: '肌群趋势' },
  { id: 'structure', label: '结构' },
  { id: 'findings', label: '结论' },
];

const WARMUP_SOURCE_ZH: Record<string, string> = {
  server_set_type: '服务端热身标记',
  heuristic: '启发式推断',
  mixed: '混合',
};

function pctText(v: number): string {
  return `${Math.round(v * 100)}%`;
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** ISO 时间 → `MM-DD`（与诊断区 fmtTime 同一套本地时间口径）。 */
function mmdd(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.slice(5, 10);
  return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** 版本选择器选项：`版本 3 · 11-30`。 */
function versionLabel(v: { version_no: number; generated_at: string }): string {
  return `版本 ${v.version_no} · ${mmdd(v.generated_at)}`;
}

/**
 * 判定 → 中文。复用 labels.ts 里已有的两套映射（动作 / 肌群是不同枚举，别混用）。
 * 服务端没给判定（null）→ 返回 null，调用方决定怎么显示。
 */
function verdictZh(v: string | null, kind: 'movement' | 'muscle'): string | null {
  if (v === null) return null;
  const map = kind === 'movement' ? MOVEMENT_VERDICT : MUSCLE_VERDICT;
  return map[v]?.label ?? v;
}

/** 变化百分比着色：涨绿、跌红、无数据灰。 */
function deltaCls(pct: number | null): string {
  if (pct === null) return 'text-slate-400';
  if (pct > 0) return 'text-emerald-600';
  if (pct < 0) return 'text-red-600';
  return 'text-slate-500';
}

function pctSigned(pct: number | null): string {
  if (pct === null) return '—';
  return `${pct > 0 ? '+' : ''}${pct}%`;
}

/** 时长中位数（旧快照没有该字段时回退平均时长）。 */
function durationText(bs: AnalysisReport['basic_stats']): string {
  const v = bs.duration_median_min ?? bs.avg_duration_min ?? null;
  const isMedian = bs.duration_median_min !== undefined && bs.duration_median_min !== null;
  if (v === null) return '—';
  return isMedian ? `${v} 分钟` : `约 ${v} 分钟`;
}

function BasicTab({ r }: { r: AnalysisReport }): React.ReactNode {
  const dq = r.data_quality;
  const bs = r.basic_stats;
  const ls = r.window.last_session;
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="训练次数" value={bs.total_sessions} sub={`窗口 ${r.window.weeks} 周`} hint="窗口内完成且未被剔除离群的训练天数" />
        <StatCard label="周均频率" value={bs.sessions_per_week} sub="次 / 周" hint="训练次数 ÷ 窗口周数" />
        <StatCard
          label="时长中位数"
          value={durationText(bs)}
          hint="剔除离群训练（时长缺失 / 过短 / 过长）后的中位数；排计划按中位数而不是上限"
        />
        <StatCard
          label="有效组总数"
          value={bs.total_effective_sets}
          sub={`力量 ${bs.strength_sessions} 次 · 有氧 ${bs.cardio_sessions} 次`}
          hint={EFFECTIVE_SETS_HINT}
        />
      </div>

      <SectionCard title="常用训练日" extra={<span className="text-xs text-slate-400">按窗口内出现天数统计</span>}>
        <div className="flex flex-wrap gap-2">
          {bs.preferred_dows.length === 0 && <span className="text-sm text-slate-400">无数据</span>}
          {bs.preferred_dows.map((d) => (
            <span key={d} className="rounded-lg bg-indigo-50 px-2.5 py-1 text-sm text-indigo-700">
              {DOW_ZH[d] ?? d}
            </span>
          ))}
        </div>
      </SectionCard>

      <SectionCard title="数据质量">
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <StatCard label="时长覆盖率" value={pctText(dq.duration_coverage)} hint="训练记录中填写了时长的比例" />
          <StatCard label="未映射组占比" value={pctText(dq.unmapped_set_ratio)} hint="动作名未能映射到肌群的有效组比例（映射表见设置页「诊断与维护」）" />
          {dq.server_type_coverage !== undefined && (
            <StatCard label="服务端类型覆盖" value={pctText(dq.server_type_coverage)} hint="组记录自带类型（正式/热身等）的比例" />
          )}
        </div>
        <div className="mt-3 flex flex-wrap gap-2 text-xs text-slate-500">
          <span className="rounded bg-slate-50 px-2 py-1">热身组来源：{WARMUP_SOURCE_ZH[dq.warmup_source] ?? dq.warmup_source}</span>
          <span className="rounded bg-slate-50 px-2 py-1">同步天数：{dq.synced_days}</span>
        </div>
        {(dq.excluded_outliers?.length ?? 0) > 0 && (
          <div className="mt-3">
            <div className="text-xs font-medium text-slate-500">已剔除离群训练（不参与统计）</div>
            <ul className="mt-1 space-y-0.5 text-xs text-slate-500">
              {dq.excluded_outliers!.map((o) => (
                <li key={o.datestr}>
                  {o.datestr} · {o.duration_min === null ? '时长缺失' : `${o.duration_min} 分钟`} ·{' '}
                  {{ too_short: '过短', too_long: '过长', missing_duration: '时长缺失' }[o.reason]}
                </li>
              ))}
            </ul>
          </div>
        )}
        {dq.warnings.length > 0 && (
          <div className="mt-3 rounded-lg bg-amber-50 p-3">
            <div className="text-xs font-medium text-amber-700">数据提醒</div>
            <ul className="mt-1 list-disc space-y-0.5 pl-4 text-xs text-amber-700">
              {dq.warnings.map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
          </div>
        )}
      </SectionCard>

      {ls && (
        <SectionCard title="最近一次训练" extra={<span className="text-xs text-slate-400">{ls.datestr}</span>}>
          <div className="text-sm font-medium text-slate-800">{ls.title || '（无标题）'}</div>
          <table className="mt-2 w-full text-sm">
            <thead>
              <tr className="border-b border-slate-100 text-left text-xs text-slate-400">
                <th className="py-1.5 pr-3 font-medium">动作</th>
                <th className="py-1.5 pr-3 font-medium" title={EFFECTIVE_SETS_HINT}>组数</th>
                <th className="py-1.5 font-medium">最大重量</th>
              </tr>
            </thead>
            <tbody>
              {ls.movements.map((m) => (
                <tr key={m.name} className="border-b border-slate-50 last:border-0">
                  <td className="py-1.5 pr-3 text-slate-700">{m.name}</td>
                  <td className="py-1.5 pr-3 tabular-nums text-slate-600">{m.sets}</td>
                  <td className="py-1.5 tabular-nums text-slate-600">{m.best_weight ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </SectionCard>
      )}
    </div>
  );
}

function MuscleTab({ r }: { r: AnalysisReport }): React.ReactNode {
  return (
    <div className="space-y-4">
      <SectionCard title="肌群周均有效组（最近 12 周分段对比）">
        <MuscleBars trends={r.muscle_trends} />
      </SectionCard>
      <SectionCard title="窗口总量明细" extra={<span className="text-xs text-slate-400" title={EFFECTIVE_SETS_HINT}>按有效组折算</span>}>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
          {Object.entries(r.muscle_volume).map(([code, v]) => (
            <div key={code} className="rounded-lg border border-slate-100 px-3 py-2">
              <div className="text-sm font-medium text-slate-800">{muscleZh(code)}</div>
              <div className="mt-0.5 text-xs tabular-nums text-slate-500">
                总 {v.sets_total} 组（全窗口）· 周均 {v.sets_per_week_seg0}（近 4 周）
              </div>
            </div>
          ))}
          {Object.keys(r.muscle_volume).length === 0 && <span className="text-sm text-slate-400">无数据</span>}
        </div>
      </SectionCard>
    </div>
  );
}

/** 结论增减里的一组（新增 / 消失）。 */
function CompareFindingGroup(props: { title: string; items: CompareFinding[]; emptyText: string }): React.ReactNode {
  return (
    <div>
      <div className="mb-2 text-xs font-medium text-slate-500">
        {props.title}（{props.items.length}）
      </div>
      {props.items.length === 0 ? (
        <div className="text-xs text-slate-400">{props.emptyText}</div>
      ) : (
        <ul className="space-y-1.5">
          {props.items.map((f) => (
            <li key={f.code} className="flex items-start gap-2 text-sm">
              <SeverityBadge severity={f.severity} />
              <span className="min-w-0 text-slate-700">{f.title}</span>
              <span className="ml-auto shrink-0 text-[11px] text-slate-400">{f.code}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * 「与上一版对比」展开后的内容。
 * 只在展开时才挂载，所以 compare 请求只在用户点开时发出（不在打开页面时发）。
 */
function VersionCompareView(props: { from: number; to: number }): React.ReactNode {
  const { data, isPending, isError, error } = useVersionCompare(props.from, props.to);
  if (isPending) return <div className="py-8 text-center text-sm text-slate-400">对比中…</div>;
  if (isError) return <div className="py-6 text-center text-sm text-red-600">对比加载失败：{String(error)}</div>;
  if (!data) return null;

  const { summary, movements, muscles, findings } = data;
  const changedMovements = movements.filter((m) => m.changed);
  // 只有**真的变了**的肌群才进列表：delta_pct === 0（量没动）不算。
  // 早先没排除 0，导致「两份一模一样的快照」会把全部 15 个肌群以「25.88 → 25.88  0%」列出来，
  // 而同一张卡的动作段却正确显示空态 —— 两段行为不一致，看着像列表坏了。
  const changedMuscles = muscles.filter((m) => m.delta_pct !== null && m.delta_pct !== 0);
  // 变化 ≥10% 的优先；不足 3 个就把所有有变化的都列出来，否则「只列了 1 行」会让人以为功能没生效。
  const bigMuscles = changedMuscles.filter((m) => Math.abs(m.delta_pct as number) >= 10);
  const shownMuscles = bigMuscles.length >= 3 ? bigMuscles : changedMuscles;

  return (
    <div className="space-y-4">
      <div className="rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-700">
        动作 <b className="tabular-nums">{summary.movements_changed}</b> 个有变化 · 肌群{' '}
        <b className="tabular-nums">{summary.muscles_changed}</b> 个量变了 · 新增结论{' '}
        <b className="tabular-nums">{summary.findings_added}</b> 条 / 消失{' '}
        <b className="tabular-nums">{summary.findings_removed}</b> 条
      </div>

      <SectionCard title="动作重量变化" extra={<span className="text-xs text-slate-400">只列有变化的动作</span>}>
        {changedMovements.length === 0 ? (
          <div className="py-6 text-center text-sm text-slate-400">这一版之间没有动作重量或判定变化</div>
        ) : (
          <ul className="space-y-1.5">
            {changedMovements.map((m) => {
              const verdictChanged = m.from_verdict !== m.to_verdict;
              return (
                <li key={m.name} className="flex flex-wrap items-center gap-2 rounded-lg border border-slate-100 px-3 py-2 text-sm">
                  <span className="font-medium text-slate-800">{m.name}</span>
                  <span className="tabular-nums text-slate-600">
                    {m.from_weight ?? '—'}kg → {m.to_weight ?? '—'}kg
                  </span>
                  <span className={`tabular-nums ${deltaCls(m.delta_pct)}`}>{pctSigned(m.delta_pct)}</span>
                  {verdictChanged && (
                    <span className="text-xs text-slate-400">
                      {verdictZh(m.from_verdict, 'movement') ?? '—'} → {verdictZh(m.to_verdict, 'movement') ?? '—'}
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </SectionCard>

      <SectionCard title="肌群周均变化" extra={<span className="text-xs text-slate-400">有效组 / 周</span>}>
        {shownMuscles.length === 0 ? (
          <div className="py-6 text-center text-sm text-slate-400">肌群训练量基本没变</div>
        ) : (
          <ul className="space-y-1.5">
            {shownMuscles.map((m) => (
              <li key={m.code} className="flex flex-wrap items-center gap-2 rounded-lg border border-slate-100 px-3 py-2 text-sm">
                <span className="font-medium text-slate-800">{m.name}</span>
                <span className="tabular-nums text-slate-600">
                  {m.from_weekly_sets} → {m.to_weekly_sets} 组/周
                </span>
                <span className={`tabular-nums ${deltaCls(m.delta_pct)}`}>{pctSigned(m.delta_pct)}</span>
              </li>
            ))}
          </ul>
        )}
      </SectionCard>

      <SectionCard title="结论增减">
        <div className="grid gap-4 sm:grid-cols-2">
          <CompareFindingGroup title="新增结论" items={findings.added} emptyText="没有新增结论" />
          <CompareFindingGroup title="消失结论" items={findings.removed} emptyText="没有消失结论" />
        </div>
      </SectionCard>
    </div>
  );
}

export function AnalysisPage(props: { initialTab?: AnalysisTab }): React.ReactNode {
  const versionsQuery = useSnapshotVersions();
  const versions = versionsQuery.data?.versions ?? [];
  // 列表已按版本号倒序，第一个就是最新。
  const latestVersionNo = versions.length > 0 ? versions[0].version_no : null;

  // 选中的版本是**临时状态**：不持久化、不进 URL。默认跟随最新（null = 跟最新）。
  const [selectedVersion, setSelectedVersion] = useState<number | null>(null);
  const [compareOpen, setCompareOpen] = useState(false);
  const [snapshotMsg, setSnapshotMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  const currentVersionNo = selectedVersion ?? latestVersionNo;
  // 对比对象 = 当前版本的**前一版**（version_no - 1）；不存在则不给入口。
  const prevMeta =
    currentVersionNo === null ? null : (versions.find((v) => v.version_no === currentVersionNo - 1) ?? null);

  // 传 undefined → 不带 version_no，服务端给最新快照（没有快照时回退最新报告）。
  const { data, isPending, isError, error, refetch } = useLatestAnalysis(currentVersionNo ?? undefined);
  const createSnapshot = useCreateSnapshot();
  const [tab, setTab] = useState<AnalysisTab>(props.initialTab ?? 'basic');

  const runCreateSnapshot = (): void => {
    setSnapshotMsg(null);
    createSnapshot.mutate(undefined, {
      onSuccess: (d) => {
        setSelectedVersion(null); // 新版本生成后回到最新
        setCompareOpen(false);
        setSnapshotMsg({ kind: 'ok', text: `已生成版本 ${d.version_no}（${mmdd(d.generated_at)} 生成）。` });
      },
      onError: (e) => setSnapshotMsg({ kind: 'err', text: e.message }),
    });
  };

  const snapshotButton = (label: string, pendingLabel: string): React.ReactNode => (
    <button
      className="rounded-lg bg-indigo-600 px-4 py-2 text-sm text-white disabled:opacity-50"
      disabled={createSnapshot.isPending}
      onClick={runCreateSnapshot}
    >
      {createSnapshot.isPending ? pendingLabel : label}
    </button>
  );

  const snapshotMessage = snapshotMsg && (
    <div
      className={`rounded-lg px-3 py-2 text-sm ${
        snapshotMsg.kind === 'ok' ? 'bg-emerald-50 text-emerald-700' : 'bg-red-50 text-red-600'
      }`}
    >
      {snapshotMsg.text}
    </div>
  );

  if (isPending) {
    return <div className="py-20 text-center text-sm text-slate-400">加载中…</div>;
  }
  if (isError) {
    return <EmptyState title="分析报告加载失败" desc={String(error)} action={<button className="rounded-lg bg-indigo-600 px-4 py-2 text-sm text-white" onClick={() => refetch()}>重试</button>} />;
  }
  if (!data?.exists || !data.report) {
    return (
      <div className="space-y-4">
        {snapshotMessage}
        <EmptyState
          title="还没有训练画像"
          desc="点下面的按钮，用已同步的训练数据产出第一份画像（版本 0）。之后每个训练周期结束时自动更新一版，画像不会被日常同步改动。"
          action={snapshotButton('生成训练画像', '生成中…')}
        />
      </div>
    );
  }

  const r = data.report;
  // `?? null` 兜底：后端未升级时 `version_no` 可能是 undefined，别渲染出「版本 undefined」。
  const shownVersionNo = data.version_no ?? null;
  const generatedIso = data.generatedAt ?? r.generated_at;
  const isHistorical = currentVersionNo !== null && latestVersionNo !== null && currentVersionNo !== latestVersionNo;
  const findingsCount = r.findings.length;
  const highCount = r.findings.filter((f) => f.severity === 'high').length;
  const tabExtra = (id: AnalysisTab): React.ReactNode => {
    if (id !== 'findings' || findingsCount === 0) return null;
    return (
      <span className={`ml-1.5 rounded px-1.5 py-0.5 text-[10px] leading-none ${highCount > 0 ? 'bg-red-100 text-red-600' : 'bg-slate-200 text-slate-500'}`}>
        {findingsCount}
      </span>
    );
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold text-slate-900">训练画像</h1>
          <p className="mt-0.5 text-xs text-slate-500">
            统计窗口 {r.window.trend_start} ~ {r.window.trend_end}（{r.window.weeks} 周） · 报告生成于{' '}
            {new Date(generatedIso).toLocaleString('zh-CN')}
          </p>
          <p className="mt-0.5 text-xs text-slate-400">
            画像一个训练周期更新一次。
            {shownVersionNo !== null
              ? `当前展示：版本 ${shownVersionNo}（${mmdd(generatedIso)} 生成）。`
              : '当前还没有版本快照，展示的是最新报告。'}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {versions.length > 0 && (
            <label className="flex items-center gap-2 text-xs text-slate-500">
              画像版本
              <select
                className="rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-sm text-slate-700 hover:border-slate-400 focus:border-indigo-500 focus:outline-none"
                value={currentVersionNo ?? ''}
                onChange={(e) => {
                  setSelectedVersion(Number(e.target.value));
                  setCompareOpen(false);
                }}
              >
                {versions.map((v) => (
                  <option key={v.version_no} value={v.version_no}>
                    {versionLabel(v)}
                  </option>
                ))}
              </select>
            </label>
          )}
          <button
            className="rounded-lg bg-indigo-600 px-4 py-2 text-sm text-white disabled:opacity-50"
            disabled={createSnapshot.isPending}
            title="基于已同步的训练数据，产出一份新的画像版本（每个训练周期一版）"
            onClick={runCreateSnapshot}
          >
            {createSnapshot.isPending ? '生成中…' : '生成画像版本'}
          </button>
        </div>
      </div>

      {snapshotMessage}

      {isHistorical && (
        <div className="flex flex-wrap items-center gap-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-2.5 text-sm text-amber-800">
          <span>
            你正在看历史版本（版本 {currentVersionNo}），最新是版本 {latestVersionNo}。
          </span>
          <button
            className="rounded-md border border-amber-300 bg-white px-2.5 py-1 text-xs text-amber-700 hover:bg-amber-100"
            onClick={() => {
              setSelectedVersion(null);
              setCompareOpen(false);
            }}
          >
            看最新
          </button>
        </div>
      )}

      {prevMeta !== null && currentVersionNo !== null && (
        <CollapsibleCard
          title="与上一版对比"
          summary={`版本 ${prevMeta.version_no} → 版本 ${currentVersionNo}`}
          open={compareOpen}
          onToggle={setCompareOpen}
        >
          {compareOpen && <VersionCompareView from={prevMeta.version_no} to={currentVersionNo} />}
        </CollapsibleCard>
      )}

      <div className="flex flex-wrap gap-1 border-b border-slate-200 pb-px">
        {TABS.map((t) => (
          <button
            key={t.id}
            className={`flex items-center rounded-t-lg px-3.5 py-2 text-sm transition-colors ${
              tab === t.id ? 'border-b-2 border-indigo-600 font-medium text-indigo-700' : 'text-slate-500 hover:text-slate-800'
            }`}
            onClick={() => setTab(t.id)}
          >
            {t.label}
            {tabExtra(t.id)}
          </button>
        ))}
      </div>

      {tab === 'basic' && <BasicTab r={r} />}
      {tab === 'movement' && (
        <SectionCard title="动作趋势" extra={<span className="text-xs text-slate-400" title={EFFECTIVE_SETS_HINT}>按周均有效组排序</span>}>
          <TrendTable trends={r.movement_trends} />
        </SectionCard>
      )}
      {tab === 'muscle' && <MuscleTab r={r} />}
      {tab === 'structure' && (
        <SectionCard title="训练结构">
          <StructureRatio structure={r.structure} />
        </SectionCard>
      )}
      {tab === 'findings' && <FindingList findings={r.findings} onGotoTab={(t) => setTab(t)} />}
    </div>
  );
}
