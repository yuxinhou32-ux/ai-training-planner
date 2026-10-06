/**
 * 计划周特殊情况路由（2026-09-30 用户定案）。
 *
 * GET /api/week-note?week_start=YYYY-MM-DD   读某个计划周的特殊情况（不传 = 下一周）
 * PUT /api/week-note                         写 { week_start?, text }（不传 = 下一周，空文本 = 清空）
 *
 * 🔴 为什么按「计划周」而不是「今天」：
 *    首页那个框是**为生成计划服务的**，而计划排的是**计划周**
 *    （`currentPlanningWeekStart`：本周还剩训练日就排本周，否则顺延下周）。
 *    所以不传 week_start 时的默认值必须与排计划用的周一致，否则用户写的与 AI 读的差一周。
 *
 * 这只是**一段文本的读写**，不做任何「禁用/替换动作」的联动 ——
 * 怎么用由 prompt 决定（PRD-v2 §5：它优先级最高，但手段是减容而非禁用）。
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Db } from '../../db/index.js';
import { HttpError, sendJson } from '../errors.js';
import { readBody } from './analysis.js';
import { WeekNoteError, loadWeekNote, saveWeekNote } from '../../week/weekNoteService.js';
import { currentPlanningWeekStart } from '../../plan/planService.js';

export function handleWeekNoteRoutes(
  db: Db,
): (req: IncomingMessage, res: ServerResponse, pathname: string) => Promise<boolean> {
  function translate<T>(fn: () => T): T {
    try {
      return fn();
    } catch (e) {
      if (e instanceof WeekNoteError) throw new HttpError(e.status, e.message);
      throw e;
    }
  }

  /** 计划周起点 —— 与排计划共用同一判据（本周还剩训练日就排本周）。 */
  function planWeekStart(): string {
    return currentPlanningWeekStart(db);
  }

  function resolveWeekStart(raw: unknown): string {
    if (typeof raw === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
    if (raw !== undefined && raw !== null && raw !== '') {
      throw new HttpError(400, 'week_start 需为 YYYY-MM-DD');
    }
    return planWeekStart();
  }

  async function parseJson(req: IncomingMessage): Promise<Record<string, unknown>> {
    const raw = await readBody(req);
    try {
      const parsed = JSON.parse(raw) as unknown;
      return (parsed ?? {}) as Record<string, unknown>;
    } catch {
      throw new HttpError(400, '请求体不是合法 JSON');
    }
  }

  return async (req, res, pathname) => {
    if (pathname !== '/api/week-note') return false;

    if (req.method === 'GET') {
      const weekStart = resolveWeekStart(new URL(req.url ?? '/', 'http://localhost').searchParams.get('week_start'));
      sendJson(res, 200, { week_start: weekStart, text: loadWeekNote(db, weekStart) });
      return true;
    }

    if (req.method === 'PUT') {
      const body = await parseJson(req);
      // week_start 允许从查询串给（PUT 也能带着 ?week_start=…）——
      // 给了就必须合法，非法值不能静默忽略退回「计划周」，否则写错周了没人知道。
      const fromQuery = new URL(req.url ?? '/', 'http://localhost').searchParams.get('week_start');
      const weekStart = resolveWeekStart(body.week_start ?? fromQuery);
      const text = typeof body.text === 'string' ? body.text : '';
      const saved = translate(() => saveWeekNote(db, weekStart, text, Date.now()));
      sendJson(res, 200, saved);
      return true;
    }

    throw new HttpError(405, `/api/week-note 不支持 ${req.method}`);
  };
}
