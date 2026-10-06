/**
 * 动作条目（§8.2 P3-③）—— **动作名一行、训练量一行**（2026-09-30 用户第 6 轮定稿）。
 *
 * 🔴 为什么改成两行：首页「下周计划」变成 4 条竖长条后，每条只有约 228px 宽，
 *    「动作名 + 组/次/kg/休息 四个输入框」塞不进同一行 —— 原型实测 `4×10` 会被截成 `4×1`、
 *    `31.8` 被截成 `31.×`。用户拍板：「你把现在这个部分变窄，或者把动作挪到下一行」→ 采纳后者。
 *
 * 🔴 参数顺序与写法由用户定死：**先 kg，再「组 × 次」，最后休息秒**；
 *    组与次之间必须有乘号，kg 与组之间没有。三段列宽固定（`grid-cols-[62px_60px_1fr]`），
 *    所以同一条竖条里所有动作的同一段永远落在同一个 x 位置（用户要的「所有的组数再开始出现」）。
 *
 * 🔴 内外间距分两档（用户口述）：「动作跟组数肯定是一个项目，下一个动作跟组数是另外一个项目。
 *    你把动作跟组数之间间隔调大一点，那上一个动作跟这一个动作之间的整体模块的距离就要更大一点」
 *    → 项目内 6px（`mt-1.5`），项目间 20px（`py-1.5` × 2 + 列表 `space-y-2`）。
 *
 * 不给 RPE 输入框（PRD-v2 §11.4 决策 A：AI 只给重量 × 组数 × 次数）。
 * 改动防抖 800ms 后 PATCH（服务端重算 summary）。
 * why 不用 `<details>`（它会插在名字和训练量之间、打断两行节奏）→ 改 React state：
 * 入口是名字右上角一个 11px 的圆圈问号（用户第 8 轮：「打一个小小的问号，画一个圈，
 * 挂在动作的右上角，大概字体的 1/4~1/5 大小」），展开的内容落在训练量下面。
 */
import { useEffect, useRef, useState } from 'react';
import type { PlanExercise } from '../../api/client.js';

type Field = 'sets' | 'reps' | 'weight_kg' | 'rest_s';

/** 提交流程的字段顺序（与服务端列顺序无关，只是稳定遍历顺序）。 */
const PATCH_ORDER: Field[] = ['sets', 'reps', 'weight_kg', 'rest_s'];

const STEP: Record<Field, number> = { weight_kg: 2.5, sets: 1, reps: 1, rest_s: 15 };

/**
 * 输入框样式：平时**没有边框也没有底色**，看起来就是一列数字（像表格单元格）；
 * 鼠标移上去浮出淡边框，聚焦时蓝框 + 淡光晕。
 * 隐藏 number 的上下箭头（`[&::-webkit-…]`），否则 62px 宽的格子里箭头要吃掉一半。
 */
const INPUT =
  'min-w-0 flex-1 rounded border border-transparent bg-transparent px-1 py-0.5 text-right text-[12px] font-medium tabular-nums text-slate-700 ' +
  'placeholder:text-slate-300 ' +
  'hover:border-slate-200 hover:bg-white focus:border-indigo-400 focus:bg-white focus:ring-2 focus:ring-indigo-500/15 focus:outline-none ' +
  'disabled:cursor-not-allowed disabled:text-slate-400 ' +
  '[&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none';

