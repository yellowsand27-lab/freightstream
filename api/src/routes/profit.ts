import type { FastifyInstance } from "fastify";
import { q } from "../db.js";

/**
 * 每票盈亏（file P&L），仅 direct 自营业务。数据源 mart.file_pl。
 * 收入=提单 AR 明细和，成本=AP 明细和，毛利=收入−成本。agency/柜级不做（见 021 说明）。
 */
export default async function profit(app: FastifyInstance) {
  /** KPI 汇总 */
  app.get("/api/profit/summary", async () =>
    (await q(`
      SELECT count(*)::int                                   AS files,
             COALESCE(sum(revenue), 0)                        AS revenue,
             COALESCE(sum(cost), 0)                           AS cost,
             COALESCE(sum(gross_profit), 0)                   AS gross_profit,
             round(COALESCE(avg(gross_profit), 0))            AS avg_gp,
             round(100.0 * sum(gross_profit) / NULLIF(sum(revenue), 0), 1) AS margin_pct,
             count(*) FILTER (WHERE gross_profit < 0)::int    AS loss_files
      FROM mart.file_pl`))[0]);

  /** 月度毛利趋势（近 N 月，按归属期 period_date） */
  app.get<{ Querystring: { months?: string } }>("/api/profit/trend", async (req) => {
    const m = Math.min(60, Math.max(3, Number(req.query.months ?? 24) || 24));
    return q(`
      WITH months AS (
        SELECT generate_series(date_trunc('month', CURRENT_DATE) - ($1::int - 1) * INTERVAL '1 month',
                               date_trunc('month', CURRENT_DATE), INTERVAL '1 month')::date AS m
      ),
      pl AS (
        SELECT date_trunc('month', period_date)::date m,
               count(*) files, sum(revenue) revenue, sum(cost) cost, sum(gross_profit) gp
        FROM mart.file_pl
        WHERE period_date <= CURRENT_DATE GROUP BY 1
      )
      SELECT to_char(months.m, 'YYYY-MM')                            AS period,
             COALESCE(pl.files, 0)::int                              AS files,
             COALESCE(pl.gp, 0)                                      AS gross_profit,
             COALESCE(pl.revenue, 0)                                 AS revenue,
             round(100.0 * pl.gp / NULLIF(pl.revenue, 0), 1)         AS margin_pct
      FROM months LEFT JOIN pl ON pl.m = months.m
      ORDER BY months.m`, [m]);
  });

  /** Top 客户：按毛利 */
  app.get<{ Querystring: { limit?: string } }>("/api/profit/by-customer", async (req) => {
    const limit = Math.min(30, Math.max(5, Number(req.query.limit ?? 12) || 12));
    return q(`
      SELECT entity_id,
             COALESCE(entity_name, customer_name, '#' || invoice_to_id) AS customer_name,
             count(*)::int                                             AS files,
             sum(revenue)                                              AS revenue,
             sum(gross_profit)                                         AS gross_profit,
             round(100.0 * sum(gross_profit) / NULLIF(sum(revenue), 0), 1) AS margin_pct
      FROM mart.file_pl
      GROUP BY entity_id, entity_name, customer_name, invoice_to_id
      ORDER BY gross_profit DESC LIMIT ${limit}`);
  });

  /** 操作员创利 */
  app.get<{ Querystring: { limit?: string } }>("/api/profit/by-operator", async (req) => {
    const limit = Math.min(30, Math.max(5, Number(req.query.limit ?? 15) || 15));
    return q(`
      SELECT COALESCE(NULLIF(btrim(operator), ''), '(未署名)') AS operator,
             count(*)::int                                     AS files,
             sum(gross_profit)                                 AS gross_profit,
             round(100.0 * sum(gross_profit) / NULLIF(sum(revenue), 0), 1) AS margin_pct
      FROM mart.file_pl
      GROUP BY 1 ORDER BY gross_profit DESC LIMIT ${limit}`);
  });

  /** 每票列表：分页 + 排序 + 搜索 */
  app.get<{ Querystring: { page?: string; pageSize?: string; sort?: string; order?: string; q?: string } }>(
    "/api/profit/files", async (req) => {
      const page = Math.max(1, Number(req.query.page ?? 1) || 1);
      const ps = Math.min(100, Math.max(1, Number(req.query.pageSize ?? 25) || 25));
      const sortable: Record<string, string> = {
        gross_profit: "gross_profit", margin_pct: "margin_pct", revenue: "revenue",
        cost: "cost", period_date: "period_date", hbl_no: "hbl_no",
      };
      const sc = sortable[req.query.sort ?? ""] ?? "gross_profit";
      const ord = req.query.order === "asc" ? "ASC" : "DESC";
      const search = (req.query.q ?? "").trim();
      const params: unknown[] = [];
      let where = "";
      if (search) { params.push(`%${search}%`); where = `WHERE (hbl_no ILIKE $1 OR customer_name ILIKE $1 OR operator ILIKE $1)`; }
      const rows = await q(`
        SELECT shipment_id, hbl_no, customer_name, operator, sman_id, eta, period_date,
               revenue, hbl_cost, master_cost_alloc, cost, gross_profit, margin_pct
        FROM mart.file_pl ${where}
        ORDER BY ${sc} ${ord} NULLS LAST, shipment_id DESC
        LIMIT ${ps} OFFSET ${(page - 1) * ps}`, params);
      const cnt = await q<{ n: number }>(`SELECT count(*)::int n FROM mart.file_pl ${where}`, params);
      return { data: rows, total: cnt[0].n };
    });

  /** 钻取：某票的收支明细行 */
  app.get<{ Params: { id: string } }>("/api/profit/file/:id/lines", async (req) => {
    const id = Number(req.params.id);
    return q(`
      SELECT cl.direction, cl.description, cl.billing_code, cl.rate, cl.qty, cl.amount,
             co.full_name AS counterparty
      FROM mirror.charge_lines cl
      LEFT JOIN mirror.companies co ON co.company_id = cl.counterparty_id
      WHERE cl.src_table = 'T_OIHMAIN' AND cl.src_id = $1 AND cl.void_flag = 0
      ORDER BY cl.direction, cl.amount DESC`, [id]);
  });
}
