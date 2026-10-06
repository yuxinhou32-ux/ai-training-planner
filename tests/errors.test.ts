import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyResponse, userMessageOf, XunjiError } from '../server/xunji/errors.js';
import { fatalEnvelope, tooFrequentEnvelope } from './fixtures.js';

test('错误分类：apikey missing → fatal 不重试', () => {
  const e = classifyResponse(200, fatalEnvelope('missing'), null);
  assert.ok(e instanceof XunjiError);
  assert.equal(e?.code, 'API_KEY_MISSING');
  assert.equal(e?.kind, 'fatal');
  assert.match(userMessageOf(e as XunjiError), /未配置训记 API Key/);
});

test('错误分类：apikey invalid → fatal', () => {
  const e = classifyResponse(200, fatalEnvelope('invalid'), null);
  assert.equal(e?.code, 'API_KEY_INVALID');
  assert.equal(e?.kind, 'fatal');
});

test('错误分类：仅 VIP 可用 → fatal', () => {
  const e = classifyResponse(200, fatalEnvelope('vip'), null);
  assert.equal(e?.code, 'VIP_REQUIRED');
  assert.equal(e?.kind, 'fatal');
});

test('错误分类：too frequent（读取形态，文本在 res）→ ratelimit + 解析等待值', () => {
  const e = classifyResponse(200, tooFrequentEnvelope(30, 'res'), null);
  assert.equal(e?.code, 'TOO_FREQUENT');
  assert.equal(e?.kind, 'ratelimit');
  assert.equal(e?.retryMs, 30_000);
});

test('错误分类：too frequent（写回形态，文本在 error）同样识别（双字段兼容）', () => {
  const e = classifyResponse(200, tooFrequentEnvelope(44, 'error'), null);
  assert.equal(e?.code, 'TOO_FREQUENT');
  assert.equal(e?.retryMs, 44_000);
});

test('错误分类：HTTP 5xx → retryable', () => {
  const e = classifyResponse(502, { success: false }, null);
  assert.equal(e?.code, 'HTTP_5XX');
  assert.equal(e?.kind, 'retryable');
});

test('错误分类：HTTP 4xx 未知 → failed 不重试', () => {
  const e = classifyResponse(404, {}, null);
  assert.equal(e?.code, 'HTTP_4XX');
  assert.equal(e?.kind, 'failed');
});

test('错误分类：success=true → null（成功）', () => {
  assert.equal(classifyResponse(200, { success: true, res: { trains: [] } }, null), null);
});

test('错误分类：🔴 实测形态——外壳无 success 字段只有 res 对象 → 成功（回归 90 天全失败 bug）', () => {
  // data/probe/*.json 实测：成功响应外壳是 { res: {...} }，没有顶层 success 字段
  const realShape = {
    res: {
      schema: 'train_open_api_v2',
      schema_version: 'train_open_api_v2',
      mode: 'full',
      datestr: '2026-09-14',
      limits: {},
      truncated: false,
      trains: [],
    },
  };
  assert.equal(classifyResponse(200, realShape, null), null);
  // res 是错误文本字符串且无关键字时不算成功（reader 的结构校验会拒绝）
  const e = classifyResponse(200, { res: 'some unclassifiable text' }, null);
  assert.equal(e, null, 'classify 层放行，结构校验归 reader');
});

test('错误分类：success 非 true 且未知 → failed', () => {
  const e = classifyResponse(200, { success: false }, null);
  assert.equal(e?.code, 'UNKNOWN_API_ERROR');
  assert.equal(e?.kind, 'failed');
});

test('错误分类：JSON 解析失败 → failed（留证由引擎负责）', () => {
  const e = classifyResponse(200, null, 'Unexpected token < in JSON');
  assert.equal(e?.code, 'JSON_PARSE');
  assert.equal(e?.kind, 'failed');
});

test('错误分类：success=true 优先于非 200 HTTP 状态（以响应体为准）', () => {
  assert.equal(classifyResponse(502, { success: true, res: {} }, null), null);
});

test('脱敏：错误消息中的 Bearer Key 必须被掩码（红线 §12.3-1）', () => {
  const e = new XunjiError({
    code: 'HTTP_4XX',
    kind: 'failed',
    message: 'HTTP 400: bad request, header was "Authorization: Bearer sk-live-abc123XYZ"',
  });
  assert.ok(!e.message.includes('sk-live-abc123XYZ'));
  assert.ok(e.message.includes('Bearer ***'));
});
