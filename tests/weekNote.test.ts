/**
 * 计划周特殊情况（`week_note`）测试 —— 2026-09-30 用户定案。
 *
 * 用户要求（原话）：
 *   「本周特殊情况不应该是复盘里面感受里面的……本周特殊情况是需要做计划的时候需要考虑的。
 *     比如说我在经期，他给我排计划的时候就应该给我减量。」
 *   「要有一个小的文本框可以给我输入，它的优先级应该是最高的……先考虑我在经期内，
 *     然后再考虑我这周练胸，这是一个优先级的问题。」
 *   「（复盘页的感受）它就是用来复盘的，它只关乎下一周的计划，跟这一周的计划是没有关系的。」
 *
 * 所以本文件守的是一条**分工红线**：
 *   `week_note`（本模块）→ 进排计划输入的 `week.special_note`；
 *   `daily_note`（复盘页感受）→ **不进**排计划输入（只喂周复盘 AI）。
 *
 * ⚠️ 这条红线以前是反的：`week.special_note` 曾经取自「最近 14 天的 daily_note」。
 *    所以下面专门有用例盯着「写了日感受，special_note 一个字节都不动」。
 *
 * 零真实网络：只调本地服务与摘要层。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it, test } from 'node:test';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  WEEK_NOTE_MAX_CHARS,
  WeekNoteError,
  loadWeekNote,
  saveWeekNote,
  weekNoteForDigest,
} from '../server/week/weekNoteService.js';
import { handleWeekNoteRoutes } from '../server/api/routes/weekNote.js';
import { HttpError } from '../server/api/errors.js';
import { buildPlanDigest } from '../server/ai/digest.js';
import { saveDailyNote } from '../server/review/dailyNote.js';
import type { AnalysisReport, GoalConstraints } from '../server/analysis/reportSchema.js';
import { makeTempDb } from './fixtures.js';
import { ANALYSIS_WINDOW_WEEKS } from '../server/analysis/window.js';
import type { Db } from '../server/db/index.js';
import { shiftDays } from '../server/util/dates.js';

// 「现在」固定 = 2026-10-01 本地 10:00（时钟锚点纪律：不许靠跑测试那天恰好是几号）
const NOW_MS = new Date('2026-10-01T10:00:00').getTime();
const TODAY = '2026-10-01';
const NOW_ISO = new Date(NOW_MS).toISOString();
const WEEK_START = '2026-10-05'; // 计划周（周一）
const PREV_WEEK_START = '2026-09-28';

function freshDb(): Db {
  return makeTempDb().db;
}

function expect400(fn: () => unknown, keyword: string): void {
  try {
    fn();
  } catch (e) {
    assert.ok(e instanceof WeekNoteError, `应抛 WeekNoteError，实际 ${String(e)}`);
    assert.equal((e as WeekNoteError).status, 400);
    assert.ok(
      (e as Error).message.includes(keyword),
      `错误信息应包含「${keyword}」，实际「${(e as Error).message}」`,
    );
    return;
  }
  assert.fail('应当抛错但没有');
}

// ---------------------------------------------------------------------------
// 1. 存储
// ---------------------------------------------------------------------------

describe('计划周特殊情况：存储', () => {
  it('空库 → null（不是空串）；写完能读回', () => {
    const db = freshDb();
    assert.equal(loadWeekNote(db, WEEK_START), null);
    saveWeekNote(db, WEEK_START, '周三开始来经期，整体减量', NOW_MS);
    assert.equal(loadWeekNote(db, WEEK_START), '周三开始来经期，整体减量');
  });

  it('按周分开：改计划周不影响上一周（历史那条要留着）', () => {
    const db = freshDb();
    saveWeekNote(db, PREV_WEEK_START, '上周出差', NOW_MS);
    saveWeekNote(db, WEEK_START, '这周经期', NOW_MS);
    assert.equal(loadWeekNote(db, PREV_WEEK_START), '上周出差');
    assert.equal(loadWeekNote(db, WEEK_START), '这周经期');
  });

  it('同一周再保存 = 覆盖（一行，不新增）', () => {
    const db = freshDb();
    saveWeekNote(db, WEEK_START, 'A', NOW_MS);
    saveWeekNote(db, WEEK_START, 'B', NOW_MS);
    const n = db.prepare('SELECT COUNT(*) AS n FROM week_note').get() as unknown as { n: number };
    assert.equal(Number(n.n), 1);
    assert.equal(loadWeekNote(db, WEEK_START), 'B');
  });

  it('去空白后为空 → 删行（「空串」与「没写过」展示上必须一样）', () => {
    const db = freshDb();
    saveWeekNote(db, WEEK_START, '经期', NOW_MS);
    assert.deepEqual(saveWeekNote(db, WEEK_START, '   \n  ', NOW_MS), { week_start: WEEK_START, text: null });
    assert.equal(loadWeekNote(db, WEEK_START), null);
    // 再清一次幂等
    assert.equal(saveWeekNote(db, WEEK_START, '', NOW_MS).text, null);
  });

  it('两端去空白后存；week_start 非法 / 超长 → 400', () => {
    const db = freshDb();
    assert.equal(saveWeekNote(db, WEEK_START, '  经期  ', NOW_MS).text, '经期');
    expect400(() => saveWeekNote(db, '2026-10-5', 'x', NOW_MS), 'week_start');
    expect400(() => saveWeekNote(db, WEEK_START, 'x'.repeat(WEEK_NOTE_MAX_CHARS + 1), NOW_MS), '太长');
    // 边界值放行
    assert.equal(saveWeekNote(db, WEEK_START, 'x'.repeat(WEEK_NOTE_MAX_CHARS), NOW_MS).text?.length, WEEK_NOTE_MAX_CHARS);
  });

  it('给摘要层的压缩：换行折成空格；空串 → null；超长兜底截断', () => {
    assert.equal(weekNoteForDigest(null), null);
    assert.equal(weekNoteForDigest('   '), null);
    assert.equal(weekNoteForDigest('经期\n第 2 天'), '经期 第 2 天');
    assert.equal(weekNoteForDigest('x'.repeat(900))?.length, WEEK_NOTE_MAX_CHARS + 1, '截断后会补一个省略号');
  });
});

// ---------------------------------------------------------------------------
// 2. 🔴 分工红线：排计划读它，复盘读 daily_note，两者不串
// ---------------------------------------------------------------------------

const GOAL: GoalConstraints = {
  goal_type: '减脂保肌',
  sessions_per_week: 3,
  min_duration_min: 60,
  max_duration_min: 90,
  week_start_dow: 1,
  preferred_dows: [1, 3, 5],
};

/** 最小报告：本组用例不关心统计，只关心 `week.special_note` 的来源。 */
function miniReport(): AnalysisReport {
  return {
    schema_version: '1.0',
    generated_at: NOW_ISO,
    window: {
      trend_start: shiftDays(WEEK_START, -84),
      trend_end: shiftDays(WEEK_START, -1),
      recent_start: shiftDays(WEEK_START, -28),
      recent_end: shiftDays(WEEK_START, -1),
      weeks: ANALYSIS_WINDOW_WEEKS,
      last_session: null,
    },
    data_quality: {
      duration_coverage: 1,
      unmapped_set_ratio: 0,
      total_sessions: 0,
      synced_days: 0,
      warmup_source: 'server_set_type',
      warnings: [],
    },
    subjective_state: [],
    basic_stats: {
      total_sessions: 0,
      sessions_per_week: 0,
      avg_duration_min: null,
      duration_median_min: null,
      strength_sessions: 0,
      cardio_sessions: 0,
      total_effective_sets: 0,
      preferred_dows: [],
    },
    muscle_volume: {},
    movement_trends: [],
    muscle_trends: [],
    structure: { push_sets: 0, pull_sets: 0, push_pull_ratio: null, upper_lower_ratio: null, large_muscle_freq: {}, top_repeated_movements: [] },
    findings: [],
    constraints: { goal: null, hard_rules: [], soft_rules: [] },
    candidate_pool: [],
    writing_rules: {
      max_trains_per_batch: 4,
      max_movements_per_train: 15,
      max_sets_per_movement: 20,
      same_day_per_batch: true,
      movement_name_must_come_from: 'candidate_pool',
      name_language: 'zh-CN 标准名',
    },
  } as unknown as AnalysisReport;
}

