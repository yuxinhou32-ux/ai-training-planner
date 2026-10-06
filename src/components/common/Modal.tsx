/**
 * 通用弹窗 —— 全站第一个 modal（2026-10-06 随首次引导新增）。
 *
 * `src/components/common/ui.tsx` 现有导出（StatCard / EmptyState / Badge / SeverityBadge /
 * SectionCard / CollapsibleCard / PaneHead）**没有任何 dialog**，引导需要一层真正的模态，
 * 所以单独放这里，而不是硬塞进 ui.tsx。
 *
 * 刻意保持最小：只有 `title / children / footer / onClose` 四个 props。
 * 行为三件套（用户对模态的默认预期，一个都不能少）：
 *   1. ESC 关闭；2. 点遮罩关闭；3. 焦点陷阱（Tab/Shift+Tab 在面板内循环，不逃到背后页面）。
 *
 * 渲染到 `document.body`（createPortal）：避免被祖先的 transform / overflow 影响 fixed 定位。
 * 本项目是纯客户端渲染（`createRoot`），document 一定存在。
 */
import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import type { ReactNode } from 'react';

export function Modal(props: {
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
}): ReactNode {
  const panelRef = useRef<HTMLDivElement>(null);

  // 打开时把焦点移进面板（并在关闭时归还给触发元素），键盘用户才有「我进了弹窗」的感知。
  useEffect(() => {
    const prevActive = document.activeElement as HTMLElement | null;
    panelRef.current?.focus();
    return () => prevActive?.focus?.();
  }, []);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        props.onClose();
        return;
      }
      if (e.key !== 'Tab') return;

      const panel = panelRef.current;
      if (panel === null) return;
      const focusables = panel.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
      );
      if (focusables.length === 0) {
        e.preventDefault();
        panel.focus();
        return;
      }
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement;
      // 焦点在面板空白处时，Shift+Tab 也回卷到最后一个
      if (e.shiftKey && (active === first || active === panel)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [props.onClose]);

  const node = (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4"
      // 用 mousedown 而非 click：避免「在输入框里按下、拖到遮罩上松开」被误判成点遮罩
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) props.onClose();
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        tabIndex={-1}
        className="flex max-h-[85vh] w-full max-w-lg flex-col overflow-hidden rounded-2xl border border-slate-200/80 bg-white shadow-[0_1px_3px_rgba(15,23,42,0.05)] focus:outline-none"
      >
        <div className="flex items-center justify-between gap-3 border-b border-slate-100 px-5 py-3.5">
          <h2 className="flex min-w-0 items-center gap-2.5 text-[15px] font-semibold tracking-tight text-slate-800">
            <span
              aria-hidden="true"
              className="h-4 w-1 shrink-0 rounded-full bg-gradient-to-b from-indigo-500 to-violet-500"
            />
            <span className="truncate">{props.title}</span>
          </h2>
          <button
            type="button"
            onClick={props.onClose}
            aria-label="关闭"
            className="shrink-0 rounded-lg p-1 text-slate-400 transition hover:bg-slate-50 hover:text-slate-600"
          >
            <svg width="18" height="18" viewBox="0 0 20 20" fill="none" aria-hidden="true">
              <path d="M5 5l10 10M15 5L5 15" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-5">{props.children}</div>

        {props.footer !== undefined && <div className="border-t border-slate-100 px-5 py-3.5">{props.footer}</div>}
      </div>
    </div>
  );

  return createPortal(node, document.body);
}
