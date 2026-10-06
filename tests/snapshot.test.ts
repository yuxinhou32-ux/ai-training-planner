/**
 * 快照式画像版本（D）+ 报告清理（E）测试。
 *
 * 覆盖：
 *  1) nextVersionNo：空库=0、递增、adhoc 不占号；
 *  2) createSnapshot：版本 0/1、可按 version 取回、kind='snapshot'；
 *  3) latestSnapshot：无快照=null、只有 adhoc 仍=null（画像不被过程产物污染）；
 *  4) pruneReports：adhoc 留最近 3、snapshot 保留 3 年；
 *  5) compare 契约：movements/muscles/findings 的对齐与排序；
 *  6) 路由：latest?version_no、snapshots、compare 的 400/404、cycle close 产出快照。
 *
 * 红线：零真实网络；所有用例独立内存库。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { openMemoryDatabase, prepare, type Db } from '../server/db/index.js';
import { migrate } from '../server/db/migrate.js';
import {
  compareSnapshots,
  createSnapshot,
  latestSnapshot,
  listSnapshots,
  nextVersionNo,
  snapshotByVersion,
} from '../server/analysis/snapshot.js';
import { pruneReports } from '../server/analysis/prune.js';
import { handleAnalysisRoutes } from '../server/api/routes/analysis.js';
import { handleCycleRoutes } from '../server/api/routes/cycle.js';
import { JobRunner } from '../server/jobs/runner.js';
import { openCycle } from '../server/cycle/cycleService.js';
import { HttpError } from '../server/api/errors.js';
import { isoSeconds } from '../server/util/clock.js';

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

function freshDb(): Db {
  const db = openMemoryDatabase();
  migrate(db);
  return db;
}

const NOW_MS = Date.UTC(2026, 5, 30, 12, 0, 0); // 2026-06-30T12:00:00Z

/** 一份最小可用报告 payload（快照列表只解析 window/basic_stats，compare 读 4 个字段）。 */
function payloadOf(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    window: { weeks: 26, trend_start: '2026-01-01', trend_end: '2026-06-30', recent_start: '2026-06-01', recent_end: '2026-06-30', last_session: null },
    basic_stats: { active_weeks: 3 },
    muscle_volume: {},
    muscle_trends: [],
    movement_trends: [],
    findings: [],
    ...over,
  };
}

function insertReport(
  db: Db,
  o: { kind: 'snapshot' | 'adhoc'; versionNo: number | null; generatedAt: string; payload?: unknown },
): number {
  const payloadJson = JSON.stringify(o.payload ?? payloadOf());
  const r = prepare(
    db,
    `INSERT INTO analysis_report
     (window_start, window_end, window_preset, params_json, payload_json, payload_hash, schema_version, generated_at, kind, version_no)
     VALUES ('2026-01-01', '2026-06-30', 'w26', ?, ?, ?, '1.0', ?, ?, ?)`,
  ).run(
    JSON.stringify({ weeks: 26 }),
    payloadJson,
    `hash-${o.generatedAt}-${o.versionNo ?? 'x'}`,
    o.generatedAt,
    o.kind,
    o.versionNo,
  );
  return Number(r.lastInsertRowid);
}

/** 一条最小训练记录（hasTrainingData 为真的最低成本）。 */
function seedSession(db: Db, datestr: string, localid = 'L1'): void {
  prepare(
    db,
    `INSERT INTO train_session (datestr, localid, session_type, content_hash, synced_at)
     VALUES (?, ?, 'strength', ?, ?)`,
  ).run(datestr, localid, `h:${localid}`, '2026-06-30T00:00:00Z');
}

// ---------------------------------------------------------------------------
// 1) nextVersionNo
// ---------------------------------------------------------------------------

