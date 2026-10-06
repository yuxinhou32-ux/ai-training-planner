#!/usr/bin/env node
/**
 * 行数对账 CLI（T1 验收）。
 *
 * 三方核对：
 *   A. probe 落盘原始数据（data/probe/*.json，§5 表格来源）
 *   B. 解析器对同一批原始数据的解析计数（验证解析器与探针口径一致）
 *   C. 数据库 train_session / session_movement / movement_set 实际行数
 *
 * 验收基线（docs/probe-report.md）：train 31 / movement 214 / set 912。
 * 用法：node dist/reconcile.js [--db PATH] [--probe-dir DIR] [--days N] [--per-day]
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { loadEnvFile } from './server/config/env.js';
import { loadConfig } from './server/config/index.js';
import { closeDatabase, openDatabase } from './server/db/index.js';
import { migrate } from './server/db/migrate.js';
import { TrainRepo } from './server/repo/trainRepo.js';
import { parseDay, flattenSets } from './server/ingest/parser.js';
import { isValidDateStr, todayStr, shiftDays } from './server/util/dates.js';
import type { ResBody } from './server/xunji/types.js';

interface CliOpts {
  dbPath: string | null;
  probeDir: string;
  days: number;
  perDay: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): CliOpts {
  const opts: CliOpts = { dbPath: null, probeDir: 'data/probe', days: 90, perDay: false, help: false };
  for (const raw of argv) {
    const arg = raw.replace(/^--/, '');
    const eq = arg.indexOf('=');
    const key = (eq >= 0 ? arg.slice(0, eq) : arg).toLowerCase();
    const val = eq >= 0 ? arg.slice(eq + 1) : undefined;
    switch (key) {
      case 'db':
        opts.dbPath = val ?? null;
        break;
      case 'probe-dir':
        opts.probeDir = val ?? 'data/probe';
        break;
      case 'days':
        opts.days = Math.max(1, Math.min(365, Number(val ?? 90) || 90));
        break;
      case 'per-day':
        opts.perDay = true;
        break;
      case 'h':
      case 'help':
        opts.help = true;
        break;
      default:
        throw new Error(`未知参数：--${key}`);
    }
  }
  return opts;
}

interface ProbeDayCounts {
  datestr: string;
  trains: number;
  movements: number;
  sets: number;
}

/** 递归数组（含超级组 items 子项 —— 与解析器 flattenSets 口径一致）。 */
function countSetsDeep(ss: unknown[]): number {
  let n = 0;
  for (const s of ss) {
    const so = s as Record<string, unknown>;
    n += 1;
    const items = Array.isArray(so.items) ? so.items : [];
    n += countSetsDeep(items);
  }
  return n;
}

/** 直接数 probe JSON 的原始结构（不经过解析器 —— 作为独立口径）。 */
function countRaw(res: ResBody): { trains: number; movements: number; sets: number } {
  const trains = Array.isArray(res.trains) ? res.trains : [];
  let movements = 0;
  let sets = 0;
  for (const t of trains) {
    const o = t as Record<string, unknown>;
    const ms = Array.isArray(o.movements) ? o.movements : [];
    movements += ms.length;
    for (const m of ms) {
      const mo = m as Record<string, unknown>;
      const ss = Array.isArray(mo.sets) ? mo.sets : [];
      sets += countSetsDeep(ss);
    }
  }
  return { trains: trains.length, movements, sets };
}

