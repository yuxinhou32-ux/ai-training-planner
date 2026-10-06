/**
 * 个人基础信息（体重 + 性别 / 年龄 / 身高 / 训练年限 + 旧伤 / 基础疾病）
 * —— PRD-v2 §10.3 V9，2026-09-30 从「身体信息」扩为「个人基础信息」。
 *
 * 存储刻意分两处（见 `db/schema.ts` v6 注释）：
 *  - **体重**是时序数据（要画趋势图、要按日覆写）→ `weight_log` 表，一行一天。
 *  - **其余都是长期不变的画像字段** → `app_config['body_info']` 里的一份 JSON。
 *    它们没有时序含义（「什么时候写下这句话」对训练没有任何意义），
 *    跟体重挤一张表只会让人误以为它有时效性。
 *
 * 🔴 **`app_config['body_info']` 是「一份 JSON 整体覆写」** —— 每次保存都必须
 *    **先读出来、改掉要给的那个键、再整份写回**（`saveBodyInfo` 里就是这么做的）。
 *    直接 `JSON.stringify({ age })` 会把用户填的旧伤、性别一并抹掉，
 *    而且界面上看起来「只是改了个年龄」，不会有人想到另外几个字段没了。
 *
 * 🔴 这些字段**全部可以留空**（用户定案：「他填了就保存，不填就默认空」）：
 *    留空在库里的表达是 `null` / 空串，进摘要层时也是 `null` ——
 *    对 AI 的信号是「用户没告诉我这件事」，prompt 里明确要求「不许提起、不许追问、不许假设」。
 *
 * 🔴 旧伤只作背景参考 —— 这是本模块最重要的一条约束：
 *    这里**只负责存取**，绝不产出任何「禁用动作 / 降容量 / 过滤候选池」的逻辑
 *    （PRD-v2 §5「旧伤：只作参考，不自动禁用相关动作」）。
 *    它进入 AI 输入的路径**只有一条**：`digest.profile.body`（纯文本），
 *    且 prompt 里明确写了「不得据此禁用动作」。
 *    优先级：本周特殊情况（`daily_note`，会进 `week.special_note`）> 基础疾病。
 */
import { inTransaction, prepare, type Db } from '../db/index.js';
import { isoSeconds } from '../util/clock.js';
import { isValidDateStr, shiftDays, todayStr } from '../util/dates.js';

export class BodyServiceError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'BodyServiceError';
  }
}

/** 体重合理区间（kg）。超出即视为误输入 —— 拦在这里比让趋势图画出 780 kg 强。 */
export const WEIGHT_MIN = 20;
export const WEIGHT_MAX = 400;
/** 旧伤 / 基础疾病文本上限。 */
export const CONDITIONS_MAX_CHARS = 500;
/**
 * 性别（可选，可空）。存中文原样 —— 跟 `goal_type` / `week_note` 一个路子：
 * prompt 里直接可读，不需要维护一张枚举映射表。
 * 只有两个值：留空是「没填」，不设「不愿说」这种第三个选项（默认空本身就能表达）。
 */
export const GENDER_VALUES = ['女', '男'] as const;
/** 训练年限（可选，可空）。它比年龄更能决定「加重该多激进」（新手该巩固、老手该破平台）。 */
export const TRAINING_YEARS_VALUES = ['不到 1 年', '1~3 年', '3 年以上'] as const;
/** 年龄 / 身高的合理区间：只用来拦误输入，不拦「不填」。 */
export const AGE_MIN = 10;
export const AGE_MAX = 100;
export const HEIGHT_MIN = 100;
export const HEIGHT_MAX = 250;
/** 趋势图默认回看天数（约半年，够看长期方向）。 */
export const WEIGHT_HISTORY_DAYS = 180;
/** 摘要层看体重的变化窗口。 */
export const WEIGHT_DELTA_DAYS = 30;

const KEY_BODY_INFO = 'body_info';

export interface WeightPoint {
  datestr: string;
  weight_kg: number;
}

export interface BodyInfo {
  /** 旧伤 / 基础疾病；空串 = 用户没填（设置页的输入框要好编辑，所以这里不用 null）。 */
  conditions: string;
  /** 性别（`女` / `男`）；null = 没填。 */
  gender: string | null;
  /** 年龄；null = 没填。 */
  age: number | null;
  /** 身高（cm）；null = 没填。 */
  height_cm: number | null;
  /** 训练年限（`不到 1 年` / `1~3 年` / `3 年以上`）；null = 没填。 */
  training_years: string | null;
  /** 最新一次体重（按 datestr 取最新，不是按写入时间）。 */
  weight_kg: number | null;
  weight_date: string | null;
  /** 最新一次相对 `WEIGHT_DELTA_DAYS` 天前（窗口内最早一条）的变化；不足两条 → null。 */
  delta_30d_kg: number | null;
  /** 上面这些字段最后一次写入时间（ISO 秒精度）。 */
  updated_at: string | null;
}

