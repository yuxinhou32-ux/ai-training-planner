/**
 * 写回路由（T4，D11 双栏杆的 HTTP 层）。
 *
 * POST /api/plans/:id/approve         第一道栏杆：draft → approved
 * POST /api/plans/:id/write/preview   预演（纯本地：选日+校验+展示，零网络）
 * POST /api/plans/:id/write/confirm   第二道栏杆：body.confirmed===true 才执行真实写入
 *                                     （异步作业：同步跑完准入检查后立即返回 job_id，批次在后台跑）
 * GET  /api/plans/:id/write/job       作业状态（UI 轮询）
 *
 * 红线：真实写入只被 confirm 端点触达；不存在任何自动写入路径。
 * preview 纯本地不需要 Key，confirm 需要 Key（503 if missing）。
 *
 * 异步改造（2026-10-06）：confirm 曾同步阻塞 ~263s（4 天：65s×3 冷却 + 15s×4 读回）。
 * 现改为：beginWrite 在请求内同步完成全部准入检查（confirmed===true / approved|uncertain /
 * awaiting_confirm）与快照、状态转 writing，然后立即回 200 { job_id, total_batches, backup_path }；
 * 批次循环 runWriteBatches 在后台跑，前端轮询 GET write/job 看进度。
 * 准入错误仍是同步 HTTP 400/409 —— 用户点确认后必须立刻知道这一步有没有被拒。
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Db } from '../../db/index.js';
import { HttpError, sendJson } from '../errors.js';
import { readBody } from './analysis.js';
import { PlanServiceError } from '../../plan/planService.js';
import {
  approvePlan,
  beginWrite,
  createPreview,
  getWriteJob,
  recordWriteCrash,
  runWriteBatches,
  type WriteDeps,
} from '../../plan/writeService.js';

export interface WriteRouteDeps {
  deps: WriteDeps | null;
}

function requireDeps(deps: WriteDeps | null): WriteDeps {
  if (!deps) throw new HttpError(503, '未配置训记 API Key（XUNJI_API_KEY），写回功能不可用');
  return deps;
}

export function handleWriteRoutes(db: Db, routeDeps: WriteRouteDeps | null): (req: IncomingMessage, res: ServerResponse, pathname: string) => Promise<boolean> {
  async function translate<T>(fn: () => T | Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof PlanServiceError) throw new HttpError(e.status, e.message);
      throw e;
    }
  }

  return async (req, res, pathname) => {
    const m = pathname.match(/^\/api\/plans\/(\d+)\/(approve|write\/preview|write\/confirm|write\/job)$/);
    if (!m) return false;
    const planId = Number(m[1]);
    const action = m[2];

    // GET /api/plans/:id/write/job —— 只读，不需要 Key
    if (action === 'write/job' && req.method === 'GET') {
      const job = await translate(() => getWriteJob(db, planId));
      sendJson(res, 200, job ?? { job_id: null, plan_id: planId, status: 'none', total_batches: 0, finished_batches: 0, window: null, days: [], batches: [] });
      return true;
    }

    if (req.method !== 'POST') {
      if (pathname.startsWith('/api/plans')) throw new HttpError(404, `未知的写回路由：${req.method} ${pathname}`);
      return false;
    }

    if (action === 'approve') {
      await readBody(req); // 允许空体
      const out = await translate(() => approvePlan(db, planId));
      sendJson(res, 200, out);
      return true;
    }

    if (action === 'write/preview') {
      await readBody(req);
      // 预演纯本地，不需要 Key
      const deps = routeDeps?.deps ?? null as unknown as WriteDeps;
      const job = await translate(() => createPreview(db, deps, planId));
      sendJson(res, 200, job);
      return true;
    }

    // action === 'write/confirm'
    const raw = await readBody(req);
    let confirmed: unknown = false;
    try {
      const parsed = JSON.parse(raw) as { confirmed?: unknown };
      confirmed = parsed?.confirmed;
    } catch {
      // 非 JSON 体 → confirmed=false → 400 MISSING_CONFIRM
    }
    const deps = requireDeps(routeDeps?.deps ?? null);
    const { result, batches } = await translate(() => beginWrite(db, deps, planId, confirmed));
    // 先发响应，再在后台跑批次循环。catch 必须落库 + 通知，绝不留悬空状态。
    void runWriteBatches(db, deps, planId, result.job_id, batches).catch((e: unknown) =>
      recordWriteCrash(db, planId, result.job_id, e),
    );
    sendJson(res, 200, result);
    return true;
  };
}
