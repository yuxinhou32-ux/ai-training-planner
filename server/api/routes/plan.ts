/**
 * 计划路由（§2.3 server/api/routes/plan.ts）。
 *
 * GET    /api/plans/current?week_start=YYYY-MM-DD  某周计划详情（不传 = 计划周，即下一周）
 * POST   /api/plans/generate                   AI 生成（accept / 规则模板降级）
 *          body: { week_start?, mode?: 'auto' | 'full' }
 *          `mode='auto'`（默认）：周期第 2~4 周自动沿用上一周模板，省 token；
 *          `mode='full'`：显式重新全量生成（首页那行文字的入口）。
 *          响应含 `used_template` / `template_week_no`。
 * POST   /api/plans/regenerate-template        手动用规则模板生成（**不走模板复用**，见 planService）
 * PATCH  /api/plans/:id/exercises/:eid         手动编辑动作
 * DELETE /api/plans/:id/exercises/:eid         手动删除动作
 * POST   /api/plans/:id/days/:dayId/move       把整个训练日挪到另一天（V7；目标日有训练日则交换）
 *
 * v2 已移除 POST /api/plans/:id/adjust（AI 对话调整面板）——「重新生成」就够了。
 * 写回红线：本路由不含任何 approve/confirm/写入端点（双栏杆在 /plan/confirm 流程）。
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Db } from '../../db/index.js';
import type { AiGateway } from '../../ai/schemas.js';
import { HttpError, sendJson } from '../errors.js';
import { readBody } from './analysis.js';
import {
  PlanServiceError,
  activeWeekStartDow,
  createPlanFromAi,
  deleteExercise,
  getPlanIdForWeek,
  currentPlanningWeekStart,
  getPlanDetail,
  movePlanDay,
  nextWeekStart,
  regenerateTemplate,
  todayLocal,
  updateExercise,
  type CreatePlanOptions,
  type ExercisePatch,
} from '../../plan/planService.js';

/** AI 依赖由入口层装配（app.ts 拿不到 config；index.ts 构建 gateway 后传入）。 */
export interface PlanAiDeps {
  gw: AiGateway;
  /** plan.ai_model_tag 审计值：'http:<model>' | 'rule_fallback'。 */
  aiModelTag: string;
}

export function handlePlanRoutes(db: Db, ai: PlanAiDeps | null): (req: IncomingMessage, res: ServerResponse, pathname: string) => Promise<boolean> {
  /** PlanServiceError → HttpError 翻译（app.ts 统一 catch HttpError）；兼容同步/异步。 */
  async function translate<T>(fn: () => T | Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof PlanServiceError) throw new HttpError(e.status, e.message);
      throw e;
    }
  }

  function requireAi(): PlanAiDeps {
    if (!ai) throw new HttpError(503, 'AI 未配置（缺 LLM_API_KEY 或网关装配），可改用「规则模板生成」');
    return ai;
  }

  function matchPlanExercise(pathname: string): { planId: number; exerciseId: number } | null {
    const m = pathname.match(/^\/api\/plans\/(\d+)\/exercises\/(\d+)$/);
    return m ? { planId: Number(m[1]), exerciseId: Number(m[2]) } : null;
  }

  function matchPlanId(pathname: string, suffix: string): number | null {
    const m = pathname.match(new RegExp(`^/api/plans/(\\d+)${suffix}$`));
    return m ? Number(m[1]) : null;
  }

  function matchPlanDay(pathname: string, suffix: string): { planId: number; dayId: number } | null {
    const m = pathname.match(new RegExp(`^/api/plans/(\\d+)/days/(\\d+)${suffix}$`));
    return m ? { planId: Number(m[1]), dayId: Number(m[2]) } : null;
  }

  return async (req, res, pathname) => {
    // GET /api/plans/current
    if (pathname === '/api/plans/current' && req.method === 'GET') {
      // 🔴 取的是**计划周那份**，不是「最新一份」。
      //    首页整页讲下一周、确认页导入的也是下一周那份；按「最新一份」取的话，
      //    用户隔一周没生成时端上来的会是上一周那份 —— 标题写成「下周计划 · <上周日期>」，
      //    「重新生成」却按下一周排，看到的和会改的差一周。
      const q = new URL(req.url ?? '/', 'http://localhost').searchParams.get('week_start');
      if (q !== null && !/^\d{4}-\d{2}-\d{2}$/.test(q)) throw new HttpError(400, 'week_start 需为 YYYY-MM-DD');
      const weekStart = q ?? currentPlanningWeekStart(db);
      const planId = getPlanIdForWeek(db, weekStart);
      // 消息里保留「还没有计划」这个子串：前端空态就是靠它判「没计划」而不是「加载失败」。
      if (planId === null) throw new HttpError(404, `还没有计划：${weekStart} 那周还是空的，先点「生成计划」`);
      sendJson(res, 200, await translate(() => getPlanDetail(db, planId)));
      return true;
    }

    // GET /api/plans/:id —— 按 id 取详情（确认页 ?plan=N 用；current 因 week_start 排序不一定是最新生成的那份）
    const byId = pathname.match(/^\/api\/plans\/(\d+)$/);
    if (byId && req.method === 'GET') {
      sendJson(res, 200, await translate(() => getPlanDetail(db, Number(byId[1]))));
      return true;
    }

    // POST /api/plans/generate
    if (pathname === '/api/plans/generate' && req.method === 'POST') {
      const body = await readBody(req);
      const { weekStart, mode } = parseGenerateBody(body);
      const dep = requireAi();
      const out = await translate(() => createPlanFromAi(db, dep.gw, dep.aiModelTag, { weekStart, mode }));
      sendJson(res, 200, {
        plan_id: out.planId,
        /** 本次是否沿用了周期模板（true 时 `template_week_no` 一定非空）。 */
        used_template: out.templateWeekNo !== null,
        template_week_no: out.templateWeekNo,
        generation: out.result.status === 'accepted'
          ? { status: 'accepted', attempts: out.result.attempts, warnings: out.result.warnings, clamped: out.result.clamped }
          : { status: 'rule_fallback', reason: out.result.reason, attempts: out.result.attempts },
        detail: out.detail,
      });
      return true;
    }

    // POST /api/plans/regenerate-template
    if (pathname === '/api/plans/regenerate-template' && req.method === 'POST') {
      const body = await readBody(req);
      const weekStart = parseWeekStart(body);
      const detail = await translate(() => regenerateTemplate(db, { weekStart }));
      sendJson(res, 200, { plan_id: detail.plan.id, generation: { status: 'rule_fallback', reason: 'manual' }, detail });
      return true;
    }

    // PATCH / DELETE /api/plans/:id/exercises/:eid
    const pe = matchPlanExercise(pathname);
    if (pe && req.method === 'PATCH') {
      const body = await readBody(req);
      const patch = sanitizePatch(body);
      const out = await translate(() => updateExercise(db, pe.planId, pe.exerciseId, patch));
      sendJson(res, 200, out);
      return true;
    }
    if (pe && req.method === 'DELETE') {
      await readBody(req);
      const out = await translate(() => deleteExercise(db, pe.planId, pe.exerciseId));
      sendJson(res, 200, out);
      return true;
    }

    // POST /api/plans/:id/days/:dayId/move —— 把整个训练日挪到另一天（目标日有训练日则交换）
    const pdMove = matchPlanDay(pathname, '/move');
    if (pdMove && req.method === 'POST') {
      const body = await readBody(req);
      const datestr = parseDatestr(body);
      const out = await translate(() => movePlanDay(db, pdMove.planId, pdMove.dayId, datestr));
      sendJson(res, 200, out);
      return true;
    }
    // 同路径的其他方法要明确拒绝，否则会掉到末尾的「未知的计划路由」里报 404（语义不清）
    if (pdMove) throw new HttpError(405, `不支持的方法：${req.method} ${pathname}`);

    // POST /api/plans/:id/adjust —— v2 已移除（AI 对话调整面板）
    if (matchPlanId(pathname, '/adjust') !== null) {
      throw new HttpError(404, 'AI 对话调整已移除，请用「重新生成」');
    }

    if (pathname.startsWith('/api/plans')) {
      throw new HttpError(404, `未知的计划路由：${req.method} ${pathname}`);
    }
    return false;
  };
}