export function ExerciseRow(props: {
  exercise: PlanExercise;
  disabled?: boolean;
  onPatch: (exerciseId: number, patch: Record<string, unknown>) => void;
  onDelete: (exerciseId: number) => void;
}): React.ReactNode {
  const { exercise, disabled, onPatch, onDelete } = props;
  const [local, setLocal] = useState<Record<Field, string>>(() => ({
    sets: String(exercise.sets),
    reps: exercise.reps === null ? '' : String(exercise.reps),
    weight_kg: exercise.weight_kg === null ? '' : String(exercise.weight_kg),
    rest_s: exercise.rest_s === null ? '' : String(exercise.rest_s),
  }));
  const [showWhy, setShowWhy] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const baseline = useRef(local);

  // 服务端数据变化（AI 调整/重新生成）时同步本地值
  useEffect(() => {
    const next = {
      sets: String(exercise.sets),
      reps: exercise.reps === null ? '' : String(exercise.reps),
      weight_kg: exercise.weight_kg === null ? '' : String(exercise.weight_kg),
      rest_s: exercise.rest_s === null ? '' : String(exercise.rest_s),
    };
    setLocal(next);
    baseline.current = next;
  }, [exercise.id, exercise.sets, exercise.reps, exercise.weight_kg, exercise.rest_s]);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const schedulePatch = (next: Record<Field, string>): void => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      const patch: Record<string, unknown> = {};
      for (const f of PATCH_ORDER) {
        if (next[f] === baseline.current[f]) continue;
        if (next[f] === '') patch[f] = null;
        else {
          const n = Number(next[f]);
          if (Number.isFinite(n)) patch[f] = n;
        }
      }
      if (Object.keys(patch).length > 0) {
        baseline.current = next;
        onPatch(exercise.id, patch);
      }
    }, 800);
  };

  const onChange = (key: Field, value: string): void => {
    const next = { ...local, [key]: value };
    setLocal(next);
    schedulePatch(next);
  };

  const inputFor = (key: Field): React.ReactNode => (
    <input
      type="number"
      step={STEP[key]}
      min={0}
      disabled={disabled}
      value={local[key]}
      placeholder="—"
      onChange={(e) => onChange(key, e.target.value)}
      className={INPUT}
    />
  );

  return (
    <div className="group rounded-lg px-2 py-1.5 transition-colors hover:bg-slate-50">
      {/* 第 1 行：序号 + 动作名（+ 问号图标 + 徽章 + 删除） */}
      <div className="flex items-center gap-1.5">
        <span className="w-3 shrink-0 text-right text-[10px] text-slate-300">{exercise.ord}</span>
        <span className="min-w-0 truncate text-[13px] font-medium text-slate-800" title={exercise.name}>
          {exercise.name}
        </span>
        {/* 说明入口（2026-09-30 用户第 8 轮）：原来是常驻的「为什么」三个字，太吵 ——
            用户要求「打一个小小的问号，画一个圈，挂在动作的右上角，大概字体的 1/4~1/5 大小」。
            所以做成 11px 的圆圈 + 7px 的问号，用 `-top-[3px]` + `-ml-1` 贴到名字右上角当上标。
            顺带把名字那一行的可用宽度从约 68px 提到约 89px（少了「为什么」三个字）。 */}
        {exercise.why !== '' && (
          <button
            type="button"
            onClick={() => setShowWhy((v) => !v)}
            title={showWhy ? '收起这条说明' : '为什么这么安排？'}
            aria-label="为什么这么安排"
            aria-expanded={showWhy}
            className="relative -top-[3px] -ml-1 flex h-[11px] w-[11px] shrink-0 items-center justify-center rounded-full border border-slate-300 text-[7px] leading-none font-semibold text-slate-400 transition-colors hover:border-indigo-400 hover:bg-indigo-50 hover:text-indigo-600"
          >
            ?
          </button>
        )}
        {exercise.is_cardio && <span className="shrink-0 rounded bg-sky-100 px-1 text-[10px] text-sky-700">有氧</span>}
        {exercise.source === 'manual' && (
          <span className="shrink-0 rounded bg-slate-100 px-1 text-[10px] text-slate-500">手动</span>
        )}
        <span className="ml-auto flex shrink-0 items-center">
          <button
            className="rounded px-1 text-[11px] text-slate-300 opacity-0 transition-opacity group-hover:opacity-100 hover:bg-red-50 hover:text-red-600 disabled:cursor-not-allowed disabled:text-slate-200"
            disabled={disabled}
            title="删除动作"
            onClick={() => onDelete(exercise.id)}
          >
            ✕
          </button>
        </span>
      </div>

      {/* 第 2 行：kg ｜ 组 × 次 ｜ 秒 —— 三列固定宽度，全条对齐 */}
      <div className="mt-1.5 grid grid-cols-[62px_60px_1fr] items-center pl-4">
        <label className="flex min-w-0 items-center gap-0.5" title="重量（kg）">
          {inputFor('weight_kg')}
          <span className="shrink-0 text-[10px] text-slate-400">kg</span>
        </label>
        <label className="flex min-w-0 items-center gap-0.5" title="组数 × 次数">
          {inputFor('sets')}
          <span className="shrink-0 text-[10px] text-slate-300">×</span>
          {inputFor('reps')}
        </label>
        <label className="flex min-w-0 items-center gap-0.5" title="组间休息（秒）">
          {inputFor('rest_s')}
          <span className="shrink-0 text-[10px] text-slate-400">秒</span>
        </label>
      </div>

      {exercise.why !== '' && showWhy && (
        <div className="mt-1 rounded bg-slate-100 px-2 py-1.5 text-[11px] leading-snug text-slate-600">
          {exercise.why}
        </div>
      )}
    </div>
  );
}
