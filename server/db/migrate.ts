import { isoSeconds, realClock } from '../util/clock.js';
import type { Db } from './index.js';
import { prepare } from './index.js';
import { MIGRATIONS } from './schema.js';

/**
 * 迁移执行器（T1）。
 *
 * - 每个迁移在单事务内执行：DDL + schema_migration 记录同生共死；
 * - 幂等：已记录的版本跳过；
 * - schema_migration 表本身由本函数显式保证存在（鸡生蛋问题的标准解法，
 *   DDL v1 中同名的 CREATE IF NOT EXISTS 在二次执行时是 no-op）。
 */
export interface MigrateResult {
  applied: number;
  currentVersion: number;
}

export function migrate(db: Db, nowMs: number = realClock.now()): MigrateResult {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migration (
  version     INTEGER PRIMARY KEY,
  name        TEXT NOT NULL,
  applied_at  TEXT NOT NULL
);`);

  const appliedSet = new Set<number>();
  const rows = db.prepare('SELECT version FROM schema_migration').all() as Array<{ version: number }>;
  for (const row of rows) appliedSet.add(Number(row.version));

  let applied = 0;
  for (const m of MIGRATIONS) {
    if (appliedSet.has(m.version)) continue;
    // preSql 必须在事务外执行（PRAGMA foreign_keys 在事务内是 no-op）
    if (m.preSql) db.exec(m.preSql);
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(m.sql);
      prepare(db, 'INSERT INTO schema_migration (version, name, applied_at) VALUES (?, ?, ?)').run(
        m.version,
        m.name,
        isoSeconds(nowMs),
      );
      db.exec('COMMIT');
      applied += 1;
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    } finally {
      // finally 语义：回滚路径也必须恢复连接级 PRAGMA，绝不让后续迁移在 FK 关闭下运行
      if (m.postSql) db.exec(m.postSql);
    }
  }

  return { applied, currentVersion: currentSchemaVersion(db) };
}

/** 当前 schema 版本（空库为 0）。 */
export function currentSchemaVersion(db: Db): number {
  const row = db
    .prepare('SELECT MAX(version) AS v FROM schema_migration')
    .get() as { v: number | null } | undefined;
  return row?.v ?? 0;
}

/** 表数量核对（测试与 reconcile 用）。 */
export function countTables(db: Db): number {
  const row = db
    .prepare("SELECT COUNT(*) AS c FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .get() as { c: number };
  return Number(row.c);
}

/** 索引数量核对。 */
export function countIndexes(db: Db): number {
  const row = db
    .prepare("SELECT COUNT(*) AS c FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%'")
    .get() as { c: number };
  return Number(row.c);
}
