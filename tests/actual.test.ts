/**
 * V6 计划 vs 实际 测试。
 *
 * 这一层的口径容易写错，所以用例刻意压在几个边界上：
 *   - 同动作跨天出现 → 计划组数要累加
 *   - 「没做」与「做了但差一点」要区分（前者 weight_hit=null，后者 false）
 *   - 完成度用**有效组**算，且必须走全局唯一判据 isEffectiveSet（热身组 / 部分完成不算）
 *   - 计划外临时加练的动作不进 items（那是额外收益，不是欠账）
 *
 * 🔴 零真实网络：只读本地库。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { prepare, type Db } from '../server/db/index.js';
import { loadPlanActual } from '../server/plan/actual.js';
import { makeTempDb } from './fixtures.js';

const NOW = '2026-09-28T10:00:00.000Z';
/** 计划周 = 上周（loadPlanActual 的入参就是这一周的起点）。 */
const WEEK_START = '2026-09-28'; // 周一
const D_TUE = '2026-09-29'; // dow=2
const D_THU = '2026-10-01'; // dow=4

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

const CATALOG: Array<{ id: number; name: string }> = [
  { id: 101, name: '杠铃卧推' },
  { id: 102, name: '杠铃深蹲' },
  { id: 103, name: '罗马尼亚硬拉' },
  { id: 104, name: '绳索下压' }, // 只在「计划外加练」用例里出现
];

function seedCatalog(db: Db): void {
  for (const c of CATALOG) {
    prepare(
      db,
      'INSERT INTO movement_catalog (id, seq_no, name, name_norm, is_cardio, is_stretch, created_at) VALUES (?, ?, ?, ?, 0, 0, ?)',
    ).run(c.id, c.id, c.name, c.name, NOW);
  }
}

interface PlanDayDef {
  datestr: string;
  dow: number;
  exercises: Array<{ cid: number; name: string; sets: number; weight: number | null }>;
}

function seedPlan(db: Db, days: PlanDayDef[], status = 'approved'): number {
  const res = prepare(
    db,
    `INSERT INTO plan (week_start, week_end, version_no, status, source, ai_model_tag, ai_attempts, created_at, updated_at)
     VALUES (?, '2026-10-04', 1, ?, 'ai', 'http:deepseek-flash', 1, ?, ?)`,
  ).run(WEEK_START, status, NOW, NOW);
  const planId = Number(res.lastInsertRowid);
  days.forEach((d, di) => {
    const r = prepare(
      db,
      `INSERT INTO plan_day (plan_id, datestr, dow, ord, day_type, title, est_duration_min, est_sets, lock_state)
       VALUES (?, ?, ?, ?, '训练', ?, 60, ?, 'planned')`,
    ).run(planId, d.datestr, d.dow, di + 1, d.datestr, d.exercises.length);
    const dayId = Number(r.lastInsertRowid);
    d.exercises.forEach((e, ei) => {
      prepare(
        db,
        `INSERT INTO plan_exercise (plan_day_id, ord, catalog_id, name, sets, reps, weight_kg, weight_source, is_cardio, source)
         VALUES (?, ?, ?, ?, ?, 8, ?, 'history_best', 0, 'ai')`,
      ).run(dayId, ei + 1, e.cid, e.name, e.sets, e.weight);
    });
  });
  return planId;
}

let seq = 1;

