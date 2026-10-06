/**
 * 周复盘测试（PRD-v2 §10.3 V8）：周视图逐日口径 + 日感受 + AI 复盘门禁 + 摘要层闭环。
 *
 * 红线：零真实网络（gateway 用手工 mock）；db 用临时文件全量迁移库。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  WeeklyReviewError,
  buildWeekView,
  generateWeeklyReview,
  recentWeekStarts,
  weekDatesOf,
} from '../server/review/weeklyReview.js';
import { earliestManagedWeek, ensureTakeover, getTakeover } from '../server/review/takeover.js';
import { closeActiveCycle, openCycle } from '../server/cycle/cycleService.js';
import { DailyNoteError, saveDailyNote } from '../server/review/dailyNote.js';
import { saveWeekNote } from '../server/week/weekNoteService.js';
import { buildPlanDigest } from '../server/ai/digest.js';
import type { PlanInputDigest } from '../server/ai/digest.js';
import type { AiGateway, WeeklyReviewInput } from '../server/ai/schemas.js';
import type { AnalysisReport } from '../server/analysis/reportSchema.js';
import { makeTempDb } from './fixtures.js';
import type { Db } from '../server/db/index.js';

/** 一周 2026-09-28（周一）~ 10-04（周日）。 */
const WEEK = { start: '2026-09-28', end: '2026-10-04' };
/** 「下周一」——把这一周明确置于过去。 */
const AFTER_WEEK = '2026-10-05T09:00:00Z';
const BEFORE_WEEK = '2026-10-01T09:00:00Z';

function ms(iso: string): number {
  return new Date(iso).getTime();
}

function baseDb(): Db {
  const { db } = makeTempDb();
  db.prepare(
    `INSERT INTO user_goal (goal_type, sessions_per_week, min_duration_min, max_duration_min, week_start_dow, preferred_dows, is_active, effective_from, created_at)
     VALUES ('fatloss_keep_strength', 2, 60, 90, 1, '[1,4]', 1, '2026-01-01', '2026-01-01T00:00:00Z')`,
  ).run();
  const ins = db.prepare(
    `INSERT OR IGNORE INTO movement_catalog (id, seq_no, name, name_norm, segment_code, is_cardio, is_stretch, created_at)
     VALUES (?, ?, ?, ?, NULL, 0, 0, '2026-01-01T00:00:00Z')`,
  );
    ins.run(1, 1, '杠铃卧推', '杠铃卧推');
    ins.run(2, 2, '杠铃深蹲', '杠铃深蹲');
    seedCatalog(db, 3, '高位下拉');
    return db;
}

/** 追加一个动作到目录（plan_exercise.catalog_id 的外键目标）。 */
function seedCatalog(db: Db, id: number, name: string): void {
  db.prepare(
    `INSERT OR IGNORE INTO movement_catalog (id, seq_no, name, name_norm, segment_code, is_cardio, is_stretch, created_at)
     VALUES (?, ?, ?, ?, NULL, 0, 0, '2026-01-01T00:00:00Z')`,
  ).run(id, id, name, name);
}

/** 插一天训练：movements = [{name, catalogId, sets: [{weight, done, warmup}]}] */
function seedSession(
  db: Db,
  datestr: string,
  movements: Array<{ name: string; catalogId: number; sets: Array<{ weight?: number; done?: number; warmup?: number }> }>,
  opts: { duration?: number; localid?: string } = {},
): void {
  const sid = Number(
    db
      .prepare(
        `INSERT INTO train_session (datestr, localid, duration_min, is_outlier, is_cardio, is_rest, content_hash, synced_at)
         VALUES (?, ?, ?, 0, 0, 0, ?, '2026-10-05T00:00:00Z')`,
      )
      .run(datestr, opts.localid ?? `${datestr}-s`, opts.duration ?? 70, `h-${datestr}`).lastInsertRowid,
  );
  movements.forEach((m, mi) => {
    const smId = Number(
      db
        .prepare(
          `INSERT INTO session_movement (session_id, ord, name_raw, name_norm, catalog_id, resolve_status, is_cardio, is_stretch, created_at)
           VALUES (?, ?, ?, ?, ?, 'exact', 0, 0, '2026-10-05T00:00:00Z')`,
        )
        .run(sid, mi + 1, m.name, m.name, m.catalogId).lastInsertRowid,
    );
    m.sets.forEach((s, si) => {
      db.prepare(
        `INSERT INTO movement_set (session_movement_id, ord, done, is_warmup, warmup_source, weight_kg, reps)
         VALUES (?, ?, ?, ?, ?, ?, 8)`,
      ).run(smId, si + 1, s.done ?? 1, s.warmup ?? 0, s.warmup === 1 ? 'server_set_type' : null, s.weight ?? null);
    });
  });
}

