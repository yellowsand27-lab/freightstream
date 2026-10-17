-- =============================================================================
-- 022 —— 操作员绩效记分卡（OP scorecard）
--
-- 执行身份：fs_owner（DDL）
--   本地：psql -U fs_owner -d freightstream -f sql/022_op_scorecard.sql
--   生产：sudo -u postgres psql -d freightstream -c 'SET ROLE fs_owner;' -f ...
--
-- 为什么做这个：单票精确成本在此 ERP 下算不准（T_OPACCT 操作台账与 T_APDETAIL
--   财务凭证互相矛盾，同一票各记一半成本，已发信问业务方确认权威表）。
--   但「衡量 OP 干得好不好」不必等那个答案——除毛利外的四个维度数据都干净：
--     1. 产出量   建单票数 / 服务客户数            (mirror.shipments，operator 覆盖 99.9%)
--     2. 开票时效 建单→首次开票天数               (已知全库中位 24 天)
--     3. 成本转嫁 该转嫁却没转嫁的成本缺口         (mart.unrecovered_cost)
--     4. 滞期回收 滞期/仓储费付出 vs 收回          (mart.demurrage_penalty，100% 挂提单，可靠)
--     5. 录入质量 疑似重复录入的应付               (mart.duplicate_payment，疑似清单非判决)
--   毛利列等业务方确认成本口径后再加进来，届时只需给本视图加一列。
--
-- 归属规则：一律按 `mirror.shipments.operator`（该票的操作归属人），
--   **不是** `created_by`（录单人）。二者不同域：operator 171 个值 / created_by 189 个，
--   仅 149 重合。`mart.staff_activity`（数据分析页的"员工产出"）用的是 created_by，
--   口径不同，两张表的数字不应互相对照——本视图的注释与页面提示都写明了这一点。
--
-- 归属月份：一律用该票的**建单月** `created_at`。这样一票在所有指标里只落在
--   同一个月，跨指标可以相加；若按各自的费用发生日归属，同一票会散到多个月。
--
-- ⚠ 口径红线（沿用 RUNBOOK 第 7 节的三次纠偏）：
--   · 金额类指标（成本转嫁、滞期回收）**只算 direct 自营**。agency 按周期批量结算、
--     单票无应收，混进来会产生假缺口（滞期那项曾因此虚报 $11.2M，实为 $945K）。
--   · 开票时效同理要按 business_model 分流看；本视图逐票给出 business_model，
--     由查询端过滤，视图本身不预先丢数据。
--   · 疑似重复是**待人工核**的线索，不是"这个人多付了钱"的结论。
--   · 提柜及时率做不了：pickup_date 覆盖仅 0.9%（见 mart.container_dwell 注释）。
--
-- 粒度选择：**每票一行**，不是每人每月一行。理由是中位数不能由月度中位数再聚合
--   （median of medians 是错的），必须在查询端按所选窗口对原始行算 percentile_cont。
--   每票一行同时把钻取列表免费给出来了。
--
-- 为什么物化：底层 mart.unrecovered_cost / demurrage_penalty 每次都要扫 charge_lines(75.8 万行)，
--   直接建普通视图时一次记分卡查询 1.7s，而页面要并发发四五个请求。物化后 84,127 行 ~40ms。
--   代价是数据只在 ETL 后刷新（每晚 03:00 UTC）——与 mart.payment_baseline 同一模式，
--   已挂进 mart.refresh_all()。
--   ⚠ 因此**不存** unbilled_days 这类"距今天数"，只存 first_invoice_date/file_opened，
--     未开票天数由查询端用 CURRENT_DATE 现算，避免刷新间隔内给出昨天的账龄。
-- =============================================================================

-- 幂等清理：本文件早期版本曾把 op_file 建成普通视图，
-- 而 DROP VIEW 删不了物化视图、DROP MATERIALIZED VIEW 也删不了普通视图（都会报错），
-- 所以按 relkind 判断再删，重跑本文件不会中断。
DO $$
DECLARE k "char";
BEGIN
    SELECT c.relkind INTO k
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'mart' AND c.relname = 'op_file';
    IF    k = 'v' THEN EXECUTE 'DROP VIEW mart.op_file';
    ELSIF k = 'm' THEN EXECUTE 'DROP MATERIALIZED VIEW mart.op_file';
    END IF;
END $$;

