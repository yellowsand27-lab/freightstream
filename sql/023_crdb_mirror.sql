-- =============================================================================
-- 023 —— CR/DB 代理对账单入镜像，并修正「成本未转嫁」口径（第 5 次口径纠偏）
--
-- 执行身份：fs_owner（DDL）
--   本地：psql -U fs_owner -d freightstream -f sql/023_crdb_mirror.sql
--   生产：sudo -u postgres psql -d freightstream -c 'SET ROLE fs_owner;' -f ...
--   ⚠ 执行顺序（三步，缺一不可）：
--     ① 本文件（建表 + 重建视图/物化视图）
--     ② .venv/bin/python etl/refresh_mirror.py --tables crdb_notes,crdb_lines   ← 约 4 分钟
--     ③ psql -c "SELECT * FROM mart.refresh_all()"   ← 重建 op_file，否则记分卡仍是旧缺口
--     ①建的 op_file 是在空表上算的，必须经③才带上修正后的数字。
--
-- 背景（2026-09-25 探查源库发现的最大盲区）：
--   `T_CRDBHD`/`T_CRDBDETAIL` 是**与海外代理/关联公司的贷项借项对账单**，
--   一直没进镜像，而它才是多数提单的收支载体：
--     近两年 18,188 票里 94%(17,128) 有 CR/DB，只有 42%(7,680) 有应收发票；
--     54%(9,820) 只有 CR/DB 没有应收发票 —— 就是分析里"只见成本、假负毛利"的那群。
--
--   结构（已验证）：明细行带 F_Debit/F_Credit（向代理借记/贷记）、F_Revenue/F_Cost，
--   且 F_STBName='T_OPACCT' —— CR/DB 行由操作台账生成。恒等式
--   `F_Total = Σ借 − Σ贷` 在 2024 年起 41,409 单上 100% 吻合。
--   实例 HBL DGSS20222386：海运 $146,300 在 T_APDETAIL 找不到，因为它经
--   TKI-CR/DR064405 贷记给了代理 DGS LOGISTICS（借 635 − 贷 146,335 = -145,700 ✓）。
--
-- 本次修什么：`mart.unrecovered_cost` 原来只认"开给客户的应收发票"算转嫁，
--   把"经 CR/DB 向代理借记收回"误判成没转嫁。按记分卡口径实测近 12 月
--   1,233 行 / $361,369 中 **约 60%（$217,690 / 402 票）**有同类同额借记（≥95%），
--   duty 类 **94%** 是误报。实证：TKIBIMIAS041764 判「duty 未转嫁 $17,426」，
--   CR/DB 里 DUTY & FEE 借记 $17,426，分毫不差。
--
-- 关键前提：**CR/DB 与应收/应付用的是同一套费用代码**（DUTY.OI / CHASSIS.OI /
--   STORAGE.OI …），可直接接 `ref.charge_class`，所以"同类"是有定义的，
--   不需要另建映射表。这一点已核过，不是假设。
--
-- 为什么不把 CR/DB 塞进 mirror.charge_lines：那张表被 file_pl、duplicate_payment、
--   demurrage_penalty 等十几处直接 SUM，多一个 direction 会**静默改变**所有既有口径。
--   单独建表，由各 mart 视图显式选择是否纳入，改动范围可控。
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 0. 按依赖倒序拆掉本文件要重建的所有对象
--
--    依赖链：mart.op_file(物化视图) → mart.unrecovered_cost → mart.agent_rebill
--            → mirror.crdb_lines / crdb_notes
--    必须先拆下游再拆上游，否则 DROP 会被依赖挡住。不用 CASCADE——那会连带
--    删掉本文件管辖之外的对象而不自知，宁可把每个被重建的对象显式写出来。
--    重跑本文件是安全的（幂等），但**表会被重建成空表，之后必须重跑 ETL**。
-- ---------------------------------------------------------------------------

DROP MATERIALIZED VIEW IF EXISTS mart.op_file;
DROP VIEW  IF EXISTS mart.alert_unrecovered_cost;
DROP VIEW  IF EXISTS mart.unrecovered_cost;
DROP VIEW  IF EXISTS mart.agent_rebill;
DROP TABLE IF EXISTS mirror.crdb_lines;
DROP TABLE IF EXISTS mirror.crdb_notes;

