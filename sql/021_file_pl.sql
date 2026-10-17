-- =============================================================================
-- 021 —— 每票盈亏（file P&L），仅 direct 自营业务
--   v2 (2026-09-22)：成本补上 MBL(master) 层分摊。
--
-- 执行身份：fs_owner（DDL）
--   本地：psql -U fs_owner -d freightstream -f sql/021_file_pl.sql
--   生产：sudo -u postgres psql -d freightstream -c 'SET ROLE fs_owner;' -f ...
--
-- 背景：AR/AP 主体挂在提单层 (T_OIHMAIN)，但**海运主费等常挂在 MBL(master, T_OIMMAIN)**，
--   一个 MBL 下多个 HBL。v1 只算 HBL 层成本 → 漏掉 master 层 AP $56M，毛利率虚高
--   (19.9% → 实际约 11.7%)。v2 把 master 层 AP 按「该 MBL 下 HBL 数」平摊到每票。
--
--   ⚠ 仍是近似：master 成本按票数平摊(非按量/按收入比)；pass-through 代垫票
--   (收入全额开客户、对应成本在别处)仍可能虚高毛利——见页面提示与 RUNBOOK。
--   agency 收入不归单票(排除)；每柜利润做不了(费用挂提单，柜经 master 关联)。
--
-- 口径：direct 业务、revenue>0 且 总成本>0（收入成本齐全）。
-- =============================================================================

DROP VIEW IF EXISTS mart.file_pl;

CREATE VIEW mart.file_pl AS
WITH hbl AS (
    SELECT src_id AS shipment_id,
           sum(amount) FILTER (WHERE direction = 'ar') AS revenue,
           sum(amount) FILTER (WHERE direction = 'ap') AS hbl_cost
    FROM mirror.charge_lines
    WHERE src_table = 'T_OIHMAIN' AND void_flag = 0 AND src_id IS NOT NULL
    GROUP BY src_id
),
master_ap AS (
    SELECT src_id AS master_id, sum(amount) AS m_cost
    FROM mirror.charge_lines
    WHERE src_table = 'T_OIMMAIN' AND direction = 'ap' AND void_flag = 0
    GROUP BY src_id
),
master_cnt AS (
    SELECT master_id, count(*) AS hbl_n
    FROM mirror.shipments WHERE master_id IS NOT NULL GROUP BY master_id
),
calc AS (
    SELECT s.shipment_id, s.hbl_no, s.operator, s.sman_id, s.invoice_to_id, s.master_id,
           s.eta, s.close_date, s.created_at,
           cust.full_name AS customer_name, e.entity_id, e.entity_name,
           COALESCE(h.revenue, 0)                                    AS revenue,
           COALESCE(h.hbl_cost, 0)                                   AS hbl_cost,
           round(COALESCE(ma.m_cost / NULLIF(mc.hbl_n, 0), 0), 2)    AS master_cost_alloc
    FROM hbl h
    JOIN mirror.shipments s      ON s.shipment_id = h.shipment_id
    LEFT JOIN mirror.companies cust ON cust.company_id = s.invoice_to_id
    JOIN ref.entity_member em     ON em.company_id = s.invoice_to_id
    JOIN ref.entity e             ON e.entity_id = em.entity_id
    LEFT JOIN master_ap ma        ON ma.master_id = s.master_id
    LEFT JOIN master_cnt mc       ON mc.master_id = s.master_id
    WHERE e.business_model = 'direct'
)
SELECT shipment_id, hbl_no, operator, sman_id, invoice_to_id, customer_name,
       entity_id, entity_name, eta, close_date, created_at,
       COALESCE(eta, created_at::date)                        AS period_date,
       revenue,
       hbl_cost,
       master_cost_alloc,
       (hbl_cost + master_cost_alloc)                         AS cost,
       (revenue - hbl_cost - master_cost_alloc)               AS gross_profit,
       round((revenue - hbl_cost - master_cost_alloc) / NULLIF(revenue, 0) * 100, 1) AS margin_pct
FROM calc
WHERE revenue > 0 AND (hbl_cost + master_cost_alloc) > 0;

COMMENT ON VIEW mart.file_pl IS
  '每票盈亏(direct 自营)：收入=提单 AR 明细和；成本=提单 AP + 所属 MBL(master) 层 AP 按票数分摊。
   仅 business_model=direct。⚠ master 成本按票数平摊(近似)、pass-through 代垫票可能虚高毛利。
   agency 收入不归单票(排除)；柜级利润不可行(费用挂提单)。';

GRANT SELECT ON mart.file_pl TO fs_app, fs_read;