describe('nextVersionNo：第一份 = 0，只数 snapshot', () => {
  it('空库 = 0；已有 0 → 1；已有 0/1/2 → 3', () => {
    const db = freshDb();
    assert.equal(nextVersionNo(db), 0);

    insertReport(db, { kind: 'snapshot', versionNo: 0, generatedAt: '2026-01-01T00:00:00.000Z' });
    assert.equal(nextVersionNo(db), 1);

    insertReport(db, { kind: 'snapshot', versionNo: 1, generatedAt: '2026-02-01T00:00:00.000Z' });
    insertReport(db, { kind: 'snapshot', versionNo: 2, generatedAt: '2026-03-01T00:00:00.000Z' });
    assert.equal(nextVersionNo(db), 3);
  });

  it('adhoc 行不影响版本号', () => {
    const db = freshDb();
    for (let i = 0; i < 5; i++) {
      insertReport(db, { kind: 'adhoc', versionNo: null, generatedAt: `2026-01-0${i + 1}T00:00:00.000Z` });
    }
    assert.equal(nextVersionNo(db), 0, 'adhoc 不占号，下一个快照仍是 0');
    insertReport(db, { kind: 'snapshot', versionNo: 0, generatedAt: '2026-02-01T00:00:00.000Z' });
    insertReport(db, { kind: 'adhoc', versionNo: null, generatedAt: '2026-02-02T00:00:00.000Z' });
    assert.equal(nextVersionNo(db), 1);
  });
});

// ---------------------------------------------------------------------------
// 2) createSnapshot
// ---------------------------------------------------------------------------

describe('createSnapshot：版本 0、1，可回读，kind=snapshot', () => {
  it('连续两次 → 版本 0 与 1；都能按 version_no 取回；落库 kind 正确', () => {
    const db = freshDb();
    seedSession(db, '2026-06-28');

    const m0 = createSnapshot(db, { trendEnd: '2026-06-30' });
    const m1 = createSnapshot(db, { trendEnd: '2026-06-30' });

    assert.equal(m0.version_no, 0);
    assert.equal(m1.version_no, 1);
    assert.equal(m0.report_id, snapshotByVersion(db, 0)?.meta.report_id);
    assert.notEqual(m0.report_id, m1.report_id);

    const got0 = snapshotByVersion(db, 0);
    const got1 = snapshotByVersion(db, 1);
    assert.ok(got0 !== null && got1 !== null);
    assert.equal(got0.report.window.weeks, 26);

    const kinds = prepare(db, `SELECT kind, version_no FROM analysis_report ORDER BY version_no`).all() as unknown as Array<{
      kind: string;
      version_no: number;
    }>;
    assert.deepEqual(
      kinds.map((k) => [k.kind, Number(k.version_no)]),
      [['snapshot', 0], ['snapshot', 1]],
    );

    // finding_count 必须与真正落库的 findings 数一致
    const cnt = prepare(db, `SELECT COUNT(*) AS c FROM analysis_finding WHERE report_id = ?`).get(m1.report_id) as unknown as { c: number };
    assert.equal(m1.finding_count, Number(cnt.c));
    assert.ok(m1.high_count <= m1.finding_count);
  });

  it('listSnapshots 新 → 旧，并从 payload 解析 weeks / active_weeks', () => {
    const db = freshDb();
    insertReport(db, { kind: 'snapshot', versionNo: 0, generatedAt: '2026-01-01T00:00:00.000Z' });
    insertReport(db, {
      kind: 'snapshot',
      versionNo: 1,
      generatedAt: '2026-02-01T00:00:00.000Z',
      payload: payloadOf({ basic_stats: { active_weeks: 7 } }),
    });
    insertReport(db, { kind: 'adhoc', versionNo: null, generatedAt: '2026-03-01T00:00:00.000Z' });

    const list = listSnapshots(db);
    assert.deepEqual(list.map((s) => s.version_no), [1, 0]);
    assert.equal(list[0].weeks, 26);
    assert.equal(list[0].active_weeks, 7);
    assert.equal(list[1].active_weeks, 3);
  });

  it('payload 损坏时 active_weeks 给 null，不抛错', () => {
    const db = freshDb();
    prepare(
      db,
      `INSERT INTO analysis_report
       (window_start, window_end, window_preset, params_json, payload_json, payload_hash, schema_version, generated_at, kind, version_no)
       VALUES ('2026-01-01','2026-06-30','w26','{}','{broken json','h','1.0','2026-01-01T00:00:00.000Z','snapshot',0)`,
    ).run();
    const list = listSnapshots(db);
    assert.equal(list.length, 1);
    assert.equal(list[0].active_weeks, null);
    assert.equal(list[0].weeks, 26, 'payload 坏了退 params（这里 params 也坏 → 退全局常量）');
  });
});

