import type { FastifyInstance } from "fastify";
import { q } from "../db.js";

const VIEWS: Record<string, string> = {
  credit_breach: "mart.alert_credit_breach",
  payment_overdue: "mart.alert_payment_overdue",
  unrecovered_cost: "mart.alert_unrecovered_cost",
  duplicate_payment: "mart.alert_duplicate_payment",
  billing_delay: "mart.alert_billing_delay",
};

/**
 * 告警工作台。五个视图遵循同一契约（alert_code / dedup_key / severity / subject_zh / subject_en / detail_json），
 * 所以这里是一个通用循环——新增一类告警只需在 VIEWS 里加一行。
 */
export default async function alerts(app: FastifyInstance) {
  app.get<{ Querystring: { code?: string; severity?: string } }>("/api/alerts", async (req, reply) => {
    const codes = req.query.code ? req.query.code.split(",").filter((c) => VIEWS[c]) : Object.keys(VIEWS);
    if (codes.length === 0) return reply.code(400).send({ error: "unknown alert code" });
    const union = codes.map((c) => `SELECT * FROM ${VIEWS[c]}`).join(" UNION ALL ");
    const sev = req.query.severity;
    const rows = await q(
      `SELECT * FROM (${union}) a ${sev ? "WHERE severity = $1" : ""}
       ORDER BY CASE severity WHEN 'critical' THEN 0 WHEN 'serious' THEN 1 WHEN 'warning' THEN 2 ELSE 3 END,
                amount DESC NULLS LAST`,
      sev ? [sev] : [],
    );
    return { data: rows, total: rows.length };
  });

  app.get("/api/alerts/rules", async () =>
    q(`SELECT alert_code, title_zh, title_en, source_view, min_severity, schedule_cron,
              throttle_hours, enabled FROM notify.rule ORDER BY alert_code`));
}
