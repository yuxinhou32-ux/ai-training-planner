/**
 * npm run analyze — 分析引擎 CLI（T2）。
 *
 * 用法：
 *   node dist/analyze.js [--out report.json] [--dry] [--ensure-default-goal]
 *
 *   --out <file>          把报告 payload 另存为 JSON 文件（落库仍会执行，除非 --dry）
 *   --dry                 只算不落库（analysis_report 不插入）
 *   --ensure-default-goal 若无激活目标则写入默认训练基础（减脂保肌 / 周一三五日 / 60–90min），
 *                         该目标会作为 constraints.goal 传给 AI 教练。
 *                         注意：正常入口是「设置 → 训练基础」，这里只是首次开库的兜底。
 *
 * 退出码 0 = 成功（含有 findings）；仅 SQL/校验异常非 0。
 */
import { writeFileSync } from 'node:fs';
import { openDatabase, closeDatabase, type Db } from './server/db/index.js';
import { migrate } from './server/db/migrate.js';
import { runAnalysis } from './server/analysis/analysisService.js';
import { loadConfig } from './server/config/index.js';
import { prepare, inTransaction } from './server/db/index.js';

/**
 * 兜底种子。参数必须与设置页默认值一致（PRD-v2 §12.1）：
 *   4 天 = 4 次/周（次数由训练日数量推导，不再单独写 4）
 *   60~90 分钟（用户口述「一个小时到一个半小时」）
 *   preferred_dows 按周起点（周一）的时间顺序排列：周一 → 周三 → 周五 → 周日
 */
function ensureDefaultGoal(db: Db): boolean {
  const existing = prepare(db, 'SELECT id FROM user_goal WHERE is_active = 1 LIMIT 1').get();
  if (existing) return false;
  const now = new Date().toISOString();
  const today = new Date().toISOString().slice(0, 10);
  inTransaction(db, () => {
    prepare(
      db,
      `INSERT INTO user_goal
       (goal_type, sessions_per_week, min_duration_min, max_duration_min, week_start_dow, preferred_dows, notes, is_active, effective_from, created_at)
       VALUES ('减脂保肌', 4, 60, 90, 1, '[1,3,5,0]', '初始默认值，可在「设置 → 训练基础」修改', 1, ?, ?)`,
    ).run(today, now);
  });
  return true;
}

function main(): void {
  const args = process.argv.slice(2);
  let outFile: string | null = null;
  let dry = false;
  let ensureGoal = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--out') outFile = args[++i] ?? null;
    else if (args[i] === '--dry') dry = true;
    else if (args[i] === '--ensure-default-goal') ensureGoal = true;
  }

  const cfg = loadConfig();
  const db: Db = openDatabase(cfg.dbPath);
  try {
    const mig = migrate(db);
    console.log(`[migrate] version=${mig.currentVersion} applied=${mig.applied}`);

    if (ensureGoal) {
      const seeded = ensureDefaultGoal(db);
      console.log(seeded ? '[goal] 已写入默认训练基础：减脂保肌 / 周一三五日 / 60–90 分钟' : '[goal] 已存在激活目标，跳过');
    }

    const { report, reportId } = runAnalysis(db, { persist: !dry });
    if (dry) console.log('[dry] 未落库');

    const w = report.window;
    console.log(`\n[window] ${w.trend_start} ~ ${w.trend_end}（${w.weeks} 周）`);
    const b = report.basic_stats;
    console.log(
      `[basic] 训练 ${b.total_sessions} 次（${b.sessions_per_week}/周），时长中位 ${b.duration_median_min ?? '—'} min，有效组 ${b.total_effective_sets}`,
    );
    const q = report.data_quality;
    console.log(
      `[quality] duration=${q.duration_coverage} unmapped=${q.unmapped_set_ratio} 离群剔除 ${q.excluded_outliers?.length ?? 0} 天`,
    );
    console.log(`[trends] 动作 ${report.movement_trends.length} 个 / 肌群 ${report.muscle_trends.length} 个 / 候选池 ${report.candidate_pool.length}`);
    if (report.findings.length === 0) {
      console.log('[findings] 无');
    } else {
      console.log('[findings]');
      for (const f of report.findings) {
        console.log(`  - ${f.code} (${f.severity}) ${f.title}`);
      }
    }
    console.log(`[report] id=${reportId ?? '—'} hash 落库`);

    if (outFile && reportId !== null) {
      writeFileSync(outFile, JSON.stringify(report, null, 2), 'utf8');
      console.log(`[out] 已写入 ${outFile}`);
    }
  } finally {
    closeDatabase(db);
  }
}

main();