// ---------------------------------------------------------------------------
// 3) latestSnapshot
// ---------------------------------------------------------------------------

describe('latestSnapshot：无快照 = null；只有 adhoc 仍 = null', () => {
  it('空库 → null', () => {
    assert.equal(latestSnapshot(freshDb()), null);
  });

  it('有 adhoc 但无 snapshot → 仍然 null（画像不能被过程产物污染）', () => {
    const db = freshDb();
    insertReport(db, { kind: 'adhoc', versionNo: null, generatedAt: '2026-06-01T00:00:00.000Z' });
    assert.equal(latestSnapshot(db), null);
    // 同时也确认「落库的 adhoc 确实存在」——不是空库误判
    const n = prepare(db, `SELECT COUNT(*) AS c FROM analysis_report`).get() as unknown as { c: number };
    assert.equal(Number(n.c), 1);
  });

  it('有 snapshot 时取版本号最大的一份', () => {
    const db = freshDb();
    insertReport(db, { kind: 'snapshot', versionNo: 0, generatedAt: '2026-01-01T00:00:00.000Z' });
    insertReport(db, { kind: 'snapshot', versionNo: 1, generatedAt: '2026-02-01T00:00:00.000Z' });
    assert.equal(latestSnapshot(db)?.meta.version_no, 1);
  });
});

// ---------------------------------------------------------------------------
// 4) pruneReports
// ---------------------------------------------------------------------------

describe('pruneReports：adhoc 留最近 3 份、snapshot 保留 3 年', () => {
  it('5 份 adhoc + 2 份 snapshot（一份 4 年前）→ adhoc 剩最新 3、老 snapshot 删、新 snapshot 留', () => {
    const db = freshDb();
    const adhocIds: number[] = [];
    for (let i = 0; i < 5; i++) {
      adhocIds.push(insertReport(db, { kind: 'adhoc', versionNo: null, generatedAt: `2026-01-0${i + 1}T00:00:00.000Z` }));
    }
    const oldSnapshot = insertReport(db, { kind: 'snapshot', versionNo: 0, generatedAt: '2022-01-01T00:00:00.000Z' });
    const newSnapshot = insertReport(db, { kind: 'snapshot', versionNo: 1, generatedAt: '2026-06-01T00:00:00.000Z' });

    const res = pruneReports(db, { nowMs: NOW_MS });
    assert.deepEqual(res, { adhocDeleted: 2, snapshotDeleted: 1 });

    const remaining = prepare(db, `SELECT id FROM analysis_report WHERE kind = 'adhoc' ORDER BY id`).all() as unknown as Array<{ id: number }>;
    assert.deepEqual(
      remaining.map((r) => Number(r.id)),
      adhocIds.slice(2),
      '保留的必须是**最新**的 3 份',
    );

    const gone = prepare(db, `SELECT id FROM analysis_report WHERE id = ?`).get(oldSnapshot) as unknown as { id: number } | undefined;
    assert.equal(gone, undefined, '4 年前的 snapshot 应被删');
    const kept = prepare(db, `SELECT id FROM analysis_report WHERE id = ?`).get(newSnapshot) as unknown as { id: number } | undefined;
    assert.ok(kept !== undefined, '近期 snapshot 必须保留');
  });

  it('无报告时是空操作', () => {
    assert.deepEqual(pruneReports(freshDb(), { nowMs: NOW_MS }), { adhocDeleted: 0, snapshotDeleted: 0 });
  });
});

// ---------------------------------------------------------------------------
// 5) compare 冻结契约
// ---------------------------------------------------------------------------

