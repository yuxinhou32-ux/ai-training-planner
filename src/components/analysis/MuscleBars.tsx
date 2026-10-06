/**
 * 肌群趋势分段柱（§8.1 P2-MuscleBars：4 周分段对比 seg2 → seg1 → seg0）。
 * 纯 div 条形，不引图表库（反对过度设计）。
 */
import type { AnalysisReport } from '../../../server/analysis/reportSchema.js';
import { Badge } from '../common/ui.js';
import { MUSCLE_VERDICT, muscleZh } from '../../api/labels.js';

export function MuscleBars(props: {
  trends: AnalysisReport['muscle_trends'];
  onSelect?: (code: string) => void;
}): React.ReactNode {
  const { trends } = props;
  if (trends.length === 0) {
    return <div className="py-8 text-center text-sm text-slate-400">窗口内没有肌群数据</div>;
  }
  const maxSeg = Math.max(...trends.map((t) => Math.max(t.seg0, t.seg1, t.seg2)), 1);

  return (
    <div className="space-y-3">
      {[...trends]
        .sort((a, b) => b.seg0 - a.seg0)
        .map((t) => {
          const v = MUSCLE_VERDICT[t.verdict] ?? MUSCLE_VERDICT.stable;
          const row = (label: string, val: number, highlight: boolean): React.ReactNode => (
            <div className="flex items-center gap-2">
              <span className={`w-10 shrink-0 text-right text-[11px] ${highlight ? 'text-slate-700' : 'text-slate-400'}`}>{label}</span>
              <div className="h-3 min-w-0 flex-1 overflow-hidden rounded bg-slate-100">
                <div
                  className={`h-full rounded ${highlight ? 'bg-indigo-500' : 'bg-indigo-300'}`}
                  style={{ width: `${Math.max((val / maxSeg) * 100, 1.5)}%` }}
                />
              </div>
              <span className="w-12 shrink-0 tabular-nums text-[11px] text-slate-500">{val}</span>
            </div>
          );
          return (
            <div
              key={t.muscle_code}
              className="flex items-center gap-3 rounded-lg px-2 py-1.5 hover:bg-slate-50"
              onClick={(): void => props.onSelect?.(t.muscle_code)}
            >
              <div className="w-20 shrink-0 text-sm font-medium text-slate-800">{muscleZh(t.muscle_code)}</div>
              <div className="min-w-0 flex-1 space-y-1">
                {row('近4周', t.seg0, true)}
                {row('5-8周', t.seg1, false)}
                {row('9-12周', t.seg2, false)}
              </div>
              <div className="w-24 shrink-0 text-right">
                <Badge cls={v.cls}>{v.label}</Badge>
                {t.delta_recent_pct !== null && (
                  <div className={`mt-0.5 text-[11px] tabular-nums ${t.delta_recent_pct >= 20 ? 'text-emerald-600' : t.delta_recent_pct <= -20 ? 'text-red-600' : 'text-slate-400'}`}>
                    {t.delta_recent_pct > 0 ? '+' : ''}
                    {t.delta_recent_pct}%
                  </div>
                )}
              </div>
            </div>
          );
        })}
      <div className="pt-1 text-xs text-slate-400">柱值为周均有效组（seg0=近4周 / seg1=5-8周 / seg2=9-12周）。分段固定为最近 12 周，与画像窗口无关。判定：长期不足=连续两段低于阈值；过量=超阈值且主项无进步。</div>
    </div>
  );
}
