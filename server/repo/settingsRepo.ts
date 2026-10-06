import { isoSeconds } from '../util/clock.js';
import { stableStringify } from '../util/json.js';
import type { Db } from '../db/index.js';
import { prepare, toDb } from '../db/index.js';
import type { XunjiLimits } from '../xunji/types.js';

/**
 * app_config 仓库（T1）。承载：
 *  - `xunji_limits`：res.limits 的最新快照（每次成功读取刷新，§6.2.2 三源之②）。
 */
export class SettingsRepo {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  getJson(key: string): unknown {
    const row = prepare(this.db, 'SELECT value_json FROM app_config WHERE key = ?').get(key) as
      | { value_json: string }
      | undefined;
    if (!row) return null;
    try {
      return JSON.parse(row.value_json) as unknown;
    } catch {
      return null;
    }
  }

  setJson(key: string, value: unknown, nowMs: number = Date.now()): void {
    prepare(
      this.db,
      `INSERT INTO app_config (key, value_json, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
    ).run(key, stableStringify(value), isoSeconds(nowMs));
  }

  /** 读取缓存的 res.limits（结构非法时返回 null）。 */
  getLimits(): XunjiLimits | null {
    const raw = this.getJson('xunji_limits');
    if (raw === null || typeof raw !== 'object') return null;
    const o = raw as Record<string, unknown>;
    if (typeof o.readRateLimitSecondsFull !== 'number' && typeof o.readRateLimitSeconds !== 'number') {
      return null;
    }
    return raw as XunjiLimits;
  }

  /** 刷新 res.limits 缓存（同步引擎在每次成功读取后调用）。 */
  saveLimits(limits: XunjiLimits, nowMs: number = Date.now()): void {
    this.setJson('xunji_limits', limits, nowMs);
  }
}
