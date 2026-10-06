/**
 * 动作名 → 肌群/模式/关节 规则引擎（T2）。
 *
 * 依据：四层优先级 manual > server > rule > segment
 * 与 N1 目录实测（2026-09-29）：
 *   - 官方目录 259 动作 type 100% 覆盖 → L2（server）为主力；
 *   - 目录无 seq 字段 → **L4 序号区间先验作废**（架构 §3.4 的 segment 层不实现）；
 *   - 未匹配目录且规则未命中的名字 → movement_unresolved（不阻断分析）。
 *
 * 本模块只做「纯函数规则匹配」；DB 读写与别名/目录解析在 catalogService。
 */
import type { Db } from '../db/index.js';
import { prepare } from '../db/index.js';

// ---------- 类型 ----------

export interface MuscleContribution {
  code: string;
  role: 'primary' | 'secondary';
  weight: number;
}

export interface JointFlag {
  code: string;
  level: number; // 0~3
}

export interface KeywordRule {
  id: string;
  keywords: string[];
  exclude?: string[];
  muscles: MuscleContribution[];
  pattern: string;
  is_cardio?: boolean;
  is_stretch?: boolean;
  joints?: JointFlag[];
  note?: string;
}

export interface ResolveResult {
  name: string;
  catalogId: number | null;
  catalogName: string | null;
  muscles: MuscleContribution[];
  pattern: string | null;
  isCardio: boolean;
  isStretch: boolean;
  joints: JointFlag[];
  /** 结论来源：catalog=标准名/别名的 movement_muscle_map；rule=关键词规则；none=未识别 */
  source: 'catalog' | 'rule' | 'none';
  /** source=catalog 时的底层来源（manual/server），供 UI 展示置信 */
  detailSource?: 'manual' | 'server';
  /** 命中路径（session_movement.resolve_status 用）：exact=精确标准名，alias=别名表 */
  via?: 'exact' | 'alias';
  matchedRules?: string[];
}

// ---------- 归一化 ----------

/** 名字归一化：小写 + 去空白 + 全角括号转半角（与 movement_catalog.name_norm 一致）。 */
export function normName(s: string): string {
  return s
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/（/g, '(')
    .replace(/）/g, ')');
}

// ---------- 规则加载 ----------

export function loadRulesFromDb(db: Db): KeywordRule[] {
  const rows = prepare(db, 'SELECT value_json FROM app_config WHERE key = ?').all('keyword_rules') as Array<{ value_json: string }>;
  if (rows.length === 0) return [];
  return JSON.parse(rows[0].value_json) as KeywordRule[];
}

// ---------- 关键词规则匹配（纯函数） ----------

/**
 * 有序规则匹配：按数组顺序评估全部规则（可命中多条，多标签设计）。
 * 命中条件：任一 keyword 是名字子串，且任一 exclude 词都不是子串。
 * 合并策略：muscles 按 (code, role) 去重、取更高 weight；joints 取最高 level。
 */
export function matchRules(name: string, rules: KeywordRule[]): {
  muscles: MuscleContribution[];
  pattern: string | null;
  isCardio: boolean;
  isStretch: boolean;
  joints: JointFlag[];
  matchedRules: string[];
} {
  const n = normName(name);
  const muscleMap = new Map<string, MuscleContribution>();
  const jointMap = new Map<string, number>();
  const patterns: string[] = [];
  let isCardio = false;
  let isStretch = false;
  const matchedRules: string[] = [];

  for (const rule of rules) {
    const hit = rule.keywords.some((k) => n.includes(normName(k)));
    if (!hit) continue;
    const excluded = (rule.exclude ?? []).some((x) => n.includes(normName(x)));
    if (excluded) continue;

    matchedRules.push(rule.id);
    if (rule.is_cardio) isCardio = true;
    if (rule.is_stretch) isStretch = true;
    if (rule.pattern) patterns.push(rule.pattern);
    for (const m of rule.muscles) {
      const key = `${m.code}|${m.role}`;
      const prev = muscleMap.get(key);
      if (!prev || m.weight > prev.weight) muscleMap.set(key, { ...m });
    }
    for (const j of rule.joints ?? []) {
      jointMap.set(j.code, Math.max(jointMap.get(j.code) ?? 0, j.level));
    }
  }

  return {
    muscles: [...muscleMap.values()],
    pattern: patterns[0] ?? null, // 首个命中规则的 pattern（有序性即优先级）
    isCardio,
    isStretch,
    joints: [...jointMap.entries()].map(([code, level]) => ({ code, level })),
    matchedRules,
  };
}

