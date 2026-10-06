import { isoSeconds } from '../util/clock.js';
import type { Db } from '../db/index.js';
import { prepare, toDb } from '../db/index.js';
import { sanitize } from '../shared/logger.js';

/**
 * raw_train_raw 仓库（T1）—— 第 1 层「原始快照层」。
 *
 * 语义：
 *  - 每次成功读取都追加一行（datestr + fetched_at 唯一）—— 历史可回溯；
 *  - 幂等：同秒重复写入走 ON CONFLICT DO UPDATE（内容一致则无害）；
 *  - 失败读取（gzip/JSON 损坏、致命错误）也落一行 ok=0 留证（§6.4 矩阵）。
 *  - request_json 不含 Key（Key 只在 Authorization 头，永不入库）。
 */
export interface RawInsertRow {
  datestr: string;
  fetchedAtMs: number;
  requestJson: string;
  payloadJson: string | null;
  payloadHash: string | null;
  httpStatus: number | null;
  ok: boolean;
  errorCode: string | null;
  errorMsg: string | null;
}

export interface RawRow {
  id: number;
  datestr: string;
  fetched_at: string;
  request_json: string;
  payload_json: string | null;
  payload_hash: string | null;
  http_status: number | null;
  ok: number;
  error_code: string | null;
  error_msg: string | null;
}

export class RawRepo {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  /** 幂等 upsert：UNIQUE(datestr, fetched_at)。返回行 id。 */
  insert(row: RawInsertRow): number {
    const fetchedAt = isoSeconds(row.fetchedAtMs);
    const r = prepare(
      this.db,
      `INSERT INTO raw_train_raw
         (datestr, fetched_at, request_json, payload_json, payload_hash, http_status, ok, error_code, error_msg)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(datestr, fetched_at) DO UPDATE SET
         payload_json = excluded.payload_json,
         payload_hash = excluded.payload_hash,
         http_status = excluded.http_status,
         ok = excluded.ok,
         error_code = excluded.error_code,
         error_msg = excluded.error_msg`,
    ).run(
      row.datestr,
      fetchedAt,
      row.requestJson,
      toDb(row.payloadJson),
      toDb(row.payloadHash),
      toDb(row.httpStatus),
      row.ok ? 1 : 0,
      toDb(row.errorCode),
      sanitize(row.errorMsg ?? '') || null,
    );
    return Number(r.lastInsertRowid);
  }

  /** 某日期最近一次成功快照（reconcile / 排障用）。 */
  latestOk(datestr: string): RawRow | null {
    return (
      (prepare(
        this.db,
        'SELECT id, datestr, fetched_at, request_json, payload_json, payload_hash, http_status, ok, error_code, error_msg FROM raw_train_raw WHERE datestr = ? AND ok = 1 ORDER BY fetched_at DESC LIMIT 1',
      ).get(datestr) as RawRow | undefined) ?? null
    );
  }

  count(): number {
    const row = prepare(this.db, 'SELECT COUNT(*) AS c FROM raw_train_raw').get() as { c: number };
    return Number(row.c);
  }
}