-- ---------------------------------------------------------------------------
-- 1. 镜像表（忠实副本，不过滤作废单；口径判断留给 mart 层）
-- ---------------------------------------------------------------------------

-- 对账单头 T_CRDBHD
CREATE TABLE mirror.crdb_notes (
    note_id       integer PRIMARY KEY,              -- F_ID
    crdb_no       text,                             -- F_CrDbNo，如 TKI-CR/DR064405
    src_table     text,                             -- F_TBName：T_OIHMAIN=挂提单，T_GENMAIN=按周期
    src_id        integer,                          -- F_TBID → shipment_id
    agent_id      integer,                          -- F_Agent → companies（海外代理/关联公司）
    invoice_date  date,                             -- F_InvoiceDate
    due_date      date,
    post_date     date,
    paid_date     date,
    terms_days    integer,
    total_amt     numeric(18,2) NOT NULL DEFAULT 0, -- F_Total = Σ借 − Σ贷（已验证恒等）
    paid_amt      numeric(18,2) NOT NULL DEFAULT 0,
    profit_share  numeric(18,2) NOT NULL DEFAULT 0, -- F_ProfitShare
    settled       text,
    currency      text,
    void_flag     smallint NOT NULL DEFAULT 0,      -- 源系统 F_Void
    created_at    timestamp,
    created_by    text,
    updated_at    timestamp,
    updated_by    text
);
CREATE INDEX ON mirror.crdb_notes (src_table, src_id);
CREATE INDEX ON mirror.crdb_notes (agent_id);
CREATE INDEX ON mirror.crdb_notes (invoice_date);

COMMENT ON TABLE mirror.crdb_notes IS
  '与海外代理/关联公司的贷项借项对账单单头（源 T_CRDBHD）。
   total_amt>0=代理净欠我们，<0=我们净欠代理。挂提单的经 src_table=''T_OIHMAIN'' + src_id。';

-- 对账单明细 T_CRDBDETAIL
CREATE TABLE mirror.crdb_lines (
    line_id      integer PRIMARY KEY,               -- F_ID
    note_id      integer NOT NULL,                  -- F_CrDbHDID
    billing_code text,                              -- F_CRDBCODE，与 ref.charge_class 同一套编码
    description  text,
    debit        numeric(18,2) NOT NULL DEFAULT 0,  -- F_Debit：代理欠我们（= 向代理收回成本 / 收代理的费）
    credit       numeric(18,2) NOT NULL DEFAULT 0,  -- F_Credit：我们欠代理（= 代理垫付/代理应得）
    revenue      numeric(18,2) NOT NULL DEFAULT 0,  -- F_Revenue（多数为 0，主要载体是 debit/credit）
    cost         numeric(18,2) NOT NULL DEFAULT 0,  -- F_Cost（同上）
    rate         numeric(18,4),
    qty          numeric(18,4),
    profit_share text,                              -- F_PShare
    src_table    text,                              -- F_STBName，通常 'T_OPACCT'（操作台账行）
    src_id       integer,                           -- F_STBID
    currency     text,
    seq          integer
);
CREATE INDEX ON mirror.crdb_lines (note_id);
CREATE INDEX ON mirror.crdb_lines (billing_code);

COMMENT ON TABLE mirror.crdb_lines IS
  '代理对账单明细（源 T_CRDBDETAIL）。debit=向代理借记（我们收），credit=贷记（我们付）。
   billing_code 与 mirror.charge_lines 同一套编码，可直接 JOIN ref.charge_class。
   src_table 通常是 ''T_OPACCT''——这些行由操作台账生成，印证"台账是源头、
   对客户走发票、对代理走 CR/DB"的三段式结构。';

GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE ON mirror.crdb_notes, mirror.crdb_lines TO fs_etl;
GRANT SELECT ON mirror.crdb_notes, mirror.crdb_lines TO fs_app, fs_read;

