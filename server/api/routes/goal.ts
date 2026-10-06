/**
 * 训练基础路由（PRD-v2 V1）。
 *
 * GET  /api/goal   当前生效的训练基础（训练日 / 每次时长 / 一周起始日 / 长期目标）
 * PUT  /api/goal   保存（新增一行 + 旧行 is_active=0，历史计划指向不变）
 *
 * 两个刻意的设计：
 *  1. **不接受 sessions_per_week** —— 它由训练日数量推导（用户：「我选了几个训练日，
 *     你就能选几个一周几练」）。这样「4 次」与「偏好周一/三/五」的自相矛盾在数据层
 *     就不可能出现（旧 CLI 种子正是踩了这个坑）。
 *  2. **保存只落训练基础，不重跑分析**。分析报告是「快照」产物（手动刷新 / 周期末），
 *     而排计划现在**现算**报告（planService.runAnalysis persist:false），所以训练基础
 *     一改，下次排计划立刻用新值 —— 不再需要「保存后刷新报告」这层间接。
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Db } from '../../db/index.js';
import { HttpError, sendJson } from '../errors.js';
import { readBody } from './analysis.js';
import { GoalServiceError, getGoalSettings, saveGoalSettings } from '../../goal/goalService.js';

export function handleGoalRoutes(
  db: Db,
): (req: IncomingMessage, res: ServerResponse, pathname: string) => Promise<boolean> {
  /** GoalServiceError → HttpError 翻译（app.ts 统一 catch HttpError）。 */
  function translate<T>(fn: () => T): T {
    try {
      return fn();
    } catch (e) {
      if (e instanceof GoalServiceError) throw new HttpError(e.status, e.message);
      throw e;
    }
  }

  return async (req, res, pathname) => {
    if (pathname !== '/api/goal') return false;

    if (req.method === 'GET') {
      sendJson(res, 200, { goal: getGoalSettings(db) });
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
      const goal = translate(() => saveGoalSettings(db, parsed));
      sendJson(res, 200, { goal });
      return true;
    }

    throw new HttpError(405, `/api/goal 不支持 ${req.method}`);
  };
}
