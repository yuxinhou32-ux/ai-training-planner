/**
 * 计划路由层测试（V7 起）。
 *
 * 存在的理由：`handlePlanRoutes` 里的路径匹配 / body 解析 / PlanServiceError→HttpError
 * 翻译是**独立于 service 的一层**，而且历史上真出过「service 写好了、路由分支没接」
 * 这种只在这一层才暴露的问题。这里用假的 req/res 直接打路由器，不启服务、不连网络。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { handlePlanRoutes } from '../server/api/routes/plan.js';
import { makeTempDb } from './fixtures.js';
import type { Db } from '../server/db/index.js';

/** 最小 req：readBody 只用 data/end/error 三个事件。 */
function fakeReq(method: string, body?: unknown): IncomingMessage {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body), 'utf8')];
  const stream = Readable.from(chunks) as unknown as IncomingMessage;
  stream.method = method;
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

const WEEK = { start: '2026-01-05', end: '2026-01-11' };

/** 直接插一份两天草稿：路由层只关心 plan/plan_day，不需要目录与报告。 */
function seedDraftPlan(db: Db): { planId: number; day1Id: number; day2Id: number } {
  const now = '2026-01-01T00:00:00Z';
  db.prepare(
    `INSERT INTO plan (id, week_start, week_end, version_no, status, source, ai_attempts, created_at, updated_at)
     VALUES (1, ?, ?, 1, 'draft', 'ai', 1, ?, ?)`,
  ).run(WEEK.start, WEEK.end, now, now);
  const ins = db.prepare(
    `INSERT INTO plan_day (plan_id, datestr, dow, ord, day_type, title, est_duration_min, lock_state)
     VALUES (1, ?, ?, ?, '上肢推', ?, 70, 'planned')`,
  );
  const d1 = Number(ins.run(WEEK.start, 1, 1, '上肢推').lastInsertRowid);
  const d2 = Number(ins.run('2026-01-07', 3, 2, '下肢力量').lastInsertRowid);
  return { planId: 1, day1Id: d1, day2Id: d2 };
}

function planDb(): Db {
  const { db } = makeTempDb();
  seedDraftPlan(db);
  return db;
}

describe('计划路由（V7 挪训练日）', () => {
  it('POST /api/plans/:id/days/:dayId/move → 200 + 新详情（路由确实接上了）', async () => {
    const db = planDb();
    const handler = handlePlanRoutes(db, null);
    const { res, out } = fakeRes();
    const handled = await handler(fakeReq('POST', { datestr: '2026-01-06' }), res, `/api/plans/1/days/${seedDraftPlanDayId(db)}/move`);
    assert.equal(handled, true);
    assert.equal(out.status, 200);
    const detail = out.body as { days: Array<{ datestr: string; title: string }> };
    assert.deepEqual(
      detail.days.map((d) => d.datestr),
      ['2026-01-06', '2026-01-07'],
    );
  });

  it('body 缺 datestr / 格式错 → 400，由 parseDatestr 兜住（不落到 service）', async () => {
    const db = planDb();
    const handler = handlePlanRoutes(db, null);
    for (const body of [{}, { datestr: '2026/01/06' }, { datestr: 20260106 }]) {
      const { res, out } = fakeRes();
      await assert.rejects(
        () => handler(fakeReq('POST', body), res, '/api/plans/1/days/1/move'),
        (e: unknown) => (e as { status?: number }).status === 400,
      );
      assert.equal(out.status, null); // 抛出去由 app 统一转 JSON，这里没写响应
    }
  });

  it('空 body → 400', async () => {
    const db = planDb();
    const handler = handlePlanRoutes(db, null);
    const { res } = fakeRes();
    await assert.rejects(
      () => handler(fakeReq('POST'), res, '/api/plans/1/days/1/move'),
      (e: unknown) => (e as { status?: number }).status === 400,
    );
  });

  it('PlanServiceError 被翻成同名状态码：越界 400 / 非 draft 409', async () => {
    const db = planDb();
    const handler = handlePlanRoutes(db, null);

    await assert.rejects(
      () => handler(fakeReq('POST', { datestr: '2026-02-01' }), fakeRes().res, '/api/plans/1/days/1/move'),
      (e: unknown) => (e as { status?: number }).status === 400,
    );

    db.prepare(`UPDATE plan SET status = 'approved' WHERE id = 1`).run();
    await assert.rejects(
      () => handler(fakeReq('POST', { datestr: '2026-01-06' }), fakeRes().res, '/api/plans/1/days/1/move'),
      (e: unknown) => (e as { status?: number }).status === 409,
    );
  });

  it('同路径的 GET → 405（不是掉到末尾的 404「未知路由」）', async () => {
    const db = planDb();
    const handler = handlePlanRoutes(db, null);
    await assert.rejects(
      () => handler(fakeReq('GET'), fakeRes().res, '/api/plans/1/days/1/move'),
      (e: unknown) => (e as { status?: number }).status === 405,
    );
  });

  it('未知计划路由仍返回 404；非 /api/plans 前缀返回 false（交下一个 handler）', async () => {
    const db = planDb();
    const handler = handlePlanRoutes(db, null);
    await assert.rejects(
      () => handler(fakeReq('GET'), fakeRes().res, '/api/plans/1/days'),
      (e: unknown) => (e as { status?: number }).status === 404,
    );
    assert.equal(await handler(fakeReq('GET'), fakeRes().res, '/api/goal'), false);
  });
});

