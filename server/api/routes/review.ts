/**
 * 复盘路由。
 *
 * —— 周复盘（V8）——
 * GET  /api/reviews/week?week_start=…     某周手账视图（7 天计划 vs 实际 + 每日感受 + 已有总结）；默认当前周
 * PUT  /api/reviews/note                  写某天的感受 { datestr, text }；text 为空即删
 * POST /api/reviews/weekly                生成该周总结 { week_start }；**周未结束返回 400**
 * GET  /api/reviews/weeks?count=8         最近 N 周的 week_start（新→旧），给周选择器用
 *
 * 🔴 2026-09-30 用户定案：**总结只有一种节奏 —— 每周一次**。
 *    「它这个总结是每周生成一次，不是四周生成一次。」
 *    因此原 T5 的「4 周周期总结」三个端点（GET /api/reviews、GET /api/reviews/:id、
 *    POST /api/reviews/generate）已随 `reviewService.ts` 一并删除；`review` 表本身保留
 *    （删表要建迁移、收益为零，与 v2 砍除阶段对 `plan.version_no` 的处理一致）。
 *
 * 注意路由顺序：`/api/reviews/week|weekly|weeks|note` 都是字面量路径，天然不会被
 * 别的分支吃掉 —— 这条纪律在还有 `:id` 匹配时是必须的，现在只剩提醒价值。
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Db } from '../../db/index.js';
import { HttpError, sendJson } from '../errors.js';
import { readBody } from './analysis.js';
import {
  WeeklyReviewError,
  buildWeekView,
  generateWeeklyReview,
  recentWeekStarts,
} from '../../review/weeklyReview.js';
import { DailyNoteError, saveDailyNote } from '../../review/dailyNote.js';
import type { AiGateway } from '../../ai/schemas.js';

/** AI 依赖同计划路由（index.ts 装配传入）。 */
export interface ReviewAiDeps {
  gw: AiGateway;
  aiModelTag: string;
}

export function handleReviewRoutes(db: Db, ai: ReviewAiDeps | null): (req: IncomingMessage, res: ServerResponse, pathname: string) => Promise<boolean> {
  /** WeeklyReviewError / DailyNoteError → HttpError 翻译（app.ts 统一 catch HttpError）。 */
  function translate<T>(fn: () => T): T {
    try {
      return fn();
    } catch (e) {
      if (e instanceof WeeklyReviewError || e instanceof DailyNoteError) throw new HttpError(e.status, e.message);
      throw e;
    }
  }

  /** 本周起点的默认值 = 服务端按 user_goal.week_start_dow 算的当前周。 */
  function defaultWeekStart(db2: Db): string {
    return recentWeekStarts(db2, new Date().toISOString().slice(0, 10), 1)[0] as string;
  }

  /** 解析 query string（app.ts 传进来的 pathname 已去掉 query，所以从 req.url 取）。 */
  function queryOf(req: IncomingMessage): URLSearchParams {
    const raw = req.url ?? '';
    const i = raw.indexOf('?');
    return i === -1 ? new URLSearchParams() : new URLSearchParams(raw.slice(i + 1));
  }

  async function handleWeek(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<boolean> {
    // GET /api/reviews/week?week_start=…
    if (pathname === '/api/reviews/week' && req.method === 'GET') {
      const ws = queryOf(req).get('week_start') ?? defaultWeekStart(db);
      sendJson(res, 200, translate(() => buildWeekView(db, ws)));
      return true;
    }

    // GET /api/reviews/weeks?count=8
    if (pathname === '/api/reviews/weeks' && req.method === 'GET') {
      const raw = Number(queryOf(req).get('count') ?? 8);
      const count = Number.isFinite(raw) && raw > 0 ? Math.min(Math.floor(raw), 52) : 8;
      sendJson(res, 200, { weeks: recentWeekStarts(db, new Date().toISOString().slice(0, 10), count) });
      return true;
    }

    // PUT /api/reviews/note
    if (pathname === '/api/reviews/note' && req.method === 'PUT') {
      const body = await readBody(req);
      let v: unknown;
      try {
        v = JSON.parse(body);
      } catch {
        throw new HttpError(400, '请求体不是合法 JSON');
      }
      const src = (v ?? {}) as { datestr?: unknown; text?: unknown };
      const datestr = typeof src.datestr === 'string' ? src.datestr : '';
      const text = typeof src.text === 'string' ? src.text : '';
      const out = translate(() => saveDailyNote(db, datestr, text, Date.now()));
      sendJson(res, 200, out);
      return true;
    }

    // POST /api/reviews/weekly
    if (pathname === '/api/reviews/weekly' && req.method === 'POST') {
      const body = await readBody(req);
      let v: unknown = {};
      if (body.trim() !== '') {
        try {
          v = JSON.parse(body);
        } catch {
          throw new HttpError(400, '请求体不是合法 JSON');
        }
      }
      const rawWs = (v as { week_start?: unknown }).week_start;
      const weekStart = typeof rawWs === 'string' && rawWs !== '' ? rawWs : defaultWeekStart(db);
      let out;
      try {
        out = await generateWeeklyReview(db, ai?.gw ?? null, ai?.aiModelTag ?? 'none', { weekStart });
      } catch (e) {
        if (e instanceof WeeklyReviewError) throw new HttpError(e.status, e.message);
        throw e;
      }
      sendJson(res, 200, out);
      return true;
    }

    return false;
  }

  return async (req, res, pathname) => {
    // 字面量路径的周复盘路由
    if (await handleWeek(req, res, pathname)) return true;

    if (pathname.startsWith('/api/reviews')) {
      throw new HttpError(404, `未知的复盘路由：${req.method} ${pathname}`);
    }
    return false;
  };
}
