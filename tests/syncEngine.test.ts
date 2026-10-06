/**
 * 同步引擎集成测试（T1）——全部走 MockTransport + VirtualClock + 临时 SQLite。
 *
 * 🔴 红线（§12.3-6）：零真实网络；零写回调用（T1 根本不实现写回）。
 *
 * 覆盖场景（对应验收标准「断点续传」「限频退避」的引擎级验证）：
 *  1. 全量同步基础路径 + 行数对账 + job_run 记录
 *  2. 断点续传：中断（paused）→ 悬挂 fetching 复位 → 重跑不重复拉取、不重复入库
 *  3. 限频退避：too frequent → 按提示值等待 → 成功；attempts 不被消耗
 *  4. 自适应降级：并发 2 → 限频后 → 1
 *  5. 致命错误（Key 无效）终止整轮 + notification(error)
 *  6. 网络错误指数退避 + 重试耗尽 RETRY_EXHAUSTED
 *  7. HTTP 4xx → failed 不重试
 *  8. 新鲜度跳过 + force 全量重拉的幂等性
 *  9. 增量同步水位（watermark）语义
 * 10. runRetryFailed 仅重试 failed 日期
 * 11. runSingle 单日重拉幂等（raw 追加、结构化不重复）
 * 12. truncated → notification(warn) 不静默丢弃
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';

import {
  MockTransport,
  VirtualClock,
  daysTransport,
  fatalEnvelope,
  makeEnvelope,
  makeTempDb,
  makeTrain,
  tooFrequentEnvelope,
} from './fixtures.js';
import { SyncEngine, type SyncProgress } from '../server/ingest/syncEngine.js';
import { XunjiHttpClient, type XunjiHttpRequest } from '../server/xunji/client.js';
import { shiftDays, todayStr } from '../server/util/dates.js';
import { BACKOFF_BASE_MS, BACKOFF_CAP_MS, MAX_RETRY_ATTEMPTS } from '../server/config/constants.js';

/** 用 MockTransport 构造注入用 HTTP 客户端（不真实联网）。 */
function makeClient(transport: MockTransport): XunjiHttpClient {
  return new XunjiHttpClient({
    baseUrl: 'https://mock.xunji.test',
    apiKey: 'mock-key-for-tests-only',
    transport: transport.transport,
  });
}

interface EngineOpts {
  clock?: VirtualClock;
  concurrency?: number;
  shouldStop?: () => boolean;
  adaptiveDegrade?: boolean;
}

function buildEngine(
  db: ReturnType<typeof makeTempDb>['db'],
  transport: MockTransport,
  opts: EngineOpts = {},
): SyncEngine {
  return new SyncEngine({
    db,
    client: makeClient(transport),
    clock: opts.clock,
    concurrency: opts.concurrency,
    shouldStop: opts.shouldStop,
    adaptiveDegrade: opts.adaptiveDegrade,
  });
}

/** 统计某日期在 mock 传输上的真实请求次数。 */
function countCalls(transport: MockTransport, datestr: string): number {
  return transport.calls.filter((r: XunjiHttpRequest) => transport.datestrOf(r) === datestr).length;
}

/** 测试收尾：先关 DB（Windows 下不关会 EBUSY），再删临时目录。 */
function cleanup(db: ReturnType<typeof makeTempDb>['db'], dir: string): () => void {
  return () => {
    try {
      db.close();
    } catch {
      // 已关闭（node:sqlite 重复 close 会抛错，忽略）
    }
    rmSync(dir, { recursive: true, force: true });
  };
}

/** 判断 sleepLog 中是否存在落在 [expected - 999, expected] 的等待值。 */
function hasSleepNear(sleepLog: number[], expectedMs: number): boolean {
  return sleepLog.some((ms) => ms <= expectedMs && ms > expectedMs - 1000);
}

