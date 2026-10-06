/**
 * 首次使用引导路由 —— 2026-10-06 新增。
 *
 * GET  /api/onboarding   → { done: boolean }
 * PUT  /api/onboarding   → body { done: true } → 写 app_config → { done: true }
 *
 * 🔴 引导**不新增写入路径**：这里只有完成位读写，三步的业务写入分别走
 *    既有的 `/api/xunji/config`、`/api/goal`、`/api/body`（见 onboardingService 顶部注释）。
 * 🔴 只允许写 `true`：防止误传 `false` 把已完成状态回退（validateOnboardingPatch 里有理由说明）。
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Db } from '../../db/index.js';
import { HttpError, sendJson } from '../errors.js';
import { readBody } from './analysis.js';
import {
  OnboardingError,
  isOnboardingDone,
  markOnboardingDone,
  validateOnboardingPatch,
} from '../../onboarding/onboardingService.js';

export function handleOnboardingRoutes(
  db: Db,
): (req: IncomingMessage, res: ServerResponse, pathname: string) => Promise<boolean> {
  /** OnboardingError → HttpError 翻译（app.ts 统一 catch HttpError）。 */
  function translate<T>(fn: () => T): T {
    try {
      return fn();
    } catch (e) {
      if (e instanceof OnboardingError) throw new HttpError(e.status, e.message);
      throw e;
    }
  }

  return async (req, res, pathname) => {
    if (pathname !== '/api/onboarding') return false;

    if (req.method === 'GET') {
      sendJson(res, 200, { done: isOnboardingDone(db) });
      return true;
    }

    if (req.method === 'PUT') {
      const raw = await readBody(req);
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        throw new HttpError(400, '请求体不是合法 JSON');
      }
      translate(() => validateOnboardingPatch(parsed));
      markOnboardingDone(db);
      sendJson(res, 200, { done: true });
      return true;
    }

    throw new HttpError(405, `/api/onboarding 不支持 ${req.method}`);
  };
}
