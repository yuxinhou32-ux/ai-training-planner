/**
 * 测试夹具与 Mock 传输层（T1）。
 *
 * 🔴 红线（§12.3-6）：单元/集成测试一律 mock 传输层，绝不真实联网，
 * 更不存在任何写回调用（T1 阶段根本不实现写回）。
 */
import { gzipSync } from 'node:zlib';
import type { XunjiHttpRequest, XunjiHttpResponse, Transport } from '../server/xunji/client.js';
import type { ResBody, TrainRaw, XunjiLimits } from '../server/xunji/types.js';
import type { Clock } from '../server/util/clock.js';
import { openDatabase, type Db } from '../server/db/index.js';
import { migrate } from '../server/db/migrate.js';

/** 与服务端实测自报值一致的默认 limits（probe-report 开头 JSON）。 */
export const DEFAULT_LIMITS: XunjiLimits = {
  maxTrainsPerDay: 4,
  maxMovesPerTrain: 40,
  maxSetsPerMove: 60,
  maxWriteMovesPerTrain: 15,
  maxWriteSetsPerMove: 20,
  maxPayloadBytes: 131_072,
  maxResponseBytes: 196_608,
  readRateLimitSeconds: 30,
  readRateLimitSecondsLight: 15,
  readRateLimitSecondsFull: 30,
  writeRateLimitSeconds: 45,
};

export function makeSet(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    index: 1,
    done: true,
    weight: '30',
    unit: 'kg',
    reps: '10',
    time: 60,
    timeLabel: '',
    selfWeight: false,
    rpe: '',
    note: '',
    comment: '',
    setType: '',
    leftWeight: '',
    ...over,
  };
}

export function makeMovement(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    index: 1,
    name: '杠铃卧推',
    type: '胸',
    exetype: '',
    sets: [makeSet(), makeSet({ index: 2, weight: '32.5' })],
    truncated: false,
    note: '',
    singleSide: false,
    restTime: 120,
    warn_restTime: 0,
    ...over,
  };
}

export function makeTrain(over: Record<string, unknown> = {}): Record<string, unknown> {
  // 虚构时间戳（2026-09-14T00:00:00Z）：真实接口返回的毫秒值已脱敏
  const start = 1_789_344_000_000;
  return {
    localid: 1_789_344_000_001,
    datestr: '2026-09-14',
    title: '',
    note: '状态不错',
    start,
    end: start + 67 * 60 * 1000,
    started_at: start,
    ended_at: start + 67 * 60 * 1000,
    movements: [makeMovement()],
    truncated: false,
    ...over,
  };
}

export function makeEnvelope(
  datestr: string,
  trains: Record<string, unknown>[],
  opts: { resTruncated?: boolean; limits?: XunjiLimits | null } = {},
): Record<string, unknown> {
  // 🔴 忠实还原实测线上形态（data/probe/*.json）：成功响应外壳只有 res，没有顶层 success 字段
  return {
    res: {
      schema: 'train_open_api_v2',
      schema_version: 'train_open_api_v2',
      version: 2,
      mode: 'full',
      includeFullData: true,
      include_full_data: true,
      datestr,
      movementCatalogUrl: '/api_movement_catalog_for_llm_v2',
      movement_catalog_url: '/api_movement_catalog_for_llm_v2',
      limits: opts.limits === undefined ? { ...DEFAULT_LIMITS } : opts.limits,
      truncated: opts.resTruncated ?? false,
      trains,
    },
  };
}

export function makeCardioTrain(datestr: string, localid = 111): Record<string, unknown> {
  return makeTrain({
    localid,
    datestr,
    movements: [
      makeMovement({
        index: 1,
        name: '有氧训练',
        type: '',
        exetype: 'cardio',
        restTime: null,
        singleSide: null,
        sets: [
          makeSet({
            weight: '',
            unit: '',
            reps: '',
            time: 0,
            metrics: { distance: '1.97', kcal: '266.71', bpm: '133' },
            distance: '1.97',
            kcal: '266.71',
            bpm: '133',
            recordFieldKeys: ['distance', 'steps', 'cadence', 'kcal', 'bpm'],
          }),
        ],
      }),
    ],
  });
}

/** 限频响应（读取侧：文本在 res 字段，§6.4 实测）。 */
export function tooFrequentEnvelope(seconds = 30, field: 'res' | 'error' = 'res'): Record<string, unknown> {
  const text = `too frequent, retry after ${seconds}s`;
  return field === 'res' ? { success: false, res: text } : { success: false, error: text };
}

export function fatalEnvelope(kind: 'missing' | 'invalid' | 'vip'): Record<string, unknown> {
  if (kind === 'missing') return { success: false, error: 'apikey is missing' };
  if (kind === 'invalid') return { success: false, error: 'apikey invalid' };
  return { success: false, error: '该接口仅 VIP 可用' };
}

