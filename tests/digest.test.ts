/**
 * 摘要层测试（V3）。
 *
 * 验收红线（PRD-v2 §10.1 V3）：**AI 输入 payload ≤ 15 KB**。
 * 这条红线的意义不是「现在恰好小」，而是「池子有上限、趋势有筛选」，
 * 所以下面的尺寸用例特意喂进一份 254 个动作的输入（=真实库规模），
 * 断言输出仍然被压到 15 KB 以内 —— 换一份更大的历史数据也不会破线。
 *
 * 🔴 零真实网络：本文件只调 buildPlanDigest（纯本地统计）。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { prepare, type Db } from '../server/db/index.js';
import { buildPlanDigest, digestByteSize, MAX_DIGEST_POOL } from '../server/ai/digest.js';
import { buildTemplateDraft } from '../server/plan/template.js';
import type {
  AnalysisReport,
  CandidatePoolItem,
  Constraints,
  GoalConstraints,
  HardRule,
} from '../server/analysis/reportSchema.js';
import { makeTempDb } from './fixtures.js';
import { shiftDays } from '../server/util/dates.js';
import { ANALYSIS_WINDOW_WEEKS } from '../server/analysis/window.js';

const NOW = '2026-10-01T12:00:00.000Z';
const WEEK_START = '2026-10-05'; // 周一

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

/**
 * 插一条周复盘（`weekly_review`）。2026-09-30 起「上周复盘结论」的来源就是它 ——
 * 4 周周期总结（`review` 表）那条链路已整体删除。
 */
function seedWeeklyReview(
  db: Db,
  weekStart: string,
  weekEnd: string,
  status: 'done' | 'draft',
  ai: { verdict: string; adjustments: string[]; note_reply: string },
): void {
  prepare(
    db,
    `INSERT INTO weekly_review (week_start, week_end, data_summary_json, ai_summary_json, status, ai_model_tag, generated_at)
     VALUES (?, ?, '{}', ?, ?, ?, ?)`,
  ).run(
    weekStart,
    weekEnd,
    status === 'done' ? JSON.stringify(ai) : null,
    status,
    status === 'done' ? 'http:test' : null,
    NOW,
  );
}

/** 真实库里的 22 条肌群（含 4 个聚合码与 cardio/stretch）。 */
function seedMuscleGroups(db: Db): void {
  const rows = JSON.parse(readFileSync(path.join(process.cwd(), 'seeds', 'muscle_groups.json'), 'utf8')) as Array<{
    code: string;
    name_zh: string;
    parent_code: string | null;
    region: string;
    size: string;
    sort_no: number;
  }>;
  const ins = prepare(
    db,
    'INSERT INTO muscle_group (code, name_zh, parent_code, region, size, sort_no) VALUES (?, ?, NULL, ?, ?, ?)',
  );
  for (const r of rows) ins.run(r.code, r.name_zh, r.region, r.size, r.sort_no);
  const upd = prepare(db, 'UPDATE muscle_group SET parent_code = ? WHERE code = ?');
  for (const r of rows) if (r.parent_code !== null) upd.run(r.parent_code, r.code);
}

/** 摘要层排除的肌群：聚合父码 + 非肌群（有氧/拉伸）。 */
const PARENT_CODES = ['back', 'arms', 'lower', 'shoulder'];
const NON_MUSCLES = ['cardio', 'stretch'];

interface CatalogDef {
  cid: number;
  name: string;
  muscles: Array<{ code: string; role: 'primary' | 'secondary'; weight?: number }>;
  joints?: Array<{ joint: string; level: number }>;
}

