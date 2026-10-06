/**
 * 任务编排测试：开机编排 + 过期草稿归档 + JobRunner。
 *
 * 红线：零真实网络——不构造 SyncEngine（engine=null 路径），AI 用桩网关。
 * 时钟：全部注入固定 nowMs（不依赖真实挂钟，杜绝跨天脆弱性）。
 *
 * v2 已移除定时调度与自动化开关，相应测试（schedule/automation/catchup）一并删除。
 * 2026-09-30：4 周周期总结按用户定案改成「每周一次」，reviewService 及其测试一并删除；
 *             周复盘（weeklyReview）的测试在 weeklyReview.test.ts。
 */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { archiveStaleDrafts, hasCompletedFullSync, nextSyncJobType, runStartupTasks } from '../server/jobs/startup.js';
import { JobRunner } from '../server/jobs/runner.js';
import { makeTempDb } from './fixtures.js';
import { openMemoryDatabase } from '../server/db/index.js';
import { migrate } from '../server/db/migrate.js';
import type { Db } from '../server/db/index.js';

function memoryDb(): Db {
  const db = openMemoryDatabase();
  migrate(db);
  return db;
}

// ---------------------------------------------------------------------------
// 开机编排（startup.ts）：复位 running + 归档过期草稿 + 可选开机同步
// ---------------------------------------------------------------------------

describe('runStartupTasks', () => {
  function seedPlan(db: Db, weekStart: string, weekEnd: string, status: string): number {
    const r = db
      .prepare(
        `INSERT INTO plan (week_start, week_end, version_no, status, source, created_at, updated_at)
         VALUES (?, ?, 1, ?, 'rule_fallback', '2026-09-21T00:00:00Z', '2026-09-21T00:00:00Z')`,
      )
      .run(weekStart, weekEnd, status) as unknown as { lastInsertRowid: number | bigint };
    return Number(r.lastInsertRowid);
  }

  function stubRunner(enqueued: Array<{ jobType: string; triggeredBy: string }>): { enqueue: (jobType: string, triggeredBy: string) => Promise<{ jobRunId: null; status: 'success' }> } {
    return {
      enqueue: (jobType: string, triggeredBy: string) => {
        enqueued.push({ jobType, triggeredBy });
        return Promise.resolve({ jobRunId: null, status: 'success' as const });
      },
    };
  }

  it('复位遗留 running；归档过期草稿；从未全量过 → 开机排「全量」而不是增量', () => {
    const db = memoryDb();
    const staleId = seedPlan(db, '2026-09-14', '2026-09-20', 'draft');
    db.prepare(
      `INSERT INTO job_run (job_type, status, triggered_by, started_at)
       VALUES ('analysis_refresh', 'running', 'manual', '2026-09-30T00:00:00Z')`,
    ).run();

    const calls: Array<{ jobType: string; triggeredBy: string }> = [];
    const rep = runStartupTasks(db, stubRunner(calls) as never, { syncOnStartup: true });

    assert.equal(rep.cancelled, 1);
    assert.equal(rep.archived, 1);
    assert.equal(rep.syncQueued, true);
    // 🔴 新库第一次开机必须是全量：走增量只会拉近 7 天，还会立刻建水位，
    //    26 周窗口的前 25 周此后永远没人补（2026-10-01 定案）。
    assert.equal(rep.syncJobType, 'sync_full');
    const stale = db.prepare('SELECT status FROM plan WHERE id = ?').get(staleId) as { status: string };
    assert.equal(stale.status, 'archived');
    const running = db.prepare("SELECT COUNT(*) AS c FROM job_run WHERE status = 'running'").get() as { c: number };
    assert.equal(Number(running.c), 0, '遗留 running 应被复位');
    // 同步以 fire-and-forget 排队，等一个 tick 后再断言
    return Promise.resolve().then(() => {
      assert.deepEqual(calls, [{ jobType: 'sync_full', triggeredBy: 'startup' }]);
    });
  });

  it('已经成功全量过 → 开机只排增量', () => {
    const db = memoryDb();
    db.prepare(
      `INSERT INTO job_run (job_type, status, triggered_by, started_at, finished_at)
       VALUES ('sync_full', 'success', 'startup', '2026-09-30T00:00:00Z', '2026-09-30T00:00:09Z')`,
    ).run();

    const calls: Array<{ jobType: string; triggeredBy: string }> = [];
    const rep = runStartupTasks(db, stubRunner(calls) as never, { syncOnStartup: true });

    assert.equal(rep.syncJobType, 'sync_incremental');
    return Promise.resolve().then(() => {
      assert.deepEqual(calls, [{ jobType: 'sync_incremental', triggeredBy: 'startup' }]);
    });
  });

  it('全量只失败过（未成功）→ 仍然排全量（失败不算「导入过」）', () => {
    const db = memoryDb();
    db.prepare(
      `INSERT INTO job_run (job_type, status, triggered_by, started_at, finished_at, result_ref)
       VALUES ('sync_full', 'failed', 'startup', '2026-09-30T00:00:00Z', '2026-09-30T00:00:02Z', NULL)`,
    ).run();
    assert.equal(hasCompletedFullSync(db), false);
    assert.equal(nextSyncJobType(db), 'sync_full');
  });

  it('partial（未成功）也不算「导入过」→ 仍然排全量', () => {
    const db = memoryDb();
    db.prepare(
      `INSERT INTO job_run (job_type, status, triggered_by, started_at, finished_at, result_ref)
       VALUES ('sync_full', 'partial', 'startup', '2026-09-30T00:00:00Z', '2026-09-30T00:00:02Z', NULL)`,
    ).run();
    assert.equal(hasCompletedFullSync(db), false);
    assert.equal(nextSyncJobType(db), 'sync_full');
  });

  it('syncOnStartup=false → 不排队任何任务（未配置 Key 时不刷失败记录）', () => {
    const db = memoryDb();
    const calls: Array<{ jobType: string; triggeredBy: string }> = [];
    const rep = runStartupTasks(db, stubRunner(calls) as never, { syncOnStartup: false });
    assert.equal(rep.syncQueued, false);
    assert.equal(rep.syncJobType, null);
    assert.equal(calls.length, 0);
  });
});