-- ---------------------------------------------------------------------------
-- 2. 派生：每票每费用类别 向代理借记了多少（成本转嫁的第二条路径）
-- ---------------------------------------------------------------------------

CREATE VIEW mart.agent_rebill AS
SELECT n.src_id                              AS shipment_id,
       cc.class,
       sum(l.debit)                          AS agent_debit,
       sum(l.credit)                         AS agent_credit,
       count(*)                              AS lines,
       min(n.invoice_date)                   AS first_note_date,
       array_agg(DISTINCT n.crdb_no)         AS crdb_nos
FROM mirror.crdb_lines l
JOIN mirror.crdb_notes n ON n.note_id = l.note_id
JOIN ref.charge_class  cc ON cc.billing_code = l.billing_code
WHERE n.void_flag = 0
  AND n.src_table = 'T_OIHMAIN'
  AND n.src_id IS NOT NULL
GROUP BY n.src_id, cc.class;

COMMENT ON VIEW mart.agent_rebill IS
  '每票每费用类别向代理借记/贷记的金额。agent_debit 是"成本经代理对账收回"的部分——
   这是 unrecovered_cost 原来看不见的第二条转嫁路径。只含挂提单(T_OIHMAIN)的非作废对账单。';

GRANT SELECT ON mart.agent_rebill TO fs_app, fs_read;

-- ---------------------------------------------------------------------------
-- 3. 重建 mart.unrecovered_cost —— 转嫁 = 开给客户的应收 + 向代理的借记
--
--    列的前缀（shipment_id … recovery_state, created_at）保持原顺序不变，
--    末尾新增 agent_debit / gross_gap，这样 alert_unrecovered_cost、/costs 页面、
--    mart.op_file 等依赖方不用改就能拿到修正后的 gap。
-- ---------------------------------------------------------------------------

CREATE VIEW mart.unrecovered_cost AS
WITH ap AS (
    SELECT cl.src_id AS shipment_id, cc.class,
           sum(cl.amount) AS ap_amount, count(*) AS ap_lines
    FROM mirror.charge_lines cl
    JOIN ref.charge_class cc ON cc.billing_code = cl.billing_code
    WHERE cl.direction = 'ap' AND cl.void_flag = 0
      AND cl.src_table = 'T_OIHMAIN' AND cc.passthrough_expected
    GROUP BY cl.src_id, cc.class
),
ar AS (
    SELECT cl.src_id AS shipment_id, cc.class, sum(cl.amount) AS ar_amount
    FROM mirror.charge_lines cl
    JOIN ref.charge_class cc ON cc.billing_code = cl.billing_code
    WHERE cl.direction = 'ar' AND cl.void_flag = 0 AND cl.src_table = 'T_OIHMAIN'
    GROUP BY cl.src_id, cc.class
),
has_ar AS (
    SELECT DISTINCT src_id AS shipment_id
    FROM mirror.charge_lines
    WHERE direction = 'ar' AND void_flag = 0 AND src_table = 'T_OIHMAIN'
),
calc AS (
    SELECT ap.shipment_id,
           ap.class,
           ap.ap_amount,
           COALESCE(ar.ar_amount, 0)     AS ar_amount,
           COALESCE(ag.agent_debit, 0)   AS agent_debit,
           (ha.shipment_id IS NOT NULL)  AS has_ar_invoice
    FROM ap
    LEFT JOIN ar ON ar.shipment_id = ap.shipment_id AND ar.class = ap.class
    LEFT JOIN mart.agent_rebill ag ON ag.shipment_id = ap.shipment_id AND ag.class = ap.class
    LEFT JOIN has_ar ha ON ha.shipment_id = ap.shipment_id
)
SELECT c.shipment_id,
       s.hbl_no,
       s.operator,
       em.entity_id,
       e.entity_name,
       e.business_model,
       c.class,
       c.ap_amount,
       c.ar_amount,
       -- gap 现在是「扣掉代理借记之后」的真实缺口（第 5 次纠偏，2026-09-25）
       c.ap_amount - c.ar_amount - c.agent_debit          AS gap,
       CASE
         -- 代理那边收回了大头：本就不是漏收
         WHEN c.agent_debit > 0
          AND c.ar_amount + c.agent_debit >= c.ap_amount * 0.9 THEN 'recovered_via_agent'
         WHEN c.ar_amount + c.agent_debit >= c.ap_amount * 0.9 THEN 'recovered'
         WHEN NOT c.has_ar_invoice AND c.agent_debit = 0      THEN 'no_ar_invoice'
         -- 整票没有客户账单、代理只借记了一部分：**故意不算漏收**。
         -- 没有客户账单本身就说明这票走的是代理结算（老口径的 no_ar_invoice 同理），
         -- 差额更可能是定价结构（实测：我方付 chassis $1,800、只向代理收 $160）
         -- 而不是忘了转嫁。单列一个状态让它可见、可钻取，但不进"漏收"口径——
         -- 沿用 RUNBOOK 的通用规律：宁可漏也别把正常业务误标。
         -- 实测近 12 月 direct：105 行 / $19,250。
         WHEN NOT c.has_ar_invoice                            THEN 'agent_partial'
         WHEN c.ar_amount + c.agent_debit = 0                 THEN 'not_rebilled'
         ELSE 'under_rebilled'
       END                                                AS recovery_state,
       s.created_at,
       -- 新增列（放末尾，不打乱既有顺序）
       c.agent_debit,
       c.ap_amount - c.ar_amount                          AS gross_gap  -- 修正前的老口径，便于对比
