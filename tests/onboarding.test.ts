/**
 * 首次使用引导（onboarding）测试 —— 2026-10-06 新增。
 *
 * 守三件事：
 *  ① `/api/onboarding` 的完成位读写契约（GET/PUT）；
 *  ② 🔴 **拒绝 `done = false`** —— 完成位一旦置位不可回退，否则用户会「每开一次都弹」；
 *  ③ **老用户豁免迁移**：升级前已有生效 goal 的库要补种 true（不弹），
 *     无 goal 的新库不补种（照常弹）。
 *
 * 契约测试直接调用**真实路由** `handleOnboardingRoutes`，用最小 fake req/res ——
 * readBody 只依赖 'data'/'end'/'error' 三个事件，sendJson 只依赖 writeHead/end。
 * 全程零真实网络、零真实 HTTP 监听。
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { describe, it } from 'node:test';
import { handleOnboardingRoutes } from '../server/api/routes/onboarding.js';
import {
  ONBOARDING_KEY,
  isOnboardingDone,
  seedOnboardingForExistingUsers,
} from '../server/onboarding/onboardingService.js';
import { runStartupTasks } from '../server/jobs/startup.js';
import { makeTempDb } from './fixtures.js';
import type { Db } from '../server/db/index.js';

function emptyDb(): Db {
  return makeTempDb().db;
}

/** 插一条 user_goal（历史表：写入即新增行 + 旧行 is_active=0，这里直接造最终态）。 */
function addGoal(db: Db, active: 0 | 1 = 1): void {
  db.prepare(
    `INSERT INTO user_goal (goal_type, sessions_per_week, min_duration_min, max_duration_min, week_start_dow, preferred_dows, is_active, effective_from, created_at)
     VALUES ('减脂保肌', 2, 60, 90, 1, '[1,3]', ?, '2026-01-01', '2026-01-01T00:00:00Z')`,
  ).run(active);
}

function appConfigRow(db: Db): unknown {
  return db.prepare(`SELECT value_json FROM app_config WHERE key = ?`).get(ONBOARDING_KEY);
}

/** 最小 IncomingMessage：只需 'data'/'end' 事件。 */
function fakeReq(method: string, body = ''): IncomingMessage {
  const req = new EventEmitter() as unknown as IncomingMessage & EventEmitter;
  (req as unknown as { method: string }).method = method;
  setImmediate(() => {
    if (body !== '') req.emit('data', Buffer.from(body, 'utf8'));
    req.emit('end');
  });
  return req as unknown as IncomingMessage;
}

/** 最小 ServerResponse：记录 status 与 body（sendJson 只用 writeHead/end）。 */
function fakeRes(): { res: ServerResponse; out: { status: number; body: string } } {
  const out = { status: 0, body: '' };
  const res = {
    writeHead(status: number): void {
      out.status = status;
    },
    end(buf?: Buffer | string): void {
      out.body = buf === undefined ? '' : buf.toString();
    },
  } as unknown as ServerResponse;
  return { res, out };
}

/** 调一次真实路由，返回 { handled, status, json }。 */
async function callRoute(
  db: Db,
  method: string,
  body = '',
): Promise<{ handled: boolean; status: number; json: unknown }> {
  const handler = handleOnboardingRoutes(db);
  const { res, out } = fakeRes();
  const handled = await handler(fakeReq(method, body), res, '/api/onboarding');
  return { handled, status: out.status, json: out.body === '' ? null : (JSON.parse(out.body) as unknown) };
}

/** 期望路由抛错（HttpError）。 */
async function callRouteThrow(db: Db, method: string, body = ''): Promise<Error & { status?: number }> {
  try {
    await callRoute(db, method, body);
  } catch (e) {
    return e as Error & { status?: number };
  }
  assert.fail('应当抛错但没有');
}

describe('onboarding：GET/PUT 完成位读写', () => {
  it('新库 GET → { done: false }；PUT { done: true } → { done: true }；再 GET → { done: true }', async () => {
    const db = emptyDb();

    const first = await callRoute(db, 'GET');
    assert.equal(first.handled, true, '固定路径应被本路由接住');
    assert.equal(first.status, 200);
    assert.deepEqual(first.json, { done: false });

    const saved = await callRoute(db, 'PUT', JSON.stringify({ done: true }));
    assert.equal(saved.status, 200);
    assert.deepEqual(saved.json, { done: true });

    const after = await callRoute(db, 'GET');
    assert.deepEqual(after.json, { done: true });

    // 落库位置正确：app_config 里键存在且值为 true
    assert.equal(isOnboardingDone(db), true);
    const row = appConfigRow(db) as { value_json: string } | undefined;
    assert.ok(row !== undefined, `${ONBOARDING_KEY} 应写入 app_config`);
    assert.equal(row.value_json, 'true');
  });

  it('非 /api/onboarding 路径不接管（返回 false）', async () => {
    const db = emptyDb();
    const handler = handleOnboardingRoutes(db);
    const { res } = fakeRes();
    assert.equal(await handler(fakeReq('GET'), res, '/api/goal'), false);
  });
});

