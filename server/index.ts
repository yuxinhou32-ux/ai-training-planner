/**
 * HTTP 服务入口（§2.3 server/index.ts）。
 *
 * 用法：npm run server → node dist/server/index.js
 * 端口：8787（vite dev proxy 5173 → 8787，§2.3）。
 */
import { pathToFileURL, fileURLToPath } from 'node:url';
import path from 'node:path';
import { openDatabase, closeDatabase } from './db/index.js';
import { migrate } from './db/migrate.js';
import { loadConfig } from './config/index.js';
import { loadEnvFile } from './config/env.js';
import { createAiGateway } from './ai/gateway.js';
import { createAiRuntime, envPathOf } from './ai/aiConfig.js';
import { XunjiHttpClient } from './xunji/client.js';
import { createApp } from './app.js';
import { SyncEngine } from './ingest/syncEngine.js';
import { JobRunner } from './jobs/runner.js';
import { hasCompletedFullSync, runStartupTasks } from './jobs/startup.js';
import type { JobsRouteDeps } from './api/routes/jobs.js';
import type { WriteRouteDeps } from './api/routes/write.js';

/** npm run analyze 等场景以 `node dist/xxx.js` 直跑；判断是否为主模块再启动。 */
export function isMainModule(): boolean {
  return import.meta.url === pathToFileURL(process.argv[1] ?? '').href;
}

