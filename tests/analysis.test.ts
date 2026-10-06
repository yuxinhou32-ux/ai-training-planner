/**
 * 分析引擎单元测试（T2 第二阶段）。
 *
 * 🔴 红线：零真实网络。
 * v3：RPE 已从报告侧整体移除（PRD-v2 §11 决策 A）——本文件不再断言任何 RPE 字段。
 * 每个用例独立内存库，避免规则跨场景串扰。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { openMemoryDatabase, prepare, type Db } from '../server/db/index.js';
import { migrate } from '../server/db/migrate.js';
import { runAnalysis } from '../server/analysis/analysisService.js';
import { ANALYSIS_WINDOW_WEEKS, ANALYSIS_WINDOW_PRESET } from '../server/analysis/window.js';
import { round2 } from '../server/analysis/metrics.js';
import { SYNC_INITIAL_WEEKS } from '../server/config/constants.js';
import { shiftDays } from '../server/util/dates.js';

const TREND_END = '2026-09-29';
const NOW = '2026-09-29T12:00:00.000Z';

function freshDb(): Db {
  const db = openMemoryDatabase();
  migrate(db);
  return db;
}

let localidSeq = 1;

interface SeedSet {
  done?: boolean;
  warmup?: boolean;
  weight?: number | null;
  reps?: number | null;
  rpe?: number | null;
  timeS?: number | null;
}
interface SeedSm {
  cid?: number | null;
  name: string;
  isCardio?: boolean;
  isStretch?: boolean;
  restTimeS?: number | null;
  sets: SeedSet[];
}
interface SeedSession {
  datestr: string;
  durationMin?: number | null;
  isOutlier?: boolean;
  outlierReason?: string | null;
  note?: string | null;
  title?: string | null;
  movements: SeedSm[];
}

function seedSession(db: Db, s: SeedSession): number {
  const localid = `L${localidSeq++}`;
  const res = prepare(
    db,
    `INSERT INTO train_session
     (datestr, localid, title, note, duration_min, duration_src, is_outlier, outlier_reason, is_rest, session_type, content_hash, synced_at)
     VALUES (?, ?, ?, ?, ?, 'start_end', ?, ?, 0, 'strength', ?, ?)`,
  ).run(
    s.datestr,
    localid,
    s.title ?? null,
    s.note ?? null,
    s.durationMin ?? null,
    s.isOutlier ? 1 : 0,
    s.outlierReason ?? null,
    `h:${localid}`,
    NOW,
  );
  const sid = Number(res.lastInsertRowid);
  s.movements.forEach((m, mi) => {
    const r2 = prepare(
      db,
      `INSERT INTO session_movement
       (session_id, ord, name_raw, name_norm, catalog_id, resolve_status, is_cardio, is_stretch, rest_time_s, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      sid,
      mi + 1,
      m.name,
      m.name,
      m.cid ?? null,
      m.cid != null ? 'exact' : 'unresolved',
      m.isCardio ? 1 : 0,
      m.isStretch ? 1 : 0,
      m.restTimeS ?? null,
      NOW,
    );
    const smid = Number(r2.lastInsertRowid);
    m.sets.forEach((st, si) => {
      prepare(
        db,
        `INSERT INTO movement_set
         (session_movement_id, ord, done, is_warmup, warmup_source, weight_kg, reps, rpe, time_s)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        smid,
        si + 1,
        st.done === false ? 0 : 1,
        st.warmup ? 1 : 0,
        st.warmup ? 'server_set_type' : null,
        st.weight ?? null,
        st.reps ?? null,
        st.rpe ?? null,
        st.timeS ?? null,
      );
    });
  });
  return sid;
}

function seedMuscles(db: Db): void {
  const file = path.join(process.cwd(), 'seeds', 'muscle_groups.json');
  const rows = JSON.parse(readFileSync(file, 'utf8')) as Array<{
    code: string;
    name_zh: string;
    parent_code: string | null;
    region: string;
    size: string;
    sort_no: number;
  }>;
  const ins = prepare(db, 'INSERT INTO muscle_group (code, name_zh, parent_code, region, size, sort_no) VALUES (?, ?, NULL, ?, ?, ?)');
  for (const r of rows) ins.run(r.code, r.name_zh, r.region, r.size, r.sort_no);
  const upd = prepare(db, 'UPDATE muscle_group SET parent_code = ? WHERE code = ?');
  for (const r of rows) {
    if (r.parent_code !== null) upd.run(r.parent_code, r.code);
  }
}

interface SeedCatalogDef {
  cid: number;
  name: string;
  isCardio?: boolean;
  isStretch?: boolean;
  muscles?: Array<{ code: string; role: 'primary' | 'secondary'; weight?: number }>;
  pattern?: string;
  joints?: Array<{ joint: string; level: number }>;
}

function seedCatalog(db: Db, defs: SeedCatalogDef[]): void {
  for (const d of defs) {
    prepare(
      db,
      'INSERT INTO movement_catalog (id, seq_no, name, name_norm, is_cardio, is_stretch, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(d.cid, d.cid, d.name, d.name, d.isCardio ? 1 : 0, d.isStretch ? 1 : 0, NOW);
    for (const m of d.muscles ?? []) {
      prepare(
        db,
        `INSERT INTO movement_muscle_map (catalog_id, muscle_code, role, weight, source, confidence, updated_at)
         VALUES (?, ?, ?, ?, 'manual', 'high', ?)`,
      ).run(d.cid, m.code, m.role, m.weight ?? (m.role === 'primary' ? 1.0 : 0.5), NOW);
    }
    if (d.pattern) {
      prepare(
        db,
        `INSERT INTO movement_pattern_map (catalog_id, pattern, is_unilateral, source, confidence, updated_at)
         VALUES (?, ?, 0, 'manual', 'high', ?)`,
      ).run(d.cid, d.pattern, NOW);
    }
    for (const j of d.joints ?? []) {
      prepare(
        db,
        `INSERT INTO movement_joint_flag (catalog_id, joint_code, stress_level, source, updated_at) VALUES (?, ?, ?, 'manual', ?)`,
      ).run(d.cid, j.joint, j.level, NOW);
    }
  }
}

/** 每周一个训练日：weeksAgo = k → datestr = TREND_END - 7k 天。 */
function dateAtWeeksAgo(k: number): string {
  return shiftDays(TREND_END, -7 * k);
}

