/**
 * 启动编排（v2 精简版）：不做定时调度，只做开机必须的三件事。
 *
 *   1) 复位遗留 running 任务（进程内任务跨重启无效）；
 *   2) 归档过期计划草稿（week_end 已过去 → archived）；
 *   3) 开机同步一次（**首次全量、之后增量**；同步只读训记，不链式落分析报告）。
 *
 * v2 已移除：进程内主调度器（不再有每日/每周定时触发）、启动补跑扫描、
 * 自动化开关与定时锚点——一切流程改为页面上的手动按钮触发。
 * 唯一保留的自动动作是「开机同步一次」，它只读训记、绝不写入。
 */
import type { Db } from '../db/index.js';
import { prepare } from '../db/index.js';
import { pruneReports } from '../analysis/prune.js';
import { JobRepo, type JobType } from '../repo/jobRepo.js';
import { NotificationRepo } from '../repo/notificationRepo.js';
import type { JobRunner } from './runner.js';
import { isoSeconds } from '../util/clock.js';
import { todayStr } from '../util/dates.js';
import { recoverStuckWrites } from '../plan/writeService.js';
import { seedOnboardingForExistingUsers } from '../onboarding/onboardingService.js';

export interface StartupOptions {
  /** 是否在开机时排一次增量同步（未装配训记 Key 时传 false，避免刷出失败任务）。 */
  syncOnStartup: boolean;
}

export interface StartupReport {
  cancelled: number;
  archived: number;
  /** 本次开机恢复的中断写入作业数（上次进程在写入中途被杀 → 置 uncertain，交人工核实）。 */
  stuckWrites: number;
  syncQueued: boolean;
  /** 本次排队的是哪种同步（未排则 null）。 */
  syncJobType: JobType | null;
  /** 本次开机清理掉的历史报告数（保留策略见 analysis/prune.ts）。 */
  pruned: { adhocDeleted: number; snapshotDeleted: number };
  /** 本次是否为老用户补种了引导完成位（true = 升级前就已有 goal，豁免首次引导弹窗）。 */
  onboardingSeeded: boolean;
}

/**
 * 是否已经做过一次**成功的全量回溯**。
 *
 * 🔴 用它判断「首次导入」，而不是判断「有没有同步过」：开机同步本身是增量的，
 *    新库第一次开机只会拉最近 7 天，**并立刻建立水位** —— 此后永远走增量，
 *    26 周窗口的前 25 周就再也没人补了（只能靠用户自己发现并手动点全量）。
 *
 * 看 `job_run` 而不新增状态：页面按钮与 CLI 触发的全量都会在这里留下一条
 * `sync_full` 记录，跑成功即算「导入过」。
 */
export function hasCompletedFullSync(db: Db): boolean {
  const row = prepare(db, `SELECT COUNT(*) AS c FROM job_run WHERE job_type = 'sync_full' AND status = 'success'`).get() as
    | { c: number }
    | undefined;
  return row !== undefined && Number(row.c) > 0;
}

/**
 * 「该跑哪种同步」的唯一判据 —— 开机编排与「网页填完 Key 之后」都调它。
 *
 * 🔴 为什么需要共享：Key 现在可以在网页上填。新用户的开机那一刻**还没有 Key**，
 *    开机同步整个被跳过；等他填完 Key，如果没人补这一步，就永远只走增量，
 *    26 周窗口的前 25 周白等（卡片上那句「第一次使用会自动整段导入」也就成了假话）。
 *    所以「填完 Key 且从未全量过 → 自动全量」必须走同一套判断。
 */
export function nextSyncJobType(db: Db): JobType {
  return hasCompletedFullSync(db) ? 'sync_incremental' : 'sync_full';
}

/**
 * 过期草稿归档（§7.6：草稿对应的周已过去 → archived + 提示重新生成）。
 * 同步归档数写入 notification，仪表盘可见。
 */
export function archiveStaleDrafts(db: Db, nowMs: number = Date.now()): number {
  const today = todayStr(nowMs);
  const rows = prepare(db, `SELECT id, week_end FROM plan WHERE status = 'draft' AND week_end < ?`).all(today) as unknown as Array<{
    id: number;
    week_end: string;
  }>;
  if (rows.length === 0) return 0;
  const now = isoSeconds(nowMs);
  for (const r of rows) {
    prepare(db, `UPDATE plan SET status = 'archived', updated_at = ? WHERE id = ? AND status = 'draft'`).run(now, r.id);
  }
  new NotificationRepo(db).add(
    'info',
    `归档 ${rows.length} 份过期计划草稿`,
    `对应周已结束（week_end < ${today}），请重新生成下周计划`,
    'plan',
    null,
  );
  return rows.length;
}

/**
 * 开机编排。同步动作以 fire-and-forget 方式排队（不阻塞 HTTP 监听），
 * 结果写入日志与 job_run 历史。
 */
export function runStartupTasks(db: Db, runner: Pick<JobRunner, 'enqueue'>, opts: StartupOptions): StartupReport {
  const cancelled = new JobRepo(db).cancelRunning();
  const archived = archiveStaleDrafts(db);
  // 异步写入改造后：上次进程在写入中途被杀是常见场景（用户合上笔记本），
  // sync_write_job/plan 会永久停在 writing → 死锁。开机统一恢复为 uncertain（结果未知，交人工核实）。
  const stuckWrites = recoverStuckWrites(db);
  // 老用户豁免：升级前就有生效 goal 的库，补种引导完成位，避免升级当天被弹一次引导。
  // 新库（无 goal）不补种 —— 首次打开页面才会看到三步引导。
  const onboardingSeeded = seedOnboardingForExistingUsers(db);

  // 首次导入（从未成功全量过）→ 开机直接全量拉满分析窗口（实测 182 天约 9 秒）；
  // 之后一律增量。这样新装一套（Key 已在 .env 里）不必手动点「全量同步」。
  // ⚠️ Key 是开机之后才在网页上填的，走不到这里 —— 那条路由 index.ts 的 onXunjiApplied 兜住。
  const syncJobType: JobType | null = opts.syncOnStartup ? nextSyncJobType(db) : null;

  if (syncJobType !== null) {
    void runner
      .enqueue(syncJobType, 'startup')
      .then((out) =>
        console.log(`[startup] 开机同步（${syncJobType}）${out.status}${out.detail ? ` · ${out.detail}` : ''}`),
      )
      .catch((e: unknown) => console.error(`[startup] 开机同步异常：${(e as Error).message}`));
  }

  // 清理历史报告：纯本地、毫秒级，顺手同步做掉（同步动作在前、清理在后）。
  // 不用排队成任务 —— 开机路径要的是「启动即完成」，而它没有任何网络/长耗时。
  const pruned = pruneReports(db);

  return { cancelled, archived, stuckWrites, onboardingSeeded, syncQueued: opts.syncOnStartup, syncJobType, pruned };
}