function digestOf(db: Db) {
  return buildPlanDigest(db, {
    report: miniReport(),
    constraints: { goal: GOAL, hard_rules: [] },
    weekStart: WEEK_START,
    nowMs: NOW_MS,
  });
}

describe('摘要层：special_note 来自计划周特殊情况', () => {
  it('没填 → null', () => {
    assert.equal(digestOf(freshDb()).week.special_note, null);
  });

  it('填了 → 原话进 AI 输入；换行被折平', () => {
    const db = freshDb();
    saveWeekNote(db, WEEK_START, '周三开始来经期，整体减量\n不要练腿', NOW_MS);
    assert.equal(digestOf(db).week.special_note, '周三开始来经期，整体减量 不要练腿');
  });

  it('只读**计划周**那一条，不读别的周', () => {
    const db = freshDb();
    saveWeekNote(db, PREV_WEEK_START, '上一周的事', NOW_MS);
    assert.equal(digestOf(db).week.special_note, null, '上一周的特殊情况不该被带进这一周的计划');
    saveWeekNote(db, WEEK_START, '这一周的事', NOW_MS);
    assert.equal(digestOf(db).week.special_note, '这一周的事');
  });

  it('🔴 复盘页的日感受（daily_note）**不再**影响排计划输入', () => {
    const db = freshDb();
    const before = digestOf(db);
    assert.equal(before.week.special_note, null);

    saveDailyNote(db, shiftDays(TODAY, -1), '今天练完肩有点紧，卧推最后一组没做满', NOW_MS);
    saveDailyNote(db, TODAY, '睡得不好', NOW_MS);

    const after = digestOf(db);
    assert.equal(
      after.week.special_note,
      null,
      '日感受是复盘用的，不许再冒充「特殊情况」进排计划输入（这是 V8 时期的方向错误）',
    );
    // 整个 week 切片都不该因为写了日感受而变
    assert.deepEqual(after.week, before.week, '日感受不能影响任何本周切片字段');
    assert.deepEqual(after.constraints, before.constraints);
    assert.deepEqual(after.candidate_pool, before.candidate_pool);
  });

  it('🔴 特殊情况只改 `week.special_note` —— 硬约束 / 候选池 / 画像一个字节都不动', () => {
    const db = freshDb();
    const before = digestOf(db);

    saveWeekNote(db, WEEK_START, '经期，整体减量', NOW_MS);
    const after = digestOf(db);

    assert.notEqual(after.week.special_note, before.week.special_note, '先确认它确实生效了');
    assert.equal(after.week.special_note, '经期，整体减量');

    // 减容是**交给 AI 的指令**，不是系统在本地偷偷改数字 ——
    // 系统若在这里就把候选池/组数改掉，AI 与界面看到的就不是同一件事了。
    assert.deepEqual(after.constraints, before.constraints, '特殊情况不得改动硬约束');
    assert.deepEqual(after.candidate_pool, before.candidate_pool, '特殊情况不得过滤候选池');
    assert.deepEqual(after.findings, before.findings, '特殊情况不得凭空造出结论');
    assert.deepEqual(after.profile, before.profile, '特殊情况不得影响长期画像');
  });
});