describe('compareSnapshots：movements / muscles / findings 的对齐与排序', () => {
  function twoVersions(): Db {
    const db = freshDb();
    const ins = prepare(db, `INSERT INTO muscle_group (code, name_zh, parent_code, region, size) VALUES (?, ?, NULL, ?, ?)`);
    ins.run('chest', '胸', 'upper', 'large');
    ins.run('quads', '股四头', 'lower', 'large');
    ins.run('back_lats', '背阔', 'upper', 'large');

    insertReport(db, {
      kind: 'snapshot',
      versionNo: 0,
      generatedAt: '2026-01-01T00:00:00.000Z',
      payload: payloadOf({
        movement_trends: [
          { catalog_id: 1, name: '杠铃卧推', verdict: 'plateau', last_weight: 60 },
          { catalog_id: 2, name: '杠铃深蹲', verdict: 'progress', last_weight: 100 },
          { catalog_id: 3, name: '硬拉', verdict: 'insufficient_data', last_weight: null },
        ],
        muscle_volume: {
          chest: { sets_total: 16, sets_per_week_seg0: 4, sets_per_week_seg1: 4, sets_per_week_seg2: 4 },
          quads: { sets_total: 32, sets_per_week_seg0: 8, sets_per_week_seg1: 8, sets_per_week_seg2: 8 },
        },
        muscle_trends: [
          { muscle_code: 'chest', verdict: 'stable' },
          { muscle_code: 'quads', verdict: 'rising' },
        ],
        findings: [
          { code: 'R-AG-03', severity: 'high', title: '胸不足' },
          { code: 'R-AG-05', severity: 'warn', title: '卧推停滞' },
        ],
      }),
    });
    insertReport(db, {
      kind: 'snapshot',
      versionNo: 1,
      generatedAt: '2026-03-01T00:00:00.000Z',
      payload: payloadOf({
        movement_trends: [
          { catalog_id: 1, name: '杠铃卧推', verdict: 'progress', last_weight: 66 },
          { catalog_id: 2, name: '杠铃深蹲', verdict: 'progress', last_weight: 100 },
          { catalog_id: 4, name: '杠铃划船', verdict: 'progress', last_weight: 50 },
        ],
        muscle_volume: {
          chest: { sets_total: 24, sets_per_week_seg0: 6, sets_per_week_seg1: 6, sets_per_week_seg2: 6 },
          back_lats: { sets_total: 20, sets_per_week_seg0: 5, sets_per_week_seg1: 5, sets_per_week_seg2: 5 },
        },
        muscle_trends: [
          { muscle_code: 'chest', verdict: 'rising' },
          { muscle_code: 'back_lats', verdict: 'rising' },
        ],
        findings: [
          { code: 'R-AG-05', severity: 'warn', title: '卧推停滞' },
          { code: 'R-AG-07', severity: 'warn', title: '推拉失衡' },
        ],
      }),
    });
    return db;
  }

  it('movements：changed 在前、按 |delta_pct| 降序、null 排最后', () => {
    const db = twoVersions();
    const r = compareSnapshots(db, 0, 1);
    assert.ok(r !== null);
    assert.equal(r.from.version_no, 0);
    assert.equal(r.to.version_no, 1);
    assert.equal(r.from.window_start, '2026-01-01');
    assert.equal(r.to.generated_at, '2026-03-01T00:00:00.000Z');

    // 变化：卧推（重量+判定）、硬拉（只在 from）、划船（只在 to）；深蹲不变 → 排最后
    assert.deepEqual(
      r.movements.map((m) => m.name),
      ['杠铃卧推', '硬拉', '杠铃划船', '杠铃深蹲'],
    );
    const bench = r.movements[0];
    assert.equal(bench.from_weight, 60);
    assert.equal(bench.to_weight, 66);
    assert.equal(bench.delta_pct, 10, '(66-60)/60*100 = 10');
    assert.equal(bench.from_verdict, 'plateau');
    assert.equal(bench.to_verdict, 'progress');
    assert.equal(bench.changed, true);

    const squat = r.movements[3];
    assert.equal(squat.changed, false);
    assert.equal(squat.delta_pct, 0);

    // 只在 to 出现 → from_weight null → delta_pct null
    const row = r.movements.find((m) => m.name === '杠铃划船')!;
    assert.equal(row.from_weight, null);
    assert.equal(row.delta_pct, null);
    assert.equal(row.changed, true);

    assert.equal(r.summary.movements_changed, 3);
  });

  it('muscles：全量列出、按 to_weekly_sets 降序、中文名来自 muscle_group', () => {
    const db = twoVersions();
    const r = compareSnapshots(db, 0, 1)!;

    assert.deepEqual(r.muscles.map((m) => m.code), ['chest', 'back_lats', 'quads']);
    assert.deepEqual(r.muscles.map((m) => m.to_weekly_sets), [6, 5, 0]);
    assert.deepEqual(r.muscles.map((m) => m.name), ['胸', '背阔', '股四头']);

    const chest = r.muscles[0];
    assert.equal(chest.from_weekly_sets, 4);
    assert.equal(chest.delta_pct, 50);
    assert.equal(chest.from_verdict, 'stable');
    assert.equal(chest.to_verdict, 'rising');

    const quads = r.muscles.find((m) => m.code === 'quads')!;
    assert.equal(quads.delta_pct, -100);
    assert.equal(quads.to_verdict, null, 'to 报告没有该肌群趋势 → null');

    const back = r.muscles.find((m) => m.code === 'back_lats')!;
    assert.equal(back.delta_pct, null, 'from 为 0 → 变化率无意义 → null');

    assert.equal(r.summary.muscles_changed, 3);
  });

  it('findings：按 code|title 对齐 → added / removed', () => {
    const db = twoVersions();
    const r = compareSnapshots(db, 0, 1)!;
    assert.deepEqual(r.findings.added, [{ code: 'R-AG-07', severity: 'warn', title: '推拉失衡' }]);
    assert.deepEqual(r.findings.removed, [{ code: 'R-AG-03', severity: 'high', title: '胸不足' }]);
    assert.equal(r.summary.findings_added, 1);
    assert.equal(r.summary.findings_removed, 1);
  });

  it('版本不存在 → null', () => {
    const db = twoVersions();
    assert.equal(compareSnapshots(db, 0, 99), null);
    assert.equal(compareSnapshots(db, 99, 1), null);
  });
});

