import type { FastifyInstance } from "fastify";
import { q } from "../db.js";

/**
 * 操作员绩效记分卡。数据源 mart.op_file（每票一行，归属到 shipments.operator）。
 *
 * 口径三条铁律（违反任一条数字就是错的，见 sql/022 与 RUNBOOK 第 7 节）：
 *  1. 金额与时效类指标只算 business_model='direct'。agency 按周期批量结算、单票无应收，
 *     混进来会造出假缺口——实测 CalvinL「未开票超 45 天」全口径 524 票、direct 口径只有 5 票。
 *  2. 产出量（票数/客户数）算全口径，因为 agency 的票也是实际干的活。
 *  3. 中位数必须在原始逐票行上算 percentile_cont，不能由月度中位数再平均。
 *
 * 不给综合评分：各 OP 的货型与客户结构不同（有人专做一个大代理客户，有人做几十个直客），
 * 单一分数会把结构差异当成能力差异。页面并列五个维度，由人来判断。
 */

/** 归属月窗口条件：近 N 月（含本月） */
const WINDOW = `op.month >= date_trunc('month', CURRENT_DATE) - (($1::int - 1) * INTERVAL '1 month')`;
const clampMonths = (v: unknown, dflt = 12) => Math.min(60, Math.max(1, Number(v ?? dflt) || dflt));

/** direct 专用的口径片段——重复出现，集中定义避免各处写歪 */
const D = "op.business_model = 'direct'";
const OVERDUE_UNBILLED = `${D} AND op.first_invoice_date IS NULL AND op.has_cost AND (CURRENT_DATE - op.file_opened) > 45`;

