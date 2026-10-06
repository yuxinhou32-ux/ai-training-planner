/**
 * 应用壳（§8.1 AppShell：侧边导航 + 顶栏）。
 * 响应式预留（§8.3）：≥lg 侧边栏，<lg 顶部横向导航。
 *
 * 🔴 导航**只有这三项** —— PRD-v2 §2 的「四个页面」里，④ 数据汇总本期不做
 * （「后端保留接口，**前端不显示入口**，不做一个空白页面给用户」）。
 *
 * v1 那套六项导航（仪表盘 / 数据分析 / 计划生成 / 计划确认 / 周期总结 / 设置与映射）
 * 已被收敛：
 *   - 仪表盘 + 计划生成 → 合并成「首页 · 下周」（PRD §2① 是一个主操作页：
 *     看周期进度 → 生成下周计划 → 调整 → 导入，本来就不该拆成三页）
 *   - 计划确认 → 成了首页「导入」按钮的去处，不再单独占一个导航位
 *   - 周期总结 → 改叫「复盘 · 本周」（V8 之后它的主体是手账式周复盘，
 *     4 周中期总结只是页面底部默认折叠的一块）
 *   - 数据分析 → 收进设置页的「诊断」折叠区（它是给排计划做依据的，
 *     不是用户每天要看的东西）
 *   - 设置与映射 → 「设置」（映射表已收进诊断区）
 */
import type { ReactNode } from 'react';

export interface NavItem {
  hash: string;
  label: string;
  /** 后续阶段交付的页面只读占位 */
  stage?: string;
}

/** 导航只放 PRD §2 的三个页面；其余路由仍可达（首页按钮 / 设置页诊断区），只是不占位置。 */
export const NAV_ITEMS: NavItem[] = [
  // 「下周」不是「本周」：这一页排的永远是下一周（`nextWeekStart` 保证 +7）。
  // 用户拍板：「你首页的这一部分内容就全部是下周了，复盘那一块才是本周。」
  { hash: '/', label: '首页 · 下周' },
  { hash: '/review', label: '复盘 · 本周' },
  { hash: '/settings', label: '设置' },
];

export function AppShell({ current, children }: { current: string; children: ReactNode }): ReactNode {
  const isActive = (item: NavItem): boolean =>
    item.hash === '/' ? current === '/' : current.startsWith(item.hash);

  const nav = (
    <>
      {/* 品牌区：渐变方形标记 + 中文名 + 英文小字（纯视觉，无逻辑） */}
      <div className="px-4 pb-3 pt-5">
        <div className="flex items-center gap-2.5">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-indigo-500 to-violet-600 text-[13px] font-bold tracking-wide text-white shadow-[0_2px_6px_rgba(99,102,241,0.35)]">
            AI
          </div>
          <div className="min-w-0">
            <div className="truncate text-[15px] font-bold leading-tight tracking-tight text-slate-900">训练规划</div>
            <div className="text-[11px] leading-tight text-slate-400">AI Training Planner</div>
          </div>
        </div>
      </div>
      <nav className="flex flex-row gap-1 overflow-x-auto px-3 lg:flex-col lg:overflow-visible">
        {NAV_ITEMS.map((item) => (
          <a
            key={item.hash}
            href={`#${item.hash}`}
            className={`flex shrink-0 items-center gap-2 rounded-xl px-3.5 py-2.5 text-sm transition-colors ${
              isActive(item)
                ? 'bg-indigo-50 font-medium text-indigo-700 shadow-[inset_0_0_0_1px_rgb(224_231_255)]'
                : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900'
            }`}
          >
            {item.label}
            {item.stage && (
              <span
                className={`rounded px-1 py-0.5 text-[10px] leading-none ${
                  isActive(item) ? 'bg-white/20 text-white/90' : 'bg-slate-200 text-slate-500'
                }`}
              >
                {item.stage}
              </span>
            )}
          </a>
        ))}
      </nav>
    </>
  );

  return (
    <div className="flex h-full min-h-screen flex-col lg:flex-row">
      <header className="border-b border-slate-200/80 bg-white/90 backdrop-blur lg:hidden">{nav}</header>
      <aside className="hidden w-56 shrink-0 border-r border-slate-200/80 bg-white lg:block">{nav}</aside>
      <main className="min-w-0 flex-1 overflow-x-hidden">
        <div className="mx-auto w-full max-w-5xl px-4 py-8 sm:px-6 lg:px-10">{children}</div>
      </main>
    </div>
  );
}
