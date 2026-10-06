import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';

/**
 * SQLite 数据层入口（T1，Node 内置 node:sqlite，无第三方驱动）。
 *
 * 连接后立即执行的 PRAGMA（§3.2 头部注释）：
 *   journal_mode = WAL（读写不互斥，进程被杀时靠 WAL 恢复）
 *   foreign_keys = ON（DDL 全部显式外键，必须生效）
 *   synchronous = NORMAL（WAL 下的推荐档）
 */
export type Db = DatabaseSync;

/** 语句缓存：同一条 SQL 只 prepare 一次（按连接隔离）。 */
const stmtCache = new WeakMap<DatabaseSync, Map<string, StatementSync>>();

export function prepare(db: Db, sql: string): StatementSync {
  let cache = stmtCache.get(db);
  if (!cache) {
    cache = new Map<string, StatementSync>();
    stmtCache.set(db, cache);
  }
  let stmt = cache.get(sql);
  if (!stmt) {
    stmt = db.prepare(sql);
    cache.set(sql, stmt);
  }
  return stmt;
}

/** 打开（或创建）数据库文件并设置 PRAGMA。父目录不存在时自动创建。 */
export function openDatabase(file: string): Db {
  mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA synchronous = NORMAL;');
  return db;
}

/** 内存库（测试用；WAL 在内存库上无效，自动忽略）。 */
export function openMemoryDatabase(): Db {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  return db;
}

/**
 * 绑定值规整：JS → SQLite。
 * 注意 node:sqlite 不接受 undefined（实测抛错），必须转 null；
 * 布尔转 0/1（§3.1 布尔约定）。
 */
export function toDb(v: unknown): string | number | bigint | null {
  if (v === undefined || v === null) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'bigint') return v;
  return JSON.stringify(v);
}

/**
 * 显式事务：fn 抛错即 ROLLBACK，成功即 COMMIT。
 * 同步引擎的「单天事务」保证：中断（Ctrl-C/断电）时当天绝不留半截数据。
 */
export function inTransaction<T>(db: Db, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (e) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // 连接已坏（如进程被杀后的自动恢复场景）时忽略回滚失败，向上抛原始错误
    }
    throw e;
  }
}

export function closeDatabase(db: Db): void {
  try {
    db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
  } catch {
    // checkpoint 失败不影响关闭
  }
  db.close();
}
