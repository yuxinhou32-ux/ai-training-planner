/**
 * 动作目录/映射路由（§2.3 server/api/routes/catalog.ts）——T2 阶段只读。
 *
 * GET /api/catalog/mappings    动作 → 肌群映射（含来源/置信度；页面按动作分组展示）
 * GET /api/catalog/unresolved  未识别动作清单（Q-F，open 状态按 hit_count 降序）
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Db } from '../../db/index.js';
import { prepare } from '../../db/index.js';
import { HttpError, sendJson } from '../errors.js';

export function handleCatalogRoutes(db: Db): (req: IncomingMessage, res: ServerResponse, pathname: string) => Promise<boolean> {
  return async (req, res, pathname) => {
    if (pathname === '/api/catalog/mappings' && req.method === 'GET') {
      const rows = prepare(
        db,
        `SELECT c.id AS catalog_id, c.name, mm.muscle_code,
                COALESCE(g.name_zh, mm.muscle_code) AS muscle_zh,
                mm.role, mm.weight, mm.source, mm.confidence, mm.confirmed
         FROM movement_catalog c
         LEFT JOIN movement_muscle_map mm ON mm.catalog_id = c.id
         LEFT JOIN muscle_group g ON g.code = mm.muscle_code
         ORDER BY c.name, CASE mm.role WHEN 'primary' THEN 0 ELSE 1 END, mm.muscle_code`,
      ).all() as unknown as Array<{
        catalog_id: number;
        name: string;
        muscle_code: string | null;
        muscle_zh: string | null;
        role: string | null;
        weight: number | null;
        source: string | null;
        confidence: string | null;
        confirmed: number | null;
      }>;
      // 按动作分组
      const byCatalog = new Map<number, { catalogId: number; name: string; muscles: Array<Record<string, unknown>> }>();
      for (const r of rows) {
        let entry = byCatalog.get(Number(r.catalog_id));
        if (!entry) {
          entry = { catalogId: Number(r.catalog_id), name: r.name, muscles: [] };
          byCatalog.set(Number(r.catalog_id), entry);
        }
        if (r.muscle_code !== null) {
          entry.muscles.push({
            code: r.muscle_code,
            name: r.muscle_zh,
            role: r.role,
            weight: r.weight,
            source: r.source,
            confidence: r.confidence,
            confirmed: Number(r.confirmed) === 1,
          });
        }
      }
      sendJson(res, 200, { movements: [...byCatalog.values()] });
      return true;
    }

    if (pathname === '/api/catalog/unresolved' && req.method === 'GET') {
      const rows = prepare(
        db,
        `SELECT name_raw, name_norm, hit_count, first_seen, last_seen
         FROM movement_unresolved WHERE status = 'open'
         ORDER BY hit_count DESC, last_seen DESC LIMIT 100`,
      ).all() as unknown as Array<{
        name_raw: string;
        name_norm: string;
        hit_count: number;
        first_seen: string;
        last_seen: string;
      }>;
      sendJson(res, 200, {
        unresolved: rows.map((r) => ({
          nameRaw: r.name_raw,
          nameNorm: r.name_norm,
          hitCount: Number(r.hit_count),
          firstSeen: r.first_seen,
          lastSeen: r.last_seen,
        })),
      });
      return true;
    }

    if (pathname.startsWith('/api/catalog')) {
      throw new HttpError(404, `未知的目录路由：${req.method} ${pathname}`);
    }
    return false;
  };
}
