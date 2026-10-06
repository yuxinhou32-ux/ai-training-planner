/**
 * AI 配置路由（PRD-v2 V4）。
 *
 * GET /api/ai/config   当前 AI 配置（**Key 只回掩码**）
 * PUT /api/ai/config   保存：写 `.env` + 立即热更新（不用重启服务）
 *
 * 🔴 安全红线（PRD-v2 §10.3 V4）：
 *  - Key 的唯一落盘位置是 `.env`（已被 .gitignore 忽略）。**绝不入库、绝不写日志、绝不回传明文**；
 *  - 响应里只有 `has_key`（布尔）与 `key_hint`（`****后四位`）；
 *  - 请求里不带 `api_key` 就保持原值不动 —— 前端拿不到明文，所以不会「保存一次就被清空」。
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { HttpError, sendJson } from '../errors.js';
import { readBody } from './analysis.js';
import {
  AiConfigError,
  applyAiConfig,
  validateAiConfigPatch,
  type AiRuntime,
} from '../../ai/aiConfig.js';

export interface AiConfigRouteDeps {
  runtime: AiRuntime;
  /** `.env` 绝对路径。 */
  envPath: string;
  /** 保存成功后的回调：把审计标签同步给 job/plan 依赖（热更新的一部分）。 */
  onApplied?: (tag: string) => void;
}

export function handleAiRoutes(
  deps: AiConfigRouteDeps,
): (req: IncomingMessage, res: ServerResponse, pathname: string) => Promise<boolean> {
  function translate<T>(fn: () => T): T {
    try {
      return fn();
    } catch (e) {
      if (e instanceof AiConfigError) throw new HttpError(e.status, e.message);
      throw e;
    }
  }

  return async (req, res, pathname) => {
    if (pathname !== '/api/ai/config') return false;

    if (req.method === 'GET') {
      sendJson(res, 200, { config: deps.runtime.view(), env_file: deps.envPath });
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
      const patch = translate(() => validateAiConfigPatch(parsed));
      const config = translate(() => applyAiConfig(deps.runtime, { envPath: deps.envPath, patch }));
      deps.onApplied?.(deps.runtime.tag());
      sendJson(res, 200, { config, env_file: deps.envPath, applied: true });
      return true;
    }

    throw new HttpError(405, `/api/ai/config 不支持 ${req.method}`);
  };
}