function findingCodes(report: ReturnType<typeof runAnalysis>['report']): string[] {
  return report.findings.map((f) => f.code);
}

describe('analysis/口径：有效组与 data_quality', () => {
  test('热身组/未打勾组/有氧/拉伸均不计有效组；肌群权重 primary 1.0 / secondary 0.5', () => {
    const db = freshDb();
    seedMuscles(db);
    seedCatalog(db, [
      { cid: 1, name: '杠铃卧推', muscles: [{ code: 'chest', role: 'primary' }, { code: 'triceps', role: 'secondary' }] },
      { cid: 2, name: '有氧训练', isCardio: true },
      { cid: 3, name: '拉伸放松', isStretch: true },
    ]);
    seedSession(db, {
      datestr: TREND_END,
      durationMin: 60,
      note: '昨晚睡眠很差，肩膀酸',
      movements: [
        {
          cid: 1,
          name: '杠铃卧推',
          restTimeS: 90,
          sets: [
            { weight: 60, reps: 8, timeS: 40 },
            { warmup: true, weight: 30, reps: 10 },
            { done: false, weight: 60, reps: 8 },
          ],
        },
        { cid: 2, name: '有氧训练', isCardio: true, sets: [{ timeS: 1200 }] },
        { cid: 3, name: '拉伸放松', isStretch: true, sets: [{ timeS: 60 }] },
      ],
    });

    const { report } = runAnalysis(db, { trendEnd: TREND_END, persist: false });
    assert.equal(report.basic_stats.total_effective_sets, 1);
    const chest = report.muscle_volume['chest'];
    const triceps = report.muscle_volume['triceps'];
    assert.ok(chest, 'chest 应在 muscle_volume');
    assert.equal(chest.sets_per_week_seg0, 0.25); // 1 组 × 1.0 / 4 周
    assert.ok(triceps, 'triceps 应在 muscle_volume');
    assert.equal(triceps.sets_per_week_seg0, 0.13); // 1 × 0.5 / 4 = 0.125，round2 四舍五入 → 0.13
    assert.equal(report.muscle_volume['cardio'], undefined);
    assert.equal(report.muscle_volume['stretch'], undefined);

    assert.equal(report.data_quality.duration_coverage, 1);
    assert.equal(report.data_quality.unmapped_set_ratio, 0);
    assert.equal(report.data_quality.warmup_source, 'server_set_type');

    assert.ok(report.window.last_session);
    assert.equal(report.window.last_session!.datestr, TREND_END);
    assert.equal(report.window.last_session!.movements.length, 3);
    const bench = report.window.last_session!.movements[0];
    assert.equal(bench.sets, 1);
    assert.equal(bench.best_weight, 60);

    // 红线：备注原文不得进入报告（§12.3-4）
    assert.ok(!JSON.stringify(report).includes('睡眠'));
  });
});