// ---------------------------------------------------------------------------
// 过期草稿归档（§7.6）
// ---------------------------------------------------------------------------

describe('archiveStaleDrafts', () => {
  function seedPlan(db: Db, weekStart: string, weekEnd: string, status: string): number {
    const r = db
      .prepare(
        `INSERT INTO plan (week_start, week_end, version_no, status, source, created_at, updated_at)
         VALUES (?, ?, 1, ?, 'rule_fallback', '2026-09-21T00:00:00Z', '2026-09-21T00:00:00Z')`,
      )
      .run(weekStart, weekEnd, status) as unknown as { lastInsertRowid: number | bigint };
    return Number(r.lastInsertRowid);
  }

  it('week_end 已过的 draft → archived + 通知；其余状态不动', () => {
    const db = memoryDb();
    const staleId = seedPlan(db, '2026-09-14', '2026-09-20', 'draft');
    const futureId = seedPlan(db, '2026-10-05', '2026-10-11', 'draft');
    seedPlan(db, '2026-09-07', '2026-09-13', 'approved'); // 非 draft 不归档
    const n = archiveStaleDrafts(db, new Date(2026, 8, 30, 10, 0).getTime());
    assert.equal(n, 1);
    const stale = db.prepare('SELECT status FROM plan WHERE id = ?').get(staleId) as { status: string };
    const future = db.prepare('SELECT status FROM plan WHERE id = ?').get(futureId) as { status: string };
    assert.equal(stale.status, 'archived');
    assert.equal(future.status, 'draft');
    const notif = db.prepare("SELECT COUNT(*) AS c FROM notification WHERE title LIKE '归档%'").get() as { c: number };
    assert.equal(Number(notif.c), 1);
  });
});

// ---------------------------------------------------------------------------
// JobRunner：串行执行 + job_run 生命周期 + 同类合并
// ---------------------------------------------------------------------------

describe('JobRunner', () => {
  it('db_backup：执行成功 → job_run success + result_ref + 备份文件存在', async () => {
    const { db, dir, file } = makeTempDb();
    const runner = new JobRunner(db, { db, dbPath: file, engine: null, gw: null, aiModelTag: 'none' });
    const out = await runner.enqueue('db_backup', 'manual');
    assert.equal(out.status, 'success');
    const row = db.prepare("SELECT status, result_ref FROM job_run WHERE job_type = 'db_backup' ORDER BY id DESC LIMIT 1").get() as {
      status: string;
      result_ref: string | null;
    };
    assert.equal(row.status, 'success');
    assert.ok(row.result_ref !== null && row.result_ref.includes(path.join(dir, 'backups')));
    assert.ok(existsSync(row.result_ref as string));
  });

  it('同类型重复排队 → 后到的合并跳过', async () => {
    const { db, file } = makeTempDb();
    const runner = new JobRunner(db, { db, dbPath: file, engine: null, gw: null, aiModelTag: 'none' });
    const p1 = runner.enqueue('db_backup', 'manual');
    const p2 = runner.enqueue('db_backup', 'manual');
    const p3 = runner.enqueue('db_backup', 'manual');
    const [r1, r2, r3] = await Promise.all([p1, p2, p3]);
    assert.equal(r1.status, 'success');
    assert.match(r2.detail ?? '', /合并/);
    assert.match(r3.detail ?? '', /合并/);
    // 只执行了 1 次
    const n = db.prepare("SELECT COUNT(*) AS c FROM job_run WHERE job_type = 'db_backup'").get() as { c: number };
    assert.equal(Number(n.c), 1);
  });

  it('engine=null 时 sync_incremental → failed + error 通知', async () => {
    const { db, file } = makeTempDb();
    const runner = new JobRunner(db, { db, dbPath: file, engine: null, gw: null, aiModelTag: 'none' });
    const out = await runner.enqueue('sync_incremental', 'manual');
    assert.equal(out.status, 'failed');
    const notif = db.prepare("SELECT level FROM notification WHERE title LIKE '%失败%' ORDER BY id DESC LIMIT 1").get() as { level: string };
    assert.equal(notif.level, 'error');
  });
});