/**
 * `app_config['body_info']` 里那份 JSON 的形状。
 *
 * 🔴 保存时必须**按它读-改-写整份覆写**，不能只写要改的那个键：
 *    `JSON.stringify({ age })` 会把旧伤、性别一起抹掉，而界面上看起来只是改了年龄。
 */
export interface BodyMeta {
  conditions: string;
  gender: string | null;
  age: number | null;
  height_cm: number | null;
  training_years: string | null;
}

/** 什么都没填的状态 —— 冷库 / JSON 被手工改坏时都用它兜底。 */
const EMPTY_META: BodyMeta = {
  conditions: '',
  gender: null,
  age: null,
  height_cm: null,
  training_years: null,
};

/** 摘要层要的那一份（字段名与 `digest.profile.body` 一致，省一次映射）。 */
export interface BodyForDigest {
  weight_kg: number | null;
  weight_date: string | null;
  delta_30d_kg: number | null;
  conditions: string | null;
  gender: string | null;
  age: number | null;
  height_cm: number | null;
  training_years: string | null;
}

// ---------------------------------------------------------------------------
// 读写
// ---------------------------------------------------------------------------

interface BodyInfoRow {
  value_json: string;
  updated_at: string;
}

function readBodyMeta(db: Db): { meta: BodyMeta; updatedAt: string | null } {
  const row = prepare(db, 'SELECT value_json, updated_at FROM app_config WHERE key = ?').get(KEY_BODY_INFO) as unknown as
    | BodyInfoRow
    | undefined;
  if (!row) return { meta: { ...EMPTY_META }, updatedAt: null };
  try {
    const parsed = JSON.parse(row.value_json) as Record<string, unknown>;
    return {
      meta: {
        conditions: typeof parsed.conditions === 'string' ? parsed.conditions : '',
        gender: typeof parsed.gender === 'string' && parsed.gender !== '' ? parsed.gender : null,
        age: typeof parsed.age === 'number' && Number.isFinite(parsed.age) ? parsed.age : null,
        height_cm:
          typeof parsed.height_cm === 'number' && Number.isFinite(parsed.height_cm) ? parsed.height_cm : null,
        training_years:
          typeof parsed.training_years === 'string' && parsed.training_years !== ''
            ? parsed.training_years
            : null,
      },
      updatedAt: row.updated_at,
    };
  } catch {
    // 手工改库改坏了不该让整个页面打不开 —— 当成没填
    return { meta: { ...EMPTY_META }, updatedAt: row.updated_at };
  }
}

/**
 * 体重序列（升序）。
 *
 * `days > 0` 时只看最近 N 天（相对 `nowMs` 的**本地**今天）。
 * ⚠️ 窗口左界用「今天 − days」而不是「最后一条记录 − days」：用户三个月没量体重时，
 * 用最后一条做锚会把三个月前的记录全画出来，看起来像「最近一直在量」。
 */
export function listWeights(db: Db, opts: { days?: number; nowMs?: number } = {}): WeightPoint[] {
  const days = opts.days ?? WEIGHT_HISTORY_DAYS;
  const rows = (
    days > 0
      ? prepare(db, 'SELECT datestr, weight_kg FROM weight_log WHERE datestr >= ? ORDER BY datestr ASC').all(
          shiftDays(todayStr(opts.nowMs ?? Date.now()), -days),
        )
      : prepare(db, 'SELECT datestr, weight_kg FROM weight_log ORDER BY datestr ASC').all()
  ) as unknown as Array<{ datestr: string; weight_kg: number }>;
  return rows.map((r) => ({ datestr: r.datestr, weight_kg: r.weight_kg }));
}

/**
 * 最新一次体重 相对 变化窗口内最早一条 的差值。
 *
 * 只有一条记录 → null（无法算变化，不是 0 —— 给 0 会让 AI 以为「最近很平稳」）。
 */
function deltaOver(series: WeightPoint[], days: number): number | null {
  if (series.length < 2) return null;
  const latest = series[series.length - 1]!;
  const from = shiftDays(latest.datestr, -days);
  const base = series.find((p) => p.datestr >= from && p.datestr < latest.datestr);
  if (!base) return null;
  return round1(latest.weight_kg - base.weight_kg);
}