describe('analysis/口径：离群时长与未识别动作', () => {
  test('离群日剔除出时长均值但保留有效组；未识别组计入 unmapped_set_ratio', () => {
    const db = freshDb();
    seedMuscles(db);
    seedCatalog(db, [{ cid: 1, name: '杠铃卧推', muscles: [{ code: 'chest', role: 'primary' }] }]);
    seedSession(db, {
      datestr: TREND_END,
      durationMin: 15,
      isOutlier: true,
      outlierReason: 'too_short',
      movements: [{ cid: 1, name: '杠铃卧推', sets: [{ weight: 50, reps: 8 }, { weight: 50, reps: 8 }] }],
    });
    seedSession(db, {
      datestr: shiftDays(TREND_END, -1),
      durationMin: 90,
      movements: [{ cid: 1, name: '杠铃卧推', sets: [{ weight: 50, reps: 8 }] }],
    });
    seedSession(db, {
      datestr: shiftDays(TREND_END, -2),
      durationMin: 60,
      movements: [{ name: '神秘器械动作', sets: [{ weight: 20, reps: 10 }, { weight: 20, reps: 10 }, { weight: 20, reps: 10 }] }],
    });

    const { report } = runAnalysis(db, { trendEnd: TREND_END, persist: false });
    // 时长：离群 15min 剔除，avg = 90 与 60 的均值
    assert.equal(report.basic_stats.avg_duration_min, 75);
    assert.ok(report.data_quality.excluded_outliers!.some((o) => o.datestr === TREND_END && o.reason === 'too_short'));
    // 有效组保留：2 + 1 + 3 = 6
    assert.equal(report.basic_stats.total_effective_sets, 6);
    assert.equal(report.data_quality.unmapped_set_ratio, 0.5);
  });
});

