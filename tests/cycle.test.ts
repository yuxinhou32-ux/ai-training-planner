/**
 * 训练周期测试（PRD-v2 V2）。
 *
 * 覆盖：周次换算（不落库、现算）→ 减量周判定 → 开/改/关周期 → 周期上下文进 AI 输入
 * → 模板减量周（容量减半、强度 −12.5%）。
 *
 * 红线：零真实网络（gateway 用手工 mock，只断言渲染出的 prompt 文本）。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { handleCycleRoutes } from '../server/api/routes/cycle.js';
import {
  CYCLE_WEEKS,
  CycleServiceError,
  closeActiveCycle,
  currentWeekStart,
  cycleStatusFor,
  forceEditCycleGoal,
  getActiveCycle,
  isCycleExpired,
  openCycle,
  weekNoOf,
} from '../server/cycle/cycleService.js';
import { buildTemplateDraft } from '../server/plan/template.js';
import { cycleContextFor, nextWeekStart, planningWeekStart, todayLocal } from '../server/plan/planService.js';
import { buildPlanDigest } from '../server/ai/digest.js';
import { createAiGateway } from '../server/ai/gateway.js';
import type { AiGateway } from '../server/ai/schemas.js';
import type { AnalysisReport, CandidatePoolItem, Constraints, WritingRules } from '../server/analysis/reportSchema.js';
import { makeTempDb } from './fixtures.js';
import { ANALYSIS_WINDOW_WEEKS } from '../server/analysis/window.js';
import type { Db } from '../server/db/index.js';

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

function cycleDb(): Db {
  const { db } = makeTempDb();
  db.prepare(
    `INSERT INTO user_goal (goal_type, sessions_per_week, min_duration_min, max_duration_min, week_start_dow, preferred_dows, is_active, effective_from, created_at)
     VALUES ('减脂保肌', 2, 60, 90, 1, '[1,3]', 1, '2026-01-01', '2026-01-01T00:00:00Z')`,
  ).run();
  return db;
}

/** 摘要层的肌群基线来自 muscle_group（真实库里由 catalog 导入落库）；测试里手工种最少的几条。 */
function seedMuscleGroups(db: Db): void {
  const ins = db.prepare(
    `INSERT OR IGNORE INTO muscle_group (code, name_zh, parent_code, region, size) VALUES (?, ?, NULL, ?, ?)`,
  );
  ins.run('chest', '胸', 'upper', 'large');
  ins.run('quads', '股四头', 'lower', 'large');
  ins.run('glutes', '臀', 'lower', 'large');
  ins.run('cardio', '有氧', 'other', 'other'); // 非肌群：必须被摘要层排除
}

const W1 = '2026-01-05'; // 周一
const W2 = '2026-01-12';
const W3 = '2026-01-19';
const W4 = '2026-01-26';
const W5 = '2026-02-02';

function expectCycleError(fn: () => unknown, status: number, keyword: string): void {
  try {
    fn();
  } catch (e) {
    assert.ok(e instanceof CycleServiceError, `应抛 CycleServiceError，实际 ${String(e)}`);
    assert.equal((e as CycleServiceError).status, status);
    assert.ok((e as Error).message.includes(keyword), `信息应含「${keyword}」，实际「${(e as Error).message}」`);
    return;
  }
  assert.fail('应当抛错但没有');
}

// ---------------------------------------------------------------------------
// 周次换算
// ---------------------------------------------------------------------------

