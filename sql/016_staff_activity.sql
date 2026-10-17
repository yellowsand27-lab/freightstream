-- =============================================================================
-- 016 —— 员工产出分析支撑
--
-- 执行身份：fs_owner
--     psql -U fs_owner -d freightstream -f sql/016_staff_activity.sql
--
-- 员工每日产出来自镜像的审计字段（created_by / created_at，三张表 100% 覆盖）。
-- 只统计"新建"这类可靠事件——源库只存首建(U1)与最后改(U2)，不存每次操作，
-- 所以这是"产出量"，不是"全部操作明细"。
--
-- 系统账号（如 AMS 自动报文生成）要从"员工"里排除，用一张可维护表管理。
-- =============================================================================

CREATE TABLE ref.system_account (
    user_id text PRIMARY KEY,   -- 对应 created_by / F_U1ID
    note    text
);
INSERT INTO ref.system_account (user_id, note) VALUES
    ('AMS', 'AMS auto-generated vouchers, not a person')
ON CONFLICT (user_id) DO NOTHING;

GRANT SELECT, INSERT, UPDATE, DELETE ON ref.system_account TO fs_app;
GRANT SELECT ON ref.system_account TO fs_read;
-- 纳入变更审计（依赖 009 的 ref.log_change）
CREATE TRIGGER audit_system_account
    AFTER INSERT OR UPDATE OR DELETE ON ref.system_account
    FOR EACH ROW EXECUTE FUNCTION ref.log_change('{user_id}');

-- 统一"活动"视图：三类产出合成一张，便于按人×天聚合与钻取。
-- 只含真人（排除 system_account），只含有 created_by 的行。
CREATE OR REPLACE VIEW mart.staff_activity AS
SELECT 'shipment'::text            AS activity_type,
       s.shipment_id::bigint       AS ref_id,
       s.hbl_no                    AS ref_no,
       btrim(s.created_by)         AS staff,
       s.created_at                AS created_at,
       s.created_at::date          AS day,
       NULL::numeric               AS amount,
       s.customer_id               AS party_id
FROM mirror.shipments s
WHERE s.created_by IS NOT NULL AND btrim(s.created_by) <> ''
UNION ALL
SELECT 'invoice', i.invoice_id, i.invoice_no, btrim(i.created_by),
       i.created_at, i.created_at::date, i.invoice_amt, i.bill_to_id
FROM mirror.invoices i
WHERE i.created_by IS NOT NULL AND btrim(i.created_by) <> ''
UNION ALL
SELECT 'ap', v.voucher_id, v.invoice_no, btrim(v.created_by),
       v.created_at, v.created_at::date, v.invoice_amt, v.pay_to_id
FROM mirror.ap_vouchers v
WHERE v.created_by IS NOT NULL AND btrim(v.created_by) <> '';

COMMENT ON VIEW mart.staff_activity IS
  '员工产出明细：每条=某人某时刻新建的一张单（提单/应收/应付）。
   系统账号在查询处按 ref.system_account 排除。仅"新建"，非全部操作。';

GRANT SELECT ON mart.staff_activity TO fs_app, fs_read;