describe('analysis/动作趋势（§4.2.1）', () => {
  test('重量持续上涨 → progress；单周数据 → insufficient_data；长期平稳 → plateau 且触发 R-AG-05', () => {
    const db = freshDb();
    seedMuscles(db);
    seedCatalog(db, [
      { cid: 10, name: '杠铃卧推', muscles: [{ code: 'chest', role: 'primary' }] },
      { cid: 11, name: '哑铃飞鸟', muscles: [{ code: 'chest', role: 'secondary' }] },
      { cid: 12, name: '器械推胸', muscles: [{ code: 'chest', role: 'primary' }] },
    ]);
    // progress：12 周，重量 50 → 61
    for (let k = 11; k >= 0; k--) {
      seedSession(db, {
        datestr: dateAtWeeksAgo(k),
        durationMin: 60,
        movements: [{ cid: 10, name: '杠铃卧推', restTimeS: 90, sets: [{ weight: 61 - k, reps: 8, timeS: 60 }] }],
      });
    }
    // insufficient：只有 1 周
    seedSession(db, {
      datestr: dateAtWeeksAgo(0),
      durationMin: 40,
      movements: [{ cid: 11, name: '哑铃飞鸟', sets: [{ weight: 10, reps: 12 }] }],
    });
    // plateau：10 周重量不变
    for (let k = 9; k >= 0; k--) {
      seedSession(db, {
        datestr: dateAtWeeksAgo(k),
        durationMin: 60,
        movements: [{ cid: 12, name: '器械推胸', restTimeS: 90, sets: [{ weight: 50, reps: 10, timeS: 60 }] }],
      });
    }

    const { report } = runAnalysis(db, { trendEnd: TREND_END, persist: false });
    const byId = new Map(report.movement_trends.map((m) => [m.catalog_id, m]));

    const prog = byId.get(10)!;
    assert.equal(prog.verdict, 'progress');
    assert.equal(prog.weeks_with_data, 12);
    assert.equal(prog.first_weight, 50.5);
    assert.equal(prog.last_weight, 60.5);
    assert.ok((prog.slope_weight_per_week ?? 0) > 0);

    assert.equal(byId.get(11)!.verdict, 'insufficient_data');

    const plat = byId.get(12)!;
    assert.equal(plat.verdict, 'plateau');
    assert.ok(findingCodes(report).includes('R-AG-05'), 'plateau 且 W≥6 应触发 R-AG-05');
  });

});

describe('analysis/肌群趋势（§4.2.2）', () => {
  test('insufficient / rising / excess（过量需叠加无进步）', () => {
    const db = freshDb();
    seedMuscles(db);
    seedCatalog(db, [
      { cid: 30, name: '腿举', muscles: [{ code: 'quads', role: 'primary' }] },
      { cid: 31, name: '杠铃划船', muscles: [{ code: 'back_lats', role: 'primary' }] },
      { cid: 32, name: '器械卧推', muscles: [{ code: 'chest', role: 'primary' }] },
    ]);
    // quads：seg0 0.5/周、seg1 0.5/周 → insufficient（大肌群阈值 8）
    seedSession(db, { datestr: dateAtWeeksAgo(0), durationMin: 60, movements: [{ cid: 30, name: '腿举', sets: [{ weight: 100, reps: 10 }, { weight: 100, reps: 10 }] }] });
    seedSession(db, { datestr: dateAtWeeksAgo(5), durationMin: 60, movements: [{ cid: 30, name: '腿举', sets: [{ weight: 100, reps: 10 }, { weight: 100, reps: 10 }] }] });
    // back_lats：seg0 10/周 vs seg1 5/周 → +100% → rising（seg0 ≥ 8 不判不足）
    seedSession(db, { datestr: dateAtWeeksAgo(0), durationMin: 60, movements: [{ cid: 31, name: '杠铃划船', sets: Array.from({ length: 40 }, () => ({ weight: 60, reps: 10 })) }] });
    seedSession(db, { datestr: dateAtWeeksAgo(5), durationMin: 60, movements: [{ cid: 31, name: '杠铃划船', sets: Array.from({ length: 20 }, () => ({ weight: 60, reps: 10 })) }] });
    // chest：seg0 25/周 > 22，且主项 10 周平稳（plateau）→ excess
    for (let k = 3; k >= 0; k--) {
      seedSession(db, {
        datestr: dateAtWeeksAgo(k),
        durationMin: 60,
        movements: [{ cid: 32, name: '器械卧推', restTimeS: 60, sets: Array.from({ length: 25 }, () => ({ weight: 60, reps: 10, timeS: 40 })) }],
      });
    }
    for (let k = 9; k >= 4; k--) {
      seedSession(db, {
        datestr: dateAtWeeksAgo(k),
        durationMin: 60,
        movements: [{ cid: 32, name: '器械卧推', restTimeS: 60, sets: [{ weight: 60, reps: 10, timeS: 40 }] }],
      });
    }

    const { report } = runAnalysis(db, { trendEnd: TREND_END, persist: false });
    const mt = new Map(report.muscle_trends.map((m) => [m.muscle_code, m]));
    assert.equal(mt.get('quads')!.verdict, 'insufficient');
    assert.equal(mt.get('back_lats')!.verdict, 'rising');
    assert.equal(mt.get('back_lats')!.delta_recent_pct, 100);
    assert.equal(mt.get('chest')!.verdict, 'excess');
    assert.ok(findingCodes(report).includes('R-AG-03'), 'quads 不足应触发 R-AG-03');
    assert.ok(findingCodes(report).includes('R-AG-04'), 'chest 过量无进步应触发 R-AG-04');
  });
});