describe('计划路由：/api/plans/current 取「计划周那份」而不是「最新一份」', () => {
  /**
   * 夹具里的计划是 2026-01-05 那周，而「计划周」跟着 todayLocal 走（永远是下一周）。
   * 两者不可能相等 → 不传 week_start 时必须 404，让前端显示空态。
   *
   * 🔴 这就是「隔一周没生成」的场景：旧周有计划、下周没有。
   *    旧实现按「最新一份」取，会把 2026-01-05 那份端上来，首页就写着
   *    「下周计划 · 2026-01-05 ~ 2026-01-11」—— 而「重新生成」其实按下一周排。
   */
  it('不传 week_start → 取下一周那份；只有旧周有计划 → 404', async () => {
    const db = planDb();
    const handler = handlePlanRoutes(db, null);
    await assert.rejects(
      () => handler(fakeReq('GET'), fakeRes().res, '/api/plans/current'),
      (e: unknown) => (e as { status?: number }).status === 404,
    );
  });

  it('带 ?week_start= → 命中那一周并返回详情', async () => {
    const db = planDb();
    const handler = handlePlanRoutes(db, null);
    const { res, out } = fakeRes();
    const req = fakeReq('GET');
    (req as { url?: string }).url = `/api/plans/current?week_start=${WEEK.start}`;
    assert.equal(await handler(req, res, '/api/plans/current'), true);
    assert.equal(out.status, 200);
    assert.equal((out.body as { plan: { week_start: string } }).plan.week_start, WEEK.start);
  });

  it('week_start 格式非法 → 400（不静默退回计划周）', async () => {
    const db = planDb();
    const handler = handlePlanRoutes(db, null);
    const req = fakeReq('GET');
    (req as { url?: string }).url = '/api/plans/current?week_start=2026/01/05';
    await assert.rejects(
      () => handler(req, fakeRes().res, '/api/plans/current'),
      (e: unknown) => (e as { status?: number }).status === 400,
    );
  });

  it('404 文案里保留「还没有计划」子串 —— 前端空态靠它区分「没计划」与「加载失败」', async () => {
    const db = planDb();
    const handler = handlePlanRoutes(db, null);
    await assert.rejects(
      () => handler(fakeReq('GET'), fakeRes().res, '/api/plans/current'),
      (e: unknown) => /还没有计划/.test((e as Error).message),
    );
  });
});

/** 取该计划第一个训练日的 id（seed 顺序固定，但别硬编码）。 */
function seedDraftPlanDayId(db: Db): number {
  const row = db.prepare(`SELECT id FROM plan_day WHERE plan_id = 1 ORDER BY ord LIMIT 1`).get() as { id: number };
  return Number(row.id);
}

describe('计划路由：/api/plans/generate 的 mode（周期模板复用）', () => {
  /**
   * mode 的解析必须在「有没有 AI 依赖」「有没有分析报告」之前 —— 参数不合法就是 400。
   * 否则前端把 mode 拼错时会拿到 503 / 400（报告缺失）这种误导性的错误。
   */
  it("mode 只接受 'auto' / 'full'：非法值 400", async () => {
    const db = planDb();
    const handler = handlePlanRoutes(db, null);
    for (const bad of ['bogus', 1, true]) {
      await assert.rejects(
        () => handler(fakeReq('POST', { mode: bad }), fakeRes().res, '/api/plans/generate'),
        (e: unknown) => (e as { status?: number }).status === 400,
        `mode=${String(bad)} 应为 400`,
      );
    }
  });

  it("mode='full' / 'auto' / 缺省都是合法输入 → 走到 AI 依赖检查（503）", async () => {
    const db = planDb();
    const handler = handlePlanRoutes(db, null);
    for (const body of [{ mode: 'full' }, { mode: 'auto' }, {}, { week_start: WEEK.start }]) {
      await assert.rejects(
        () => handler(fakeReq('POST', body), fakeRes().res, '/api/plans/generate'),
        (e: unknown) => (e as { status?: number }).status === 503,
        `${JSON.stringify(body)} 应通过解析、因缺 AI 依赖报 503`,
      );
    }
  });
});
