/**
 * 关键常量清单（§12.1，集中管理，禁止散落硬编码）。
 *
 * ⚠️ 读/写上限不对称（实测事实，禁止混用）：
 *   - 读侧：maxMovesPerTrain=40 / maxSetsPerMove=60 —— 同步引擎截断检测用；
 *   - 写侧：maxWriteMovesPerTrain=15 / maxWriteSetsPerMove=20 —— T4 写前校验 C2/C3 用。
 */
export const XUNJI_BASE_URL = 'https://trains.xunjiapp.cn';
export const READ_PATH = '/api_trains_for_llm_v2';

/**
 * 写回接口路径（§12.1 常量完整性而在此声明）。
 * 🔴 红线（§12.3-2/6）：T1 阶段严禁任何代码调用该接口；
 * 真实写回只允许出现在 T4 的 `POST /api/plans/:id/confirm` 调用点。
 */
export const WRITE_PATH = '/api_upsert_trains_for_llm_v2';

export const SCHEMA_VERSION = 'train_open_api_v2';

/** 实测强制 full 模式（§6.2.1 硬约束）：setType/restTime/rpe 仅 full 模式返回，不可配置。 */
export const INCLUDE_FULL_DATA = true as const;

/** 读侧限频冷却（§12.1）：三源之②的默认值（res.limits.readRateLimitSecondsFull）。 */
export const READ_COOL_DOWN_MS = 30_000;
/**
 * 写侧限频冷却（§12.1）。
 * 实测事实：服务端 res.limits.writeRateLimitSeconds 自报 45s，但 45s 整的批间
 * 请求会被静默丢弃（预演批次 2/3 踩坑——请求消失但无写入也无错误）。
 * 保守取 65s 留 20s 余量（T4 验证 2026-09-29）。
 */
export const WRITE_COOL_DOWN_MS = 65_000;
/**
 * 写后读回验证前的等待（T4，2026-09-30 实测驱动）。
 * 实写响应 res.trains 恒为空数组（成功不回显），与限频静默丢弃不可区分——
 * 必须写后用 full 模式读回验证。写→读的限频关系未实测，保守等 15s 再读；
 * 若读回仍被限频则批次落定 uncertain（人工到 App 核实，绝不自动重写）。
 */
export const WRITE_VERIFY_DELAY_MS = 15_000;
/** 三源之③末位兜底：仅当响应解析与 res.limits 缓存都失效（响应结构变化）时使用。 */
export const COOL_DOWN_MS_FALLBACK = 90_000;

/** 同步默认并发（§12.1）：实测按天隔离，串行 ~91s 已够快，取 2 平衡速度与安全。 */
export const SYNC_DEFAULT_CONCURRENCY = 2;

/**
 * 画像 / 分析窗口的周数 —— **全系统唯一来源**。
 * 2026-10 用户定案：12 周太短，改到半年（26 周），用半年内的训练历史刻画画像。
 * 注意：config/default.json 的 analysis.window 与 thresholds.ts 的 THRESHOLD_DEFAULTS.window
 * 都**不是**窗口来源，它们只是历史遗留（全仓库无消费方）。改窗口只改这里。
 */
export const ANALYSIS_WINDOW_WEEKS = 26;
/** 落到 analysis_report.window_preset 的字面量（与上面绑定，别在两处写死）。 */
export const ANALYSIS_WINDOW_PRESET = 'w26';

/**
 * 首次/全量同步的回溯周数。
 * 🔴 必须 ≥ ANALYSIS_WINDOW_WEEKS：分析窗口是「用多少历史刻画画像」，
 *    导入回溯是「能拉回多少历史」。回溯小于窗口时，窗口的后半段永远是空的
 *    —— 实测 2026-10-01：回溯 12 周 + 窗口 26 周，findings/趋势条数零差异，
 *    只有「周均频率」被 26 除成了错数。所以两者绑定为同一个值。
 */
export const SYNC_INITIAL_WEEKS = ANALYSIS_WINDOW_WEEKS;

/** 网络类重试：指数退避起点（对齐读侧冷却 30s）、上限 5 次、单次等待上限 300s（§6.2.2）。 */
export const MAX_RETRY_ATTEMPTS = 5;
export const BACKOFF_BASE_MS = 30_000;
export const BACKOFF_CAP_MS = 300_000;

/** 读侧上限（截断检测用，§6.2.4；写侧 15/20 在 T4 引用，勿混用）。 */
export const MAX_READ_MOVES_PER_TRAIN = 40;
export const MAX_READ_SETS_PER_MOVE = 60;
export const MAX_RESPONSE_BYTES = 196_608;

/** 时长离群值界（§4.1.5：实测区间 19~125 min，取 20/150）。 */
export const OUTLIER_MIN_MINUTES = 20;
export const OUTLIER_MAX_MINUTES = 150;

/** 增量新鲜度（§6.2.3）：近 7 天内 6 小时内不重拉；历史日期 30 天内不重拉。 */
export const FRESHNESS_RECENT_DAYS = 7;
export const FRESHNESS_RECENT_MS = 6 * 60 * 60 * 1000;
export const FRESHNESS_HISTORICAL_MS = 30 * 24 * 60 * 60 * 1000;

/** HTTP 超时默认值。 */
export const HTTP_TIMEOUT_MS_DEFAULT = 20_000;

/** 数据库默认路径（相对项目根；可用 ATP_DB_PATH 覆盖）。 */
export const DB_PATH_DEFAULT = 'data/app.db';
