-- =============================================================================
-- 017 —— 收窄重复付款判定：必须同一提单
--
-- 执行身份：fs_owner
--     psql -U fs_owner -d freightstream -f sql/017_fix_duplicate_scope.sql
--
-- 原口径（同供应商+同发票号+同金额）把"一个发票号覆盖多票货"也算成重复：
-- 实测 925 组里 840 组其实挂在不同提单——承运人一张总发票拆到各提单入账，
-- 是正常的多票计费，不是多付。真重复应再加一个维度：同一票货(src_id)。
-- 收窄后 90 组 / 98 张多余凭证 / 敞口约 4.7 万（原虚高到 53 万）。
--
-- 保留一个旁支视图 mart.duplicate_invoice_no_multi_shipment，把"同号跨提单"
-- 单独列出——绝大多数正常，但万一里面有个别真错录，仍可人工翻查。
-- =============================================================================

-- 列结构变了（新增 shipment_id），CREATE OR REPLACE 不允许，改 DROP 重建。
-- alert 依赖它，先 DROP alert 再 DROP 本视图。
DROP VIEW IF EXISTS mart.alert_duplicate_payment;
DROP VIEW IF EXISTS mart.duplicate_payment;
CREATE VIEW mart.duplicate_payment AS
SELECT d.pay_to_id,
       c.full_name                              AS vendor_name,
       d.invoice_no,
       d.src_id                                 AS shipment_id,
       s.hbl_no,
       d.n                                      AS entry_count,
       d.each_amount,
       d.each_amount * (d.n - 1)                AS extra_amount,
       d.first_entered,
       d.last_entered,
       d.voucher_ids
FROM (
    SELECT v.pay_to_id, v.invoice_no, v.src_id, count(*) AS n,
           min(v.invoice_amt)                   AS each_amount,
           min(v.created_at)                    AS first_entered,
           max(v.created_at)                    AS last_entered,
           array_agg(v.voucher_id ORDER BY v.voucher_id) AS voucher_ids
    FROM mirror.ap_vouchers v
    WHERE v.void_flag = 0
      AND v.invoice_no IS NOT NULL AND btrim(v.invoice_no) <> ''
      AND v.invoice_amt > 0
      AND v.src_id IS NOT NULL                  -- 必须挂在某票货上
    GROUP BY v.pay_to_id, v.invoice_no, v.src_id
    HAVING count(*) > 1 AND count(DISTINCT v.invoice_amt) = 1
) d
LEFT JOIN mirror.companies c ON c.company_id = d.pay_to_id
LEFT JOIN mirror.shipments s ON s.shipment_id = d.src_id;

COMMENT ON VIEW mart.duplicate_payment IS
  '真重复付款：同供应商 + 同发票号 + 同金额 + 同一提单，录入多次。
   加"同一提单"是因为一个发票号常覆盖多票货（承运人总发票拆分入账），那不是多付。';

-- 旁支：同号但跨提单（正常多票计费，仅供偶发错录的人工排查，不进告警/敞口）
CREATE OR REPLACE VIEW mart.same_invoice_multi_shipment AS
SELECT v.pay_to_id, c.full_name AS vendor_name, v.invoice_no,
       count(DISTINCT v.src_id) AS shipments,
       count(*) AS vouchers,
       sum(v.invoice_amt) AS total_amount
FROM mirror.ap_vouchers v
LEFT JOIN mirror.companies c ON c.company_id = v.pay_to_id
WHERE v.void_flag = 0 AND v.invoice_no IS NOT NULL AND btrim(v.invoice_no) <> '' AND v.src_id IS NOT NULL
GROUP BY v.pay_to_id, c.full_name, v.invoice_no
HAVING count(DISTINCT v.src_id) > 1
ORDER BY count(*) DESC;

GRANT SELECT ON mart.duplicate_payment, mart.same_invoice_multi_shipment TO fs_app, fs_read;

-- alert_duplicate_payment 依赖 duplicate_payment，重建以跟上新列（dedup_key 加提单维度）
CREATE VIEW mart.alert_duplicate_payment AS
SELECT 'duplicate_payment'::text                                        AS alert_code,
       'dup:' || d.pay_to_id || ':' || d.invoice_no || ':' || d.shipment_id AS dedup_key,
       NULL::bigint                                                     AS entity_id,
       d.shipment_id::integer                                          AS shipment_id,
       CASE WHEN d.extra_amount >= 5000 THEN 'critical' ELSE 'serious' END AS severity,
       d.extra_amount                                                   AS amount,
       COALESCE(d.vendor_name,'供应商#'||d.pay_to_id) || ' 发票 ' || d.invoice_no
         || ' 在同一提单录入 ' || d.entry_count || ' 次，多出 '
         || to_char(d.extra_amount,'FM999,999,999')                     AS subject_zh,
       COALESCE(d.vendor_name,'Vendor #'||d.pay_to_id) || ' invoice ' || d.invoice_no
         || ' entered ' || d.entry_count || ' times on the same file, surplus '
         || to_char(d.extra_amount,'FM999,999,999')                     AS subject_en,
       to_jsonb(d)                                                      AS detail_json
FROM mart.duplicate_payment d
WHERE d.last_entered >= now() - interval '14 days';

GRANT SELECT ON mart.alert_duplicate_payment TO fs_app, fs_read;