function seedCatalog(db: Db, defs: CatalogDef[]): void {
  for (const d of defs) {
    prepare(
      db,
      'INSERT INTO movement_catalog (id, seq_no, name, name_norm, is_cardio, is_stretch, created_at) VALUES (?, ?, ?, ?, 0, 0, ?)',
    ).run(d.cid, d.cid, d.name, d.name, NOW);
    for (const m of d.muscles) {
      prepare(
        db,
        `INSERT INTO movement_muscle_map (catalog_id, muscle_code, role, weight, source, confidence, updated_at)
         VALUES (?, ?, ?, ?, 'manual', 'high', ?)`,
      ).run(d.cid, m.code, m.role, m.weight ?? (m.role === 'primary' ? 1 : 0.5), NOW);
    }
    for (const j of d.joints ?? []) {
      prepare(
        db,
        `INSERT INTO movement_joint_flag (catalog_id, joint_code, stress_level, source, updated_at) VALUES (?, ?, ?, 'manual', ?)`,
      ).run(d.cid, j.joint, j.level, NOW);
    }
  }
}

let seq = 1;

/** 一个训练日：一次训练 + 若干动作 × 组。 */
function seedSession(
  db: Db,
  datestr: string,
  movements: Array<{ cid: number; name: string; sets: Array<{ weight: number; reps: number }> }>,
  durationMin = 70,
): void {
  const localid = `L${seq++}`;
  const res = prepare(
    db,
    `INSERT INTO train_session
     (datestr, localid, title, duration_min, duration_src, is_outlier, is_rest, session_type, content_hash, synced_at)
     VALUES (?, ?, '训练', ?, 'start_end', 0, 0, 'strength', ?, ?)`,
  ).run(datestr, localid, durationMin, `h:${localid}`, NOW);
  const sid = Number(res.lastInsertRowid);
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
        `INSERT INTO movement_set (session_movement_id, ord, done, is_warmup, weight_kg, reps) VALUES (?, ?, 1, 0, ?, ?)`,
      ).run(smid, si + 1, st.weight, st.reps);
    });
  });
}

