-- =============================================================================
-- 007 —— 告警视图调优（基于真实数据的产出量实测）
--
-- 执行身份：fs_owner
--     psql -U fs_owner -d freightstream -f sql/007_tune_alerts.sql
--
-- 实测问题：006 之后五个告警的产出量是
--     credit_breach        9 条    ✓ 可用
--     payment_overdue     22 条    ✓ 可用
--     duplicate_payment    4 条    ✓ 可用（14 天窗口生效）
--     unrecovered_cost  4,868 条   ✗ 不可用
--     billing_delay     8,093 条   ✗ 不可用
--
-- 核心原则：【告警聚合，网页下钻】。
--   一个人要的是「客户 X 有 12 票共 8,400 未转嫁」，不是 12 封邮件。
--   逐票明细留在 mart.unrecovered_cost / mart.billing_lag 供网页展开，
--   告警视图只输出聚合后的行动项。
-- =============================================================================


-- =============================================================================
-- A 段 —— 额度预警：剔除垃圾额度值，修正百分比格式溢出
--
-- 源库里有 credit_limit = 1 这样的脏值，算出来是 6,086,300%，
-- 原格式掩码 FM990.0 直接溢出成 ###.#%。
-- 小于 100 的额度视为「未设置」，不参与告警。
-- =============================================================================

CREATE OR REPLACE VIEW mart.alert_credit_breach AS
SELECT 'credit_breach'::text                                            AS alert_code,
       'credit_breach:' || x.entity_id || ':' || to_char(CURRENT_DATE,'IYYY-IW') AS dedup_key,
       x.entity_id,
       NULL::integer                                                    AS shipment_id,
       CASE WHEN x.limit_utilization >= 1.0 THEN 'critical' ELSE 'warning' END AS severity,
       x.total_open                                                     AS amount,
       x.entity_name || ' 敞口 ' || to_char(x.total_open,'FM999,999,999')
         || ' / 额度 ' || to_char(x.credit_limit,'FM999,999,999')
         || '（' || to_char(x.limit_utilization*100,'FM99,999,990.0') || '%）' AS subject_zh,
       x.entity_name || ' exposure ' || to_char(x.total_open,'FM999,999,999')
         || ' of ' || to_char(x.credit_limit,'FM999,999,999')
         || ' limit (' || to_char(x.limit_utilization*100,'FM99,999,990.0') || '%)' AS subject_en,
       to_jsonb(x)                                                      AS detail_json
FROM mart.entity_exposure x
WHERE NOT x.is_related_party
  AND x.credit_limit >= 100          -- 小于 100 的是源库脏值，视为未设置
  AND x.limit_utilization >= x.warn_ratio;


-- =============================================================================
-- B 段 —— 成本未转嫁：聚合到客户级
--
-- 调优后实测：13 家客户 · 204 票 · 缺口 230,931
-- （原 4,868 条逐票告警，其中 chassis 5,629 / customs 6,755 这类
--   高频小额项把信号完全淹没了）
-- =============================================================================

