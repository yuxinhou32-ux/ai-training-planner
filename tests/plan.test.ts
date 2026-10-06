/**
 * 计划层测试（T3 第二截）：planService + 规则模板。
 * 红线：零真实网络——gateway 用手工 mock（实现 AiGateway 接口），db 用临时文件全量迁移库。
 * v2：冲突检查（conflictService）与 AI 对话调整（adjustPlanWithInstruction）已砍除，对应用例一并删除。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { planDraftSchema } from '../server/ai/schemas.js';
import type { AiGateway, PlanDraft, PlanGenerationInput, PlanGenerationResult } from '../server/ai/schemas.js';
import type { PlanInputDigest } from '../server/ai/digest.js';
import { buildSummary } from '../server/ai/summaryBuilder.js';
import { templateFor } from '../server/plan/cycleTemplate.js';
import { openCycle } from '../server/cycle/cycleService.js';
import {
  PlanServiceError,
  createPlanFromAi,
  deleteExercise,
  getPlanIdForWeek,
  getPlanDetail,
  movePlanDay,
  nextMonday,
  nextWeekStart,
  planningWeekStart,
  regenerateTemplate,
  remainingTrainingDows,
  rebuildDraftFromDb,
  todayLocal,
  updateExercise,
} from '../server/plan/planService.js';
import { saveGoalSettings } from '../server/goal/goalService.js';
import type { AnalysisReport, Constraints, WritingRules } from '../server/analysis/reportSchema.js';
import { makeTempDb } from './fixtures.js';
import { ANALYSIS_WINDOW_PRESET } from '../server/analysis/window.js';
import { todayStr } from '../server/util/dates.js';
import type { Db } from '../server/db/index.js';

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

/** 肌群映射：1=卧推(chest/triceps) 2=深蹲(quads/glutes) 3=飞鸟(chest) 4=划船(back_lats/biceps) */
function seedMuscleMap(db: Db): void {
  // movement_catalog（plan_exercise.catalog_id / movement_muscle_map.catalog_id 的 FK 目标）
  const insC = db.prepare(
    `INSERT OR IGNORE INTO movement_catalog (id, seq_no, name, name_norm, segment_code, is_cardio, is_stretch, created_at)
     VALUES (?, ?, ?, ?, NULL, 0, 0, '2026-01-01T00:00:00Z')`,
  );
  insC.run(1, 1, '杠铃卧推', '杠铃卧推');
  insC.run(2, 2, '杠铃深蹲', '杠铃深蹲');
  insC.run(3, 3, '哑铃飞鸟', '哑铃飞鸟');
  insC.run(4, 4, '杠铃划船', '杠铃划船');
  insC.run(5, 5, '臀桥', '臀桥');
  insC.run(6, 6, '哑铃肩推', '哑铃肩推');
  insC.run(7, 7, '高位下拉', '高位下拉');
  // muscle_group 由目录导入（catalogService）填充；测试库只有 migrate，需手动补种子（FK：muscle_code 引用）
  const insG = db.prepare(
    `INSERT OR IGNORE INTO muscle_group (code, name_zh, parent_code, region, size, sort_no) VALUES (?, ?, NULL, ?, ?, 0)`,
  );
  insG.run('chest', '胸', 'upper', 'large');
  insG.run('triceps', '肱三头肌', 'upper', 'small');
  insG.run('quads', '股四头肌', 'lower', 'large');
  insG.run('glutes', '臀', 'lower', 'large');
  insG.run('back_lats', '背阔肌', 'upper', 'large');
  insG.run('biceps', '肱二头肌', 'upper', 'small');
  insG.run('shoulder_front', '三角肌前束', 'upper', 'small');
  const ins = db.prepare(
    `INSERT INTO movement_muscle_map (catalog_id, muscle_code, role, weight, source, confidence, confirmed, updated_at)
     VALUES (?, ?, ?, ?, 'manual', 'high', 1, '2026-01-01T00:00:00Z')`,
  );
  const rows: Array<[number, string, string, number]> = [
    [1, 'chest', 'primary', 1.0],
    [1, 'triceps', 'secondary', 0.5],
    [2, 'quads', 'primary', 1.0],
    [2, 'glutes', 'secondary', 0.5],
    [3, 'chest', 'primary', 1.0],
    [4, 'back_lats', 'primary', 1.0],
    [4, 'biceps', 'secondary', 0.5],
    [5, 'glutes', 'primary', 1.0],
    [6, 'shoulder_front', 'primary', 1.0],
    [7, 'back_lats', 'primary', 1.0],
    [7, 'biceps', 'secondary', 0.5],
  ];
  for (const [cid, code, role, w] of rows) ins.run(cid, code, role, w);
}

const CONSTRAINTS: Constraints = {
  goal: {
    goal_type: 'fatloss_keep_strength',
    sessions_per_week: 2,
    min_duration_min: 60,
    max_duration_min: 90,
    preferred_dows: [1, 3],
  },
  hard_rules: [
    { kind: 'keep', target_type: 'movement', target_value: '杠铃深蹲' },
    { kind: 'avoid', target_type: 'movement', target_value: '哑铃飞鸟' },
  ],
  soft_rules: [],
};

const WRITING_RULES: WritingRules = {
  max_trains_per_batch: 4,
  max_movements_per_train: 15,
  max_sets_per_movement: 20,
  same_day_per_batch: true,
  movement_name_must_come_from: 'candidate_pool',
  name_language: 'zh-CN 标准名',
};

const REPORT = {
  schema_version: '1.0',
  constraints: CONSTRAINTS,
  candidate_pool: [
    { catalog_id: 1, name: '杠铃卧推', primary_muscles: ['chest'], last_weight: 60, used_recently: true, mapping_confidence: 'high' },
    { catalog_id: 2, name: '杠铃深蹲', primary_muscles: ['quads', 'glutes'], last_weight: 90, used_recently: true, mapping_confidence: 'high' },
    { catalog_id: 3, name: '哑铃飞鸟', primary_muscles: ['chest'], last_weight: null, used_recently: false, mapping_confidence: 'high' },
    { catalog_id: 4, name: '杠铃划船', primary_muscles: ['back_lats'], last_weight: 50, used_recently: false, mapping_confidence: 'high' },
    { catalog_id: 5, name: '臀桥', primary_muscles: ['glutes'], last_weight: null, used_recently: false, mapping_confidence: 'high' },
    { catalog_id: 6, name: '哑铃肩推', primary_muscles: ['shoulder_front'], last_weight: 15, used_recently: false, mapping_confidence: 'high' },
    { catalog_id: 7, name: '高位下拉', primary_muscles: ['back_lats'], last_weight: 45, used_recently: false, mapping_confidence: 'high' },
  ],
  writing_rules: WRITING_RULES,
} as unknown as AnalysisReport;

function seedReport(db: Db): number {
  const r = db
    .prepare(
      `INSERT INTO analysis_report (window_start, window_end, window_preset, params_json, payload_json, payload_hash, generated_at)
       VALUES ('2025-10-06','2025-12-29','${ANALYSIS_WINDOW_PRESET}','{}',?, 'hash-test', '2026-01-04T12:00:00Z')`,
    )
    .run(JSON.stringify(REPORT));
  return Number(r.lastInsertRowid);
}

/**
 * 现算报告（planService 现在调 runAnalysis(persist:false)）要求至少有 1 天训练数据，
 * 否则会撞「暂无训练数据」守卫。这里种一天训练：目录 1~7 各一条有重量的有效组，
 * 让候选池的 last_weight / suggest_kg 不为 null（模板路径的重量断言依赖它）。
 */
