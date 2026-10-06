/**
 * HTTP 应用（§2.3 server/app.ts）。
 *
 * 零框架：node:http + 极简路由分发。T1~T2 的 API 面（分析/目录）都很小，
 * 引入 Express/Fastify 属于过度设计；SSE（§8.4 /api/jobs/:id/stream）留 T5。
 *
 * 职责：
 *  1. /api/* → 各路由模块（未匹配 → 404 JSON）
 *  2. 其余 → 静态托管 vite build 产物（dist/web；SPA fallback 到 index.html）
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import type { Db } from './db/index.js';
import { sendError, HttpError } from './api/errors.js';
import { handleAnalysisRoutes } from './api/routes/analysis.js';
import { handleCatalogRoutes } from './api/routes/catalog.js';
import { handleGoalRoutes } from './api/routes/goal.js';
import { handleCycleRoutes } from './api/routes/cycle.js';
import { handlePlanRoutes, type PlanAiDeps } from './api/routes/plan.js';
import { handleWriteRoutes, type WriteRouteDeps } from './api/routes/write.js';
import { handleJobsRoutes, type JobsRouteDeps } from './api/routes/jobs.js';
import { handleReviewRoutes } from './api/routes/review.js';
import { handleBodyRoutes } from './api/routes/body.js';
import { handleWeekNoteRoutes } from './api/routes/weekNote.js';
import { handleAiRoutes, type AiConfigRouteDeps } from './api/routes/ai.js';
import { handleXunjiRoutes, type XunjiConfigRouteDeps } from './api/routes/xunji.js';
import { handleResetRoutes } from './api/routes/reset.js';
import { handleOnboardingRoutes } from './api/routes/onboarding.js';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

type RouteHandler = (req: IncomingMessage, res: ServerResponse, pathname: string) => Promise<boolean>;

export function createApp(
  db: Db,
  webRoot: string,
  planAi: PlanAiDeps | null = null,
  writeDeps: WriteRouteDeps | null = null,
  opsDeps: JobsRouteDeps | null = null,
  aiConfigDeps: AiConfigRouteDeps | null = null,
  xunjiConfigDeps: XunjiConfigRouteDeps | null = null,
): Server {
  const routes: RouteHandler[] = [
    handleAnalysisRoutes(db),
    handleCatalogRoutes(db),
    // V1：训练基础读写（固定路径 /api/goal，不参与前缀兜底，顺序无敏感依赖）
    handleGoalRoutes(db),
    // V2：训练周期（固定路径 /api/cycle*）
    handleCycleRoutes(db),
    // V9：身体信息 + 用户画像（固定路径 /api/body、/api/profile）
    handleBodyRoutes(db),
    // 计划周特殊情况（固定路径 /api/week-note）—— 排计划输入，与复盘用的 daily_note 分开
    handleWeekNoteRoutes(db),
    // 首次使用引导完成位（固定路径 /api/onboarding）—— 不含业务写入，只读写一个布尔位
    handleOnboardingRoutes(db),
    // V4：AI 配置（固定路径 /api/ai/config）
    ...(aiConfigDeps ? [handleAiRoutes(aiConfigDeps)] : []),
    // 训记接入（固定路径 /api/xunji/config）—— 与 AI 配置同一条安全纪律
    ...(xunjiConfigDeps ? [handleXunjiRoutes(xunjiConfigDeps)] : []),
    // 计划重置（固定路径 /api/reset/*）—— 设置页底部危险区，只删本地表不触网络
    handleResetRoutes(db),
    // 写回路由必须在计划路由之前：plan.ts 对未匹配的 /api/plans/* 有兜底 404，会吞掉 approve/write 路径
    handleWriteRoutes(db, writeDeps),
    handlePlanRoutes(db, planAi),
    // T5：任务编排 + 周复盘（jobs 路由的 404 兜底只认自己的前缀，顺序无敏感依赖）
    handleJobsRoutes(db, opsDeps),
    // 🔴 传 planAi **本身的引用**（不是拷一份字面量）：V4 改 AI 配置时热更新的是
    // planAi.aiModelTag，拷一份就永远停在启动时的值。
    handleReviewRoutes(db, planAi),
  ];

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const pathname = decodeURIComponent(url.pathname);

    if (pathname.startsWith('/api/')) {
      for (const handler of routes) {
        const handled = await handler(req, res, pathname);
        if (handled) return;
      }
      sendError(res, 404, `未知的 API 路由：${req.method} ${pathname}`);
      return;
    }

    // 静态文件（SPA fallback）
    await serveStatic(res, webRoot, pathname);
  }

  return createServer((req, res) => {
    handle(req, res).catch((e: unknown) => {
      if (res.headersSent) {
        res.end();
        return;
      }
      if (e instanceof HttpError) {
        sendError(res, e.status, e.message);
      } else {
        sendError(res, 500, `服务器内部错误：${(e as Error).message}`);
      }
    });
  });
}

async function serveStatic(res: ServerResponse, webRoot: string, pathname: string): Promise<void> {
  const rel = pathname === '/' ? '/index.html' : pathname;
  const file = path.join(webRoot, rel);
  try {
    const st = await stat(file);
    if (st.isFile()) {
      const buf = await readFile(file);
      res.writeHead(200, {
        'content-type': MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
        'content-length': buf.length,
      });
      res.end(buf);
      return;
    }
  } catch {
    // fallthrough → SPA fallback
  }
  // SPA fallback：非文件请求一律回 index.html（前端 hash 路由其实用不到，但直刷路径不 404）
  try {
    const buf = await readFile(path.join(webRoot, 'index.html'));
    res.writeHead(200, { 'content-type': MIME['.html'], 'content-length': buf.length });
    res.end(buf);
  } catch {
    sendError(res, 404, '前端资源未构建（先执行 npm run build:web）');
  }
}