// ---------------------------------------------------------------------------
// 3. 路由层
// ---------------------------------------------------------------------------

/** 最小 req：readBody 只用 data/end/error 三个事件。 */
function fakeReq(method: string, body?: unknown, url = '/'): IncomingMessage {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body), 'utf8')];
  const stream = Readable.from(chunks) as unknown as IncomingMessage;
  stream.method = method;
  stream.url = url;
  return stream;
}

interface Captured {
  status: number | null;
  body: unknown;
}

/** 最小 res：sendJson 只用 writeHead / end。 */
function fakeRes(): { res: ServerResponse; out: Captured } {
  const out: Captured = { status: null, body: null };
  const res = {
    writeHead(status: number) {
      out.status = status;
      return res;
    },
    end(buf?: Buffer | string) {
      out.body = buf === undefined ? null : JSON.parse(buf.toString('utf8'));
      return res;
    },
  } as unknown as ServerResponse;
  return { res, out };
}

async function call(db: Db, method: string, url: string, body?: unknown): Promise<Captured> {
  const handler = handleWeekNoteRoutes(db);
  const { res, out } = fakeRes();
  const pathname = url.split('?')[0] ?? url;
  const handled = await handler(fakeReq(method, body, url), res, pathname);
  assert.equal(handled, true, `路由应当接住 ${method} ${url}`);
  return out;
}

async function callFail(db: Db, method: string, url: string, body?: unknown): Promise<HttpError> {
  const handler = handleWeekNoteRoutes(db);
  const { res } = fakeRes();
  try {
    await handler(fakeReq(method, body, url), res, url.split('?')[0] ?? url);
  } catch (e) {
    assert.ok(e instanceof HttpError, `应抛 HttpError，实际 ${String(e)}`);
    return e as HttpError;
  }
  assert.fail(`${method} ${url} 应当抛错`);
}