function seedTrainingData(db: Db): void {
  const sid = Number(
    db
      .prepare(
        `INSERT INTO train_session (datestr, localid, content_hash, synced_at) VALUES (?, 'L-plan-seed', 'plan-seed', ?)`,
      )
      .run(todayStr(), '2026-01-01T00:00:00Z').lastInsertRowid,
  );
  const insSm = db.prepare(
    `INSERT INTO session_movement (session_id, ord, name_raw, name_norm, catalog_id, resolve_status, is_cardio, is_stretch, created_at)
     VALUES (?, ?, ?, ?, ?, 'manual', 0, 0, '2026-01-01T00:00:00Z')`,
  );
  const insSet = db.prepare(
    `INSERT INTO movement_set (session_movement_id, ord, done, is_warmup, weight_kg, reps) VALUES (?, 1, 1, 0, ?, 8)`,
  );
  const weighted: Array<[number, string, number]> = [
    [1, '杠铃卧推', 60],
    [2, '杠铃深蹲', 90],
    [3, '哑铃飞鸟', 20],
    [4, '杠铃划船', 50],
    [5, '臀桥', 40],
    [6, '哑铃肩推', 15],
    [7, '高位下拉', 45],
  ];
  weighted.forEach(([cid, name, w], i) => {
    const smId = Number(insSm.run(sid, i + 1, name, name, cid).lastInsertRowid);
    insSet.run(smId, w);
  });
}

/**
 * 用户硬约束落到 constraint_rule（原来是写在 analysis_report 夹具的 hard_rules 里）。
 * 现算报告必须从这张表读，否则 keep/avoid 会静默消失。
 */
function seedConstraintRules(db: Db): void {
  const ins = db.prepare(
    `INSERT INTO constraint_rule (kind, target_type, target_value, severity, is_active, created_at, updated_at)
     VALUES (?, 'movement', ?, 'hard', 1, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
  );
  ins.run('keep', '杠铃深蹲');
  ins.run('avoid', '哑铃飞鸟');
}

function planDb(): Db {
  const { db } = makeTempDb();
  seedMuscleMap(db);
  seedTrainingData(db);
  seedConstraintRules(db);
  seedReport(db);
  db.prepare(
    `INSERT INTO user_goal (goal_type, sessions_per_week, min_duration_min, max_duration_min, week_start_dow, preferred_dows, is_active, effective_from, created_at)
     VALUES ('fatloss_keep_strength', 2, 60, 90, 1, '[1,3]', 1, '2026-01-01', '2026-01-01T00:00:00Z')`,
  ).run();
  return db;
}

function mockGw(result: PlanGenerationResult): AiGateway {
  return {
    generatePlan: async () => result,
    explainPlan: async () => {
      throw new Error('explainPlan 不在本测试范围');
    },
    summarizeReview: async () => {
      throw new Error('summarizeReview 不在本测试范围');
    },
    summarizeWeek: async () => {
      throw new Error('summarizeWeek 不在本测试范围');
    },
  };
}

/** 两天草稿：胸日（卧推 4 组）+ 腿日（深蹲 4 组），重量取池内 last_weight。 */
function twoDayDraft(weekStart: string, weekEnd: string): PlanDraft {
  const d = new Date(`${weekStart}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 2);
  const day2 = d.toISOString().slice(0, 10);
  return {
    week_start: weekStart,
    week_end: weekEnd,
    days: [
      {
        datestr: weekStart,
        day_type: '上肢推',
        title: '上肢推',
        est_duration_min: 70,
        exercises: [
          { ord: 1, catalog_id: 1, name: '杠铃卧推', sets: 4, reps: 8, weight_kg: 60, weight_source: 'history_best', rest_s: 120, is_cardio: false, why: '主项' },
        ],
        why: { summary: '胸日', evidence_refs: [{ type: 'movement_trend', ref: 'movement_trend:1', text: '卧推平台期' }] },
      },
      {
        datestr: day2,
        day_type: '下肢力量',
        title: '下肢力量',
        est_duration_min: 75,
        exercises: [
          { ord: 1, catalog_id: 2, name: '杠铃深蹲', sets: 4, reps: 8, weight_kg: 90, weight_source: 'history_best', rest_s: 120, is_cardio: false, why: 'keep 动作' },
        ],
        why: { summary: '腿日', evidence_refs: [{ type: 'generic', ref: 'generic:plan', text: '通则' }] },
      },
    ],
  };
}

/**
 * 🔴 用**下一个完整周**而不是写死的日期（如原 `2026-01-05`）。
 *
 * V12（2026-10-05）起 `buildTemplateDraft` 会过滤「早于明天」的训练日 ——
 * 因为起始周只排本周剩下的几天。写死的过去日期会让这里的天数变成 0，
 * 用例一到那天就崩。锚到 `+7` 就永远不会过期（无论今天周几都严格晚于今天）。
 *
 * 下面所有断言里的具体某天都写成 `WEEK.start + n`（`WEEK_DAY` 工具）。
 */
