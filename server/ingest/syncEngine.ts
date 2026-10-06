import {
  FRESHNESS_HISTORICAL_MS,
  FRESHNESS_RECENT_DAYS,
  FRESHNESS_RECENT_MS,
  INCLUDE_FULL_DATA,
  MAX_RETRY_ATTEMPTS,
  SCHEMA_VERSION,
  SYNC_DEFAULT_CONCURRENCY,
} from '../config/constants.js';
import { realClock, isoSeconds, type Clock } from '../util/clock.js';
import { buildDateWindow, shiftDays, todayStr } from '../util/dates.js';
import { sha256Hex } from '../util/json.js';
import { silentLogger, type Logger } from '../shared/logger.js';
import { inTransaction, type Db } from '../db/index.js';
import { JobRepo, type JobType, type TriggeredBy } from '../repo/jobRepo.js';
import { NotificationRepo } from '../repo/notificationRepo.js';
import { RawRepo } from '../repo/rawRepo.js';
import { SettingsRepo } from '../repo/settingsRepo.js';
import { SyncStateRepo, toReaderStateStore } from '../repo/syncStateRepo.js';
import { TrainRepo } from '../repo/trainRepo.js';
import { userMessageOf, XunjiError } from '../xunji/errors.js';
import { backoffMs, resolveRetryMs } from '../xunji/ratelimit.js';
import { XunjiHttpClient } from '../xunji/client.js';
import { XunjiReader } from '../xunji/reader.js';
import type { XunjiLimits } from '../xunji/types.js';
import { parseDay, type ParsedDay } from './parser.js';

/**
 * 同步引擎（T1，§6.2.3）。
 *
 * 四种模式：
 *  - runFull(days)：全量回溯 [today-(days-1), today]，倒序（最近的先拉，中断也有近期数据）；
 *  - runIncremental()：「上次成功水位之后」（水位 = 已同步最大日期；无水位则近 7 天）
 *    + 失败日期重试；
 *  - runRetryFailed()：仅重试 failed 日期；
 *  - runSingle(date)：单日重拉（--force 语义）。
 *
 * 可靠性设计：
 *  - 断点续传：每天独立事务；done/empty 跳过（+新鲜度：近 7 天 6h、历史 30 天）；
 *  - 限频：三源等待（① 响应解析 → ② limits 缓存 → ③ 90s），不消耗重试次数，
 *    自适应降并发（首次 too frequent → 减半 → 1）；
 *  - 网络类错误：指数退避 30s×2^n（上限 300s），至多 5 次；
 *  - 致命错误（Key/VIP）：终止整轮 + notification(error)；
 *  - truncated：落 notification(warn)，原始 JSON 已在 raw_train_raw 留证，不静默丢弃。
 */
export interface SyncProgress {
  total: number;
  fetched: number;
  empty: number;
  failed: number;
  skipped: number;
  current: string | null;
  etaSeconds: number | null;
  message: string;
}

/** 同步触发来源（与 job_run.triggered_by 同口径）。 */
export type SyncTriggeredBy = TriggeredBy;

export interface SyncSummary {
  jobRunId: number;
  jobType: JobType;
  /** success=全部完成；partial=有失败日期；failed=致命错误终止；paused=中断（SIGINT）。 */
  status: 'success' | 'partial' | 'failed' | 'paused';
  total: number;
  fetched: number;
  empty: number;
  failed: number;
  skipped: number;
  rateLimitHits: number;
  degradeEvents: number;
  finalConcurrency: number;
  failedDates: Array<{ datestr: string; code: string; message: string }>;
  startedAtMs: number;
  finishedAtMs: number;
}

export interface SyncEngineOptions {
  db: Db;
  /** HTTP 客户端（测试注入 MockTransport 构造的实例；本引擎不直接联网）。 */
  client: XunjiHttpClient;
  clock?: Clock;
  concurrency?: number;
  /** 首次 too frequent → 并发减半，再次 → 1（§6.2.3，默认开）。 */
  adaptiveDegrade?: boolean;
  logger?: Logger;
  onProgress?: (p: SyncProgress) => void;
  /** 外部停止信号（SIGINT 优雅中断：完成当前日期后停止）。 */
  shouldStop?: () => boolean;
}

const PROGRESS_THROTTLE_MS = 1_000;