export default async function staff(app: FastifyInstance) {
  /** 团队级 KPI（窗口内） */
  app.get<{ Querystring: { months?: string } }>("/api/staff/summary", async (req) => {
    const m = clampMonths(req.query.months);
    return (await q(`
      SELECT count(DISTINCT op.operator)::int                           AS operators,
             count(*)::int                                              AS files,
             count(*) FILTER (WHERE ${D})::int                          AS direct_files,
             percentile_cont(0.5) WITHIN GROUP (ORDER BY op.lag_days)
               FILTER (WHERE ${D} AND op.lag_days IS NOT NULL)          AS med_lag_days,
             count(*) FILTER (WHERE ${OVERDUE_UNBILLED})::int           AS unbilled_over_45,
             COALESCE(sum(op.unrec_gap), 0)                             AS unrec_gap,
             COALESCE(sum(op.dem_paid), 0)                              AS dem_paid,
             COALESCE(sum(op.dem_recovered), 0)                         AS dem_recovered,
             round(100.0 * sum(op.dem_recovered) / NULLIF(sum(op.dem_paid), 0), 1) AS dem_recovery_pct,
             COALESCE(sum(op.dup_groups), 0)::int                       AS dup_groups,
             COALESCE(sum(op.dup_extra), 0)                             AS dup_extra
      FROM mart.op_file op
      WHERE ${WINDOW}`, [m]))[0];
  });

  /**
   * 记分卡主表：每个 OP 一行。
   * minFiles 过滤掉窗口内只有一两票的历史账号（169 个 operator 值里近 12 月真正活跃的只有十几个）。
   */
  app.get<{ Querystring: { months?: string; minFiles?: string } }>("/api/staff/scorecard", async (req) => {
    const m = clampMonths(req.query.months);
    const min = Math.min(500, Math.max(0, Number(req.query.minFiles ?? 10) || 0));
    return q(`
      SELECT op.operator,
             count(*)::int                                              AS files,
             count(*) FILTER (WHERE ${D})::int                          AS direct_files,
             count(DISTINCT op.customer_id)::int                         AS customers,
             max(op.created_at)                                          AS last_file_at,
             -- 开票时效（direct）
             percentile_cont(0.5) WITHIN GROUP (ORDER BY op.lag_days)
               FILTER (WHERE ${D} AND op.lag_days IS NOT NULL)          AS med_lag_days,
             count(*) FILTER (WHERE ${D} AND op.lag_days > 45)::int      AS lag_over_45,
             count(*) FILTER (WHERE ${OVERDUE_UNBILLED})::int            AS unbilled_over_45,
             COALESCE(sum(op.ar_billed) FILTER (WHERE ${D}), 0)          AS ar_billed,
             -- 成本转嫁（direct）
             COALESCE(sum(op.unrec_gap), 0)                              AS unrec_gap,
             count(*) FILTER (WHERE op.unrec_gap > 0)::int               AS unrec_files,
             -- 经代理对账收回的金额：解释"为什么缺口没那么大"，见 023
             COALESCE(sum(op.agent_debit) FILTER (WHERE ${D}), 0)        AS agent_debit,
             -- 滞期回收（direct）
             COALESCE(sum(op.dem_paid), 0)                               AS dem_paid,
             COALESCE(sum(op.dem_recovered), 0)                          AS dem_recovered,
             round(100.0 * sum(op.dem_recovered) / NULLIF(sum(op.dem_paid), 0), 1) AS dem_recovery_pct,
             -- 疑似重复录入（线索，不是结论）
             COALESCE(sum(op.dup_groups), 0)::int                        AS dup_groups,
             COALESCE(sum(op.dup_extra), 0)                              AS dup_extra
      FROM mart.op_file op
      WHERE ${WINDOW}
      GROUP BY op.operator
      HAVING count(*) >= ${min}
      ORDER BY files DESC`, [m]);
  });

  /** 月度趋势：不传 operator = 全团队 */
  app.get<{ Querystring: { months?: string; operator?: string } }>("/api/staff/trend", async (req) => {
    const m = clampMonths(req.query.months, 24);
    const who = (req.query.operator ?? "").trim();
    const params: unknown[] = [m];
    let filter = "";
    if (who) { params.push(who); filter = `AND op.operator = $2`; }
    return q(`
      WITH months AS (
        SELECT generate_series(date_trunc('month', CURRENT_DATE) - ($1::int - 1) * INTERVAL '1 month',
                               date_trunc('month', CURRENT_DATE), INTERVAL '1 month')::date AS m
      ),
      agg AS (
        SELECT op.month AS m,
               count(*)::int                                            AS files,
               count(*) FILTER (WHERE ${D})::int                        AS direct_files,
               percentile_cont(0.5) WITHIN GROUP (ORDER BY op.lag_days)
                 FILTER (WHERE ${D} AND op.lag_days IS NOT NULL)        AS med_lag_days,
               sum(op.unrec_gap)                                        AS unrec_gap
        FROM mart.op_file op
        WHERE ${WINDOW} ${filter}
        GROUP BY op.month
      )
      SELECT to_char(months.m, 'YYYY-MM')          AS period,
             COALESCE(agg.files, 0)                AS files,
             COALESCE(agg.direct_files, 0)         AS direct_files,
             agg.med_lag_days,
             COALESCE(agg.unrec_gap, 0)            AS unrec_gap
      FROM months LEFT JOIN agg ON agg.m = months.m
      ORDER BY months.m`, params);
  });

  /**
   * 钻取：某 OP 窗口内的票。
   * issue 用于只看某一类问题的票——记分卡上每个数字都必须能点开看到是哪几票。
   */
  app.get<{
    Querystring: { months?: string; operator?: string; issue?: string; page?: string; pageSize?: string; sort?: string; order?: string };
  }>("/api/staff/files", async (req) => {
    const m = clampMonths(req.query.months);
    const who = (req.query.operator ?? "").trim();
    const page = Math.max(1, Number(req.query.page ?? 1) || 1);
    const ps = Math.min(100, Math.max(1, Number(req.query.pageSize ?? 25) || 25));

    const issues: Record<string, string> = {
      unbilled: OVERDUE_UNBILLED,                       // 有成本、超 45 天还没开票
      slow_billing: `${D} AND op.lag_days > 45`,         // 开了票但太慢
      unrecovered: `op.unrec_gap > 0`,                   // 成本没转嫁出去
      demurrage: `op.dem_paid > 0`,                      // 产生了滞期/仓储费
      duplicate: `op.dup_groups > 0`,                    // 疑似重复录入
    };
    const sortable: Record<string, string> = {
      unrec_gap: "op.unrec_gap", dem_paid: "op.dem_paid", lag_days: "op.lag_days",
      ar_billed: "op.ar_billed", file_opened: "op.file_opened", dup_extra: "op.dup_extra",
    };
    const sc = sortable[req.query.sort ?? ""] ?? "op.file_opened";
    const ord = req.query.order === "asc" ? "ASC" : "DESC";

    const params: unknown[] = [m];
    const where = [WINDOW];
    if (who) { params.push(who); where.push(`op.operator = $${params.length}`); }
    const iss = issues[req.query.issue ?? ""];
    if (iss) where.push(iss);
    const clause = `WHERE ${where.join(" AND ")}`;

    const rows = await q(`
      SELECT op.shipment_id, op.hbl_no, op.operator, op.entity_name, op.business_model,
             op.file_opened, op.eta, op.first_invoice_date, op.lag_days,
             CASE WHEN op.first_invoice_date IS NULL
                  THEN CURRENT_DATE - op.file_opened END AS unbilled_days,
             op.ar_billed, op.ap_cost, op.unrec_gap, op.agent_debit, op.dem_paid, op.dem_recovered,
             op.dup_groups, op.dup_extra, op.dup_max_gap_hours
      FROM mart.op_file op ${clause}
      ORDER BY ${sc} ${ord} NULLS LAST, op.shipment_id DESC
      LIMIT ${ps} OFFSET ${(page - 1) * ps}`, params);
    const cnt = await q<{ n: number }>(`SELECT count(*)::int n FROM mart.op_file op ${clause}`, params);
    return { data: rows, total: cnt[0].n };
  });

  /** 操作员下拉：窗口内有票的人 */
  app.get<{ Querystring: { months?: string } }>("/api/staff/operators", async (req) => {
    const m = clampMonths(req.query.months);
    return q(`
      SELECT op.operator, count(*)::int AS files
      FROM mart.op_file op WHERE ${WINDOW}
      GROUP BY op.operator ORDER BY files DESC`, [m]);
  });
}
