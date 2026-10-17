-- =============================================================================
-- 020 —— 重复付款判定：从「头层同金额」改为「完全相同明细行被录多次」
--
-- 执行身份：fs_owner（DDL）
--     psql -U fs_owner -d freightstream -f sql/020_duplicate_detail_basis.sql
--   生产上：sudo -u postgres psql -d freightstream -c 'SET ROLE fs_owner;' -f ...
--
-- 背景（第三类校准，续 017「同提单」、018「按实付」）：
--   旧口径只在 T_APHD 头层比「同供应商+同发票号+同提单+同金额」，多一条就算重复。
--   这会把正常业务误判为重复，实测有三种：
--     · 分期付款：一张发票分 deposit+尾款两次入账（Lucky Q90289：两条各
--       rate=7300/qty=0.5，合计一份）。
--     · 按量分批：同一费用按数量分两次录（MIIN-23032：STORAGE @125，
--       一条 qty=36=$4500、一条 qty=4=$500，合计 40 天，是正常仓储费）。
--     · 多箱单据：一条凭证 qty=5（海运 5 箱），本就不是多条。
--
--   ⚠ 关键教训：明细 F_Rate/F_Qty 语义随业务变——分期里 rate 是「合同总额」、
--   qty 是比例；按量里 rate 是「单价」、qty 是数量。所以既不能用 rate 当基准，
--   也不能只按「描述+费率」聚合再看份数和（那会把 36+4 天算成多付 39 份）。
--
-- 判据（明细行级，用 mirror.charge_lines，ap 的 rate/qty 覆盖率 99.4%）：
--   把 ap 明细按 (供应商, 发票号, 提单, 描述, 费率, **数量**) 归组——即「完全相同
--   的费用行」。只有当同一行出现在 **>1 张凭证** 且 **该行数量×出现次数 > 1** 时
--   才算重复（后一条排除 qty=0.5×2 的分期）。
--     · 分期(Lucky)：qty0.5，出现2次，0.5×2=1  → 出局 ✓
--     · 按量(MIIN)：qty36 与 qty4 是不同的行，各出现1次 → 出局 ✓
--     · 多箱(MEDUV)：qty5 只在1张凭证         → 出局 ✓
--     · 重复(Yang)：qty1，出现2次，1×2=2>1     → 保留 ✓
--   超额 = 该行金额 ×(出现次数 − 1)；已付敞口只按「已付凭证」的出现次数计。
-- =============================================================================

-- alert 依赖 duplicate_payment，先删 alert 再删主视图（列有增改，必须 DROP 重建）
DROP VIEW IF EXISTS mart.alert_duplicate_payment;
DROP VIEW IF EXISTS mart.duplicate_payment;

-- 明细行级判定要按 header_id join charge_lines，原来无索引会全表扫（ap 50 万+ 行）。
-- charge_lines 每晚 TRUNCATE+COPY 重建，索引定义随表保留、自动重建。
CREATE INDEX IF NOT EXISTS charge_lines_ap_header_idx
    ON mirror.charge_lines (header_id) WHERE direction = 'ap';