describe('计划周特殊情况路由', () => {
  it('GET 不带参数 → 服务端给的是**计划周**（与生成计划同源）', async () => {
    const out = await call(freshDb(), 'GET', '/api/week-note');
    assert.equal(out.status, 200);
    const b = out.body as { week_start: string; text: string | null };
    assert.equal(b.text, null);
    assert.match(b.week_start, /^\d{4}-\d{2}-\d{2}$/, '必须落在一个真实的周起点上');
    // 关键：不能是「今天」，否则用户写的与 AI 读的会差一周
    assert.notEqual(b.week_start, TODAY);
  });

  it('PUT 后 GET 读到同一份；显式指定 week_start 也认', async () => {
    const db = freshDb();
    const a = await call(db, 'PUT', '/api/week-note', { week_start: WEEK_START, text: '经期' });
    assert.equal(a.status, 200);
    assert.deepEqual(a.body, { week_start: WEEK_START, text: '经期' });

    const b = await call(db, 'GET', `/api/week-note?week_start=${WEEK_START}`);
    assert.deepEqual(b.body, a.body);
  });

  it('PUT 空文本 = 清空', async () => {
    const db = freshDb();
    await call(db, 'PUT', '/api/week-note', { week_start: WEEK_START, text: '经期' });
    const out = await call(db, 'PUT', '/api/week-note', { week_start: WEEK_START, text: '   ' });
    assert.deepEqual(out.body, { week_start: WEEK_START, text: null });
  });

  it('非法 week_start → 400；非 JSON → 400；方法不对 → 405', async () => {
    const db = freshDb();
    assert.equal((await callFail(db, 'PUT', '/api/week-note', { week_start: '2026-10-5', text: 'x' })).status, 400);
    assert.equal((await callFail(db, 'PUT', `/api/week-note?week_start=oops`, {})).status, 400);
    assert.equal((await callFail(db, 'DELETE', '/api/week-note')).status, 405);
  });

  it('不相关的路径必须放手给下一个路由（否则会吞掉后面的 API）', async () => {
    const handler = handleWeekNoteRoutes(freshDb());
    const { res } = fakeRes();
    assert.equal(await handler(fakeReq('GET', undefined, '/api/body'), res, '/api/body'), false);
  });
});

// ---------------------------------------------------------------------------
// 4. schema
// ---------------------------------------------------------------------------

test('迁移 v7：week_note 建表 + 幂等', () => {
  const { db } = makeTempDb();
  const cols = db.prepare(`SELECT name FROM pragma_table_info('week_note')`).all() as unknown as Array<{ name: string }>;
  assert.deepEqual(
    cols.map((c) => c.name).sort(),
    ['created_at', 'text', 'updated_at', 'week_start'],
  );
  const v = db.prepare('SELECT MAX(version) AS v FROM schema_migration').get() as unknown as { v: number };
  assert.ok(
    Number(v.v) >= 10,
    `当前 schema 至少到 v10（v9 = analysis_report 重建；v10 = job_run.job_type 放行 report_prune），实际 v${v.v}`,
  );
});

// ---------------------------------------------------------------------------
// 5. prompt 断言：优先级链条写进 prompt 了没有
// ---------------------------------------------------------------------------

describe('prompt：特殊情况优先于周期目标', () => {
  const md = readFileSync(path.join(process.cwd(), 'server', 'ai', 'prompts', 'planGenerator.md'), 'utf8');

  it('prompt 里把「特殊情况高于周期目标」写成硬性优先级', () => {
    assert.ok(md.includes('week.special_note'), 'prompt 必须提到 special_note');
    assert.ok(/计划周特殊情况/.test(md), '要用统一的说法「计划周特殊情况」');
    assert.ok(/高于周期目标|先按特殊情况处理/.test(md), '要写清它优先于周期目标');
  });

  it('prompt 里给了减容手段（不是只说「减量」两个字）', () => {
    assert.ok(/组数打到平时的/.test(md), '容量手段');
    assert.ok(/不追加重/.test(md), '强度手段');
  });

  it('旧伤仍然明令「不得据此禁用 / 替换 / 减少动作」', () => {
    assert.ok(/不得据此禁用、替换或减少任何动作/.test(md));
  });
});
