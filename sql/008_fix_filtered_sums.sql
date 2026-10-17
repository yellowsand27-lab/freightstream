-- =============================================================================
-- 008 —— 修正 FILTER 聚合返回 NULL 的问题
--
-- 执行身份：fs_owner
--     psql -U fs_owner -d freightstream -f sql/008_fix_filtered_sums.sql
--
-- Bug：sum(x) FILTER (WHERE ...) 在没有匹配行时返回 NULL，不是 0。
--   于是 net_position = ar - ap 在只有单边时整体变成 NULL。
--   实测：TRANS KNIGHTS SHANGHAI 2026-05 向其开票 1,021,004、无应付，
--   净头寸却是 NULL——网页上会显示成 0，把一百万的往来抹掉。
--   mart.demurrage_penalty 的 paid_out / recovered 同样受影响。
-- =============================================================================

CREATE OR REPLACE VIEW mart.related_party_ledger AS
SELECT e.entity_id,
       e.entity_name,
       date_trunc('month', cl.doc_date)::date                           AS period,
       COALESCE(sum(cl.amount) FILTER (WHERE cl.direction = 'ar'), 0)   AS billed_to_them,
       COALESCE(sum(cl.amount) FILTER (WHERE cl.direction = 'ap'), 0)   AS billed_by_them,
       COALESCE(sum(cl.amount) FILTER (WHERE cl.direction = 'ar'), 0)
         - COALESCE(sum(cl.amount) FILTER (WHERE cl.direction = 'ap'), 0) AS net_position,
       count(DISTINCT cl.src_id)                                        AS shipments
FROM mirror.charge_lines cl
LEFT JOIN mirror.shipments  s ON s.shipment_id = cl.src_id AND cl.src_table = 'T_OIHMAIN'
LEFT JOIN ref.entity_member em ON em.company_id = COALESCE(s.customer_id, cl.counterparty_id)
JOIN ref.entity e ON e.entity_id = em.entity_id AND e.is_related_party
WHERE cl.void_flag = 0 AND cl.doc_date IS NOT NULL
GROUP BY e.entity_id, e.entity_name, date_trunc('month', cl.doc_date);

COMMENT ON VIEW mart.related_party_ledger IS
  'R6：关联方（Knights CHB、Trans Knights 各分支）与本体的往来。
   这些实体不进催收队列与额度告警，其头寸在此单独出账。';

-- CREATE OR REPLACE 不能在已有列中间插入新列（net_cost），
-- 所以这里 DROP 重建。无对象依赖该视图，无级联影响。
DROP VIEW IF EXISTS mart.demurrage_penalty;
CREATE VIEW mart.demurrage_penalty AS
SELECT cl.src_id                     AS shipment_id,
       s.hbl_no,
       s.operator,
       em.entity_id,
       e.entity_name,
       e.business_model,
       cc.class,
       COALESCE(sum(cl.amount) FILTER (WHERE cl.direction = 'ap'), 0) AS paid_out,
       COALESCE(sum(cl.amount) FILTER (WHERE cl.direction = 'ar'), 0) AS recovered,
       COALESCE(sum(cl.amount) FILTER (WHERE cl.direction = 'ap'), 0)
         - COALESCE(sum(cl.amount) FILTER (WHERE cl.direction = 'ar'), 0) AS net_cost,
       min(cl.doc_date)                                  AS first_charge_date,
       s.last_free_day
FROM mirror.charge_lines cl
JOIN ref.charge_class cc ON cc.billing_code = cl.billing_code
LEFT JOIN mirror.shipments  s ON s.shipment_id = cl.src_id AND cl.src_table = 'T_OIHMAIN'
LEFT JOIN ref.entity_member em ON em.company_id = s.customer_id
LEFT JOIN ref.entity         e ON e.entity_id  = em.entity_id
WHERE cl.void_flag = 0
  AND cc.class IN ('demurrage','detention','storage')
GROUP BY cl.src_id, s.hbl_no, s.operator, em.entity_id, e.entity_name,
         e.business_model, cc.class, s.last_free_day;

GRANT SELECT ON mart.related_party_ledger, mart.demurrage_penalty TO fs_app, fs_read;