FROM calc c
LEFT JOIN mirror.shipments  s ON s.shipment_id = c.shipment_id
LEFT JOIN ref.entity_member em ON em.company_id = s.customer_id
LEFT JOIN ref.entity         e ON e.entity_id  = em.entity_id;

COMMENT ON VIEW mart.unrecovered_cost IS
  '成本转嫁缺口。**转嫁有两条路径**：开给客户的应收发票(ar_amount) 与
   向海外代理的对账借记(agent_debit，见 mart.agent_rebill)。gap = 成本 − 两者之和。
   gross_gap 是只看应收的旧口径，留作对比——实测旧口径约 60% 是误报(duty 类 94%)。
   只有 business_model=''direct'' 且 recovery_state=''not_rebilled''/''under_rebilled''
   才是真的漏收。其余状态：''recovered_via_agent''=经代理对账收回；
   ''agent_partial''=整票无客户账单、代理只借记一部分(多为定价结构，不算漏收)；
   ''no_ar_invoice''=整票无应收且无代理借记，多为代理周期结算。';

-- 告警视图跟着重建（定义保持 007 调优后的口径：客户级聚合 + 近 12 月 + 缺口≥1000）
CREATE VIEW mart.alert_unrecovered_cost AS
SELECT 'unrecovered_cost'::text                        AS alert_code,
       u.entity_id,
       u.entity_name,
       count(*)                                        AS shipments,
       sum(u.gap)                                      AS total_gap,
       max(u.created_at)                               AS latest_file
FROM mart.unrecovered_cost u
WHERE u.business_model = 'direct'
  AND u.recovery_state IN ('not_rebilled', 'under_rebilled')
  AND u.gap >= 100
  AND u.created_at >= now() - interval '12 months'
GROUP BY u.entity_id, u.entity_name
HAVING sum(u.gap) >= 1000;

COMMENT ON VIEW mart.alert_unrecovered_cost IS
  '成本未转嫁告警：客户级聚合、近 12 月、缺口≥1000。gap 已扣除向代理的对账借记（023 修正）。';

GRANT SELECT ON mart.unrecovered_cost, mart.alert_unrecovered_cost TO fs_app, fs_read;