/** 插一周计划：days = [{datestr, title, exercises: [{catalog_id, name, sets}]}] */
function seedPlan(
  db: Db,
  days: Array<{ datestr: string; title: string; exercises: Array<{ catalog_id: number | null; name: string; sets: number; weight?: number }> }>,
  opts: { status?: string } = {},
): number {
  const now = '2026-09-27T00:00:00Z';
  const planId = Number(
    db
      .prepare(
        `INSERT INTO plan (week_start, week_end, version_no, status, source, ai_attempts, created_at, updated_at)
         VALUES (?, ?, 1, ?, 'ai', 1, ?, ?)`,
      )
      .run(WEEK.start, WEEK.end, opts.status ?? 'written', now, now).lastInsertRowid,
  );
  days.forEach((d, di) => {
    const pdId = Number(
      db
        .prepare(
          `INSERT INTO plan_day (plan_id, datestr, dow, ord, title, est_duration_min, lock_state) VALUES (?, ?, ?, ?, ?, 65, 'planned')`,
        )
        .run(planId, d.datestr, new Date(`${d.datestr}T00:00:00Z`).getUTCDay(), di + 1, d.title).lastInsertRowid,
    );
    d.exercises.forEach((e, ei) => {
      db.prepare(
        `INSERT INTO plan_exercise (plan_day_id, ord, catalog_id, name, sets, reps, weight_kg, is_cardio, source)
         VALUES (?, ?, ?, ?, ?, 8, ?, 0, 'ai')`,
      ).run(pdId, ei + 1, e.catalog_id, e.name, e.sets, e.weight ?? 60);
    });
  });
  return planId;
}

/** 只插一行 plan（不排动作）：用于钉住「已排过计划的最早周」。 */
function seedPlanRow(db: Db, weekStart: string, weekEnd: string, status: string): void {
  const now = '2026-09-27T00:00:00Z';
  db.prepare(
    `INSERT INTO plan (week_start, week_end, version_no, status, source, ai_attempts, created_at, updated_at)
     VALUES (?, ?, 1, ?, 'ai', 1, ?, ?)`,
  ).run(weekStart, weekEnd, status, now, now);
}

function mockWeekGw(out: { verdict: string; adjustments: string[]; note_reply: string }, capture?: (i: WeeklyReviewInput) => void): AiGateway {
  return {
    generatePlan: async () => {
      throw new Error('generatePlan 不在本测试范围');
    },
    explainPlan: async () => {
      throw new Error('explainPlan 不在本测试范围');
    },
    summarizeReview: async () => {
      throw new Error('summarizeReview 不在本测试范围');
    },
    summarizeWeek: async (input) => {
      capture?.(input);
      return out;
    },
  };
}

// ---------------------------------------------------------------------------
// 逐日口径
// ---------------------------------------------------------------------------

