/**
 * AI 层测试（T3）。红线：零真实网络 ——
 * http 模式一律注入 fetchImpl stub（按调用次序返回预录内容）。
 * （原 workbuddy 文件契约模式的测试已随该模式一并移除，2026-09-30）
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { planDraftSchema, planExplanationSchema, reviewSummarySchema } from '../server/ai/schemas.js';
import type {
  PlanDraft,
  PlanExplanation,
  ReviewSummary,
} from '../server/ai/schemas.js';
import { refIndexFromDigest, refIndexFromReport, validateDraft, validateExplanation } from '../server/ai/validator.js';
import type { PlanInputDigest } from '../server/ai/digest.js';
import { buildSummary } from '../server/ai/summaryBuilder.js';
import { createAiGateway } from '../server/ai/gateway.js';
import type { AnalysisReport, CandidatePoolItem, Constraints, WritingRules } from '../server/analysis/reportSchema.js';
import type { Db } from '../server/db/index.js';
import { ANALYSIS_WINDOW_WEEKS } from '../server/analysis/window.js';
import { nextWeekStart, todayLocal } from '../server/plan/planService.js';

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

const POOL: CandidatePoolItem[] = [
  {
    catalog_id: 1,
    name: '杠铃卧推',
    primary_muscles: ['chest'],
    joint_flags: [{ joint: 'shoulder', level: 2 }],
    last_weight: 60,
    last_sets_reps: '3x8',
    used_recently: true,
    mapping_confidence: 'high',
  },
  {
    catalog_id: 2,
    name: '杠铃深蹲',
    primary_muscles: ['quads', 'glutes'],
    joint_flags: [{ joint: 'lumbar', level: 3 }],
    last_weight: 90,
    last_sets_reps: '3x8',
    used_recently: true,
    mapping_confidence: 'high',
  },
  {
    catalog_id: 3,
    name: '哑铃飞鸟',
    primary_muscles: ['chest'],
    joint_flags: [],
    last_weight: null,
    last_sets_reps: null,
    used_recently: false,
    mapping_confidence: 'high',
  },
];

const REPORT = {
  schema_version: '1.0',
  movement_trends: [
    { catalog_id: 1, name: '杠铃卧推', verdict: 'plateau' },
  ],
  muscle_trends: [{ muscle_code: 'chest', verdict: 'stable' }],
  findings: [
    { code: 'R-AG-04', severity: 'warn', title: '胸量高无进步', detail: '', evidence: { metric: 'x', value: 1, window: '12周' } },
  ],
} as unknown as AnalysisReport;

const CONSTRAINTS: Constraints = {
  goal: { goal_type: 'fatloss_keep_strength', sessions_per_week: 2, min_duration_min: 60, max_duration_min: 90 },
  hard_rules: [
    { kind: 'keep', target_type: 'movement', target_value: '杠铃深蹲' },
    { kind: 'limit_load', target_type: 'joint', target_value: 'lumbar', param: { max_joint_stress_level: 3 } },
  ],
  soft_rules: [],
};

/**
 * 🔴 夹具用的一周**必须是未来**（相对跑测试那天）。
 *
 * V12（2026-10-05）给 `validateDraft` 加了 `DATE_IN_PAST`：调用方传了 `todayStr` 时，
 * 「今天与之前」的训练日一律 BLOCK（与 `PlanConfirm` 的写回窗口同一条红线）。
 * 写死 `2026-10-05` 这种具体日期，一到那天所有 gateway 用例都会突然变成 rule_fallback。
 *
 * 这里锚到**下一个完整周**（+7，无论今天周几都严格晚于今天），
 * 再按偏移量生成各训练日 —— 用例就永远不会过期。
 */
const FIXTURE_WEEK_START = nextWeekStart(todayLocal(), 1);
const fxDay = (offset: number): string => addDaysForTest(FIXTURE_WEEK_START, offset);