/** 期望的指数退避序列：30s, 60s, 120s, 240s, 300s（cap）。 */
function expectedBackoffSeq(): number[] {
  return Array.from({ length: MAX_RETRY_ATTEMPTS }, (_, i) =>
    Math.min(BACKOFF_BASE_MS * 2 ** i, BACKOFF_CAP_MS),
  );
}
/* ------------------------------------------------------------------ */
/* 1. 全量同步基础路径                                                  */
/* ------------------------------------------------------------------ */
test('runFull：全量同步、行数对账、job_run 记录与进度回调', async (t) => {
  const { db, dir } = makeTempDb();
  t.after(cleanup(db, dir));

  const clock = new VirtualClock();
  const today = todayStr(clock.now());
  const trainDays = [shiftDays(today, -1), shiftDays(today, -3)];
  const transport = daysTransport(trainDays);
  const engine = buildEngine(db, transport, { clock, concurrency: 2 });

  const progressLog: SyncProgress[] = [];
  const engineWithProgress = new SyncEngine({
    db,
    client: makeClient(transport),
    clock,
    concurrency: 2,
    onProgress: (p) => progressLog.push(p),
  });

  const summary = await engineWithProgress.runFull(7);
  assert.equal(summary.status, 'success');
  assert.equal(summary.total, 7);
  assert.equal(summary.fetched, 2);
  assert.equal(summary.empty, 5);
  assert.equal(summary.failed, 0);
  assert.equal(summary.skipped, 0);
  assert.equal(summary.rateLimitHits, 0);

  // 行数对账：2 天数据 ×（1 训练 / 1 动作 / 2 组）
  assert.deepEqual(engineWithProgress.train.counts(), { sessions: 2, movements: 2, sets: 4 });
  // raw 层：每次成功读取都留证（含 5 个空日期），7 天 = 7 行
  assert.equal(engineWithProgress.raw.count(), 7);

  // 每个日期恰好请求一次
  for (let k = 0; k < 7; k++) {
    assert.equal(countCalls(transport, shiftDays(today, -k)), 1, `date -${k} 应恰好请求 1 次`);
  }

  // 状态机：有数据 → done；无数据 → empty
  assert.equal(engineWithProgress.syncState.get(trainDays[0])?.status, 'done');
  assert.equal(engineWithProgress.syncState.get(today)?.status, 'empty');

  // job_run 记录闭环
  const job = engineWithProgress.jobs.get(summary.jobRunId);
  assert.equal(job?.status, 'success');
  assert.ok(job?.finished_at !== null && job?.finished_at !== undefined);

  // 进度回调至少收到终态（total=7）
  const last = progressLog.at(-1);
  assert.ok(last, '应收到进度回调');
  assert.equal(last.total, 7);
});

