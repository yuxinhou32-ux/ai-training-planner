/**
 * 训练周期路由（PRD-v2 V2）。
 *
 * GET  /api/cycle            当前周期 + 计划周/本周各是第几周 + 是否减量周
 * POST /api/cycle            开新周期（周期目标 + 开始周）
 * PUT  /api/cycle/goal       「强行修改」周期目标（唯一改动入口，会留痕）
 * POST /api/cycle/close      手动结束当前周期
 *
 * ⚠️ 周期目标在周期内锁定：不做常规的 PATCH，只留 force-edit 这一个口子。
 *    用户明确「防止频繁改目标等于没目标」——所以这个接口在 UI 上默认折叠、要二次确认。
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Db } from '../../db/index.js';
import { HttpError, sendJson } from '../errors.js';
import { readBody } from './analysis.js';
import {
  CycleServiceError,
  closeActiveCycle,
  currentWeekStart,
  cycleStatusFor,
  forceEditCycleGoal,
  getActiveCycle,
  isCycleExpired,
  openCycle,
} from '../../cycle/cycleService.js';
import { getGoalSettings } from '../../goal/goalService.js';
import { currentPlanningWeekStart, todayLocal, nextWeekStart } from '../../plan/planService.js';
import { createSnapshot, type SnapshotMeta } from '../../analysis/snapshot.js';
import { hasTrainingData } from '../../repo/trainRepo.js';

async function parseJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const raw = await readBody(req);
  try {
    const parsed = JSON.parse(raw) as unknown;
    return (parsed ?? {}) as Record<string, unknown>;
  } catch {
    throw new HttpError(400, '请求体不是合法 JSON');
  }
}

export function handleCycleRoutes(
  db: Db,
): (req: IncomingMessage, res: ServerResponse, pathname: string) => Promise<boolean> {
  function translate<T>(fn: () => T): T {
    try {
      return fn();
    } catch (e) {
      if (e instanceof CycleServiceError) throw new HttpError(e.status, e.message);
      throw e;
    }
  }

  /** 一周起始日跟随训练基础设置；无设置时按周一。 */
  function weekStartDow(): number {
    return getGoalSettings(db)?.weekStartDow === 0 ? 0 : 1;
  }

  function payload(): Record<string, unknown> {
    const dow = weekStartDow();
    // 「开新周期的起点」永远是下一个**完整**周（+7）—— 残缺周不进周期（V12）。
    const nextStart = nextWeekStart(todayLocal(), dow);
    // 「本周期该排哪一周」—— 本周还剩训练日就是本周（残缺周 = 起始周 Week 0）。
    const planWeek = currentPlanningWeekStart(db);
    const cycle = getActiveCycle(db);
    if (!cycle) {
      return {
        cycle: null,
        week_no: null,
        is_deload: false,
        expired: false,
        plan_week: { week_no: null, in_cycle: false, is_deload: false, expired: false, is_starter_week: false },
        next_week_start: nextStart,
        plan_week_start: planWeek,
      };
    }
    const thisWeek = currentWeekStart(todayLocal(), dow);
    const status = cycleStatusFor(db, thisWeek);
    // 🔴 **计划周**在周期里的位置，与上面那组「今天所在周」分开报。
    //
    // 首页整页讲的是**计划周**（`currentPlanningWeekStart`），而周期通常从下一个完整周开始。
    // 当计划周落在周期开始**之前**（用户本周就想练 = 起始周），`week_no` 会是 null ——
    // 这正是 V12 的预期语义：**起始周不占周次**，用户不会看到「练完残缺周，下周还是第 1 周」
    // 的错觉。此时用 `is_starter_week` 明确告诉前端「这不是 bug，这是起始周」。
    const planStatus = cycleStatusFor(db, planWeek);
    const isStarterWeek = planStatus.weekNo === null && planWeek < cycle.firstWeekStart && !planStatus.expired;
    return {
      cycle,
      // 「今天所在周」的周次（保留原语义，供非「计划周」视角使用）
      week_no: status.weekNo,
      is_deload: status.isDeload,
      expired: isCycleExpired(cycle, todayLocal(), dow),
      // 「计划周」的周次 —— 首页展示用这组
      plan_week: {
        week_no: planStatus.weekNo,
        in_cycle: planStatus.weekNo !== null,
        is_deload: planStatus.isDeload,
        // 计划周已越过周期最后一周 = 这个周期该收尾了
        expired: planStatus.expired,
        /** 起始周（残缺周）：本周想练但这周不算周期第 1 周。前端要显式标注，免得用户以为程序出错。 */
        is_starter_week: isStarterWeek,
      },
      next_week_start: nextStart,
      /** 本周期实际该排的那一周（可能是本周 = 起始周）。 */
      plan_week_start: planWeek,
    };
  }

  return async (req, res, pathname) => {
    if (pathname === '/api/cycle') {
      if (req.method === 'GET') {
        sendJson(res, 200, payload());
        return true;
      }
      if (req.method === 'POST') {
        const body = await parseJsonBody(req);
        const raw = body.first_week_start;
        // 🔴 默认起点 = **下一个完整周**（+7），不是本周。
        //    V12：本周如果还剩训练日，那份计划属于「起始周（Week 0）」，**不占周期第 1 周**。
        //    周期必须从完整的那一周才开始计，否则「第 1 周只有两天」会被当成正常渐进周。
        const firstWeekStart = typeof raw === 'string' && raw !== '' ? raw : nextWeekStart(todayLocal(), weekStartDow());
        const cycle = translate(() => openCycle(db, { goal_text: body.goal_text, first_week_start: firstWeekStart }));
        sendJson(res, 201, { cycle, ...payload() });
        return true;
      }
      throw new HttpError(405, `/api/cycle 不支持 ${req.method}`);
    }

    if (pathname === '/api/cycle/goal') {
      if (req.method !== 'PUT') throw new HttpError(405, `/api/cycle/goal 不支持 ${req.method}`);
      const body = await parseJsonBody(req);
      translate(() => forceEditCycleGoal(db, { goal_text: body.goal_text }));
      sendJson(res, 200, payload());
      return true;
    }

    if (pathname === '/api/cycle/close') {
      if (req.method !== 'POST') throw new HttpError(405, `/api/cycle/close 不支持 ${req.method}`);
      const closed = closeActiveCycle(db);
      if (!closed) throw new HttpError(404, '当前没有进行中的周期');
      // 周期末产出一份**画像版本**（用户看到的画像一个周期只变一次）。
      // 🔴 快照失败绝不能影响「关周期」本身：关周期已提交，这里只把结果/原因附在响应里，
      //    绝不让异常穿出去把 200 变成 500（否则用户会因为画像算不出来以为周期没关掉）。
      //    没有训练数据时跳过（不是错误，是「还没得可画」）。
      let snapshot: SnapshotMeta | null = null;
      let snapshotError: string | null = null;
      try {
        if (!hasTrainingData(db)) {
          snapshotError = '暂无训练数据 —— 先同步训记或导入历史数据，再生成画像';
        } else {
          snapshot = createSnapshot(db);
        }
      } catch (e) {
        snapshotError = (e as Error).message ?? String(e);
      }
      sendJson(res, 200, { closed, snapshot, snapshot_error: snapshotError, ...payload() });
      return true;
    }

    return false;
  };
}