CREATE MATERIALIZED VIEW mart.op_file AS
WITH base AS (
    SELECT s.shipment_id,
           s.hbl_no,
           btrim(s.operator)                        AS operator,
           s.created_at,
           s.created_at::date                       AS file_opened,
           date_trunc('month', s.created_at)::date  AS month,
           s.customer_id,
           s.eta,
           e.entity_id,
           e.entity_name,
           COALESCE(e.business_model, 'unknown')    AS business_model
    FROM mirror.shipments s
    LEFT JOIN ref.entity_member em ON em.company_id = s.customer_id
    LEFT JOIN ref.entity        e  ON e.entity_id   = em.entity_id
    WHERE s.created_at IS NOT NULL
      AND btrim(COALESCE(s.operator, '')) <> ''
      AND btrim(s.operator) NOT IN (SELECT user_id FROM ref.system_account)
),
-- 已开应收：按单开票口径（T_GENMAIN 周期结算不归单票，与 mart.billing_lag 一致）
inv AS (
    SELECT src_id                AS shipment_id,
           sum(invoice_amt)      AS ar_billed,
           min(invoice_date)     AS first_invoice_date
    FROM mirror.invoices
    WHERE src_table = 'T_OIHMAIN' AND void_flag = 0 AND src_id IS NOT NULL
    GROUP BY src_id
),
-- 是否已发生应付成本：没成本的空壳单/作废单催开票没有意义（告警调优时 8,093→3,910 的那一刀）
ap AS (
    SELECT src_id           AS shipment_id,
           sum(amount)      AS ap_cost
    FROM mirror.charge_lines
    WHERE src_table = 'T_OIHMAIN' AND direction = 'ap' AND void_flag = 0 AND src_id IS NOT NULL
    GROUP BY src_id
),
unrec AS (
    SELECT shipment_id, sum(gap) AS unrec_gap, count(*) AS unrec_items
    FROM mart.unrecovered_cost
    WHERE business_model = 'direct' AND recovery_state IN ('not_rebilled', 'under_rebilled')
    GROUP BY shipment_id
),
dem AS (
    SELECT shipment_id,
           sum(COALESCE(paid_out, 0))   AS dem_paid,
           sum(COALESCE(recovered, 0))  AS dem_recovered
    FROM mart.demurrage_penalty
    WHERE business_model = 'direct' AND shipment_id IS NOT NULL
    GROUP BY shipment_id
),
dup AS (
    SELECT shipment_id,
           count(*)                  AS dup_groups,
           sum(extra_amount)         AS dup_extra,
           max(max_gap_hours)        AS dup_max_gap_hours
    FROM mart.duplicate_payment
    WHERE shipment_id IS NOT NULL
    GROUP BY shipment_id
)
SELECT b.shipment_id,
       b.hbl_no,
       b.operator,
       b.month,
       b.file_opened,
       b.created_at,
       b.eta,
       b.customer_id,
       b.entity_id,
       b.entity_name,
       b.business_model,
       -- 1. 开票时效
       i.first_invoice_date,
       (i.first_invoice_date - b.file_opened)                       AS lag_days,
       COALESCE(i.ar_billed, 0)                                     AS ar_billed,
       COALESCE(a.ap_cost, 0)                                       AS ap_cost,
       (COALESCE(a.ap_cost, 0) > 0)                                 AS has_cost,
       -- 2. 成本转嫁缺口（direct 才有值）
       COALESCE(u.unrec_gap, 0)                                     AS unrec_gap,
       COALESCE(u.unrec_items, 0)::int                              AS unrec_items,
       -- 3. 滞期/仓储回收
       COALESCE(d.dem_paid, 0)                                      AS dem_paid,
       COALESCE(d.dem_recovered, 0)                                 AS dem_recovered,
       -- 4. 疑似重复录入（线索，非结论）
       COALESCE(p.dup_groups, 0)::int                               AS dup_groups,
       COALESCE(p.dup_extra, 0)                                     AS dup_extra,
       p.dup_max_gap_hours
FROM base b
LEFT JOIN inv   i ON i.shipment_id = b.shipment_id
LEFT JOIN ap    a ON a.shipment_id = b.shipment_id
LEFT JOIN unrec u ON u.shipment_id = b.shipment_id
LEFT JOIN dem   d ON d.shipment_id = b.shipment_id
LEFT JOIN dup   p ON p.shipment_id = b.shipment_id;

CREATE UNIQUE INDEX op_file_pkey  ON mart.op_file (shipment_id);
CREATE INDEX op_file_op_month_idx ON mart.op_file (operator, month);
CREATE INDEX op_file_month_idx    ON mart.op_file (month);

COMMENT ON MATERIALIZED VIEW mart.op_file IS
  '操作员绩效记分卡的逐票底表：每行=一票，归属到 shipments.operator(操作归属人，非录单人 created_by)，
   归属月=建单月。含开票时效(lag_days/unbilled_days)、成本转嫁缺口(unrec_gap)、
   滞期回收(dem_paid/dem_recovered)、疑似重复录入(dup_groups/dup_extra)。
   ⚠ 金额类指标只对 business_model=''direct'' 成立(agency 按周期结算、单票无应收)，
   由查询端过滤。⚠ 不含毛利——每票成本在此 ERP 下算不准，待业务方确认权威表后再加列。
   ⚠ 与 mart.staff_activity 口径不同(那张按 created_by 录单人)，两者数字不可互相对照。
   物化视图，由 mart.refresh_all() 在每晚 ETL 后重建。';

GRANT SELECT ON mart.op_file TO fs_app, fs_read;

-- ---------------------------------------------------------------------------
-- 挂进夜间刷新：005 建的 refresh_all() 原来只刷 payment_baseline，这里整体替换
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION mart.refresh_all()
RETURNS TABLE (view_name text, rows bigint, elapsed interval)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = mart, mirror, ref, pg_temp
AS $$
DECLARE
    t0 timestamptz;
    n  bigint;
BEGIN
    t0 := clock_timestamp();
    REFRESH MATERIALIZED VIEW mart.payment_baseline;
    SELECT count(*) INTO n FROM mart.payment_baseline;
    RETURN QUERY SELECT 'mart.payment_baseline'::text, n, clock_timestamp() - t0;

    t0 := clock_timestamp();
    REFRESH MATERIALIZED VIEW mart.op_file;
    SELECT count(*) INTO n FROM mart.op_file;
    RETURN QUERY SELECT 'mart.op_file'::text, n, clock_timestamp() - t0;
END;
$$;

REVOKE ALL ON FUNCTION mart.refresh_all() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION mart.refresh_all() TO fs_etl, fs_app;

COMMENT ON FUNCTION mart.refresh_all() IS
  'ETL 结束后调用，重建派生物化视图(payment_baseline + op_file)。SECURITY DEFINER，仅授予 fs_etl / fs_app。';