CREATE OR REPLACE VIEW mart.alert_unrecovered_cost AS
WITH agg AS (
    SELECT u.entity_id,
           count(DISTINCT u.shipment_id)                         AS files,
           sum(u.gap)                                            AS gap_total,
           sum(u.ap_amount)                                      AS cost_total,
           max(u.created_at)                                     AS latest_file,
           jsonb_agg(jsonb_build_object(
               'shipment_id', u.shipment_id, 'hbl_no', u.hbl_no,
               'operator', u.operator, 'class', u.class,
               'ap_amount', u.ap_amount, 'gap', u.gap,
               'state', u.recovery_state)
               ORDER BY u.gap DESC)                              AS items
    FROM mart.unrecovered_cost u
    JOIN (SELECT class, min(min_alert_amount) AS min_alert_amount
          FROM ref.charge_class WHERE passthrough_expected GROUP BY class) cc
      ON cc.class = u.class
    WHERE u.business_model = 'direct'
      AND u.recovery_state IN ('not_rebilled','under_rebilled')
      AND u.gap >= GREATEST(cc.min_alert_amount, 200)
      -- 只看近 12 个月：更早的属于一次性存量清理，不该进日常告警流
      AND u.created_at >= CURRENT_DATE - INTERVAL '12 months'
    GROUP BY u.entity_id
    HAVING sum(u.gap) >= 1000           -- 客户级缺口不足千元的不打扰人
)
SELECT 'unrecovered_cost'::text                                         AS alert_code,
       'unrecovered:' || a.entity_id || ':' || to_char(CURRENT_DATE,'IYYY-MM') AS dedup_key,
       a.entity_id,
       NULL::integer                                                    AS shipment_id,
       CASE WHEN a.gap_total >= 20000 THEN 'critical'
            WHEN a.gap_total >= 5000  THEN 'serious'
            ELSE 'warning' END                                          AS severity,
       a.gap_total                                                      AS amount,
       e.entity_name || ' 有 ' || a.files || ' 票代垫成本未转嫁，缺口 '
         || to_char(a.gap_total,'FM999,999,999')                        AS subject_zh,
       e.entity_name || ': ' || a.files || ' files with advanced cost not rebilled, gap '
         || to_char(a.gap_total,'FM999,999,999')                        AS subject_en,
       jsonb_build_object('entity_name', e.entity_name, 'files', a.files,
                          'gap_total', a.gap_total, 'cost_total', a.cost_total,
                          'latest_file', a.latest_file, 'items', a.items) AS detail_json
FROM agg a
JOIN ref.entity e ON e.entity_id = a.entity_id;


-- =============================================================================
-- C 段 —— 开票超期：聚合到操作员，并只看真正异常的
--
-- 三处修正：
--   1. 阈值 30 → 45 天。实测近 24 个月已开票的中位延迟是 24 天，
--      30 天几乎等于中位数——那是常态不是例外，用它告警等于每天报一半的票。
--   2. 必须已发生应付成本。没有任何费用的票多是作废或空壳单，
--      催它开票没有意义（实测 8,093 票里有成本的是 3,910 票）。
--   3. 限定近 12 个月。更早的是历史存量，属一次性清理。
--
-- 调优后实测：12 名操作员 · 224 票（原 8,093 条逐票告警）
-- =============================================================================

CREATE OR REPLACE VIEW mart.alert_billing_delay AS
WITH pend AS (
    SELECT COALESCE(NULLIF(btrim(l.operator),''), '(未指派)')          AS operator,
           count(*)                                                    AS files,
           max(l.unbilled_days)                                        AS max_days,
           jsonb_agg(jsonb_build_object(
               'shipment_id', l.shipment_id, 'hbl_no', l.hbl_no,
               'entity_name', l.entity_name, 'file_opened', l.file_opened,
               'unbilled_days', l.unbilled_days)
               ORDER BY l.unbilled_days DESC)                          AS items
    FROM mart.billing_lag l
    WHERE l.business_model = 'direct'
      AND l.first_invoice_date IS NULL
      AND l.unbilled_days >= 45
      AND l.file_opened >= CURRENT_DATE - INTERVAL '12 months'
      AND EXISTS (SELECT 1 FROM mirror.charge_lines cl
                  WHERE cl.src_table = 'T_OIHMAIN' AND cl.src_id = l.shipment_id
                    AND cl.direction = 'ap' AND cl.void_flag = 0)
    GROUP BY 1
)
SELECT 'billing_delay'::text                                            AS alert_code,
       'billing:' || p.operator || ':' || to_char(CURRENT_DATE,'IYYY-IW') AS dedup_key,
       NULL::bigint                                                     AS entity_id,
       NULL::integer                                                    AS shipment_id,
       CASE WHEN p.max_days >= 180 THEN 'serious' ELSE 'warning' END    AS severity,
       NULL::numeric                                                    AS amount,
       p.operator || ' 有 ' || p.files || ' 票已发生成本但未开票，最久 '
         || p.max_days || ' 天'                                          AS subject_zh,
       p.operator || ': ' || p.files || ' files with costs booked but unbilled, oldest '
         || p.max_days || ' days'                                        AS subject_en,
       jsonb_build_object('operator', p.operator, 'files', p.files,
                          'max_days', p.max_days, 'items', p.items)      AS detail_json
FROM pend p;

GRANT SELECT ON mart.alert_credit_breach, mart.alert_unrecovered_cost,
                mart.alert_billing_delay TO fs_app, fs_read;