async function main(): Promise<number> {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log('用法：node dist/reconcile.js [--db PATH] [--probe-dir DIR] [--days N] [--per-day]');
    return 0;
  }
  loadEnvFile(process.cwd());
  const config = loadConfig(undefined, process.cwd());
  if (opts.dbPath !== null) config.dbPath = opts.dbPath;

  const probeDir = path.resolve(process.cwd(), opts.probeDir);
  if (!existsSync(probeDir)) {
    console.error(`[reconcile] 探针数据目录不存在：${probeDir}`);
    return 2;
  }

  // A+B：probe 原始计数 与 解析器计数
  const files = readdirSync(probeDir).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
  const cutoff = shiftDays(todayStr(), -(opts.days - 1));
  const probeRows: ProbeDayCounts[] = [];
  let parserMismatch = 0;
  for (const f of files) {
    const datestr = f.replace(/\.json$/, '');
    if (datestr < cutoff) continue;
    const envelope = JSON.parse(readFileSync(path.join(probeDir, f), 'utf8')) as {
      res?: ResBody;
    };
    const res = envelope.res ?? ({} as ResBody);
    const raw = countRaw(res);
    const parsed = parseDay(datestr, res);
    // B 口径：解析器计数 = 原始计数 + 超级组子项
    const parserSets = parsed.sessions.reduce(
      (acc, s) => acc + s.movements.reduce((a, m) => a + flattenSets(m.sets).length, 0),
      0,
    );
    if (parsed.counts.trains !== raw.trains || parsed.counts.movements !== raw.movements || parserSets !== raw.sets) {
      parserMismatch += 1;
      console.error(
        `[reconcile] 解析器与原始计数不一致 ${datestr}: raw=${raw.trains}/${raw.movements}/${raw.sets} parsed=${parsed.counts.trains}/${parsed.counts.movements}/${parserSets}`,
      );
    }
    probeRows.push({ datestr, ...raw });
  }

  const probeTotals = probeRows.reduce(
    (acc, r) => ({ trains: acc.trains + r.trains, movements: acc.movements + r.movements, sets: acc.sets + r.sets }),
    { trains: 0, movements: 0, sets: 0 },
  );

  // C：数据库实际行数
  const db = openDatabase(config.dbPath);
  try {
    migrate(db);
    const trainRepo = new TrainRepo(db);
    const dbTotals = trainRepo.counts();

    console.log('==================== 行数对账（T1 验收） ====================');
    console.log('口径                     train       movement       set');
    console.log(
      `probe 落盘(${probeRows.length} 天)   ${String(probeTotals.trains).padStart(6)}   ${String(probeTotals.movements).padStart(10)}   ${String(probeTotals.sets).padStart(8)}`,
    );
    console.log(
      `数据库                   ${String(dbTotals.sessions).padStart(6)}   ${String(dbTotals.movements).padStart(10)}   ${String(dbTotals.sets).padStart(8)}`,
    );
    console.log('基线(probe-report §1)       31           214         912');
    console.log('=============================================================');

    if (opts.perDay) {
      console.log('\n按天明细（probe vs DB）：');
      for (const r of probeRows) {
        const d = trainRepo.countsByDate(r.datestr);
        const mark =
          d.sessions === r.trains && d.movements === r.movements && d.sets === r.sets ? '✓' : '✗';
        console.log(
          `${mark} ${r.datestr}  probe ${String(r.trains).padStart(2)}/${String(r.movements).padStart(3)}/${String(r.sets).padStart(4)}  db ${String(d.sessions).padStart(2)}/${String(d.movements).padStart(3)}/${String(d.sets).padStart(4)}`,
        );
      }
    }

    const okCounts =
      probeTotals.trains === dbTotals.sessions &&
      probeTotals.movements === dbTotals.movements &&
      probeTotals.sets === dbTotals.sets;
    const baselineOk = dbTotals.sessions === 31 && dbTotals.movements === 214 && dbTotals.sets === 912;

    if (parserMismatch > 0) {
      console.error(`\n[reconcile] FAIL：解析器与原始计数不一致（${parserMismatch} 天）`);
      return 1;
    }
    if (!okCounts) {
      console.error('\n[reconcile] FAIL：数据库与 probe 落盘不一致 —— 先查解析器与同步范围');
      return 1;
    }
    if (!baselineOk) {
      console.error('\n[reconcile] WARN：与 probe-report 基线(31/214/912)不一致 —— 若数据窗口不同可忽略');
      return 1;
    }
    console.log('\n[reconcile] PASS：31 / 214 / 912 全部一致 ✓');
    return 0;
  } finally {
    closeDatabase(db);
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((e) => {
    console.error(`[reconcile] 未捕获异常：${(e as Error)?.stack ?? String(e)}`);
    process.exitCode = 1;
  });