/* ------------------------------------------------------------------ */
/* 2. 断点续传                                                          */
/* ------------------------------------------------------------------ */
test('断点续传：中断暂停 → 悬挂 fetching 复位 → 重跑不重复拉取、不重复入库', async (t) => {
  const { db, dir } = makeTempDb();
  t.after(cleanup(db, dir));

  const clock = new VirtualClock();
  const today = todayStr(clock.now());
  const window = Array.from({ length: 7 }, (_, k) => shiftDays(today, -k));
  const transport1 = daysTransport(window); // 7 天都有数据
  const engine1 = buildEngine(db, transport1, {
    clock,
    concurrency: 1,
    shouldStop: () => transport1.calls.length >= 3, // 拉 3 天后模拟中断
  });

  const summary1 = await engine1.runFull(7);
  assert.equal(summary1.status, 'paused');
  assert.equal(summary1.fetched, 3);
  assert.equal(engine1.raw.count(), 3);
  assert.equal(engine1.train.counts().sessions, 3);

  // 模拟崩溃遗留的悬挂状态：一个未处理日期停在 fetching
  const dangling = window[6]; // 最旧日期（队列倒序，最后才轮到）
  assert.notEqual(engine1.syncState.get(dangling)?.status, 'done');
  engine1.syncState.setStatus(dangling, 'fetching', clock.now());

  // 第二轮：同一 DB、同一时钟、全新 transport —— 已完成的 3 天应被跳过
  const transport2 = daysTransport(window);
  const engine2 = buildEngine(db, transport2, { clock, concurrency: 1 });
  const summary2 = await engine2.runFull(7);

  assert.equal(summary2.status, 'success');
  assert.equal(summary2.skipped, 3, '已完成的 3 天应被新鲜度规则跳过');
  assert.equal(summary2.fetched, 4);
  assert.equal(transport2.calls.length, 4, '重跑只请求未完成的 4 天');

  // 被跳过的日期零请求
  for (const d of window.slice(0, 3)) {
    assert.equal(countCalls(transport2, d), 0, `已完成日期 ${d} 不应再次请求`);
  }

  // 对账：raw 3+4=7 行；结构化层不重复
  assert.equal(engine2.raw.count(), 7);
  assert.deepEqual(engine2.train.counts(), { sessions: 7, movements: 7, sets: 14 });

  // 无残留 fetching
  assert.equal(engine2.syncState.listByStatus('fetching').length, 0);

  // 第三轮全跳过（全部新鲜）
  const transport3 = daysTransport(window);
  const engine3 = buildEngine(db, transport3, { clock, concurrency: 1 });
  const summary3 = await engine3.runFull(7);
  assert.equal(summary3.status, 'success');
  assert.equal(summary3.skipped, 7);
  assert.equal(summary3.total, 0);
  assert.equal(transport3.calls.length, 0);
});

/* ------------------------------------------------------------------ */
/* 3. 限频退避（engine 级）                                              */
/* ------------------------------------------------------------------ */
test('限频退避：too frequent → 按提示值等待 → 成功；不消耗重试次数', async (t) => {
  const { db, dir } = makeTempDb();
  t.after(cleanup(db, dir));

  const clock = new VirtualClock();
  const today = todayStr(clock.now());
  const window = Array.from({ length: 3 }, (_, k) => shiftDays(today, -k));
  const limitedDate = window[0];

  const callsPerDate = new Map<string, number>();
  const transport2 = new MockTransport((req) => {
    const d = (JSON.parse(req.body) as { datestr: string }).datestr;
    const n = (callsPerDate.get(d) ?? 0) + 1;
    callsPerDate.set(d, n);
    if (d === limitedDate && n === 1) {
      return MockTransport.jsonResponse(tooFrequentEnvelope(30, 'res'));
    }
    return MockTransport.jsonResponse(makeEnvelope(d, [makeTrain({ datestr: d })]));
  });

  const engine = buildEngine(db, transport2, { clock, concurrency: 1 });
  const summary = await engine.runFull(3);

  assert.equal(summary.status, 'success');
  assert.equal(summary.fetched, 3);
  assert.equal(summary.rateLimitHits, 1, '限频恰好命中 1 次');

  // 等待值来自 ① 响应解析（retry after 30s）；next_retry_at 以秒精度落库，
  // 等待值 = 30s − (now % 1000) ∈ (29s, 30s]，按区间断言
  assert.ok(
    hasSleepNear(clock.sleepLog, 30_000),
    `应出现 ≈30s 等待，实际 sleepLog=${JSON.stringify(clock.sleepLog)}`,
  );

  // 该日期共请求 2 次（1 次限频 + 1 次成功）
  assert.equal(countCalls(transport2, limitedDate), 2);

  // 🔴 限频不消耗重试次数（§6.2.2）
  assert.equal(engine.syncState.get(limitedDate)?.attempts, 0);
  assert.equal(engine.syncState.get(limitedDate)?.status, 'done');

  // 数据完整
  assert.deepEqual(engine.train.counts(), { sessions: 3, movements: 3, sets: 6 });
});

