import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseRetryMs,
  backoffMs,
  readCooldownMs,
  resolveRetryMs,
} from '../server/xunji/ratelimit.js';
import { DEFAULT_LIMITS } from './fixtures.js';

test('parseRetryMs：读取侧限频文本在 res 字段（实测形态）', () => {
  assert.equal(parseRetryMs('too frequent, retry after 30s'), 30_000);
  assert.equal(parseRetryMs('too frequent, retry after 44s'), 44_000);
});

test('parseRetryMs：写回侧文本在 error 字段同样可解析（双字段兼容）', () => {
  assert.equal(parseRetryMs('too frequent, retry after 44s'), 44_000);
  assert.equal(parseRetryMs(null), null);
  assert.equal(parseRetryMs(undefined), null);
  assert.equal(parseRetryMs(12345), null);
  assert.equal(parseRetryMs(''), null);
  assert.equal(parseRetryMs('something else'), null);
});

test('parseRetryMs：单位兼容（分钟/毫秒）与上限钳制', () => {
  assert.equal(parseRetryMs('retry after 2min'), 120_000);
  assert.equal(parseRetryMs('retry after 500ms'), 500);
  assert.equal(parseRetryMs('retry after 3600s'), 600_000); // 钳到 10 分钟
});

test('backoffMs：起点 30s、指数递增、上限 300s', () => {
  assert.equal(backoffMs(1), 30_000);
  assert.equal(backoffMs(2), 60_000);
  assert.equal(backoffMs(3), 120_000);
  assert.equal(backoffMs(4), 240_000);
  assert.equal(backoffMs(5), 300_000);
  assert.equal(backoffMs(9), 300_000);
  assert.equal(backoffMs(0), 30_000);
});

test('readCooldownMs 三源之②/③：limits 正常→full 值；缺缓存→30s 默认；结构变化→90s 兜底', () => {
  assert.equal(readCooldownMs(DEFAULT_LIMITS), 30_000);
  assert.equal(readCooldownMs(null), 30_000);
  assert.equal(
    readCooldownMs({
      maxTrainsPerDay: 4,
      maxMovesPerTrain: 40,
      maxSetsPerMove: 60,
      maxWriteMovesPerTrain: 15,
      maxWriteSetsPerMove: 20,
      maxPayloadBytes: 1,
      maxResponseBytes: 1,
      readRateLimitSeconds: 0, // 非法值
      readRateLimitSecondsLight: 0,
      readRateLimitSecondsFull: 0,
      writeRateLimitSeconds: 45,
    }),
    90_000, // ③ 兜底：limits 结构变化
  );
  assert.equal(
    readCooldownMs({
      ...DEFAULT_LIMITS,
      readRateLimitSecondsFull: 45, // 服务端可能调整
    }),
    45_000,
  );
});

test('resolveRetryMs 三源优先级：① 响应解析 → ② limits → ③ 90s', () => {
  // ① 最优先：即使 limits 也在也用响应里的
  assert.equal(resolveRetryMs(44_000, DEFAULT_LIMITS), 44_000);
  assert.equal(resolveRetryMs(44_000, null), 44_000);
  // ② 无响应提示 → limits/默认 30s
  assert.equal(resolveRetryMs(null, DEFAULT_LIMITS), 30_000);
  assert.equal(resolveRetryMs(null, null), 30_000);
  // ③ limits 存在但结构变化 → 90s
  assert.equal(
    resolveRetryMs(null, { ...DEFAULT_LIMITS, readRateLimitSecondsFull: 0, readRateLimitSeconds: 0 }),
    90_000,
  );
});