// ---------------------------------------------------------------------------
// 6) 路由
// ---------------------------------------------------------------------------

interface RouteOut {
  status: number;
  body: Record<string, unknown>;
}

async function callAnalysis(db: Db, method: string, url: string): Promise<RouteOut> {
  const req = Readable.from([]) as unknown as IncomingMessage;
  req.method = method;
  req.url = url;
  const pathname = url.split('?')[0];
  let status = 200;
  let body: Record<string, unknown> = {};
  const res = {
    writeHead(s: number) {
      status = s;
      return res;
    },
    end(buf?: Buffer | string) {
      body = buf === undefined ? {} : (JSON.parse(buf.toString('utf8')) as Record<string, unknown>);
      return res;
    },
  } as unknown as ServerResponse;
  try {
    const handled = await handleAnalysisRoutes(db)(req, res, pathname);
    assert.equal(handled, true);
  } catch (e) {
    assert.ok(e instanceof HttpError, `应抛 HttpError，实际 ${String(e)}`);
    return { status: (e as HttpError).status, body: { error: (e as HttpError).message } };
  }
  return { status, body };
}

describe('分析路由：latest / snapshots / snapshot / compare', () => {
  it('latest：无快照但存在 adhoc → 回退最新报告且 version_no=null', async () => {
    const db = freshDb();
    insertReport(db, { kind: 'adhoc', versionNo: null, generatedAt: '2026-06-01T00:00:00.000Z' });
    const out = await callAnalysis(db, 'GET', '/api/analysis/latest');
    assert.equal(out.status, 200);
    assert.equal(out.body.exists, true);
    assert.equal(out.body.version_no, null);
  });

  it('latest：有快照 → 返回最新快照；带 version_no → 返回指定版本', async () => {
    const db = freshDb();
    insertReport(db, { kind: 'snapshot', versionNo: 0, generatedAt: '2026-01-01T00:00:00.000Z' });
    insertReport(db, { kind: 'snapshot', versionNo: 1, generatedAt: '2026-02-01T00:00:00.000Z' });

    const latest = await callAnalysis(db, 'GET', '/api/analysis/latest');
    assert.equal(latest.body.version_no, 1);

    const v0 = await callAnalysis(db, 'GET', '/api/analysis/latest?version_no=0');
    assert.equal(v0.body.exists, true);
    assert.equal(v0.body.version_no, 0);

    const missing = await callAnalysis(db, 'GET', '/api/analysis/latest?version_no=42');
    assert.deepEqual(missing.body, { exists: false });

    const bad = await callAnalysis(db, 'GET', '/api/analysis/latest?version_no=abc');
    assert.equal(bad.status, 400);
  });

  it('GET /api/analysis/snapshots → versions 新 → 旧', async () => {
    const db = freshDb();
    insertReport(db, { kind: 'snapshot', versionNo: 0, generatedAt: '2026-01-01T00:00:00.000Z' });
    insertReport(db, { kind: 'snapshot', versionNo: 1, generatedAt: '2026-02-01T00:00:00.000Z' });
    const out = await callAnalysis(db, 'GET', '/api/analysis/snapshots');
    const versions = out.body.versions as Array<{ version_no: number }>;
    assert.deepEqual(versions.map((v) => v.version_no), [1, 0]);
  });

  it('compare：不存在 → 404；from===to → 400；正常 → 契约字段', async () => {
    const db = freshDb();
    insertReport(db, { kind: 'snapshot', versionNo: 0, generatedAt: '2026-01-01T00:00:00.000Z' });
    insertReport(db, { kind: 'snapshot', versionNo: 1, generatedAt: '2026-02-01T00:00:00.000Z' });

    const nf = await callAnalysis(db, 'GET', '/api/analysis/snapshots/compare?from=0&to=9');
    assert.equal(nf.status, 404);

    const same = await callAnalysis(db, 'GET', '/api/analysis/snapshots/compare?from=1&to=1');
    assert.equal(same.status, 400);

    const ok = await callAnalysis(db, 'GET', '/api/analysis/snapshots/compare?from=0&to=1');
    assert.equal(ok.status, 200);
    assert.ok(Array.isArray(ok.body.movements));
    assert.ok(Array.isArray(ok.body.muscles));
    assert.ok('summary' in ok.body);
  });

  it('POST /api/analysis/snapshot：无训练数据 → 400；有数据 → 落库版本 0 并立接管起点', async () => {
    const empty = freshDb();
    const noData = await callAnalysis(empty, 'POST', '/api/analysis/snapshot');
    assert.equal(noData.status, 400);
    assert.match(String(noData.body.error), /暂无训练数据/);

    const db = freshDb();
    seedSession(db, '2026-06-28');
    const out = await callAnalysis(db, 'POST', '/api/analysis/snapshot');
    assert.equal(out.status, 200);
    assert.equal(out.body.created, true);
    assert.equal(out.body.version_no, 0);
    assert.equal(listSnapshots(db).length, 1);
    const takeover = prepare(db, `SELECT value_json FROM app_config WHERE key = 'takeover'`).get() as unknown as
      | { value_json: string }
      | undefined;
    assert.ok(takeover !== undefined, '首次建立画像应写入接管起点');
  });

  it('POST /api/analysis/refresh：落库 kind=adhoc（不占版本号）', async () => {
    const db = freshDb();
    const out = await callAnalysis(db, 'POST', '/api/analysis/refresh');
    assert.equal(out.status, 200);
    const row = prepare(db, `SELECT kind, version_no FROM analysis_report WHERE id = ?`).get(
      Number(out.body.reportId),
    ) as unknown as {
      kind: string;
      version_no: number | null;
    };
    assert.equal(row.kind, 'adhoc');
    assert.equal(row.version_no, null);
    assert.equal(latestSnapshot(db), null, 'refresh 不能被画像页取到');
  });
});

