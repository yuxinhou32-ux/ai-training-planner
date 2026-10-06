/**
 * 分析报告路由（§2.3 server/api/routes/analysis.ts）。
 *
 * GET  /api/analysis/latest?version_no=N   画像（不带版本 → 最新 snapshot，回退任意 kind）
 * GET  /api/analysis/snapshots             全部画像版本（新 → 旧）
 * POST /api/analysis/snapshot              产出一份画像版本（首次=版本 0，并立接管起点）
 * POST /api/analysis/refresh               重新分析并落库（过程产物 kind='adhoc'）
 * GET  /api/analysis/snapshots/compare?from=N&to=M   两个画像版本的差异
 *
 * 🔴 「画像」= kind='snapshot'（周期末冻结的版本）。refresh 落的是 adhoc 过程产物，
 *    绝不能被画像页取到 —— 这就是 latest 优先快照、且快照缺席才回退的原因。
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Db } from '../../db/index.js';
import { prepare } from '../../db/index.js';
import { runAnalysis } from '../../analysis/analysisService.js';
import {
  compareSnapshots,
  createSnapshot,
  latestSnapshot,
  listSnapshots,
  snapshotByVersion,
  type SnapshotMeta,
} from '../../analysis/snapshot.js';
import { hasTrainingData } from '../../repo/trainRepo.js';
import { currentPlanningWeekStart } from '../../plan/planService.js';
import { ensureTakeover } from '../../review/takeover.js';
import { HttpError, sendJson } from '../errors.js';

interface ReportDbRow {
  id: number;
  payload_json: string;
  payload_hash: string;
  generated_at: string;
  window_start: string;
  window_end: string;
}

/**
 * 「最新报告」——**任意 kind**（含 adhoc）。仅作为「一份快照都没有」时的回退，
 * 让刚同步完还没产过画像的库也能看到点什么。
 */
export function latestReport(
  db: Db,
): { exists: true; reportId: number; report: unknown; generatedAt: string; version_no: number | null } | { exists: false } {
  const row = prepare(
    db,
    `SELECT id, payload_json, payload_hash, generated_at, window_start, window_end
     FROM analysis_report
     ORDER BY generated_at DESC, id DESC LIMIT 1`,
  ).get() as unknown as ReportDbRow | undefined;
  if (!row) return { exists: false };
  return {
    exists: true,
    reportId: Number(row.id),
    report: JSON.parse(row.payload_json),
    generatedAt: row.generated_at,
    // 回退路径可能取到 adhoc（version_no 恒 NULL）——如实报 null，不谎报成一个版本
    version_no: null,
  };
}

function queryOf(req: IncomingMessage): URLSearchParams {
  return new URL(req.url ?? '/', 'http://localhost').searchParams;
}

/** 版本号参数：必须是 ≥0 的整数；非法 → 400（不静默忽略，否则前端会以为看到的是指定版本）。 */
function versionParam(raw: string | null): number | null {
  if (raw === null || raw === '') return null;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) throw new HttpError(400, `version_no 需为非负整数，得到「${raw}」`);
  return n;
}

function snapshotMetaView(meta: SnapshotMeta): Record<string, unknown> {
  return { ...meta };
}

export function handleAnalysisRoutes(db: Db): (req: IncomingMessage, res: ServerResponse, pathname: string) => Promise<boolean> {
  return async (req, res, pathname) => {
    if (pathname === '/api/analysis/latest' && req.method === 'GET') {
      const wanted = versionParam(queryOf(req).get('version_no'));
      if (wanted !== null) {
        const snap = snapshotByVersion(db, wanted);
        if (snap === null) {
          sendJson(res, 200, { exists: false });
          return true;
        }
        sendJson(res, 200, {
          exists: true,
          reportId: snap.meta.report_id,
          report: snap.report,
          generatedAt: snap.meta.generated_at,
          version_no: snap.meta.version_no,
        });
        return true;
      }
      const snap = latestSnapshot(db);
      if (snap !== null) {
        sendJson(res, 200, {
          exists: true,
          reportId: snap.meta.report_id,
          report: snap.report,
          generatedAt: snap.meta.generated_at,
          version_no: snap.meta.version_no,
        });
        return true;
      }
      // 一份快照都没有 → 回退「最新报告（任意 kind）」，并把版本号如实报成 null
      sendJson(res, 200, latestReport(db));
      return true;
    }

    if (pathname === '/api/analysis/snapshots' && req.method === 'GET') {
      sendJson(res, 200, { versions: listSnapshots(db).map(snapshotMetaView) });
      return true;
    }

    if (pathname === '/api/analysis/snapshots/compare' && req.method === 'GET') {
      const q = queryOf(req);
      const from = versionParam(q.get('from'));
      const to = versionParam(q.get('to'));
      if (from === null || to === null) throw new HttpError(400, 'from / to 均为必填的版本号（非负整数）');
      if (from === to) throw new HttpError(400, 'from 与 to 不能是同一个版本');
      const result = compareSnapshots(db, from, to);
      if (result === null) throw new HttpError(404, `版本不存在：from=${from} to=${to}`);
      sendJson(res, 200, result);
      return true;
    }

    if (pathname === '/api/analysis/snapshot' && req.method === 'POST') {
      // 消费请求体（保持连接干净）；snapshot 不接受参数
      await readBody(req);
      if (!hasTrainingData(db)) {
        throw new HttpError(400, '暂无训练数据 —— 先同步训记或导入历史数据，再生成画像');
      }
      const meta = createSnapshot(db);
      // 🔴 首次建立画像 = 接管起点（第一个由本软件规划的训练周）。
      //    V12：用 `currentPlanningWeekStart` —— 用户本周就想练时，接管点落在**本周**
      //    （起始周），而不是硬跳下一周；否则本周那份计划会被判成「接管之前」而进不了复盘。
      //    ensureTakeover 单调：已有接管记录时原样返回，绝不后移。
      ensureTakeover(db, currentPlanningWeekStart(db));
      sendJson(res, 200, { created: true, ...snapshotMetaView(meta) });
      return true;
    }

    if (pathname === '/api/analysis/refresh' && req.method === 'POST') {
      // 消费请求体（保持连接干净）；refresh 不接受参数
      await readBody(req);
      // 显式 adhoc：这是诊断用的过程产物，不是画像版本（不占版本号、不进画像页）。
      const { report, reportId } = runAnalysis(db, { persist: true, kind: 'adhoc' });
      sendJson(res, 200, { exists: true, reportId, report, generatedAt: report.generated_at });
      return true;
    }

    if (pathname.startsWith('/api/analysis')) {
      throw new HttpError(404, `未知的分析路由：${req.method} ${pathname}`);
    }
    return false;
  };
}

export function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
