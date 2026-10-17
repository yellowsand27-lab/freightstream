import type { FastifyInstance } from "fastify";
import { q } from "../db.js";
import { paging, type PageQuery } from "../paging.js";

const SORT = ["total_balance", "days_past_baseline", "days_past_due_nominal", "invoice_date", "due_date", "entity_name"] as const;

export default async function receivables(app: FastifyInstance) {
  /** 未清应收明细（双口径逾期） */
  app.get<{ Querystring: PageQuery & { entityId?: string; search?: string; overdueOnly?: string; includeRelated?: string } }>(
    "/api/receivables/open", async (req) => {
      const p = paging(req.query, SORT, "days_past_baseline");
      const where: string[] = [];
      const params: unknown[] = [];
      if (req.query.entityId) { params.push(Number(req.query.entityId)); where.push(`entity_id = $${params.length}`); }
      if (req.query.search) {
        // 客户名或发票号，大小写不敏感模糊匹配
        params.push(`%${req.query.search}%`);
        where.push(`(entity_name ILIKE $${params.length} OR invoice_no ILIKE $${params.length})`);
      }
      if (req.query.overdueOnly === "true") where.push("days_past_baseline > 0");
      if (req.query.includeRelated !== "true") where.push("NOT COALESCE(is_related_party,false)");
      const w = where.length ? `WHERE ${where.join(" AND ")}` : "";
      const [{ n }] = await q<{ n: string }>(`SELECT count(*) AS n FROM mart.open_item ${w}`, params);
      const data = await q(
        `SELECT * FROM mart.open_item ${w} ORDER BY ${p.orderBy} LIMIT ${p.limit} OFFSET ${p.offset}`, params);
      return { data, total: Number(n) };
    });

  /** 关联方往来（R6） */
  app.get("/api/receivables/related-party", async () =>
    q(`SELECT * FROM mart.related_party_ledger WHERE period >= CURRENT_DATE - INTERVAL '24 months'
       ORDER BY period DESC, entity_name`));
}
