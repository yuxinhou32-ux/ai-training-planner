/**
 * 任务处理器：每个 job_type 的实际执行体。
 *
 * 原则：
 *  - 只编排既有服务层（syncEngine / runAnalysis / planService / backup），
 *    不复制业务逻辑；
 *  - sync 类任务的 job_run 由 SyncEngine 自建（ownsJobRun=true），其余由 JobRunner 统一建；
 *  - 同步只拉数据，不再链式落分析报告 —— 分析由排计划/复盘现算、周期末快照产出；
 *  - plan_draft 只产出草稿并通知——写回必须走用户 approve→confirm 双栏杆（红线）。
 *
 * v2：任务全部由手动按钮或开机同步触发，不再有定时调度与备份轮转
 * （备份每次落一个新时间戳文件，由用户自行清理）。
 */
import path from 'node:path';
import type { Db } from '../db/index.js';
import { prepare } from '../db/index.js';
import { backupDb, defaultBackupPath } from '../db/backup.js';
import { runAnalysis } from '../analysis/analysisService.js';
import { pruneReports } from '../analysis/prune.js';
import { createPlanFromAi, regenerateTemplate } from '../plan/planService.js';
import { importAll, loadSeeds } from '../catalog/catalogService.js';
import type { SyncEngine, SyncSummary } from '../ingest/syncEngine.js';
import type { AiGateway } from '../ai/schemas.js';
import type { TriggeredBy } from '../repo/jobRepo.js';
import { SYNC_INITIAL_WEEKS } from '../config/constants.js';
import { NotificationRepo } from '../repo/notificationRepo.js';
import { hasTrainingData } from '../repo/trainRepo.js';
import { todayStr } from '../util/dates.js';

export interface JobDeps {
  db: Db;
  /** SQLite 文件路径（备份用）。 */
  dbPath: string;
  /** SyncEngine（未配置 API Key 时为 null）。 */
  engine: SyncEngine | null;
  /** AI 网关（未配置 LLM 时为 null → plan_draft/review 走确定性路径）。 */
  gw: AiGateway | null;
  aiModelTag: string;
}

export interface HandlerResult {
  status: 'success' | 'partial' | 'failed';
  /** 结果引用：'report:12' / 'plan:3' / 'review:5' / 备份文件路径。 */
  resultRef?: string;
  /** 人类可读摘要（任务历史与通知用）。 */
  detail?: string;
  /** sync 类：引擎自建的 job_run id（runner 不再建）。 */
  ownJobRunId?: number;
}

export type JobHandler = (deps: JobDeps, triggeredBy: TriggeredBy) => Promise<HandlerResult>;

export interface JobHandlerDef {
  handler: JobHandler;
  /** job_run 由处理器自建（sync 类）时为 true。 */
  ownsJobRun: boolean;
  label: string;
}

function mapSyncOutcome(s: SyncSummary): HandlerResult {
  const detail = `共 ${s.total} 天：拉取 ${s.fetched} / 空 ${s.empty} / 失败 ${s.failed} / 跳过 ${s.skipped}`;
  const status = s.status === 'success' ? 'success' : s.status === 'partial' ? 'partial' : 'failed';
  return { status, resultRef: `job:${s.jobRunId}`, detail, ownJobRunId: s.jobRunId };
}

/* ------------------ 各任务处理器 ------------------ */

const syncIncremental: JobHandler = async (deps, triggeredBy) => {
  if (deps.engine === null) return { status: 'failed', detail: '未配置训记 API Key，同步不可用' };
  const s = await deps.engine.runIncremental({ triggeredBy });
  return mapSyncOutcome(s);
};

const syncRetryFailed: JobHandler = async (deps, triggeredBy) => {
  if (deps.engine === null) return { status: 'failed', detail: '未配置训记 API Key，同步不可用' };
  const s = await deps.engine.runRetryFailed({ triggeredBy });
  return mapSyncOutcome(s);
};

