/**
 * 通用小组件（§2.3 src/components/common）。
 * 2026-09-30 视觉改版：结构与逻辑零改动，只统一「通用模板」的卡片语言 —
 * 16px 圆角、极浅投影、标题左侧一道 indigo 渐变强调条。
 */
import { useState } from 'react';
import type { ReactNode } from 'react';
import { SEVERITY } from '../../api/labels.js';

export function StatCard(props: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  /** hover 口径说明（§8.2 P2：每个数字 hover 可看口径说明） */
  hint?: string;
}): ReactNode {
  return (
    <div className="rounded-2xl border border-slate-200/80 bg-white p-5 shadow-[0_1px_3px_rgba(15,23,42,0.05)]" title={props.hint}>
      <div className="text-xs font-medium text-slate-500">{props.label}</div>
      <div className="mt-1.5 text-2xl font-bold tracking-tight text-slate-900">{props.value}</div>
      {props.sub !== undefined && <div className="mt-1 text-xs text-slate-400">{props.sub}</div>}
    </div>
  );
}

export function EmptyState(props: { title: string; desc?: ReactNode; action?: ReactNode }): ReactNode {
  return (
    <div className="flex flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-slate-300 bg-white px-6 py-14 text-center">
      <div className="text-base font-semibold text-slate-700">{props.title}</div>
      {props.desc && <div className="max-w-md text-sm text-slate-500">{props.desc}</div>}
      {props.action}
    </div>
  );
}

export function Badge(props: { cls: string; children: ReactNode; title?: string }): ReactNode {
  return (
    <span
      title={props.title}
      className={`inline-flex items-center rounded-md px-1.5 py-0.5 text-xs font-medium ${props.cls}`}
    >
      {props.children}
    </span>
  );
}

export function SeverityBadge({ severity }: { severity: string }): ReactNode {
  const s = SEVERITY[severity] ?? SEVERITY.info;
  return <Badge cls={s.cls}>{s.label}</Badge>;
}

export function SectionCard(props: { title: ReactNode; extra?: ReactNode; children: ReactNode }): ReactNode {
  return (
    <section className="overflow-hidden rounded-2xl border border-slate-200/80 bg-white shadow-[0_1px_3px_rgba(15,23,42,0.05)]">
      <div className="flex items-center justify-between gap-3 border-b border-slate-100 px-5 py-3.5">
        <h2 className="flex min-w-0 items-center gap-2.5 text-[15px] font-semibold tracking-tight text-slate-800">
          <span aria-hidden="true" className="h-4 w-1 shrink-0 rounded-full bg-gradient-to-b from-indigo-500 to-violet-500" />
          <span className="truncate">{props.title}</span>
        </h2>
        {props.extra}
      </div>
      <div className="p-5">{props.children}</div>
    </section>
  );
}

/**
 * 可折叠卡片 —— 设置页所有区块的统一外壳（2026-09-30 设置页改版新增）。
 *
 * 🔴 全站只有这一套折叠交互（用户定案）：卡片头整行可点，右端小三角
 *    朝右 `▶` = 收起、点一下转 90° 朝下 `▼` = 展开。
 *    改版前设置页有三个长相不同的折叠：诊断与维护用原生 `<details>`（浏览器灰 marker、
 *    位置缀在文字后面、不旋转）、用户画像用「展开查看 / 收起」按钮、其余三张压根不能收。
 *    用户原话：「两个的展开逻辑不一样，全部做成这个小角点一下下去就展开的这交互吧」。
 *
 * 🔴 默认收起、**且不持久化**：设置页里全是常驻信息，多数时候不需要看。
 *    但如果把开合状态存进 localStorage，用户某次展开后忘了收，下次进来看到的是展开的，
 *    第一反应就是「折叠坏了」—— 每次进设置页都回到收起态，行为永远可预期。
 *
 * `summary` 是收起态的价值所在 —— **收起不等于看不见**：标题右侧那串灰字直接显示当前值
 * （`一周 4 练 · 每次 60~90 分钟`、`女 · 31 岁 · 最新 58.5 kg`），扫一眼就知道现状，
 * 而不是要么看不到、要么为了看一眼把整张卡展开。
 */