// ---------------------------------------------------------------------------
// 6b) 周期末自动快照
// ---------------------------------------------------------------------------

describe('POST /api/cycle/close：关周期后产出一份 snapshot', () => {
  async function closeCycle(db: Db): Promise<RouteOut> {
    const req = Readable.from([]) as unknown as IncomingMessage;
    req.method = 'POST';
    req.url = '/api/cycle/close';
    let status = 200;
    let body: Record<string, unknown> = {};
    const res = {
      writeHead(s: number) {
        status = s;
        return res;
      },
      end(buf?: Buffer | string) {
        body = buf === undefined ? {} : (JSON.parse(buf.toString('utf8')) as Record<string, unknown>);
        return res;
      },
    } as unknown as ServerResponse;
    const handled = await handleCycleRoutes(db)(req, res, '/api/cycle/close');
    assert.equal(handled, true);
    return { status, body };
  }

  it('有训练数据 → snapshot 非 null，且库里存在一份 kind=snapshot', async () => {
    const db = freshDb();
    seedSession(db, '2026-06-28');
    openCycle(db, { goal_text: '着重练胸', first_week_start: '2026-06-01' });
    const out = await closeCycle(db);
    assert.equal(out.status, 200);
    assert.ok(out.body.closed, '关周期本身必须照常返回');
    assert.ok(out.body.snapshot !== null, '应产出一份快照');
    assert.equal(out.body.snapshot_error, null);
    assert.equal(listSnapshots(db).length, 1);
    assert.equal((out.body.snapshot as { version_no: number }).version_no, 0);
  });

  it('无训练数据 → snapshot=null + snapshot_error，但关周期仍 200', async () => {
    const db = freshDb();
    openCycle(db, { goal_text: '着重练胸', first_week_start: '2026-06-01' });
    const out = await closeCycle(db);
    assert.equal(out.status, 200, '快照失败绝不能影响关周期');
    assert.ok(out.body.closed);
    assert.equal(out.body.snapshot, null);
    assert.match(String(out.body.snapshot_error), /暂无训练数据/);
    assert.equal(listSnapshots(db).length, 0);
  });
});