const syncFull: JobHandler = async (deps, triggeredBy) => {
  if (deps.engine === null) return { status: 'failed', detail: '未配置训记 API Key，同步不可用' };
  const s = await deps.engine.runFull(SYNC_INITIAL_WEEKS * 7, { triggeredBy });
  return mapSyncOutcome(s);
};

export const analysisRefresh: JobHandler = async (deps) => {
  if (!hasTrainingData(deps.db)) return { status: 'failed', detail: '暂无训练数据，请先同步' };
  const res = runAnalysis(deps.db, { trendEnd: todayStr(), persist: true });
  if (res.reportId === null) return { status: 'failed', detail: '分析报告未落库' };
  return { status: 'success', resultRef: `report:${res.reportId}`, detail: `报告窗口 ${res.report.window.trend_start} ~ ${res.report.window.trend_end}` };
};

export const planDraft: JobHandler = async (deps) => {
  let planId: number;
  let source: string;
  if (deps.gw !== null) {
    const out = await createPlanFromAi(deps.db, deps.gw, deps.aiModelTag, {});
    planId = out.planId;
    source = out.result.status === 'accepted' ? 'ai' : 'rule_fallback';
  } else {
    const detail = regenerateTemplate(deps.db, {});
    planId = detail.plan.id;
    source = 'rule_fallback';
  }
  new NotificationRepo(deps.db).add(
    'info',
    '下周计划草稿已生成',
    '请到「计划确认」页查看并确认；不确认绝不写入训记',
    'plan',
    String(planId),
  );
  return { status: 'success', resultRef: `plan:${planId}`, detail: `下周草稿已生成（${source === 'ai' ? 'AI' : '规则模板'}），待确认` };
};

/** 清理历史分析报告：adhoc 只留最近 3 份、snapshot 保留 3 年（见 analysis/prune.ts）。 */
export const reportPrune: JobHandler = async (deps) => {
  const { adhocDeleted, snapshotDeleted } = pruneReports(deps.db);
  return { status: 'success', detail: `清理 adhoc ${adhocDeleted} 份 / snapshot ${snapshotDeleted} 份` };
};

export const dbBackup: JobHandler = async (deps) => {
  const dest = defaultBackupPath(deps.dbPath, new Date());
  backupDb(deps.db, dest);
  return { status: 'success', resultRef: dest, detail: `备份完成：${path.basename(dest)}` };
};

export const catalogImport: JobHandler = async (deps) => {
  const row = prepare(deps.db, 'SELECT COUNT(*) AS c FROM movement_catalog').get() as { c: number };
  if (Number(row.c) > 0) return { status: 'success', detail: `动作目录已存在（${row.c} 条），跳过导入` };
  const input = loadSeeds();
  const res = importAll(deps.db, input);
  return { status: 'success', detail: `目录导入完成：${res.catalogCount} 动作 / ${res.serverMapRows} 服务端映射` };
};

/** 手动触发白名单 + 元数据（§7.2 全部任务；顺序即 UI 展示顺序）。 */
export const JOB_HANDLER_DEFS: Record<string, JobHandlerDef> = {
  sync_full: { handler: syncFull, ownsJobRun: true, label: `全量同步（${SYNC_INITIAL_WEEKS} 周）` },
  sync_incremental: { handler: syncIncremental, ownsJobRun: true, label: '增量同步' },
  sync_retry: { handler: syncRetryFailed, ownsJobRun: true, label: '重试失败日期' },
  analysis_refresh: { handler: analysisRefresh, ownsJobRun: false, label: '刷新分析报告' },
  plan_draft: { handler: planDraft, ownsJobRun: false, label: '生成下周计划草稿' },
  db_backup: { handler: dbBackup, ownsJobRun: false, label: '数据库备份' },
  catalog_import: { handler: catalogImport, ownsJobRun: false, label: '导入动作目录' },
  report_prune: { handler: reportPrune, ownsJobRun: false, label: '清理历史分析报告' },
};
