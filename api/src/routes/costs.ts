import type { FastifyInstance } from "fastify";
import { q } from "../db.js";
import { paging, type PageQuery } from "../paging.js";

/** 成本回收：未转嫁成本（R5c）与滞期罚款归因（R5d） */
export default async function costs(app: FastifyInstance) {
  /** 客户级汇总——与告警口径一致 */
  app.get<{ Querystring: { months?: string } }>("/api/costs/unrecovered/summary", async (req) => {
    const m = Math.min(60, Math.max(1, Number(req.query.months ?? 12) || 12));
    return q(`
      SELECT u.entity_id, u.entity_name, u.business_model,
             count(DISTINCT u.shipment_id)::int AS files,
             sum(u.ap_amount)  AS cost_total,
             sum(u.gap)        AS gap_total,
             max(u.created_at) AS latest_file
      FROM mart.unrecovered_cost u
      WHERE u.business_model = 'direct'
        AND u.recovery_state IN ('not_rebilled','under_rebilled')
        AND u.gap >= 200
        AND u.created_at >= CURRENT_DATE - ($1::int || ' months')::interval
      GROUP BY 1,2,3 HAVING sum(u.gap) >= 1000
      ORDER BY gap_total DESC`, [m]);
  });

  /** 逐票明细：网页下钻 */
  app.get<{ Querystring: PageQuery & { entityId?: string; state?: string; months?: string } }>(
    "/api/costs/unrecovered", async (req) => {
      const p = paging(req.query, ["gap", "ap_amount", "created_at", "entity_name", "class"], "gap");
      const m = Math.min(60, Math.max(1, Number(req.query.months ?? 12) || 12));
      const where = ["business_model = 'direct'", `created_at >= CURRENT_DATE - ($1::int || ' months')::interval`];
      const params: unknown[] = [m];
      if (req.query.entityId) { params.push(Number(req.query.entityId)); where.push(`entity_id = $${params.length}`); }
      if (req.query.state) { params.push(req.query.state); where.push(`recovery_state = $${params.length}`); }
      else where.push("recovery_state IN ('not_rebilled','under_rebilled')");
      const w = `WHERE ${where.join(" AND ")}`;
      const [{ n }] = await q<{ n: string }>(`SELECT count(*) AS n FROM mart.unrecovered_cost ${w}`, params);
      const data = await q(`SELECT * FROM mart.unrecovered_cost ${w} ORDER BY ${p.orderBy} LIMIT ${p.limit} OFFSET ${p.offset}`, params);
      return { data, total: Number(n) };
    });

  /** 滞期罚款：按客户 × 类别归因，含回收率 */
  app.get<{ Querystring: { months?: string } }>("/api/costs/demurrage", async (req) => {
    const m = Math.min(60, Math.max(1, Number(req.query.months ?? 12) || 12));
    return q(`
      SELECT COALESCE(entity_name,'(unassigned)') AS entity_name, entity_id, business_model, class,
             count(*)::int AS files,
             sum(paid_out)  AS paid_out,
             sum(recovered) AS recovered,
             sum(net_cost)  AS net_cost,
             CASE WHEN sum(paid_out) > 0 THEN round(100*sum(recovered)/sum(paid_out),1) END AS recovery_pct
      FROM mart.demurrage_penalty
      WHERE first_charge_date >= CURRENT_DATE - ($1::int || ' months')::interval
      GROUP BY 1,2,3,4 ORDER BY net_cost DESC`, [m]);
  });

  /**
   * 滞期费回收趋势：按【年 × 科目】统计付出/收回/缺口/回收率。
   * 这是最初发现"回收率从 4% 爬到 94%"的那张表，可下钻到票（见下一个接口）。
   * businessModel 过滤：默认全部；传 'direct' 只看直客（代理按周期结算，会拉低表观回收率）。
   */
  app.get<{ Querystring: { fromYear?: string; businessModel?: string } }>("/api/costs/demurrage/trend", async (req) => {
    const fromYear = Math.max(2007, Number(req.query.fromYear ?? 2023) || 2023);
    const bm = req.query.businessModel;
    const params: unknown[] = [fromYear];
    let bmFilter = "";
    if (bm) { params.push(bm); bmFilter = `AND business_model = $${params.length}`; }
    return q(`
      SELECT extract(year FROM first_charge_date)::int AS year,
             class,
             count(DISTINCT shipment_id)::int          AS files,
             sum(paid_out)                             AS paid_out,
             sum(recovered)                            AS recovered,
             sum(net_cost)                             AS net_cost,
             CASE WHEN sum(paid_out) > 0
                  THEN round(100 * sum(recovered) / sum(paid_out), 1) END AS recovery_pct
      FROM mart.demurrage_penalty
      WHERE first_charge_date >= make_date($1, 1, 1) ${bmFilter}
      GROUP BY 1, 2
      ORDER BY 1 DESC, 2`, params);
  });

  /** 钻取：某年 × 某科目 背后的逐票明细（可再按 business_model 过滤） */
  app.get<{ Querystring: PageQuery & { year?: string; class?: string; businessModel?: string; recoveredState?: string } }>(
    "/api/costs/demurrage/files", async (req) => {
      const p = paging(req.query, ["net_cost", "paid_out", "recovered", "first_charge_date", "entity_name"], "net_cost");
      const where: string[] = ["first_charge_date IS NOT NULL"];
      const params: unknown[] = [];
      if (req.query.year) { params.push(Number(req.query.year)); where.push(`extract(year FROM first_charge_date) = $${params.length}`); }
      if (req.query.class) { params.push(req.query.class); where.push(`class = $${params.length}`); }
      if (req.query.businessModel) { params.push(req.query.businessModel); where.push(`business_model = $${params.length}`); }
      // 只看没收回的（缺口>0）：钻到"该追的票"
      if (req.query.recoveredState === "gap") where.push("net_cost > 0.005");
      const w = `WHERE ${where.join(" AND ")}`;
      const [{ n }] = await q<{ n: string }>(`SELECT count(*) AS n FROM mart.demurrage_penalty ${w}`, params);
      const data = await q(`SELECT * FROM mart.demurrage_penalty ${w} ORDER BY ${p.orderBy} LIMIT ${p.limit} OFFSET ${p.offset}`, params);
      return { data, total: Number(n) };
    });

  /** 重复付款存量清理报表 */
  app.get("/api/costs/duplicates", async () =>
    q(`SELECT * FROM mart.duplicate_payment ORDER BY entered_surplus DESC LIMIT 500`));

  /** 钻取：某供应商 + 某发票号 下被重复录入的每一张应付凭证 */
  app.get<{ Querystring: { payToId?: string; invoiceNo?: string; shipmentId?: string } }>("/api/costs/duplicates/vouchers", async (req, reply) => {
    const payToId = Number(req.query.payToId);
    const invoiceNo = String(req.query.invoiceNo ?? "");
    if (!payToId || !invoiceNo) return reply.code(400).send({ error: "payToId and invoiceNo required" });
    // 真重复按同一提单归组，钻取也限定到该提单
    const params: unknown[] = [payToId, invoiceNo];
    let shpFilter = "";
    if (req.query.shipmentId) { params.push(Number(req.query.shipmentId)); shpFilter = `AND v.src_id = $${params.length}`; }
    return q(`
      SELECT v.voucher_id, v.invoice_no, v.invoice_amt, v.paid_amt, v.paid_date,
             v.invoice_date, v.void_flag, v.created_at, v.created_by,
             v.src_table, v.src_id, s.hbl_no,
             cl.rate, cl.qty, cl.description
      FROM mirror.ap_vouchers v
      LEFT JOIN LATERAL (
        SELECT max(c.rate) AS rate, sum(c.qty) AS qty,
               string_agg(DISTINCT c.description, '; ') AS description
        FROM mirror.charge_lines c
        WHERE c.direction = 'ap' AND c.header_id = v.voucher_id AND c.void_flag = 0
      ) cl ON true
      LEFT JOIN mirror.shipments s ON s.shipment_id = v.src_id AND v.src_table = 'T_OIHMAIN'
      WHERE v.pay_to_id = $1 AND v.invoice_no = $2 ${shpFilter}
      ORDER BY v.created_at`, params);
  });
}
