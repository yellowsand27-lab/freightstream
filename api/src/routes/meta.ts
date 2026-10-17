import type { FastifyInstance } from "fastify";
import { q } from "../db.js";

/** 数据水位线：网页上的「数据截至 X」直接读这里，让看的人知道数据是什么时候的 */
export default async function meta(app: FastifyInstance) {
  app.get("/api/meta/refresh", async () => {
    const rows = await q<{ table_name: string; status: string; row_count: number; finished_at: string }>(`
      SELECT DISTINCT ON (table_name) table_name, status, row_count, finished_at
      FROM mirror.refresh_log
      WHERE status = 'ok'
      ORDER BY table_name, started_at DESC`);
    const asOf = rows.reduce<string | null>((m, r) => (!m || r.finished_at > m ? r.finished_at : m), null);
    return { asOf, tables: rows };
  });

  // 中台「运行状态」页用（docs/03-module-contract.md）：夜间同步任务的最近一次结果 + 数据时间
  app.get("/api/status", async () => {
    const [last] = await q<{ finished_at: string | null; started_at: string; ok: number; failed: number; rows: number }>(`
      WITH run AS (SELECT * FROM mirror.refresh_log WHERE started_at > (SELECT MAX(started_at) FROM mirror.refresh_log) - interval '6 hours')
      SELECT MAX(finished_at) finished_at, MIN(started_at) started_at,
             COUNT(*) FILTER (WHERE status = 'ok')::int ok, COUNT(*) FILTER (WHERE status <> 'ok')::int failed,
             COALESCE(SUM(row_count) FILTER (WHERE status = 'ok'), 0)::int rows
      FROM run`);
    const status = !last?.started_at ? "planned" : last.failed ? "partial" : "ok";
    return {
      jobs: [{ id: "etl", title: { en: "Nightly refresh from iFMS", zh: "每晚从 iFMS 同步" }, schedule: "03:00 UTC",
        last: last?.started_at ? { at: last.finished_at ?? last.started_at, status, summary: { tables: last.ok + last.failed, failed: last.failed, rows: last.rows } } : null }],
      alerts: last?.failed ? [{ level: "warn", text: { en: `${last.failed} table(s) failed in the last refresh`, zh: `最近一次同步有 ${last.failed} 张表失败` }, at: last.finished_at }] : [],
      data: { asOf: last?.finished_at ?? null }
    };
  });
}
