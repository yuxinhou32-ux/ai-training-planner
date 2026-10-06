/**
 * 计划重置路由（2026-10-05 用户定案）—— 设置页最底部的「危险区」。
 *
 * GET  /api/reset/preview   预览：会删多少、什么不会被删
 * POST /api/reset/plan      执行清空（body: { clear_cycle?: boolean, confirm: 'CLEAR' }）
 *
 * 🔴 两道栏杆：
 *   1. `confirm` 必须逐字等于 `'CLEAR'` —— 防止误触 / 脚本空 body 打进来；
 *   2. 前端有二次确认弹窗 + 红框卡片。
 * 这跟「写回训记」不同：写回是要点两次的**外部副作用**，这里是**本地清理**，
 * 用户明确说「不需要做快照备份的处理」，所以不做 approve 流程，只做防误触。
 *
 * 只读/只删本地表，**不触任何网络**（不调训记、不调 AI）。
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Db } from '../../db/index.js';
import { HttpError, sendJson } from '../errors.js';
import { readBody } from './analysis.js';
import { previewReset, resetPlans, type ResetPlanResult, type ResetPreview } from '../../plan/resetService.js';

async function parseJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const raw = await readBody(req);
  try {
    const parsed = JSON.parse(raw) as unknown;
    return (parsed ?? {}) as Record<string, unknown>;
  } catch {
    throw new HttpError(400, '请求体不是合法 JSON');
  }
}

export function handleResetRoutes(
  db: Db,
): (req: IncomingMessage, res: ServerResponse, pathname: string) => Promise<boolean> {
  return async (req, res, pathname) => {
    if (pathname === '/api/reset/preview') {
      if (req.method !== 'GET') throw new HttpError(405, `/api/reset/preview 不支持 ${req.method}`);
      sendJson(res, 200, previewReset(db) satisfies ResetPreview);
      return true;
    }

    if (pathname === '/api/reset/plan') {
      if (req.method !== 'POST') throw new HttpError(405, `/api/reset/plan 不支持 ${req.method}`);
      const body = await parseJsonBody(req);
      // 防误触闸门：必须逐字传 'CLEAR'（前端二次确认框里让用户确认的也是这个）
      if (body.confirm !== 'CLEAR') {
        throw new HttpError(400, '确认码不正确 —— 需要在确认框里明确确认「清空」才会执行');
      }
      const result: ResetPlanResult = resetPlans(db, { clearCycle: body.clear_cycle === true });
      sendJson(res, 200, { ok: true, result, preview: previewReset(db) });
      return true;
    }

    return false;
  };
}
