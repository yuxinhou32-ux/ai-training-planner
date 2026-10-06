/**
 * 结构趋势（§8.1 P2：推拉比 / 上下肢比 / 大肌群频率 / 高重复动作）。
 */
import type { AnalysisReport } from '../../../server/analysis/reportSchema.js';
import { muscleZh } from '../../api/labels.js';

function RatioBar(props: { title: string; ratio: number | null; target: [number, number]; leftLabel: string; rightLabel: string; leftSets?: number; rightSets?: number }): React.ReactNode {
  const inRange = props.ratio !== null && props.ratio >= props.target[0] && props.ratio <= props.target[1];
  // 可视映射：ratio 0.25~4 对数压缩到 0~100%
  const pct =
    props.ratio === null
      ? 50
      : Math.max(2, Math.min(98, ((Math.log2(props.ratio) + 2) / 4) * 100));
  const targetL = ((Math.log2(props.target[0]) + 2) / 4) * 100;
  const targetR = ((Math.log2(props.target[1]) + 2) / 4) * 100;
  return (
    <div>
      <div className="flex items-baseline justify-between">
        <span className="text-sm font-medium text-slate-800">{props.title}</span>
        <span className={`text-sm tabular-nums ${inRange ? 'text-emerald-600' : props.ratio === null ? 'text-slate-400' : 'text-amber-600'}`}>
          {props.ratio === null ? '数据不足' : props.ratio.toFixed(2)}
          {props.ratio !== null && (inRange ? '（达标）' : '（超区间）')}
        </span>
      </div>
      <div className="relative mt-2 h-3 rounded bg-slate-100">
        <div className="absolute inset-y-0 rounded bg-emerald-100" style={{ left: `${targetL}%`, width: `${targetR - targetL}%` }} />
        {props.ratio !== null && (
          <div
            className={`absolute top-1/2 h-4 w-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full ${inRange ? 'bg-emerald-500' : 'bg-amber-500'}`}
            style={{ left: `${pct}%` }}
          />
        )}
      </div>
      <div className="mt-1 flex justify-between text-[11px] text-slate-400">
        <span>
          {props.leftLabel}
          {props.leftSets !== undefined ? ` ${props.leftSets} 组` : ''}
        </span>
        <span>
          {props.rightLabel}
          {props.rightSets !== undefined ? ` ${props.rightSets} 组` : ''}
        </span>
      </div>
      <div className="mt-0.5 text-[11px] text-slate-400">目标区间 {props.target[0]} ~ {props.target[1]}</div>
    </div>
  );
}

export function StructureRatio({ structure }: { structure: AnalysisReport['structure'] }): React.ReactNode {
  return (
    <div className="space-y-6">
      <div className="grid gap-6 lg:grid-cols-2">
        <RatioBar
          title="推 / 拉 比"
          ratio={structure.push_pull_ratio}
          target={[0.8, 1.25]}
          leftLabel="推"
          rightLabel="拉"
          leftSets={structure.push_sets}
          rightSets={structure.pull_sets}
        />
        <RatioBar
          title="上肢 / 下肢 比"
          ratio={structure.upper_lower_ratio}
          target={[0.7, 1.4]}
          leftLabel="上肢"
          rightLabel="下肢"
        />
      </div>
      <div>
        <div className="text-sm font-medium text-slate-800">大肌群训练频率（次/周，建议 ≥1.5）</div>
        <div className="mt-2 flex flex-wrap gap-2">
          {Object.entries(structure.large_muscle_freq).length === 0 && (
            <span className="text-sm text-slate-400">无数据</span>
          )}
          {Object.entries(structure.large_muscle_freq).map(([code, freq]) => (
            <span
              key={code}
              className={`rounded-lg px-2.5 py-1 text-sm tabular-nums ${
                freq >= 1.5 ? 'bg-emerald-50 text-emerald-700' : 'bg-amber-50 text-amber-700'
              }`}
            >
              {muscleZh(code)} <strong>{freq}</strong>
            </span>
          ))}
        </div>
      </div>
      <div>
        <div className="text-sm font-medium text-slate-800">高重复动作（出现率 = 出现天数 ÷ 训练天数）</div>
        <div className="mt-2 space-y-1">
          {structure.top_repeated_movements.length === 0 && (
            <span className="text-sm text-slate-400">无数据</span>
          )}
          {structure.top_repeated_movements.map((m) => (
            <div key={m.catalog_id} className="flex items-center gap-3 text-sm">
              <span className="w-40 shrink-0 truncate text-slate-700">{m.name}</span>
              <div className="h-2 min-w-0 flex-1 overflow-hidden rounded bg-slate-100">
                <div className="h-full rounded bg-indigo-400" style={{ width: `${Math.min(m.appear_rate * 100, 100)}%` }} />
              </div>
              <span className="w-14 shrink-0 text-right tabular-nums text-slate-500">{Math.round(m.appear_rate * 100)}%</span>
            </div>
          ))}
        </div>
        <div className="mt-1 text-[11px] text-slate-400">出现率 ≥60% 且无同模式轮换时触发 R-AG-09 提醒。</div>
      </div>
    </div>
  );
}
