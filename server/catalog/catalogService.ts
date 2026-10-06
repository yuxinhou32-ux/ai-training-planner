/**
 * 动作目录导入与映射装配（T2）。
 *
 * 数据源（N1 实测，2026-09-29）：POST /api_movement_catalog_for_llm_v2
 *   → { res: { schema:'movement_catalog_v1', version, movements:[{name,type,exetype,aliases}] } }
 *   官方 259 动作、type 100% 覆盖（14 取值）、无序号字段（L4 区间先验作废）、aliases 为空。
 *
 * 导入内容：
 *   1. movement_catalog        ← 目录（seq_no 按数组序赋 1..N；segment_code 不再使用）
 *   2. muscle_group            ← seeds/muscle_groups.json（18 肌群）
 *   3. server_type_map         ← seeds/server_type_map.json + 目录 type 派生 movement_muscle_map(source='server')
 *   4. movement_muscle_map     ← server 行 + seeds/manual_map_seed.json 覆盖（manual 物理替换 server 行）
 *   5. movement_pattern_map    ← server_type_map.pattern_hint（source='rule'）
 *   6. movement_alias          ← seeds/alias_seed.json（source='auto'）
 *   7. session_movement 回填   ← resolveName 逐条 UPDATE catalog_id / is_cardio / is_stretch
 *   8. movement_unresolved     ← 解析失败的原始名（hit_count 累计）
 *
 * 幂等：全部 UPSERT / 先删后插，重复执行无副作用（§3.1）。
 * 红线：本模块绝不发起网络请求；在线刷新目录由调用方（reader）负责取数后传入。
 */
import fs from 'node:fs';
import type { Db } from '../db/index.js';
import { prepare } from '../db/index.js';
import { normName, resolveName, loadRulesFromDb, type KeywordRule, type MuscleContribution, type JointFlag } from './ruleEngine.js';

// ---------- 目录文件结构（seeds/catalog_seed.json，源自探针 catalog_probe.json） ----------

export interface CatalogMovement {
  name: string;
  type: string;
  exetype: string;
  aliases: string[];
}
export interface CatalogFile {
  empty: { body: { res: { schema: string; version: number; movements: CatalogMovement[] } } };
}

/** 目录导入时跳过肌群映射的特殊 type（肌群不定/不计训练量）。 */
const UNMAPPED_TYPES = new Set(['全身', '自重', '计时动作']);

const nowIso = () => new Date().toISOString();

// ---------- 1+2+3. 目录与基础 seed ----------

export function importCatalog(db: Db, catalogFile: CatalogFile): { catalogCount: number; serverMapRows: number } {
  const movements = catalogFile.empty.body.res.movements;
  if (!Array.isArray(movements) || movements.length === 0) throw new Error('目录文件为空或结构不符');

  const insCatalog = prepare(db, `
    INSERT INTO movement_catalog (id, seq_no, name, name_norm, segment_code, is_cardio, is_stretch, created_at)
    VALUES (NULL, ?, ?, ?, NULL, ?, ?, ?)
    ON CONFLICT(name) DO UPDATE SET seq_no = excluded.seq_no, name_norm = excluded.name_norm
  `);
  const getCatalogId = prepare(db, 'SELECT id FROM movement_catalog WHERE name = ?');
  const getMapRow = prepare(db, 'SELECT id FROM movement_muscle_map WHERE catalog_id = ? AND muscle_code = ? AND role = ?');
  const insMap = prepare(db, `
    INSERT INTO movement_muscle_map (catalog_id, muscle_code, role, weight, source, confidence, confirmed, updated_at)
    VALUES (?, ?, ?, ?, 'server', 'high', 0, ?)
    ON CONFLICT(catalog_id, muscle_code, role) DO UPDATE SET
      weight = excluded.weight, source = 'server', confidence = 'high', updated_at = excluded.updated_at
  `);
  const delServerMap = prepare(db, "DELETE FROM movement_muscle_map WHERE catalog_id = ? AND source = 'server'");
  const insPattern = prepare(db, `
    INSERT INTO movement_pattern_map (catalog_id, pattern, is_unilateral, source, confidence, updated_at)
    VALUES (?, ?, 0, 'rule', 'high', ?)
    ON CONFLICT(catalog_id, pattern) DO NOTHING
  `);
  const getServerTypeMap = prepare(db, 'SELECT server_type, muscle_code, role, weight, pattern_hint FROM server_type_map');
  const typeMapRows = getServerTypeMap.all() as Array<{
    server_type: string; muscle_code: string; role: 'primary' | 'secondary'; weight: number; pattern_hint: string | null;
  }>;
  const typeToMap = new Map(typeMapRows.map((r) => [r.server_type, r]));

  let serverMapRows = 0;
  let seq = 0;
  for (const m of movements) {
    seq += 1;
    // 目录 type='有氧' → is_cardio；目录无独立拉伸 type，按 exetype==='stretch' 判定
    const isCardio = m.type === '有氧' || m.exetype === 'cardio' ? 1 : 0;
    const isStretch = m.exetype === 'stretch' ? 1 : 0;
    insCatalog.run(seq, m.name, normName(m.name), isCardio, isStretch, nowIso());

    const idRow = getCatalogId.get(m.name) as { id: number };
    const catalogId = idRow.id;

    // 特殊 type 不给肌群结论（肌群不定/不计训练量），交给规则层或 unknown
    if (UNMAPPED_TYPES.has(m.type)) continue;

    const tm = typeToMap.get(m.type);
    if (!tm) continue; // 未知 type 留待人工（不猜测）
    delServerMap.run(catalogId);
    insMap.run(catalogId, tm.muscle_code, tm.role, tm.weight, nowIso());
    serverMapRows += 1;
    if (tm.pattern_hint && tm.pattern_hint !== 'other') {
      insPattern.run(catalogId, tm.pattern_hint, nowIso());
    }
  }

  return { catalogCount: seq, serverMapRows };
}