/** 真实规模的报告：254 个动作 / 45 条动作趋势 / 全部肌群 / 6 条结论。 */
function bigReport(): AnalysisReport {
  const muscleCodes = [
    'chest',
    'back_upper',
    'back_lats',
    'shoulder_front',
    'shoulder_side',
    'shoulder_rear',
    'biceps',
    'triceps',
    'forearm',
    'quads',
    'hamstrings',
    'glutes',
    'calves',
    'core',
    'adductors',
    'hip_abductors',
  ];
  const pool: CandidatePoolItem[] = [];
  for (let i = 0; i < 254; i++) {
    const m = muscleCodes[i % muscleCodes.length];
    pool.push({
      catalog_id: 1000 + i,
      name: `动作${i}`,
      primary_muscles: [m, muscleCodes[(i + 1) % muscleCodes.length]],
      joint_flags: i % 7 === 0 ? [{ joint: 'lumbar', level: 2 }] : [],
      last_weight: i % 5 === 0 ? null : 20 + (i % 60),
      last_sets_reps: '4x8',
      used_recently: i % 3 === 0,
      mapping_confidence: i % 11 === 0 ? 'low' : 'high',
    });
  }
  const movement_trends = pool.slice(0, 45).map((p, i) => ({
    catalog_id: p.catalog_id,
    name: p.name,
    verdict: (['progress', 'plateau', 'regress', 'unstable', 'insufficient_data'] as const)[i % 5],
    weeks_with_data: 12 - (i % 6),
    first_weight: 40 + i,
    last_weight: 45 + i,
    delta_weight_pct: i % 2 === 0 ? 4.5 : -3.2,
    slope_weight_per_week: 0.2,
    avg_sets_per_week: 3.5,
    last_performed: shiftDays(WEEK_START, -3),
    volume_load_last: 3000,
  }));
  const muscle_volume: AnalysisReport['muscle_volume'] = {};
  const muscle_trends: AnalysisReport['muscle_trends'] = [];
  muscleCodes.forEach((code, i) => {
    if (i >= 14) return; // 最后两个肌群 12 周 0 组 → 该练没练到
    const seg0 = 10 - i * 0.5;
    muscle_volume[code] = { sets_total: seg0 * 4, sets_per_week_seg0: seg0, sets_per_week_seg1: seg0 + 1, sets_per_week_seg2: seg0 + 2 };
    muscle_trends.push({
      muscle_code: code,
      verdict: i < 3 ? 'insufficient' : i === 3 ? 'excess' : 'stable',
      seg0,
      seg1: seg0 + 1,
      seg2: seg0 + 2,
      delta_recent_pct: -5,
    });
  });
  return {
    schema_version: '1.0',
    generated_at: NOW,
    window: {
      trend_start: shiftDays(WEEK_START, -84),
      trend_end: shiftDays(WEEK_START, -1),
      recent_start: shiftDays(WEEK_START, -28),
      recent_end: shiftDays(WEEK_START, -1),
      weeks: ANALYSIS_WINDOW_WEEKS,
      last_session: {
        datestr: shiftDays(WEEK_START, -3),
        title: '推日',
        movements: [{ name: '动作1000', sets: 4, best_weight: 60 }],
      },
    },
    data_quality: {
      duration_coverage: 1,
      unmapped_set_ratio: 0,
      total_sessions: 31,
      synced_days: 84,
      warmup_source: 'server_set_type',
      warnings: [],
    },
    subjective_state: [],
    basic_stats: {
      total_sessions: 31,
      sessions_per_week: 3.1,
      avg_duration_min: 68,
      duration_median_min: 67,
      strength_sessions: 40,
      cardio_sessions: 3,
      total_effective_sets: 912,
      preferred_dows: [1, 3, 5, 0],
    },
    muscle_volume,
    movement_trends,
    muscle_trends,
    structure: { push_sets: 222, pull_sets: 170, push_pull_ratio: 1.3, upper_lower_ratio: 2.2, large_muscle_freq: {}, top_repeated_movements: [] },
    findings: [
      { code: 'R-AG-03', severity: 'high', title: '胸长期训练不足', detail: '周均有效组：近4周 6.2，前4周 7.8，连续两段低于阈值', evidence: { metric: 'sets_per_week', value: 6.2, window: '近8周' }, suggestion: '在该肌群所在训练日 +2~4 组' },
      { code: 'R-AG-03', severity: 'high', title: '上背长期训练不足', detail: '周均有效组：近4周 5.5，前4周 6.5，连续两段低于阈值', evidence: { metric: 'sets_per_week', value: 5.5, window: '近8周' }, suggestion: '在该肌群所在训练日 +2~4 组' },
      { code: 'R-AG-04', severity: 'warn', title: '肩前束训练量偏高且无进步', detail: '近4周周均 24 组（超阈值），且关联主项趋势为 plateau/regress', evidence: { metric: 'sets_per_week', value: 24, window: '近4周' }, suggestion: '该肌群 -20% 组数，观察 2 周' },
      { code: 'R-AG-05', severity: 'warn', title: '动作1000已停滞 9 周', detail: '重量变化 0.4%（近2周 vs 最早2周）', evidence: { metric: 'delta_weight_pct', value: 0.4, window: '近9周' }, suggestion: '换变体（如杠铃卧推→哑铃卧推）或改次数区间' },
      { code: 'R-AG-07', severity: 'warn', title: '推拉比 1.3 超出目标区间 0.8~1.25', detail: '推 222 组 / 拉 170 组（近12周有效组）', evidence: { metric: 'push_pull_ratio', value: 1.3, window: '近12周' }, suggestion: '调整分化，使比值回到 0.8~1.25' },
      { code: 'R-AG-16', severity: 'info', title: '训练时长离散度过大（σ/中位数 = 0.41 ≥ 0.35）', detail: '近12周时长标准差 28 分钟，中位数 67 分钟（n=31）', evidence: { metric: 'duration_cv', value: 0.41, window: '近12周' }, suggestion: '计划生成时按中位数而非上限排期' },
    ],
    constraints: { goal: null, hard_rules: [], soft_rules: [] },
    candidate_pool: pool,
    writing_rules: {
      max_trains_per_batch: 4,
      max_movements_per_train: 15,
      max_sets_per_movement: 20,
      same_day_per_batch: true,
      movement_name_must_come_from: 'candidate_pool',
      name_language: 'zh-CN 标准名',
    },
  };
}

