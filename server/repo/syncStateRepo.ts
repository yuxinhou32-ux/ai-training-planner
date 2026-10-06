import { isoSeconds } from '../util/clock.js';
import type { Db } from '../db/index.js';
import { prepare, toDb } from '../db/index.js';
import { sanitize } from '../shared/logger.js';

export type SyncDateStatus = 'pending' | 'fetching' | 'done' | 'empty' | 'failed' | 'skipped';

export interface SyncDateState {
  datestr: string;
  status: SyncDateStatus;
  attempts: number;
  last_attempt_at: string | null;
  last_success_at: string | null;
  next_retry_at: string | null;
  content_hash: string | null;
  session_count: number;
  error_code: string | null;
  error_msg: string | null;
}

/**
 * sync_date_state 仓库（T1）—— 断点续传的核心。
 *
 * 状态机（§6.2.3）：
 *   pending → fetching → done | empty | failed
 *   failed --(重试调度)--> pending（attempts 增） / 等待 next_retry_at
 *   too frequent → next_retry_at 推进，**不消耗 attempts**（限频不是失败，§6.2.2）
 * 断点续传：每个日期完成后立即落库（单天事务）；重启后 done/empty 自动跳过。
 */
export class SyncStateRepo {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  get(datestr: string): SyncDateState | null {
    return (
      (prepare(
        this.db,
        `SELECT datestr, status, attempts, last_attempt_at, last_success_at, next_retry_at,
                content_hash, session_count, error_code, error_msg
         FROM sync_date_state WHERE datestr = ?`,
      ).get(datestr) as SyncDateState | undefined) ?? null
    );
  }

  /** 幂等初始化（status=pending, attempts=0；已有记录不动）。 */
  ensure(datestr: string): void {
    prepare(this.db, 'INSERT OR IGNORE INTO sync_date_state (datestr, status) VALUES (?, ?)').run(
      datestr,
      'pending',
    );
  }

  setStatus(datestr: string, status: SyncDateStatus, nowMs: number = Date.now()): void {
    this.ensure(datestr);
    if (status === 'fetching') {
      prepare(
        this.db,
        'UPDATE sync_date_state SET status = ?, last_attempt_at = ? WHERE datestr = ?',
      ).run('fetching', isoSeconds(nowMs), datestr);
      return;
    }
    prepare(this.db, 'UPDATE sync_date_state SET status = ? WHERE datestr = ?').run(status, datestr);
  }

  /** 成功完成（有训练）。 */
  markDone(datestr: string, contentHash: string, sessionCount: number, nowMs: number = Date.now()): void {
    prepare(
      this.db,
      `UPDATE sync_date_state SET status = 'done', last_success_at = ?, next_retry_at = NULL,
              content_hash = ?, session_count = ?, error_code = NULL, error_msg = NULL
       WHERE datestr = ?`,
    ).run(isoSeconds(nowMs), contentHash, sessionCount, datestr);
  }

  /** 成功完成（无训练：休息日）。 */
  markEmpty(datestr: string, contentHash: string, nowMs: number = Date.now()): void {
    prepare(
      this.db,
      `UPDATE sync_date_state SET status = 'empty', last_success_at = ?, next_retry_at = NULL,
              content_hash = ?, session_count = 0, error_code = NULL, error_msg = NULL
       WHERE datestr = ?`,
    ).run(isoSeconds(nowMs), contentHash, datestr);
  }

  /** 失败落定（不可重试错误或重试次数耗尽）。 */
  markFailed(
    datestr: string,
    errorCode: string,
    errorMsg: string | null,
    nowMs: number = Date.now(),
  ): void {
    prepare(
      this.db,
      `UPDATE sync_date_state SET status = 'failed', error_code = ?, error_msg = ?
       WHERE datestr = ?`,
    ).run(errorCode, errorMsg === null ? null : sanitize(errorMsg), datestr);
    void nowMs;
  }