describe('cycleService：周次与减量周（现算，不落库）', () => {
  it('weekNoOf：第 1~4 周依次为 1~4；越界/未对齐返回 null', () => {
    const db = cycleDb();
    const cycle = openCycle(db, { goal_text: '着重练胸', first_week_start: W1 });
    assert.equal(weekNoOf(cycle, W1), 1);
    assert.equal(weekNoOf(cycle, W2), 2);
    assert.equal(weekNoOf(cycle, W3), 3);
    assert.equal(weekNoOf(cycle, W4), 4);
    assert.equal(weekNoOf(cycle, W5), null, '第 5 周已越出周期');
    assert.equal(weekNoOf(cycle, '2026-01-01'), null, '周期开始之前');
    assert.equal(weekNoOf(cycle, '2026-01-06'), null, '只认整周对齐（差 1 天不算）');
  });

  it('cycleStatusFor：只有第 4 周是减量周', () => {
    const db = cycleDb();
    openCycle(db, { goal_text: '着重练背', first_week_start: W1 });
    assert.equal(cycleStatusFor(db, W1).isDeload, false);
    assert.equal(cycleStatusFor(db, W3).isDeload, false);
    assert.equal(cycleStatusFor(db, W4).isDeload, true);
    assert.equal(cycleStatusFor(db, W4).weekNo, 4);
  });

  it('未开周期时 cycleStatusFor 返回全 null / false', () => {
    const db = cycleDb();
    const st = cycleStatusFor(db, W1);
    assert.equal(st.cycle, null);
    assert.equal(st.weekNo, null);
    assert.equal(st.isDeload, false);
    assert.equal(st.expired, false);
  });

  it('currentWeekStart：按一周起始日回退到本周起点', () => {
    assert.equal(currentWeekStart('2026-01-07', 1), W1, '周三 → 本周一');
    assert.equal(currentWeekStart('2026-01-05', 1), W1, '周一 → 自己');
    assert.equal(currentWeekStart('2026-01-11', 1), W1, '周日 → 仍是本周一（周一起点）');
    assert.equal(currentWeekStart('2026-01-11', 0), '2026-01-11', '周日起点：周日就是起点');
  });
});

// ---------------------------------------------------------------------------
// 开 / 改 / 关
// ---------------------------------------------------------------------------

describe('cycleService：开周期 / 强行修改 / 结束', () => {
  it('openCycle：写入 4 周跨度、cycle_no 从 1 递增、状态 active', () => {
    const db = cycleDb();
    const c = openCycle(db, { goal_text: '着重练胸', first_week_start: W1 }, new Date('2026-01-01T02:00:00Z'));
    assert.equal(c.cycleNo, 1);
    assert.equal(c.firstWeekStart, W1);
    assert.equal(c.lastWeekStart, W4, `最后一周 = 开始周 + ${(CYCLE_WEEKS - 1) * 7} 天`);
    assert.equal(c.goalText, '着重练胸');
    assert.equal(c.status, 'active');
    assert.equal(c.forceEditedAt, null);
    assert.equal(getActiveCycle(db)?.id, c.id);

    closeActiveCycle(db);
    const c2 = openCycle(db, { goal_text: '加强腿部', first_week_start: W5 });
    assert.equal(c2.cycleNo, 2);
  });

  it('openCycle：目标为空 / 缺开始周 / 已有进行中周期 → 报错', () => {
    const db = cycleDb();
    expectCycleError(() => openCycle(db, { goal_text: '   ', first_week_start: W1 }), 400, '不能为空');
    expectCycleError(() => openCycle(db, { goal_text: 'x'.repeat(61), first_week_start: W1 }), 400, '最多 60');
    expectCycleError(() => openCycle(db, { goal_text: '着重练胸' }), 400, '缺少开始周');
    openCycle(db, { goal_text: '着重练胸', first_week_start: W1 });
    expectCycleError(() => openCycle(db, { goal_text: '再来一个', first_week_start: W2 }), 409, '已有进行中的周期');
  });

  it('forceEditCycleGoal：只改文案 + 留痕，周期起止与周次不变', () => {
    const db = cycleDb();
    openCycle(db, { goal_text: '着重练胸', first_week_start: W1 });
    const edited = forceEditCycleGoal(db, { goal_text: '着重练背' }, new Date('2026-01-08T02:00:00Z'));

    assert.equal(edited.goalText, '着重练背');
    assert.notEqual(edited.forceEditedAt, null, '强行修改必须留痕');
    assert.equal(edited.firstWeekStart, W1, '不动周期起点');
    assert.equal(edited.lastWeekStart, W4);
    assert.equal(weekNoOf(edited, W3), 3, '周次不受影响');
    // 只有一个周期行，没有新增
    const n = db.prepare(`SELECT COUNT(*) AS c FROM training_cycle`).get() as unknown as { c: number };
    assert.equal(Number(n.c), 1);
  });

  it('forceEditCycleGoal：无周期 → 404；空目标 → 400', () => {
    const db = cycleDb();
    expectCycleError(() => forceEditCycleGoal(db, { goal_text: '任何' }), 404, '没有进行中的周期');
    openCycle(db, { goal_text: '着重练胸', first_week_start: W1 });
    expectCycleError(() => forceEditCycleGoal(db, { goal_text: '  ' }), 400, '不能为空');
  });

  it('closeActiveCycle：状态置 closed + 记录时间；无周期时返回 null', () => {
    const db = cycleDb();
    assert.equal(closeActiveCycle(db), null);
    openCycle(db, { goal_text: '着重练胸', first_week_start: W1 });
    const closed = closeActiveCycle(db, new Date('2026-01-30T02:00:00Z'));
    assert.equal(closed?.status, 'closed');
    assert.equal(getActiveCycle(db), null, '关掉之后没有活动周期');
    const row = db.prepare(`SELECT status, closed_at FROM training_cycle`).get() as unknown as {
      status: string;
      closed_at: string | null;
    };
    assert.equal(row.status, 'closed');
    assert.ok((row.closed_at ?? '').startsWith('2026-01-30'));
  });

  it('isCycleExpired：今天所在周越过最后一周才算跑完', () => {
    const db = cycleDb();
    const cycle = openCycle(db, { goal_text: '着重练胸', first_week_start: W1 });
    assert.equal(isCycleExpired(cycle, '2026-01-28', 1), false, '第 4 周内');
    assert.equal(isCycleExpired(cycle, '2026-02-02', 1), true, '第 5 周 = 跑完');
  });
});