const GOAL: GoalConstraints = {
  goal_type: '减脂保肌',
  sessions_per_week: 4,
  min_duration_min: 60,
  max_duration_min: 90,
  week_start_dow: 1,
  preferred_dows: [1, 3, 5, 0],
};

function freshDb(): Db {
  const { db } = makeTempDb();
  seedMuscleGroups(db);
  return db;
}

// ---------------------------------------------------------------------------
// 尺寸红线
// ---------------------------------------------------------------------------

describe('摘要层：payload 尺寸红线（≤15 KB）', () => {
  it('254 个动作 / 45 条趋势 → 摘要 ≤15 KB，池子被截到上限', () => {
    const db = freshDb();
    const report = bigReport();
    const digest = buildPlanDigest(db, { report, constraints: { goal: GOAL, hard_rules: [] }, weekStart: WEEK_START });

    const size = digestByteSize(digest);
    assert.ok(size <= 15 * 1024, `摘要必须 ≤15 KB，实际 ${(size / 1024).toFixed(1)} KB`);
    assert.ok(digest.candidate_pool.length <= MAX_DIGEST_POOL, `池子必须 ≤${MAX_DIGEST_POOL}，实际 ${digest.candidate_pool.length}`);
    // 旧版就是被这两项撑爆的（candidate_pool 47.7 KB + movement_trends 11.5 KB = 89%）
    assert.ok(digest.candidate_pool.length < report.candidate_pool.length, '池子必须被真正精简');
    console.log(`[digest] ${(size / 1024).toFixed(1)} KB（池 ${digest.candidate_pool.length} 条 / 原 ${report.candidate_pool.length} 条）`);
  });

  it('池子覆盖全部有数据的肌群，而不是只挑一个部位', () => {
    const db = freshDb();
    const digest = buildPlanDigest(db, {
      report: bigReport(),
      constraints: { goal: GOAL, hard_rules: [] },
      weekStart: WEEK_START,
    });
    const covered = new Set(digest.candidate_pool.flatMap((p) => p.primary_muscles));
    for (const code of ['chest', 'back_lats', 'quads', 'glutes', 'triceps']) {
      assert.ok(covered.has(code), `池子必须覆盖 ${code}`);
    }
    assert.equal(new Set(digest.candidate_pool.map((p) => p.catalog_id)).size, digest.candidate_pool.length, '不得重复');
  });
});

// ---------------------------------------------------------------------------
// 内容正确性
// ---------------------------------------------------------------------------

