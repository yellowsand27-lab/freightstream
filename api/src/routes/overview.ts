import type { FastifyInstance } from "fastify";
import { q } from "../db.js";

/** 总览页：KPI 瓦片 + 告警计数 + 账龄趋势 */
export default async function overview(app: FastifyInstance) {
  app.get("/api/overview", async () => {
    const [kpi] = await q<Record<string, string>>(`
      WITH oi AS (SELECT * FROM mart.open_item WHERE NOT COALESCE(is_related_party,false))
      SELECT
        (SELECT count(*)            FROM oi)                                        AS open_invoices,
        (SELECT sum(total_balance)  FROM oi)                                        AS open_total,
        (SELECT sum(freight_balance) FROM oi)                                       AS open_freight,
        (SELECT sum(duty_balance)   FROM oi)                                        AS open_duty,
        (SELECT sum(total_balance)  FROM oi WHERE days_past_baseline > 0)           AS overdue_by_baseline,
        (SELECT sum(total_balance)  FROM oi WHERE days_past_due_nominal > 90)       AS overdue_90_nominal,
        (SELECT count(*) FROM mart.entity_exposure WHERE limit_utilization >= warn_ratio AND NOT is_related_party AND credit_limit >= 100) AS credit_breaches,
        (SELECT sum(gap) FROM mart.unrecovered_cost
           WHERE business_model='direct' AND recovery_state IN ('not_rebilled','under_rebilled')
             AND created_at >= CURRENT_DATE - INTERVAL '12 months')                AS unrecovered_12m,
        (SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY lag_days)
           FROM mart.billing_lag WHERE business_model='direct' AND first_invoice_date IS NOT NULL
             AND file_opened >= CURRENT_DATE - INTERVAL '12 months')               AS billing_lag_median,
        (SELECT count(*) FROM mart.billing_lag WHERE business_model='direct' AND first_invoice_date IS NULL
             AND unbilled_days >= 45 AND file_opened >= CURRENT_DATE - INTERVAL '12 months') AS unbilled_files`);

    const alerts = await q<{ alert_code: string; n: number; amount: string | null }>(`
      SELECT alert_code, count(*)::int AS n, sum(amount) AS amount FROM (
        SELECT alert_code, amount FROM mart.alert_credit_breach
        UNION ALL SELECT alert_code, amount FROM mart.alert_payment_overdue
        UNION ALL SELECT alert_code, amount FROM mart.alert_unrecovered_cost
        UNION ALL SELECT alert_code, amount FROM mart.alert_duplicate_payment
        UNION ALL SELECT alert_code, amount FROM mart.alert_billing_delay
      ) a GROUP BY alert_code ORDER BY alert_code`);

    return { kpi, alerts };
  });

  /** 账龄趋势：每月月末一个点，由 mart.aging_as_of 回溯计算，无需快照表 */
  app.get<{ Querystring: { months?: string; includeRelated?: string } }>("/api/aging/trend", async (req) => {
    const months = Math.min(60, Math.max(3, Number(req.query.months ?? 12) || 12));
    const incl = req.query.includeRelated === "true";
    return q(`
      SELECT to_char(g.d, 'YYYY-MM') AS period,
             a.aging_bucket,
             sum(a.invoices)::int          AS invoices,
             sum(a.freight_balance)        AS balance
      FROM generate_series(
             date_trunc('month', CURRENT_DATE) - ($1::int - 1) * INTERVAL '1 month',
             date_trunc('month', CURRENT_DATE), INTERVAL '1 month') g(d),
           LATERAL mart.aging_as_of(LEAST((g.d + INTERVAL '1 month - 1 day')::date, CURRENT_DATE), $2) a
      GROUP BY 1, 2 ORDER BY 1, 2`, [months, incl]);
  });

  app.get<{ Querystring: { date?: string; includeRelated?: string } }>("/api/aging/asof", async (req) => {
    const d = req.query.date ?? new Date().toISOString().slice(0, 10);
    return q(`SELECT * FROM mart.aging_as_of($1::date, $2)`, [d, req.query.includeRelated === "true"]);
  });
}