// ---------------------------------------------------------------------------
// 周期上下文 → AI 输入
// ---------------------------------------------------------------------------

const POOL: CandidatePoolItem[] = [
  { catalog_id: 1, name: '杠铃卧推', primary_muscles: ['chest'], last_weight: 60, last_sets_reps: '4×8', used_recently: true, mapping_confidence: 'high' },
  { catalog_id: 2, name: '杠铃深蹲', primary_muscles: ['quads', 'glutes'], last_weight: 90, last_sets_reps: '4×6', used_recently: true, mapping_confidence: 'high' },
];

const CONSTRAINTS: Constraints = {
  goal: {
    goal_type: '减脂保肌',
    sessions_per_week: 2,
    min_duration_min: 60,
    max_duration_min: 90,
    preferred_dows: [1, 3],
  },
  hard_rules: [],
  soft_rules: [],
};

const WRITE_RULES: WritingRules = {
  max_trains_per_batch: 4,
  max_movements_per_train: 15,
  max_sets_per_movement: 20,
  same_day_per_batch: true,
  movement_name_must_come_from: 'candidate_pool',
  name_language: 'zh-CN 标准名',
};

const REPORT = {
  window: { trend_start: '2026-01-05', trend_end: '2026-03-29', weeks: ANALYSIS_WINDOW_WEEKS, last_session: null },
  basic_stats: {
    total_sessions: 12,
    sessions_per_week: 1,
    avg_duration_min: 70,
    duration_median_min: 70,
    strength_sessions: 12,
    cardio_sessions: 0,
    total_effective_sets: 100,
    preferred_dows: [1, 3],
  },
  muscle_volume: {
    chest: { sets_total: 8, sets_per_week_seg0: 2, sets_per_week_seg1: 2, sets_per_week_seg2: 2 },
    quads: { sets_total: 8, sets_per_week_seg0: 2, sets_per_week_seg1: 2, sets_per_week_seg2: 2 },
  },
  muscle_trends: [
    { muscle_code: 'chest', verdict: 'insufficient', seg0: 2, seg1: 2, seg2: 2, delta_recent_pct: null },
    { muscle_code: 'quads', verdict: 'stable', seg0: 2, seg1: 2, seg2: 2, delta_recent_pct: null },
  ],
  movement_trends: [
    { catalog_id: 1, name: '杠铃卧推', verdict: 'plateau', weeks_with_data: 8, delta_weight_pct: 0, last_performed: '2026-03-25' },
    { catalog_id: 2, name: '杠铃深蹲', verdict: 'progress', weeks_with_data: 8, delta_weight_pct: 5, last_performed: '2026-03-27' },
  ],
  structure: { push_pull_ratio: 1.3, upper_lower_ratio: 1.1 },
  findings: [{ code: 'R-AG-03', severity: 'high', title: '胸长期训练不足', detail: '近4周 2 组', evidence: { metric: 'x', value: 1, window: '8周' } }],
  constraints: CONSTRAINTS,
  candidate_pool: POOL,
  writing_rules: WRITE_RULES,
} as unknown as AnalysisReport;