// ---------- 综合解析（目录 → 别名 → 规则） ----------

interface CatalogRow { id: number; name: string; is_cardio: number; is_stretch: number }
interface MapRow { muscle_code: string; role: 'primary' | 'secondary'; weight: number; source: string }
interface AliasRow { catalog_id: number }
interface PatternRow { pattern: string }

/**
 * 解析一个动作名：
 *   1) 精确命中 movement_catalog.name_norm → 该 catalog 的 muscle_map（底层 manual > server 已由导入保证）
 *   2) movement_alias.alias_norm → 同 1
 *   3) 关键词规则 → 肌群结论（catalogId=null）
 *   4) 全部未命中 → source='none'（调用方落 movement_unresolved）
 * 不做任何写操作；调用方负责 unresolved/回填。
 */
export function resolveName(db: Db, name: string, rules: KeywordRule[]): ResolveResult {
  const norm = normName(name);

  // 1) 精确目录名
  const byName = prepare(
    db,
    'SELECT id, name, is_cardio, is_stretch FROM movement_catalog WHERE name_norm = ? LIMIT 1',
  ).get(norm) as CatalogRow | undefined;

  // 2) 别名表
  let catalog: CatalogRow | undefined = byName;
  let via: 'exact' | 'alias' = 'exact';
  if (!catalog) {
    const alias = prepare(db, 'SELECT catalog_id FROM movement_alias WHERE alias_norm = ? LIMIT 1')
      .get(norm) as AliasRow | undefined;
    if (alias) {
      catalog = prepare(
        db,
        'SELECT id, name, is_cardio, is_stretch FROM movement_catalog WHERE id = ? LIMIT 1',
      ).get(alias.catalog_id) as CatalogRow | undefined;
      via = 'alias';
    }
  }

  if (catalog) {
    const mapRows = prepare(
      db,
      "SELECT muscle_code, role, weight, source FROM movement_muscle_map WHERE catalog_id = ?",
    ).all(catalog.id) as unknown as MapRow[];
    const patternRow = prepare(
      db,
      'SELECT pattern FROM movement_pattern_map WHERE catalog_id = ? LIMIT 1',
    ).get(catalog.id) as PatternRow | undefined;
    const jointRows = prepare(
      db,
      'SELECT joint_code, stress_level FROM movement_joint_flag WHERE catalog_id = ? AND stress_level > 0',
    ).all(catalog.id) as Array<{ joint_code: string; stress_level: number }>;

    const detailSource = mapRows.some((r) => r.source === 'manual')
      ? ('manual' as const)
      : ('server' as const);

    return {
      name,
      catalogId: catalog.id,
      catalogName: catalog.name,
      muscles: mapRows.map((r) => ({ code: r.muscle_code, role: r.role, weight: r.weight })),
      pattern: patternRow?.pattern ?? null,
      isCardio: catalog.is_cardio === 1,
      isStretch: catalog.is_stretch === 1,
      joints: jointRows.map((r) => ({ code: r.joint_code, level: r.stress_level })),
      source: 'catalog',
      detailSource,
      via,
    };
  }

  // 3) 关键词规则
  const m = matchRules(name, rules);
  if (m.matchedRules.length > 0) {
    return {
      name,
      catalogId: null,
      catalogName: null,
      muscles: m.muscles,
      pattern: m.pattern,
      isCardio: m.isCardio,
      isStretch: m.isStretch,
      joints: m.joints,
      source: 'rule',
      matchedRules: m.matchedRules,
    };
  }

  // 4) 未识别
  return {
    name,
    catalogId: null,
    catalogName: null,
    muscles: [],
    pattern: null,
    isCardio: false,
    isStretch: false,
    joints: [],
    source: 'none',
  };
}