/* ------------------------------------------------------------------ */
/* 4. 自适应降级                                                        */
/* ------------------------------------------------------------------ */
test('自适应降级：并发 2 遇限频 → 降为 1，任务仍全部完成', async (t) => {
  const { db, dir } = makeTempDb();
  t.after(cleanup(db, dir));

  const clock = new VirtualClock();
  const today = todayStr(clock.now());
  const window = Array.from({ length: 4 }, (_, k) => shiftDays(today, -k));
  const limitedDate = window[2];

  const callsPerDate = new Map<string, number>();
  const transport = new MockTransport((req) => {
    const d = (JSON.parse(req.body) as { datestr: string }).datestr;
    const n = (callsPerDate.get(d) ?? 0) + 1;
    callsPerDate.set(d, n);
    if (d === limitedDate && n === 1) {
      return MockTransport.jsonResponse(tooFrequentEnvelope(30, 'res'));
    }
    return MockTransport.jsonResponse(makeEnvelope(d, [makeTrain({ datestr: d })]));
  });

  const engine = buildEngine(db, transport, { clock, concurrency: 2 });
  const summary = await engine.runFull(4);

  assert.equal(summary.status, 'success');
  assert.equal(summary.fetched, 4);
  assert.equal(summary.rateLimitHits, 1);
  assert.equal(summary.degradeEvents, 1);
  assert.equal(summary.finalConcurrency, 1);
  assert.deepEqual(engine.train.counts(), { sessions: 4, movements: 4, sets: 8 });
});

/* ------------------------------------------------------------------ */
/* 5. 致命错误终止整轮                                                   */
/* ------------------------------------------------------------------ */
test('致命错误（Key 无效）：终止整轮 + notification(error)，不重试', async (t) => {
  const { db, dir } = makeTempDb();
  t.after(cleanup(db, dir));

  const clock = new VirtualClock();
  const transport = new MockTransport(() => MockTransport.jsonResponse(fatalEnvelope('invalid')));
  const engine = buildEngine(db, transport, { clock, concurrency: 1 });

  const summary = await engine.runFull(5);
  assert.equal(summary.status, 'failed');
  assert.equal(summary.failed, 1);
  assert.equal(summary.fetched, 0);

  // 致命错误不重试：仅 1 次请求即终止
  assert.equal(transport.calls.length, 1);

  // 原始层零写入
  assert.equal(engine.raw.count(), 0);

  // 状态 failed 且带错误码
  const failedRows = engine.syncState.listFailed();
  assert.equal(failedRows.length, 1);
  assert.equal(failedRows[0].error_code, 'API_KEY_INVALID');

  // 通知落库
  const notes = engine.notifications.listRecent(10);
  assert.ok(
    notes.some((n) => n.level === 'error' && n.title.includes('同步终止')),
    '应有 error 级通知',
  );

  // job_run 终态 failed
  const job = engine.jobs.get(summary.jobRunId);
  assert.equal(job?.status, 'failed');
});