describe('buildWeekView（V8 逐日手账）', () => {
  it('恒返回 7 天；计划 4 组实际 4 组 → done；计划 4 组实际 2 组 → partial；计划 7 组实际 0 → missed', () => {
    const db = baseDb();
    seedPlan(db, [
      { datestr: '2026-09-28', title: '上肢推', exercises: [{ catalog_id: 1, name: '杠铃卧推', sets: 4 }] },
      { datestr: '2026-10-01', title: '下肢力量', exercises: [{ catalog_id: 2, name: '杠铃深蹲', sets: 4, weight: 100 }] },
      {
        datestr: '2026-10-02',
        title: '上肢拉',
        exercises: [
          { catalog_id: 1, name: '杠铃卧推', sets: 4 },
          { catalog_id: 3, name: '高位下拉', sets: 3 },
        ],
      },
      { datestr: '2026-10-03', title: '补练', exercises: [{ catalog_id: 2, name: '杠铃深蹲', sets: 4 }] },
    ]);
    // 09-28 做满 4 组；10-01 只做 2 组；10-02/10-03 一点没做
    seedSession(db, '2026-09-28', [
      { name: '杠铃卧推', catalogId: 1, sets: [{ weight: 60 }, { weight: 60 }, { weight: 60 }, { weight: 60 }] },
    ]);
    seedSession(db, '2026-10-01', [{ name: '杠铃深蹲', catalogId: 2, sets: [{ weight: 90 }, { weight: 90 }] }]);

    const v = buildWeekView(db, WEEK.start, ms(AFTER_WEEK));
    assert.equal(v.days.length, 7);
    assert.equal(v.week_end, WEEK.end);
    assert.equal(v.is_over, true);
    const byDate = new Map(v.days.map((d) => [d.datestr, d]));
    assert.equal(byDate.get('2026-09-28')!.status, 'done');
    assert.equal(byDate.get('2026-09-28')!.completion, 1);
    assert.equal(byDate.get('2026-10-01')!.status, 'partial');
    assert.equal(byDate.get('2026-10-01')!.completion, 0.5);
    assert.equal(byDate.get('2026-10-02')!.status, 'missed');
    assert.equal(byDate.get('2026-10-02')!.planned!.planned_sets, 7);
    assert.equal(byDate.get('2026-10-02')!.actual.effective_sets, 0);
    assert.equal(byDate.get('2026-10-03')!.status, 'missed');
    assert.deepEqual(v.summary.missed_days.sort(), ['2026-10-02', '2026-10-03']);
    // 周级数字走 loadPlanActual：按 catalog_id 汇总（同一动作一周排两次算一个条目）
    assert.equal(v.summary.planned_sets, 19); // 4 + 4 + (4+3) + 4
    assert.equal(v.summary.effective_sets, 6); // 4 + 2
    assert.equal(v.summary.completion, 0.32); // round2(6/19) = round2(0.3158)
    // 高位下拉计划了 3 组、一组没做 → 唯一一个真正「一次没做」的动作
    assert.deepEqual(v.summary.skipped_movements, ['高位下拉']);
    // 深蹲计划 100kg 实际只到 90kg → 未达成重量（卧推 60 达标，不算）
    assert.deepEqual(v.summary.missed_weight, ['杠铃深蹲']);
    // 逐动作明细（2026-09-30 手账改版 → 当晚简化）：杠铃卧推 4 个有效组归成一条，只留「几组 · 多少公斤」
    const items = byDate.get('2026-09-28')!.actual.items;
    assert.equal(items.length, 1);
    assert.equal(items[0]!.name, '杠铃卧推');
    assert.equal(items[0]!.sets, 4);
    assert.equal(items[0]!.weight, '60kg', `4 组同为 60kg → 去重后只剩一个，实际 ${items[0]!.weight}`);
  });

  /**
   * 🔴 回归（2026-09-30 晚）：次数从明细里拿掉之后，**重量必须去重保序**。
   * 递减组 / 加重组会产生多个重量，若不汇总就会退化成逐组长串（用户明确嫌占位置）。
   */
  it('逐动作明细：同动作出现多个重量 → 按首见顺序去重列出', () => {
    const db = baseDb();
    seedSession(db, '2026-09-29', [
      { name: '杠铃卧推', catalogId: 1, sets: [{ weight: 60 }, { weight: 60 }, { weight: 62.5 }] },
    ]);
    const v = buildWeekView(db, WEEK.start, ms(AFTER_WEEK));
    const d = v.days.find((x) => x.datestr === '2026-09-29')!;
    assert.equal(d.actual.items.length, 1);
    assert.equal(d.actual.items[0]!.sets, 3);
    assert.equal(d.actual.items[0]!.weight, '60kg / 62.5kg');
  });

  it('热身组与未打勾组不计入有效组（全局唯一判据 isEffectiveSet）', () => {
    const db = baseDb();
    seedPlan(db, [{ datestr: '2026-09-28', title: '上肢推', exercises: [{ catalog_id: 1, name: '杠铃卧推', sets: 4 }] }]);
    seedSession(db, '2026-09-28', [
      {
        name: '杠铃卧推',
        catalogId: 1,
        sets: [{ weight: 40, warmup: 1 }, { weight: 40, warmup: 1 }, { weight: 60 }, { weight: 60, done: 0 }],
      },
    ]);
    const v = buildWeekView(db, WEEK.start, ms(AFTER_WEEK));
    const d = v.days.find((x) => x.datestr === '2026-09-28')!;
    assert.equal(d.actual.effective_sets, 1, '4 组里只有 1 组是既完成又非热身的有效组');
    assert.equal(d.status, 'partial'); // 1/4 = 25% < 80%
    assert.equal(d.completion, 0.25);
  });

  it('没计划但练了 → extra（额外收益，不算欠账）；没计划也没练 → rest', () => {
    const db = baseDb();
    seedPlan(db, [{ datestr: '2026-09-28', title: '上肢推', exercises: [{ catalog_id: 1, name: '杠铃卧推', sets: 4 }] }]);
    seedSession(db, '2026-09-28', [{ name: '杠铃卧推', catalogId: 1, sets: [{ weight: 60 }] }]);
    seedSession(db, '2026-09-30', [{ name: '杠铃深蹲', catalogId: 2, sets: [{ weight: 90 }] }]);

    const v = buildWeekView(db, WEEK.start, ms(AFTER_WEEK));
    const byDate = new Map(v.days.map((d) => [d.datestr, d]));
    assert.equal(byDate.get('2026-09-30')!.status, 'extra');
    assert.equal(byDate.get('2026-09-30')!.completion, null, '没有计划就没有完成度可谈');
    assert.equal(byDate.get('2026-09-29')!.status, 'rest');
    // extra 不产生 skipped，也不进 missed_days
    assert.deepEqual(v.summary.missed_days, []);
    assert.equal(v.summary.trained_days, 2);
  });

  /**
   * 回归：**没计划的一周，周级数字也必须反映真实训练量**。
   *
   * 旧实现把 summary 取自 `loadPlanActual`（口径是「计划 vs 实际」，只统计计划里出现过的动作）——
   * 没计划时全为 0，于是页面上「有效组 0 / 练过的天 0」，而每张日卡都写着「26 有效组」。
   * 用户历史周基本都没计划，所以这个自相矛盾在真实数据上必然出现（2026-09-30 复盘页截图抓到）。
   */
  it('没计划的一周：仍返回 7 天 + 实际，plan 为 null；周级数字来自逐日事实而不是计划', () => {
    const db = baseDb();
    seedSession(db, '2026-09-29', [{ name: '杠铃卧推', catalogId: 1, sets: [{ weight: 60 }, { weight: 60 }] }]);
    const v = buildWeekView(db, WEEK.start, ms(AFTER_WEEK));
    assert.equal(v.plan, null);
    assert.equal(v.days.length, 7);
    assert.equal(v.summary.planned_sessions, 0);
    assert.equal(v.summary.completion, 0, '没有计划就没有完成度可谈');
    assert.equal(v.summary.planned_sets, 0);
    const day = v.days.find((d) => d.datestr === '2026-09-29')!;
    assert.equal(day.status, 'extra');
    assert.equal(day.actual.effective_sets, 2);
    assert.equal(v.summary.effective_sets, 2, '周级有效组必须等于逐日实际之和');
    assert.equal(v.summary.trained_days, 1, '练过的天必须与日卡一致');
  });

  it('未来日期 → upcoming；周未结束时 is_over=false', () => {
    const db = baseDb();
    seedSession(db, '2026-09-28', [{ name: '杠铃卧推', catalogId: 1, sets: [{ weight: 60 }] }]);
    const v = buildWeekView(db, WEEK.start, ms(BEFORE_WEEK)); // 2026-10-01 当天
    assert.equal(v.is_over, false);
    const byDate = new Map(v.days.map((d) => [d.datestr, d]));
    assert.equal(byDate.get('2026-10-02')!.status, 'upcoming');
    assert.equal(byDate.get('2026-10-04')!.status, 'upcoming');
    assert.equal(byDate.get('2026-09-28')!.status, 'extra', '今天之前的照常判定');
  });

  it('🔴 今天还没练不算 missed（手账周中打开不该看到一串红），missed_days 也不含今天与未来', () => {
    const db = baseDb();
    // 09-28 与 10-01 排了计划；「现在」= 10-01 当天，用户还没练
    seedPlan(db, [
      { datestr: '2026-09-28', title: '上肢推', exercises: [{ catalog_id: 1, name: '杠铃卧推', sets: 4 }] },
      { datestr: '2026-10-01', title: '下肢力量', exercises: [{ catalog_id: 2, name: '杠铃深蹲', sets: 4 }] },
      { datestr: '2026-10-03', title: '上肢拉', exercises: [{ catalog_id: 1, name: '杠铃卧推', sets: 4 }] },
    ]);
    const v = buildWeekView(db, WEEK.start, ms(BEFORE_WEEK)); // 2026-10-01 当天
    const byDate = new Map(v.days.map((d) => [d.datestr, d]));
    assert.equal(byDate.get('2026-10-01')!.status, 'upcoming', '今天还没过完，不能判没练');
    assert.equal(byDate.get('2026-10-03')!.status, 'upcoming');
    assert.equal(byDate.get('2026-09-28')!.status, 'missed', '已经过去且没练的照常判');
    assert.deepEqual(v.summary.missed_days, ['2026-09-28'], 'missed_days 只含已经过去的日子');
  });

  it('今天练了 → 照常判 done/partial，不当成 upcoming', () => {
    const db = baseDb();
    seedPlan(db, [{ datestr: '2026-10-01', title: '下肢力量', exercises: [{ catalog_id: 2, name: '杠铃深蹲', sets: 4 }] }]);
    seedSession(db, '2026-10-01', [
      { name: '杠铃深蹲', catalogId: 2, sets: [{ weight: 90 }, { weight: 90 }, { weight: 90 }, { weight: 90 }] },
    ]);
    const v = buildWeekView(db, WEEK.start, ms(BEFORE_WEEK));
    const today = v.days.find((d) => d.datestr === '2026-10-01')!;
    assert.equal(today.status, 'done');
    assert.equal(today.completion, 1);
  });

  it('archived 计划不参与（与 loadPlanActual 同一规则）', () => {
    const db = baseDb();
    seedPlan(db, [{ datestr: '2026-09-28', title: '旧计划', exercises: [{ catalog_id: 1, name: '杠铃卧推', sets: 4 }] }], {
      status: 'archived',
    });
    const v = buildWeekView(db, WEEK.start, ms(AFTER_WEEK));
    assert.equal(v.plan, null);
    assert.equal(v.days.find((d) => d.datestr === '2026-09-28')!.planned, null);
  });

  it('非法 week_start → 400', () => {
    const db = baseDb();
    assert.throws(
      () => buildWeekView(db, '2026/09/28', ms(AFTER_WEEK)),
      (e: unknown) => e instanceof WeeklyReviewError && e.status === 400,
    );
  });

  it('weekDatesOf 与 week_start_dow=0（周日起点）不冲突：仍是从 week_start 起 7 天', () => {
    assert.deepEqual(weekDatesOf('2026-09-27'), ['2026-09-27', '2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02', '2026-10-03']);
  });
});