export function CollapsibleCard(props: {
  title: ReactNode;
  /** 标题右侧的常驻摘要（收起/展开都显示）。收起时它就是「当前值」。 */
  summary?: ReactNode;
  /** 展开时卡片头右侧的额外内容（按钮之类）。 */
  extra?: ReactNode;
  /** 非受控初值，默认收起。 */
  defaultOpen?: boolean;
  /** 受控开合：给了 `open` 就完全由外部控制（例如「展开才发请求」的懒加载卡）。 */
  open?: boolean;
  onToggle?: (next: boolean) => void;
  children: ReactNode;
}): ReactNode {
  const [innerOpen, setInnerOpen] = useState(props.defaultOpen ?? false);
  const open = props.open ?? innerOpen;
  const toggle = (): void => {
    const next = !open;
    // 受控模式下不写内部 state，否则会出现「内部与外部各说各话」
    if (props.open === undefined) setInnerOpen(next);
    props.onToggle?.(next);
  };
  return (
    <section className="overflow-hidden rounded-2xl border border-slate-200/80 bg-white shadow-[0_1px_3px_rgba(15,23,42,0.05)]">
      {/* <button> 里不能放 <h2>（button 只收 phrasing content），所以反着套：
          标题语义由外层 h2 承担，可点区域是里层的 button（撑满整行）。 */}
      <h2 className="m-0">
        <button
          type="button"
          onClick={toggle}
          aria-expanded={open}
          className="flex w-full items-center gap-3 px-5 py-3.5 text-left transition-colors hover:bg-slate-50/70"
        >
          <span className="flex min-w-0 shrink-0 items-center gap-2.5 text-[15px] font-semibold tracking-tight text-slate-800">
            <span
              aria-hidden="true"
              className="h-4 w-1 shrink-0 rounded-full bg-gradient-to-b from-indigo-500 to-violet-500"
            />
            <span className="truncate">{props.title}</span>
          </span>
          {props.summary !== undefined && (
            <span className="min-w-0 flex-1 truncate text-xs text-slate-400">{props.summary}</span>
          )}
          {props.extra}
          <span
            aria-hidden="true"
            className={
              'ml-auto flex shrink-0 items-center text-slate-400 transition-transform duration-150 ' +
              (open ? 'rotate-90' : '')
            }
          >
            <svg width="16" height="16" viewBox="0 0 20 20" fill="none">
              <path
                d="M7.5 5l5 5-5 5"
                stroke="currentColor"
                strokeWidth="1.7"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </span>
        </button>
      </h2>
      {open && <div className="border-t border-slate-100 p-5">{props.children}</div>}
    </section>
  );
}

/**
 * 卡内分栏小标题（2026-09-30 两栏改版新增）。
 *
 * 用于「一张卡内部再分栏」的场景 —— 首页排计划卡（周期目标 ｜ 下周特殊情况）、
 * 复盘日卡（动作 ｜ 训练感受）。与 SectionCard 标题同款渐变强调条，只是小一号，
 * 这样「卡内栏」和「卡片」是同一套视觉语言，不会看起来像两张卡的碎片。
 *
 * 🔴 高度**必须固定**（`h-5` + 单行）：「首页排计划卡」里这一行是左右两栏各自的第一子元素，
 *    右栏多一句 note（周次说明）。只要允许它换行，右栏这一行就会比左栏高，两栏下面的输入框
 *    跟着不一样高 —— 而用户对未开周期态的要求正是「两个文本框要一样大」。
 */
export function PaneHead(props: { text: string; note?: string }): ReactNode {
  return (
    <div className="flex h-5 items-center gap-2.5 overflow-hidden">
      <span
        aria-hidden="true"
        className="h-3 w-0.5 shrink-0 rounded-full bg-gradient-to-b from-indigo-500 to-violet-500"
      />
      <span className="shrink-0 text-xs font-semibold tracking-tight text-slate-600">{props.text}</span>
      {props.note !== undefined && props.note !== '' && (
        <span className="min-w-0 truncate text-[11px] text-slate-400">{props.note}</span>
      )}
    </div>
  );
}
