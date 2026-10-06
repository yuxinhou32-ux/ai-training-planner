/**
 * 首次使用引导（onboarding）完成位 —— 2026-10-06 新增。
 *
 * 引导本身**不新增任何写入路径**：三步各自复用既有的 `/api/xunji/config`、
 * `/api/goal`、`/api/body`。这里只管一个显式布尔完成位，以及「老用户豁免」迁移。
 *
 * 为什么用显式布尔位、而不是从数据推断（决策见 docs/onboarding-plan.md §3）：
 *  - 靠「个人信息填没填」不行 —— BodyPatch 全部字段可选，填了性别、跳过体重，
 *    下次打开又被判成没引导过；
 *  - 靠「有没有配 Key」不行 —— 新用户只要先摸到设置页配了 Key，就永远看不到引导。
 *
 * 完成位存 `app_config['onboarding_done']`。`SettingsRepo` 已经是通用 KV
 * （`ON CONFLICT(key) DO UPDATE`），不用改 repo，直接用。
 */
import type { Db } from '../db/index.js';
import { prepare } from '../db/index.js';
import { SettingsRepo } from '../repo/settingsRepo.js';

/** app_config 里的完成位键名。服务端路由、启动迁移、测试都引用它，避免各写各的字面量。 */
export const ONBOARDING_KEY = 'onboarding_done';

/** 与 GoalServiceError / XunjiConfigError 同款：携带状态码，路由层翻成 HttpError。 */
export class OnboardingError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** 完成位是否已置位：只有**显式 true** 才算完成（缺键、null、false 一律视为未完成）。 */
export function isOnboardingDone(db: Db): boolean {
  return new SettingsRepo(db).getJson(ONBOARDING_KEY) === true;
}

/**
 * 校验 PUT 入参：**只接受 `{ done: true }`**。
 *
 * 🔴 拒绝 `done: false` 是刻意的：完成位一旦置位就不该被回退 ——
 *    否则一次误传就会让用户「每开一次都弹」。要重新看引导，走设置页的
 *    「重新运行首次引导」入口（前端本地强制打开，不改服务端状态）。
 */
export function validateOnboardingPatch(body: unknown): { done: true } {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new OnboardingError(400, '请求体必须是 JSON 对象');
  }
  if ((body as Record<string, unknown>).done !== true) {
    throw new OnboardingError(400, '只接受 done: true —— 已完成状态不可回退');
  }
  return { done: true };
}

/** 置完成位。 */
export function markOnboardingDone(db: Db, nowMs?: number): void {
  new SettingsRepo(db).setJson(ONBOARDING_KEY, true, nowMs);
}

/**
 * 老用户豁免迁移（开机时跑一次）。
 *
 * 光有显式完成位不够：现有库里没有这个键，若只判 `=== true` 才不弹，
 * 升级当天老用户会被弹一次。所以在启动编排里补一道迁移：
 *
 *   完成位键不存在 **且** 库里已有生效 goal  →  补种 done = true
 *
 * 判据用现成先例（`server/plan/resetService.ts:150`）：
 *   `SELECT COUNT(*) AS n FROM user_goal WHERE is_active = 1`
 *
 * 为什么 goal 是可靠的「老用户」标志：`user_goal` 是历史表（写入 = INSERT 新行 +
 * 旧行 is_active=0），但**永远至少有一条 is_active=1**；而「清空计划」功能明确
 * **不删** user_goal —— 即使用户清空过计划，判据依然成立。
 *
 * @returns 本次是否补种了完成位（供启动日志观察）
 */
export function seedOnboardingForExistingUsers(db: Db): boolean {
  // 「键不存在」必须查原表，不能用 getJson（getJson 无法区分「缺键」与「值为 null」）
  const exists =
    prepare(db, `SELECT 1 AS one FROM app_config WHERE key = ? LIMIT 1`).get(ONBOARDING_KEY) !== undefined;
  if (exists) return false;

  const row = prepare(db, `SELECT COUNT(*) AS n FROM user_goal WHERE is_active = 1`).get() as
    | { n: number }
    | undefined;
  if (row === undefined || Number(row.n) <= 0) return false;

  markOnboardingDone(db);
  return true;
}