export function getBodyInfo(db: Db, nowMs: number = Date.now()): BodyInfo {
  const { meta, updatedAt } = readBodyMeta(db);
  const series = listWeights(db, { days: 0 });
  const latest = series.length > 0 ? series[series.length - 1]! : null;
  const weightAt = prepare(db, `SELECT MAX(updated_at) AS t FROM weight_log`).get() as unknown as {
    t: string | null;
  };
  return {
    ...meta,
    weight_kg: latest?.weight_kg ?? null,
    weight_date: latest?.datestr ?? null,
    delta_30d_kg: deltaOver(series, WEIGHT_DELTA_DAYS),
    updated_at: maxIso(updatedAt, weightAt?.t ?? null),
  };
}

/**
 * 摘要层入口：只返回 AI 需要的字段，且「没填」统一成 `null`（空串 → null）。
 *
 * 🔴 这一层**不做任何过滤** —— 旧伤、性别、年龄、训练年限都是纯背景参考，
 *    这里没有、也不允许有「据它禁用动作 / 降容量」的逻辑（PRD-v2 §5）。
 */
export function loadBodyForDigest(db: Db, nowMs: number = Date.now()): BodyForDigest {
  const info = getBodyInfo(db, nowMs);
  return {
    weight_kg: info.weight_kg,
    weight_date: info.weight_date,
    delta_30d_kg: info.delta_30d_kg,
    conditions: info.conditions.trim() === '' ? null : info.conditions,
    gender: info.gender,
    age: info.age,
    height_cm: info.height_cm,
    training_years: info.training_years,
  };
}

export interface BodyPatch {
  /** 旧伤 / 基础疾病；空串 = 清空。给 null 等同忽略（用 '' 表达清空）。 */
  conditions?: string;
  /** 性别；`null` 或空串 = 不填（清空）。 */
  gender?: string | null;
  /** 年龄；`null` = 不填（清空）。 */
  age?: number | null;
  /** 身高 cm；`null` = 不填（清空）。 */
  height_cm?: number | null;
  /** 训练年限；`null` 或空串 = 不填（清空）。 */
  training_years?: string | null;
  /** `null` = 删除 `datestr`（或今天）那一条体重记录。 */
  weight_kg?: number | null;
  /** 体重所属日期，默认今天。 */
  datestr?: string;
}

/** `app_config['body_info']` 里允许出现的键（`weight_kg` / `datestr` 走 `weight_log`，不进这一份）。 */
const META_KEYS = ['conditions', 'gender', 'age', 'height_cm', 'training_years'] as const;

/**
 * 部分更新：`META_KEYS` 里给哪个改哪个，`weight_kg` 独立。
 *
 * 「删掉某天的体重」用 `weight_kg: null` + `datestr` 表达（不再单开一个 DELETE 路由）：
 * 把错填的日期删掉与改掉同属一件事，多一个端点不值得。
 * 「清空某个基础信息」用 `null`（文本字段也可用空串）—— 用户把选中的按钮再点一下就是取消选择。
 */
