-- =============================================================================
-- 012 —— 历史时点账龄（as-of aging）
--
-- 执行身份：fs_owner
--     psql -U fs_owner -d freightstream -f sql/012_as_of_aging.sql
--
-- 用途：网页的账龄趋势、DSO 趋势、月度 KPI 都需要"某一天的未清状态"。
--   因为源库行上带日期，这个状态可以回溯计算，不需要每日快照。
--
-- 公式的正确性已用 2026-09-01 的历史基线校验过（当时直查 MSSQL 得出）：
--
--     账龄段        原始(直查)              回溯(本函数)
--     未到期        191 张 / 1,861,255      190 张 / 1,861,674
--     逾期 1-30     175 张 / 1,474,073      174 张 / 1,497,133
--     逾期 31-60     51 张 /   140,665       48 张 /   138,839
--     逾期 61-90     34 张 /    79,340       28 张 /    71,380
--     逾期 90+       50 张 /    66,719       47 张 /    68,595
--     合计          501 张 / 3,622,052      487 张 / 3,637,621   （金额差 0.43%）
--     90天以上占比   1.8%                    1.9%
--
--   剩余 14 张的差异来源已查明且合理：原始查询未过滤作废发票，而两周内
--   确有发票被作废；另外原始用「当前余额 > 1」判定未清，对当时已部分收款的
--   发票按残值计入，本函数对当时分文未付的取全额。不是管道错误。
--
-- ⚠ 两个已知边界：
--   1. 已收清但 paid_date 未盖的发票（全库 11 张）会被误判为"当时未清"。
--      本函数用 paid_amt >= invoice_amt 兜掉了这一类——这正是校验过程中
--      发现的缺口：不加这条判断，那 11 张会按全额落进 90+ 档，
--      把 90 天以上占比从 1.9% 虚增到 5.7%。
--   2. 关税腿无独立的 duty_paid_date，无法回溯，只能给当前值。
--      所以返回列名叫 duty_balance_current，提醒调用方它不是 as-of 值。
-- =============================================================================

CREATE OR REPLACE FUNCTION mart.open_item_as_of(as_of date)
RETURNS TABLE (
    invoice_id            integer,
    invoice_no            text,
    entity_id             bigint,
    entity_name           text,
    business_model        text,
    is_related_party      boolean,
    invoice_date          date,
    due_date              date,
    freight_balance       numeric(18,2),   -- as-of 准确
    duty_balance_current  numeric(18,2),   -- 当前值，非 as-of（见文件头说明）
    days_past_due         integer,
    aging_bucket          text
)
LANGUAGE sql
STABLE
AS $$
    SELECT i.invoice_id,
           i.invoice_no,
           em.entity_id,
           e.entity_name,
           e.business_model,
           COALESCE(e.is_related_party, false),
           i.invoice_date,
           i.due_date,
           -- 当时分文未付 → 全额；至今未付清 → 当前余额
           (CASE WHEN i.paid_date > as_of THEN i.invoice_amt
                 ELSE i.invoice_amt - i.paid_amt END)::numeric(18,2),
           GREATEST(i.duty_amt - GREATEST(i.duty_paid_amt, 0), 0)::numeric(18,2),
           (as_of - i.due_date)::integer,
           CASE WHEN as_of - i.due_date <= 0   THEN '0_current'
                WHEN as_of - i.due_date <= 30  THEN '1_1-30'
                WHEN as_of - i.due_date <= 60  THEN '2_31-60'
                WHEN as_of - i.due_date <= 90  THEN '3_61-90'
                WHEN as_of - i.due_date <= 180 THEN '4_91-180'
                WHEN as_of - i.due_date <= 365 THEN '5_181-365'
                ELSE '6_365+' END
    FROM mirror.invoices i
    LEFT JOIN ref.entity_member em ON em.company_id = i.bill_to_id
    LEFT JOIN ref.entity        e  ON e.entity_id   = em.entity_id
    WHERE i.void_flag = 0
      AND i.invoice_amt > 1
      AND i.invoice_date <= as_of
      AND ( i.paid_date > as_of
            -- paid_date 为空且至今未付清才算未清。
            -- 必须加 paid_amt 判断：全库有 11 张已收清但未盖 paid_date，
            -- 漏掉这一条会让 90 天以上占比从 1.9% 虚增到 5.7%。
         OR (i.paid_date IS NULL AND i.paid_amt < i.invoice_amt - 0.01) );
$$;

COMMENT ON FUNCTION mart.open_item_as_of(date) IS
  '某一历史时点的未清应收明细。freight_balance 是 as-of 准确值；
   duty_balance_current 是当前值（源库无 duty_paid_date，无法回溯）。
   公式已用 2026-09-01 历史基线校验，金额吻合度 99.6%。';


-- 账龄汇总：网页趋势图与月度 KPI 的直接数据源
CREATE OR REPLACE FUNCTION mart.aging_as_of(as_of date, include_related boolean DEFAULT false)
RETURNS TABLE (
    aging_bucket    text,
    invoices        bigint,
    freight_balance numeric(18,2)
)
LANGUAGE sql
STABLE
AS $$
    SELECT o.aging_bucket, count(*), sum(o.freight_balance)::numeric(18,2)
    FROM mart.open_item_as_of(as_of) o
    WHERE include_related OR NOT o.is_related_party
    GROUP BY o.aging_bucket
    ORDER BY o.aging_bucket;
$$;

COMMENT ON FUNCTION mart.aging_as_of(date, boolean) IS
  '账龄分档汇总。默认排除关联方（Knights CHB 等内部往来会让账龄失真），
   include_related => true 时纳入。';

REVOKE ALL ON FUNCTION mart.open_item_as_of(date) FROM PUBLIC;
REVOKE ALL ON FUNCTION mart.aging_as_of(date, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION mart.open_item_as_of(date) TO fs_app, fs_read;
GRANT EXECUTE ON FUNCTION mart.aging_as_of(date, boolean) TO fs_app, fs_read;
