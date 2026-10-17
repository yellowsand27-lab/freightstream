import type { FastifyInstance } from "fastify";
import { q } from "../db.js";
import { paging, type PageQuery } from "../paging.js";

/** 开票时效（能力清单第 1 项） */
export default async function billing(app: FastifyInstance) {
  /** 按操作员汇总——与告警口径一致：直客 + 已发生成本 + 近 12 月 */
  app.get<{ Querystring: { months?: string; threshold?: string } }>("/api/billing/by-operator", async (req) => {
    const m = Math.min(60, Math.max(1, Number(req.query.months ?? 12) || 12));
    const t = Math.max(0, Number(req.query.threshold ?? 45) || 45);
    return q(`
      WITH base AS (
        SELECT l.*,
               EXISTS (SELECT 1 FROM mirror.charge_lines cl WHERE cl.src_table='T_OIHMAIN'
                       AND cl.src_id = l.shipment_id AND cl.direction='ap' AND cl.void_flag=0) AS has_cost
        FROM mart.billing_lag l
        WHERE l.business_model = 'direct' AND l.file_opened >= CURRENT_DATE - ($1::int || ' months')::interval)
      SELECT COALESCE(NULLIF(btrim(operator),''),'(unassigned)') AS operator,
             count(*)::int                                                       AS files,
             count(*) FILTER (WHERE first_invoice_date IS NOT NULL)::int         AS billed,
             percentile_cont(0.5) WITHIN GROUP (ORDER BY lag_days)               AS median_lag,
             count(*) FILTER (WHERE first_invoice_date IS NULL AND has_cost AND unbilled_days >= $2)::int AS unbilled_over_threshold,
             max(unbilled_days) FILTER (WHERE first_invoice_date IS NULL AND has_cost) AS oldest_unbilled
      FROM base GROUP BY 1 ORDER BY unbilled_over_threshold DESC, files DESC`, [m, t]);
  });

  /** 逐票明细 */
  app.get<{ Querystring: PageQuery & { operator?: string; unbilledOnly?: string; months?: string } }>(
    "/api/billing/files", async (req) => {
      const p = paging(req.query, ["unbilled_days", "lag_days", "file_opened", "entity_name", "operator"], "unbilled_days");
      const m = Math.min(60, Math.max(1, Number(req.query.months ?? 12) || 12));
      const where = ["business_model = 'direct'", `file_opened >= CURRENT_DATE - ($1::int || ' months')::interval`];
      const params: unknown[] = [m];
      if (req.query.operator) { params.push(req.query.operator); where.push(`operator = $${params.length}`); }
      if (req.query.unbilledOnly === "true") where.push("first_invoice_date IS NULL");
      const w = `WHERE ${where.join(" AND ")}`;
      const [{ n }] = await q<{ n: string }>(`SELECT count(*) AS n FROM mart.billing_lag ${w}`, params);
      const data = await q(`SELECT * FROM mart.billing_lag ${w} ORDER BY ${p.orderBy} LIMIT ${p.limit} OFFSET ${p.offset}`, params);
      return { data, total: Number(n) };
    });
}