describe('摘要层：画像与本周切片', () => {
  it('画像：肌群基线来自 muscle_volume、名字来自 muscle_group、聚合码与非肌群被排除', () => {
    const db = freshDb();
    const digest = buildPlanDigest(db, {
      report: bigReport(),
      constraints: { goal: GOAL, hard_rules: [] },
      weekStart: WEEK_START,
    });
    const byCode = new Map(digest.profile.muscles.map((m) => [m.code, m]));
    assert.equal(byCode.get('chest')?.name, '胸');
    assert.equal(byCode.get('chest')?.weekly_sets, 10);
    assert.equal(byCode.get('chest')?.verdict, 'insufficient');
    for (const code of [...PARENT_CODES, ...NON_MUSCLES]) {
      assert.ok(!byCode.has(code), `${code} 不该出现在画像肌群里`);
    }
    assert.equal(digest.profile.habit.duration_median_min, 67, '排期按中位数');
    assert.equal(digest.profile.habit.goal_sessions_per_week, 4);
    assert.equal(digest.profile.structure.push_pull_ratio, 1.3);
  });

  it('该补 / 该减 / 该练没练到 分别来自 verdict 与「零数据」', () => {
    const db = freshDb();
    const digest = buildPlanDigest(db, {
      report: bigReport(),
      constraints: { goal: GOAL, hard_rules: [] },
      weekStart: WEEK_START,
    });
    // 列表按肌群码升序（与 profile.muscles 同序，便于人与模型对照）
    assert.deepEqual(digest.week.focus_muscles, ['back_lats', 'back_upper', 'chest']);
    assert.deepEqual(digest.week.reduce_muscles, ['shoulder_front']);
    assert.deepEqual(digest.week.untrained_muscles, ['adductors', 'hip_abductors']);
    // 找不到的肌群不该被当成「没练到」乱报
    assert.ok(!digest.week.untrained_muscles.includes('cardio'));
  });

  it('上周实际（最后一次训练所在周之后）从库里算，不依赖报告窗口', () => {
    const db = freshDb();
    seedCatalog(db, [
      { cid: 1, name: '杠铃卧推', muscles: [{ code: 'chest', role: 'primary' }] },
      { cid: 2, name: '杠铃深蹲', muscles: [{ code: 'quads', role: 'primary' }] },
    ]);
    // 计划周 2026-10-05 起 → 上一周 = 09-28 ~ 10-04
    seedSession(db, '2026-09-29', [{ cid: 1, name: '杠铃卧推', sets: [{ weight: 60, reps: 8 }, { weight: 60, reps: 8 }] }]);
    seedSession(db, '2026-10-01', [{ cid: 2, name: '杠铃深蹲', sets: [{ weight: 90, reps: 6 }] }]);
    seedSession(db, '2026-10-05', [{ cid: 1, name: '杠铃卧推', sets: [{ weight: 62, reps: 8 }] }]); // 计划周内 → 不算上周

    const digest = buildPlanDigest(db, {
      report: bigReport(),
      constraints: { goal: GOAL, hard_rules: [] },
      weekStart: WEEK_START,
    });
    assert.ok(digest.week.last_week, '必须算出上周实际');
    assert.equal(digest.week.last_week!.start, '2026-09-28');
    assert.equal(digest.week.last_week!.end, '2026-10-04');
    assert.equal(digest.week.last_week!.sessions, 2);
    assert.equal(digest.week.last_week!.effective_sets, 3);
    assert.equal(digest.week.last_week!.by_muscle['chest'], 2);
    assert.equal(digest.week.last_week!.by_muscle['quads'], 1);
  });

  it('上周完全没练 → last_week 为 null（而不是一堆 0）', () => {
    const db = freshDb();
    const digest = buildPlanDigest(db, {
      report: bigReport(),
      constraints: { goal: GOAL, hard_rules: [] },
      weekStart: WEEK_START,
    });
    assert.equal(digest.week.last_week, null);
  });

  /**
   * 2026-09-30 用户定案：总结**每周一次**（不是 4 周一次），
   * 所以「上周的复盘结论」来源是 `weekly_review` 里**计划周前一周**那一条。
   */
  it('上一周的周总结（done）→ 进本周输入', () => {
    const db = freshDb();
    seedWeeklyReview(db, '2026-09-28', '2026-10-04', 'done', {
      verdict: '这周达标，容量稳住了',
      adjustments: ['下周主项各加 2.5kg', '周三挪到周四'],
      note_reply: '收到',
    });
    const digest = buildPlanDigest(db, {
      report: bigReport(),
      constraints: { goal: GOAL, hard_rules: [] },
      weekStart: WEEK_START,
    });
    assert.equal(digest.week.last_review?.week_start, '2026-09-28');
    assert.equal(digest.week.last_review?.week_end, '2026-10-04');
    assert.equal(digest.week.last_review?.verdict, '这周达标，容量稳住了');
    assert.deepEqual(digest.week.last_review?.adjustments, ['下周主项各加 2.5kg', '周三挪到周四']);
  });

  it('只认「前一周」，不认「最近一次」——跳过一周没复盘时不拿两周前的话冒充上周', () => {
    const db = freshDb();
    // 两周前有一条 done，前一周没有
    seedWeeklyReview(db, '2026-09-21', '2026-09-27', 'done', {
      verdict: '两周前的结论',
      adjustments: ['两周前的建议'],
      note_reply: '',
    });
    const digest = buildPlanDigest(db, {
      report: bigReport(),
      constraints: { goal: GOAL, hard_rules: [] },
      weekStart: WEEK_START,
    });
    assert.equal(digest.week.last_review, null);
  });

  it('draft 状态的周总结不当作「上周复盘结论」', () => {
    const db = freshDb();
    seedWeeklyReview(db, '2026-09-28', '2026-10-04', 'draft', {
      verdict: '只有数据',
      adjustments: ['x'],
      note_reply: '',
    });
    const digest = buildPlanDigest(db, {
      report: bigReport(),
      constraints: { goal: GOAL, hard_rules: [] },
      weekStart: WEEK_START,
    });
    assert.equal(digest.week.last_review, null);
  });
});