/** 导入肌群字典（muscle_group）。两步写入：先插行（parent 置空）再补父引用，规避自引用外键顺序问题。 */
export function importMuscleGroups(db: Db, groups: Array<{ code: string; name_zh: string; parent_code: string | null; region: string; size: string; sort_no: number }>): void {
  const ins = prepare(db, `
    INSERT INTO muscle_group (code, name_zh, parent_code, region, size, sort_no)
    VALUES (?, ?, NULL, ?, ?, ?)
    ON CONFLICT(code) DO UPDATE SET name_zh = excluded.name_zh,
      region = excluded.region, size = excluded.size, sort_no = excluded.sort_no
  `);
  const updParent = prepare(db, 'UPDATE muscle_group SET parent_code = ? WHERE code = ?');
  for (const g of groups) ins.run(g.code, g.name_zh, g.region, g.size, g.sort_no);
  for (const g of groups) {
    if (g.parent_code !== null) updParent.run(g.parent_code, g.code); // 自引用（chest→chest）合法：行已存在
  }
}

/** 导入 server_type_map 种子（必须先于 importCatalog 调用）。 */
export function importServerTypeMap(
  db: Db,
  rows: Array<{ server_type: string; muscle_code: string; role: string; weight: number; pattern_hint: string | null; note: string }>,
): void {
  const ins = prepare(db, `
    INSERT INTO server_type_map (server_type, muscle_code, role, weight, pattern_hint, note, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(server_type, muscle_code) DO UPDATE SET
      role = excluded.role, weight = excluded.weight, pattern_hint = excluded.pattern_hint,
      note = excluded.note, updated_at = excluded.updated_at
  `);
  for (const r of rows) ins.run(r.server_type, r.muscle_code, r.role, r.weight, r.pattern_hint, r.note, nowIso());
}

// ---------- 4. manual 覆盖 ----------

/**
 * 应用 manual 覆盖表：按 name 定位 catalog，删除该 catalog 的 server/manual 旧行后插入 manual 行。
 * 语义（MVP）：seed 是唯一事实源，重跑幂等；用户 UI 校正（T5）落地时再引入「不覆盖用户修改」逻辑。
 */
export function applyManualMap(db: Db, items: Array<{ name: string; muscles: MuscleContribution[] }>): { applied: number; missing: string[] } {
  const getId = prepare(db, 'SELECT id FROM movement_catalog WHERE name = ?');
  const delAuto = prepare(db, "DELETE FROM movement_muscle_map WHERE catalog_id = ? AND source IN ('server','manual')");
  const ins = prepare(db, `
    INSERT INTO movement_muscle_map (catalog_id, muscle_code, role, weight, source, confidence, confirmed, updated_at)
    VALUES (?, ?, ?, ?, 'manual', 'high', 1, ?)
  `);
  const insPattern = prepare(db, `
    INSERT INTO movement_pattern_map (catalog_id, pattern, is_unilateral, source, confidence, updated_at)
    VALUES (?, ?, 0, 'manual', 'high', ?)
    ON CONFLICT(catalog_id, pattern) DO NOTHING
  `);

  let applied = 0;
  const missing: string[] = [];
  for (const item of items) {
    const row = getId.get(item.name) as { id: number } | undefined;
    if (!row) { missing.push(item.name); continue; }
    delAuto.run(row.id);
    for (const m of item.muscles) {
      ins.run(row.id, m.code, m.role, m.weight, nowIso());
      applied += 1;
    }
    // manual 覆盖时按主贡献推导 pattern（首个 primary 的常识映射在 seed 中通过 pattern_hint 已给，manual 只补特殊）
  }
  return { applied, missing };
}