function addDaysForTest(datestr: string, n: number): string {
  const d = new Date(`${datestr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function validDraft(): PlanDraft {
  return {
    week_start: FIXTURE_WEEK_START,
    week_end: fxDay(6),
    days: [
      {
        datestr: fxDay(0),
        day_type: '上肢推',
        title: '推日',
        est_duration_min: 75,
        exercises: [
          {
            ord: 1,
            catalog_id: 1,
            name: '杠铃卧推',
            sets: 4,
            reps: 8,
            weight_kg: 60,
            weight_source: 'history_best',
            rest_s: 120,
            is_cardio: false,
            record_preset: null,
            why: 'plateau：改次数区间',
          },
        ],
        why: {
          summary: '胸平台期维持容量',
          evidence_refs: [{ type: 'movement_trend', ref: 'movement_trend:1', text: '卧推近12周持平' }],
        },
      },
      {
        datestr: fxDay(3),
        day_type: '下肢力量',
        title: '腿日',
        est_duration_min: 80,
        exercises: [
          {
            ord: 1,
            catalog_id: 2,
            name: '杠铃深蹲',
            sets: 4,
            reps: 8,
            weight_kg: 85.5,
            weight_source: 'history_best',
            rest_s: 150,
            is_cardio: false,
            record_preset: null,
            why: 'regress：重量回调 10%',
          },
        ],
        why: {
          summary: '深蹲退步响应',
          evidence_refs: [{ type: 'finding', ref: 'finding:R-AG-04', text: '胸量高无进步需响应' }],
        },
      },
    ],
  };
}

function memDb(): Db {
  const db = new DatabaseSync(':memory:') as Db;
  db.exec('CREATE TABLE movement_muscle_map (catalog_id INTEGER, muscle_code TEXT, weight REAL)');
  db.exec("INSERT INTO movement_muscle_map VALUES (1,'chest',1.0),(1,'triceps',0.5),(2,'quads',1.0),(2,'glutes',0.5)");
  return db;
}

const PROMPTS_DIR = path.resolve('server/ai/prompts');

function makeHttpGateway(contents: string[]) {
  const bodies: Array<Record<string, unknown>> = [];
  let call = 0;
  const fetchImpl = (async (_url: unknown, init?: { body?: string }) => {
    bodies.push(JSON.parse(init?.body ?? '{}') as Record<string, unknown>);
    const content = contents[Math.min(call, contents.length - 1)];
    call += 1;
    return {
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content } }] }),
    };
  }) as unknown as typeof fetch;
  const gw = createAiGateway(memDb(), {
    promptsDir: PROMPTS_DIR,
    maxAttempts: 3,
    http: { mode: 'http', baseUrl: 'https://llm.invalid/v1', model: 'test-model', apiKey: 'test-key', maxTokens: 8192, temperature: 0.3, timeoutMs: 1000 },
    fetchImpl,
  });
  return { gw, bodies };
}

const WRITING_RULES: WritingRules = {
  max_trains_per_batch: 4,
  max_movements_per_train: 15,
  max_sets_per_movement: 20,
  same_day_per_batch: true,
  movement_name_must_come_from: 'candidate_pool',
  name_language: 'zh-CN 标准名',
};

/**
 * 摘要层夹具（V3）：AI 的输入不再是整份报告，而是这份 digest。
 * 字段与 buildPlanDigest 的输出一一对应（池子里带上 trend/delta_pct 等趋势字段）。
 */
const DIGEST: PlanInputDigest = {
  schema_version: '3.4',
  generated_at: '2026-10-01T00:00:00Z',
  profile: {
    window: { start: '2026-07-13', end: '2026-10-04', weeks: ANALYSIS_WINDOW_WEEKS },
    habit: {
      sessions_per_week: 2,
      goal_sessions_per_week: 2,
      avg_duration_min: 70,
      duration_median_min: 70,
      trained_dows: [1, 4],
    },
    muscles: [
      { code: 'chest', name: '胸', weekly_sets: 9, verdict: 'stable' },
      { code: 'quads', name: '股四头', weekly_sets: 3, verdict: 'insufficient' },
    ],
    structure: { push_pull_ratio: 1.3, upper_lower_ratio: 2.2 },
    body: {
      weight_kg: 58.4,
      weight_date: '2026-09-30',
      delta_30d_kg: -1.2,
      conditions: '腰突（2020 年，已痊愈）',
      gender: '女',
      age: 31,
      height_cm: 163,
      training_years: '1~3 年',
    },
  },
  week: {
    week_start: FIXTURE_WEEK_START,
    week_end: addDaysForTest(FIXTURE_WEEK_START, 6),
    week_no: 2,
    total_weeks: 4,
    is_deload: false,
    cycle_goal: '着重练胸',
    long_term_goal: 'fatloss_keep_strength',
    focus_muscles: ['quads'],
    reduce_muscles: [],
    untrained_muscles: [],
    last_week: null,
    last_session: null,
    last_review: null,
    last_plan_actual: null,
    special_note: null,
    available_datestrs: [addDaysForTest(FIXTURE_WEEK_START, 1), addDaysForTest(FIXTURE_WEEK_START, 3), addDaysForTest(FIXTURE_WEEK_START, 4)],
  },
  findings: [{ code: 'R-AG-04', severity: 'warn', title: '胸量高无进步', detail: '近4周周均 24 组' }],
  constraints: { goal: CONSTRAINTS.goal, hard_rules: CONSTRAINTS.hard_rules },
  candidate_pool: POOL.map((p, i) => ({
    catalog_id: p.catalog_id,
    name: p.name,
    primary_muscles: p.primary_muscles,
    ...(p.joint_flags && p.joint_flags.length > 0 ? { joint_flags: p.joint_flags } : {}),
    last_weight: p.last_weight,
    last_sets_reps: p.last_sets_reps,
    trend: i === 0 ? ('plateau' as const) : ('insufficient_data' as const),
    delta_pct: i === 0 ? 0.5 : null,
    weeks: i === 0 ? 8 : 1,
    last_performed: '2026-10-01',
    used_recently: p.used_recently,
    mapping_confidence: p.mapping_confidence,
    // V5：这一份夹具刻意让建议值 == 历史最佳（action=hold），
    // 这样既有的 V2 ±10% 断言口径不变；建议值与历史值不同的场景在 progression.test.ts 里覆盖。
    progression: { suggest_kg: p.last_weight, delta_kg: 0, action: 'hold' as const },
  })),
  writing_rules: WRITING_RULES,
};

const REFS = refIndexFromDigest(DIGEST);

/** 只覆盖训练基础（goal / hard_rules）——摘要层其余部分沿用夹具。 */
function genInput(overrides: Partial<Constraints> = {}): { digest: PlanInputDigest } {
  const constraints = { ...CONSTRAINTS, ...overrides };
  return {
    digest: { ...DIGEST, constraints: { goal: constraints.goal, hard_rules: constraints.hard_rules ?? [] } },
  };
}

// ---------------------------------------------------------------------------
// V5：zod schema
// ---------------------------------------------------------------------------

describe('ai/schemas：PlanDraft V5', () => {
  it('合法草稿通过 strict 校验', () => {
    const r = planDraftSchema.safeParse(validDraft());
    assert.equal(r.success, true);
  });

  it('未知字段被拒绝（V5 strict）', () => {
    const d = validDraft() as Record<string, unknown>;
    d.plan_summary = { total_sets: 8 }; // AI 不允许自报周汇总
    const r = planDraftSchema.safeParse(d);
    assert.equal(r.success, false);
  });

  it('AI 输出带 rpe → 被 strict 拒绝（README：决策 A，只给重量 × 组数 × 次数）', () => {
    const d = validDraft() as unknown as { days: Array<{ exercises: Array<Record<string, unknown>> }> };
    d.days[0].exercises[0].rpe = 8;
    const r = planDraftSchema.safeParse(d);
    assert.equal(r.success, false, 'prompt 已禁止 rpe；万一模型仍输出，必须在 schema 层被拦下（宁可重试也不写进计划）');
  });

  it('组数超过写侧上限 20 被拒绝', () => {
    const d = validDraft();
    d.days[0].exercises[0].sets = 21;
    const r = planDraftSchema.safeParse(d);
    assert.equal(r.success, false);
  });

  it('动作名加修饰词不会在这里拦（V1 的职责），但空 days 会拦', () => {
    const d = validDraft();
    d.days = [];
    assert.equal(planDraftSchema.safeParse(d).success, false);
  });
});

// ---------------------------------------------------------------------------
// validator V1~V4
// ---------------------------------------------------------------------------

describe('ai/validator：V1 白名单', () => {
  it('动作名非逐字 → BLOCK', () => {
    const d = validDraft();
    d.days[0].exercises[0].name = '杠铃卧推（宽握）';
    const { violations } = validateDraft(d, { pool: POOL, constraints: CONSTRAINTS, refs: REFS });
    assert.ok(violations.some((x) => x.check === 'V1' && x.level === 'BLOCK' && x.code === 'NAME_NOT_VERBATIM'));
  });

  it('catalog_id 不在候选池 → BLOCK', () => {
    const d = validDraft();
    d.days[0].exercises[0].catalog_id = 999;
    const { violations } = validateDraft(d, { pool: POOL, constraints: CONSTRAINTS, refs: REFS });
    assert.ok(violations.some((x) => x.check === 'V1' && x.code === 'CATALOG_NOT_IN_POOL'));
  });
});

describe('ai/validator：V2 数值溯源', () => {
  it('重量超 ±10% → 钳制并记录，不产生违规', () => {
    const d = validDraft();
    d.days[0].exercises[0].weight_kg = 100; // 60 的 +66%
    const { violations, draft, clamped } = validateDraft(d, { pool: POOL, constraints: CONSTRAINTS, refs: REFS });
    assert.equal(violations.filter((x) => x.check === 'V2').length, 0);
    assert.equal(draft.days[0].exercises[0].weight_kg, 66); // 60×1.1
    assert.equal(clamped.length, 1);
  });

  it('无历史重量却给数值且无 estimate 依据 → BLOCK', () => {
    const d = validDraft();
    d.days[0].exercises[0].catalog_id = 3;
    d.days[0].exercises[0].name = '哑铃飞鸟';
    d.days[0].exercises[0].weight_kg = 10;
    d.days[0].exercises[0].weight_source = 'history_best';
    const { violations } = validateDraft(d, { pool: POOL, constraints: CONSTRAINTS, refs: REFS });
    assert.ok(violations.some((x) => x.check === 'V2' && x.code === 'WEIGHT_WITHOUT_HISTORY'));
  });

  it('无历史重量 + estimate + why 含"估计" → 通过', () => {
    const d = validDraft();
    d.days[0].exercises[0].catalog_id = 3;
    d.days[0].exercises[0].name = '哑铃飞鸟';
    d.days[0].exercises[0].weight_kg = 10;
    d.days[0].exercises[0].weight_source = 'estimate';
    d.days[0].exercises[0].why = '无历史数据，重量为估计值';
    const { violations } = validateDraft(d, { pool: POOL, constraints: CONSTRAINTS, refs: REFS });
    assert.equal(violations.filter((x) => x.check === 'V2').length, 0);
  });
});

describe('ai/validator：V3 evidence', () => {
  it('day 级 evidence_refs 为空 → BLOCK', () => {
    const d = validDraft();
    d.days[0].why.evidence_refs = [];
    const { violations } = validateDraft(d, { pool: POOL, constraints: CONSTRAINTS, refs: REFS });
    assert.ok(violations.some((x) => x.check === 'V3' && x.code === 'EMPTY_EVIDENCE_REFS'));
  });

  it('ref 引用不存在的对象 → BLOCK；存在 → 通过', () => {
    const d = validDraft();
    d.days[0].why.evidence_refs = [{ type: 'movement_trend', ref: 'movement_trend:999', text: 'x' }];
    const bad = validateDraft(d, { pool: POOL, constraints: CONSTRAINTS, refs: REFS });
    assert.ok(bad.violations.some((x) => x.check === 'V3' && x.code === 'REF_UNRESOLVABLE'));

    const d2 = validDraft();
    const ok = validateDraft(d2, { pool: POOL, constraints: CONSTRAINTS, refs: REFS });
    assert.equal(ok.violations.filter((x) => x.check === 'V3').length, 0);
  });
});

describe('ai/validator：V4 硬约束', () => {
  it('训练日数 ≠ 目标 → BLOCK', () => {
    const d = validDraft();
    d.days = [d.days[0]];
    const { violations } = validateDraft(d, { pool: POOL, constraints: CONSTRAINTS, refs: REFS });
    assert.ok(violations.some((x) => x.check === 'V4' && x.code === 'DAY_COUNT_MISMATCH'));
  });

  it('keep 动作缺失 → BLOCK', () => {
    const d = validDraft();
    d.days[1].exercises[0].name = '杠铃卧推'; // 深蹲被换掉
    const { violations } = validateDraft(d, { pool: POOL, constraints: CONSTRAINTS, refs: REFS });
    assert.ok(violations.some((x) => x.check === 'V4' && x.code === 'KEEP_MISSING'));
  });

  it('avoid 动作出现 → BLOCK', () => {
    const d = validDraft();
    const constraints: Constraints = {
      ...CONSTRAINTS,
      hard_rules: [...CONSTRAINTS.hard_rules, { kind: 'avoid', target_type: 'movement', target_value: '杠铃卧推' }],
    };
    const { violations } = validateDraft(d, { pool: POOL, constraints, refs: REFS });
    assert.ok(violations.some((x) => x.check === 'V4' && x.code === 'FORBIDDEN_MOVEMENT'));
  });

  it('关节压力超限 → BLOCK', () => {
    const constraints: Constraints = {
      ...CONSTRAINTS,
      hard_rules: [{ kind: 'limit_load', target_type: 'joint', target_value: 'lumbar', param: { max_joint_stress_level: 2 } }],
    };
    const { violations } = validateDraft(d2WithSquat(), { pool: POOL, constraints, refs: REFS });
    assert.ok(violations.some((x) => x.check === 'V4' && x.code === 'JOINT_STRESS_EXCEEDED'));
    function d2WithSquat(): PlanDraft {
      return validDraft();
    }
  });

  it('时长超出区间 → 仅 WARN（V4-WARN 可熔断放行）', () => {
    const d = validDraft();
    d.days[0].est_duration_min = 110;
    const { violations } = validateDraft(d, { pool: POOL, constraints: CONSTRAINTS, refs: REFS });
    const warn = violations.filter((x) => x.level === 'WARN');
    assert.equal(warn.length, 1);
    assert.equal(warn[0].code, 'DURATION_OUT_OF_RANGE');
    assert.deepEqual(warn[0].detail, { datestr: fxDay(0), value: 110, range: [60, 90] });
  });

  it('合法草稿零违规', () => {
    const { violations } = validateDraft(validDraft(), { pool: POOL, constraints: CONSTRAINTS, refs: REFS });
    assert.deepEqual(violations, []);
  });
});

describe('ai/validator：validateExplanation（A3 输出）', () => {
  const EXPLANATION: PlanExplanation = {
    days: [
      {
        datestr: '2026-10-05',
        summary: '推日',
        evidence_refs: [{ type: 'finding', ref: 'finding:R-AG-04', text: 'x' }],
        exercises: [{ ord: 1, why: '依据不足，按通用训练原则建议', basis: 'generic_principle' }],
      },
    ],
  };

  it('generic_principle 未写「依据不足」→ BLOCK', () => {
    const bad = { days: [{ ...EXPLANATION.days[0], exercises: [{ ord: 1, why: '感觉不错', basis: 'generic_principle' }] }] } as unknown as PlanExplanation;
    assert.ok(validateExplanation(bad, refIndexFromReport(REPORT)).length > 0);
  });

  it('basis=data 但 evidence_refs 为空 → BLOCK', () => {
    const bad = { days: [{ ...EXPLANATION.days[0], exercises: [{ ord: 1, why: 'x', basis: 'data' }] }] } as unknown as PlanExplanation;
    assert.ok(validateExplanation(bad, refIndexFromReport(REPORT)).length > 0);
  });

  it('合法解释零违规', () => {
    assert.deepEqual(validateExplanation(EXPLANATION, refIndexFromReport(REPORT)), []);
  });
});

// ---------------------------------------------------------------------------
// summaryBuilder（确定性计算）
// ---------------------------------------------------------------------------

describe('ai/summaryBuilder', () => {
  it('按 movement_muscle_map 权重折算肌群分布；有氧不计组数', () => {
    const db = memDb();
    db.exec("INSERT INTO movement_muscle_map VALUES (3,'chest',1.0)");
    const d = validDraft();
    d.days[0].exercises.push({
      ord: 2,
      catalog_id: 3,
      name: '哑铃飞鸟',
      sets: 3,
      reps: 12,
      weight_kg: null,
      rest_s: null,
      is_cardio: false,
      record_preset: null,
      why: '无历史数据，按保守重量估算',
    });
    // 追加一个有氧日动作（不计 total_sets / distribution）
    d.days[1].exercises.push({
      ord: 2,
      catalog_id: 3,
      name: '哑铃飞鸟',
      sets: 5,
      reps: null,
      weight_kg: null,
      rest_s: null,
      is_cardio: true,
      record_preset: null,
      why: '有氧收尾',
    });
    const s = buildSummary(db, d);
    assert.equal(s.total_sessions, 2);
    assert.equal(s.total_sets, 4 + 4 + 3); // 有氧的 5 组不计
    assert.equal(s.est_total_min, 155);
    // chest: 卧推 4×1.0 + 飞鸟 3×1.0 = 7；triceps: 4×0.5=2；quads 4×1=4；glutes 2
    assert.equal(s.muscle_distribution['chest'], 7);
    assert.equal(s.muscle_distribution['triceps'], 2);
    assert.equal(s.muscle_distribution['quads'], 4);
    assert.equal(s.muscle_distribution['glutes'], 2);
  });
});

// ---------------------------------------------------------------------------
// gateway：http 模式（fetch stub，零真实网络）
// ---------------------------------------------------------------------------

/** OpenAI 格式：业务 payload 在 messages[1].content（字符串），此处解包。 */
function payloadOf(body: Record<string, unknown>): Record<string, unknown> {
  const messages = body['messages'] as Array<{ role: string; content: string }>;
  assert.equal(messages.length, 2);
  assert.equal(messages[0].role, 'system');
  assert.equal(messages[1].role, 'user');
  return JSON.parse(messages[1].content) as Record<string, unknown>;
}

describe('ai/gateway：http 模式熔断状态机', () => {
  it('首次即合法 → accepted，attempts=1，summary 附带', async () => {
    const { gw } = makeHttpGateway([JSON.stringify(validDraft())]);
    const r = await gw.generatePlan(genInput());
    assert.equal(r.status, 'accepted');
    if (r.status === 'accepted') {
      assert.equal(r.attempts, 1);
      assert.equal(r.summary.total_sessions, 2);
      assert.deepEqual(r.warnings, []);
    }
  });

  it('首次 V4-BLOCK → 错误回灌 correction_hints → 第二次通过', async () => {
    const bad = validDraft();
    bad.days[1].exercises[0].name = '杠铃卧推'; // keep 深蹲缺失 → BLOCK
    const { gw, bodies } = makeHttpGateway([JSON.stringify(bad), JSON.stringify(validDraft())]);
    const r = await gw.generatePlan(genInput());
    assert.equal(r.status, 'accepted');
    if (r.status === 'accepted') assert.equal(r.attempts, 2);
    assert.equal(bodies.length, 2);
    const hints = payloadOf(bodies[1])['correction_hints'] as { violations: unknown[] } | undefined;
    assert.ok(hints, '第二次请求必须回灌违规清单');
    assert.ok(JSON.stringify(hints).includes('KEEP_MISSING'));
  });

  it('3 次全部 V4-BLOCK → rule_fallback(v4_block_after_retries)', async () => {
    const bad = validDraft();
    bad.days[1].exercises[0].name = '杠铃卧推';
    const { gw, bodies } = makeHttpGateway([JSON.stringify(bad)]);
    const r = await gw.generatePlan(genInput());
    assert.equal(r.status, 'rule_fallback');
    if (r.status === 'rule_fallback') {
      assert.equal(r.reason, 'v4_block_after_retries');
      assert.equal(r.attempts, 3);
    }
    assert.equal(bodies.length, 3);
  });

  it('仅剩时长 WARN → accepted 且带 warnings（熔断结果 A）', async () => {
    const d = validDraft();
    d.days[0].est_duration_min = 120;
    const { gw } = makeHttpGateway([JSON.stringify(d)]);
    const r = await gw.generatePlan(genInput());
    assert.equal(r.status, 'accepted');
    if (r.status === 'accepted') {
      assert.equal(r.warnings.length, 1);
      assert.equal(r.warnings[0].code, 'DURATION_OUT_OF_RANGE');
      assert.equal(r.warnings[0].value, 120);
    }
  });

  it('非 JSON 输出 → V5 拒绝后纠错重试', async () => {
    const { gw, bodies } = makeHttpGateway(['这不是JSON', JSON.stringify(validDraft())]);
    const r = await gw.generatePlan(genInput());
    assert.equal(r.status, 'accepted');
    if (r.status === 'accepted') assert.equal(r.attempts, 2);
    assert.ok(JSON.stringify(bodies[1]).includes('NOT_JSON'));
  });

  it('fetch 网络失败 → rule_fallback(ai_unavailable)，不空转 3 次', async () => {
    const fetchImpl = (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    const gw = createAiGateway(memDb(), {
      promptsDir: PROMPTS_DIR,
      maxAttempts: 3,
      http: { mode: 'http', baseUrl: 'https://llm.invalid/v1', model: 'm', apiKey: 'test-key', maxTokens: 8192, temperature: 0.3, timeoutMs: 500 },
      fetchImpl,
    });
    const r = await gw.generatePlan(genInput());
    assert.equal(r.status, 'rule_fallback');
    if (r.status === 'rule_fallback') assert.equal(r.reason, 'ai_unavailable');
  });

  it('前置过滤：avoid/超限动作被物理移出候选池（AI 看不到）', async () => {
    const { gw, bodies } = makeHttpGateway([JSON.stringify(validDraft())]);
    await gw.generatePlan(genInput());
    const p0 = payloadOf(bodies[0]);
    const d0 = p0['digest'] as { candidate_pool: Array<{ name: string }> };
    const names0 = d0.candidate_pool.map((x) => x.name);
    assert.ok(names0.includes('杠铃卧推') && names0.includes('杠铃深蹲') && names0.includes('哑铃飞鸟'));

    // 构造 avoid 哑铃飞鸟场景验证剔除 + prompt 注入说明
    const { gw: gw2, bodies: bodies2 } = makeHttpGateway([JSON.stringify(validDraft())]);
    await gw2.generatePlan(
      genInput({
        hard_rules: [...CONSTRAINTS.hard_rules, { kind: 'avoid', target_type: 'movement', target_value: '哑铃飞鸟' }],
      }),
    );
    const p1 = payloadOf(bodies2[0]);
    const d1 = p1['digest'] as { candidate_pool: Array<{ name: string }> };
    assert.ok(!d1.candidate_pool.some((x) => x.name === '哑铃飞鸟'));
    const system = (bodies2[0]['messages'] as Array<{ content: string }>)[0].content;
    assert.ok(system.includes('已被系统移出候选池'));
    assert.ok(system.includes('【保留】动作「杠铃深蹲」必须出现'));
  });
});

// ---------------------------------------------------------------------------
// prompt 文件与 R-14 验收锚点
// ---------------------------------------------------------------------------

describe('ai/prompts：模板完整性', () => {
  it('4 个角色 prompt 文件存在且含关键纪律', () => {
    for (const f of ['dataAnalyst.md', 'planGenerator.md', 'planExplainer.md', 'reviewSummarizer.md']) {
      const p = path.join(PROMPTS_DIR, f);
      assert.ok(existsSync(p), `${f} 应存在`);
      const text = readFileSync(p, 'utf8');
      assert.ok(text.length > 200, `${f} 内容过短`);
      if (f === 'planGenerator.md') {
        assert.ok(text.includes('熔断'), '生成器 prompt 必须含熔断说明');
        assert.ok(text.includes('{{USER_HARD_RULES}}'), '生成器 prompt 必须含硬约束注入占位');
        // PRD-v2 §11.4 决策 A：AI 不给 RPE —— prompt 里既不能有 rpe 字段示例，也要显式禁止
        assert.ok(!text.includes('"rpe"'), 'planGenerator 的 JSON 示例不得再出现 rpe 字段');
        assert.ok(text.includes('不输出 rpe'), 'planGenerator 必须显式写明不输出 rpe');
      }
      if (f === 'reviewSummarizer.md') {
        // R-14 验收锚点（PRD v1.8）：弹性日纪律第 5 条原文必须在 system prompt 中
        assert.ok(text.includes('不计入完成率'));
        assert.ok(text.includes('额外投入、值得肯定'));
        assert.ok(text.includes('严禁表述为"未达标/未完成目标"'));
      }
    }
  });

  it('A4 reviewSummary schema：建议可执行字段与枚举', () => {
    const ok: ReviewSummary = {
      strengths: [{ text: '频率稳定', evidence: '31/12 周' }],
      issues: [],
      suggestions: [{ text: '把周三推日改为拉日', action_type: 'split_change', executable: true }],
    };
    assert.equal(reviewSummarySchema.safeParse(ok).success, true);
    const badAction = { ...ok, suggestions: [{ text: 'x', action_type: 'magic', executable: true }] };
    assert.equal(reviewSummarySchema.safeParse(badAction).success, false);
  });
});

// ---------------------------------------------------------------------------
// V4：LLM 连接（DeepSeek / 任意 OpenAI 兼容端点）
// ---------------------------------------------------------------------------

/** 可控的假 fetch：按顺序返回预设响应，同时记录请求体与请求头。 */
function gatewayWith(
  responses: Array<{ status?: number; content?: string | null; throw?: Error }>,
  httpOverride: Record<string, unknown> = {},
) {
  const bodies: Array<Record<string, unknown>> = [];
  const headers: Array<Record<string, string>> = [];
  let calls = 0;
  const fetchImpl = (async (_url: unknown, init?: { body?: string; headers?: Record<string, string> }) => {
    bodies.push(JSON.parse(init?.body ?? '{}') as Record<string, unknown>);
    headers.push(init?.headers ?? {});
    const r = responses[Math.min(calls, responses.length - 1)];
    calls += 1;
    if (r.throw) throw r.throw;
    const status = r.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => ({ choices: [{ message: { content: r.content ?? null } }] }),
    };
  }) as unknown as typeof fetch;
  const http = {
    mode: 'http' as const,
    baseUrl: 'https://llm.invalid/v1',
    model: 'deepseek-flash',
    apiKey: 'test-key' as string | null,
    maxTokens: 8192,
    temperature: 0.3,
    timeoutMs: 500,
    ...httpOverride,
  };
  const gw = createAiGateway(memDb(), { promptsDir: PROMPTS_DIR, maxAttempts: 3, http, fetchImpl });
  return { gw, bodies, headers, http, calls: () => calls };
}

describe('V4：LLM 连接（DeepSeek）', () => {
  it('请求体是 OpenAI 兼容形状，并显式带 max_tokens / temperature / json_object', async () => {
    const { gw, bodies, headers } = gatewayWith([{ content: JSON.stringify(validDraft()) }]);
    const r = await gw.generatePlan(genInput());
    assert.equal(r.status, 'accepted');
    const body = bodies[0];
    assert.equal(body['model'], 'deepseek-flash');
    assert.deepEqual(body['response_format'], { type: 'json_object' });
    // DeepSeek JSON 模式官方要求显式设 max_tokens，否则 JSON 可能被中途截断
    assert.equal(body['max_tokens'], 8192);
    assert.equal(body['temperature'], 0.3);
    assert.equal(headers[0]['Authorization'], 'Bearer test-key');
    const messages = body['messages'] as Array<{ role: string; content: string }>;
    assert.equal(messages[0].role, 'system');
    // DeepSeek JSON 模式另一条要求：prompt 里必须出现 "json" 字样
    assert.ok(messages[0].content.toLowerCase().includes('json'));
  });

  it('LLM_MODE=off → 直接降级规则模板，不发起任何网络请求', async () => {
    const { gw, calls } = gatewayWith([{ content: JSON.stringify(validDraft()) }], { mode: 'off' });
    const r = await gw.generatePlan(genInput());
    assert.equal(r.status, 'rule_fallback');
    if (r.status === 'rule_fallback') assert.equal(r.reason, 'ai_unavailable');
    assert.equal(calls(), 0, '关闭后不得调用模型');
  });

  it('远端端点缺 Key → 明确报未配置，而不是拿一次 401 换一次调用', async () => {
    const { gw, calls } = gatewayWith([{ content: JSON.stringify(validDraft()) }], { apiKey: null });
    const r = await gw.generatePlan(genInput());
    assert.equal(r.status, 'rule_fallback');
    assert.equal(calls(), 0, '缺 Key 时不该发起网络请求');
  });

  it('本地端点（127.0.0.1）允许不带 Key（ollama / 本机 mock）', async () => {
    const { gw, calls } = gatewayWith([{ content: JSON.stringify(validDraft()) }], {
      baseUrl: 'http://127.0.0.1:1234/v1',
      apiKey: null,
    });
    const r = await gw.generatePlan(genInput());
    assert.equal(r.status, 'accepted');
    assert.equal(calls(), 1);
  });

  it('空 content（DeepSeek 已知偶发）→ 重试而不是直接降级', async () => {
    const { gw, calls } = gatewayWith([{ content: '' }, { content: JSON.stringify(validDraft()) }]);
    const r = await gw.generatePlan(genInput());
    assert.equal(r.status, 'accepted');
    if (r.status === 'accepted') assert.equal(r.attempts, 2);
    assert.equal(calls(), 2);
  });

  it('重试完仍空 content → rule_fallback(ai_transient)（如实说明是偶发故障，不是模型不会做）', async () => {
    const { gw, calls } = gatewayWith([{ content: '' }]);
    const r = await gw.generatePlan(genInput());
    assert.equal(r.status, 'rule_fallback');
    if (r.status === 'rule_fallback') assert.equal(r.reason, 'ai_transient');
    assert.equal(calls(), 3, '应当把 3 次尝试用满');
  });

  it('429 / 5xx 可重试；401 不重试（重试没有意义）', async () => {
    const rate = gatewayWith([{ status: 429 }, { content: JSON.stringify(validDraft()) }]);
    assert.equal((await rate.gw.generatePlan(genInput())).status, 'accepted');
    assert.equal(rate.calls(), 2);

    const serverErr = gatewayWith([{ status: 503 }, { status: 503 }, { status: 503 }]);
    const r2 = await serverErr.gw.generatePlan(genInput());
    assert.equal(serverErr.calls(), 3);
    if (r2.status === 'rule_fallback') assert.equal(r2.reason, 'ai_transient');

    const unauthorized = gatewayWith([{ status: 401 }]);
    const r3 = await unauthorized.gw.generatePlan(genInput());
    assert.equal(unauthorized.calls(), 1, '401 不该重试');
    if (r3.status === 'rule_fallback') assert.equal(r3.reason, 'ai_unavailable');
  });

  it('超时 → ai_unavailable 且不重试（重试只会把等待时间翻三倍）', async () => {
    const err = new Error('aborted');
    err.name = 'AbortError';
    const { gw, calls } = gatewayWith([{ throw: err }]);
    const r = await gw.generatePlan(genInput());
    assert.equal(r.status, 'rule_fallback');
    if (r.status === 'rule_fallback') assert.equal(r.reason, 'ai_unavailable');
    assert.equal(calls(), 1);
  });

  it('配置热更新：mutate 同一个 http 对象后，下一次调用立刻用新值', async () => {
    const { gw, bodies, headers, http } = gatewayWith([{ content: JSON.stringify(validDraft()) }]);
    await gw.generatePlan(genInput());
    assert.equal(bodies[0]['model'], 'deepseek-flash');

    http.model = 'deepseek-v4-pro';
    http.apiKey = 'rotated-key';
    http.maxTokens = 4096;
    await gw.generatePlan(genInput());
    assert.equal(bodies[1]['model'], 'deepseek-v4-pro');
    assert.equal(bodies[1]['max_tokens'], 4096);
    assert.equal(headers[1]['Authorization'], 'Bearer rotated-key');
  });
});

describe('V4：输出形状的兜底（避免撞库 500）', () => {
  it('同一天出现两个训练日 → V4-BLOCK 走纠错重试，而不是落库时撞 UNIQUE(plan_id, datestr)', async () => {
    const bad = validDraft();
    // 把第 2 天改成与第 1 天同日期（模型在「要求 4 天但只有 3 个训练日」时会这么干）
    bad.days[1] = { ...bad.days[1], datestr: bad.days[0].datestr };
    const { gw, bodies } = makeHttpGateway([JSON.stringify(bad), JSON.stringify(validDraft())]);
    const r = await gw.generatePlan(genInput());
    assert.equal(r.status, 'accepted');
    if (r.status === 'accepted') assert.equal(r.attempts, 2);
    assert.ok(JSON.stringify(bodies[1]).includes('DUPLICATE_DATE'), '纠错提示必须说明日期重复');
  });

  it('三次都给重复日期 → rule_fallback(v4_block_after_retries) 且带 DUPLICATE_DATE 违规', async () => {
    const bad = validDraft();
    bad.days[1] = { ...bad.days[1], datestr: bad.days[0].datestr };
    const { gw } = makeHttpGateway([JSON.stringify(bad)]);
    const r = await gw.generatePlan(genInput());
    assert.equal(r.status, 'rule_fallback');
    if (r.status === 'rule_fallback') {
      assert.equal(r.reason, 'v4_block_after_retries');
      assert.ok(r.lastViolations.some((v) => v.code === 'DUPLICATE_DATE'));
    }
  });

  it('发给模型的 payload 是紧凑 JSON（缩进会把 11.4 KB 撑成 18.7 KB，白花约 1800 token/次）', async () => {
    const { gw, bodies } = makeHttpGateway([JSON.stringify(validDraft())]);
    await gw.generatePlan(genInput());
    const content = (bodies[0]['messages'] as Array<{ role: string; content: string }>)[1].content;
    assert.ok(!content.includes('\n  '), 'payload 不该带缩进');
    assert.ok(!content.includes('\n'), 'payload 不该有换行');
    assert.ok(content.length < 15 * 1024, `摘要层 + 紧凑序列化后应 <15 KB，实际 ${content.length}`);
  });
});