export class SyncEngine {
  private readonly db: Db;
  private readonly clock: Clock;
  private readonly logger: Logger;
  private readonly shouldStop: () => boolean;
  private readonly onProgress: ((p: SyncProgress) => void) | null;

  readonly settings: SettingsRepo;
  readonly syncState: SyncStateRepo;
  readonly raw: RawRepo;
  readonly train: TrainRepo;
  readonly jobs: JobRepo;
  readonly notifications: NotificationRepo;
  readonly reader: XunjiReader;

  private limits: XunjiLimits | null;
  private concurrency: number;
  private readonly adaptiveDegrade: boolean;
  private rateLimitHits = 0;
  private degradeEvents = 0;
  private activeWorkers = 0;

  constructor(opts: SyncEngineOptions) {
    this.db = opts.db;
    this.clock = opts.clock ?? realClock;
    this.logger = opts.logger ?? silentLogger;
    this.shouldStop = opts.shouldStop ?? (() => false);
    this.onProgress = opts.onProgress ?? null;
    this.concurrency = Math.max(1, opts.concurrency ?? SYNC_DEFAULT_CONCURRENCY);
    this.adaptiveDegrade = opts.adaptiveDegrade ?? true;

    this.settings = new SettingsRepo(opts.db);
    this.syncState = new SyncStateRepo(opts.db);
    this.raw = new RawRepo(opts.db);
    this.train = new TrainRepo(opts.db);
    this.jobs = new JobRepo(opts.db);
    this.notifications = new NotificationRepo(opts.db);

    // res.limits：启动时读 app_config 缓存，成功响应后刷新（同步引擎运行时优先用它）
    this.limits = this.settings.getLimits();
    this.reader = new XunjiReader({
      client: opts.client,
      limitsProvider: () => this.limits,
      state: toReaderStateStore(this.syncState),
      onLimits: (l) => this.handleLimits(l),
      clock: this.clock,
      logger: this.logger,
    });
  }

  /** 当前生效并发度（自适应降级后变化；测试与 CLI 展示用）。 */
  get currentConcurrency(): number {
    return this.concurrency;
  }

  private handleLimits(limits: XunjiLimits): void {
    this.limits = limits;
    this.settings.saveLimits(limits, this.clock.now());
  }

  /* ------------------ 四种模式 ------------------ */

  /** 全量回溯（§6.2.3：渐进式已取消，直接按天窗口跑完）。 */
  async runFull(days: number, opts: { force?: boolean; triggeredBy?: SyncTriggeredBy } = {}): Promise<SyncSummary> {
    const today = todayStr(this.clock.now());
    const window = buildDateWindow(today, Math.max(1, days));
    const queue = window.slice().reverse(); // 倒序：最近的先拉
    const jobId = this.jobs.create('sync_full', opts.triggeredBy ?? 'manual', { days, force: opts.force === true }, this.clock.now());
    return this.runQueue(queue, jobId, { force: opts.force === true });
  }

  /** 增量：「上次成功水位之后」+ 失败日期（§7.2：近 7 天 + failed 重试的合成语义）。 */
  async runIncremental(opts: { triggeredBy?: SyncTriggeredBy } = {}): Promise<SyncSummary> {
    const today = todayStr(this.clock.now());
    const watermark = this.syncState.maxSyncedDatestr();
    const start = watermark ?? shiftDays(today, -(FRESHNESS_RECENT_DAYS - 1));
    const dates: string[] = [];
    for (let d = start; d <= today; d = shiftDays(d, 1)) {
      dates.push(d);
    }
    const failed = this.syncState.listFailed().map((s) => s.datestr);
    const queue = Array.from(new Set([...dates, ...failed])).sort().reverse();
    const jobId = this.jobs.create('sync_incremental', opts.triggeredBy ?? 'auto', { start, watermark, failed: failed.length }, this.clock.now());
    return this.runQueue(queue, jobId, { force: false });
  }

  /** 仅重试 failed 日期（§7.2 sync_retry）。 */
  async runRetryFailed(opts: { triggeredBy?: SyncTriggeredBy } = {}): Promise<SyncSummary> {
    const queue = this.syncState.listFailed().map((s) => s.datestr).sort().reverse();
    const jobId = this.jobs.create('sync_retry', opts.triggeredBy ?? 'manual', { count: queue.length }, this.clock.now());
    return this.runQueue(queue, jobId, { force: false });
  }