/* ------------------------------------------------------------------ */
/* 6. 网络错误指数退避 + 重试耗尽                                        */
/* ------------------------------------------------------------------ */
test('网络错误：指数退避 30s→300s，耗尽后 RETRY_EXHAUSTED 落定', async (t) => {
  const { db, dir } = makeTempDb();
  t.after(cleanup(db, dir));

  const clock = new VirtualClock();
  const today = todayStr(clock.now());
  const badDate = shiftDays(today, 0);
  const goodDate = shiftDays(today, -1);

  const callsPerDate = new Map<string, number>();
  const transport = new MockTransport((req) => {
    const d = (JSON.parse(req.body) as { datestr: string }).datestr;
    const n = (callsPerDate.get(d) ?? 0) + 1;
    callsPerDate.set(d, n);
    if (d === badDate) throw new Error('ECONNRESET: socket hang up'); // 永远网络错误
    return MockTransport.jsonResponse(makeEnvelope(d, [makeTrain({ datestr: d })]));
  });

  const engine = buildEngine(db, transport, { clock, concurrency: 1 });
  const summary = await engine.runFull(2);

  assert.equal(summary.status, 'partial');
  assert.equal(summary.fetched, 1);
  assert.equal(summary.failed, 1);

  // 坏日期：恰好 MAX_RETRY_ATTEMPTS 次请求（每次网络错误消耗 1 次），耗尽落定；
  // 落定错误码 = 最后一次底层错误（NETWORK_ERROR，比笼统的 RETRY_EXHAUSTED 更利排障）
  const badState = engine.syncState.get(badDate);
  assert.equal(badState?.status, 'failed');
  assert.equal(badState?.error_code, 'NETWORK_ERROR');
  assert.equal(badState?.attempts, MAX_RETRY_ATTEMPTS);

  // 退避序列：前 4 次失败各睡 backoff(1..4)=30/60/120/240s；
  // 第 5 次失败耗尽 → 直接落定，不再睡眠（因此无 300s）
  const backoffSeq = expectedBackoffSeq();
  for (let i = 0; i < MAX_RETRY_ATTEMPTS - 1; i++) {
    assert.ok(
      hasSleepNear(clock.sleepLog, backoffSeq[i]),
      `退避序列应包含 ≈${backoffSeq[i]}ms，实际=${JSON.stringify(clock.sleepLog)}`,
    );
  }
  assert.equal(clock.sleepLog.includes(backoffSeq[MAX_RETRY_ATTEMPTS - 1] - 1), false, '耗尽后不应再退避 300s');

  // 好日期不受影响
  assert.equal(engine.syncState.get(goodDate)?.status, 'done');
  assert.deepEqual(engine.train.counts(), { sessions: 1, movements: 1, sets: 2 });
});

/* ------------------------------------------------------------------ */
/* 7. HTTP 4xx → failed 不重试                                          */
/* ------------------------------------------------------------------ */
test('HTTP 4xx：该日直接 failed，不重试不排队', async (t) => {
  const { db, dir } = makeTempDb();
  t.after(cleanup(db, dir));

  const clock = new VirtualClock();
  const today = todayStr(clock.now());
  const badDate = shiftDays(today, -1);

  const transport = new MockTransport((req) => {
    const d = (JSON.parse(req.body) as { datestr: string }).datestr;
    if (d === badDate) {
      return MockTransport.jsonResponse({ success: false, error: 'bad request: bad datestr' }, 400);
    }
    return MockTransport.jsonResponse(makeEnvelope(d, [makeTrain({ datestr: d })]));
  });

  const engine = buildEngine(db, transport, { clock, concurrency: 1 });
  const summary = await engine.runFull(3);

  assert.equal(summary.status, 'partial');
  assert.equal(summary.failed, 1);
  assert.equal(countCalls(transport, badDate), 1, '4xx 不应重试');
  assert.equal(engine.syncState.get(badDate)?.status, 'failed');
  assert.equal(engine.syncState.get(badDate)?.error_code, 'HTTP_4XX');
  assert.equal(engine.syncState.get(badDate)?.attempts, 0, '4xx 不消耗重试次数（直接落定）');
  assert.equal(summary.rateLimitHits, 0);
});

