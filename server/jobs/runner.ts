/**
 * JobRunner（T5）：进程内串行任务执行器。
 *
 * 设计（§7.4 简化实现）：
 *  - 单队列串行（同步 → 分析 → 计划的依赖顺序天然要求串行；个人系统无并发诉求）；
 *  - 等待队列只存内存（queued 记录不落 job_run）：进程崩溃丢队列无损——
 *    catchup 在下次启动按「最近应触发时刻」幂等补跑，已成功的不会重跑；
 *  - job_run 仍完整落库（T1 语义）：sync 类由 SyncEngine 自建，其余 runner 建；
 *  - 同一时刻只允许 1 个 running（串行队列天然保证）；
 *  - 完成时写 notification：failed→error、partial→warn、success 一般不通知
 *    （plan_draft/review 的业务通知在 handler 内加）。
 */
import type { Db } from '../db/index.js';
import { JobRepo, type JobType, type TriggeredBy } from '../repo/jobRepo.js';
import { NotificationRepo } from '../repo/notificationRepo.js';
import { JOB_HANDLER_DEFS, type JobDeps, type JobHandlerDef } from './handlers.js';

interface QueuedJob {
  jobType: JobType;
  triggeredBy: TriggeredBy;
  /** 补跑/定时触发时的应触发时刻（审计用）。 */
  scheduledAt: string | null;
  resolve: (r: RunnerOutcome) => void;
}

export interface RunnerOutcome {
  jobRunId: number | null;
  status: 'success' | 'partial' | 'failed';
  detail?: string;
}

export class JobRunner {
  private readonly db: Db;
  private readonly deps: JobDeps;
  private readonly jobs: JobRepo;
  private readonly notifications: NotificationRepo;
  private queue: QueuedJob[] = [];
  private running = false;
  /** 进程内互斥标记（跨进程不防护——个人单实例部署）。 */
  private runningType: JobType | null = null;

  constructor(db: Db, deps: JobDeps) {
    this.db = db;
    this.deps = deps;
    this.jobs = new JobRepo(db);
    this.notifications = new NotificationRepo(db);
  }

  /** 排队执行。返回 Promise 在该任务执行完时 resolve。同类型已在跑/排队 → 立即合并返回。 */
  enqueue(jobType: JobType, triggeredBy: TriggeredBy, scheduledAt: string | null = null): Promise<RunnerOutcome> {
    const dup = this.runningType === jobType || this.queue.some((q) => q.jobType === jobType);
    if (dup) {
      return Promise.resolve({ jobRunId: null, status: 'success', detail: '同类型任务已在执行/排队中，本次合并跳过' });
    }
    return new Promise<RunnerOutcome>((resolve) => {
      this.queue.push({ jobType, triggeredBy, scheduledAt, resolve });
      void this.drain();
    });
  }

  /** 当前是否有任务在跑（UI 显示用）。 */
  get busy(): boolean {
    return this.running;
  }

  /**
   * 依赖对象的**引用**（V4 热更新用）。
   * handler 每次执行时从 `this.deps` 读取，所以外部 mutate 这个对象就能改变
   * 后续任务用到的 AI 审计标签，不必重建 runner。
   */
  get depsRef(): JobDeps {
    return this.deps;
  }

  get currentJobType(): JobType | null {
    return this.runningType;
  }

  /** 待执行数量（不含正在跑的）。 */
  get pendingCount(): number {
    return this.queue.length;
  }

  private async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (this.queue.length > 0) {
        const item = this.queue.shift();
        if (item === undefined) break;
        item.resolve(await this.runOne(item.jobType, item.triggeredBy, item.scheduledAt));
      }
    } finally {
      this.running = false;
      this.runningType = null;
    }
  }

  private async runOne(jobType: JobType, triggeredBy: TriggeredBy, scheduledAt: string | null): Promise<RunnerOutcome> {
    const def: JobHandlerDef | undefined = JOB_HANDLER_DEFS[jobType];
    if (def === undefined) {
      return { jobRunId: null, status: 'failed', detail: `未知任务类型：${jobType}` };
    }
    this.runningType = jobType;
    const startMs = Date.now();

    // ownsJobRun=true（sync 类）：job_run 由引擎自建，handler 返回 ownJobRunId
    const jobRunId = def.ownsJobRun ? -1 : this.jobs.create(jobType, triggeredBy, { scheduled_at: scheduledAt }, startMs);

    try {
      const out = await def.handler(this.deps, triggeredBy);
      const finalId = out.ownJobRunId ?? jobRunId;
      if (!def.ownsJobRun) {
        this.jobs.finish(finalId, out.status, out.status === 'failed' ? out.detail ?? '任务失败' : null, Date.now(), out.resultRef ?? null);
      }
      if (out.status === 'failed') {
        this.notifications.add('error', `${def.label}失败`, out.detail ?? null, 'job_run', String(finalId));
      } else if (out.status === 'partial') {
        this.notifications.add('warn', `${def.label}部分完成`, out.detail ?? null, 'job_run', String(finalId));
      }
      return { jobRunId: finalId, status: out.status, detail: out.detail };
    } catch (e) {
      const msg = (e as Error).message ?? String(e);
      if (!def.ownsJobRun) {
        this.jobs.finish(jobRunId, 'failed', msg, Date.now());
      }
      this.notifications.add('error', `${def.label}失败`, msg, 'job_run', String(jobRunId));
      return { jobRunId, status: 'failed', detail: msg };
    }
  }
}