  /**
   * 限频重试调度：只推进 next_retry_at，**不消耗 attempts**（§6.2.2）。
   * 同时记录 last_attempt_at（客户端冷却闸门依据）。
   */
  scheduleRateLimitedRetry(datestr: string, nextRetryAtMs: number, nowMs: number = Date.now()): void {
    prepare(
      this.db,
      `UPDATE sync_date_state SET status = 'pending', next_retry_at = ?, last_attempt_at = ?
       WHERE datestr = ?`,
    ).run(isoSeconds(nextRetryAtMs), isoSeconds(nowMs), datestr);
  }

  /**
   * 网络类重试调度：attempts + 1（§6.2.2 退避，消耗重试次数）。
   * 返回更新后的 attempts。
   */
  scheduleBackoffRetry(
    datestr: string,
    nextRetryAtMs: number,
    nowMs: number = Date.now(),
  ): number {
    prepare(
      this.db,
      `UPDATE sync_date_state SET status = 'pending', attempts = attempts + 1,
              next_retry_at = ?, last_attempt_at = ?
       WHERE datestr = ?`,
    ).run(isoSeconds(nextRetryAtMs), isoSeconds(nowMs), datestr);
    const st = this.get(datestr);
    return st ? st.attempts : 0;
  }

  /** 启动复位：把上次中断遗留的 fetching 悬挂状态复位为 pending（§6.2.3）。返回复位数量。 */
  resetFetching(): number {
    const r = prepare(
      this.db,
      "UPDATE sync_date_state SET status = 'pending' WHERE status = 'fetching'",
    ).run();
    return Number(r.changes);
  }

  /**
   * 记录一次请求（客户端冷却闸门依据，§6.2.2「同一天短时间内二次请求」预防）：
   * last_attempt_at = now，next_retry_at = now + 冷却。
   */
  touchAttempt(datestr: string, nextRetryAtMs: number, nowMs: number = Date.now()): void {
    this.ensure(datestr);
    prepare(
      this.db,
      'UPDATE sync_date_state SET last_attempt_at = ?, next_retry_at = ? WHERE datestr = ?',
    ).run(isoSeconds(nowMs), isoSeconds(nextRetryAtMs), datestr);
  }

  listByStatus(status: SyncDateStatus): SyncDateState[] {
    return prepare(
      this.db,
      `SELECT datestr, status, attempts, last_attempt_at, last_success_at, next_retry_at,
              content_hash, session_count, error_code, error_msg
       FROM sync_date_state WHERE status = ? ORDER BY datestr`,
    ).all(status) as unknown as SyncDateState[];
  }

  listFailed(): SyncDateState[] {
    return this.listByStatus('failed');
  }

  /** 增量同步水位：已有成功数据的最大日期（done/empty）。 */
  maxSyncedDatestr(): string | null {
    const row = prepare(
      this.db,
      "SELECT MAX(datestr) AS d FROM sync_date_state WHERE status IN ('done','empty')",
    ).get() as { d: string | null };
    return row?.d ?? null;
  }

  stats(): Record<string, number> {
    const rows = prepare(
      this.db,
      'SELECT status, COUNT(*) AS c FROM sync_date_state GROUP BY status',
    ).all() as Array<{ status: string; c: number }>;
    const out: Record<string, number> = {};
    for (const r of rows) out[r.status] = Number(r.c);
    return out;
  }
}

/** 供 reader 的客户端闸门使用（避免 reader 直接依赖 repo 全量 API）。 */
export interface ReaderStateStore {
  /** 该日期下次允许请求的时间（epoch ms）；无记录返回 null。 */
  getNextRetryAtMs(datestr: string): number | null;
  /** 记录一次请求：last_attempt_at=now，next_retry_at=nextAllowedAtMs。 */
  touchAttempt(datestr: string, nextAllowedAtMs: number, nowMs: number): void;
}

/** SyncStateRepo → ReaderStateStore 适配。 */
export function toReaderStateStore(repo: SyncStateRepo): ReaderStateStore {
  return {
    getNextRetryAtMs(datestr: string): number | null {
      const st = repo.get(datestr);
      if (!st || !st.next_retry_at) return null;
      const ms = Date.parse(st.next_retry_at);
      return Number.isFinite(ms) ? ms : null;
    },
    touchAttempt(datestr: string, nextAllowedAtMs: number, nowMs: number): void {
      repo.touchAttempt(datestr, nextAllowedAtMs, nowMs);
    },
  };
}