// ---------------------------------------------------------------------------
// 日感受
// ---------------------------------------------------------------------------

describe('daily_note（V8 感受）', () => {
  it('写 → 读回；再写覆盖；清空即删行', () => {
    const db = baseDb();
    assert.equal(saveDailyNote(db, '2026-09-28', '今天推举很轻松', 1000).text, '今天推举很轻松');
    assert.equal(saveDailyNote(db, '2026-09-28', '改成 65kg 了', 2000).text, '改成 65kg 了');
    assert.equal(buildWeekView(db, WEEK.start, ms(AFTER_WEEK)).days[0].note, '改成 65kg 了');
    assert.equal(saveDailyNote(db, '2026-09-28', '   ', 3000).text, null);
    const n = db.prepare('SELECT COUNT(*) AS c FROM daily_note').get() as { c: number };
    assert.equal(Number(n.c), 0, '空文本必须删行，不留下「写过但是空」的状态');
    assert.equal(buildWeekView(db, WEEK.start, ms(AFTER_WEEK)).days[0].note, null);
  });

  it('超长文本 → 400；非法日期 → 400', () => {
    const db = baseDb();
    assert.throws(
      () => saveDailyNote(db, '2026-09-28', 'x'.repeat(1001), 1000),
      (e: unknown) => e instanceof DailyNoteError && e.status === 400,
    );
    assert.throws(
      () => saveDailyNote(db, '9/28', 'ok', 1000),
      (e: unknown) => e instanceof DailyNoteError && e.status === 400,
    );
  });

  it('notes_count 与逐日 note 一致', () => {
    const db = baseDb();
    saveDailyNote(db, '2026-09-29', '睡得不好', 1000);
    saveDailyNote(db, '2026-10-01', '出差，只练了半小时', 1000);
    const v = buildWeekView(db, WEEK.start, ms(AFTER_WEEK));
    assert.equal(v.summary.notes_count, 2);
    assert.equal(v.days.filter((d) => d.note !== null).length, 2);
  });

  // ⚠️ 「recentNotes / notesToSpecialNote 压成一行喂摘要层」那组用例已删除（2026-09-30）：
  //    那两个函数随语义反转一起删了 —— 日感受不再进排计划输入，
  //    周复盘 AI 直接从 buildWeekView 的逐日 note 取（见上面那条用例）。
});