describe('analysis/结构（§4.2.3）与 R-AG-07', () => {
  test('推拉比失衡触发 R-AG-07', () => {
    const db = freshDb();
    seedMuscles(db);
    seedCatalog(db, [
      { cid: 40, name: '杠铃卧推', muscles: [{ code: 'chest', role: 'primary' }], pattern: 'push' },
      { cid: 41, name: '杠铃划船', muscles: [{ code: 'back_lats', role: 'primary' }], pattern: 'pull' },
    ]);
    seedSession(db, {
      datestr: dateAtWeeksAgo(0),
      durationMin: 60,
      movements: [
        { cid: 40, name: '杠铃卧推', sets: Array.from({ length: 10 }, () => ({ weight: 60, reps: 8 })) },
        { cid: 41, name: '杠铃划船', sets: Array.from({ length: 4 }, () => ({ weight: 50, reps: 10 })) },
      ],
    });

    const { report } = runAnalysis(db, { trendEnd: TREND_END, persist: false });
    assert.equal(report.structure.push_sets, 10);
    assert.equal(report.structure.pull_sets, 4);
    assert.equal(report.structure.push_pull_ratio, 2.5);
    assert.equal(report.structure.upper_lower_ratio, null); // 无下肢 → 不判
    assert.ok(findingCodes(report).includes('R-AG-07'));
    assert.ok(report.structure.top_repeated_movements.length >= 2);
  });
});


describe('analysis/目标与数据质量提示（R-AG-16）', () => {
  const goalSessions = (): SeedSession[] =>
    [130, 50, 60, 100, 150, 140].map((dur, i) => ({
      datestr: dateAtWeeksAgo(i),
      durationMin: dur,
      movements: [{ cid: 60, name: '杠铃卧推', sets: [{ weight: 60, reps: 8 }] }],
    }));

  function seedGoal(db: Db): void {
    // 刻意写成自相矛盾的历史行（存储 4 练，但只选了 3 个训练日）—— 真实库里就是这样，
    // 用来钉住「计划链路读到的一周几练必须由训练日数量推导」这条修正。
    prepare(
      db,
      `INSERT INTO user_goal (goal_type, sessions_per_week, min_duration_min, max_duration_min, week_start_dow, preferred_dows, is_active, effective_from, created_at)
       VALUES ('fatloss_keep_strength', 4, 45, 60, 1, '[1,3,5]', 1, '2026-01-01', ?)`,
    ).run(NOW);
  }

  test('R-AG-16 时长离散度 + 目标透传进 constraints', () => {
    const db = freshDb();
    seedMuscles(db);
    seedCatalog(db, [{ cid: 60, name: '杠铃卧推', muscles: [{ code: 'chest', role: 'primary' }] }]);
    seedGoal(db);
    for (const s of goalSessions()) seedSession(db, s);

    const { report } = runAnalysis(db, { trendEnd: TREND_END, persist: false });
    const codes = findingCodes(report);
    // v3：R-AG-15（RPE 缺失提示）已删——每次必命中的噪声，不是结论
    assert.ok(!codes.includes('R-AG-15'), 'R-AG-15 已随报告侧 RPE 一起清掉');
    assert.ok(codes.includes('R-AG-16'), '时长 CV ≈ 0.37 ≥ 0.35 → R-AG-16');
    // 🔴 报告里的 constraints.goal 是 AI 的输入：一周几练必须 = 选中的训练日数量，
    // 不能是存储值。否则 AI 收到「排 4 天 + 只有一/三/五」，只能瞎猜第 4 天（实测撞库 500）。
    assert.equal(report.constraints.goal!.sessions_per_week, 3);
    assert.deepEqual(report.constraints.goal!.preferred_dows, [1, 3, 5]);
  });
});