CREATE VIEW mart.duplicate_payment AS
WITH ap_line AS (
    -- 每条 ap 明细行 + 其所属凭证的发票号/提单/已付状态
    SELECT v.pay_to_id, v.invoice_no, v.src_id, v.voucher_id,
           v.paid_amt, v.created_at,
           cl.description, cl.rate, cl.qty, cl.amount
    FROM mirror.ap_vouchers v
    JOIN mirror.charge_lines cl
      ON cl.direction = 'ap' AND cl.header_id = v.voucher_id AND cl.void_flag = 0
    WHERE v.void_flag = 0
      AND v.invoice_no IS NOT NULL AND btrim(v.invoice_no) <> ''
      AND v.src_id IS NOT NULL
      AND cl.rate IS NOT NULL AND cl.rate > 0
      AND cl.qty  IS NOT NULL AND cl.qty  > 0
),
dup_line AS (
    -- 完全相同的费用行(描述+费率+数量)被录进多张凭证，且合计份数超过 1
    SELECT pay_to_id, invoice_no, src_id, description, rate, qty,
           count(DISTINCT voucher_id)                                 AS occurs,
           count(DISTINCT voucher_id) FILTER (WHERE paid_amt > 0.005) AS paid_occurs,
           max(amount)                                                AS unit_amount,
           -- 完全相同行的录入时间跨度：分批作业几分钟内连录(gap≈0)，
           -- 真误录往往隔小时/隔天(Yang 2h、Lucky 23 天)。用于复核排序。
           extract(epoch FROM (max(created_at) - min(created_at))) / 3600.0 AS gap_hours,
           min(created_at)                                            AS first_entered,
           max(created_at)                                            AS last_entered
    FROM ap_line
    GROUP BY pay_to_id, invoice_no, src_id, description, rate, qty
    HAVING count(DISTINCT voucher_id) > 1
       AND qty * count(DISTINCT voucher_id) > 1.0 + 0.0005
)
SELECT d.pay_to_id,
       c.full_name                                                   AS vendor_name,
       d.invoice_no,
       d.src_id                                                      AS shipment_id,
       s.hbl_no,
       (SELECT count(*) FROM mirror.ap_vouchers v2
         WHERE v2.pay_to_id = d.pay_to_id AND v2.invoice_no = d.invoice_no
           AND v2.src_id = d.src_id AND v2.void_flag = 0)            AS entry_count,
       (SELECT count(*) FROM mirror.ap_vouchers v2
         WHERE v2.pay_to_id = d.pay_to_id AND v2.invoice_no = d.invoice_no
           AND v2.src_id = d.src_id AND v2.void_flag = 0 AND v2.paid_amt > 0.005) AS paid_count,
       count(*)                                                      AS dup_line_count,
       round(sum(d.unit_amount * (d.occurs - 1)), 2)                 AS entered_surplus,
       round(sum(d.unit_amount * GREATEST(d.paid_occurs - 1, 0)), 2) AS extra_amount,
       round(max(d.gap_hours)::numeric, 1)                           AS max_gap_hours,
       min(d.first_entered)                                          AS first_entered,
       max(d.last_entered)                                           AS last_entered,
       (SELECT array_agg(v3.voucher_id ORDER BY v3.voucher_id) FROM mirror.ap_vouchers v3
         WHERE v3.pay_to_id = d.pay_to_id AND v3.invoice_no = d.invoice_no
           AND v3.src_id = d.src_id AND v3.void_flag = 0)            AS voucher_ids
FROM dup_line d
LEFT JOIN mirror.companies c ON c.company_id = d.pay_to_id
LEFT JOIN mirror.shipments  s ON s.shipment_id = d.src_id
GROUP BY d.pay_to_id, c.full_name, d.invoice_no, d.src_id, s.hbl_no;

COMMENT ON VIEW mart.duplicate_payment IS
  '疑似重复复核清单（非确定判决，续 020/方向A）：同供应商+同发票号+同提单下，完全相同的费用行
   (描述+费率+数量)被录进>1张凭证。⚠ 汇总账单(一个发票号覆盖多票货)里同一费用项常合法分批录入，
   仅凭我方录入数据无法与"重复录入"区分，必须对供应商发票原件人工核对。
   max_gap_hours=完全相同行的录入间隔小时：≈0 多为分批作业，隔小时/隔天才可疑。
   extra_amount=疑似已付敞口(待核)。已排除分期(合计份数≤1)、按量分批(数量不同)、多箱(单凭证)。';


CREATE VIEW mart.alert_duplicate_payment AS
SELECT 'duplicate_payment'::text                                            AS alert_code,
       'dup:' || pay_to_id || ':' || invoice_no || ':' || shipment_id       AS dedup_key,
       NULL::bigint                                                         AS entity_id,
       shipment_id,
       CASE WHEN extra_amount >= 5000 THEN 'critical' ELSE 'serious' END    AS severity,
       extra_amount                                                        AS amount,
       COALESCE(vendor_name, '供应商#' || pay_to_id) || ' 发票 ' || invoice_no
         || ' 同一提单疑似重复实付 '
         || to_char(extra_amount, 'FM999,999,999') || '（待核对发票原件）'      AS subject_zh,
       COALESCE(vendor_name, 'Vendor #' || pay_to_id) || ' invoice ' || invoice_no
         || ' possible duplicate paid ' || to_char(extra_amount, 'FM999,999,999')
         || ' on the same file (verify against invoice)'                    AS subject_en,
       to_jsonb(d.*)                                                       AS detail_json
FROM mart.duplicate_payment d
WHERE extra_amount > 0
  AND last_entered >= now() - interval '14 days';

GRANT SELECT ON mart.duplicate_payment, mart.alert_duplicate_payment TO fs_app, fs_read;