export function startServer(): void {
  // 🔴 必须先加载 .env（T5 冒烟实测发现的潜伏 bug：T2 起服务端从未加载过 .env，
  // 导致同步引擎 / 写回客户端 / AI http 配置在服务进程里全部为空，同步与写回路由静默 503）。
  loadEnvFile(process.cwd());
  const cfg = loadConfig();
  const db = openDatabase(cfg.dbPath);
  const mig = migrate(db);
  console.log(`[migrate] version=${mig.currentVersion} applied=${mig.applied}`);

  const webRoot = fileURLToPath(new URL('../../dist/web/', import.meta.url));

  // AI 网关：prompt 目录按 cwd 解析（npm run server 从项目根运行）
  // 🔴 runtime.http 是同一个对象引用，一路传进 gateway：设置页保存配置时 mutate 它即热更新（V4）
  const aiRuntime = createAiRuntime(cfg);
  const aiModelTag = aiRuntime.tag();
  const gw = createAiGateway(db, {
    promptsDir: path.resolve(process.cwd(), 'server/ai/prompts'),
    maxAttempts: 3,
    http: aiRuntime.http,
  });

  // 写回客户端（T4）：有 Key 才装配；无 Key 时写回路由整体 503（approve/preview/confirm 不可用）。
  // 🔴 这个对象**永远是同一份**（不再可能是 null）：设置页换 Key 时只改它里面的 `deps`，
  //    路由每次请求读的都是这个引用，所以能热更新（见下方 onXunjiApplied）。
  const writeDeps: WriteRouteDeps = {
    deps: cfg.apiKey
      ? {
          client: new XunjiHttpClient({ baseUrl: cfg.xunjiBaseUrl, apiKey: cfg.apiKey, timeoutMs: cfg.httpTimeoutMs }),
          dbPath: cfg.dbPath,
        }
      : null,
  };

  // 任务编排（同步引擎 / runner / 开机同步）；v2 已无定时调度器
  const syncEngine = cfg.apiKey
    ? new SyncEngine({
        db,
        client: new XunjiHttpClient({ baseUrl: cfg.xunjiBaseUrl, apiKey: cfg.apiKey, timeoutMs: cfg.httpTimeoutMs }),
      })
    : null;
  const runner = new JobRunner(db, {
    db,
    dbPath: cfg.dbPath,
    engine: syncEngine,
    gw,
    aiModelTag,
  });

  const opsDeps: JobsRouteDeps = { runner };

  // 🔴 共享可变对象（V4 热更新）：设置页保存 AI 配置后，把审计标签同步到这两个引用上。
  //    gateway 本身不用重建 —— 它读的是 aiRuntime.http 那个对象引用。
  const planAi = { gw, aiModelTag };
  const runnerDeps = runner.depsRef;
  const onAiApplied = (tag: string): void => {
    planAi.aiModelTag = tag;
    runnerDeps.aiModelTag = tag;
    console.log(`[ai] 配置已更新并生效 | AI: ${tag}`);
  };

  const envPath = envPathOf(process.cwd());

  /**
   * 训记 Key 变更后的热更新。
   *
   * 🔴 与 AI 配置的差别：AI 那边是个可变 runtime（改字段即可），而同步引擎与写回客户端
   *    都是**启动时装配的对象实例**，改不了里面的 Key —— 只能整个重建、再换掉活引用。
   *    两者都换掉之后，同步与写回**不用重启服务**即可生效。
   */
  const onXunjiApplied = (key: string | null): void => {
    const client =
      key === null
        ? null
        : new XunjiHttpClient({ baseUrl: cfg.xunjiBaseUrl, apiKey: key, timeoutMs: cfg.httpTimeoutMs });
    writeDeps.deps = client === null ? null : { client, dbPath: cfg.dbPath };
    runnerDeps.engine = client === null ? null : new SyncEngine({ db, client });
    console.log(`[xunji] 接入配置已更新并生效 | 同步与写回：${client === null ? '未装配' : '已装配'}`);

    // 🔴 新用户是「先开机、后填 Key」的：开机时没 Key，开机同步整个被跳过。
    //    如果这里不补一次，他就永远只走增量 —— 26 周窗口的前 25 周没人拉，
    //    「第一次使用会自动整段导入」也就成了假话。所以填完 Key 且从未成功全量过 → 立刻全量。
    //    注意顺序：必须先装上 engine 再入队，否则 handler 会因未装配而失败。
    if (client !== null && !hasCompletedFullSync(db)) {
      void runner
        .enqueue('sync_full', 'auto')
        .then((out) => console.log(`[xunji] 首次导入（自动全量）${out.status}${out.detail ? ` · ${out.detail}` : ''}`))
        .catch((e: unknown) => console.error(`[xunji] 首次导入异常：${(e as Error).message}`));
    }
  };

  const app = createApp(
    db,
    webRoot,
    planAi,
    writeDeps,
    opsDeps,
    { runtime: aiRuntime, envPath, onApplied: onAiApplied },
    {
      envPath,
      currentKey: () => {
        const k = process.env.XUNJI_API_KEY;
        return typeof k === 'string' && k.trim() !== '' ? k.trim() : null;
      },
      onApplied: onXunjiApplied,
    },
  );
  const PORT = Number(process.env.ATP_PORT ?? 8787);
  app.listen(PORT, '127.0.0.1', () => {
    console.log(`[server] http://127.0.0.1:${PORT}（静态资源目录 ${webRoot}）`);
    console.log(
      `[server] AI: ${aiRuntime.tag()}${aiRuntime.view().ready ? '' : `（${aiRuntime.view().blocked_reason}）`} | API: GET /api/analysis/latest | POST /api/analysis/refresh | ` +
        'GET /api/catalog/* | GET|PUT /api/goal | GET|POST /api/cycle | PUT /api/cycle/goal | GET|PUT /api/ai/config | GET|PUT /api/xunji/config | GET /api/plans/current | GET /api/plans/:id | POST /api/plans/generate | POST /api/plans/regenerate-template | PATCH|DELETE /api/plans/:id/exercises/:eid | POST /api/plans/:id/days/:dayId/move | ' +
        `POST /api/plans/:id/approve | POST /api/plans/:id/write/(preview|confirm) | ` +
        `GET /api/jobs/recent | POST /api/jobs/trigger | ` +
        `GET /api/reviews/week | PUT /api/reviews/note | POST /api/reviews/weekly | ` +
        `GET|PUT /api/body | GET /api/profile | GET|PUT /api/week-note | ` +
        `写回${writeDeps.deps ? '已装配' : '未装配：缺 Key'} | 同步${runnerDeps.engine ? '已装配' : '未装配：缺 Key'}`,
    );

    // 启动编排：复位遗留 running（进程内任务跨重启无效）→ 归档过期草稿 → 恢复中断写入 → 开机同步一次
    const rep = runStartupTasks(db, runner, { syncOnStartup: syncEngine !== null });
    console.log(
      `[startup] 复位 ${rep.cancelled} 个遗留 running · 归档 ${rep.archived} 份过期草稿 · ` +
        `恢复 ${rep.stuckWrites} 个中断的写入计划 · ` +
        `清理报告 adhoc ${rep.pruned.adhocDeleted} / snapshot ${rep.pruned.snapshotDeleted} · ` +
        `引导豁免 ${rep.onboardingSeeded ? '已补种' : '无'} · ${
          rep.syncJobType !== null ? `已排队开机同步（${rep.syncJobType}）` : '未配置 Key，跳过开机同步'
        }`,
    );
  });

  const shutdown = (): void => {
    console.log('[server] shutting down');
    app.close(() => {
      closeDatabase(db);
      process.exit(0);
    });
    // 静态连接挂起时 2s 后强制退出
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (isMainModule()) startServer();
