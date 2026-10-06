/**
 * 身体信息 + 用户画像路由（PRD-v2 §10.3 V9）。
 *
 * GET  /api/body                    身体信息 + 体重历史（近 180 天，升序）
 * PUT  /api/body                    部分更新 { conditions?, weight_kg?, datestr? }
 *                                   weight_kg: null + datestr = 删掉那天的记录
 * GET  /api/profile                 用户画像（系统实际喂给 AI 的长期画像）
 *
 * 两个端点放一个文件：它们服务同一块 UI（设置页 V9），且画像里就要展示身体信息 ——
 * 分两个文件只会让「画像页展示的体重」与「身体信息卡的体重」各走一条读取路径。
 *
 * 🔴 这里**没有任何禁用动作的逻辑**：`conditions` 只是要展示/保存的一段文本。
 *    旧伤绝不进入候选池过滤（PRD-v2 §5）。
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Db } from '../../db/index.js';
import { HttpError, sendJson } from '../errors.js';
import { readBody } from './analysis.js';
import { BodyServiceError, getBodyInfo, listWeights, saveBodyInfo } from '../../body/bodyService.js';
import { buildProfileView } from '../../profile/profileService.js';

export function handleBodyRoutes(db: Db): (req: IncomingMessage, res: ServerResponse, pathname: string) => Promise<boolean> {
  /** BodyServiceError → HttpError 翻译（app.ts 统一 catch HttpError）。 */
  function translate<T>(fn: () => T): T {
    try {
      return fn();
    } catch (e) {
      if (e instanceof BodyServiceError) throw new HttpError(e.status, e.message);
      throw e;
    }
  }

  async function parseJson(req: IncomingMessage): Promise<unknown> {
    const raw = await readBody(req);
    try {
      return JSON.parse(raw) as unknown;
    } catch {
      throw new HttpError(400, '请求体不是合法 JSON');
    }
  }

  return async (req, res, pathname) => {
    if (pathname === '/api/body') {
      if (req.method === 'GET') {
        sendJson(res, 200, { info: getBodyInfo(db), weights: listWeights(db) });
        return true;
      }
      if (req.method === 'PUT') {
        const parsed = await parseJson(req);
        const info = translate(() => saveBodyInfo(db, parsed));
        sendJson(res, 200, { info, weights: listWeights(db) });
        return true;
      }
      throw new HttpError(405, `/api/body 不支持 ${req.method}`);
    }

    if (pathname === '/api/profile') {
      if (req.method !== 'GET') throw new HttpError(405, `/api/profile 不支持 ${req.method}`);
      // 没有分析报告时 profile 为 null（前端渲染引导语），不是 404 ——
      // 「报告还没生成」是一种正常状态，不是路由不存在。
      sendJson(res, 200, { profile: buildProfileView(db) });
      return true;
    }

    return false;
  };
}