/** Mock 传输：按调用序/请求内容决定响应；记录全部请求供断言。 */
export class MockTransport {
  calls: XunjiHttpRequest[] = [];
  private handler: (req: XunjiHttpRequest, callIndex: number) => Promise<XunjiHttpResponse> | XunjiHttpResponse;

  constructor(
    handler: (req: XunjiHttpRequest, callIndex: number) => Promise<XunjiHttpResponse> | XunjiHttpResponse,
  ) {
    this.handler = handler;
  }

  readonly transport: Transport = async (req: XunjiHttpRequest): Promise<XunjiHttpResponse> => {
    this.calls.push(req);
    return this.handler(req, this.calls.length - 1);
  };

  /** 解析请求 body 里的 datestr。 */
  datestrOf(req: XunjiHttpRequest): string {
    return (JSON.parse(req.body) as { datestr: string }).datestr;
  }

  static jsonResponse(body: unknown, status = 200): XunjiHttpResponse {
    return {
      status,
      headers: { 'content-type': 'application/json' },
      bodyBytes: Buffer.from(JSON.stringify(body), 'utf8'),
    };
  }

  /** gzip 响应（content-encoding: gzip + 魔数 1f 8b 字节，模拟最常见真实形态）。 */
  static gzipResponse(body: unknown, status = 200): XunjiHttpResponse {
    return {
      status,
      headers: { 'content-type': 'application/json', 'content-encoding': 'gzip' },
      bodyBytes: gzipSync(Buffer.from(JSON.stringify(body), 'utf8')),
    };
  }
}

/** 虚拟时钟：sleep 即推进时间（退避/冷却断言不真实等待）。 */
export class VirtualClock implements Clock {
  nowMs: number;
  readonly sleepLog: number[] = [];

  /**
   * 缺省锚点固定为「当日本地 10:00」，严禁用真实时钟做锚点：
   * 若以真实 Date.now() 为起点，在本地 ≥17:00 运行测试时推进 7h 会
   * 跨过本地午夜 → todayStr 翻天 → 增量窗口多出一天（时间边界缺陷，
   * 而非业务缺陷：跨天后新的一天本就应重拉）。固定锚点后任何推进量
   * 均确定性落点（10:00 + 7h = 当日 17:00，10:00 + 32h = 次日 18:00）。
   */
  constructor(baseMs?: number) {
    if (baseMs !== undefined) {
      this.nowMs = baseMs;
      return;
    }
    const anchor = new Date();
    anchor.setHours(10, 0, 0, 0);
    this.nowMs = anchor.getTime();
  }

  now(): number {
    return this.nowMs;
  }

  async sleep(ms: number): Promise<void> {
    this.sleepLog.push(ms);
    this.nowMs += Math.max(0, ms);
  }

  /** 跳过最后一次 sleep 产生的 next_retry_at 到期（配合引擎轮询）。 */
  static nextDayIso(clock: VirtualClock): string {
    return new Date(clock.nowMs).toISOString();
  }
}

/** 本模块创建的临时库/目录登记表，供退出钩子统一清理（单点收口泄漏）。 */
const tempDbRegistry: { db: Db; dir: string }[] = [];
/** 退出钩子只注册一次（模块通常仅加载一次，仍防重）。 */
let exitCleanupHookRegistered = false;

/** 确保退出钩子已注册：逐个先关库、再删目录（Windows 上顺序不可调换）。 */
function ensureExitCleanupHook(): void {
  if (exitCleanupHookRegistered) return;
  exitCleanupHookRegistered = true;
  process.on('exit', () => {
    for (const { db, dir } of tempDbRegistry) {
      try {
        db.close();
      } catch {
        // 测试可能已自行关库；退出钩子绝不可抛异常
      }
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // 清理失败不应影响退出码
      }
    }
  });
}

/** 临时文件数据库（WAL 真实路径；本模块退出钩子统一清理目录）。 */
export function makeTempDb(): { db: Db; dir: string; file: string } {
  const dir = makeTempDir();
  const file = `${dir}/app.db`;
  const db = openDatabase(file);
  migrate(db);
  tempDbRegistry.push({ db, dir });
  ensureExitCleanupHook();
  return { db, dir, file };
}

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

export function makeTempDir(): string {
  return mkdtempSync(path.join(tmpdir(), 'atp-t1-'));
}

/** 组合多天数据的 transport（默认每天 1 条训练）。 */
export function daysTransport(
  datesWithData: string[],
  opts: { trainPerDay?: (d: string) => Record<string, unknown>[] } = {},
): MockTransport {
  return new MockTransport((req) => {
    const d = (JSON.parse(req.body) as { datestr: string }).datestr;
    const trains = datesWithData.includes(d)
      ? (opts.trainPerDay?.(d) ?? [makeTrain({ localid: 1_789_344_000_001, datestr: d })])
      : [];
    return MockTransport.jsonResponse(makeEnvelope(d, trains));
  });
}
