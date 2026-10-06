#!/usr/bin/env node
/**
 * 训记同步 CLI（T1）。
 *
 * 用法：
 *   node dist/sync.js --days 90            # 全量回溯最近 90 天（默认）
 *   node dist/sync.js --incremental        # 增量：上次成功水位之后 + 失败日期
 *   node dist/sync.js --retry-failed       # 仅重试 failed 日期
 *   node dist/sync.js --date 2026-09-14    # 单日重拉（force）
 *   node dist/sync.js --days 90 --force    # 忽略新鲜度强制重拉
 *
 * 选项：
 *   --db PATH            数据库路径（默认 data/app.db，或 ATP_DB_PATH）
 *   --concurrency N      并发度 1~4（默认 2）
 *   --timeout-ms N       单次 HTTP 超时（默认 20000）
 *   --quiet              只输出 warn/error
 *   --help
 *
 * 环境变量：
 *   XUNJI_API_KEY        必填（从 .env 读取；绝不打印、绝不落库）
 *
 * 中断语义：Ctrl-C 第一次 → 完成当前日期后优雅停止（job_run=paused，已完成的日期
 * 保留）；再按一次 → 立即退出。重启后重跑同一命令即从断点继续（done 自动跳过）。
 */
import { loadEnvFile } from './server/config/env.js';
import { loadConfig } from './server/config/index.js';
import { closeDatabase, openDatabase } from './server/db/index.js';
import { migrate } from './server/db/migrate.js';
import { NotificationRepo } from './server/repo/notificationRepo.js';
import { JobRepo } from './server/repo/jobRepo.js';
import { SyncEngine } from './server/ingest/syncEngine.js';
import { XunjiHttpClient } from './server/xunji/client.js';
import { createConsoleLogger } from './server/shared/logger.js';
import { isValidDateStr } from './server/util/dates.js';

interface CliArgs {
  days: number;
  incremental: boolean;
  retryFailed: boolean;
  date: string | null;
  force: boolean;
  dbPath: string | null;
  concurrency: number | null;
  timeoutMs: number | null;
  quiet: boolean;
  help: boolean;
}