// ---------------------------------------------------------------------------
// AI 复盘门禁
// ---------------------------------------------------------------------------

describe('generateWeeklyReview（V8）', () => {
  it('周未结束 → 400，且不许落库', async () => {
    const db = baseDb();
    ensureTakeover(db, WEEK.start); // 已接管，本用例只考「周未结束」这条
    seedSession(db, '2026-09-28', [{ name: '杠铃卧推', catalogId: 1, sets: [{ weight: 60 }] }]);
    await assert.rejects(
      () => generateWeeklyReview(db, mockWeekGw({ verdict: 'x', adjustments: ['y'], note_reply: '' }), 'test', { weekStart: WEEK.start, nowMs: ms(BEFORE_WEEK) }),
      (e: unknown) => e instanceof WeeklyReviewError && e.status === 400 && /还没结束/.test((e as Error).message),
    );
    const n = db.prepare('SELECT COUNT(*) AS c FROM weekly_review').get() as { c: number };
    assert.equal(Number(n.c), 0);
  });

  it('周已结束 → done，落 ai_summary + data_summary；感受按日期升序进输入', async () => {
    const db = baseDb();
    ensureTakeover(db, WEEK.start); // 已接管，否则会被 no_takeover 拦下
    seedPlan(db, [{ datestr: '2026-09-28', title: '上肢推', exercises: [{ catalog_id: 1, name: '杠铃卧推', sets: 4 }] }]);
    seedSession(db, '2026-09-28', [{ name: '杠铃卧推', catalogId: 1, sets: [{ weight: 60 }, { weight: 60 }] }]);
    saveDailyNote(db, '2026-09-29', '出差了', 1000);
    saveDailyNote(db, '2026-09-28', '状态一般', 1000);

    const seen: { v: WeeklyReviewInput | null } = { v: null };
    const out = await generateWeeklyReview(
      db,
      mockWeekGw({ verdict: '本周完成率 50%，偏松', adjustments: ['周五并入周四'], note_reply: '出差影响不大，回来补上就好' }, (i) => {
        seen.v = i;
      }),
      'http:test',
      { weekStart: WEEK.start, nowMs: ms(AFTER_WEEK) },
    );

    assert.equal(out.status, 'done');
    assert.equal(out.ai_summary?.verdict, '本周完成率 50%，偏松');
    assert.ok(seen.v);
    assert.deepEqual(seen.v.notes.map((n: { datestr: string }) => n.datestr), ['2026-09-28', '2026-09-29']);
    assert.equal(seen.v.cycleGoal, null);
    assert.equal((seen.v.weekSummary as { completion: number }).completion, 0.5);

    const v = buildWeekView(db, WEEK.start, ms(AFTER_WEEK));
    assert.equal(v.review!.status, 'done');
    assert.deepEqual(v.review!.ai_summary!.adjustments, ['周五并入周四']);
    assert.equal((v.review!.data_summary as { completion: number }).completion, 0.5);
  });

  it('AI 不可用 → draft + detail，数据部分照常可看，可重试覆盖为 done', async () => {
    const db = baseDb();
    ensureTakeover(db, WEEK.start);
    seedSession(db, '2026-09-28', [{ name: '杠铃卧推', catalogId: 1, sets: [{ weight: 60 }] }]);
    const draft = await generateWeeklyReview(db, null, 'none', { weekStart: WEEK.start, nowMs: ms(AFTER_WEEK) });
    assert.equal(draft.status, 'draft');
    assert.match(draft.detail!, /AI 未配置/);
    assert.equal(draft.ai_summary, null);

    const v1 = buildWeekView(db, WEEK.start, ms(AFTER_WEEK));
    assert.equal(v1.review!.status, 'draft');
    assert.ok(v1.review!.data_summary);
    assert.equal(v1.review!.ai_summary, null);

    const badGw = { ...mockWeekGw({ verdict: 'x', adjustments: ['y'], note_reply: '' }), summarizeWeek: async () => { throw new Error('429 限频'); } };
    const again = await generateWeeklyReview(db, badGw, 'test', { weekStart: WEEK.start, nowMs: ms(AFTER_WEEK) });
    assert.equal(again.status, 'draft');
    assert.match(again.detail!, /429 限频/);

    const ok = await generateWeeklyReview(db, mockWeekGw({ verdict: 'ok', adjustments: ['z'], note_reply: '' }), 'http:test', {
      weekStart: WEEK.start,
      nowMs: ms(AFTER_WEEK),
    });
    assert.equal(ok.status, 'done');
    const v2 = buildWeekView(db, WEEK.start, ms(AFTER_WEEK));
    assert.equal(v2.review!.status, 'done', 'ON CONFLICT 覆盖同一周，不产生第二行');
    const cnt = db.prepare('SELECT COUNT(*) AS c FROM weekly_review').get() as { c: number };
    assert.equal(Number(cnt.c), 1);
  });

  it('既无计划也无训练 → 400', async () => {
    const db = baseDb();
    ensureTakeover(db, WEEK.start); // 已接管 → 走到 no_content 这条
    await assert.rejects(
      () => generateWeeklyReview(db, mockWeekGw({ verdict: 'x', adjustments: ['y'], note_reply: '' }), 'test', { weekStart: WEEK.start, nowMs: ms(AFTER_WEEK) }),
      (e: unknown) => e instanceof WeeklyReviewError && e.status === 400,
    );
  });
});

