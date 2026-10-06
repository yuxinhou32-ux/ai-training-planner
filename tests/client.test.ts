import { test } from 'node:test';
import assert from 'node:assert/strict';
import { brotliCompressSync, deflateSync, gunzipSync, gzipSync } from 'node:zlib';
import { XunjiHttpClient, decodeBody, fetchTransport } from '../server/xunji/client.js';
import { MockTransport, makeEnvelope, makeTrain, tooFrequentEnvelope } from './fixtures.js';
import { READ_PATH } from '../server/config/constants.js';

test('decodeBody：gzip 魔数 1f 8b → 手工 gunzip（即使头部未声明）', () => {
  const gzipBytes = gzipSync(Buffer.from(JSON.stringify({ a: 1 }), 'utf8'));
  const out = decodeBody({}, gzipBytes);
  assert.equal(out.encoding, 'gzip（已手动解压）');
  assert.deepEqual(JSON.parse(out.text), { a: 1 });
});

test('decodeBody：传输层已自动解压（实测主路径）→ 按明文处理', () => {
  const plain = Buffer.from(JSON.stringify({ a: 1 }), 'utf8');
  const out = decodeBody({ 'content-encoding': 'gzip' }, plain);
  assert.deepEqual(JSON.parse(out.text), { a: 1 });
  assert.match(out.encoding, /传输层已自动解压/);
});

test('decodeBody：deflate / br / identity', () => {
  const payload = Buffer.from(JSON.stringify({ b: 2 }), 'utf8');
  assert.deepEqual(JSON.parse(decodeBody({ 'content-encoding': 'deflate' }, deflateSync(payload)).text), { b: 2 });
  assert.deepEqual(JSON.parse(decodeBody({ 'content-encoding': 'br' }, brotliCompressSync(payload)).text), { b: 2 });
  assert.deepEqual(JSON.parse(decodeBody({}, payload).text), { b: 2 });
});

test('decodeBody：gzip 魔数正确但包体损坏 → 按原文返回（交 JSON.parse 判定）', () => {
  const broken = Buffer.concat([Buffer.from([0x1f, 0x8b]), Buffer.from('garbage-not-gzip')]);
  const out = decodeBody({}, broken);
  assert.match(out.encoding, /解压失败/);
  // 「按原文」= 原始字节原样（含魔数）；后续 JSON.parse 失败会走 JSON_PARSE 留证路径
  assert.equal(out.text, broken.toString('utf8'));
  assert.throws(() => JSON.parse(out.text));
});

test('XunjiHttpClient：请求构造（full 模式常量 + Bearer 头 + gzip 声明）', async () => {
  const mock = new MockTransport(() => MockTransport.jsonResponse(makeEnvelope('2026-09-14', [])));
  const client = new XunjiHttpClient({ baseUrl: 'https://trains.xunjiapp.cn', apiKey: 'TESTKEY123', transport: mock.transport });
  await client.post(READ_PATH, client.buildReadBody('2026-09-14'));

  assert.equal(mock.calls.length, 1);
  const req = mock.calls[0] as (typeof mock.calls)[number];
  assert.equal(req.url, 'https://trains.xunjiapp.cn/api_trains_for_llm_v2');
  assert.equal(req.method, 'POST');
  assert.equal(req.headers['Authorization'], 'Bearer TESTKEY123');
  assert.equal(req.headers['Accept-Encoding'], 'gzip');
  const body = JSON.parse(req.body) as Record<string, unknown>;
  assert.deepEqual(body, {
    schema_version: 'train_open_api_v2',
    datestr: '2026-09-14',
    include_full_data: true, // 🔴 全程 full，不提供开关
  });
});

test('XunjiHttpClient：gzip 响应链路（传输→解码→JSON）', async () => {
  const mock = new MockTransport((req) => MockTransport.gzipResponse(makeEnvelope('2026-09-14', [makeTrain({ datestr: '2026-09-14' })])));
  const client = new XunjiHttpClient({ baseUrl: 'https://x.example', apiKey: 'K', transport: mock.transport });
  const r = await client.post('/api_trains_for_llm_v2', { datestr: '2026-09-14' });
  assert.equal(r.httpStatus, 200);
  assert.equal(r.parseError, null);
  const envelope = r.json as { success?: boolean; res: { trains: unknown[] } };
  // 实测线上成功响应没有顶层 success 字段（classify 以 res 结构兜底判定成功）
  assert.equal('success' in envelope, false);
  assert.equal(envelope.res.trains.length, 1);
});

test('XunjiHttpClient：限频响应透传给上层分类（不在 client 层吞掉）', async () => {
  const mock = new MockTransport(() => MockTransport.jsonResponse(tooFrequentEnvelope(30)));
  const client = new XunjiHttpClient({ baseUrl: 'https://x.example', apiKey: 'K', transport: mock.transport });
  const r = await client.post('/api_trains_for_llm_v2', { datestr: '2026-09-14' });
  const envelope = r.json as { success: boolean; res: string };
  assert.equal(envelope.success, false);
  assert.match(envelope.res, /too frequent/);
});

test('XunjiHttpClient：传输层抛错 → 归一为 NETWORK_ERROR（retryable）', async () => {
  const mock = new MockTransport(() => {
    throw new Error('ECONNRESET');
  });
  const client = new XunjiHttpClient({ baseUrl: 'https://x.example', apiKey: 'K', transport: mock.transport });
  await assert.rejects(
    client.post('/api_trains_for_llm_v2', {}),
    (e: unknown) => e instanceof Error && /网络错误/.test((e as Error).message),
  );
});

test('fetchTransport：AbortError → 归一为 NETWORK_ERROR（mock 全局 fetch，零真实网络）', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => {
    const e = new Error('This operation was aborted');
    e.name = 'AbortError';
    throw e;
  }) as typeof fetch;
  try {
    await assert.rejects(
      fetchTransport({
        url: 'https://x.example/api',
        method: 'POST',
        headers: {},
        body: '{}',
        timeoutMs: 5,
      }),
      (e: unknown) => e instanceof Error && /请求超时/.test((e as Error).message),
    );
  } finally {
    globalThis.fetch = original;
  }
});

test('fetchTransport：普通 fetch 失败 → 归一为 NETWORK_ERROR（mock 全局 fetch）', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error('connect ECONNREFUSED');
  }) as typeof fetch;
  try {
    await assert.rejects(
      fetchTransport({
        url: 'https://x.example/api',
        method: 'POST',
        headers: {},
        body: '{}',
        timeoutMs: 5,
      }),
      (e: unknown) => e instanceof Error && /ECONNREFUSED/.test((e as Error).message),
    );
  } finally {
    globalThis.fetch = original;
  }
});