-- ---------------------------------------------------------------------------
-- 4. 重建 mart.op_file（022 建的记分卡底表）—— 它 SUM 了 unrecovered_cost.gap，
--    口径变了就必须重建；同时新增 unrec_agent_debit 列，让页面能说明"已向代理收回多少"。
-- ---------------------------------------------------------------------------

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
inv AS (
    SELECT src_id AS shipment_id, sum(invoice_amt) AS ar_billed, min(invoice_date) AS first_invoice_date
    FROM mirror.invoices
    WHERE src_table = 'T_OIHMAIN' AND void_flag = 0 AND src_id IS NOT NULL
    GROUP BY src_id
),
ap AS (
    SELECT src_id AS shipment_id, sum(amount) AS ap_cost
    FROM mirror.charge_lines
    WHERE src_table = 'T_OIHMAIN' AND direction = 'ap' AND void_flag = 0 AND src_id IS NOT NULL
    GROUP BY src_id
),
unrec AS (
    SELECT shipment_id, sum(gap) AS unrec_gap, count(*) AS unrec_items
    FROM mart.unrecovered_cost
    WHERE business_model = 'direct' AND recovery_state IN ('not_rebilled', 'under_rebilled')
      AND gap > 0
    GROUP BY shipment_id
),
-- 该票总共经代理对账收回了多少（全类别），用于页面解释"为什么缺口变小了"
agent AS (
    SELECT shipment_id, sum(agent_debit) AS agent_debit
    FROM mart.agent_rebill GROUP BY shipment_id
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
           count(*)            AS dup_groups,
           sum(extra_amount)   AS dup_extra,
           max(max_gap_hours)  AS dup_max_gap_hours
    FROM mart.duplicate_payment
    WHERE shipment_id IS NOT NULL
    GROUP BY shipment_id
)
SELECT b.shipment_id, b.hbl_no, b.operator, b.month, b.file_opened, b.created_at, b.eta,
       b.customer_id, b.entity_id, b.entity_name, b.business_model,
       i.first_invoice_date,
       (i.first_invoice_date - b.file_opened)                       AS lag_days,
       COALESCE(i.ar_billed, 0)                                     AS ar_billed,
       COALESCE(a.ap_cost, 0)                                       AS ap_cost,
       (COALESCE(a.ap_cost, 0) > 0)                                 AS has_cost,
       COALESCE(u.unrec_gap, 0)                                     AS unrec_gap,
       COALESCE(u.unrec_items, 0)::int                              AS unrec_items,
       COALESCE(ag.agent_debit, 0)                                  AS agent_debit,
       COALESCE(d.dem_paid, 0)                                      AS dem_paid,
       COALESCE(d.dem_recovered, 0)                                 AS dem_recovered,
       COALESCE(p.dup_groups, 0)::int                               AS dup_groups,
       COALESCE(p.dup_extra, 0)                                     AS dup_extra,
       p.dup_max_gap_hours
FROM base b
LEFT JOIN inv   i  ON i.shipment_id  = b.shipment_id
LEFT JOIN ap    a  ON a.shipment_id  = b.shipment_id
LEFT JOIN unrec u  ON u.shipment_id  = b.shipment_id
LEFT JOIN agent ag ON ag.shipment_id = b.shipment_id
LEFT JOIN dem   d  ON d.shipment_id  = b.shipment_id
LEFT JOIN dup   p  ON p.shipment_id  = b.shipment_id;

CREATE UNIQUE INDEX op_file_pkey  ON mart.op_file (shipment_id);
CREATE INDEX op_file_op_month_idx ON mart.op_file (operator, month);
CREATE INDEX op_file_month_idx    ON mart.op_file (month);

COMMENT ON MATERIALIZED VIEW mart.op_file IS
  '操作员绩效记分卡的逐票底表（022 建，023 修正成本转嫁口径并加 agent_debit 列）。
   每行=一票，归属到 shipments.operator(操作归属人，非录单人 created_by)，归属月=建单月。
   unrec_gap 已扣除向海外代理的对账借记；agent_debit=该票经 CR/DB 向代理收回的总额。
   ⚠ 金额类指标只对 business_model=''direct'' 成立，由查询端过滤。
   ⚠ 不含毛利——每票成本口径待业务方确认（见 RUNBOOK 第 7、13 节）。
   ⚠ 与 mart.staff_activity 口径不同(那张按 created_by)，两者数字不可互相对照。
   物化视图，由 mart.refresh_all() 在每晚 ETL 后重建。';

GRANT SELECT ON mart.op_file TO fs_app, fs_read;