// ---------- 5. 别名 ----------

export function applyAliasSeed(db: Db, items: Array<{ alias: string; catalog_name: string }>): { applied: number; missing: string[] } {
  const getCatalogId = prepare(db, 'SELECT id FROM movement_catalog WHERE name = ?');
  const ins = prepare(db, `
    INSERT INTO movement_alias (alias_norm, catalog_id, source, created_at)
    VALUES (?, ?, 'auto', ?)
    ON CONFLICT(alias_norm) DO UPDATE SET catalog_id = excluded.catalog_id
  `);
  let applied = 0;
  const missing: string[] = [];
  for (const it of items) {
    const row = getCatalogId.get(it.catalog_name) as { id: number } | undefined;
    if (!row) { missing.push(`${it.alias} → ${it.catalog_name}`); continue; }
    ins.run(normName(it.alias), row.id, nowIso());
    applied += 1;
  }
  return { applied, missing };
}

// ---------- 6. 关键词规则入库 ----------

export function storeKeywordRules(db: Db, rules: KeywordRule[]): void {
  prepare(db, `
    INSERT INTO app_config (key, value_json, updated_at)
    VALUES ('keyword_rules', ?, ?)
    ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at
  `).run(JSON.stringify(rules), nowIso());
}

// ---------- 7+8. 回填与未识别清单 ----------

export interface BackfillStats {
  total: number;
  resolved: number;
  byRule: number;
  unresolved: number;
  distinctUnresolved: number;
}

/** 对 session_movement 全量回填 catalog_id / resolve_status / is_cardio / is_stretch；失败名落 movement_unresolved。 */
export function backfillSessionMovements(db: Db): BackfillStats {
  const rules = loadRulesFromDb(db);
  if (rules.length === 0) throw new Error('keyword_rules 未入库，请先运行 storeKeywordRules');

  const rows = prepare(db, `
    SELECT sm.id, sm.name_raw, sm.name_norm, sm.catalog_id
    FROM session_movement sm
    ORDER BY sm.id
  `).all() as Array<{ id: number; name_raw: string; name_norm: string; catalog_id: number | null }>;

  const upd = prepare(db, `
    UPDATE session_movement
    SET catalog_id = ?, resolve_status = ?, is_cardio = ?, is_stretch = ?
    WHERE id = ?
  `);
  const insUnresolved = prepare(db, `
    INSERT INTO movement_unresolved (name_raw, name_norm, hit_count, first_seen, last_seen, status)
    VALUES (?, ?, ?, ?, ?, 'open')
    ON CONFLICT(name_raw) DO UPDATE SET
      hit_count = excluded.hit_count, last_seen = excluded.last_seen
  `);

  const clearUnresolved = prepare(db, "UPDATE movement_unresolved SET status = 'resolved', resolved_at = ? WHERE name_raw = ? AND status = 'open'");

  // 预统计每个原始名的实际出现次数（hit_count = 真实条目数，跨批重跑幂等）
  const countRows = prepare(db, `
    SELECT name_raw, COUNT(*) AS c FROM session_movement GROUP BY name_raw
  `).all() as Array<{ name_raw: string; c: number }>;
  const countByName = new Map(countRows.map((r) => [r.name_raw, Number(r.c)]));

  const stats: BackfillStats = { total: rows.length, resolved: 0, byRule: 0, unresolved: 0, distinctUnresolved: 0 };
  const unresolvedSeen = new Set<string>();
  const today = nowIso();

  for (const r of rows) {
    // name_norm 已归一化；resolveName 内部 normName 幂等，直接传 name_raw 保留原始信息
    const res = resolveName(db, r.name_raw, rules);
    if (res.source === 'none') {
      stats.unresolved += 1;
      const key = r.name_raw;
      if (!unresolvedSeen.has(key)) {
        unresolvedSeen.add(key);
        stats.distinctUnresolved += 1;
        insUnresolved.run(r.name_raw, r.name_norm, countByName.get(r.name_raw) ?? 1, today, today);
      }
      continue;
    }
    const status = res.source === 'rule' ? 'rule' : res.via === 'alias' ? 'alias' : 'exact';
    upd.run(res.catalogId, status, res.isCardio ? 1 : 0, res.isStretch ? 1 : 0, r.id);
    stats.resolved += 1;
    if (res.source === 'rule') stats.byRule += 1;
    if (res.catalogId !== null) clearUnresolved.run(today, r.name_raw);
  }
  return stats;
}