describe('analysis/落库与报告不可变性（§4.6）', () => {
  test('每次分析生成新行；findings 落 analysis_finding；payload 可回读', () => {
    const db = freshDb();
    seedMuscles(db);
    seedCatalog(db, [{ cid: 1, name: '杠铃卧推', muscles: [{ code: 'chest', role: 'primary' }] }]);
    seedSession(db, {
      datestr: TREND_END,
      durationMin: 60,
      movements: [{ cid: 1, name: '杠铃卧推', sets: [{ weight: 60, reps: 8 }] }],
    });

    const r1 = runAnalysis(db, { trendEnd: TREND_END });
    const r2 = runAnalysis(db, { trendEnd: TREND_END });

    const cnt = prepare(db, 'SELECT COUNT(*) AS c FROM analysis_report').get() as unknown as { c: number };
    assert.equal(Number(cnt.c), 2, '报告不可变：重跑产生新行');
    const fcnt = prepare(db, 'SELECT COUNT(*) AS c FROM analysis_finding WHERE report_id = ?').get(r2.reportId) as unknown as {
      c: number;
    };
    assert.equal(Number(fcnt.c), r2.report.findings.length);
    const stored = prepare(db, 'SELECT payload_json FROM analysis_report WHERE id = ?').get(r2.reportId) as unknown as {
      payload_json: string;
    };
    const parsed = JSON.parse(stored.payload_json) as { schema_version: string; basic_stats: { total_sessions: number } };
    assert.equal(parsed.schema_version, '1.0');
    assert.equal(parsed.basic_stats.total_sessions, 1);
    assert.equal(r1.report.window.weeks, ANALYSIS_WINDOW_WEEKS);
  });
});

describe('analysis/窗口：默认 26 周（画像改半年）', () => {
  test('不传 weeks 时 window.weeks = ANALYSIS_WINDOW_WEEKS，trend_start 落在 26 周前的对齐日', () => {
    const db = freshDb();
    const END = '2026-06-30';
    const { report } = runAnalysis(db, { trendEnd: END, persist: false });
    assert.equal(report.window.weeks, ANALYSIS_WINDOW_WEEKS);
    assert.equal(ANALYSIS_WINDOW_WEEKS, 26);
    assert.equal(report.window.trend_end, END);
    assert.equal(report.window.trend_start, shiftDays(END, -(ANALYSIS_WINDOW_WEEKS * 7 - 1)));
    // 对照组：12 周口径的起点更晚 —— 确认窗口真的变长了
    assert.notEqual(report.window.trend_start, shiftDays(END, -83));
  });

  test('落库时 window_preset 绑定 ANALYSIS_WINDOW_PRESET（不再是写死的 w12）', () => {
    const db = freshDb();
    const { reportId } = runAnalysis(db, { trendEnd: '2026-06-30' });
    assert.ok(reportId !== null);
    const row = prepare(db, 'SELECT window_preset FROM analysis_report WHERE id = ?').get(reportId) as unknown as {
      window_preset: string;
    };
    assert.equal(row.window_preset, ANALYSIS_WINDOW_PRESET);
    assert.equal(ANALYSIS_WINDOW_PRESET, 'w26');
  });
});