// ---------------------------------------------------------------------------
// 接管起点（takeover）：历史周只进画像、不进复盘
// ---------------------------------------------------------------------------

describe('takeover（接管起点）与复盘门禁', () => {
  it('① 空库：getTakeover → null；周视图 lock = no_takeover；生成 → 400', async () => {
    const db = baseDb(); // 无 training_cycle、无 app_config.takeover
    assert.equal(getTakeover(db), null);

    const v = buildWeekView(db, WEEK.start, ms(AFTER_WEEK));
    assert.equal(v.takeover_start_week, null);
    assert.equal(v.lock?.code, 'no_takeover');
    assert.match(v.lock!.reason, /还没有把训练交给本软件规划/);

    await assert.rejects(
      () => generateWeeklyReview(db, mockWeekGw({ verdict: 'x', adjustments: ['y'], note_reply: '' }), 'test', { weekStart: WEEK.start, nowMs: ms(AFTER_WEEK) }),
      (e: unknown) => e instanceof WeeklyReviewError && e.status === 400 && /还没有把训练交给本软件规划/.test((e as Error).message),
    );
  });

  it('② 只有 training_cycle 行、无 app_config.takeover → derived，起点取该周期 first_week_start', () => {
    const db = baseDb();
    db.prepare(
      `INSERT INTO training_cycle (cycle_no, first_week_start, last_week_start, goal_text, status, created_at)
       VALUES (1, '2026-09-28', '2026-10-19', '着重练胸', 'active', '2026-09-01T00:00:00Z')`,
    ).run();

    const t = getTakeover(db);
    assert.equal(t?.source, 'derived');
    assert.equal(t?.start_week, '2026-09-28');
    assert.equal(t?.set_at, '', 'derived 不谎报写入时刻');

    // 周视图据此把「接管当周及之后」视为可复盘：接管当周已结束且无内容 → no_content（不是 no_takeover）
    const v = buildWeekView(db, WEEK.start, ms(AFTER_WEEK));
    assert.equal(v.takeover_start_week, '2026-09-28');
    assert.equal(v.lock?.code, 'no_content');
  });

  it('③ 接管起点之后的周才有资格：查询起点之前的周 → pre_takeover；生成 → 400', async () => {
    const db = baseDb();
    ensureTakeover(db, '2026-10-05'); // 接管从 10-05 那周开始
    // 仍有训练数据（历史周往往有数据），但也不该被当成可复盘
    seedSession(db, '2026-09-28', [{ name: '杠铃卧推', catalogId: 1, sets: [{ weight: 60 }] }]);

    const v = buildWeekView(db, WEEK.start, ms(AFTER_WEEK)); // 09-28 早于 10-05
    assert.equal(v.lock?.code, 'pre_takeover');
    assert.match(v.lock!.reason, /在你开始用本软件规划训练之前/);
    assert.match(v.lock!.reason, /已并入训练画像/);

    await assert.rejects(
      () => generateWeeklyReview(db, mockWeekGw({ verdict: 'x', adjustments: ['y'], note_reply: '' }), 'test', { weekStart: WEEK.start, nowMs: ms(AFTER_WEEK) }),
      (e: unknown) => e instanceof WeeklyReviewError && e.status === 400 && /已并入训练画像/.test((e as Error).message),
    );
  });

  it('④ 接管当周（已结束 + 有训练）→ lock = null，生成不被边界拦下（无 AI 配置也可落 draft）', async () => {
    const db = baseDb();
    ensureTakeover(db, WEEK.start);
    seedSession(db, '2026-09-28', [{ name: '杠铃卧推', catalogId: 1, sets: [{ weight: 60 }] }]);

    const v = buildWeekView(db, WEEK.start, ms(AFTER_WEEK));
    assert.equal(v.lock, null);
    assert.equal(v.takeover_start_week, WEEK.start);

    const out = await generateWeeklyReview(db, null, 'none', { weekStart: WEEK.start, nowMs: ms(AFTER_WEEK) });
    assert.equal(out.status, 'draft');
    assert.equal(out.week_start, WEEK.start);
  });

  it('⑤ openCycle → explicit 且等于 first_week_start；幂等；再开更晚周期也不后移', () => {
    const db = baseDb();
    const c1 = openCycle(db, { goal_text: '着重练胸', first_week_start: '2026-09-28' });

    const t1 = getTakeover(db);
    assert.equal(t1?.source, 'explicit');
    assert.equal(t1?.start_week, c1.firstWeekStart);
    assert.notEqual(t1?.set_at, '', 'explicit 必须带写入时刻');

    // 幂等：重复读结果不变
    assert.deepEqual(getTakeover(db), t1);

    // 单调：关掉第一个周期、再开更晚的第二个周期，接管起点仍停在第一个
    closeActiveCycle(db);
    openCycle(db, { goal_text: '着重练背', first_week_start: '2026-10-05' });
    assert.equal(getTakeover(db)?.start_week, '2026-09-28');
  });

  // 🔴 2026-10-05 界碑判据改版（用户拍板方案 A）：**只有开训练周期才算接管**。
  //
  //    旧行为：`min(周期最早周, 已排过计划的最早周)` —— 只要软件建过一个 plan，
  //    界碑就立起来了。实测踩坑：9/29 调试时建过一个 `rule_fallback` 的**测试计划**
  //    （从未成功导入训记、训记侧零数据），它把界碑钉成 2026-09-28，于是复盘页拿
  //    这份测试计划去跟用户真实训练记录对比，得出「完成率 200%」这种无意义结果。
  //
  //    用户原话：「我还没有使用导入啊……前面的这个计划不是只是为了测试吗？
  //    并没有真的导入到我的训记 APP 里」「真实开始使用之后才加入复盘」。
  //
  //    新行为：**排过计划 ≠ 接管**。只有 training_cycle（用户主动开周期）才立界碑。
  it('⑥ 只排过计划、从未开周期 → 仍是「尚未接管」，测试计划不得污染复盘', () => {
    const db = baseDb();
    // 模拟：调试期点过首页「生成计划」，软件排了 2026-09-28 那周，但从未导入训记、也没开周期
    seedPlanRow(db, WEEK.start, WEEK.end, 'partial');

    assert.equal(getTakeover(db), null, '排过计划不算接管');

    // 关键后果：那一周显示「尚未接管」整页说明，而不是拿测试计划去对比真实训练
    const v = buildWeekView(db, WEEK.start, ms(AFTER_WEEK));
    assert.equal(v.takeover_start_week, null);
    assert.equal(v.lock?.code, 'no_takeover');
    assert.match(v.lock!.reason, /还没有把训练交给本软件规划/);

    // 事后开周期也不受影响：界碑就取开周期时那个 first_week_start
    const c = openCycle(db, { goal_text: '着重练胸', first_week_start: '2026-10-05' });
    const t = getTakeover(db);
    assert.equal(t?.source, 'explicit');
    assert.equal(t?.start_week, c.firstWeekStart);
    assert.equal(t?.start_week, '2026-10-05', '界碑 = 开周期那一周，不被更早的测试计划拉回去');

    // 09-28 那周因此正确地变成「接管前」
    assert.equal(buildWeekView(db, WEEK.start, ms(AFTER_WEEK)).lock?.code, 'pre_takeover');
  });

  it('⑦ earliestManagedWeek 仍能查出「排过计划的最早周」，但不再影响界碑', () => {
    const db = baseDb();
    seedPlanRow(db, '2026-09-21', '2026-09-27', 'cancelled');
    seedPlanRow(db, WEEK.start, WEEK.end, 'draft');
    assert.equal(earliestManagedWeek(db), WEEK.start, '事实查询：忽略 cancelled');
    assert.equal(getTakeover(db), null, '但界碑不认它 —— 未开周期 = 尚未接管');

    // 全是 cancelled → 事实查询也返回 null
    const db2 = baseDb();
    seedPlanRow(db2, '2026-09-21', '2026-09-27', 'cancelled');
    assert.equal(earliestManagedWeek(db2), null);
    assert.equal(getTakeover(db2), null);
  });
});

