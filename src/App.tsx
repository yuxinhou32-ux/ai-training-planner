/**
 * 应用入口（hash 路由：个人工具不引路由库，反对过度设计）。
 *
 * 路由与 PRD-v2 §2 的「四个页面」对齐：
 *   #/               首页 · 下周（主操作页：周期 → 生成 → 调整 → 导入）
 *   #/review         复盘 · 本周（手账：每天写感受，周末一键 AI 复盘）
 *   #/settings       设置
 *   （④ 数据汇总本期不做 —— 前端连入口都不给，不是做一个空白页）
 *
 * 两个**不在导航里但必须可达**的路由（各自由页面上的按钮进入）：
 *   #/plan/confirm   写回训记的确认页（双栏杆）。首页「导入训记」按钮进这里。
 *   #/analysis       分析报告详情。设置页「诊断」区进这里。
 * 它们不占导航位是因为：前者是首页那件事的第二步，后者是排计划的依据而不是日常要看的东西。
 */
import { useEffect, useState } from 'react';
import { AppShell } from './components/layout/AppShell.js';
import { HomePage } from './pages/Home.js';
import { AnalysisPage } from './pages/Analysis.js';
import { SettingsPage } from './pages/Settings.js';
import { PlanConfirmPage } from './pages/PlanConfirm.js';
import { ReviewPage } from './pages/Review.js';
import { OnboardingDialog } from './components/onboarding/OnboardingDialog.js';
import type { AnalysisTab } from './components/analysis/FindingList.js';

const ANALYSIS_TABS: AnalysisTab[] = ['basic', 'movement', 'muscle', 'structure', 'findings'];

function normalize(hash: string): string {
  const raw = hash.replace(/^#/, '');
  return raw === '' ? '/' : raw;
}

function useHashRoute(): string {
  const [route, setRoute] = useState(() => normalize(window.location.hash));
  useEffect(() => {
    const onChange = (): void => setRoute(normalize(window.location.hash));
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return route;
}

function StagePlaceholder({ route }: { route: string }): React.ReactNode {
  return (
    <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-slate-300 bg-white px-6 py-20 text-center">
      <div className="text-base font-medium text-slate-700">页面不存在</div>
      <div className="mt-1 text-sm text-slate-400">未知路由：{route}</div>
      <a href="#/" className="mt-3 rounded-lg bg-indigo-600 px-4 py-2 text-sm text-white">
        回首页
      </a>
    </div>
  );
}

function parseAnalysisTab(route: string): AnalysisTab | undefined {
  const rest = route.replace(/^\/analysis\/?/, '');
  return ANALYSIS_TABS.includes(rest as AnalysisTab) ? (rest as AnalysisTab) : undefined;
}

export default function App(): React.ReactNode {
  const route = useHashRoute();

  let page: React.ReactNode;
  if (route === '/' || route === '/plan' || route.startsWith('/plan?')) {
    // 旧的 #/plan 直接当首页（v1 的「计划生成」已并入首页，别让书签变成 404）
    page = <HomePage />;
  } else if (route === '/plan/confirm' || route.startsWith('/plan/confirm?')) {
    page = <PlanConfirmPage />;
  } else if (route === '/review') {
    page = <ReviewPage />;
  } else if (route === '/analysis' || route.startsWith('/analysis/')) {
    const tab = parseAnalysisTab(route);
    page = <AnalysisPage key={tab ?? 'basic'} initialTab={tab} />;
  } else if (route === '/settings') {
    page = <SettingsPage />;
  } else {
    page = <StagePlaceholder route={route} />;
  }

  // 引导弹窗挂在壳内最外层：首次打开（完成位为 false）时自行出现，其余时候渲染 null。
  return (
    <AppShell current={route}>
      {page}
      <OnboardingDialog />
    </AppShell>
  );
}