/** 一次实际训练。`warmup` 组用来验证 isEffectiveSet 判据真的在生效。 */
function seedSession(
  db: Db,
  datestr: string,
  movements: Array<{
    cid: number;
    name: string;
    sets: Array<{ weight: number | null; reps: number; done?: 0 | 1; warmup?: 0 | 1 }>;
  }>,
): void {
  const localid = `L${seq++}`;
  const r1 = prepare(
    db,
    `INSERT INTO train_session
     (datestr, localid, title, duration_min, duration_src, is_outlier, is_rest, session_type, content_hash, synced_at)
     VALUES (?, ?, '训练', 70, 'start_end', 0, 0, 'strength', ?, ?)`,
  ).run(datestr, localid, `h:${localid}`, NOW);
  const sid = Number(r1.lastInsertRowid);
  movements.forEach((m, mi) => {
    const r2 = prepare(
      db,
      `INSERT INTO session_movement
       (session_id, ord, name_raw, name_norm, catalog_id, resolve_status, is_cardio, is_stretch, created_at)
       VALUES (?, ?, ?, ?, ?, 'exact', 0, 0, ?)`,
    ).run(sid, mi + 1, m.name, m.name, m.cid, NOW);
    const smid = Number(r2.lastInsertRowid);
    m.sets.forEach((st, si) => {
      prepare(
        db,
        `INSERT INTO movement_set (session_movement_id, ord, done, is_warmup, weight_kg, reps) VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(smid, si + 1, st.done ?? 1, st.warmup ?? 0, st.weight, st.reps);
    });
  });
}

/** 标准场景：卧推跨两天累计 7 组；深蹲 4 组；第二天没去。 */
function standardDb(): Db {
  const { db } = makeTempDb();
  seedCatalog(db);
  seedPlan(db, [
    {
      datestr: D_TUE,
      dow: 2,
      exercises: [
        { cid: 101, name: '杠铃卧推', sets: 4, weight: 62.5 },
        { cid: 102, name: '杠铃深蹲', sets: 4, weight: 90 },
      ],
    },
    { datestr: D_THU, dow: 4, exercises: [{ cid: 101, name: '杠铃卧推', sets: 3, weight: 62.5 }] },
  ]);
  seedSession(db, D_TUE, [
    // 卧推达成（4 组 @62.5）+ 1 组热身（不该计入）
    {
      cid: 101,
      name: '杠铃卧推',
      sets: [
        { weight: 40, reps: 10, warmup: 1 },
        { weight: 62.5, reps: 8 },
        { weight: 62.5, reps: 8 },
        { weight: 62.5, reps: 8 },
        { weight: 62.5, reps: 7 },
      ],
    },
    // 深蹲：少做 2 组，且重量差 5kg
    {
      cid: 102,
      name: '杠铃深蹲',
      sets: [
        { weight: 85, reps: 6 },
        { weight: 85, reps: 6 },
      ],
    },
  ]);
  return db;
}

// ---------------------------------------------------------------------------
// 用例
// ---------------------------------------------------------------------------

describe('V6：计划 vs 实际 · 基本对齐', () => {
  it('该周没有计划 → null', () => {
    const { db } = makeTempDb();
    assert.equal(loadPlanActual(db, WEEK_START), null);
  });

  it('archived 的计划不算数', () => {
    const { db } = makeTempDb();
    seedCatalog(db);
    seedPlan(db, [{ datestr: D_TUE, dow: 2, exercises: [{ cid: 101, name: '杠铃卧推', sets: 4, weight: 60 }] }], 'archived');
    assert.equal(loadPlanActual(db, WEEK_START), null);
  });

  it('同动作跨天出现时，计划组数累加', () => {
    const r = loadPlanActual(standardDb(), WEEK_START);
    assert.ok(r);
    const bench = r.items.find((i) => i.catalog_id === 101);
    assert.ok(bench);
    assert.equal(bench.plan_sets, 7, '4 组 + 3 组 = 7 组');
    assert.equal(bench.plan_weight_kg, 62.5);
  });

  it('实际组数只算有效组（热身组不进）', () => {
    const r = loadPlanActual(standardDb(), WEEK_START);
    assert.ok(r);
    const bench = r.items.find((i) => i.catalog_id === 101);
    assert.ok(bench);
    assert.equal(bench.actual_sets, 4, '5 组里 1 组是热身 → 4 组有效');
    assert.equal(bench.actual_best_kg, 62.5);
  });

  it('完成度 = 实际有效组 / 计划组数，status 按 0.8 分档', () => {
    const r = loadPlanActual(standardDb(), WEEK_START);
    assert.ok(r);
    const bench = r.items.find((i) => i.catalog_id === 101);
    const squat = r.items.find((i) => i.catalog_id === 102);
    assert.ok(bench && squat);
    assert.equal(bench.completion, 0.57, '4 / 7');
    assert.equal(bench.status, 'partial');
    assert.equal(squat.completion, 0.5, '2 / 4');
    assert.equal(squat.status, 'partial');
  });

  it('weight_hit：达到计划重量为 true，差 5kg 为 false', () => {
    const r = loadPlanActual(standardDb(), WEEK_START);
    assert.ok(r);
    assert.equal(r.items.find((i) => i.catalog_id === 101)?.weight_hit, true);
    assert.equal(r.items.find((i) => i.catalog_id === 102)?.weight_hit, false, '85 < 90 × 0.98');
  });

  it('周级：计划 2 天、实际出勤 1 天、漏掉的那天被列出', () => {
    const r = loadPlanActual(standardDb(), WEEK_START);
    assert.ok(r);
    assert.equal(r.planned_days, 2);
    assert.equal(r.trained_days, 1);
    assert.deepEqual(r.missed_days, [D_THU]);
    assert.equal(r.completion, 0.55, '(4 + 2) / (7 + 4) = 6/11');
  });
});

describe('V6：边界与陷阱', () => {
  it('一次都没做的动作 → status=missed，weight_hit=null（没做 ≠ 没达成）', () => {
    const { db } = makeTempDb();
    seedCatalog(db);
    seedPlan(db, [
      {
        datestr: D_TUE,
        dow: 2,
        exercises: [
          { cid: 101, name: '杠铃卧推', sets: 4, weight: 60 },
          { cid: 103, name: '罗马尼亚硬拉', sets: 3, weight: 80 },
        ],
      },
    ]);
    seedSession(db, D_TUE, [{ cid: 101, name: '杠铃卧推', sets: [{ weight: 60, reps: 8 }] }]);

    const r = loadPlanActual(db, WEEK_START);
    assert.ok(r);
    const rdl = r.items.find((i) => i.catalog_id === 103);
    assert.ok(rdl);
    assert.equal(rdl.status, 'missed');
    assert.equal(rdl.actual_sets, 0);
    assert.equal(rdl.weight_hit, null, '没做不能判成「未达成」');
    assert.equal(rdl.completion, 0);
  });

  it('计划外临时加练的动作不进 items', () => {
    const { db } = makeTempDb();
    seedCatalog(db);
    seedPlan(db, [{ datestr: D_TUE, dow: 2, exercises: [{ cid: 101, name: '杠铃卧推', sets: 4, weight: 60 }] }]);
    seedSession(db, D_TUE, [
      { cid: 101, name: '杠铃卧推', sets: [{ weight: 60, reps: 8 }] },
      { cid: 104, name: '绳索下压', sets: [{ weight: 25, reps: 12 }] }, // 计划里没有
    ]);

    const r = loadPlanActual(db, WEEK_START);
    assert.ok(r);
    assert.equal(r.items.length, 1);
    assert.equal(r.items[0].catalog_id, 101);
    assert.ok(!r.items.some((i) => i.catalog_id === 104), '额外练的不算欠账');
  });

  it('超额完成 → completion > 1 且 status=done', () => {
    const { db } = makeTempDb();
    seedCatalog(db);
    seedPlan(db, [{ datestr: D_TUE, dow: 2, exercises: [{ cid: 101, name: '杠铃卧推', sets: 3, weight: 60 }] }]);
    seedSession(db, D_TUE, [
      {
        cid: 101,
        name: '杠铃卧推',
        sets: [
          { weight: 60, reps: 8 },
          { weight: 60, reps: 8 },
          { weight: 60, reps: 8 },
          { weight: 60, reps: 6 },
          { weight: 60, reps: 5 },
        ],
      },
    ]);

    const r = loadPlanActual(db, WEEK_START);
    assert.ok(r);
    assert.equal(r.items[0].actual_sets, 5);
    assert.equal(r.items[0].completion, 1.67, '5 / 3，保留真实值不封顶');
    assert.equal(r.items[0].status, 'done');
  });

  it('未完成（done=0）的组不计入', () => {
    const { db } = makeTempDb();
    seedCatalog(db);
    seedPlan(db, [{ datestr: D_TUE, dow: 2, exercises: [{ cid: 101, name: '杠铃卧推', sets: 4, weight: 60 }] }]);
    seedSession(db, D_TUE, [
      {
        cid: 101,
        name: '杠铃卧推',
        sets: [
          { weight: 60, reps: 8 },
          { weight: 60, reps: 8 },
          { weight: 60, reps: 8, done: 0 },
          { weight: 60, reps: 8, done: 0 },
        ],
      },
    ]);

    const r = loadPlanActual(db, WEEK_START);
    assert.ok(r);
    assert.equal(r.items[0].actual_sets, 2);
  });

  it('2% 容差内算达成（吸收磅片 / 1.25kg 小片的小差）', () => {
    const { db } = makeTempDb();
    seedCatalog(db);
    seedPlan(db, [{ datestr: D_TUE, dow: 2, exercises: [{ cid: 101, name: '杠铃卧推', sets: 3, weight: 62.5 }] }]);
    seedSession(db, D_TUE, [
      { cid: 101, name: '杠铃卧推', sets: [{ weight: 61.5, reps: 8 }, { weight: 61.5, reps: 8 }, { weight: 61.5, reps: 8 }] },
    ]);

    const r = loadPlanActual(db, WEEK_START);
    assert.ok(r);
    assert.equal(r.items[0].weight_hit, true, '61.5 / 62.5 = 98.4% ≥ 98%');
  });

  it('计划里 catalog_id 为 null 的条目不会被误配（跳过而不是按名字猜）', () => {
    const { db } = makeTempDb();
    seedCatalog(db);
    // 手工插一条 catalog_id 为 NULL 的计划动作（真实路径不会产生，但历史数据可能）
    const planId = seedPlan(db, []);
    const r1 = prepare(
      db,
      `INSERT INTO plan_day (plan_id, datestr, dow, ord, day_type, title, lock_state)
       VALUES (?, ?, 2, 1, '训练', 'X', 'planned')`,
    ).run(planId, D_TUE);
    const dayId = Number(r1.lastInsertRowid);
    prepare(
      db,
      `INSERT INTO plan_exercise (plan_day_id, ord, catalog_id, name, sets, reps, is_cardio, source)
       VALUES (?, 1, NULL, '某个动作', 3, 8, 0, 'ai')`,
    ).run(dayId);
    seedSession(db, D_TUE, [{ cid: 101, name: '某个动作', sets: [{ weight: 50, reps: 8 }] }]);

    const r = loadPlanActual(db, WEEK_START);
    assert.ok(r);
    assert.equal(r.items.length, 0, 'catalog_id 为 null → 无法可靠对齐，跳过');
    assert.equal(r.completion, 0, '没有可对齐的计划条目 → 完成率为 0');
  });
});
