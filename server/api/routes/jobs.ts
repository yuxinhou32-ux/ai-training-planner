/**
 * 任务编排路由：手动触发、任务历史、通知。
 *
 * GET  /api/jobs/recent          最近任务（含 running 状态）
 * POST /api/jobs/trigger         手动触发（白名单内任务；triggeredBy='manual'）
 * GET  /api/notifications        通知列表（?unread=1 只看未读）
 * POST /api/notifications/read   标记已读（body {ids?: number[]}，空 = 全部）
 *
 * v2：已移除 /api/jobs/schedule 与 /api/automation——不再有定时调度与自动化开关，
 * 所有任务都由页面按钮或开机同步触发。
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Db } from '../../db/index.js';
import { HttpError, sendJson } from '../errors.js';
import { readBody } from './analysis.js';
import { JobRepo, type JobType, type JobRunRow } from '../../repo/jobRepo.js';
import { NotificationRepo } from '../../repo/notificationRepo.js';
import { JOB_HANDLER_DEFS } from '../../jobs/handlers.js';
import type { JobRunner } from '../../jobs/runner.js';

export interface JobsRouteDeps {
  runner: JobRunner;
}

const TRIGGERABLE = new Set(Object.keys(JOB_HANDLER_DEFS));

function jobView(r: JobRunRow): Record<string, unknown> {
  return {
    id: r.id,
    job_type: r.job_type,
    status: r.status,
    triggered_by: r.triggered_by,
    scheduled_at: r.scheduled_at,
    started_at: r.started_at,
    finished_at: r.finished_at,
    progress: r.progress_json === null ? null : safeParse(r.progress_json),
    result_ref: r.result_ref,
    error: r.error_json === null ? null : safeParse(r.error_json),
    label: JOB_HANDLER_DEFS[r.job_type as JobType]?.label ?? r.job_type,
  };
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s) as unknown;
  } catch {
    return null;
  }
}

export function handleJobsRoutes(db: Db, deps: JobsRouteDeps | null): (req: IncomingMessage, res: ServerResponse, pathname: string) => Promise<boolean> {
  const jobs = new JobRepo(db);
  const notifications = new NotificationRepo(db);

  return async (req, res, pathname) => {
    // GET /api/jobs/recent
    if (pathname === '/api/jobs/recent' && req.method === 'GET') {
      sendJson(res, 200, {
        jobs: jobs.listRecent(30).map(jobView),
        runner: { busy: deps?.runner.busy ?? false, job_type: deps?.runner.currentJobType ?? null, pending: deps?.runner.pendingCount ?? 0 },
      });
      return true;
    }

    // POST /api/jobs/trigger
    if (pathname === '/api/jobs/trigger' && req.method === 'POST') {
      if (deps === null) throw new HttpError(503, '任务编排未装配');
      const body = await readBody(req);
      let parsed: unknown;
      try {
        parsed = JSON.parse(body);
      } catch {
        throw new HttpError(400, '请求体不是合法 JSON');
      }
      const jobType = (parsed as { job_type?: unknown })?.job_type;
      if (typeof jobType !== 'string' || !TRIGGERABLE.has(jobType)) {
        throw new HttpError(400, `job_type 需为以下之一：${[...TRIGGERABLE].join(', ')}`);
      }
      void deps.runner.enqueue(jobType as JobType, 'manual');
      sendJson(res, 200, { queued: true, job_type: jobType });
      return true;
    }

    // GET /api/notifications
    if (pathname === '/api/notifications' && req.method === 'GET') {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const unreadOnly = url.searchParams.get('unread') === '1';
      const all = notifications.listRecent(50);
      sendJson(res, 200, {
        notifications: unreadOnly ? all.filter((n) => n.is_read === 0) : all,
        unread: notifications.countUnread(),
      });
      return true;
    }

    // POST /api/notifications/read
    if (pathname === '/api/notifications/read' && req.method === 'POST') {
      const body = await readBody(req);
      let ids: number[] = [];
      try {
        const parsed = JSON.parse(body) as { ids?: unknown };
        if (Array.isArray(parsed.ids)) ids = parsed.ids.map(Number).filter((n) => Number.isInteger(n));
      } catch {
        // 空体 = 全部已读
      }
      sendJson(res, 200, { marked: notifications.markRead(ids) });
      return true;
    }

    if (pathname.startsWith('/api/jobs') || pathname.startsWith('/api/notifications')) {
      throw new HttpError(404, `未知的任务路由：${req.method} ${pathname}`);
    }
    return false;
  };
}