/** 只捕获 system prompt 的假 transport —— 零真实网络。 */
function capturePrompt(db: Db): { gw: AiGateway; prompt: () => string } {
  let captured = '';
  const gw = createAiGateway(db, {
    promptsDir: 'server/ai/prompts',
    maxAttempts: 1,
    http: { mode: 'http', baseUrl: 'http://127.0.0.1:1/v1', model: 'test', apiKey: null, maxTokens: 8192, temperature: 0.3, timeoutMs: 1000 },
    fetchImpl: async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as { messages?: Array<{ role: string; content: string }> };
      captured = body.messages?.find((m) => m.role === 'system')?.content ?? '';
      return new Response(JSON.stringify({ choices: [{ message: { content: '{}' } }] }), { status: 200 });
    },
  });
  return { gw, prompt: () => captured };
}

describe('周期上下文进 AI 输入（V2，V3 起经摘要层）', () => {
  it('cycleContextFor：周次正确、长期目标取自实时训练基础', () => {
    const db = cycleDb();
    openCycle(db, { goal_text: '着重练胸', first_week_start: W1 });
    const ctx = cycleContextFor(db, W3);
    assert.equal(ctx?.goalText, '着重练胸');
    assert.equal(ctx?.longTermGoal, '减脂保肌');
    assert.equal(ctx?.weekNo, 3);
    assert.equal(ctx?.totalWeeks, 4);
    assert.equal(ctx?.isDeload, false);
    assert.equal(cycleContextFor(db, W5), null, '不在周期内 → 不带周期上下文');
  });

  it('gateway prompt：周期目标与减量周提示真的渲染进了 system prompt', async () => {
    const db = cycleDb();
    seedMuscleGroups(db);
    openCycle(db, { goal_text: '着重练胸', first_week_start: W1 });
    // 第 4 周 = 减量周：走真实链路（周期行 → cycleContextFor → digest.week → prompt）
    const digest = buildPlanDigest(db, {
      report: REPORT,
      constraints: { goal: CONSTRAINTS.goal, hard_rules: [] },
      weekStart: W4,
      cycle: cycleContextFor(db, W4),
    });
    assert.equal(digest.week.is_deload, true, '摘要层必须把第 4 周标成减量周');
    assert.equal(digest.week.week_no, 4);

    const { gw, prompt } = capturePrompt(db);
    await gw.generatePlan({ digest });

    const p = prompt();
    assert.ok(p.includes('着重练胸'), 'prompt 必须含周期目标');
    assert.ok(p.includes('第 4 周'), 'prompt 必须含周次');
    assert.ok(p.includes('减量周'), '第 4 周必须提示减量');
    assert.ok(p.includes('不得加重'), '减量周必须禁止加重');
    assert.ok(p.includes('减脂保肌'), '长期目标作为背景参考也要给到');
    assert.ok(!p.includes('{{CYCLE_CONTEXT}}'), '占位必须被替换掉');
  });

  it('gateway prompt：未开周期时给出明确说明，不留空占位', async () => {
    const db = cycleDb();
    seedMuscleGroups(db);
    const digest = buildPlanDigest(db, {
      report: REPORT,
      constraints: { goal: CONSTRAINTS.goal, hard_rules: [] },
      weekStart: W4,
      cycle: null,
    });
    assert.equal(digest.week.cycle_goal, null);
    const { gw, prompt } = capturePrompt(db);
    await gw.generatePlan({ digest });
    assert.ok(prompt().includes('未开启训练周期'));
    assert.ok(!prompt().includes('{{CYCLE_CONTEXT}}'));
  });

  it('摘要层把周期目标与「该补/该减/没练到」一起交给 AI', () => {
    const db = cycleDb();
    seedMuscleGroups(db);
    openCycle(db, { goal_text: '着重练胸', first_week_start: W1 });
    const digest = buildPlanDigest(db, {
      report: REPORT,
      constraints: { goal: CONSTRAINTS.goal, hard_rules: [] },
      weekStart: W3,
      cycle: cycleContextFor(db, W3),
    });
    assert.deepEqual(digest.week.focus_muscles, ['chest'], 'insufficient → 本周该补');
    assert.deepEqual(digest.week.untrained_muscles, ['glutes'], '窗口内 0 组 → 该练没练到');
    assert.equal(digest.week.cycle_goal, '着重练胸');
    assert.equal(digest.week.long_term_goal, '减脂保肌');
    assert.ok(digest.candidate_pool.every((p) => typeof p.trend === 'string'), '池子每条都带趋势判定');
  });
});