// ---------- 一键装配 ----------

export interface ImportAllInput {
  catalogFile: CatalogFile;
  muscleGroups: Array<{ code: string; name_zh: string; parent_code: string | null; region: string; size: string; sort_no: number }>;
  serverTypeMap: Array<{ server_type: string; muscle_code: string; role: string; weight: number; pattern_hint: string | null; note: string }>;
  keywordRules: KeywordRule[];
  manualMap: Array<{ name: string; muscles: MuscleContribution[] }>;
  aliases: Array<{ alias: string; catalog_name: string }>;
}

export interface ImportAllResult {
  catalogCount: number;
  serverMapRows: number;
  manualApplied: number;
  manualMissing: string[];
  aliasApplied: number;
  aliasMissing: string[];
  backfill: BackfillStats;
}

/** 顺序装配（幂等）：肌群字典 → server_type_map → 目录 → manual → alias → 规则 → 回填。 */
export function importAll(db: Db, input: ImportAllInput): ImportAllResult {
  importMuscleGroups(db, input.muscleGroups);
  importServerTypeMap(db, input.serverTypeMap);
  const { catalogCount, serverMapRows } = importCatalog(db, input.catalogFile);
  const manual = applyManualMap(db, input.manualMap);
  const alias = applyAliasSeed(db, input.aliases);
  storeKeywordRules(db, input.keywordRules);
  const backfill = backfillSessionMovements(db);
  return {
    catalogCount,
    serverMapRows,
    manualApplied: manual.applied,
    manualMissing: manual.missing,
    aliasApplied: alias.applied,
    aliasMissing: alias.missing,
    backfill,
  };
}

/**
 * 从 seeds/ 读取全部输入（CLI 与测试共用）。
 *
 * 目录文件默认取 `<seedsDir>/catalog_seed.json`（随仓库提供的种子，公开可克隆）；
 * 第二参可选，仅在需要覆盖时传入显式路径：
 *  - 不写死为字面量 'seeds/catalog_seed.json'，否则调用方传了自定义 seedsDir 时会指向错地方；
 *  - 回落采用 `${seedsDir}/catalog_seed.json`，跟随 seedsDir 变化。
 */
export function loadSeeds(seedsDir = 'seeds', catalogPath?: string): ImportAllInput {
  const read = <T>(f: string): T => JSON.parse(fs.readFileSync(`${seedsDir}/${f}`, 'utf8')) as T;
  const catPath = catalogPath ?? `${seedsDir}/catalog_seed.json`;
  if (!fs.existsSync(catPath)) {
    // 明确报错而非裸 ENOENT：该文件随仓库提供，缺失说明仓库不完整（不会静默返回空目录）。
    throw new Error(
      `动作目录种子文件缺失：${catPath}\n` +
        '它是随仓库提供的种子文件（训记公开动作目录，259 条），并非本机 data/probe/ 的产物。\n' +
        '恢复方式：在项目根目录执行 cp data/probe/catalog_probe.json seeds/catalog_seed.json\n' +
        '（data/probe/ 已被 .gitignore 忽略；公开仓库只以 seeds/catalog_seed.json 为准）。',
    );
  }
  const cat = JSON.parse(fs.readFileSync(catPath, 'utf8')) as CatalogFile;
  return {
    catalogFile: cat,
    muscleGroups: read('muscle_groups.json'),
    serverTypeMap: read('server_type_map.json'),
    keywordRules: read('keyword_rules.json'),
    manualMap: read<{ items: Array<{ name: string; muscles: MuscleContribution[] }> }>('manual_map_seed.json').items,
    aliases: read<{ items: Array<{ alias: string; catalog_name: string }> }>('alias_seed.json').items,
  };
}

// 类型再导出（供 CLI/测试使用）
export type { MuscleContribution, JointFlag, KeywordRule };