const WEEK = { start: nextWeekStart(todayLocal(), 1), get end() { return WEEK_DAY(6); } };
function WEEK_DAY(offset: number): string {
  const d = new Date(`${WEEK.start}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// 日期工具
// ---------------------------------------------------------------------------

describe('nextMonday', () => {
  it('周三 → 下周一；周一 → 下下周临界取 +7', () => {
    assert.equal(nextMonday('2026-01-07'), '2026-01-12'); // 周三
    assert.equal(nextMonday('2026-01-05'), '2026-01-12'); // 周一 → 下周一
    assert.equal(nextMonday('2026-01-11'), '2026-01-12'); // 周日 → 明天
  });
});

describe('nextWeekStart（V1：周起点可选周一/周日）', () => {
  it('周一起点等价于 nextMonday', () => {
    assert.equal(nextWeekStart('2026-01-07', 1), '2026-01-12');
    assert.equal(nextWeekStart('2026-01-11', 1), '2026-01-12');
  });

  it('周日起点：总是取下一个周日', () => {
    assert.equal(nextWeekStart('2026-01-05', 0), '2026-01-11'); // 周一 → 本周日
    assert.equal(nextWeekStart('2026-01-10', 0), '2026-01-11'); // 周六 → 明天
    assert.equal(nextWeekStart('2026-01-11', 0), '2026-01-18'); // 周日 → 顺延一周（当天来不及走确认流程）
  });

  it('一周起始日非法值时退化为周一', () => {
    assert.equal(nextWeekStart('2026-01-07', 3), '2026-01-12');
  });
});

// ---------------------------------------------------------------------------
// V12：排计划的日期窗口（2026-10-05 用户定案）
//
// 用户原话：「例如今天其实是周一，但计划只能生成到下周的计划，这导致计划从 12 号开始。
//   我想的是可能我们可以例如这周二开始健身，然后我哪怕是周二没结束打开都可以生成本周的计划……
//   如果这个人是周三才开始使用这个软件的话，但希望即刻开始使用，我希望能够生成剩下的
//   几个训练日的计划（这个残缺的训练日在周期里不算一周）」
//
// 老实现 `nextWeekStart` 无条件 +7 —— 周一打开也只能排下周，本周剩下的训练日全浪费。
// 下面这些用例全部用**写死的日期**（不依赖跑测试那天），把「周中/周日/整周已过」都钉住。
// ---------------------------------------------------------------------------

describe('planningWeekStart / remainingTrainingDows（V12 日期窗口）', () => {
  // 2026-01-05 是周一；01-06 周二；01-07 周三；01-11 周日
  it('周一打开 → 排本周（back=0 无条件本周，整周都还没开始）', () => {
    assert.equal(planningWeekStart('2026-01-05', 1, [1, 3, 5]), '2026-01-05');
  });

  it('周二打开、训练日周二/周四/周五 → 排本周（还剩周二当天之后的日子）', () => {
    // 今天周二 = 01-06，训练日 2/4/5 → 还剩周四 01-08、周五 01-09
    assert.deepEqual(remainingTrainingDows('2026-01-06', 1, [2, 4, 5]), [4, 5]);
    assert.equal(planningWeekStart('2026-01-06', 1, [2, 4, 5]), '2026-01-05', '本周还有训练日 → 本周');
  });

  it('周三打开、训练日只有周二/周四 → 排本周，且只剩周四', () => {
    // 今天周三 = 01-07，训练日 2/4 → 周二已过，只剩周四 01-08
    assert.deepEqual(remainingTrainingDows('2026-01-07', 1, [2, 4]), [4]);
    assert.equal(planningWeekStart('2026-01-07', 1, [2, 4]), '2026-01-05');
  });

  it('今天的训练日不算「剩下的」—— 今天与过去一律不碰（与 PlanConfirm 写回窗口同一条红线）', () => {
    // 今天周二，训练日只有周二 → 本周已无可用天
    assert.deepEqual(remainingTrainingDows('2026-01-06', 1, [2]), []);
    assert.equal(planningWeekStart('2026-01-06', 1, [2]), '2026-01-12', '本周没得排了 → 顺延下周');
  });

  it('本周训练日已全过 → 顺延到下一个周起点', () => {
    // 今天周五 = 01-09，训练日 1/2/3 → 全过
    assert.deepEqual(remainingTrainingDows('2026-01-09', 1, [1, 2, 3]), []);
    assert.equal(planningWeekStart('2026-01-09', 1, [1, 2, 3]), '2026-01-12');
  });

  it('周日打开、训练日含周日 → 周日不算（明天起才算），顺延下周', () => {
    // 今天周日 = 01-11，训练日 0（周日）→ 今天这个不算
    assert.deepEqual(remainingTrainingDows('2026-01-11', 1, [0]), []);
    assert.equal(planningWeekStart('2026-01-11', 1, [0]), '2026-01-12');
  });

  it('周日起点（week_start_dow=0）：起算点是周日', () => {
    // 2026-01-11 是周日；训练日 [1,3] 还都在后面
    assert.deepEqual(remainingTrainingDows('2026-01-11', 0, [1, 3]), [1, 3]);
    assert.equal(planningWeekStart('2026-01-11', 0, [1, 3]), '2026-01-11', '今天就是起算点 → 本周');
  });

  it('没有训练日时：今天不是起算点就顺延（避免排出空气计划）', () => {
    assert.deepEqual(remainingTrainingDows('2026-01-07', 1, []), []);
    assert.equal(planningWeekStart('2026-01-07', 1, []), '2026-01-12');
  });

  it('返回的训练日去重且升序', () => {
    // 训练日给 [5,4,4,2]（乱序带重复）→ 结果 [4,5]
    assert.deepEqual(remainingTrainingDows('2026-01-06', 1, [5, 4, 4, 2]), [4, 5]);
  });

  it('and：与 nextWeekStart 的关系 —— 有剩余时早一周，没剩余时相等', () => {
    const today = '2026-01-07';
    assert.notEqual(planningWeekStart(today, 1, [2, 4]), nextWeekStart(today, 1), '还有训练日 → 比 +7 早一周');
    assert.equal(planningWeekStart(today, 1, [1, 2]), nextWeekStart(today, 1), '没训练日了 → 与 +7 一致');
  });
});

// ---------------------------------------------------------------------------
// 训练基础实时生效（V1）：排计划读设置页当前值，而不是报告生成时的冻结快照
// ---------------------------------------------------------------------------

describe('训练基础实时生效（V1）', () => {
  it('改「训练日」后重排计划立刻生效 —— 不等报告刷新', () => {
    const db = planDb();
    // 报告快照里冻结的是 2 天（planDb 的种子）
    const snapGoal = JSON.parse(
      (db.prepare(`SELECT payload_json FROM analysis_report ORDER BY id DESC LIMIT 1`).get() as unknown as { payload_json: string })
        .payload_json,
    ) as { constraints: { goal: { sessions_per_week: number } } };
    assert.equal(snapGoal.constraints.goal.sessions_per_week, 2);

    // 设置页把它改成 3 天（注意：这里**没有**重跑分析，快照仍是 2 天）
    saveGoalSettings(db, {
      goal_type: '减脂保肌',
      min_duration_min: 60,
      max_duration_min: 90,
      week_start_dow: 1,
      preferred_dows: [1, 3, 5],
    });

    const detail = regenerateTemplate(db, { weekStart: WEEK.start });
    assert.equal(detail.days.length, 3, '必须按设置页的 3 天排，而不是快照里的 2 天');
    assert.deepEqual(detail.days.map((d) => d.datestr), [WEEK_DAY(0), WEEK_DAY(2), WEEK_DAY(4)]);
  });

  it('改「每次时长」后手动编辑的重估用新区间', () => {
    const db = planDb();
    const detail = regenerateTemplate(db, { weekStart: WEEK.start });

    saveGoalSettings(db, {
      goal_type: '减脂保肌',
      min_duration_min: 30,
      max_duration_min: 45,
      week_start_dow: 1,
      preferred_dows: [1, 3],
    });

    const ex = detail.days[0].exercises[0];
    const after = updateExercise(db, detail.plan.id, ex.id, { sets: 4 });
    const est = after.days[0].est_duration_min ?? 0;
    assert.ok(est >= 30 && est <= 45, `重估时长应落在新区间 30~45，实际 ${est}（旧区间 60~90 会得 60）`);
  });

  it('一周起始日设为周日后，重排的周起点是周日、week_end = 起点 + 6', () => {
    const db = planDb();
    saveGoalSettings(db, {
      goal_type: '减脂保肌',
      min_duration_min: 60,
      max_duration_min: 90,
      week_start_dow: 0,
      preferred_dows: [0, 2],
    });
    // 显式给 weekStart，验证 week_end 与 datestr 换算。
    // 🔴 用一个**未来的周日**（写死的过去日期会被 V12 的「早于明天」过滤掉 → 排出 0 天）。
    const sunStart = ((): string => {
      const d = new Date(`${WEEK.start}T00:00:00Z`);
      d.setUTCDate(d.getUTCDate() + 6); // WEEK.start 是周一 → +6 = 周日
      return d.toISOString().slice(0, 10);
    })();
    const detail = regenerateTemplate(db, { weekStart: sunStart }); // 周日
    assert.equal(detail.plan.week_start, sunStart);
    assert.equal(detail.plan.week_end, WEEK_DAY(12));
    assert.deepEqual(detail.days.map((d) => d.datestr), [WEEK_DAY(6), WEEK_DAY(8)]);
  });
});

// ---------------------------------------------------------------------------
// regenerateTemplate（规则模板落库）
// ---------------------------------------------------------------------------

describe('regenerateTemplate', () => {
  it('落库 plan/plan_day/plan_exercise + summary + editLog；keep 排入、avoid 排除、输出过 planDraftSchema', () => {
    const db = planDb();
    const detail = regenerateTemplate(db, { weekStart: WEEK.start });

    assert.equal(detail.plan.status, 'draft');
    assert.equal(detail.plan.source, 'rule_fallback');
    assert.equal(detail.plan.ai_model_tag, 'rule_fallback');
    assert.equal(detail.plan.summary?.total_sessions, 2);
    assert.equal(detail.days.length, 2);
    assert.equal(detail.days[0].datestr, WEEK_DAY(0)); // preferred_dows [1,3]
    assert.equal(detail.days[1].datestr, WEEK_DAY(2));

    // keep 深蹲必须出现；avoid 飞鸟必须不出现
    const names = detail.days.flatMap((d) => d.exercises.map((e) => e.name));
    assert.ok(names.includes('杠铃深蹲'), `keep 深蹲应被排入，实际 ${JSON.stringify(names)}`);
    assert.ok(!names.includes('哑铃飞鸟'), 'avoid 飞鸟不得出现');

    // 模板 why 强制「依据不足」措辞
    assert.ok(detail.days.every((d) => d.why?.summary.includes('非 AI 生成')));
    const squat = detail.days.flatMap((d) => d.exercises).find((e) => e.name === '杠铃深蹲');
    assert.ok(squat?.why.includes('依据不足'));

    // 库行重建的 PlanDraft 必须能过 V5 strict schema（summary 重算吃的就是这个重建值）
    const rebuilt = rebuildDraftFromDb(db, detail.plan.id);
    const parsed = planDraftSchema.safeParse(rebuilt);
    assert.equal(parsed.success, true, parsed.success ? '' : JSON.stringify(parsed.error.issues, null, 2).slice(0, 800));

    // editLog
    const log = db.prepare(`SELECT actor, action FROM plan_edit_log WHERE plan_id = ?`).get(detail.plan.id) as { actor: string; action: string };
    assert.equal(log.actor, 'system');
    assert.equal(log.action, 'regenerate');

    // 第二次生成 → 同周单版本原地覆盖：plan id 不变、version_no 不递增、不产生 archived 行
    const firstId = detail.plan.id;
    const detail2 = regenerateTemplate(db, { weekStart: WEEK.start });
    assert.equal(detail2.plan.id, firstId);
    assert.equal(detail2.plan.version_no, 1);
    const rows = db.prepare(`SELECT id, status, version_no FROM plan ORDER BY id`).all() as unknown as Array<{
      id: number;
      status: string;
      version_no: number;
    }>;
    assert.equal(rows.length, 1, '同周只应保留一行（原地覆盖，不归档旧版）');
    assert.equal(rows[0].status, 'draft');
    assert.equal(getPlanIdForWeek(db, WEEK.start), firstId);
  });
});

// ---------------------------------------------------------------------------
// 训练基础「一周几练 × 训练日」的自相矛盾：计划链路必须自己把它归一
// ---------------------------------------------------------------------------

describe('一周几练与训练日矛盾的历史行（回归）', () => {
  /**
   * 历史数据里存在 `sessions_per_week=4` 与 `preferred_dows=[1,3,5]` 并存的行（CLI 种子写的）。
   * 计划链路读的是存储值，于是 AI 收到「必须排 4 天 + 偏好一/三/五」：
   * 模型只能自己瞎猜第 4 天 → 该天日期落回周起始日 → 与第 1 天撞 plan_day(plan_id, datestr)
   * 唯一约束 → 生成计划 500（V4 第一次真跑实测到的）。
   */
  it('AI 收到的一周几练 = 选中训练日数量，且落库不撞 plan_day 唯一约束', async () => {
    const db = planDb();
    db.prepare(`UPDATE user_goal SET sessions_per_week = 4, preferred_dows = '[1,3,5]' WHERE is_active = 1`).run();

    const captured: { seen: PlanInputDigest | null } = { seen: null };
    const gw: AiGateway = {
      generatePlan: async (input) => {
        captured.seen = input.digest;
        // 模拟一个「听话的模型」：按输入里给的训练日天数排，每天 1 个动作
        const goal = input.digest.constraints.goal!;
        const pool = input.digest.candidate_pool;
        const dows = goal.preferred_dows ?? [1, 3, 5];
        const days: PlanDraft['days'] = dows.map((dow, i) => {
          const off = (dow - 1 + 7) % 7;
          const dd = new Date(`${input.digest.week.week_start}T00:00:00Z`);
          dd.setUTCDate(dd.getUTCDate() + off);
          const p = pool[i % pool.length];
          return {
            datestr: dd.toISOString().slice(0, 10),
            day_type: '全身',
            title: `第 ${i + 1} 练`,
            est_duration_min: 70,
            exercises: [
              {
                ord: 1,
                catalog_id: p.catalog_id,
                name: p.name,
                sets: 4,
                reps: 8,
                weight_kg: p.last_weight,
                weight_source: p.last_weight === null ? ('estimate' as const) : ('history_best' as const),
                rest_s: 120,
                is_cardio: false,
                why: '主项',
              },
            ],
            why: { summary: 'x', evidence_refs: [{ type: 'generic', ref: 'generic:test', text: 't' }] },
          };
        });
        const draft: PlanDraft = { week_start: input.digest.week.week_start, week_end: input.digest.week.week_end, days };
        return { status: 'accepted', draft, summary: buildSummary(db, draft), warnings: [], clamped: [], attempts: 1 };
      },
      explainPlan: async () => {
        throw new Error('不在本测试范围');
      },
      summarizeReview: async () => {
        throw new Error('不在本测试范围');
      },
      summarizeWeek: async () => {
        throw new Error('不在本测试范围');
      },
    };

    const out = await createPlanFromAi(db, gw, 'http:test', { weekStart: '2026-10-05' });

    assert.ok(captured.seen, '网关必须收到输入');
    assert.equal(captured.seen!.constraints.goal!.sessions_per_week, 3, '一周几练必须由训练日数量推导');
    assert.deepEqual(captured.seen!.constraints.goal!.preferred_dows, [1, 3, 5]);

    const dates = db
      .prepare(`SELECT datestr FROM plan_day WHERE plan_id = ? ORDER BY ord`)
      .all(out.planId) as unknown as Array<{ datestr: string }>;
    assert.equal(dates.length, 3, '排出来的天数必须等于训练日数量，而不是存储的 4');
    assert.equal(new Set(dates.map((d) => d.datestr)).size, 3, '日期不得重复');
  });
});

// ---------------------------------------------------------------------------
// createPlanFromAi（accept / rule_fallback 双路）
// ---------------------------------------------------------------------------

describe('createPlanFromAi', () => {
  it('accepted：source=ai、审计字段与 editLog 正确', async () => {
    const db = planDb();
    const draft = twoDayDraft(WEEK.start, WEEK.end);
    const summary = buildSummary(db, draft);
    const gw = mockGw({
      status: 'accepted',
      draft,
      summary,
      warnings: [{ code: 'DURATION_OUT_OF_RANGE', datestr: WEEK.start, value: 100, range: [60, 90] }],
      clamped: [],
      attempts: 2,
    });
    const { planId, detail } = await createPlanFromAi(db, gw, 'test-model', { weekStart: WEEK.start });
    assert.equal(detail.plan.source, 'ai');
    assert.equal(detail.plan.ai_model_tag, 'test-model');
    assert.equal(detail.plan.ai_attempts, 2);
    assert.equal(detail.plan.warnings.length, 1);
    assert.deepEqual(detail.plan.summary, summary);
    const log = db.prepare(`SELECT actor, action, instruction FROM plan_edit_log WHERE plan_id = ?`).get(planId) as {
      actor: string;
      action: string;
      instruction: string;
    };
    assert.equal(log.actor, 'system');
    assert.match(log.instruction, /AI 生成（尝试 2 次）/);
  });

  it('rule_fallback：走规则模板，source/tag=rule_fallback，editLog 记录降级原因', async () => {
    const db = planDb();
    const gw = mockGw({ status: 'rule_fallback', reason: 'ai_unavailable', attempts: 1, lastViolations: [] });
    const { detail } = await createPlanFromAi(db, gw, 'test-model', { weekStart: WEEK.start });
    assert.equal(detail.plan.source, 'rule_fallback');
    assert.equal(detail.plan.ai_model_tag, 'rule_fallback');
    const log = db.prepare(`SELECT instruction FROM plan_edit_log WHERE plan_id = ?`).get(detail.plan.id) as { instruction: string };
    assert.match(log.instruction, /降级规则模板（ai_unavailable/);
  });
});

// ---------------------------------------------------------------------------
// updateExercise / deleteExercise
// ---------------------------------------------------------------------------

describe('updateExercise / deleteExercise', () => {
  async function seedSingleChestPlan(db: Db): Promise<number> {
    // 单日单动作：卧推 4 组 → chest=4，便于构造 >20% 变化
    const draft: PlanDraft = {
      week_start: WEEK.start,
      week_end: WEEK.end,
      days: [
        {
          datestr: WEEK.start,
          day_type: '上肢推',
          title: '上肢推',
          est_duration_min: 70,
          exercises: [
            { ord: 1, catalog_id: 1, name: '杠铃卧推', sets: 4, reps: 8, weight_kg: 60, weight_source: 'history_best', is_cardio: false, why: '主项' },
            { ord: 2, catalog_id: 4, name: '杠铃划船', sets: 3, reps: 12, weight_kg: 50, weight_source: 'history_best', is_cardio: false, why: '辅助' },
          ],
          why: { summary: 'x', evidence_refs: [] },
        },
      ],
    };
    const gw = mockGw({ status: 'accepted', draft, summary: buildSummary(db, draft), warnings: [], clamped: [], attempts: 1 });
    const r = await createPlanFromAi(db, gw, 'test-model', { weekStart: WEEK.start });
    return r.planId;
  }

  it('编辑组数 → summary 更新 + editLog(user)', async () => {
    const db = planDb();
    const planId = await seedSingleChestPlan(db);
    const detail = getPlanDetail(db, planId);
    const ex = detail.days[0].exercises.find((e) => e.name === '杠铃卧推');
    assert.ok(ex);

    const out = updateExercise(db, planId, ex.id, { sets: 1 });
    assert.equal(out.days[0].exercises[0].sets, 1);
    assert.ok(out.plan.summary && out.plan.summary.muscle_distribution['chest'] === 1);
    const log = db.prepare(`SELECT actor, action, field FROM plan_edit_log WHERE plan_id = ? ORDER BY id DESC LIMIT 1`).get(planId) as {
      actor: string;
      action: string;
      field: string;
    };
    assert.equal(log.actor, 'user');
    assert.equal(log.action, 'update');
    assert.match(log.field, /sets/);
  });

  it('改重量 → weight_source 变 user_input；清空 → 连带清空来源', async () => {
    const db = planDb();
    const planId = await seedSingleChestPlan(db);
    const ex = getPlanDetail(db, planId).days[0].exercises[0];
    updateExercise(db, planId, ex.id, { weight_kg: 65 });
    let row = db.prepare(`SELECT weight_kg, weight_source FROM plan_exercise WHERE id = ?`).get(ex.id) as {
      weight_kg: number | null;
      weight_source: string | null;
    };
    assert.equal(row.weight_kg, 65);
    assert.equal(row.weight_source, 'user_input');
    updateExercise(db, planId, ex.id, { weight_kg: null });
    row = db.prepare(`SELECT weight_kg, weight_source FROM plan_exercise WHERE id = ?`).get(ex.id) as {
      weight_kg: number | null;
      weight_source: string | null;
    };
    assert.equal(row.weight_kg, null);
    assert.equal(row.weight_source, null);
  });

  it('非法字段值 → 400；不存在的动作 → 404；非 draft → 409', async () => {
    const db = planDb();
    const planId = await seedSingleChestPlan(db);
    const ex = getPlanDetail(db, planId).days[0].exercises[0];
    assert.throws(() => updateExercise(db, planId, ex.id, { sets: 0 }), (e: unknown) => e instanceof PlanServiceError && e.status === 400);
    assert.throws(() => updateExercise(db, planId, 99999, { sets: 3 }), (e: unknown) => e instanceof PlanServiceError && e.status === 404);
    db.prepare(`UPDATE plan SET status = 'approved' WHERE id = ?`).run(planId);
    assert.throws(() => updateExercise(db, planId, ex.id, { sets: 3 }), (e: unknown) => e instanceof PlanServiceError && e.status === 409);
  });

  it('删除动作 → ord 重排连续 + editLog(delete)', async () => {
    const db = planDb();
    const planId = await seedSingleChestPlan(db);
    const exs = getPlanDetail(db, planId).days[0].exercises;
    const out = deleteExercise(db, planId, exs[0].id);
    const remain = out.days[0].exercises;
    assert.equal(remain.length, 1);
    assert.equal(remain[0].ord, 1); // 2 → 1 重排
    assert.equal(remain[0].name, '杠铃划船');
    const log = db.prepare(`SELECT actor, action FROM plan_edit_log WHERE plan_id = ? ORDER BY id DESC LIMIT 1`).get(planId) as {
      actor: string;
      action: string;
    };
    assert.equal(log.actor, 'user');
    assert.equal(log.action, 'delete');
  });

  it('跨天删除（删第 1 天的动作，后面还有多天）→ 重排按天独立，不撞 UNIQUE(plan_day_id, ord)', async () => {
    const db = planDb();
    // twoDayDraft：day1 卧推、day2 深蹲 → 删 day1 的卧推
    const gw = mockGw({
      status: 'accepted',
      draft: twoDayDraft(WEEK.start, WEEK.end),
      summary: buildSummary(db, twoDayDraft(WEEK.start, WEEK.end)),
      warnings: [],
      clamped: [],
      attempts: 1,
    });
    const { planId } = await createPlanFromAi(db, gw, 'test-model', { weekStart: WEEK.start });
    const day1Ex = getPlanDetail(db, planId).days[0].exercises[0];
    const out = deleteExercise(db, planId, day1Ex.id);

    assert.equal(out.days[0].exercises.length, 0);
    const day2 = out.days[1].exercises;
    assert.equal(day2.length, 1);
    assert.equal(day2[0].ord, 1); // 第 2 天的 ord 不被第 1 天的删除波及
    // summary 同步扣减：删前 8 组 → 删后 4 组
    assert.equal(out.plan.summary?.total_sets, 4);
    // editLog 有 delete 记录（修复点：以前事务外抛错会丢日志）
    const log = db.prepare(`SELECT action FROM plan_edit_log WHERE plan_id = ? AND action = 'delete'`).get(planId) as {
      action: string;
    };
    assert.ok(log);
  });
});

// ---------------------------------------------------------------------------
// V7：挪训练日
// ---------------------------------------------------------------------------

describe('movePlanDay（V7）', () => {
  /** 两天草稿：01-05 上肢推（卧推）+ 01-07 下肢力量（深蹲）。 */
  async function seedTwoDay(db: Db): Promise<number> {
    const draft = twoDayDraft(WEEK.start, WEEK.end);
    const gw = mockGw({ status: 'accepted', draft, summary: buildSummary(db, draft), warnings: [], clamped: [], attempts: 1 });
    const r = await createPlanFromAi(db, gw, 'test-model', { weekStart: WEEK.start });
    return r.planId;
  }

  it('移到空日：只改 datestr/dow，重排 ord，动作跟着走', async () => {
    const db = planDb();
    const planId = await seedTwoDay(db);
    const before = getPlanDetail(db, planId);
    const day1 = before.days[0];
    assert.equal(day1.datestr, WEEK_DAY(0));

    const out = movePlanDay(db, planId, day1.id, WEEK_DAY(1));

    assert.equal(out.days.length, 2);
    assert.deepEqual(
      out.days.map((d) => [d.datestr, d.title, d.ord]),
      [
        [WEEK_DAY(1), '上肢推', 1],
        [WEEK_DAY(2), '下肢力量', 2],
      ],
    );
    // dow 跟着日期走（01-06 是周二 = 2）
    assert.equal(out.days[0].dow, 2);
    // 动作内容原样跟着这一天走（没有落到别的天上）
    assert.equal(out.days[0].exercises[0].name, '杠铃卧推');
    assert.equal(out.days[0].exercises[0].catalog_id, 1);
    // 原位置 01-05 已空
    assert.ok(!out.days.some((d) => d.datestr === WEEK_DAY(0)));
  });

  it('移到已占用日 → 交换：两边日期对调、内容不丢、ord 与 dow 重排', async () => {
    const db = planDb();
    const planId = await seedTwoDay(db);
    const before = getPlanDetail(db, planId);
    const day1 = before.days[0]; // 01-05 上肢推
    const day2 = before.days[1]; // 01-07 下肢力量

    const out = movePlanDay(db, planId, day1.id, WEEK_DAY(2));

    assert.deepEqual(
      out.days.map((d) => [d.datestr, d.title, d.ord, d.dow, d.exercises[0].name]),
      [
        [WEEK_DAY(0), '下肢力量', 1, 1, '杠铃深蹲'],
        [WEEK_DAY(2), '上肢推', 2, 3, '杠铃卧推'],
      ],
    );
    // id 没变（是同一批 plan_day 换了位置，不是删了重建）
    assert.deepEqual(out.days.map((d) => d.id).sort(), [day1.id, day2.id].sort());
    // 中间态日期必须已经被清掉，不能留在库里
    const stray = db.prepare(`SELECT COUNT(*) AS n FROM plan_day WHERE datestr = '0001-01-01'`).get() as { n: number };
    assert.equal(Number(stray.n), 0);
  });

  it('挪到自己那天 → 幂等返回当前详情，不报错、不写 editLog', async () => {
    const db = planDb();
    const planId = await seedTwoDay(db);
    const day1 = getPlanDetail(db, planId).days[0];
    const logCountBefore = (db.prepare(`SELECT COUNT(*) AS n FROM plan_edit_log WHERE plan_id = ?`).get(planId) as { n: number }).n;
    const out = movePlanDay(db, planId, day1.id, day1.datestr);
    assert.equal(out.days[0].datestr, WEEK_DAY(0));
    const logCountAfter = (db.prepare(`SELECT COUNT(*) AS n FROM plan_edit_log WHERE plan_id = ?`).get(planId) as { n: number }).n;
    assert.equal(Number(logCountAfter), Number(logCountBefore));
  });

  it('写出 editLog(user, day, datestr) 并可回溯交换对象', async () => {
    const db = planDb();
    const planId = await seedTwoDay(db);
    const day1 = getPlanDetail(db, planId).days[0];
    movePlanDay(db, planId, day1.id, WEEK_DAY(2));
    const log = db
      .prepare(`SELECT actor, action, target_type, target_id, field, before_json, after_json FROM plan_edit_log WHERE plan_id = ? ORDER BY id DESC LIMIT 1`)
      .get(planId) as {
      actor: string;
      action: string;
      target_type: string;
      target_id: number;
      field: string;
      before_json: string;
      after_json: string;
    };
    assert.equal(log.actor, 'user');
    assert.equal(log.action, 'update');
    assert.equal(log.target_type, 'day');
    assert.equal(Number(log.target_id), day1.id);
    assert.equal(log.field, 'datestr');
    assert.equal(JSON.parse(log.before_json).datestr, WEEK_DAY(0));
    const after = JSON.parse(log.after_json) as { datestr: string; swapped: boolean };
    assert.equal(after.datestr, WEEK_DAY(2));
    assert.equal(after.swapped, true);
  });

  it('summary_json 随挪动重算并落库（不是只改了内存）', async () => {
    const db = planDb();
    const planId = await seedTwoDay(db);
    const day1 = getPlanDetail(db, planId).days[0];
    movePlanDay(db, planId, day1.id, WEEK_DAY(1));
    const row = db.prepare(`SELECT summary_json FROM plan WHERE id = ?`).get(planId) as { summary_json: string | null };
    const summary = JSON.parse(row.summary_json ?? 'null') as { total_sessions: number; total_sets: number } | null;
    assert.ok(summary);
    assert.equal(summary.total_sessions, 2);
    assert.equal(summary.total_sets, 8); // 两组各 4 组
  });

  it('越界日期 → 400；非 draft → 409；不存在的训练日 → 404', async () => {
    const db = planDb();
    const planId = await seedTwoDay(db);
    const day1 = getPlanDetail(db, planId).days[0];

    // 周外（WEEK = 2026-01-05 ~ 2026-01-11）
    assert.throws(
      () => movePlanDay(db, planId, day1.id, WEEK_DAY(7)),
      (e: unknown) => e instanceof PlanServiceError && e.status === 400,
    );
    // 格式错
    assert.throws(
      () => movePlanDay(db, planId, day1.id, '2026/01/06'),
      (e: unknown) => e instanceof PlanServiceError && e.status === 400,
    );
    // 训练日不属于这份计划
    assert.throws(
      () => movePlanDay(db, planId, 99999, WEEK_DAY(1)),
      (e: unknown) => e instanceof PlanServiceError && e.status === 404,
    );
    // 批准后锁定
    db.prepare(`UPDATE plan SET status = 'approved' WHERE id = ?`).run(planId);
    assert.throws(
      () => movePlanDay(db, planId, day1.id, WEEK_DAY(1)),
      (e: unknown) => e instanceof PlanServiceError && e.status === 409,
    );
  });

  it('交换第一步撞 UNIQUE 时整体回滚：两个训练日都没动、事务干净退出', async () => {
    const db = planDb();
    const planId = await seedTwoDay(db);
    const day1 = getPlanDetail(db, planId).days[0];
    // 提前占住交换用的中间态日期 → 交换的第一步 UPDATE 必然撞 UNIQUE(plan_id, datestr)。
    // 这是唯一能真的把事务推进到「中途抛错」的方式（正常路径不会失败），
    // 用来证明 catch → ROLLBACK 之后库里没有半态。
    db.prepare(
      `INSERT INTO plan_day (plan_id, datestr, dow, ord, title, lock_state) VALUES (?, '0001-01-01', 0, 99, '占位', 'planned')`,
    ).run(planId);

    assert.throws(() => movePlanDay(db, planId, day1.id, WEEK_DAY(2)));
    const dates = (
      db.prepare(`SELECT datestr FROM plan_day WHERE plan_id = ? AND datestr <> '0001-01-01' ORDER BY datestr`).all(planId) as Array<{
        datestr: string;
      }>
    ).map((r) => r.datestr);
    assert.deepEqual(dates, [WEEK_DAY(0), WEEK_DAY(2)]);
    // 事务没被留在打开状态：能正常执行新的写操作
    db.prepare(`UPDATE plan SET status = 'draft' WHERE id = ?`).run(planId);
  });
});


describe('getPlanDetail / getPlanIdForWeek', () => {
  it('无计划 → null；详情含 warnings 解析与报告关联', async () => {
    const db = planDb();
    assert.equal(getPlanIdForWeek(db, WEEK.start), null);
    const gw = mockGw({ status: 'accepted', draft: twoDayDraft(WEEK.start, WEEK.end), summary: buildSummary(db, twoDayDraft(WEEK.start, WEEK.end)), warnings: [{ code: 'DURATION_OUT_OF_RANGE', datestr: WEEK.start, value: 95, range: [60, 90] }], clamped: [], attempts: 3 });
    const { planId } = await createPlanFromAi(db, gw, 'test-model', { weekStart: WEEK.start });
    const detail = getPlanDetail(db, planId);
    assert.equal(String(detail.plan.warnings[0]?.code), 'DURATION_OUT_OF_RANGE');
    assert.equal(detail.plan.report_id, 1);
    assert.ok((detail.days[0]?.why?.summary.length ?? 0) > 0);
  });

  /**
   * 回归：首页整页讲「下一周」，`/api/plans/current` 曾经按「最新一份计划」取 ——
   * 用户隔一周没生成时，端上来的是**上一周**那份，卡片标题就成了「下周计划 · <上周日期>」，
   * 而「重新生成」是按下一周排的：看到的和会改的差一周。
   */
  it('按周取：隔一周没生成 → 旧周有、下一周为 null（不会拿旧周冒充下周）', async () => {
    const db = planDb();
    const gw = mockGw({ status: 'accepted', draft: twoDayDraft(WEEK.start, WEEK.end), summary: buildSummary(db, twoDayDraft(WEEK.start, WEEK.end)), warnings: [], clamped: [], attempts: 1 });
    await createPlanFromAi(db, gw, 'test-model', { weekStart: WEEK.start });

    assert.notEqual(getPlanIdForWeek(db, WEEK.start), null);
    assert.equal(getPlanIdForWeek(db, nextWeekStart(WEEK.start, 1)), null, '下一周还没生成 → 必须是 null');
  });

  it('archived 不算数（同周只剩归档行 = 没有计划）', () => {
    const db = planDb();
    db.prepare(`UPDATE plan SET status = 'archived' WHERE id = 1`).run();
    assert.equal(getPlanIdForWeek(db, WEEK.start), null);
  });
});

// ---------------------------------------------------------------------------
// 周期模板复用（2026-09-30 用户定案：「周期内同一个模板」，省 token）
// ---------------------------------------------------------------------------

/**
 * 🔴 两个**未来**周（相对跑测试那天）—— 与 `WEEK` 同一套时间锚。
 *
 * V12 起 `buildTemplateDraft` 会丢掉「早于明天」的训练日（起始周只排本周剩下的几天）。
 * 原来写死的 `2026-01-05` 是过去时，`regenerateTemplate` 会排不出任何天，
 * 下面这些模板复用用例就全部连带崩掉。锚到 `WEEK.start` 就永远不会过期。
 */
const W1 = { start: WEEK.start, get end() { return WEEK_DAY(6); } };
const W2 = { start: WEEK_DAY(7), get end() { return WEEK_DAY(13); } };

/** 日期串 → 星期几（0=周日）。与 server/util/dates.ts 同口径（UTC 解析）。 */
function dowOfDate(dateStr: string): number {
  return new Date(`${dateStr}T00:00:00Z`).getUTCDay();
}

/** 开了周期（第 1 周 = W1.start）的库。周期是模板复用的前提：没周期就没有「上一周」。 */
function cycleDb(): Db {
  const db = planDb();
  openCycle(db, { goal_text: '这周期着重练胸', first_week_start: W1.start }, new Date('2026-01-01T00:00:00Z'));
  return db;
}

/**
 * 记录 gateway 收到的输入，并返回一份「照模板平移」的 accepted 结果（模拟 AI 正常输出）。
 * `mangleWeight=true` 时故意把重量写成 suggest_kg + 3 —— 用来证明写入前会被本地覆盖。
 */
function capturingGw(db: Db, mangleWeight = false): { gw: AiGateway; inputs: PlanGenerationInput[] } {
  const inputs: PlanGenerationInput[] = [];
  const gw: AiGateway = {
    generatePlan: async (input) => {
      inputs.push(input);
      const t = input.template;
      const draft: PlanDraft =
        t === undefined
          ? twoDayDraft(W2.start, W2.end)
          : {
              week_start: W2.start,
              week_end: W2.end,
              days: t.days.map((d) => ({
                datestr: d.datestr,
                day_type: d.day_type,
                title: d.title,
                target_muscles: d.target_muscles,
                est_duration_min: 70,
                exercises: d.exercises.map((e, i) => ({
                  ord: i + 1,
                  catalog_id: e.catalog_id,
                  name: e.name,
                  sets: e.sets,
                  reps: e.reps,
                  weight_kg: e.suggest_kg === null ? null : (mangleWeight ? e.suggest_kg + 3 : e.suggest_kg),
                  weight_source: e.suggest_kg === null ? ('estimate' as const) : ('history_best' as const),
                  rest_s: e.rest_s,
                  is_cardio: e.is_cardio,
                  why: '照模板平移',
                })),
                why: {
                  summary: '沿用第 1 周模板',
                  evidence_refs: [{ type: 'structure' as const, ref: 'structure:template_reuse', text: '沿用' }],
                },
              })),
            };
      return {
        status: 'accepted',
        draft,
        summary: buildSummary(db, draft),
        warnings: [],
        clamped: [],
        attempts: 1,
      };
    },
    explainPlan: async () => {
      throw new Error('explainPlan 不在本测试范围');
    },
    summarizeReview: async () => {
      throw new Error('summarizeReview 不在本测试范围');
    },
    summarizeWeek: async () => {
      throw new Error('summarizeWeek 不在本测试范围');
    },
  };
  return { gw, inputs };
}

describe('templateFor：什么时候该沿用它，什么时候不该', () => {
  it('没开周期 → null（没有「上一周」这个概念）', () => {
    assert.equal(templateFor(planDb(), W2.start), null);
  });

  it('周期第 1 周 → null（本来就没有可沿用的东西）', () => {
    assert.equal(templateFor(cycleDb(), W1.start), null);
  });

  it('第 2 周但上一周没排过计划 → null（回落全量，不报错）', () => {
    assert.equal(templateFor(cycleDb(), W2.start), null);
  });

  it('第 2 周 + 上一周有计划 → 返回模板：存 dow 不存日期，带上一周重量', () => {
    const db = cycleDb();
    regenerateTemplate(db, { weekStart: W1.start });
    const t = templateFor(db, W2.start);
    assert.ok(t !== null, '第 2 周必须取到模板');
    assert.equal(t.source_week_start, W1.start);
    assert.equal(t.source_week_end, W1.end);
    assert.equal(t.source_week_no, 1);
    assert.ok(t.days.length > 0);
    // dow（星期几）而不是日期 —— 日期要平移到目标周再算
    assert.ok(t.days.every((d) => d.dow >= 0 && d.dow <= 6));
    assert.ok(t.days.every((d) => d.exercises.length > 0));
  });

  it('上一周的计划被归档 → null（归档不算「上一周有计划」）', () => {
    const db = cycleDb();
    regenerateTemplate(db, { weekStart: W1.start });
    db.prepare(`UPDATE plan SET status = 'archived' WHERE week_start = ?`).run(W1.start);
    assert.equal(templateFor(db, W2.start), null);
  });
});

describe('模板路径：第 2~4 周沿用上一周模板', () => {  it('第 1 周没有模板；第 2 周带上模板，日期已平移到本周、重量带上 suggest_kg', async () => {
    const db = cycleDb();
    const w1 = regenerateTemplate(db, { weekStart: W1.start });

    // 第 1 周：不沿用（周期首周）
    const first = capturingGw(db);
    const out1 = await createPlanFromAi(db, first.gw, 'test-model', { weekStart: W1.start });
    assert.equal(first.inputs[0]?.template, undefined, '第 1 周不该带模板');
    assert.equal(out1.templateWeekNo, null);
    assert.equal(out1.detail.plan.template_week_no, null);

    // 第 2 周：沿用
    const second = capturingGw(db);
    const out2 = await createPlanFromAi(db, second.gw, 'test-model', { weekStart: W2.start });
    assert.equal(out2.templateWeekNo, 1);
    assert.equal(out2.detail.plan.template_week_no, 1);

    const t = second.inputs[0]?.template;
    assert.ok(t !== undefined, '第 2 周必须把模板交给 AI');
    assert.equal(t.source_week_no, 1);
    // 平移后每天都是本周的日期，且不会落在上一周
    assert.ok(t.days.every((d) => d.datestr >= W2.start && d.datestr <= W2.end));
    assert.ok(t.days.every((d) => !(d.datestr >= W1.start && d.datestr <= W1.end)));
    // 星期几与上一周保持一致（结构不变，只挪日期）
    assert.deepEqual(
      t.days.map((d) => dowOfDate(d.datestr)).sort((a, b) => a - b),
      w1.days.map((d) => d.dow).sort((a, b) => a - b),
    );
    // 每个动作都拿到了本周建议重量字段（值是 null 也算 —— 那是「无历史重量」）
    assert.ok(t.days.every((d) => d.exercises.every((e) => 'suggest_kg' in e && 'progression_action' in e)));
  });

  it('模板路径的摘要层被瘦身：不喂 profile.muscles / findings，池子只留模板用到的动作', async () => {
    const db = cycleDb();
    regenerateTemplate(db, { weekStart: W1.start });
    const { gw, inputs } = capturingGw(db);
    await createPlanFromAi(db, gw, 'test-model', { weekStart: W2.start });

    const input = inputs[0];
    assert.ok(input?.template !== undefined);
    assert.equal(input.digest.profile.muscles.length, 0, '模板路径不喂画像肌群表');
    assert.equal(input.digest.findings.length, 0, '模板路径不喂 findings（它会诱导改结构）');
    assert.ok(input.digest.candidate_pool.length <= 30);

    // 池子必须覆盖模板里出现的每个动作（否则 V1 白名单会把 AI 的正经输出也判违规）
    const tplIds = new Set(input.template.days.flatMap((d) => d.exercises.map((e) => e.catalog_id)));
    const poolIds = new Set(input.digest.candidate_pool.map((m) => m.catalog_id));
    for (const id of tplIds) assert.ok(poolIds.has(id), `模板动作 ${id} 必须在候选池里`);
  });

  it("mode='full'（首页「重新全量生成」）显式否决模板", async () => {
    const db = cycleDb();
    regenerateTemplate(db, { weekStart: W1.start });
    const { gw, inputs } = capturingGw(db);
    const out = await createPlanFromAi(db, gw, 'test-model', { weekStart: W2.start, mode: 'full' });
    assert.equal(inputs[0]?.template, undefined, 'mode=full 不该带模板');
    assert.equal(out.templateWeekNo, null);
    assert.equal(out.detail.plan.template_week_no, null);
  });

  it('重量一律取系统算好的 suggest_kg —— 模板里的数字和 AI 编的数字都不采信', async () => {
    const db = cycleDb();
    const w1 = regenerateTemplate(db, { weekStart: W1.start });
    const w1Weight = new Map(w1.days.flatMap((d) => d.exercises).map((e) => [e.catalog_id, e.weight_kg]));
    assert.ok(
      [...w1Weight.values()].some((v) => v !== null),
      '夹具必须至少有一个带历史重量的动作，否则这条断言是空的',
    );

    const { gw } = capturingGw(db, true); // AI 故意给 suggest_kg + 3
    const out = await createPlanFromAi(db, gw, 'test-model', { weekStart: W2.start });
    const ex = out.detail.days.flatMap((d) => d.exercises);
    assert.ok(ex.length > 0);
    for (const e of ex) {
      // AI 这轮给的是 expected + 3。落库若是 expected，就证明写入前被本地覆盖了。
      const expected = w1Weight.get(e.catalog_id ?? -1) ?? null;
      assert.equal(e.weight_kg, expected, `${e.name} 的重量必须等于系统算好的建议值（不是 AI 给的）`);
    }
  });

  it('AI 熔断 → 机械平移上一周模板：动作集合不变、日期挪到本周、标题写明来源', async () => {
    const db = cycleDb();
    const w1 = regenerateTemplate(db, { weekStart: W1.start });
    const gw = mockGw({ status: 'rule_fallback', reason: 'ai_unavailable', attempts: 1, lastViolations: [] });
    const out = await createPlanFromAi(db, gw, 'test-model', { weekStart: W2.start });

    assert.equal(out.templateWeekNo, 1);
    assert.equal(out.detail.plan.template_week_no, 1);
    assert.equal(out.detail.plan.source, 'rule_fallback');
    assert.equal(out.detail.days.length, w1.days.length, '训练日数量沿用模板');
    assert.ok(out.detail.days.every((d) => /沿用第 1 周/.test(d.title)));
    assert.ok(out.detail.days.every((d) => d.datestr >= W2.start && d.datestr <= W2.end));
    assert.deepEqual(
      out.detail.days.flatMap((d) => d.exercises.map((e) => e.name)).sort(),
      w1.days.flatMap((d) => d.exercises.map((e) => e.name)).sort(),
      '动作集合必须与上一周完全一致（结构照搬）',
    );
    // 诚实标注：没有 AI 参与 → 本周特殊情况没被处理
    assert.ok(out.detail.days.every((d) => /特殊情况没有被处理/.test(d.why?.summary ?? '')));
  });
});

describe('单版本覆盖的边界：同周已有非草稿计划', () => {
  /**
   * 回归：`plan` 有 `UNIQUE (week_start, version_no)`，而 INSERT 曾经写死 `version_no = 1`。
   * v2「单版本覆盖」只覆盖 **draft** —— 已 approved / 已写入的那份要留着给用户回看，
   * 于是必然要新起一行，version_no 撞车 → 500。
   *
   * 真实可复现路径：生成 → 导入训记（status=written）→ 回首页点「重新生成」。
   * 这个 bug 是在真实库副本上跑模板复用冒烟时才暴露出来的。
   */
  it('已 approved 的那份不动；新生成的另起一条草稿且 version_no 递增', async () => {
    const db = planDb();
    const draft = twoDayDraft(WEEK.start, WEEK.end);
    const gw = mockGw({
      status: 'accepted',
      draft,
      summary: buildSummary(db, draft),
      warnings: [],
      clamped: [],
      attempts: 1,
    });

    const first = await createPlanFromAi(db, gw, 'test-model', { weekStart: WEEK.start });
    db.prepare(`UPDATE plan SET status = 'approved' WHERE id = ?`).run(first.planId);

    const second = await createPlanFromAi(db, gw, 'test-model', { weekStart: WEEK.start });
    assert.notEqual(second.planId, first.planId, '已批准的那份不能被覆盖，必须新起一条');
    assert.equal(second.detail.plan.status, 'draft');

    const approved = getPlanDetail(db, first.planId);
    assert.equal(approved.plan.status, 'approved', '已批准的计划原地不动');
    assert.ok(
      second.detail.plan.version_no > approved.plan.version_no,
      `新草稿 version_no 必须递增（否则撞 UNIQUE）：${second.detail.plan.version_no} vs ${approved.plan.version_no}`,
    );
    // 首页按周取到的是新草稿（id 更大），而不是已批准的那份
    assert.equal(getPlanIdForWeek(db, WEEK.start), second.planId);
  });

  it('同周已有草稿则原地覆盖，version_no 不递增、plan id 不变（v2 语义不回退）', async () => {
    const db = planDb();
    const draft = twoDayDraft(WEEK.start, WEEK.end);
    const gw = mockGw({
      status: 'accepted',
      draft,
      summary: buildSummary(db, draft),
      warnings: [],
      clamped: [],
      attempts: 1,
    });
    const first = await createPlanFromAi(db, gw, 'test-model', { weekStart: WEEK.start });
    const second = await createPlanFromAi(db, gw, 'test-model', { weekStart: WEEK.start });
    assert.equal(second.planId, first.planId);
    assert.equal(second.detail.plan.version_no, first.detail.plan.version_no);
    const rows = db.prepare(`SELECT COUNT(*) AS n FROM plan WHERE week_start = ?`).get(WEEK.start) as { n: number };
    assert.equal(Number(rows.n), 1, '草稿路径不该堆积版本行');
  });
});
