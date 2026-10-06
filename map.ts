/**
 * npm run map — 动作目录导入 + 映射装配 + 回填（T2 CLI）。
 *
 * 步骤：migrate → 读 seeds/（含 seeds/catalog_seed.json）→ importAll → 覆盖率报告。
 * 幂等：重复执行无副作用。
 */
import { openDatabase } from './server/db/index.js';
import { migrate } from './server/db/migrate.js';
import { importAll, loadSeeds } from './server/catalog/catalogService.js';
import { resolveName, loadRulesFromDb } from './server/catalog/ruleEngine.js';
import { prepare } from './server/db/index.js';
import type { Db } from './server/db/index.js';

const DB_FILE = 'data/app.db';

function main(): void {
  const db: Db = openDatabase(DB_FILE);
  const mig = migrate(db);
  console.log(`[migrate] applied=${mig.applied} version=${mig.currentVersion}`);

  const seeds = loadSeeds();
  const result = importAll(db, seeds);
  console.log(`[catalog] 导入目录 ${result.catalogCount} 个动作，server 映射 ${result.serverMapRows} 行`);
  console.log(`[manual] 覆盖 ${result.manualApplied} 行${result.manualMissing.length ? `，缺失目标: ${result.manualMissing.join('、')}` : ''}`);
  console.log(`[alias] 挂靠 ${result.aliasApplied} 条${result.aliasMissing.length ? `，缺失目标: ${result.aliasMissing.join('、')}` : ''}`);
  const bf = result.backfill;
  console.log(`[backfill] 共 ${bf.total} 条动作条目：目录/别名解析 ${bf.resolved - bf.byRule}，规则解析 ${bf.byRule}，未识别 ${bf.unresolved}（去重 ${bf.distinctUnresolved}）`);

  // 覆盖率报告：48 个实测动作名的解析路径分布
  const rules = loadRulesFromDb(db);
  const nameCount = new Map<string, number>(
    (prepare(db, 'SELECT name_raw, COUNT(*) AS c FROM session_movement GROUP BY name_raw').all() as Array<{ name_raw: string; c: number }>)
      .map((r) => [r.name_raw, Number(r.c)]),
  );
  const dist = { catalog: 0, alias: 0, rule: 0, none: 0 };
  const unresolvedList: string[] = [];
  for (const [name] of nameCount) {
    const res = resolveName(db, name, rules);
    if (res.source === 'catalog') dist[res.via === 'alias' ? 'alias' : 'catalog'] += 1;
    else if (res.source === 'rule') dist.rule += 1;
    else { dist.none += 1; unresolvedList.push(name); }
  }
  const total = nameCount.size;
  console.log(`\n[覆盖率] ${total} 个去重动作名：精确目录 ${dist.catalog} / 别名 ${dist.alias} / 规则 ${dist.rule} / 未识别 ${dist.none}`);
  if (unresolvedList.length) console.log(`[未识别] ${unresolvedList.join('、')}`);
  const coverage = ((total - dist.none) / total) * 100;
  console.log(`[覆盖率] ${(coverage).toFixed(1)}%（R-AG-14 告警线：未识别有效组占比 ≥10%）`);
}

main();