const HELP = `
训记同步 CLI（T1）

用法:
  node dist/sync.js [选项]

模式（互斥，默认 --days 90）:
  --days=N            全量回溯最近 N 天（1~365，默认 90）
  --incremental       增量：上次成功水位之后 + 失败日期
  --retry-failed      仅重试 failed 日期
  --date=YYYY-MM-DD   单日重拉（force 语义）

选项:
  --force             忽略新鲜度判定，强制重拉
  --db=PATH           SQLite 路径（默认 data/app.db；可用 ATP_DB_PATH 覆盖）
  --concurrency=N     并发度 1~4（默认 2；触发限频会自动减半）
  --timeout-ms=N      单次 HTTP 超时（默认 20000）
  --quiet             只输出 warn/error
  -h, --help          显示本帮助

环境变量:
  XUNJI_API_KEY       训记 API Key（.env 提供；绝不打印/落库）

中断: Ctrl-C 第一次优雅停止（当前日期完成后），重启续传；再按一次立即退出。
`;

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    days: 90,
    incremental: false,
    retryFailed: false,
    date: null,
    force: false,
    dbPath: null,
    concurrency: null,
    timeoutMs: null,
    quiet: false,
    help: false,
  };
  for (const raw of argv) {
    const arg = raw.replace(/^--/, '');
    const eq = arg.indexOf('=');
    const key = (eq >= 0 ? arg.slice(0, eq) : arg).toLowerCase();
    const val = eq >= 0 ? arg.slice(eq + 1) : undefined;
    switch (key) {
      case 'days':
        args.days = Math.max(1, Math.min(365, Number(val ?? 90) || 90));
        break;
      case 'incremental':
        args.incremental = true;
        break;
      case 'retry-failed':
        args.retryFailed = true;
        break;
      case 'date':
        args.date = val ?? null;
        break;
      case 'force':
        args.force = true;
        break;
      case 'db':
        args.dbPath = val ?? null;
        break;
      case 'concurrency':
        args.concurrency = Math.max(1, Math.min(4, Number(val ?? 2) || 2));
        break;
      case 'timeout-ms':
        args.timeoutMs = Math.max(1000, Number(val ?? 20000) || 20000);
        break;
      case 'quiet':
        args.quiet = true;
        break;
      case 'h':
      case 'help':
        args.help = true;
        break;
      default:
        throw new Error(`未知参数：--${key}（--help 查看用法）`);
    }
  }
  const modes = [args.incremental, args.retryFailed, args.date !== null].filter(Boolean).length;
  if (modes > 1) throw new Error('--incremental / --retry-failed / --date 互斥');
  return args;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(HELP);
    return 0;
  }

  const logger = createConsoleLogger(args.quiet ? 'warn' : 'info');
  loadEnvFile(process.cwd());
  const config = loadConfig(undefined, process.cwd());

  if (args.dbPath !== null) config.dbPath = args.dbPath;
  if (args.concurrency !== null) config.syncConcurrency = args.concurrency;
  if (args.timeoutMs !== null) config.httpTimeoutMs = args.timeoutMs;

  if (config.apiKey === null) {
    logger.error('未配置训记 API Key：请在项目根目录 .env 中设置 XUNJI_API_KEY（参考 .env.example）');
    return 2;
  }

  if (args.date !== null && !isValidDateStr(args.date)) {
    logger.error(`--date 需为合法的 YYYY-MM-DD，收到：${String(args.date)}`);
    return 2;
  }

  // 断点续传前置：复位上次中断遗留的 running 任务与 fetching 悬挂状态（§6.2.3）
  const db = openDatabase(config.dbPath);
  const mig = migrate(db);
  if (mig.applied > 0) logger.info(`数据库迁移：应用 ${mig.applied} 个版本，当前 v${mig.currentVersion}`);
  const jobs = new JobRepo(db);
  const cancelled = jobs.cancelRunning(['sync_full', 'sync_incremental', 'sync_retry']);
  if (cancelled > 0) {
    logger.warn(`发现 ${cancelled} 个上次中断遗留的 running 任务，已标记 cancelled`);
    new NotificationRepo(db).add(
      'info',
      '已复位上次中断的同步任务',
      `检测到 ${cancelled} 个 running 任务未正常收尾（多为进程被杀），已标记 cancelled 并可续传。`,
      'sync',
      'startup',
    );
  }

  const client = new XunjiHttpClient({
    baseUrl: config.xunjiBaseUrl,
    apiKey: config.apiKey, // 只进内存与 Authorization 头，绝不写日志/数据库
    timeoutMs: config.httpTimeoutMs,
  });

  let stopRequested = false;
  let forceExit = false;
  const engine = new SyncEngine({
    db,
    client,
    concurrency: config.syncConcurrency,
    logger,
    shouldStop: () => stopRequested || forceExit,
    onProgress: (p) => {
      const donePart = p.fetched + p.empty + p.failed;
      const eta = p.etaSeconds !== null ? `，预计剩余 ${p.etaSeconds}s` : '';
      logger.info(`进度 ${donePart}/${p.total}（成功 ${p.fetched}，空 ${p.empty}，失败 ${p.failed}，跳过 ${p.skipped}）${eta} 当前: ${p.current ?? '-'} | 并发 ${engine.currentConcurrency}`);
    },
  });

  process.on('SIGINT', () => {
    if (forceExit) {
      logger.error('强制退出（当天事务由 SQLite 保证原子性，重启续传即可）');
      process.exit(130);
    }
    if (stopRequested) {
      forceExit = true;
      return;
    }
    stopRequested = true;
    logger.warn('收到中断信号：完成当前日期后停止（再按一次 Ctrl-C 立即退出）');
  });

  try {
    let summary;
    if (args.incremental) {
      logger.info('增量同步：上次成功水位之后 + 失败日期');
      summary = await engine.runIncremental();
    } else if (args.retryFailed) {
      logger.info('重试 failed 日期');
      summary = await engine.runRetryFailed();
    } else if (args.date !== null) {
      logger.info(`单日重拉：${args.date}`);
      summary = await engine.runSingle(args.date);
    } else {
      logger.info(`全量同步：最近 ${args.days} 天（并发 ${config.syncConcurrency}）`);
      summary = await engine.runFull(args.days, { force: args.force });
    }

    const dur = ((summary.finishedAtMs - summary.startedAtMs) / 1000).toFixed(1);
    logger.info(
      `同步结束：${summary.status.toUpperCase()} | 总 ${summary.total} | 成功 ${summary.fetched} | 空 ${summary.empty} | ` +
        `失败 ${summary.failed} | 跳过 ${summary.skipped} | 限频 ${summary.rateLimitHits} 次 | ` +
        `降并发 ${summary.degradeEvents} 次 | 最终并发 ${summary.finalConcurrency} | 耗时 ${dur}s | job_run #${summary.jobRunId}`,
    );
    if (summary.failedDates.length > 0) {
      logger.warn('失败日期明细:');
      for (const f of summary.failedDates) {
        logger.warn(`  ${f.datestr} [${f.code}] ${f.message}`);
      }
      logger.warn('可用 `node dist/sync.js --retry-failed` 单独重试');
    }
    if (summary.status === 'paused') {
      logger.warn('同步被中断：重跑同一命令将从断点继续（已成功日期不会重拉）');
      return 130;
    }
    return summary.status === 'success' ? 0 : 1;
  } catch (e) {
    logger.error(`同步异常终止：${(e as Error).message}`);
    return 3;
  } finally {
    closeDatabase(db);
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((e) => {
    console.error(`[sync] 未捕获异常：${(e as Error)?.stack ?? String(e)}`);
    process.exitCode = 1;
  });
