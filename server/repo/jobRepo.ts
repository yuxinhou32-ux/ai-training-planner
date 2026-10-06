import { isoSeconds } from '../util/clock.js';
import { stableStringify } from '../util/json.js';
import type { Db } from '../db/index.js';
import { prepare, toDb } from '../db/index.js';

export type JobType =
  | 'sync_full'
  | 'sync_incremental'
  | 'sync_retry'
  | 'analysis_refresh'
  | 'plan_draft'
  | 'plan_adjust'
  | 'review_generate'
  | 'db_backup'
  | 'catalog_import'
  | 'report_prune';

/**
 * 已下线但仍留在联合类型里的 job_type（**故意不清理**）：
 *   - `plan_adjust`     —— v2 砍掉 AI 对话调整面板
 *   - `review_generate` —— 2026-09-30 起 4 周周期总结取消，改成每周一次（weekly_review）
 *
 * 留着的原因：`job_run` 表里可能还躺着这两个类型的**历史行或卡住的 running 行**，
 * `cancelRunning` 的默认列表要把它们复位。删类型名只会让旧数据变成脏数据，
 * 收益为零 —— 与 v2 砍除阶段对 `plan.version_no` 的处理同一原则。
 */

export type JobStatus =
  | 'pending'
  | 'running'
  | 'awaiting_agent'
  | 'paused'
  | 'success'
  | 'partial'
  | 'failed'
  | 'cancelled';

export type TriggeredBy = 'auto' | 'manual' | 'catchup' | 'startup';

export interface JobRunRow {
  id: number;
  job_type: string;
  status: string;
  triggered_by: string;
  scheduled_at: string | null;
  started_at: string | null;
  finished_at: string | null;
  progress_json: string | null;
  params_json: string | null;
  result_ref: string | null;
  error_json: string | null;
  awaiting_agent: number;
}

/** job_run 仓库（T1）：同步任务的进度与状态机承载（§7.4 长任务状态机）。 */
export class JobRepo {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  create(jobType: JobType, triggeredBy: TriggeredBy, params: unknown = null, nowMs: number = Date.now()): number {
    const r = prepare(
      this.db,
      `INSERT INTO job_run (job_type, status, triggered_by, scheduled_at, started_at, params_json, awaiting_agent)
       VALUES (?, 'running', ?, ?, ?, ?, 0)`,
    ).run(jobType, triggeredBy, isoSeconds(nowMs), isoSeconds(nowMs), params === null ? null : stableStringify(params));
    return Number(r.lastInsertRowid);
  }

  get(id: number): JobRunRow | null {
    return (
      (prepare(
        this.db,
        `SELECT id, job_type, status, triggered_by, scheduled_at, started_at, finished_at,
                progress_json, params_json, result_ref, error_json, awaiting_agent
         FROM job_run WHERE id = ?`,
      ).get(id) as JobRunRow | undefined) ?? null
    );
  }

  setStatus(id: number, status: JobStatus, nowMs: number = Date.now()): void {
    prepare(this.db, 'UPDATE job_run SET status = ? WHERE id = ?').run(status, id);
    void nowMs;
  }

  /** 进度 JSON（{total, done, failed, current, eta_seconds, message}）。 */
  setProgress(id: number, progress: unknown): void {
    prepare(this.db, 'UPDATE job_run SET progress_json = ? WHERE id = ?').run(
      stableStringify(progress),
      id,
    );
  }

  /** 收尾：终态 + 错误/结果引用。 */
  finish(
    id: number,
    status: Extract<JobStatus, 'success' | 'partial' | 'failed' | 'cancelled' | 'paused'>,
    error: unknown = null,
    nowMs: number = Date.now(),
    resultRef: string | null = null,
  ): void {
    prepare(this.db, 'UPDATE job_run SET status = ?, finished_at = ?, error_json = ?, result_ref = COALESCE(?, result_ref) WHERE id = ?').run(
      status,
      isoSeconds(nowMs),
      error === null ? null : stableStringify(error),
      resultRef,
      id,
    );
  }

  /** 启动复位（§6.2.3 断点续传 + T5：进程重启后进程内任务全部失效）：遗留 running → cancelled。返回复位数量。 */
  cancelRunning(
    jobTypes: string[] = [
      'sync_full',
      'sync_incremental',
      'sync_retry',
      'analysis_refresh',
      'plan_draft',
      'plan_adjust',
      'review_generate',
      'db_backup',
      'catalog_import',
      'report_prune',
    ],
  ): number {
    const placeholders = jobTypes.map(() => '?').join(', ');
    const r = prepare(
      this.db,
      `UPDATE job_run SET status = 'cancelled', finished_at = ?
       WHERE status = 'running' AND job_type IN (${placeholders})`,
    ).run(isoSeconds(Date.now()), ...jobTypes);
    return Number(r.changes);
  }

  listByStatus(status: JobStatus, limit = 100): JobRunRow[] {
    return prepare(
      this.db,
      `SELECT id, job_type, status, triggered_by, scheduled_at, started_at, finished_at,
              progress_json, params_json, result_ref, error_json, awaiting_agent
       FROM job_run WHERE status = ? ORDER BY id DESC LIMIT ?`,
    ).all(status, limit) as unknown as JobRunRow[];
  }

  /** 最近若干条任务（T5 仪表盘「任务历史」用，含全部状态）。 */
  listRecent(limit = 30): JobRunRow[] {
    return prepare(
      this.db,
      `SELECT id, job_type, status, triggered_by, scheduled_at, started_at, finished_at,
              progress_json, params_json, result_ref, error_json, awaiting_agent
       FROM job_run ORDER BY id DESC LIMIT ?`,
    ).all(limit) as unknown as JobRunRow[];
  }

  /** 某任务类型最近一次成功（T5 catchup 漏跑检测用；无则 null）。 */
  lastSuccess(jobType: JobType): JobRunRow | null {
    return (
      (prepare(
        this.db,
        `SELECT id, job_type, status, triggered_by, scheduled_at, started_at, finished_at,
                progress_json, params_json, result_ref, error_json, awaiting_agent
         FROM job_run
         WHERE job_type = ? AND status = 'success' AND finished_at IS NOT NULL
         ORDER BY finished_at DESC, id DESC LIMIT 1`,
      ).get(jobType) as JobRunRow | undefined) ?? null
    );
  }

  /** 该任务类型在 since（ISO 文本）之后是否已有成功记录（补跑幂等闸门）。 */
  existsSuccessAfter(jobType: JobType, sinceIso: string): boolean {
    const row = prepare(
      this.db,
      `SELECT 1 AS hit FROM job_run
       WHERE job_type = ? AND status = 'success' AND finished_at >= ?
       LIMIT 1`,
    ).get(jobType, sinceIso) as { hit: number } | undefined;
    return row !== undefined;
  }
}

export { toDb };