/* ------------------------------------------------------------------ */
/* 8. 新鲜度跳过 + force 全量重拉                                        */
/* ------------------------------------------------------------------ */
test('新鲜度：done 全跳过；force 重拉全部但不重复入库', async (t) => {
  const { db, dir } = makeTempDb();
  t.after(cleanup(db, dir));

  const clock = new VirtualClock();
  const window = Array.from({ length: 5 }, (_, k) => shiftDays(todayStr(clock.now()), -k));
  const transport1 = daysTransport(window);
  const engine1 = buildEngine(db, transport1, { clock, concurrency: 2 });
  await engine1.runFull(5);
  assert.deepEqual(engine1.train.counts(), { sessions: 5, movements: 5, sets: 10 });

  // 第二轮：全部新鲜 → 全跳过，零请求（先推进 1s，避开 raw 层同秒唯一键）
  clock.sleep(1_000);
  const transport2 = daysTransport(window);
  const engine2 = buildEngine(db, transport2, { clock, concurrency: 2 });
  const summary2 = await engine2.runFull(5);
  assert.equal(summary2.skipped, 5);
  assert.equal(summary2.total, 0);
  assert.equal(transport2.calls.length, 0);

  // force：绕过新鲜度，全部重拉，结构化层幂等（不产生重复行）
  clock.sleep(1_000);
  const transport3 = daysTransport(window);
  const engine3 = buildEngine(db, transport3, { clock, concurrency: 2 });
  const summary3 = await engine3.runFull(5, { force: true });
  assert.equal(summary3.skipped, 0);
  assert.equal(summary3.fetched, 5);
  assert.equal(transport3.calls.length, 5);
  assert.equal(engine3.raw.count(), 10, 'raw 层追加留证（5+5）');
  assert.deepEqual(engine3.train.counts(), { sessions: 5, movements: 5, sets: 10 }, '结构化层不重复');
});

/* ------------------------------------------------------------------ */
/* 9. 增量同步水位                                                      */
/* ------------------------------------------------------------------ */
test('runIncremental：水位之后 + 过期日期重拉，水位不回看', async (t) => {
  const { db, dir } = makeTempDb();
  t.after(cleanup(db, dir));

  const clock = new VirtualClock();
  const today0 = todayStr(clock.now());
  const window = Array.from({ length: 7 }, (_, k) => shiftDays(today0, -k));
  const transport1 = daysTransport(window);
  const engine1 = buildEngine(db, transport1, { clock, concurrency: 2 });
  await engine1.runFull(7);
  assert.equal(engine1.syncState.maxSyncedDatestr(), today0, '水位 = 已同步最大日期');

  // 情形 A：全部新鲜 → 增量无事可做（当日虽在水位后但仍在 6h TTL 内）
  const transportA = daysTransport(window);
  const engineA = buildEngine(db, transportA, { clock, concurrency: 1 });
  const summaryA = await engineA.runIncremental();
  assert.equal(summaryA.status, 'success');
  assert.equal(transportA.calls.length, 0);

  // 情形 B：推进 7h，当日 TTL 过期 → 增量只拉当日 1 天
  clock.sleep(7 * 60 * 60 * 1000);
  const transportB = daysTransport(window);
  const engineB = buildEngine(db, transportB, { clock, concurrency: 1 });
  const summaryB = await engineB.runIncremental();
  assert.equal(summaryB.fetched, 1);
  assert.equal(transportB.calls.length, 1);
  assert.equal(transportB.calls[0] ? transportB.datestrOf(transportB.calls[0]) : null, today0);

  // 情形 C：跨天推进 25h → 出现新的一天；增量拉 [旧水位日, 新今日] 两天
  clock.sleep(25 * 60 * 60 * 1000);
  const today1 = todayStr(clock.now());
  assert.notEqual(today1, today0);
  const transportC = daysTransport([...window, today1]);
  const engineC = buildEngine(db, transportC, { clock, concurrency: 1 });
  const summaryC = await engineC.runIncremental();
  assert.equal(summaryC.fetched, 2);
  assert.equal(transportC.calls.length, 2);
  assert.equal(engineC.syncState.maxSyncedDatestr(), today1, '水位推进到新今日');

  // 结构化层：7（首轮窗口）+1（新今日）= 8 个会话；旧日期重拉不重复
  assert.deepEqual(engineC.train.counts(), { sessions: 8, movements: 8, sets: 16 });
});