// ---------------------------------------------------------------------------
// 模板减量周
// ---------------------------------------------------------------------------

describe('规则模板：减量周（V2）', () => {
  it('第 4 周：容量减半、重量 −10%（池子不带 progression 时的兜底路径）、标题标注减量周', () => {
    const db = cycleDb();
    const normal = buildTemplateDraft(W1, POOL, CONSTRAINTS, null);
    const deload = buildTemplateDraft(W4, POOL, CONSTRAINTS, {
      goalText: '着重练胸',
      longTermGoal: '减脂保肌',
      weekNo: 4,
      totalWeeks: 4,
      isDeload: true,
    });

    const normEx = normal.days.flatMap((d) => d.exercises);
    const delEx = deload.days.flatMap((d) => d.exercises);
    assert.ok(normEx.length > 0 && delEx.length > 0);
    assert.equal(delEx.length, normEx.length, '减量周不减动作数量，只减容量与强度');

    for (let i = 0; i < normEx.length; i++) {
      assert.equal(delEx[i].name, normEx[i].name, '动作顺序不变');
      assert.equal(
        delEx[i].sets,
        Math.max(1, Math.round(normEx[i].sets / 2)),
        `${normEx[i].name}：容量减半，实际 ${normEx[i].sets} → ${delEx[i].sets}`,
      );
    }
    const squatNorm = normEx.find((e) => e.name === '杠铃深蹲');
    const squatDel = delEx.find((e) => e.name === '杠铃深蹲');
    assert.ok(squatNorm && squatDel);
    assert.equal(squatNorm.weight_kg, 90);
    assert.equal(squatDel.weight_kg, 81, '90 × 0.9 = 81（减量 −10%，向下夹到 0.5 精度）');
    assert.ok(deload.days.every((d) => d.title.includes('减量周')));
    assert.ok(deload.days.every((d) => (d.why?.summary ?? '').includes('减量')));
  });

  it('非减量周：与不带周期上下文时逐字段一致', () => {
    const db = cycleDb();
    const draft = buildTemplateDraft(W2, POOL, CONSTRAINTS, {
      goalText: '着重练胸',
      longTermGoal: null,
      weekNo: 2,
      totalWeeks: 4,
      isDeload: false,
    });
    const plain = buildTemplateDraft(W2, POOL, CONSTRAINTS, null);
    assert.deepEqual(draft, plain, '第 1~3 周不应因为开了周期改变任何排期');
  });
});

