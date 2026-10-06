/**
 * 动作趋势表（§8.1 P2-TrendTable）。
 */
import type { AnalysisReport } from '../../../server/analysis/reportSchema.js';
import { Badge } from '../common/ui.js';
import { MOVEMENT_VERDICT, EFFECTIVE_SETS_HINT } from '../../api/labels.js';

export function TrendTable({ trends }: { trends: AnalysisReport['movement_trends'] }): React.ReactNode {
  if (trends.length === 0) {
    return <div className="py-8 text-center text-sm text-slate-400">窗口内没有可统计的动作</div>;
  }
  const sorted = [...trends].sort((a, b) => {
    const rank = (v: string): number => (v === 'regress' ? 0 : v === 'plateau' ? 1 : v === 'progress' ? 2 : 3);
    return rank(a.verdict) - rank(b.verdict) || b.avg_sets_per_week - a.avg_sets_per_week;
  });
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[760px] text-sm">
        <thead>
          <tr className="border-b border-slate-200 text-left text-xs text-slate-500">
            <th className="py-2 pr-3 font-medium">动作</th>
            <th className="py-2 pr-3 font-medium">判定</th>
            <th className="py-2 pr-3 font-medium" title={EFFECTIVE_SETS_HINT}>
              数据周数
            </th>
            <th className="py-2 pr-3 font-medium">重量（首→末）</th>
            <th className="py-2 pr-3 font-medium" title="最近 2 周均值 vs 最早 2 周均值">
              Δ重量
            </th>
            <th className="py-2 pr-3 font-medium" title="最小二乘斜率，正数 = 重量在涨">
              斜率 kg/周
            </th>
            <th className="py-2 pr-3 font-medium" title={EFFECTIVE_SETS_HINT}>
              组/周
            </th>
            <th className="py-2 font-medium">最近训练</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((t) => {
            const v = MOVEMENT_VERDICT[t.verdict] ?? MOVEMENT_VERDICT.unstable;
            return (
              <tr key={t.catalog_id} className="border-b border-slate-100 last:border-0 hover:bg-slate-50">
                <td className="py-2 pr-3 font-medium text-slate-900">{t.name}</td>
                <td className="py-2 pr-3">
                  <Badge cls={v.cls}>{v.label}</Badge>
                </td>
                <td className="py-2 pr-3 tabular-nums text-slate-600">{t.weeks_with_data}</td>
                <td className="py-2 pr-3 tabular-nums text-slate-600">
                  {t.first_weight ?? '—'} → {t.last_weight ?? '—'}
                </td>
                <td
                  className={`py-2 pr-3 tabular-nums ${
                    t.delta_weight_pct === null ? 'text-slate-400' : t.delta_weight_pct >= 2.5 ? 'text-emerald-600' : t.delta_weight_pct <= -5 ? 'text-red-600' : 'text-slate-600'
                  }`}
                >
                  {t.delta_weight_pct === null ? '—' : `${t.delta_weight_pct > 0 ? '+' : ''}${t.delta_weight_pct}%`}
                </td>
                <td className="py-2 pr-3 tabular-nums text-slate-600">{t.slope_weight_per_week ?? '—'}</td>
                <td className="py-2 pr-3 tabular-nums text-slate-600">{t.avg_sets_per_week}</td>
                <td className="py-2 tabular-nums text-slate-500">{t.last_performed ?? '—'}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