// ---------------------------------------------------------------------------
// recentWeekStarts
// ---------------------------------------------------------------------------

describe('recentWeekStarts', () => {
  it('周一起点：今天是周四 → 本周起点是周一，往前推 N 周', () => {
    const db = baseDb(); // week_start_dow = 1
    const weeks = recentWeekStarts(db, '2026-10-01', 3); // 2026-10-01 是周四
    assert.deepEqual(weeks, ['2026-09-28', '2026-09-21', '2026-09-14']);
  });

  it('周日起点：week_start_dow=0 时本周起点是周日', () => {
    const db = baseDb();
    db.prepare(`UPDATE user_goal SET is_active = 0`).run();
    db.prepare(
      `INSERT INTO user_goal (goal_type, sessions_per_week, min_duration_min, max_duration_min, week_start_dow, preferred_dows, is_active, effective_from, created_at)
       VALUES ('fatloss_keep_strength', 3, 60, 90, 0, '[0,2,4]', 1, '2026-02-01', '2026-02-01T00:00:00Z')`,
    ).run();
    const weeks = recentWeekStarts(db, '2026-10-01', 2); // 周四 → 本周日 = 09-27
    assert.deepEqual(weeks, ['2026-09-27', '2026-09-20']);
  });
});

// ---------------------------------------------------------------------------
// 闭环：感受进摘要层
// ---------------------------------------------------------------------------