/* ------------------------------------------------------------------ */
/* 10. runRetryFailed                                                   */
/* ------------------------------------------------------------------ */
test('runRetryFailed：仅重试 failed 日期，成功后状态迁移', async (t) => {
  const { db, dir } = makeTempDb();
  t.after(cleanup(db, dir));

  const clock = new VirtualClock();
  const today = todayStr(clock.now());
  const failedDate = shiftDays(today, -2);

  // 直接在状态层预置一个 failed 日期（模拟历史失败）
  const engine0 = buildEngine(db, daysTransport([failedDate]), { clock, concurrency: 1 });
  engine0.syncState.ensure(failedDate);
  engine0.syncState.markFailed(failedDate, 'HTTP_4XX', '历史失败');

  const transport = daysTransport([failedDate]);
  const engine = buildEngine(db, transport, { clock, concurrency: 1 });
  const summary = await engine.runRetryFailed();

  assert.equal(summary.status, 'success');
  assert.equal(summary.fetched, 1);
  assert.equal(engine.syncState.get(failedDate)?.status, 'done');
  assert.equal(engine.syncState.get(failedDate)?.error_code, null);
  assert.deepEqual(engine.train.counts(), { sessions: 1, movements: 1, sets: 2 });

  // 无 failed 后再跑：空队列直接成功
  const summary2 = await engine.runRetryFailed();
  assert.equal(summary2.status, 'success');
  assert.equal(summary2.total, 0);
});

/* ------------------------------------------------------------------ */
/* 11. runSingle 幂等重拉                                                */
/* ------------------------------------------------------------------ */
test('runSingle：单日重拉两次，raw 追加、结构化不重复', async (t) => {
  const { db, dir } = makeTempDb();
  t.after(cleanup(db, dir));

  const clock = new VirtualClock();
  const date = shiftDays(todayStr(clock.now()), -1);
  const transport = daysTransport([date]);
  const engine = buildEngine(db, transport, { clock, concurrency: 1 });

  const s1 = await engine.runSingle(date);
  assert.equal(s1.status, 'success');
  assert.equal(s1.fetched, 1);

  clock.sleep(1_000); // 推进 1s：raw 层 UNIQUE(datestr, fetched_at) 为秒精度
  const s2 = await engine.runSingle(date);
  assert.equal(s2.status, 'success');
  assert.equal(s2.fetched, 1);

  assert.equal(engine.raw.count(), 2, 'raw 层两次成功各留一行');
  assert.deepEqual(engine.train.counts(), { sessions: 1, movements: 1, sets: 2 }, '结构化层幂等');
  assert.equal(engine.syncState.get(date)?.status, 'done');
  assert.equal(countCalls(transport, date), 2);
});

/* ------------------------------------------------------------------ */
/* 12. truncated → 告警落库                                              */
/* ------------------------------------------------------------------ */
test('truncated：截断响应照常入库 + notification(warn) 不静默丢弃', async (t) => {
  const { db, dir } = makeTempDb();
  t.after(cleanup(db, dir));

  const clock = new VirtualClock();
  const date = shiftDays(todayStr(clock.now()), -1);
  const transport = new MockTransport((req) => {
    const d = (JSON.parse(req.body) as { datestr: string }).datestr;
    return MockTransport.jsonResponse(
      makeEnvelope(d, [makeTrain({ datestr: d })], { resTruncated: true }),
    );
  });
  const engine = buildEngine(db, transport, { clock, concurrency: 1 });

  const summary = await engine.runSingle(date);
  assert.equal(summary.status, 'success', '截断不是错误：数据照常入库');
  assert.deepEqual(engine.train.counts(), { sessions: 1, movements: 1, sets: 2 });

  // 告警落库且指向该日期
  const notes = engine.notifications.listRecent(10);
  const warn = notes.find((n) => n.level === 'warn' && n.title.includes('数据被服务端截断'));
  assert.ok(warn, '应有截断告警');
  assert.equal(warn.ref_id, date);
  assert.ok(warn.body !== null && warn.body.includes('raw_train_raw'), '告警正文应说明原始 JSON 已留证');
});
