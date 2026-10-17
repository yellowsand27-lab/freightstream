import type { FastifyInstance } from "fastify";
import { q, withUser } from "../db.js";
import { requireEditor } from "../auth.js";
import { paging, type PageQuery } from "../paging.js";

const SORT = ["total_open", "overdue_by_baseline", "limit_utilization", "entity_name", "open_invoices", "max_days_past_baseline"] as const;

/** 客户列表 + 客户 360 + 额度维护（带审计的写路径） */
export default async function customers(app: FastifyInstance) {
  app.get<{ Querystring: PageQuery & { search?: string; model?: string; openOnly?: string } }>(
    "/api/customers", async (req) => {
      const p = paging(req.query, SORT, "total_open");
      const where: string[] = ["NOT is_related_party"];
      const params: unknown[] = [];
      if (req.query.search) { params.push(`%${req.query.search}%`); where.push(`entity_name ILIKE $${params.length}`); }
      if (req.query.model) { params.push(req.query.model); where.push(`business_model = $${params.length}`); }
      if (req.query.openOnly !== "false") where.push("total_open > 0");
      const w = `WHERE ${where.join(" AND ")}`;
      const [{ n }] = await q<{ n: string }>(`SELECT count(*) AS n FROM mart.entity_exposure ${w}`, params);
      const data = await q(`SELECT * FROM mart.entity_exposure ${w} ORDER BY ${p.orderBy} LIMIT ${p.limit} OFFSET ${p.offset}`, params);
      return { data, total: Number(n) };
    });

  app.get<{ Params: { id: string } }>("/api/customers/:id", async (req, reply) => {
    const id = Number(req.params.id);
    const [exposure] = await q(`SELECT * FROM mart.entity_exposure WHERE entity_id = $1`, [id]);
    if (!exposure) return reply.code(404).send({ error: "not found" });
    const [entity, members, policy, openItems, history, baseline] = await Promise.all([
      q(`SELECT * FROM ref.entity WHERE entity_id = $1`, [id]).then((r) => r[0]),
      q(`SELECT em.company_id, em.leg, c.full_name, c.city, c.state, c.country
         FROM ref.entity_member em JOIN mirror.companies c USING (company_id) WHERE em.entity_id = $1`, [id]),
      q(`SELECT * FROM ref.credit_policy WHERE entity_id = $1`, [id]).then((r) => r[0] ?? null),
      q(`SELECT * FROM mart.open_item WHERE entity_id = $1 ORDER BY days_past_baseline DESC`, [id]),
      q(`SELECT changed_at, actor, op, old_limit, new_limit, old_duty_limit, new_duty_limit, rationale
         FROM ref.credit_limit_history WHERE entity_id = $1 ORDER BY changed_at DESC LIMIT 50`, [id]),
      q(`SELECT * FROM mart.payment_baseline WHERE entity_id = $1`, [id]).then((r) => r[0] ?? null),
    ]);
    return { exposure, entity, members, policy, openItems, history, baseline };
  });

  /**
   * 额度维护。写入 ref.credit_policy，触发器把变更（含操作人）写进 ref.change_log。
   * 操作人来自 x-user 头——正式上线要接认证，把这里换成会话里的用户身份。
   */
  app.put<{ Params: { id: string }; Body: { credit_limit?: number | null; duty_limit?: number | null; warn_ratio?: number; rationale?: string } }>(
    "/api/customers/:id/credit-policy", { preHandler: requireEditor }, async (req, reply) => {
      const id = Number(req.params.id);
      const actor = req.user!.email || req.user!.sub;  // 审计身份来自登录 token
      void reply;
      const b = req.body ?? {};
      const row = await withUser(actor, async (c) => {
        const r = await c.query(
          `INSERT INTO ref.credit_policy (entity_id, credit_limit, duty_limit, warn_ratio, set_by, rationale, updated_at)
           VALUES ($1, $2, $3, COALESCE($4, 0.80), $5, $6, now())
           ON CONFLICT (entity_id) DO UPDATE SET
             credit_limit = EXCLUDED.credit_limit, duty_limit = EXCLUDED.duty_limit,
             warn_ratio = EXCLUDED.warn_ratio, set_by = EXCLUDED.set_by,
             rationale = EXCLUDED.rationale, updated_at = now()
           RETURNING *`,
          [id, b.credit_limit ?? null, b.duty_limit ?? null, b.warn_ratio ?? null, actor, b.rationale ?? null]);
        return r.rows[0];
      });
      return row;
    });

  /** 业务模式 / 关联方 / 风险等级维护——同样走审计 */
  app.put<{ Params: { id: string }; Body: { business_model?: string; is_related_party?: boolean; risk_tier?: string | null; note?: string } }>(
    "/api/customers/:id", { preHandler: requireEditor }, async (req, reply) => {
      const id = Number(req.params.id);
      const actor = req.user!.email || req.user!.sub;
      void reply;
      const b = req.body ?? {};
      const row = await withUser(actor, async (c) => {
        const r = await c.query(
          `UPDATE ref.entity SET
             business_model   = COALESCE($2, business_model),
             is_related_party = COALESCE($3, is_related_party),
             risk_tier        = CASE WHEN $4::text IS NOT NULL THEN NULLIF($4,'') ELSE risk_tier END,
             note             = COALESCE($5, note),
             updated_at       = now()
           WHERE entity_id = $1 RETURNING *`,
          [id, b.business_model ?? null, b.is_related_party ?? null, b.risk_tier === undefined ? null : (b.risk_tier ?? ""), b.note ?? null]);
        return r.rows[0];
      });
      return row;
    });
}
