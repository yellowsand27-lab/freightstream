import type { FastifyInstance } from "fastify";
import { q } from "../db.js";

/**
 * 数据分析：给"数据分析"页提供各类趋势/构成，供 ECharts 呈现。
 * 全部只读 mart / mirror，口径与操作页一致。未来月份（录入超前）按当前月截断。
 */
export default async function analytics(app: FastifyInstance) {
  /** 月度业务量：开票额、发票数、进口提单数 */
  app.get<{ Querystring: { months?: string } }>("/api/analytics/business-trend", async (req) => {
    const m = Math.min(60, Math.max(3, Number(req.query.months ?? 24) || 24));
    return q(`
      WITH months AS (
        SELECT generate_series(date_trunc('month', CURRENT_DATE) - ($1::int - 1) * INTERVAL '1 month',
                               date_trunc('month', CURRENT_DATE), INTERVAL '1 month')::date AS m
      ),
      iv AS (
        SELECT date_trunc('month', invoice_date)::date m, count(*) inv, sum(invoice_amt) amt
        FROM mirror.invoices WHERE void_flag = 0 AND invoice_date <= CURRENT_DATE GROUP BY 1
      ),
      sh AS (
        SELECT date_trunc('month', created_at)::date m, count(*) shp
        FROM mirror.shipments WHERE created_at <= CURRENT_DATE GROUP BY 1
      )
      SELECT to_char(months.m, 'YYYY-MM')      AS period,
             COALESCE(iv.inv, 0)::int          AS invoices,
             COALESCE(iv.amt, 0)               AS billing,
             COALESCE(sh.shp, 0)::int          AS import_shipments
      FROM months
      LEFT JOIN iv ON iv.m = months.m
      LEFT JOIN sh ON sh.m = months.m
      ORDER BY months.m`, [m]);
  });

  /** 回款速度趋势：按开票月，已收发票的付款天数中位数与 P90 */
  app.get<{ Querystring: { months?: string } }>("/api/analytics/dso-trend", async (req) => {
    const m = Math.min(60, Math.max(3, Number(req.query.months ?? 24) || 24));
    return q(`
      SELECT to_char(date_trunc('month', i.invoice_date), 'YYYY-MM')                       AS period,
             percentile_cont(0.5) WITHIN GROUP (ORDER BY (i.paid_date - i.invoice_date))    AS median_days,
             percentile_cont(0.9) WITHIN GROUP (ORDER BY (i.paid_date - i.invoice_date))    AS p90_days,
             count(*)::int                                                                  AS sample
      FROM mirror.invoices i
      LEFT JOIN ref.entity_member em ON em.company_id = i.bill_to_id
      LEFT JOIN ref.entity e ON e.entity_id = em.entity_id
      WHERE i.void_flag = 0 AND i.paid_date IS NOT NULL AND i.invoice_amt > 0
        AND i.invoice_date >= date_trunc('month', CURRENT_DATE) - ($1::int - 1) * INTERVAL '1 month'
        AND i.invoice_date <= CURRENT_DATE
        AND NOT COALESCE(e.is_related_party, false)
      GROUP BY 1 ORDER BY 1`, [m]);
  });

  /** Top 客户：按敞口 或 超基线逾期，横向条形用 */
  app.get<{ Querystring: { metric?: string; limit?: string } }>("/api/analytics/top-customers", async (req) => {
    const col = req.query.metric === "overdue" ? "overdue_by_baseline" : "total_open";
    const limit = Math.min(30, Math.max(5, Number(req.query.limit ?? 12) || 12));
    return q(`
      SELECT entity_id, entity_name, business_model,
             total_open, overdue_by_baseline, duty_open, freight_open
      FROM mart.entity_exposure
      WHERE NOT is_related_party AND ${col} > 0
      ORDER BY ${col} DESC LIMIT ${limit}`);
  });

  /** 成本未转嫁：按费用类别汇总（近 N 月，直客），供构成条形 */
  app.get<{ Querystring: { months?: string } }>("/api/analytics/unrecovered-by-class", async (req) => {
    const m = Math.min(60, Math.max(1, Number(req.query.months ?? 12) || 12));
    return q(`
      SELECT class,
             count(DISTINCT shipment_id)::int AS files,
             sum(gap) AS gap
      FROM mart.unrecovered_cost
      WHERE business_model = 'direct' AND recovery_state IN ('not_rebilled','under_rebilled')
        AND created_at >= CURRENT_DATE - ($1::int || ' months')::interval AND gap >= 200
      GROUP BY 1 ORDER BY gap DESC`, [m]);
  });

  /** 员工排行：某时间窗内每人各类产出总量 + 活跃天数（供选人/排名） */
  app.get<{ Querystring: { months?: string } }>("/api/analytics/staff/leaderboard", async (req) => {
    const m = Math.min(60, Math.max(1, Number(req.query.months ?? 3) || 3));
    return q(`
      SELECT staff,
             count(*) FILTER (WHERE activity_type='shipment')::int AS shipments,
             count(*) FILTER (WHERE activity_type='invoice')::int  AS invoices,
             count(*) FILTER (WHERE activity_type='ap')::int       AS ap,
             count(*)::int                                         AS total,
             count(DISTINCT day)::int                              AS active_days,
             max(created_at)                                       AS last_active
      FROM mart.staff_activity
      WHERE created_at >= CURRENT_DATE - ($1::int || ' months')::interval
        AND staff NOT IN (SELECT user_id FROM ref.system_account)
      GROUP BY staff ORDER BY total DESC`, [m]);
  });

  /** 日历热力：某人（或全员）每日产出计数，供日历热力图 */
  app.get<{ Querystring: { months?: string; staff?: string; type?: string } }>("/api/analytics/staff/daily", async (req) => {
    const m = Math.min(24, Math.max(1, Number(req.query.months ?? 12) || 12));
    const where = [
      `created_at >= CURRENT_DATE - ($1::int || ' months')::interval`,
      `staff NOT IN (SELECT user_id FROM ref.system_account)`,
    ];
    const params: unknown[] = [m];
    if (req.query.staff) { params.push(req.query.staff); where.push(`staff = $${params.length}`); }
    if (req.query.type && ["shipment","invoice","ap"].includes(req.query.type)) {
      params.push(req.query.type); where.push(`activity_type = $${params.length}`);
    }
    return q(`
      SELECT to_char(day,'YYYY-MM-DD') AS day,
             count(*)::int AS total,
             count(*) FILTER (WHERE activity_type='shipment')::int AS shipments,
             count(*) FILTER (WHERE activity_type='invoice')::int  AS invoices,
             count(*) FILTER (WHERE activity_type='ap')::int       AS ap
      FROM mart.staff_activity WHERE ${where.join(" AND ")}
      GROUP BY day ORDER BY day`, params);
  });

  /** 钻取：某人某天新建的具体单据 */
  app.get<{ Querystring: { staff?: string; day?: string } }>("/api/analytics/staff/day", async (req, reply) => {
    const staff = String(req.query.staff ?? "").trim();
    const day = String(req.query.day ?? "").trim();
    if (!staff || !day) return reply.code(400).send({ error: "staff and day required" });
    return q(`
      SELECT sa.activity_type, sa.ref_id, sa.ref_no, sa.amount,
             to_char(sa.created_at,'HH24:MI') AS at_time,
             e.entity_id, e.entity_name
      FROM mart.staff_activity sa
      LEFT JOIN ref.entity_member em ON em.company_id = sa.party_id
      LEFT JOIN ref.entity e ON e.entity_id = em.entity_id
      WHERE sa.staff = $1 AND sa.day = $2::date
      ORDER BY sa.created_at`, [staff, day]);
  });
}
