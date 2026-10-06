import { mkdirSync } from 'node:fs';
import path from 'node:path';
import type { Db } from './index.js';

/**
 * 数据库备份（T1 实现，T5 调度使用；§3.6 / R-22）。
 * 用 `VACUUM INTO` 生成紧凑快照 —— 在线、一致、不锁写。
 */
export function backupDb(db: Db, destPath: string): string {
  mkdirSync(path.dirname(destPath), { recursive: true });
  const escaped = destPath.replace(/'/g, "''");
  db.exec(`VACUUM INTO '${escaped}'`);
  return destPath;
}

/**
 * 默认备份路径：data/backups/app-YYYYMMDD-HHMMSS.db（§2.3 目录约定）。
 * T5 冒烟修正：原只有日期戳，同日第二次备份 VACUUM INTO 报 "output file already exists"
 * （定时 03:30 与手动触发撞车）——加时间戳，每次备份都是独立快照，保留策略由 prune 统一管。
 */
export function defaultBackupPath(dbFile: string, now: Date = new Date()): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  const stamp = [
    String(now.getFullYear()),
    pad(now.getMonth() + 1),
    pad(now.getDate()),
    '-',
    pad(now.getHours()),
    pad(now.getMinutes()),
    pad(now.getSeconds()),
  ].join('');
  return path.join(path.dirname(dbFile), 'backups', `app-${stamp}.db`);
}
