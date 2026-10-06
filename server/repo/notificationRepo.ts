import { isoSeconds } from '../util/clock.js';
import type { Db } from '../db/index.js';
import { prepare, toDb } from '../db/index.js';
import { sanitize } from '../shared/logger.js';

export type NotificationLevel = 'info' | 'warn' | 'error';

export interface NotificationRow {
  id: number;
  level: string;
  title: string;
  body: string | null;
  ref_type: string | null;
  ref_id: string | null;
  is_read: number;
  created_at: string;
}

/** notification 仓库（T1）：同步的数据质量告警 / 致命错误通知落库。 */
export class NotificationRepo {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  add(
    level: NotificationLevel,
    title: string,
    body: string | null,
    refType: string | null = null,
    refId: string | null = null,
    nowMs: number = Date.now(),
  ): number {
    const r = prepare(
      this.db,
      `INSERT INTO notification (level, title, body, ref_type, ref_id, is_read, created_at)
       VALUES (?, ?, ?, ?, ?, 0, ?)`,
    ).run(level, title, sanitize(body ?? ''), toDb(refType), toDb(refId), isoSeconds(nowMs));
    return Number(r.lastInsertRowid);
  }

  listRecent(limit: number = 50): NotificationRow[] {
    return prepare(
      this.db,
      'SELECT id, level, title, body, ref_type, ref_id, is_read, created_at FROM notification ORDER BY id DESC LIMIT ?',
    ).all(limit) as unknown as NotificationRow[];
  }

  countUnread(): number {
    const row = prepare(this.db, 'SELECT COUNT(*) AS c FROM notification WHERE is_read = 0').get() as {
      c: number;
    };
    return Number(row.c);
  }

  /** 标记已读（T5）：ids 为空/省略 = 全部已读。返回受影响行数。 */
  markRead(ids: number[] = [], nowMs: number = Date.now()): number {
    void nowMs;
    if (ids.length === 0) {
      const r = prepare(this.db, 'UPDATE notification SET is_read = 1 WHERE is_read = 0').run();
      return Number(r.changes);
    }
    const placeholders = ids.map(() => '?').join(', ');
    const r = prepare(this.db, `UPDATE notification SET is_read = 1 WHERE is_read = 0 AND id IN (${placeholders})`).run(...ids);
    return Number(r.changes);
  }
}