describe('analysis/周均口径：分母是「实际覆盖周数」，不是名义窗口', () => {
  test('窗口 26 周但只有 3 周有训练 → sessions_per_week = n/3（不是 n/26），active_weeks = 3', () => {
    const db = freshDb();
    seedMuscles(db);
    seedCatalog(db, [{ cid: 1, name: '杠铃卧推', muscles: [{ code: 'chest', role: 'primary' }] }]);
    // 3 周内共 5 次训练（最早落在 2 周前 → active_weeks = 3）
    for (const off of [0, 1, 7, 8, 14]) {
      seedSession(db, {
        datestr: shiftDays(TREND_END, -off),
        durationMin: 60,
        movements: [{ cid: 1, name: '杠铃卧推', sets: [{ weight: 60, reps: 8 }] }],
      });
    }

    const { report } = runAnalysis(db, { trendEnd: TREND_END, persist: false });
    assert.equal(report.window.weeks, ANALYSIS_WINDOW_WEEKS, '名义窗口仍是 26 周');
    assert.equal(report.basic_stats.total_sessions, 5);
    assert.equal(report.basic_stats.active_weeks, 3, '实际覆盖周数 = 3');
    assert.equal(report.basic_stats.sessions_per_week, round2(5 / 3), '周均 = 5/3');
    assert.notEqual(report.basic_stats.sessions_per_week, round2(5 / ANALYSIS_WINDOW_WEEKS), '不能被 26 除');
    assert.equal(report.window.active_weeks, 3, 'window 上也带同一口径');
  });

  test('avg_sets_per_week 同样用实际覆盖周数作分母（不是窗口周数）', () => {
    const db = freshDb();
    seedMuscles(db);
    seedCatalog(db, [{ cid: 1, name: '杠铃卧推', muscles: [{ code: 'chest', role: 'primary' }] }]);
    // 3 周、每周 1 次、每次 2 组 → 6 组 / 3 周 = 2.0
    for (const off of [0, 7, 14]) {
      seedSession(db, {
        datestr: shiftDays(TREND_END, -off),
        durationMin: 60,
        movements: [{ cid: 1, name: '杠铃卧推', sets: [{ weight: 60, reps: 8 }, { weight: 60, reps: 8 }] }],
      });
    }

    const { report } = runAnalysis(db, { trendEnd: TREND_END, persist: false });
    assert.equal(report.basic_stats.active_weeks, 3);
    const t = report.movement_trends.find((m) => m.catalog_id === 1);
    assert.ok(t);
    assert.equal(t.avg_sets_per_week, 2, '6 组 / 3 周 = 2.0');
    assert.notEqual(t.avg_sets_per_week, round2(6 / ANALYSIS_WINDOW_WEEKS), '不能被 26 除');
  });

  test('窗口内无训练 → active_weeks 兜底 1（不做 0 除），周均 = 0', () => {
    const db = freshDb();
    const { report } = runAnalysis(db, { trendEnd: TREND_END, persist: false });
    assert.equal(report.basic_stats.total_sessions, 0);
    assert.equal(report.basic_stats.active_weeks, 1);
    assert.equal(report.basic_stats.sessions_per_week, 0);
  });
});

test('SYNC_INITIAL_WEEKS 由 ANALYSIS_WINDOW_WEEKS 派生（导入回溯必须 ≥ 分析窗口）', () => {
  assert.equal(SYNC_INITIAL_WEEKS, ANALYSIS_WINDOW_WEEKS);
  assert.ok(SYNC_INITIAL_WEEKS >= ANALYSIS_WINDOW_WEEKS, '回溯小于窗口 → 窗口后半段永远为空');
});