describe('摘要层闭环：`special_note` 的来源', () => {
  const emptyReport = {
    schema_version: '1.0',
    constraints: {
      goal: {
        goal_type: 'fatloss_keep_strength',
        sessions_per_week: 3,
        min_duration_min: 60,
        max_duration_min: 90,
        week_start_dow: 1,
        preferred_dows: [1, 3, 5],
      },
      hard_rules: [],
      soft_rules: [],
    },
    candidate_pool: [
      { catalog_id: 1, name: '杠铃卧推', primary_muscles: ['chest'], last_weight: 60, used_recently: true, mapping_confidence: 'high' },
    ],
    writing_rules: { rules: [] },
    findings: [],
  } as unknown as AnalysisReport;

  /** 与 buildPlanDigest 同一次的输入（constraints 由报告快照提供，测试里手动取出）。 */
  const CONSTRAINTS = emptyReport.constraints as unknown as Parameters<typeof buildPlanDigest>[1]['constraints'];

  const digest = (db: Db, weekStart: string) =>
    buildPlanDigest(db, {
      report: emptyReport,
      constraints: CONSTRAINTS,
      weekStart,
      nowMs: new Date('2026-10-01T10:00:00Z').getTime(),
    });

  /**
   * 🔴 2026-09-30 用户定案后的**语义反转**。
   *
   * 以前这条用例断言的是「最近两周的日感受会进 week.special_note」——那是**错的**。
   * 用户原话：「（复盘页的感受）它就是用来复盘的，它只关乎下一周的计划，
   * 跟这一周的计划是没有关系的」；「本周特殊情况是需要做计划的时候需要考虑的……
   * 比如说我在经期，他给我排计划的时候就应该给我减量」（那是首页那个框要干的事）。
   *
   * 所以现在：日感受只喂**周复盘 AI**（→ 复盘建议 → 绕一圈才回到排计划），
   * 排计划输入只认 `week_note`。这条用例就是盯着这个分工别回退。
   */
  it('复盘页的日感受（daily_note）**不**进 week.special_note', () => {
    const db = baseDb();
    const before = digest(db, '2026-09-28');
    assert.equal(before.week.special_note, null);

    saveDailyNote(db, '2026-09-30', '经期第一天，量力而行', 1000);
    saveDailyNote(db, '2026-10-01', '睡得不好', 1000);

    const after = digest(db, '2026-09-28');
    assert.equal(after.week.special_note, null, '日感受是复盘用的，不许再冒充「特殊情况」进排计划输入');
    assert.deepEqual(after.week, before.week, '写了日感受不该动到 week 切片的任何一个字段');
  });

  it('排计划输入只认 week_note，而且是**计划周**那一条', () => {
    const db = baseDb();
    saveWeekNote(db, '2026-09-28', '经期，量力而行', 1000);

    assert.equal(digest(db, '2026-09-28').week.special_note, '经期，量力而行');
    assert.equal(digest(db, '2026-10-05').week.special_note, null, '别的计划周读不到它');
  });

  it('两边同时有内容时，special_note 取 week_note 而不是日感受', () => {
    const db = baseDb();
    saveDailyNote(db, '2026-09-30', '今天练完肩有点紧', 1000);
    saveWeekNote(db, '2026-09-28', '经期，整体减量', 1000);
    assert.equal(digest(db, '2026-09-28').week.special_note, '经期，整体减量');
  });
});