describe('onboarding：拒绝把已完成状态回退', () => {
  it('PUT { done: false } → 400，且完成位不变', async () => {
    const db = emptyDb();
    const err = await callRouteThrow(db, 'PUT', JSON.stringify({ done: false }));
    assert.equal(err.status, 400);
    assert.match(err.message, /done: true/);

    // 已置位后再传 false 同样被拒、且不回退
    await callRoute(db, 'PUT', JSON.stringify({ done: true }));
    const err2 = await callRouteThrow(db, 'PUT', JSON.stringify({ done: false }));
    assert.equal(err2.status, 400);
    assert.equal(isOnboardingDone(db), true, 'done 必须保持 true，不得被 false 回退');
  });

  it('非法 JSON → 400', async () => {
    const db = emptyDb();
    const err = await callRouteThrow(db, 'PUT', '{ not json');
    assert.equal(err.status, 400);
    assert.match(err.message, /合法 JSON/);
    assert.equal(isOnboardingDone(db), false, '解析失败不得写库');
  });

  it('非对象 body（数字 / 数组 / done 非布尔 true）→ 400', async () => {
    const db = emptyDb();
    for (const body of ['42', '[]', 'null', JSON.stringify({ done: 'yes' }), JSON.stringify({ done: 1 })]) {
      const err = await callRouteThrow(db, 'PUT', body);
      assert.equal(err.status, 400, `应 400：${body}`);
    }
    assert.equal(isOnboardingDone(db), false, '所有非法入参都不得写库');
  });

  it('不支持的方法 → 405', async () => {
    const db = emptyDb();
    const err = await callRouteThrow(db, 'DELETE');
    assert.equal(err.status, 405);
  });
});

describe('onboarding：老用户豁免迁移', () => {
  it('🔴 库里有生效 goal → 补种 done = true（升级后不弹）', () => {
    const db = emptyDb();
    addGoal(db, 1);
    assert.equal(isOnboardingDone(db), false, '前置：迁移前完成位应为空');

    const seeded = seedOnboardingForExistingUsers(db);
    assert.equal(seeded, true);
    assert.equal(isOnboardingDone(db), true);
    assert.equal((appConfigRow(db) as { value_json: string }).value_json, 'true');
  });

  it('无 goal 的新库 → 不补种（照常弹引导）', () => {
    const db = emptyDb();
    assert.equal(seedOnboardingForExistingUsers(db), false);
    assert.equal(isOnboardingDone(db), false);
    assert.equal(appConfigRow(db), undefined, '不该留下完成位');
  });

  it('只有 is_active=0 的历史 goal → 不算老用户，不补种', () => {
    const db = emptyDb();
    addGoal(db, 0);
    assert.equal(seedOnboardingForExistingUsers(db), false);
    assert.equal(isOnboardingDone(db), false);
  });

  it('完成位键已存在（哪怕无 goal）→ 不重复补种', () => {
    const db = emptyDb();
    addGoal(db, 1);
    assert.equal(seedOnboardingForExistingUsers(db), true);
    // 第二次开机：键已存在，应直接跳过
    assert.equal(seedOnboardingForExistingUsers(db), false);
  });

  it('runStartupTasks 把补种结果带进 StartupReport.onboardingSeeded', () => {
    const db = emptyDb();
    addGoal(db, 1);
    const runner = {
      enqueue: async (): Promise<never> => {
        throw new Error('syncOnStartup=false 时不该入队');
      },
    } as unknown as Parameters<typeof runStartupTasks>[1];

    const report = runStartupTasks(db, runner, { syncOnStartup: false });
    assert.equal(report.onboardingSeeded, true);
    assert.equal(isOnboardingDone(db), true);

    // 空库：不补种
    const db2 = emptyDb();
    const report2 = runStartupTasks(db2, runner, { syncOnStartup: false });
    assert.equal(report2.onboardingSeeded, false);
    assert.equal(isOnboardingDone(db2), false);
  });
});
