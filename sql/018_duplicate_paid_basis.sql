-- =============================================================================
-- 018 —— 重复付款敞口改按「实付」计，而非「录入」计
--
-- 执行身份：fs_owner
--     psql -U fs_owner -d freightstream -f sql/018_duplicate_paid_basis.sql
--
-- 背景：一张发票在同一提单录入 N 次，不等于多付了 (N-1) 次的钱——
-- 有的重复凭证只是录了、并未真付款。真正的资金外流 = 实付笔数 - 1。
-- 实测 90 组真重复里，86 组多张实付（真外流 $42,583），
-- 另 4 组只有一张实付或都未付（录重复但没多付钱）。
--
-- 于是 extra_amount 改为 each × (paid_count - 1)：只有多付出去的才算敞口。
-- 同时保留 entry_count（录入次数）与 paid_count（实付次数），前端可对照。
-- =============================================================================

DROP VIEW IF EXISTS mart.alert_duplicate_payment;
DROP VIEW IF EXISTS mart.duplicate_payment;

CREATE VIEW mart.duplicate_payment AS
SELECT d.pay_to_id,
       c.full_name                              AS vendor_name,
       d.invoice_no,
       d.src_id                                 AS shipment_id,
       s.hbl_no,
       d.n                                      AS entry_count,     -- 录入次数
       d.paid_count                             AS paid_count,      -- 实付次数
       d.any_voided                             AS any_voided,      -- 组内是否有作废（正常应无，因已过滤）
       d.each_amount,
       -- 真实资金外流：只有多付出去的才算。未真付的重复敞口计 0。
       d.each_amount * GREATEST(d.paid_count - 1, 0)  AS extra_amount,
       d.first_entered,
       d.last_entered,
       d.voucher_ids
FROM (
    SELECT v.pay_to_id, v.invoice_no, v.src_id,
           count(*)                                       AS n,
           count(*) FILTER (WHERE v.paid_amt > 0.005)     AS paid_count,
           bool_or(v.void_flag <> 0)                      AS any_voided,
           min(v.invoice_amt)                             AS each_amount,
           min(v.created_at)                              AS first_entered,
           max(v.created_at)                              AS last_entered,
           array_agg(v.voucher_id ORDER BY v.voucher_id)  AS voucher_ids
    FROM mirror.ap_vouchers v
    WHERE v.void_flag = 0
      AND v.invoice_no IS NOT NULL AND btrim(v.invoice_no) <> ''
      AND v.invoice_amt > 0
      AND v.src_id IS NOT NULL
    GROUP BY v.pay_to_id, v.invoice_no, v.src_id
    HAVING count(*) > 1 AND count(DISTINCT v.invoice_amt) = 1
) d
LEFT JOIN mirror.companies c ON c.company_id = d.pay_to_id
LEFT JOIN mirror.shipments s ON s.shipment_id = d.src_id;

COMMENT ON VIEW mart.duplicate_payment IS
  '真重复付款：同供应商+同发票号+同金额+同一提单，录入多次。
   extra_amount 按实付计（each × 多付笔数），录了没付的不算敞口。';

CREATE VIEW mart.alert_duplicate_payment AS
SELECT 'duplicate_payment'::text                                        AS alert_code,
       'dup:' || d.pay_to_id || ':' || d.invoice_no || ':' || d.shipment_id AS dedup_key,
       NULL::bigint                                                     AS entity_id,
       d.shipment_id::integer                                          AS shipment_id,
       CASE WHEN d.extra_amount >= 5000 THEN 'critical' ELSE 'serious' END AS severity,
       d.extra_amount                                                   AS amount,
       COALESCE(d.vendor_name,'供应商#'||d.pay_to_id) || ' 发票 ' || d.invoice_no
         || ' 在同一提单实付 ' || d.paid_count || ' 次，多出 '
         || to_char(d.extra_amount,'FM999,999,999')                     AS subject_zh,
       COALESCE(d.vendor_name,'Vendor #'||d.pay_to_id) || ' invoice ' || d.invoice_no
         || ' paid ' || d.paid_count || ' times on the same file, surplus '
         || to_char(d.extra_amount,'FM999,999,999')                     AS subject_en,
       to_jsonb(d)                                                      AS detail_json
FROM mart.duplicate_payment d
WHERE d.extra_amount > 0                     -- 只有真多付了才告警
  AND d.last_entered >= now() - interval '14 days';

GRANT SELECT ON mart.duplicate_payment, mart.alert_duplicate_payment TO fs_app, fs_read;