describe('迁移 v4：training_cycle 表', () => {
  it('表存在、UNIQUE(first_week_start) 生效、状态 CHECK 生效', () => {
    const db = cycleDb();
    const t = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='training_cycle'`).get();
    assert.ok(t, 'training_cycle 表应存在');
    // v4 引入本表；断言「≥4」而不是「=4」——后续版本（v5 daily_note/weekly_review）会抬高这个数字，
    // 这条用例要守的是「v4 已经跑过」，不是「当前就是最后一版」。
    const v = db.prepare(`SELECT MAX(version) AS v FROM schema_migration`).get() as unknown as { v: number };
    assert.ok(Number(v.v) >= 4, `schema 版本应至少到 v4，实际 ${Number(v.v)}`);

    openCycle(db, { goal_text: '着重练胸', first_week_start: W1 });
    assert.throws(() => {
      db.prepare(
        `INSERT INTO training_cycle (cycle_no, first_week_start, last_week_start, goal_text, status, created_at)
         VALUES (9, ?, ?, 'x', 'active', 'now')`,
      ).run(W1, W4);
    }, /UNIQUE/i);
    assert.throws(() => {
      db.prepare(
        `INSERT INTO training_cycle (cycle_no, first_week_start, last_week_start, goal_text, status, created_at)
         VALUES (9, '2026-03-02', '2026-03-23', 'x', 'paused', 'now')`,
      ).run();
    }, /CHECK/i);
  });
});

// ---------------------------------------------------------------------------
// GET /api/cycle 的 `plan_week`：必须按**计划周**算，不能按「今天」
// ---------------------------------------------------------------------------

/**
 * 这条用例守的是一个真实踩过的 bug（2026-09-30）：
 *
 * 首页整页讲的是**下一周**（`nextWeekStart` 永远 +7），而周期通常正是从下一周开始计的。
 * 老实现只返回「今天所在周」的周次 → 刚锁定周期时 `week_no` 是 null，
 * 界面就显示「本周期第 —/4 周」，还会误报「下一周不在这个周期的 4 周范围内」，
 * 而排计划用的 `cycleContextFor(db, planWeek)` 明明算得出第 1 周。
 *
 * 断言是**关系式**的、不依赖跑测试那天是几号：周期从 `nextWeekStart(today)` 起，
 * 那么无论今天几号，「计划周 = 第 1 周」而「今天所在周 = 不在周期内」都必然成立。
 */
describe('GET /api/cycle：plan_week 按计划周算', () => {
  function fakeReq(method: string, url = '/api/cycle'): IncomingMessage {
    const stream = Readable.from([]) as unknown as IncomingMessage;
    stream.method = method;
    stream.url = url;
    return stream;
  }

  /**
   * 🔴 让「计划周」必定顺延到下一周（而不是落在本周 = 起始周）。
   *
   * V12（2026-10-05）起，`plan_week` 由 `planningWeekStart` 决定：
   *   - 今天就是周起点（周一）→ **无条件**排本周（`back === 0` 分支，此时整周都还没开始，
   *     没有「剩下的训练日」这个概念）；
   *   - 否则本周还剩没过训练日 → 也排本周（起始周 Week 0）。
   *
   * 这组用例讲的是「周期从下一周起」的常规情况，所以两条分支都要排掉。
   * 周一那天没法用训练日构造（`back === 0` 不看训练日），返回 `false` 让调用方跳过。
   *
   * @returns 是否成功构造出「本周已无训练日」
   */
  function setPastTrainingDows(db: Db): boolean {
    const today = todayLocal();
    const todayDow = new Date(`${today}T00:00:00Z`).getUTCDay();
    if (todayDow === 1) return false; // 今天是周一 → planningWeekStart 恒排本周

    const past: number[] = [];
    for (let back = 1; back <= 6 && past.length < 3; back++) {
      const d = new Date(`${today}T00:00:00Z`);
      d.setUTCDate(d.getUTCDate() - back);
      const dow = d.getUTCDay();
      if (!past.includes(dow)) past.push(dow);
    }
    db.prepare(`UPDATE user_goal SET preferred_dows = ? WHERE is_active = 1`).run(JSON.stringify(past));
    // 自检：确实没剩训练日，否则用例前提不成立
    return planningWeekStart(today, 1, past) !== addDaysForTest(today, -((todayDow - 1 + 7) % 7));
  }

  function addDaysForTest(datestr: string, n: number): string {
    const d = new Date(`${datestr}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  }

  /** 训练日 = 未来两天（造「本周还有训练日」的场景时用） */
  function currentTrainingDowsForTest(today: string): number[] {
    const out: number[] = [];
    for (let i = 1; i <= 6 && out.length < 2; i++) {
      const d = new Date(`${today}T00:00:00Z`);
      d.setUTCDate(d.getUTCDate() + i);
      const dow = d.getUTCDay();
      if (!out.includes(dow)) out.push(dow);
    }
    return out;
  }

  async function getCycle(db: Db): Promise<Record<string, unknown>> {
    let body: unknown = null;
    const res = {
      writeHead() {
        return res;
      },
      end(buf?: Buffer | string) {
        body = buf === undefined ? null : JSON.parse(buf.toString('utf8'));
        return res;
      },
    } as unknown as ServerResponse;
    const handled = await handleCycleRoutes(db)(fakeReq('GET'), res, '/api/cycle');
    assert.equal(handled, true);
    return body as Record<string, unknown>;
  }

  it('周期从下一周起：plan_week 是第 1 周，而「今天所在周」不在周期内', async () => {
    const db = cycleDb();
    // 周一那天 planningWeekStart 恒排本周（起始周），构造不出「周期从下周起」的场景 → 跳过。
    if (!setPastTrainingDows(db)) return;
    const planStart = nextWeekStart(todayLocal(), 1);
    openCycle(db, { goal_text: '着重练胸', first_week_start: planStart });

    const p = await getCycle(db);
    const planWeek = p.plan_week as { week_no: number | null; in_cycle: boolean; is_deload: boolean; expired: boolean };

    assert.equal(p.cycle !== null, true);
    assert.equal(planWeek.week_no, 1, '计划周必须是本周期第 1 周 —— 界面靠它显示「第 N/4 周」');
    assert.equal(planWeek.in_cycle, true);
    assert.equal(planWeek.is_deload, false);
    assert.equal(planWeek.expired, false);
    // 「今天所在周」还在周期开始之前 —— 这正是不能拿它渲染首页的原因
    assert.equal(p.week_no, null, '今天所在的周确实不在周期内（周期还没开始）');
  });

  it('本周还有训练日 → 计划周落在本周（起始周 Week 0，不占周次）', async () => {
    const db = cycleDb();
    const today = todayLocal();
    const future = currentTrainingDowsForTest(today);
    if (future.length === 0) return; // 理论不可达（往后 6 天必然存在），保守起见留个出口
    db.prepare(`UPDATE user_goal SET preferred_dows = ? WHERE is_active = 1`).run(JSON.stringify(future));

    const planStart = nextWeekStart(today, 1);
    openCycle(db, { goal_text: '着重练胸', first_week_start: planStart });

    const p = await getCycle(db);
    const pw = p.plan_week as { week_no: number | null; is_starter_week: boolean; in_cycle: boolean };
    assert.equal(pw.is_starter_week, true, '本周还有训练日 → 起始周');
    assert.equal(pw.week_no, null, '起始周不占周期第 1 周（否则用户会以为「练完这周下周还是第 1 周」是 bug）');
    assert.equal(pw.in_cycle, false, '起始周在周期开始之前，不在周期内');
    assert.equal(p.plan_week_start, planningWeekStart(today, 1, future), '排计划实际落在本周起点');
    assert.notEqual(p.plan_week_start, planStart, '本周 ≠ 开周期的起点（起点永远是下一个完整周）');
  });

  it('没开周期 → plan_week 全 false/null（不是缺字段）', async () => {
    const p = await getCycle(cycleDb());
    assert.equal(p.cycle, null);
    assert.deepEqual(p.plan_week, {
      week_no: null,
      in_cycle: false,
      is_deload: false,
      expired: false,
      is_starter_week: false,
    });
  });

  it('周期最后一周跑完 → plan_week.expired = true（该开新周期了）', async () => {
    const db = cycleDb();
    // 先排除「起始周」这条分支，专测越界。周一那天排除不掉 → 跳过。
    if (!setPastTrainingDows(db)) return;
    // 周期从「上一周」开始 → 计划周已是第 2 周；再往前铺 3 个周期长度就能越过最后一周期
    const planStart = nextWeekStart(todayLocal(), 1);
    const past = (() => {
      const d = new Date(`${planStart}T00:00:00Z`);
      d.setUTCDate(d.getUTCDate() - 28);
      return d.toISOString().slice(0, 10);
    })();
    openCycle(db, { goal_text: '上一个周期', first_week_start: past });

    const p = await getCycle(db);
    const planWeek = p.plan_week as { expired: boolean; week_no: number | null };
    assert.equal(planWeek.week_no, null, '已经越过周期最后一周');
    assert.equal(planWeek.expired, true, '计划周越界 = 这个周期该收尾');
  });
});