  /** 单日重拉（CLI --date；等价于 force 单天）。 */
  async runSingle(datestr: string): Promise<SyncSummary> {
    const jobId = this.jobs.create('sync_full', 'manual', { single: datestr }, this.clock.now());
    return this.runQueue([datestr], jobId, { force: true });
  }

  /* ------------------ 调度核心 ------------------ */

  private freshnessOk(state: { status: string; last_success_at: string | null }, datestr: string, nowMs: number): boolean {
    if (state.status !== 'done' && state.status !== 'empty') return false;
    if (!state.last_success_at) return false;
    const successMs = Date.parse(state.last_success_at);
    if (!Number.isFinite(successMs)) return false;
    const isRecent = datestr > shiftDays(todayStr(nowMs), -FRESHNESS_RECENT_DAYS);
    const ttl = isRecent ? FRESHNESS_RECENT_MS : FRESHNESS_HISTORICAL_MS;
    return nowMs - successMs < ttl;
  }

  private async runQueue(
    queueInit: string[],
    jobId: number,
    opts: { force: boolean },
  ): Promise<SyncSummary> {
    const startedAtMs = this.clock.now();
    this.rateLimitHits = 0;
    this.degradeEvents = 0;

    // 断点续传前置：复位上次中断遗留的 fetching 悬挂状态（§6.2.3）
    const resetCount = this.syncState.resetFetching();
    if (resetCount > 0) this.logger.info(`复位 ${resetCount} 个悬挂的 fetching 日期为 pending`);

    // 初始过滤：done/empty 且新鲜 → skipped
    const now0 = this.clock.now();
    const queue: string[] = [];
    let skipped = 0;
    for (const d of queueInit) {
      const st = this.syncState.get(d);
      if (!opts.force && st !== null && this.freshnessOk(st, d, now0)) {
        skipped += 1;
      } else {
        this.syncState.ensure(d);
        queue.push(d);
      }
    }

    const progress: SyncProgress = {
      total: queue.length,
      fetched: 0,
      empty: 0,
      failed: 0,
      skipped,
      current: null,
      etaSeconds: null,
      message: skipped > 0 ? `跳过 ${skipped} 个已同步日期` : '开始同步',
    };
    this.jobs.setProgress(jobId, progress);
    this.onProgress?.({ ...progress });

    const failedDates: Array<{ datestr: string; code: string; message: string }> = [];
    let fatalError: XunjiError | null = null;
    let lastPersistMs = 0;

    const persistProgress = (force: boolean, current: string | null): void => {
      const now = this.clock.now();
      progress.current = current;
      progress.message =
        fatalError !== null
          ? `致命错误终止：${fatalError.code}`
          : `完成 ${progress.fetched + progress.empty + progress.failed}/${progress.total}`;
      const completed = progress.fetched + progress.empty + progress.failed;
      progress.etaSeconds =
        completed > 0 && completed < progress.total
          ? Math.round(((now - startedAtMs) / completed) * (progress.total - completed) / 1000)
          : null;
      if (force || now - lastPersistMs >= PROGRESS_THROTTLE_MS) {
        lastPersistMs = now;
        this.jobs.setProgress(jobId, { ...progress });
        this.onProgress?.({ ...progress });
      }
    };

    const worker = async (): Promise<void> => {
      for (;;) {
        if (fatalError !== null) return;
        if (this.shouldStop()) return;
        // 自适应降级：多余 worker 退出
        if (this.activeWorkers > this.concurrency) return;

        const datestr = queue.shift();
        if (datestr === undefined) return;

        const st = this.syncState.get(datestr);
        const now = this.clock.now();

        // 等待限频窗口：未到 next_retry_at → 移队尾；全员等待时统一睡到最早到期
        if (st?.next_retry_at) {
          const retryMs = Date.parse(st.next_retry_at);
          if (Number.isFinite(retryMs) && retryMs > now) {
            queue.push(datestr);
            if (queue.length > 0 && queue.every((d) => this.nextRetryMsOf(d) > this.clock.now())) {
              const minMs = Math.min(...queue.map((d) => this.nextRetryMsOf(d)));
              const wait = Math.max(10, minMs - this.clock.now());
              this.logger.debug(`所有待处理日期都在冷却中，统一等待 ${(wait / 1000).toFixed(1)}s`);
              await this.clock.sleep(wait);
            }
            continue;
          }
        }

        // 重试次数耗尽 → failed 落定
        if ((st?.attempts ?? 0) >= MAX_RETRY_ATTEMPTS) {
          this.syncState.markFailed(datestr, 'RETRY_EXHAUSTED', `重试 ${MAX_RETRY_ATTEMPTS} 次仍失败`);
          progress.failed += 1;
          failedDates.push({ datestr, code: 'RETRY_EXHAUSTED', message: '重试次数耗尽' });
          persistProgress(false, datestr);
          continue;
        }

        try {
          const outcome = await this.processDate(datestr);
          if (outcome === 'fetched') progress.fetched += 1;
          else progress.empty += 1;
        } catch (e) {
          if (e instanceof XunjiError) {
            if (e.kind === 'fatal') {
              // §6.4：不重试，终止整轮 + 通知
              fatalError = e;
              this.syncState.markFailed(datestr, e.code, userMessageOf(e), this.clock.now());
              failedDates.push({ datestr, code: e.code, message: userMessageOf(e) });
              this.notifications.add(
                'error',
                `同步终止：${e.code}`,
                `${userMessageOf(e)}（日期 ${datestr}；整轮同步已终止）`,
                'sync',
                String(jobId),
                this.clock.now(),
              );
              progress.failed += 1;
              persistProgress(true, datestr);
              return;
            }
            if (e.kind === 'ratelimit') {
              // 限频不消耗重试次数；三源等待值已在 reader 合成
              this.rateLimitHits += 1;
              const waitMs = e.retryMs ?? resolveRetryMs(null, this.limits);
              this.syncState.scheduleRateLimitedRetry(datestr, this.clock.now() + waitMs, this.clock.now());
              queue.push(datestr); // 移队尾
              this.logger.warn(
                `${datestr} 被限频，${(waitMs / 1000).toFixed(0)}s 后重试（不消耗重试次数；限频第 ${this.rateLimitHits} 次）`,
              );
              if (this.adaptiveDegrade && this.concurrency > 1) {
                const prev = this.concurrency;
                this.concurrency = Math.max(1, Math.floor(this.concurrency / 2));
                this.degradeEvents += 1;
                this.logger.warn(`自适应降级：并发 ${prev} → ${this.concurrency}`);
              }
              persistProgress(false, datestr);
              continue;
            }
            if (e.kind === 'retryable') {
              const attempts = this.syncState.scheduleBackoffRetry(
                datestr,
                this.clock.now() + backoffMs((st?.attempts ?? 0) + 1),
                this.clock.now(),
              );
              if (attempts >= MAX_RETRY_ATTEMPTS) {
                this.syncState.markFailed(datestr, e.code, e.message, this.clock.now());
                progress.failed += 1;
                failedDates.push({ datestr, code: e.code, message: e.message });
              } else {
                queue.push(datestr);
                this.logger.warn(
                  `${datestr} ${e.code}（第 ${attempts}/${MAX_RETRY_ATTEMPTS} 次），${(backoffMs(attempts) / 1000).toFixed(0)}s 后重试`,
                );
              }
              persistProgress(false, datestr);
              continue;
            }
            // kind === 'failed'：不可重试错误，该天落定失败
            this.syncState.markFailed(datestr, e.code, e.message, this.clock.now());
            progress.failed += 1;
            failedDates.push({ datestr, code: e.code, message: e.message });
            persistProgress(false, datestr);
            continue;
          }
          // 非预期异常（编程错误）：如实上抛，由 runQueue 捕获后整轮 failed
          throw e;
        }
        persistProgress(false, datestr);
      }
    };

    this.activeWorkers = 0;
    if (queue.length > 0) {
      const workerCount = Math.max(1, Math.min(this.concurrency, queue.length));
      const runners: Array<Promise<void>> = [];
      for (let i = 0; i < workerCount; i++) {
        runners.push(
          (async () => {
            this.activeWorkers += 1;
            try {
              await worker();
            } finally {
              this.activeWorkers -= 1;
            }
          })(),
        );
      }
      try {
        await Promise.all(runners);
      } catch (e) {
        // 非预期异常：整轮失败（worker 内已分类的错误不会走到这里）
        this.jobs.finish(jobId, 'failed', { error: (e as Error).message, phase: 'unexpected' }, this.clock.now());
        throw e;
      }
    }

    const finishedAtMs = this.clock.now();
    let status: SyncSummary['status'];
    if (fatalError !== null) status = 'failed';
    else if (this.shouldStop() && progress.fetched + progress.empty + progress.failed < progress.total) status = 'paused';
    else if (progress.failed > 0) status = 'partial';
    else status = 'success';

    this.jobs.finish(
      jobId,
      status,
      {
        failedDates,
        rateLimitHits: this.rateLimitHits,
        degradeEvents: this.degradeEvents,
        finalConcurrency: this.concurrency,
        interrupted: status === 'paused',
      },
      finishedAtMs,
    );
    persistProgress(true, null);

    return {
      jobRunId: jobId,
      jobType: this.jobs.get(jobId)?.job_type as JobType,
      status,
      total: progress.total,
      fetched: progress.fetched,
      empty: progress.empty,
      failed: progress.failed,
      skipped: progress.skipped,
      rateLimitHits: this.rateLimitHits,
      degradeEvents: this.degradeEvents,
      finalConcurrency: this.concurrency,
      failedDates,
      startedAtMs,
      finishedAtMs,
    };
  }