/**
 * POST /api/plans/generate 的请求体：`{ week_start?, mode? }`。
 *
 * `mode` 缺省 = `'auto'`（周期第 2~4 周自动沿用上一周模板）；
 * `'full'` = 首页「重新全量生成」用的显式否决 —— 跳过模板，走完整摘要层。
 * 宽容处理空体：老的调用方（脚本 / 测试）只发 `{}` 或不发体，等同 `auto`。
 */
function parseGenerateBody(raw: string): { weekStart?: string; mode: CreatePlanOptions['mode'] } {
  const weekStart = parseWeekStart(raw);
  if (raw.trim() === '') return { weekStart, mode: 'auto' };
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    throw new HttpError(400, '请求体不是合法 JSON');
  }
  const mode = (v as { mode?: unknown })?.mode;
  if (mode === undefined || mode === null || mode === '') return { weekStart, mode: 'auto' };
  if (mode !== 'auto' && mode !== 'full') throw new HttpError(400, "mode 只能是 'auto' 或 'full'");
  return { weekStart, mode };
}

function parseWeekStart(raw: string): string | undefined {  if (raw.trim() === '') return undefined;
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    throw new HttpError(400, '请求体不是合法 JSON');
  }
  const ws = (v as { week_start?: unknown })?.week_start;
  if (ws === undefined || ws === null || ws === '') return undefined;
  if (typeof ws !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(ws)) throw new HttpError(400, 'week_start 需为 YYYY-MM-DD');
  return ws;
}

/** POST body 里的 datestr（V7 挪训练日）。格式错误直接 400，不用等服务层兜。 */
function parseDatestr(raw: string): string {
  if (raw.trim() === '') throw new HttpError(400, '请求体不能为空');
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    throw new HttpError(400, '请求体不是合法 JSON');
  }
  const d = (v as { datestr?: unknown })?.datestr;
  if (typeof d !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(d)) throw new HttpError(400, 'datestr 需为 YYYY-MM-DD');
  return d;
}

function sanitizePatch(raw: string): ExercisePatch {
  if (raw.trim() === '') throw new HttpError(400, '请求体不能为空');
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    throw new HttpError(400, '请求体不是合法 JSON');
  }
  const src = (v ?? {}) as Record<string, unknown>;
  const patch: ExercisePatch = {};
  if (src.name !== undefined) patch.name = String(src.name);
  if (src.catalog_id !== undefined) patch.catalog_id = src.catalog_id === null ? null : Number(src.catalog_id);
  if (src.sets !== undefined) patch.sets = Number(src.sets);
  if (src.reps !== undefined) patch.reps = src.reps === null || src.reps === '' ? null : Number(src.reps);
  if (src.weight_kg !== undefined) patch.weight_kg = src.weight_kg === null || src.weight_kg === '' ? null : Number(src.weight_kg);
  if (src.rest_s !== undefined) patch.rest_s = src.rest_s === null || src.rest_s === '' ? null : Number(src.rest_s);
  return patch;
}