export function saveBodyInfo(db: Db, raw: unknown, nowMs: number = Date.now()): BodyInfo {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new BodyServiceError(400, '请求体必须是对象');
  }
  const body = raw as Record<string, unknown>;
  const has = (k: string): boolean => Object.prototype.hasOwnProperty.call(body, k);

  const hasMeta = META_KEYS.some(has);
  const hasWeight = has('weight_kg');
  if (!hasMeta && !hasWeight) {
    throw new BodyServiceError(400, `没有要更新的字段（${META_KEYS.join(' / ')} / weight_kg 至少要给一个）`);
  }

  const today = todayStr(nowMs);
  const nowIso = isoSeconds(nowMs);

  // 🔴 读-改-写：先取出当前那一份，只覆盖本次给到的键，再整份写回。
  //    写成 JSON.stringify({ age }) 会把用户填的旧伤 / 性别一起抹掉，
  //    而界面上看起来「只是改了个年龄」—— 这种丢数据没人会立刻发现。
  let nextMeta: BodyMeta | null = null;
  if (hasMeta) {
    nextMeta = { ...readBodyMeta(db).meta };
    if (has('conditions')) {
      const c = readConditionsField(body.conditions);
      if (c.length > CONDITIONS_MAX_CHARS) {
        throw new BodyServiceError(
          400,
          `旧伤 / 基础疾病最多 ${CONDITIONS_MAX_CHARS} 字（当前 ${c.length}）`,
        );
      }
      nextMeta.conditions = c;
    }
    if (has('gender')) nextMeta.gender = readEnumField(body.gender, GENDER_VALUES, 'gender');
    if (has('training_years')) {
      nextMeta.training_years = readEnumField(body.training_years, TRAINING_YEARS_VALUES, 'training_years');
    }
    if (has('age')) nextMeta.age = readIntField(body.age, AGE_MIN, AGE_MAX, 'age', '年龄');
    if (has('height_cm')) {
      nextMeta.height_cm = readIntField(body.height_cm, HEIGHT_MIN, HEIGHT_MAX, 'height_cm', '身高');
    }
  }

  let weight: number | null = null;
  let hasWeightWrite = false;
  let datestr = today;
  if (hasWeight) {
    if (body.datestr !== undefined) {
      if (!isValidDateStr(body.datestr)) throw new BodyServiceError(400, `datestr 不合法：${String(body.datestr)}`);
      if (body.datestr > today) throw new BodyServiceError(400, '体重只能记录今天或更早的日期');
      datestr = body.datestr;
    }
    if (body.weight_kg === null) {
      hasWeightWrite = true; // 删除
    } else {
      if (typeof body.weight_kg !== 'number' || !Number.isFinite(body.weight_kg)) {
        throw new BodyServiceError(400, 'weight_kg 必须是数字（或 null 表示删除该天记录）');
      }
      if (body.weight_kg < WEIGHT_MIN || body.weight_kg > WEIGHT_MAX) {
        throw new BodyServiceError(400, `体重必须在 ${WEIGHT_MIN}~${WEIGHT_MAX} kg 之间（收到 ${body.weight_kg}）`);
      }
      weight = round1(body.weight_kg);
      hasWeightWrite = true;
    }
  }

  inTransaction(db, () => {
    if (nextMeta !== null) {
      prepare(
        db,
        `INSERT INTO app_config (key, value_json, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
      ).run(KEY_BODY_INFO, JSON.stringify(nextMeta), nowIso);
    }
    if (hasWeightWrite) {
      if (weight === null) {
        // 幂等：那条本来就不存在也不算错（用户连点两次删除不该报错）
        prepare(db, 'DELETE FROM weight_log WHERE datestr = ?').run(datestr);
      } else {
        prepare(
          db,
          `INSERT INTO weight_log (datestr, weight_kg, created_at, updated_at) VALUES (?, ?, ?, ?)
           ON CONFLICT(datestr) DO UPDATE SET weight_kg = excluded.weight_kg, updated_at = excluded.updated_at`,
        ).run(datestr, weight, nowIso, nowIso);
      }
    }
  });

  return getBodyInfo(db, nowMs);
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

/** `conditions`：必须是字符串；两端空白去掉（只写空白 = 清空）。 */
function readConditionsField(v: unknown): string {
  if (typeof v !== 'string') throw new BodyServiceError(400, 'conditions 必须是字符串');
  return v.trim();
}

/**
 * 可空枚举：`null` / 空串 = 不填（用户把选中的按钮再点一下就是取消选择）。
 *
 * 🔴 白名单之外一律 400：这些值会**原样进 AI 的 prompt**，
 *    放任意字符串进来等于给用户开了一个改写提示词的入口。
 */
function readEnumField(v: unknown, allowed: readonly string[], field: string): string | null {
  if (v === null || v === '') return null;
  if (typeof v !== 'string' || !allowed.includes(v)) {
    throw new BodyServiceError(400, `${field} 只能是 ${allowed.join(' / ')}（或 null 表示不填）`);
  }
  return v;
}

/**
 * 可空整数：`null` / 空串 = 不填。
 *
 * 只要整数不要小数：年龄 30.5、身高 163.7 这种值对排计划没有任何增量信息，
 * 却会让缓存键、去重比较变得没必要地脆弱。
 */
function readIntField(v: unknown, min: number, max: number, field: string, label: string): number | null {
  if (v === null || v === '') return null;
  if (typeof v !== 'number' || !Number.isInteger(v)) {
    throw new BodyServiceError(400, `${field} 必须是整数（或 null 表示不填）`);
  }
  if (v < min || v > max) {
    throw new BodyServiceError(400, `${label}必须在 ${min}~${max} 之间（收到 ${v}）`);
  }
  return v;
}

/** 保留一位小数（体重 77.44 → 77.4）。 */
function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function maxIso(a: string | null, b: string | null): string | null {
  if (a === null) return b;
  if (b === null) return a;
  return a > b ? a : b;
}