describe('摘要层：候选池与趋势合并', () => {
  it('每条池子条目自带趋势判定（不再让 AI 按 id 手工对齐两个数组）', () => {
    const db = freshDb();
    const digest = buildPlanDigest(db, {
      report: bigReport(),
      constraints: { goal: GOAL, hard_rules: [] },
      weekStart: WEEK_START,
    });
    const withTrend = digest.candidate_pool.filter((p) => p.trend !== 'insufficient_data');
    assert.ok(withTrend.length > 0);
    assert.ok(withTrend.every((p) => typeof p.delta_pct === 'number' || p.delta_pct === null));
    assert.ok(withTrend.every((p) => p.weeks >= 3));
  });

  it('avoid 动作在进池前就被物理剔除（AI 根本看不到）', () => {
    const db = freshDb();
    const report = bigReport();
    const avoidName = report.candidate_pool[0].name;
    const hard_rules: HardRule[] = [
      { kind: 'avoid', target_type: 'movement', target_value: avoidName, reason: '受伤' },
    ];
    const digest = buildPlanDigest(db, { report, constraints: { goal: GOAL, hard_rules }, weekStart: WEEK_START });
    assert.ok(!digest.candidate_pool.some((p) => p.name === avoidName), 'avoid 动作不得进池');
    assert.equal(digest.constraints.hard_rules.length, 1);
  });

  it('关节限制：超限动作被剔除；池内条目的关节标记保留（V4 校验仍可追溯）', () => {
    const db = freshDb();
    seedCatalog(db, [
      { cid: 1, name: '危险硬拉', muscles: [{ code: 'back_lats', role: 'primary' }], joints: [{ joint: 'lumbar', level: 3 }] },
      { cid: 2, name: '安全划船', muscles: [{ code: 'back_lats', role: 'primary' }], joints: [{ joint: 'lumbar', level: 1 }] },
    ]);
    const report = bigReport();
    report.candidate_pool = [
      { catalog_id: 1, name: '危险硬拉', primary_muscles: ['back_lats'], joint_flags: [{ joint: 'lumbar', level: 3 }], last_weight: 100, last_sets_reps: '4x6', used_recently: true, mapping_confidence: 'high' },
      { catalog_id: 2, name: '安全划船', primary_muscles: ['back_lats'], joint_flags: [{ joint: 'lumbar', level: 1 }], last_weight: 50, last_sets_reps: '4x10', used_recently: true, mapping_confidence: 'high' },
    ];
    const hard_rules: HardRule[] = [{ kind: 'limit_load', target_type: 'joint', target_value: 'lumbar', param: { max_joint_stress_level: 2 } }];
    const digest = buildPlanDigest(db, { report, constraints: { goal: GOAL, hard_rules }, weekStart: WEEK_START });
    assert.deepEqual(digest.candidate_pool.map((p) => p.name), ['安全划船']);
    assert.deepEqual(digest.candidate_pool[0].joint_flags, [{ joint: 'lumbar', level: 1 }], '关节标记必须带进摘要');
  });

  it('旧快照（V3 之前生成的报告）不炸：缺 duration_median_min 时回退平均时长', () => {
    const db = freshDb();
    const report = bigReport();
    delete (report.basic_stats as { duration_median_min?: number }).duration_median_min;
    const digest = buildPlanDigest(db, { report, constraints: { goal: GOAL, hard_rules: [] }, weekStart: WEEK_START });
    assert.equal(digest.profile.habit.duration_median_min, 68, '回退到 avg_duration_min');
  });

  it('空报告（新库、没同步过）也能产出结构完整的摘要', () => {
    const db = freshDb();
    const report = bigReport();
    report.candidate_pool = [];
    report.movement_trends = [];
    report.muscle_volume = {};
    report.muscle_trends = [];
    report.findings = [];
    const digest = buildPlanDigest(db, { report, constraints: { goal: null, hard_rules: [] }, weekStart: WEEK_START });
    assert.deepEqual(digest.candidate_pool, []);
    assert.equal(digest.constraints.goal, null);
    assert.equal(digest.week.is_deload, false);
    assert.equal(digest.week.cycle_goal, null);
    assert.equal(digest.profile.muscles.length, 16, '肌群分类来自 muscle_group，与是否有数据无关');
    assert.equal(digest.week.untrained_muscles.length, 16, '一组都没有 → 全部算「没练到」');
    assert.ok(digestByteSize(digest) < 6 * 1024, '空摘要不该有任何体积负担');
  });
});

