/**
 * 画像 / 分析窗口的周数 —— 历史入口，**定义已搬到 `server/config/constants.ts`**。
 *
 * 常量清单属于 config/constants.ts（那里写着「关键常量清单，集中管理，禁止散落硬编码」），
 * 这里只做 re-export，保留既有 import 路径不变（analysisService / digest / metrics / 测试都从这里取）。
 *
 * 注意：config/default.json 的 analysis.window 与 thresholds.ts 的 THRESHOLD_DEFAULTS.window
 * 都**不是**窗口来源，它们只是历史遗留（全仓库无消费方）。改窗口只改 constants.ts。
 */
export { ANALYSIS_WINDOW_WEEKS, ANALYSIS_WINDOW_PRESET } from '../config/constants.js';