// ---------------------------------------------------------------------------
// 迁移 v10：job_run.job_type 放行 report_prune
// ---------------------------------------------------------------------------

describe('迁移 v10：job_run.job_type CHECK 放行 report_prune', () => {
  it('可插入 report_prune 的 job_run；其他非法类型仍被拦', () => {
    const db = freshDb();
    const v = prepare(db, `SELECT MAX(version) AS v FROM schema_migration`).get() as unknown as { v: number };
    assert.ok(Number(v.v) >= 10, `schema 版本应至少到 v10，实际 ${Number(v.v)}`);

    prepare(
      db,
      `INSERT INTO job_run (job_type, status, triggered_by, started_at) VALUES ('report_prune', 'success', 'startup', ?)`,
    ).run(isoSeconds(NOW_MS));

    assert.throws(() => {
      prepare(db, `INSERT INTO job_run (job_type, status, triggered_by) VALUES ('nope', 'success', 'startup')`).run();
    }, /CHECK/i);
  });

  it('report_prune 经 JobRunner 端到端可跑通（v10 的 CHECK 放行真的生效）', async () => {
    const db = freshDb();
    for (let i = 0; i < 5; i++) {
      insertReport(db, { kind: 'adhoc', versionNo: null, generatedAt: `2026-01-0${i + 1}T00:00:00.000Z` });
    }
    const runner = new JobRunner(db, { db, dbPath: 'unused', engine: null, gw: null, aiModelTag: 'none' });
    const out = await runner.enqueue('report_prune', 'manual');
    assert.equal(out.status, 'success');
    assert.match(out.detail ?? '', /清理 adhoc 2 份 \/ snapshot 0 份/);
    // runner 为 ownsJobRun=false 的任务先插 job_run —— 这一步就是 v10 CHECK 放行的验证点
    const row = prepare(db, `SELECT job_type, status FROM job_run WHERE job_type = 'report_prune' ORDER BY id DESC LIMIT 1`).get() as
      | { job_type: string; status: string }
      | undefined;
    assert.ok(row !== undefined);
    assert.equal(row.status, 'success');
  });
});
