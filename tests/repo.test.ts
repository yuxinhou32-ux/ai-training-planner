import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import path from 'node:path';
import { inTransaction } from '../server/db/index.js';
import { openMemoryDatabase } from '../server/db/index.js';
import { countIndexes, countTables, migrate } from '../server/db/migrate.js';
import { MIGRATIONS } from '../server/db/schema.js';
import { backupDb, defaultBackupPath } from '../server/db/backup.js';
import { SettingsRepo } from '../server/repo/settingsRepo.js';
import { NotificationRepo } from '../server/repo/notificationRepo.js';
import { RawRepo } from '../server/repo/rawRepo.js';
import { SyncStateRepo } from '../server/repo/syncStateRepo.js';
import { JobRepo } from '../server/repo/jobRepo.js';
import { TrainRepo } from '../server/repo/trainRepo.js';
import { parseDay } from '../server/ingest/parser.js';
import { makeCardioTrain, makeEnvelope, makeSet, makeTempDb, makeTrain, DEFAULT_LIMITS } from './fixtures.js';
import { existsSync } from 'node:fs';

test('migrate：schema 全量建表（34 表 = v1 的 29 + v4 training_cycle + v5 daily_note/weekly_review + v6 weight_log + v7 week_note）+ 索引，幂等可重复执行', () => {
  const { db, dir } = makeTempDb();
  try {
    assert.equal(countTables(db), 34);
    assert.ok(countIndexes(db) >= 40);
    // 幂等：再跑一遍不报错、不重复建表
    const second = migrate(db);
    assert.equal(second.applied, 0);
    assert.equal(countTables(db), 34);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('settingsRepo：app_config 读写 + limits 缓存往返', () => {
  const { db, dir } = makeTempDb();
  try {
    const repo = new SettingsRepo(db);
    assert.equal(repo.getLimits(), null);
    repo.saveLimits(DEFAULT_LIMITS);
    const l = repo.getLimits();
    assert.ok(l);
    assert.equal(l?.readRateLimitSecondsFull, 30);
    assert.equal(l?.maxMovesPerTrain, 40);
    // upsert 刷新
    repo.saveLimits({ ...DEFAULT_LIMITS, readRateLimitSecondsFull: 45 });
    assert.equal(repo.getLimits()?.readRateLimitSecondsFull, 45);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('notificationRepo：告警落库与未读计数', () => {
  const { db, dir } = makeTempDb();
  try {
    const repo = new NotificationRepo(db);
    repo.add('warn', '截断告警', 'X 日数据被服务端截断', 'sync', '2026-09-14');
    repo.add('error', '同步终止', 'API Key 无效');
    assert.equal(repo.countUnread(), 2);
    const rows = repo.listRecent(10);
    assert.equal(rows.length, 2);
    assert.equal(rows[0]?.level, 'error');
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('rawRepo：快照追加 + 同秒幂等 upsert + 失败行留证', () => {
  const { db, dir } = makeTempDb();
  try {
    const repo = new RawRepo(db);
    const body = JSON.stringify(makeEnvelope('2026-09-14', [makeTrain()]));
    const id1 = repo.insert({
      datestr: '2026-09-14',
      fetchedAtMs: 1_789_900_000_000,
      requestJson: '{"schema_version":"train_open_api_v2"}',
      payloadJson: body,
      payloadHash: 'h1',
      httpStatus: 200,
      ok: true,
      errorCode: null,
      errorMsg: null,
    });
    // 同一 (datestr, fetched_at) 再写 → 更新而非新行
    const id2 = repo.insert({
      datestr: '2026-09-14',
      fetchedAtMs: 1_789_900_000_000,
      requestJson: '{"schema_version":"train_open_api_v2"}',
      payloadJson: body,
      payloadHash: 'h1',
      httpStatus: 200,
      ok: true,
      errorCode: null,
      errorMsg: null,
    });
    assert.equal(id1, id2);
    assert.equal(repo.count(), 1);
    // 失败行（解析失败留证）
    repo.insert({
      datestr: '2026-09-13',
      fetchedAtMs: 1_789_900_000_001,
      requestJson: '{}',
      payloadJson: 'garbage-bytes',
      payloadHash: null,
      httpStatus: 200,
      ok: false,
      errorCode: 'JSON_PARSE',
      errorMsg: 'Unexpected token',
    });
    const okRow = repo.latestOk('2026-09-14');
    assert.ok(okRow);
    assert.equal(okRow?.ok, 1);
    assert.equal(repo.latestOk('2026-09-13'), null);
    assert.equal(repo.count(), 2);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('syncStateRepo：状态机 + 断点续传关键操作', () => {
  const { db, dir } = makeTempDb();
  try {
    const repo = new SyncStateRepo(db);
    assert.equal(repo.get('2026-09-14'), null);
    repo.ensure('2026-09-14');
    repo.ensure('2026-09-14'); // 幂等
    assert.equal(repo.get('2026-09-14')?.status, 'pending');

    // 限频调度：不消耗 attempts
    repo.scheduleRateLimitedRetry('2026-09-14', Date.now() + 30_000);
    assert.equal(repo.get('2026-09-14')?.attempts, 0);
    assert.ok(repo.get('2026-09-14')?.next_retry_at);

    // 退避调度：attempts+1
    const a1 = repo.scheduleBackoffRetry('2026-09-14', Date.now() + 60_000);
    assert.equal(a1, 1);

    // 完成
    repo.markDone('2026-09-14', 'hash-abc', 1);
    const done = repo.get('2026-09-14');
    assert.equal(done?.status, 'done');
    assert.equal(done?.content_hash, 'hash-abc');
    assert.ok(done?.next_retry_at === null || done?.next_retry_at === undefined);

    // 失败（markFailed 只 UPDATE，需先 ensure 建行）
    repo.ensure('2026-09-13');
    repo.markFailed('2026-09-13', 'HTTP_4XX', 'HTTP 错误 404');
    assert.equal(repo.get('2026-09-13')?.status, 'failed');
    assert.equal(repo.listFailed().length, 1);

    // 水位与统计（markEmpty 只 UPDATE，需先 ensure 建行）
    repo.ensure('2026-09-12');
    repo.markEmpty('2026-09-12', 'hash-e');
    assert.equal(repo.maxSyncedDatestr(), '2026-09-14');
    assert.equal(repo.stats()['done'], 1);
    assert.equal(repo.stats()['empty'], 1);

    // fetching 悬挂复位
    repo.setStatus('2026-09-11', 'fetching');
    assert.equal(repo.resetFetching(), 1);
    assert.equal(repo.get('2026-09-11')?.status, 'pending');

    // touchAttempt（客户端冷却闸门）
    const now = Date.now();
    repo.touchAttempt('2026-09-10', now + 30_000, now);
    const touched = repo.get('2026-09-10');
    assert.ok(Math.abs(Date.parse(touched?.next_retry_at ?? '') - (now + 30_000)) < 1500);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('jobRepo：创建/进度/收尾/遗留 running 复位', () => {
  const { db, dir } = makeTempDb();
  try {
    const repo = new JobRepo(db);
    const id = repo.create('sync_full', 'manual', { days: 90 });
    assert.equal(repo.get(id)?.status, 'running');
    repo.setProgress(id, { total: 90, done: 1 });
    assert.match(repo.get(id)?.progress_json ?? '', /"total":90/);
    repo.finish(id, 'partial', { failedDates: [{ datestr: '2026-09-01' }] });
    assert.equal(repo.get(id)?.status, 'partial');

    // 遗留 running 复位
    const id2 = repo.create('sync_incremental', 'startup');
    assert.equal(repo.cancelRunning(['sync_full', 'sync_incremental', 'sync_retry']), 1);
    assert.equal(repo.get(id2)?.status, 'cancelled');
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('trainRepo：幂等 upsert —— 同日两次写入不产生重复记录', () => {
  const { db, dir } = makeTempDb();
  try {
    const repo = new TrainRepo(db);
    const parsed = parseDay('2026-09-14', (makeEnvelope('2026-09-14', [makeTrain({ movements: [{}] , })]).res) as never);
    const envelope = makeEnvelope('2026-09-14', [
      makeTrain({
        movements: [
          { index: 1, name: '杠铃卧推', type: '胸', exetype: '', sets: [makeSet(), makeSet({ index: 2 })], truncated: false, note: '', singleSide: false, restTime: 120, warn_restTime: 0 },
          { index: 2, name: '深蹲', type: '腿', exetype: '', sets: [makeSet({ index: 1, weight: '100' })], truncated: false, note: '', singleSide: false, restTime: 150, warn_restTime: 0 },
        ],
      }),
    ]);
    const day = parseDay('2026-09-14', envelope.res as never);

    // raw_id 有外键约束 → 先插一行真实 raw 快照，拿到合法 id
    const rawRepo = new RawRepo(db);
    const rawId = rawRepo.insert({
      datestr: '2026-09-14',
      fetchedAtMs: Date.now(),
      requestJson: '{"schema_version":"train_open_api_v2","datestr":"2026-09-14"}',
      payloadJson: JSON.stringify(envelope),
      payloadHash: 'hash-test',
      httpStatus: 200,
      ok: true,
      errorCode: null,
      errorMsg: null,
    });

    const write = () =>
      inTransaction(db, () => repo.upsertDay(day, { rawId, syncedAtMs: Date.now() }));
    const r1 = write();
    assert.deepEqual(r1, { sessions: 1, movements: 2, sets: 3 });
    const r2 = write(); // 重复同步
    assert.deepEqual(r2, { sessions: 1, movements: 2, sets: 3 });
    assert.deepEqual(repo.counts(), { sessions: 1, movements: 2, sets: 3 });
    assert.deepEqual(repo.countsByDate('2026-09-14'), { sessions: 1, movements: 2, sets: 3 });
    void parsed;
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('trainRepo：超级组父子行 + 热身组 + 有氧指标落库', () => {
  const { db, dir } = makeTempDb();
  try {
    const repo = new TrainRepo(db);
    const envelope = makeEnvelope('2026-09-14', [
      makeTrain({
        movements: [
          {
            index: 1,
            name: '超级组',
            type: '',
            exetype: '',
            truncated: false,
            note: '',
            singleSide: false,
            restTime: 90,
            warn_restTime: 0,
            sets: [
              makeSet({ index: 1, weight: '', reps: '', items: [makeSet({ index: 1, weight: '20' }), makeSet({ index: 2, weight: '22.5' })] }),
              makeSet({ index: 2, setType: '热' }),
            ],
          },
        ],
      }),
      makeCardioTrain('2026-09-14', 222),
    ]);
    const day = parseDay('2026-09-14', envelope.res as never);
    inTransaction(db, () => repo.upsertDay(day, { rawId: null, syncedAtMs: Date.now() }));

    // 组数：超级组(1 父 + 2 子) + 热身 1 + 有氧 1 = 5
    assert.deepEqual(repo.counts(), { sessions: 2, movements: 2, sets: 5 });

    // 热身组标记
    const warmup = db
      .prepare("SELECT is_warmup, warmup_source FROM movement_set WHERE set_type = '热'")
      .all() as Array<{ is_warmup: number; warmup_source: string }>;
    assert.equal(warmup.length, 1);
    assert.equal(warmup[0]?.is_warmup, 1);
    assert.equal(warmup[0]?.warmup_source, 'server_set_type');

    // 超级组父子关系
    const child = db
      .prepare('SELECT COUNT(*) AS c FROM movement_set WHERE parent_set_id IS NOT NULL')
      .get() as { c: number };
    assert.equal(Number(child.c), 2);

    // 有氧指标
    const cardio = db
      .prepare('SELECT distance_m, kcal, avg_heart_rate FROM movement_set WHERE distance_m IS NOT NULL')
      .get() as { distance_m: number; kcal: number; avg_heart_rate: number };
    assert.equal(cardio.distance_m, 1970);
    assert.equal(cardio.kcal, 266.71);
    assert.equal(cardio.avg_heart_rate, 133);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('backup：VACUUM INTO 快照生成', () => {
  const { db, dir, file } = makeTempDb();
  try {
    const dest = defaultBackupPath(file, new Date('2026-09-29T10:00:00Z'));
    assert.match(path.basename(dest), /^app-20260929-\d{6}\.db$/);
    backupDb(db, dest);
    assert.ok(existsSync(dest));
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('迁移 v9：analysis_report 表重建（preset 加 w26 + kind/version_no），行数与 findings 一个都不能丢', () => {
  const db = openMemoryDatabase();
  try {
    // 手工把库推到 v8 —— 复刻 migrate() 的执行流程，但只跑到 v8（v9 留给待验证的 migrate 调用）
    db.exec(`CREATE TABLE IF NOT EXISTS schema_migration (
      version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL);`);
    for (const m of MIGRATIONS) {
      if (m.version > 8) break;
      if (m.preSql) db.exec(m.preSql);
      db.exec('BEGIN IMMEDIATE');
      try {
        db.exec(m.sql);
        db.prepare('INSERT INTO schema_migration (version, name, applied_at) VALUES (?, ?, ?)').run(m.version, m.name, 'now');
        db.exec('COMMIT');
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      } finally {
        if (m.postSql) db.exec(m.postSql);
      }
    }
    const v8 = db.prepare('SELECT MAX(version) AS v FROM schema_migration').get() as { v: number };
    assert.equal(Number(v8.v), 8, '前置库应停在 v8');

    // 最小报告行 + 一条 finding（finding 用来验证 DROP TABLE 不会触发 ON DELETE CASCADE）
    const rid = Number(
      db
        .prepare(
          `INSERT INTO analysis_report (window_start, window_end, window_preset, params_json, payload_json, payload_hash, generated_at)
           VALUES ('2026-01-01','2026-06-30','w12','{}','{}','h','2026-07-01T00:00:00Z')`,
        )
        .run().lastInsertRowid,
    );
    db.prepare(
      `INSERT INTO analysis_finding (report_id, code, severity, title, detail, evidence_json, suggestion, sort_no, created_at)
       VALUES (?, 'R-AG-01', 'warn', 't', 'd', '{}', NULL, 1, '2026-07-01T00:00:00Z')`,
    ).run(rid);
    const beforeReports = Number((db.prepare('SELECT COUNT(*) AS c FROM analysis_report').get() as { c: number }).c);
    const beforeFindings = Number((db.prepare('SELECT COUNT(*) AS c FROM analysis_finding').get() as { c: number }).c);
    assert.equal(beforeReports, 1);
    assert.equal(beforeFindings, 1);

    const res = migrate(db); // 应补跑 v9（analysis_report 重建）及其后的迁移（v10：job_run.job_type 放行 report_prune）
    assert.ok(res.applied >= 1, '至少要补跑 v9');
    assert.ok(res.currentVersion >= 10, `schema 至少到 v10，实际 v${res.currentVersion}`);

    const afterReports = Number((db.prepare('SELECT COUNT(*) AS c FROM analysis_report').get() as { c: number }).c);
    const afterFindings = Number((db.prepare('SELECT COUNT(*) AS c FROM analysis_finding').get() as { c: number }).c);
    assert.equal(afterReports, 1, 'analysis_report 行数不变');
    assert.equal(afterFindings, 1, 'analysis_finding 不能被 CASCADE 带走');

    const fkCheck = db.prepare('PRAGMA foreign_key_check').all();
    assert.equal(fkCheck.length, 0, 'foreign_key_check 应为空');

    const row = db.prepare('SELECT kind, version_no, window_preset FROM analysis_report WHERE id = ?').get(rid) as {
      kind: string;
      version_no: number | null;
      window_preset: string;
    };
    assert.equal(row.kind, 'adhoc', "新列 kind 默认 'adhoc'");
    assert.equal(row.version_no, null, '新列 version_no 全为 NULL');
    assert.equal(row.window_preset, 'w12', '旧行的 preset 原样保留');

    // 新 CHECK 接受 w26（表重建后能插入）
    db.prepare(
      `INSERT INTO analysis_report (window_start, window_end, window_preset, params_json, payload_json, payload_hash, schema_version, generated_at, kind, version_no)
       VALUES ('2026-01-01','2026-06-30','w26','{}','{}','h2','1.0','2026-05-04T00:00:00Z','snapshot',1)`,
    ).run();
    assert.equal(Number((db.prepare('SELECT COUNT(*) AS c FROM analysis_report').get() as { c: number }).c), 2);
  } finally {
    db.close();
  }
});