  private nextRetryMsOf(datestr: string): number {
    const st = this.syncState.get(datestr);
    if (!st?.next_retry_at) return 0;
    const ms = Date.parse(st.next_retry_at);
    return Number.isFinite(ms) ? ms : 0;
  }

  /**
   * 处理单个日期（成功路径）。返回 'fetched'（有训练）| 'empty'（无训练）。
   * 失败以 XunjiError 抛出，交由 worker 分类。
   */
  private async processDate(datestr: string): Promise<'fetched' | 'empty'> {
    this.syncState.setStatus(datestr, 'fetching', this.clock.now());

    const result = await this.reader.fetchDay(datestr);
    const parsed: ParsedDay = parseDay(datestr, result.res);
    const payloadHash = sha256Hex(result.payloadText);

    await inTransaction(this.db, () => {
      // 1) 原始快照层：每次成功读取追加一行（历史可回溯，UNIQUE(datestr, fetched_at)）
      const rawId = this.raw.insert({
        datestr,
        fetchedAtMs: result.fetchedAtMs,
        // 与 client.buildReadBody 完全一致（§7.1 审计；不含任何鉴权信息）
        requestJson: JSON.stringify({
          schema_version: SCHEMA_VERSION,
          datestr,
          include_full_data: INCLUDE_FULL_DATA,
        }),
        payloadJson: result.payloadText,
        payloadHash,
        httpStatus: result.httpStatus,
        ok: true,
        errorCode: null,
        errorMsg: null,
      });

      // 2) 结构化层：内容哈希与上次一致 → 跳过重写（§6.2.3「内容」判定，省 IO）
      const prev = this.syncState.get(datestr);
      if (prev?.content_hash !== payloadHash) {
        this.train.upsertDay(parsed, { rawId, syncedAtMs: this.clock.now() });
      }

      // 3) 状态层：done | empty（单天事务在此提交 —— 断点续传的最小单位）
      if (parsed.counts.trains === 0) {
        this.syncState.markEmpty(datestr, payloadHash, this.clock.now());
      } else {
        this.syncState.markDone(datestr, payloadHash, parsed.counts.trains, this.clock.now());
      }

      // 4) 数据质量告警：truncated 不静默丢弃（§6.2.4 / §6.4）
      for (const w of parsed.warnings) {
        this.notifications.add('warn', `${datestr} 数据质量告警`, w, 'sync', datestr, this.clock.now());
      }
      if (parsed.truncated) {
        this.notifications.add(
          'warn',
          `${datestr} 数据被服务端截断`,
          `截断来源：${parsed.truncatedSources.join('；')}。分析结论可能偏低；原始 JSON 已在 raw_train_raw 留证。`,
          'sync',
          datestr,
          this.clock.now(),
        );
      }
    });

    return parsed.counts.trains === 0 ? 'empty' : 'fetched';
  }
}
