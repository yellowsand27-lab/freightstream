-- ---------------------------------------------------------------------------
-- 024 —— 修复 mart.alert_unrecovered_cost 的列契约（2026-09-29）
--
-- 症状：生产首页打开后 KPI 卡与告警工作台永远停在骨架屏；告警页表格也空。
--
-- 原因：023 重建 mart.unrecovered_cost 时顺带重建了这个告警视图，但只写成了一个
--       「实体 / 票数 / 总缺口」的汇总形状（alert_code, entity_id, entity_name,
--       shipments, total_gap, latest_file），把五个告警视图共用的列契约
--       （alert_code, dedup_key, entity_id, shipment_id, severity, amount,
--        subject_zh, subject_en, detail_json）丢了。023 自己的注释写的是
--       「定义保持 007 调优后的口径」——是重建时漏了，不是有意改口径。
--
--       两个消费方因此整个 500：
--         GET /api/overview  —— UNION 里 SELECT amount 找不到列
--         GET /api/alerts    —— SELECT * UNION ALL 五视图，列数 9 vs 6 不一致
--       而前端 Overview 的 api.get(...).then(setD) 没有 .catch，请求一失败
--       d 永远是 null，于是整页 loading={!d} 的卡片全部卡在骨架屏。
--
-- 修复：按 007 的定义原样恢复（口径不变：客户级聚合 + 近 12 月 +
--       按 charge_class 的 min_alert_amount 逐类过滤 + 客户级缺口≥1000），
--       底表仍是 023 修正过的 mart.unrecovered_cost，所以 023 的
--       「转嫁 = 应收 + 代理借记」纠偏继续生效。
--       detail_json 的逐票明细里补一个 agent_debit，让页面能说明
--       「这票已经向代理收回了多少」——这正是 023 想让人看见的东西。
--
-- 身份：fs_owner。幂等，可重跑。
-- ---------------------------------------------------------------------------

DROP VIEW IF EXISTS mart.alert_unrecovered_cost;

CREATE VIEW mart.alert_unrecovered_cost AS
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
               'agent_debit', u.agent_debit,
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

COMMENT ON VIEW mart.alert_unrecovered_cost IS
  '成本未转嫁告警：客户级聚合、近 12 月、逐类阈值 GREATEST(min_alert_amount,200)、客户级缺口≥1000。
   与另外四个 alert_* 视图共用同一列契约（alert_code/dedup_key/entity_id/shipment_id/
   severity/amount/subject_zh/subject_en/detail_json）——/api/alerts 是 SELECT * UNION ALL，
   改这个视图的列一定会连带打断另外四个。gap 已扣除向代理的对账借记（023 修正）。';

GRANT SELECT ON mart.alert_unrecovered_cost TO fs_app, fs_read;
