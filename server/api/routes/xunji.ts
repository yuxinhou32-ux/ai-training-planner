/**
 * 训记接入路由：让用户在设置页完成 XUNJI_API_KEY 配置。
 *
 * GET /api/xunji/config   当前接入状态（**Key 只回掩码**）
 * PUT /api/xunji/config   保存：写 `.env` + 立即热更新（重建同步引擎与写回客户端，不用重启）
 *
 * 🔴 与 AI 配置路由同一条安全纪律：明文 Key 绝不出后端。
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { HttpError, sendJson } from '../errors.js';
import { readBody } from './analysis.js';
import { XunjiConfigError, applyXunjiKey, validateXunjiKeyPatch, xunjiKeyView } from '../../xunji/xunjiConfig.js';

export interface XunjiConfigRouteDeps {
  /** `.env` 绝对路径。 */
  envPath: string;
  /** 读当前生效的 Key（每次请求时取，保证热更新后拿到的是新值）。 */
  currentKey: () => string | null;
  /** 保存成功后的回调：把新 Key 装到活着的同步引擎与写回客户端上。 */
  onApplied: (key: string | null) => void;
}

export function handleXunjiRoutes(
  deps: XunjiConfigRouteDeps,
): (req: IncomingMessage, res: ServerResponse, pathname: string) => Promise<boolean> {
  function translate<T>(fn: () => T): T {
    try {
      return fn();
    } catch (e) {
      if (e instanceof XunjiConfigError) throw new HttpError(e.status, e.message);
      throw e;
    }
  }

  return async (req, res, pathname) => {
    if (pathname !== '/api/xunji/config') return false;

    if (req.method === 'GET') {
      sendJson(res, 200, { config: xunjiKeyView(deps.currentKey()), env_file: deps.envPath });
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
      const patch = translate(() => validateXunjiKeyPatch(parsed));
      translate(() =>
        applyXunjiKey({
          envPath: deps.envPath,
          patch,
          current: deps.currentKey(),
          onApplied: deps.onApplied,
        }),
      );
      sendJson(res, 200, { config: xunjiKeyView(deps.currentKey()), env_file: deps.envPath, applied: true });
      return true;
    }

    throw new HttpError(405, `/api/xunji/config 不支持 ${req.method}`);
  };
}
