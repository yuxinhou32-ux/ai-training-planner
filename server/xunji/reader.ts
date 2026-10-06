import { READ_PATH } from '../config/constants.js';
import { realClock, type Clock } from '../util/clock.js';
import { silentLogger, type Logger } from '../shared/logger.js';
import type { ReaderStateStore } from '../repo/syncStateRepo.js';
import type { ResBody, TrainRaw, XunjiLimits } from './types.js';
import { parseLimits } from './types.js';
import type { XunjiHttpClient } from './client.js';
import { classifyResponse, XunjiError } from './errors.js';
import { readCooldownMs, resolveRetryMs } from './ratelimit.js';

/**
 * 读取客户端 XunjiReader（T1，§6.2）。
 *
 * 职责（单次 fetchDay = 一次逻辑读取）：
 *  1. 客户端冷却闸门：同一天 next_retry_at 未到则先等（§6.2.2 acquire）；
 *  2. 发起请求（全程 full 模式，body 由 client.buildReadBody 构造，不提供开关）；
 *  3. 标记本次请求（last_attempt_at / next_retry_at = now + 读侧冷却）；
 *  4. 响应分类：失败抛 XunjiError（too frequent 的等待值按三源优先级合成）；
 *  5. 成功：提取 res / trains / limits（limits 回调给引擎刷新 app_config）。
 * 重试/退避/重排队属于同步引擎的调度策略，不在 reader 内循环。
 */
export interface DayFetchResult {
  datestr: string;
  ok: true;
  httpStatus: number;
  elapsedMs: number;
  encoding: string;
  /** 解压后的完整响应文本（原样落 raw_train_raw.payload_json）。 */
  payloadText: string;
  /** 响应信封 JSON（success/res）。 */
  envelope: { success: unknown; res: unknown };
  /** json.res（已验证为对象）。 */
  res: ResBody;
  trains: TrainRaw[];
  /** 本次响应携带的 res.limits（可能为 null）。 */
  limits: XunjiLimits | null;
  resTruncated: boolean | null;
  fetchedAtMs: number;
}

export class XunjiReader {
  private readonly client: XunjiHttpClient;
  private readonly limitsProvider: () => XunjiLimits | null;
  private readonly state: ReaderStateStore;
  private readonly onLimits: ((limits: XunjiLimits) => void) | null;
  private readonly clock: Clock;
  private readonly logger: Logger;

  constructor(opts: {
    client: XunjiHttpClient;
    limitsProvider: () => XunjiLimits | null;
    state: ReaderStateStore;
    onLimits?: ((limits: XunjiLimits) => void) | null;
    clock?: Clock;
    logger?: Logger;
  }) {
    this.client = opts.client;
    this.limitsProvider = opts.limitsProvider;
    this.state = opts.state;
    this.onLimits = opts.onLimits ?? null;
    this.clock = opts.clock ?? realClock;
    this.logger = opts.logger ?? silentLogger;
  }

  async fetchDay(datestr: string): Promise<DayFetchResult> {
    // 1) 客户端闸门（§6.2.2：同一天短时间内二次请求的预防）
    const gateMs = this.state.getNextRetryAtMs(datestr);
    const now0 = this.clock.now();
    if (gateMs !== null && gateMs > now0) {
      const waitMs = gateMs - now0;
      this.logger.debug(`${datestr} 处于冷却窗口，等待 ${(waitMs / 1000).toFixed(1)}s`);
      await this.clock.sleep(waitMs);
    }

    // 2) 请求（full 模式常量在 client.buildReadBody）
    const t0 = this.clock.now();
    const result = await this.client.post(READ_PATH, this.client.buildReadBody(datestr));
    const elapsedMs = this.clock.now() - t0;
    const now1 = this.clock.now();

    // 3) 标记本次请求：next allowed = now + 读侧冷却（② limits 缓存优先，不写死 30s）
    this.state.touchAttempt(datestr, now1 + readCooldownMs(this.limitsProvider()), now1);

    // 4) 分类；too frequent 的等待值按三源合成（① 解析值 ?? ② limits ?? ③ 90s）
    const err = classifyResponse(result.httpStatus, result.json, result.parseError);
    if (err !== null) {
      if (err.code === 'TOO_FREQUENT') {
        err.retryMs = resolveRetryMs(err.retryMs, this.limitsProvider());
      }
      throw err;
    }

    // 5) 成功路径：res 必须是对象且 trains 必须是数组（结构变化宁可报错也不静默吞）
    const envelope = (result.json ?? {}) as { success?: unknown; res?: unknown };
    const resRaw = envelope.res;
    if (resRaw === null || typeof resRaw !== 'object' || Array.isArray(resRaw)) {
      throw new XunjiError({
        code: 'UNKNOWN_API_ERROR',
        kind: 'failed',
        message: `响应结构异常：res 不是对象（success=${String(envelope.success)}）`,
        httpStatus: result.httpStatus,
        raw: envelope,
      });
    }
    const res = resRaw as ResBody;
    if (!Array.isArray(res.trains)) {
      throw new XunjiError({
        code: 'UNKNOWN_API_ERROR',
        kind: 'failed',
        message: '响应结构异常：res.trains 缺失或不是数组',
        httpStatus: result.httpStatus,
        raw: envelope,
      });
    }

    // res.limits → 刷新缓存（同步引擎把它写进 app_config 并更新内存值）
    const limits = parseLimits(res.limits);
    if (limits !== null) this.onLimits?.(limits);

    this.logger.info(
      `${datestr} 读取成功：${res.trains.length} 条训练（${(elapsedMs / 1000).toFixed(2)}s，${result.encoding}，${result.bytes}B）`,
    );

    return {
      datestr,
      ok: true,
      httpStatus: result.httpStatus,
      elapsedMs,
      encoding: result.encoding,
      payloadText: result.text,
      envelope: { success: envelope.success ?? null, res: envelope.res ?? null },
      res,
      trains: res.trains as TrainRaw[],
      limits,
      resTruncated: res.truncated === true ? true : res.truncated === false ? false : null,
      fetchedAtMs: now1,
    };
  }
}