// ---------------------------------------------------------------------------
// 池子要够本周分化用
// ---------------------------------------------------------------------------

/**
 * 「够用」不是「覆盖了每个肌群」这么简单：同一个动作一周内不会排两次，
 * 所以「两个训练日都要练 glutes」实际需要两批不同的动作。
 *
 * 真实数据形状（实测）：全量目录里 glutes 34 / chest 33 / back_lats 39，
 * 但 quads 只有 4、hamstrings 只有 3、back_upper **一个都没有**（映射层就不产这个码）。
 * 下面这份夹具刻意做成「少而偏」，把「池子看起来覆盖了全部肌群、但要练的那天一个都挑不出来」
 * 这个真实退化钉住。
 */
function scarcePool(): CandidatePoolItem[] {
  const defs: Array<[string, string[]]> = [
    ['深蹲', ['glutes', 'quads']],
    ['保加利亚蹲', ['quads']],
    ['腿弯举', ['hamstrings']],
    ['早安', ['hamstrings']],
    ['杠铃卧推', ['chest']],
    ['哑铃推肩', ['shoulder_front']],
    ['V-Bar 绳索下压', ['triceps']],
    ['引体向上（辅助）', ['back_lats']],
    ['哑铃弯举', ['biceps']],
    ['负重悬挂抬腿', ['core']],
    ['仰卧起坐', ['core']],
    ['坐姿提踵', ['calves']],
    ['正手杠铃弯举', ['forearm']],
    ['侧平举', ['shoulder_side']],
    ['面拉', ['shoulder_rear']],
    ['坐姿髋内收', ['adductors']],
    ['坐姿髋外展', ['hip_abductors']],
  ];
  return defs.map(([name, muscles], i) => ({
    catalog_id: 5000 + i,
    name,
    primary_muscles: muscles,
    last_weight: 40,
    last_sets_reps: '4x8',
    used_recently: true,
    mapping_confidence: 'high' as const,
  }));
}

