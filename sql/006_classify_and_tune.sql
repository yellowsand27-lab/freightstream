-- =============================================================================
-- 006 —— 业务模式分类、额度种子、告警调优
--
-- 执行身份：fs_owner（含视图重建）
--     psql -U fs_owner -d freightstream -f sql/006_classify_and_tune.sql
--
-- 背景：003 跑完后五个告警视图有三个产出为 0。逐个诊断的结论是——
--   不是逻辑错，而是 ref 层还缺三样人工/派生资产。本文件补齐。
-- =============================================================================


-- =============================================================================
-- A 段 —— 业务模式分类（让 unrecovered_cost / billing_delay 可用）
--
-- 之前所有 18,110 家实体都是 unknown，而这两个告警只认 direct，所以恒为 0。
-- 好在业务模式可以从数据直接推导：应收发票挂在哪张业务表上——
--   T_OIHMAIN → 按提单开票 = 直客
--   T_GENMAIN → 按结算周期批量开票 = 代理
-- 实测：direct 2,792 家（78,804 张发票）/ agency 324 家（7,812 张）。
-- 无发票的实体保持 unknown，不参与任何单票级告警。
-- =============================================================================

WITH cls AS (
    SELECT em.entity_id,
           count(*) FILTER (WHERE i.src_table = 'T_OIHMAIN') AS per_file,
           count(*) FILTER (WHERE i.src_table = 'T_GENMAIN') AS per_cycle
    FROM mirror.invoices i
    JOIN ref.entity_member em ON em.company_id = i.bill_to_id
    WHERE i.void_flag = 0
    GROUP BY em.entity_id
)
UPDATE ref.entity e
SET business_model = CASE WHEN c.per_file >= c.per_cycle THEN 'direct' ELSE 'agency' END,
    note = COALESCE(e.note,'') || ' | business model inferred from billing table ('
           || c.per_file || ' per-file / ' || c.per_cycle || ' per-cycle)',
    updated_at = now()
FROM cls c
WHERE c.entity_id = e.entity_id
  -- 关联方与已人工确认的代理不被覆盖
  AND e.is_related_party = false
  AND e.business_model = 'unknown';


-- =============================================================================
-- B 段 —— 额度策略种子（让 credit_breach 可用）
--
-- ref.credit_policy 是空的，所以额度告警恒为 0。
-- 源库 18,177 家公司里有 104 家设了 F_CreditLimit，先把这批搬过来做起点。
-- ⚠ 这只是起点：源库那个字段开单时无任何校验，实测有额度的 5 家里 4 家
--   严重超限（最高 8.6 倍）。真正的额度需要业务重新核定。
-- =============================================================================

INSERT INTO ref.credit_policy (entity_id, credit_limit, warn_ratio, set_by, rationale)
SELECT em.entity_id,
       max(c.credit_limit),
       0.80,
       'seed_from_source',
       'Seed value imported from T_COMPANY.F_CreditLimit; to be re-assessed by the business'
FROM mirror.companies c
JOIN ref.entity_member em ON em.company_id = c.company_id
WHERE c.credit_limit > 0
GROUP BY em.entity_id
ON CONFLICT (entity_id) DO NOTHING;


-- =============================================================================
-- C 段 —— 重复付款：拆成「存量清理报表」与「新增告警」两件事
--
-- 原视图没有时间窗，覆盖 2007–2026 全部 925 组。
-- 925 条一次性推送出去，没人会看完——而且其中绝大多数是多年前的陈账，
-- 属于一次性清理工作，不属于日常告警。
-- 所以拆开：
--   mart.duplicate_payment        全量，供存量清理用
--   mart.alert_duplicate_payment  只报最近 14 天内新录入的，供日常告警用
-- =============================================================================

CREATE OR REPLACE VIEW mart.duplicate_payment AS
SELECT d.pay_to_id,
       c.full_name                              AS vendor_name,
       d.invoice_no,
       d.n                                      AS entry_count,
       d.each_amount,
       d.each_amount * (d.n - 1)                AS extra_amount,
       d.first_entered,
       d.last_entered,
       d.voucher_ids
FROM (
    SELECT v.pay_to_id, v.invoice_no, count(*) AS n,
           min(v.invoice_amt)                   AS each_amount,
           min(v.created_at)                    AS first_entered,
           max(v.created_at)                    AS last_entered,
           array_agg(v.voucher_id ORDER BY v.voucher_id) AS voucher_ids
    FROM mirror.ap_vouchers v
    WHERE v.void_flag = 0
      AND v.invoice_no IS NOT NULL AND btrim(v.invoice_no) <> ''
      AND v.invoice_amt > 0
    GROUP BY v.pay_to_id, v.invoice_no
    HAVING count(*) > 1 AND count(DISTINCT v.invoice_amt) = 1
) d
LEFT JOIN mirror.companies c ON c.company_id = d.pay_to_id;

COMMENT ON VIEW mart.duplicate_payment IS
  '同供应商 + 同发票号 + 同金额被多次录入。绝不能用金额匹配替代发票号——
   某提单 31 个箱的按箱拖车费会有 19 笔同额记录，发票号各不相同，那是正常计费。';

CREATE OR REPLACE VIEW mart.alert_duplicate_payment AS
SELECT 'duplicate_payment'::text                                        AS alert_code,
       'dup:' || d.pay_to_id || ':' || d.invoice_no                     AS dedup_key,
       NULL::bigint                                                     AS entity_id,
       NULL::integer                                                    AS shipment_id,
       CASE WHEN d.extra_amount >= 5000 THEN 'critical' ELSE 'serious' END AS severity,
       d.extra_amount                                                   AS amount,
       COALESCE(d.vendor_name,'供应商#'||d.pay_to_id) || ' 发票 ' || d.invoice_no
         || ' 被录入 ' || d.entry_count || ' 次，多出 '
         || to_char(d.extra_amount,'FM999,999,999')                     AS subject_zh,
       COALESCE(d.vendor_name,'Vendor #'||d.pay_to_id) || ' invoice ' || d.invoice_no
         || ' entered ' || d.entry_count || ' times, surplus '
         || to_char(d.extra_amount,'FM999,999,999')                     AS subject_en,
       to_jsonb(d)                                                      AS detail_json
FROM mart.duplicate_payment d
-- 只报新发生的：存量 925 组是一次性清理工作，不该进日常告警流
WHERE d.last_entered >= now() - interval '14 days';

GRANT SELECT ON mart.duplicate_payment, mart.alert_duplicate_payment TO fs_app, fs_read;
