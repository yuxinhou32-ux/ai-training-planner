/**
 * 分析结论列表（§8.1 P2-FindingList；P1 结论卡复用）。
 *
 * v2：已移除决策卡机制——结论只作陈述，取舍交给用户与 AI 教练。
 * 点击结论可跳转到对应趋势 Tab（§8.2 P2-③）。
 */
import type { AnalysisReport, Finding } from '../../../server/analysis/reportSchema.js';
import { SeverityBadge } from '../common/ui.js';

export type AnalysisTab = 'basic' | 'movement' | 'muscle' | 'structure' | 'findings';

/** 结论 → 所属 Tab（§8.2 P2-③：条目点击跳转对应趋势 Tab）。 */
export function findingTab(code: string): AnalysisTab {
  if (code === 'R-AG-05') return 'movement';
  if (code === 'R-AG-03' || code === 'R-AG-04') return 'muscle';
  if (code === 'R-AG-07' || code === 'R-AG-08') return 'structure';
  return 'basic';
}

function evidenceLine(f: Finding): string {
  const e = f.evidence;
  const parts = [e.metric];
  if (e.value !== undefined && e.value !== null) parts.push(`值=${String(e.value)}`);
  if (e.baseline !== undefined && e.baseline !== null) parts.push(`基线=${String(e.baseline)}`);
  if (e.compare) parts.push(e.compare);
  if (e.window) parts.push(e.window);
  return parts.join(' · ');
}

export function FindingList(props: {
  findings: Finding[];
  onGotoTab?: (tab: AnalysisTab) => void;
  limit?: number;
}): React.ReactNode {
  const list = props.limit ? props.findings.slice(0, props.limit) : props.findings;
  if (list.length === 0) {
    return <div className="py-8 text-center text-sm text-slate-400">当前没有触发任何结论 —— 一切正常</div>;
  }
  return (
    <div className="space-y-3">
      {list.map((f, i) => (
        <div
          key={`${f.code}-${i}`}
          className={`rounded-xl border border-slate-200 bg-white p-4 ${props.onGotoTab ? 'cursor-pointer hover:border-indigo-300' : ''}`}
          onClick={(): void => props.onGotoTab?.(findingTab(f.code))}
        >
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <SeverityBadge severity={f.severity} />
                <span className="font-medium text-slate-900">{f.title}</span>
              </div>
              <div className="mt-1 text-sm text-slate-600">{f.detail}</div>
              {f.suggestion && (
                <div className="mt-1.5 text-sm text-emerald-700">
                  <span className="text-slate-400">建议：</span>
                  {f.suggestion}
                </div>
              )}
              <div className="mt-1.5 text-[11px] text-slate-400">
                {f.code} · {evidenceLine(f)}
              </div>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