describe('摘要层：候选池要够本周分化用', () => {
  it('「一周要练两天」的肌群分到更多名额（4 练：glutes/chest/back_lats 各出现在两天）', () => {
    const db = freshDb();
    const digest = buildPlanDigest(db, {
      report: bigReport(),
      constraints: { goal: GOAL, hard_rules: [] },
      weekStart: WEEK_START,
    });
    const covered = new Map<string, number>();
    for (const p of digest.candidate_pool) {
      for (const mu of p.primary_muscles) covered.set(mu, (covered.get(mu) ?? 0) + 1);
    }
    for (const code of ['glutes', 'chest', 'back_lats']) {
      assert.ok(
        (covered.get(code) ?? 0) >= 3,
        `${code} 在 4 练分化里出现在两个训练日，至少要 3 个候选，实际 ${covered.get(code) ?? 0}`,
      );
    }
    for (const code of ['quads', 'hamstrings', 'shoulder_front', 'triceps', 'biceps']) {
      assert.ok((covered.get(code) ?? 0) >= 2, `${code} 至少要 2 个候选（当天要挑得出动作 + 留一个变体）`);
    }
  });

  it('池子被前几天的分化吃光时，训练日也不会残缺（宁可补别的部位，也不给半张计划）', () => {
    const db = freshDb();
    const report = bigReport();
    report.candidate_pool = scarcePool();
    report.movement_trends = [];
    const constraints: Constraints = { goal: GOAL, hard_rules: [], soft_rules: [] };
    const digest = buildPlanDigest(db, { report, constraints, weekStart: WEEK_START });
    const draft = buildTemplateDraft(WEEK_START, digest.candidate_pool, constraints, null);

    assert.equal(draft.days.length, 4);
    for (const day of draft.days) {
      assert.equal(day.exercises.length, 4, `${day.datestr}（${day.day_type}）必须有 4 个动作，实际 ${day.exercises.length}`);
    }
    // 第 4 天是「全身」，目标肌群（glutes/chest/back_lats）的动作已被前三天用完 →
    // 该用池里还没用过的动作补位，而不是留一个空训练日
    const day4 = draft.days[3];
    assert.ok(day4.exercises.length === 4);
    const weekNames = draft.days.flatMap((d) => d.exercises.map((e) => e.name));
    assert.equal(new Set(weekNames).size, 16, '池子还有没用过的动作时不得重复（重复只作为最后兜底）');
  });

  it('整池都用完（极小池子）→ 允许跨天复用，但每天仍满额', () => {
    const db = freshDb();
    const report = bigReport();
    report.candidate_pool = scarcePool().slice(0, 4);
    report.movement_trends = [];
    const constraints: Constraints = { goal: GOAL, hard_rules: [], soft_rules: [] };
    const digest = buildPlanDigest(db, { report, constraints, weekStart: WEEK_START });
    const draft = buildTemplateDraft(WEEK_START, digest.candidate_pool, constraints, null);
    for (const day of draft.days) {
      assert.equal(day.exercises.length, 4, `${day.datestr} 必须满额（可跨天复用），实际 ${day.exercises.length}`);
      const names = day.exercises.map((e) => e.name);
      assert.equal(new Set(names).size, names.length, `${day.datestr} 同一天内不得重复同一个动作`);
    }
  });

  it('池子比 4 个还少 → 能排几个排几个，不硬凑重复动作', () => {
    const db = freshDb();
    const report = bigReport();
    report.candidate_pool = scarcePool().slice(0, 3);
    report.movement_trends = [];
    const constraints: Constraints = { goal: GOAL, hard_rules: [], soft_rules: [] };
    const digest = buildPlanDigest(db, { report, constraints, weekStart: WEEK_START });
    const draft = buildTemplateDraft(WEEK_START, digest.candidate_pool, constraints, null);
    for (const day of draft.days) {
      assert.equal(day.exercises.length, 3, `${day.datestr} 池子里只有 3 个动作，最多排 3 个`);
      assert.ok(day.exercises.every((e) => digest.candidate_pool.some((p) => p.name === e.name)), '不得凭空造动作');
    }
  });
});
