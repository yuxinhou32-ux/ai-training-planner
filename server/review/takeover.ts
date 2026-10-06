/**
 * 接管起点（Takeover）。
 *
 * 🔴 产品模型：用户**首次使用**时先导入历史训练数据，AI 做一次详尽分析产出训练画像；
 *    历史数据**只进画像、不进复盘**。只有「接管之后」实际按计划练完的周才允许做周复盘。
 *
 * 所以需要一个明确的界碑：**第一个由本软件规划的训练周**（= 首个训练周期的第 1 周）。
 * 它落库在 `app_config['takeover']`，形状 `{ start_week: 'YYYY-MM-DD', set_at: ISO }`。
 *
 * 三条纪律：
 *   ① **单调**：一旦确立永不改变、也不会往后挪 —— 判定的是「从哪一周开始接管」，
 *      后续再开新周期不会把界碑推后。
 *   ② **取小**：界碑取 `min(候选周, 已排过计划的最早周)`。软件可以在建画像之前就先排计划
 *      （首页「生成计划」不要求先有周期），那些周同样是接管范围 —— 只看「下一个待规划的周」
 *      会把它们判成接管前、**永久无法复盘**。
 *   ③ **可回退**：老库（本功能上线前就已有训练周期 / 计划）没有这条配置时，用
 *      `min(MIN(training_cycle.first_week_start), 已排过计划的最早周)` 现推（`source: 'derived'`），
 *      从而不必强制迁移。derived 时刻为空串，不谎报写入时间。
 *
 * ⚠️ 本模块**只直接读表**，不 import cycleService（避免循环导入：
 *    cycleService → takeover 是单向依赖）。
 */
import type { Db } from '../db/index.js';
import { prepare } from '../db/index.js';
import { isoSeconds } from '../util/clock.js';
import { stableStringify } from '../util/json.js';

/** app_config 里的配置键。 */
const KEY = 'takeover';

/** 合法日期形态（与全站 week_start 约定一致）。 */
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export interface TakeoverInfo {
  /** 接管起点：第一个由本软件规划的训练周（YYYY-MM-DD，周起点） */
  start_week: string;
  /** 写入时刻 ISO；derived 时为空串 */
  set_at: string;
  source: 'explicit' | 'derived';
}

/**
 * 软件**实际排过计划**的最早一周：已排过计划（含草稿、已归档）的周里最早的那个。
 *
 * ⚠️ 2026-10-05：**这个函数已不再参与界碑判定**（见 `getTakeover` 的说明 ——
 *    界碑只认训练周期）。保留它是因为「软件什么时候开始排过计划」本身仍是个有用的
 *    事实查询（诊断页/将来做「哪些周只在测试期排过计划」时会用到），且有测试守着。
 *    别再把它接回界面判定，那正是造成「测试计划污染复盘」的原因。
 *
 * 只排除 `cancelled`（用户主动作废的草稿不算排过）。
 */
export function earliestManagedWeek(db: Db): string | null {
  const row = prepare(db, `SELECT MIN(week_start) AS w FROM plan WHERE status != 'cancelled'`).get() as
    | { w: string | null }
    | undefined;
  return row === undefined || row.w === null ? null : row.w;
}

/**
 * 读接管起点：
 *   ① `app_config['takeover'].start_week` 合法 → `source: 'explicit'`；
 *   ② 缺失/非法 → 回退 **训练周期最早的 `first_week_start`**（`source: 'derived'`，`set_at: ''`）；
 *   ③ 没有训练周期 → `null`（尚未接管）。
 *
 * 🔴 2026-10-05 修正界碑判据（用户拍板方案 A）：**只有「开过训练周期」才算接管**。
 *
 * 旧实现是 `min(周期最早周, 已排过计划的最早周)`，把「软件建过一个 plan」当成了接管证据。
 * 实测踩坑：9/29 调试时建过一个 `rule_fallback` 的测试计划（从未成功导入训记、
 * 训记侧零数据），它把界碑钉死成 `2026-09-28` —— 于是复盘页拿这份**测试计划**
 * 去跟用户**真实训练记录**做对比，得出「完成率 200%」「计划下肢实际练上肢」这类
 * 毫无意义的结果。
 *
 * 用户原话：「我还没有使用导入啊……前面的这个计划不是只是为了测试吗？
 * 并没有真的导入到我的训记 APP 里」「真实开始使用之后才加入复盘」。
 *
 * 因此判据收敛为：**排过计划 ≠ 接管**，只有明确开周期（用户主动表示
 * 「接下来由你规划我的训练」）才是界碑。测试期的 plan 不再影响界碑。
 *
 * ⚠️ 「软件可能先排计划、后开周期」不再是问题：那些先排的周会一直等到开周期那天
 *    才被纳入复盘范围（`weekStart >= start_week`），不会永久无法复盘 ——
 *    因为开周期时写下的 `first_week_start` 就是用户认可的第一个规划周。
 */
export function getTakeover(db: Db): TakeoverInfo | null {
  const row = prepare(db, `SELECT value_json FROM app_config WHERE key = ?`).get(KEY) as
    | { value_json: string }
    | undefined;
  if (row !== undefined) {
    try {
      const o = JSON.parse(row.value_json) as { start_week?: unknown; set_at?: unknown };
      if (
        o !== null &&
        typeof o === 'object' &&
        typeof o.start_week === 'string' &&
        DATE_RE.test(o.start_week)
      ) {
        return {
          start_week: o.start_week,
          set_at: typeof o.set_at === 'string' ? o.set_at : '',
          source: 'explicit',
        };
      }
    } catch {
      // JSON 坏了 → 走 derived 回退
    }
  }

  const cycle = prepare(db, `SELECT MIN(first_week_start) AS w FROM training_cycle`).get() as
    | { w: string | null }
    | undefined;
  const w = cycle === undefined ? null : cycle.w;
  if (w === null) return null;
  return { start_week: w, set_at: '', source: 'derived' };
}

/**
 * 确立接管起点 —— **只在 `getTakeover(db) === null` 时写入**（单调，永不后移）；已有则原样返回。
 *
 * ⚠️ 调用时机：必须在训练周期行**插入之前**调用（见 cycleService.openCycle）。
 *    若先插入周期行，derived 回退会立刻读到它，「尚未接管」这个前置条件就不成立了。
 *    两者同在 openCycle 的事务里，写配置与插周期原子生效。
 *
 * ⚠️ 2026-10-05 界碑判据改版后，这里的语义更单纯了：`getTakeover` 只认
 *    ① 显式配置；② 训练周期。**plan 不再参与**（见 getTakeover 的说明）。
 *    所以走到写入分支 ⟺ 库里既无 takeover 配置、也无训练周期 —— 此时
 *    `startWeek` 就是用户开周期时认可的第一个规划周，即界碑。
 */
export function ensureTakeover(db: Db, startWeek: string, nowMs: number = Date.now()): TakeoverInfo {
  const existing = getTakeover(db);
  if (existing !== null) return existing;

  // 不变式：此处 startWeek 即界碑（没有更早的周期可退化，plan 已不参与判定）
  const anchor = startWeek;

  const setAt = isoSeconds(nowMs);
  prepare(
    db,
    `INSERT INTO app_config (key, value_json, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
  ).run(KEY, stableStringify({ start_week: anchor, set_at: setAt }), setAt);

  return { start_week: anchor, set_at: setAt, source: 'explicit' };
}
