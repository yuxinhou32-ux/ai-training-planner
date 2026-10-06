/**
 * 时钟抽象（T1）。
 *
 * 目的：让「冷却等待 / 重试退避 / 进度 ETA / 时间戳」全部可注入，
 * 单元测试用 VirtualClock 虚拟推进时间，避免真实等待 30s+；
 * 生产环境用 realClock()。
 */
export interface Clock {
  /** 当前毫秒时间戳（epoch ms）。 */
  now(): number;
  /** 异步等待 ms 毫秒。 */
  sleep(ms: number): Promise<void>;
}

/** 生产环境时钟：Date.now + setTimeout。 */
export const realClock: Clock = {
  now(): number {
    return Date.now();
  },
  sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      if (ms <= 0) {
        resolve();
        return;
      }
      setTimeout(resolve, ms);
    });
  },
};

/** 秒精度 ISO-8601 UTC 时间戳（§3.1 通用约定：TEXT、UTC、秒精度）。 */
export function isoSeconds(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}
