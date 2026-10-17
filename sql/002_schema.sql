-- =============================================================================
-- FreightStream 分析库 —— 结构定义（锚定版 2026-09-15）
--
-- 执行身份：fs_owner，连 freightstream 库
--     psql -U fs_owner -d freightstream -f 002_schema.sql
--
-- 本文件对应的需求：
--   R1  独立分析库，与 FlowForge-AI 无关                → 本库自成一体，不引用 ff_* 任何对象
--   R2  FreightStream 生产库只读                        → mirror 是单向副本，没有任何回写路径
--   R3  网页呈现                                        → mart 层输出稳定契约给 Web
--   R4  邮件推送，可扩展 telegram / teams               → notify 层，渠道可插拔
--   R5  多维度分析（额度预警 / 回款滞期 / 错付款项 /
--       提柜延期 / 超期罚款）                           → mart.alert_* 与 mart 各主题视图
--   R6  Knights CHB 是关联方，但需单独做往来分析        → ref.entity.is_related_party
--                                                          + mart.related_party_ledger
--
-- 设计主线：按【数据生命周期】分 schema，而不是按业务模块分。
--   mirror  可整体重建   —— MSSQL 的影子，权威数据在对面
--   ref     人工资产     —— 花人力判断出来的结论，丢了要重新判断
--   ops     业务状态     —— 处理过程中产生的新事实
--   notify  投递状态     —— 谁在什么时候被通知了什么
--   mart    派生         —— 给 Web 和通知器用的视图
-- 规则一句话：只有 mirror 和 mart 允许被 DROP 重建，其余三个是权威数据。
-- =============================================================================

CREATE SCHEMA IF NOT EXISTS mirror;
CREATE SCHEMA IF NOT EXISTS ref;
CREATE SCHEMA IF NOT EXISTS ops;
CREATE SCHEMA IF NOT EXISTS notify;
CREATE SCHEMA IF NOT EXISTS mart;

COMMENT ON SCHEMA mirror IS 'MSSQL TRANSKNIGHTS 单向镜像。每次刷新整表替换，禁止人工写入。';
COMMENT ON SCHEMA ref    IS '人工维护的参考数据：实体合并、业务模式、额度策略、费用分类。ETL 永不覆盖。';
COMMENT ON SCHEMA ops    IS '处理工作流状态：案件与处理动作。应用写入。';
COMMENT ON SCHEMA notify IS '通知渠道、规则、收件人与投递记录。';
COMMENT ON SCHEMA mart   IS '派生视图，供 Web 与通知器查询。可重建。';


-- =============================================================================
-- mirror —— 源系统镜像
-- 不做任何口径过滤（作废单、异常值一律照搬），判断留给 mart 层。
-- 否则「这张单系统里有、报表里没有」会变成无法排查的问题。
-- =============================================================================

CREATE TABLE mirror.companies (
    company_id    integer PRIMARY KEY,                -- T_COMPANY.F_ID
    short_name    text,
    full_name     text,
    city          text,
    state         text,
    country       text,
    irs_no        text,                               -- 税号，实体合并的强信号
    sman_id       text,
    credit_limit  numeric(18,2) NOT NULL DEFAULT 0,
    terms_days    integer       NOT NULL DEFAULT 0,
    inactive      boolean       NOT NULL DEFAULT false,
    credit_hold   boolean       NOT NULL DEFAULT false,
    account_no    text
);
COMMENT ON COLUMN mirror.companies.credit_limit IS
  '源系统 18,139 家客户只有 104 家设了值，且开单时无任何校验。仅供参考，
   实际管控额度看 ref.credit_policy。';

-- 业务单（海运进口分单）。所有收付费用最终都挂在这一层。
CREATE TABLE mirror.shipments (
    shipment_id    integer PRIMARY KEY,               -- T_OIHMAIN.F_ID
    hbl_no         text,
    master_id      integer,                           -- F_OIMBLID → 主单
    customer_id    integer,
    invoice_to_id  integer,
    operator       text,                              -- F_Operator，覆盖 99.7%，考核与归因的地基
    sman_id        text,                              -- F_SManID，仅 8.7%，不足以做销售考核
    eta            date,                              -- F_FETA
    last_free_day  date,                              -- F_LastFreeday，仅 12.3%
    pickup_date    date,                              -- F_PickupDate，源库 0 条（字段在，从未录入）
    avail_date     date,                              -- F_AvialDate
    release_date   date,                              -- F_RLSDate
    notice_date    date,                              -- F_NOTICEDATE
    close_date     date,                              -- F_CloseDate
    created_at     timestamp,                         -- F_U1Date，100% 覆盖 → 流程时效的真实起点
    updated_at     timestamp,                         -- F_U2Date
    created_by     text,                              -- F_U1ID
    updated_by     text,                              -- F_U2ID
    file_closed    text,
    isf_no         text,
    custom_status  text,
    fda_hold       text
);
CREATE INDEX ON mirror.shipments (customer_id);
CREATE INDEX ON mirror.shipments (operator);
CREATE INDEX ON mirror.shipments (created_at);
CREATE INDEX ON mirror.shipments (last_free_day) WHERE last_free_day IS NOT NULL;

-- 集装箱。提柜/还箱节点覆盖率极低（提柜日 1,187/134,591 = 0.9%），
-- 但 mart.container_dwell 会把覆盖率一起报出来，避免拿空数据做结论。
CREATE TABLE mirror.containers (
    container_row_id integer PRIMARY KEY,             -- T_OIMCONTAINER.F_ID
    master_id        integer,                         -- F_OIMBLID
    container_no     text,
    container_type   text,
    last_free_day    date,
    pickup_date      date,                            -- F_PUDATE
    out_date         date,                            -- F_OutDate 出场
    in_date          date,                            -- F_Indate 进场
    empty_return     date,                            -- F_EmptyReturn 还空
    ata              date,                            -- 实际到港
    carrier_release  date,
    customs_release  date
);
CREATE INDEX ON mirror.containers (master_id);
CREATE INDEX ON mirror.containers (container_no);

-- 应收单头 T_INVOHD
CREATE TABLE mirror.invoices (
    invoice_id     integer PRIMARY KEY,
    invoice_no     text,
    bill_to_id     integer,
    invoice_date   date,
    due_date       date,
    terms_days     integer NOT NULL DEFAULT 0,
    invoice_amt    numeric(18,2) NOT NULL DEFAULT 0,
    paid_amt       numeric(18,2) NOT NULL DEFAULT 0,
    duty_amt       numeric(18,2) NOT NULL DEFAULT 0,  -- 代垫关税：垫付、零毛利、CBP 有硬时限
    duty_paid_amt  numeric(18,2) NOT NULL DEFAULT 0,
    paid_date      date,
    src_table      text,                              -- F_TBName：T_OIHMAIN=按单开票，T_GENMAIN=按周期结算
    src_id         integer,                            -- F_TBID
    is_credit      smallint NOT NULL DEFAULT 0,
    void_flag      smallint NOT NULL DEFAULT 0,       -- 源系统 0/1/2 三态，仅 0 为有效
    created_at     timestamp,
    created_by     text
);
CREATE INDEX ON mirror.invoices (bill_to_id);
CREATE INDEX ON mirror.invoices (due_date);
CREATE INDEX ON mirror.invoices (src_table, src_id);

-- 应付单头 T_APHD
CREATE TABLE mirror.ap_vouchers (
    voucher_id     integer PRIMARY KEY,
    invoice_no     text,                              -- 供应商发票号 → 查重的唯一锚点
    pay_to_id      integer,
    invoice_date   date,
    due_date       date,
    invoice_amt    numeric(18,2) NOT NULL DEFAULT 0,
    paid_amt       numeric(18,2) NOT NULL DEFAULT 0,
    paid_date      date,
    src_table      text,
    src_id         integer,
    void_flag      smallint NOT NULL DEFAULT 0,
    approved       text,                              -- 源库 73,175 单全为 '0'，审批功能从未启用
    approved_by    text,                              -- 源库全空
    created_at     timestamp,
    created_by     text
);
CREATE INDEX ON mirror.ap_vouchers (pay_to_id);
CREATE INDEX ON mirror.ap_vouchers (src_table, src_id);
-- 重复付款检测：同供应商 + 同发票号。注意不能用金额匹配——
-- 某提单 31 个箱的按箱拖车费会有 19 笔同额记录，发票号各不相同，那是正常的。
CREATE INDEX ON mirror.ap_vouchers (pay_to_id, invoice_no)
    WHERE invoice_no IS NOT NULL AND invoice_no <> '';

-- ---------------------------------------------------------------------------
-- 核心事实表：收付费用明细行
-- T_INVODETAIL 与 T_APDETAIL 合并，用 direction 区分。
-- 滞期分析、错付款项、单票盈利、航线毛利全部在这张表上聚合——
-- 发票头只是它的一个分组维度，不是核心。
-- ---------------------------------------------------------------------------
CREATE TABLE mirror.charge_lines (
    direction    text    NOT NULL CHECK (direction IN ('ar','ap')),
    src_line_id  integer NOT NULL,
    -- 生成列：由 (direction, src_line_id) 唯一确定，每晚重建后取值不变。
    -- ops.case_link 引用 line_id，若用 bigserial 则重载后会串号。
    line_id      bigint GENERATED ALWAYS AS
                 (src_line_id::bigint * 2 + CASE WHEN direction = 'ar' THEN 0 ELSE 1 END) STORED,                    -- 源表 F_ID
    header_id    integer NOT NULL,                    -- F_INVOHDID / F_APHDID
    counterparty_id integer,                          -- AR=bill_to, AP=pay_to
    billing_code text,                                -- 如 DEMURRAGE.OI / FREIGHT.OI
    description  text,                                -- 箱号常嵌在这里：ZCSU7111182 PNCT PORT DEMURRAGE
    amount       numeric(18,2) NOT NULL DEFAULT 0,
    qty          numeric(18,4),
    rate         numeric(18,4),
    currency     text,
    post_date    date,
    doc_date     date,                                -- 取自单头的 invoice_date，便于按期间聚合
    src_table    text,                                -- 单头的 F_TBName
    src_id       integer,                             -- 单头的 F_TBID → shipment_id
    void_flag    smallint NOT NULL DEFAULT 0,
    PRIMARY KEY (line_id)      -- 公式已保证 (direction, src_line_id) 唯一
);
CREATE INDEX ON mirror.charge_lines (billing_code);
CREATE INDEX ON mirror.charge_lines (src_table, src_id);
CREATE INDEX ON mirror.charge_lines (counterparty_id);
CREATE INDEX ON mirror.charge_lines (doc_date);
CREATE INDEX ON mirror.charge_lines (direction, billing_code, doc_date);

-- 费用代码字典。来源是 T_NCODECHARGE（513 行）——
-- 注意不是 T_CODECHARGE：那是已废弃的 8 位短码体系（AISTORAG / OISTORAG），
-- 实测明细里在用的 377 个代码命中它 0 个，命中 T_NCODECHARGE 全部 377 个。
CREATE TABLE mirror.charge_codes (
    code            text PRIMARY KEY,       -- F_Code，如 'DEMURRAGE.OI'
    code_id         integer,
    description     text,
    local_desc      text,
    inactive        boolean NOT NULL DEFAULT false,
    use_in_invoice  boolean NOT NULL DEFAULT false,
    use_in_bill     boolean NOT NULL DEFAULT false,
    mod_oi          text,
    mod_oo          text,
    mod_ai          text,
    mod_ao          text,
    mod_wh          text,
    mod_ot          text
);

-- 刷新水位线：网页上的「数据截至 X」直接读这里，
-- 避免有人盯着过期数据做催收或付款决策。
CREATE TABLE mirror.refresh_log (
    id          bigserial PRIMARY KEY,
    table_name  text        NOT NULL,
    started_at  timestamptz NOT NULL DEFAULT now(),
    finished_at timestamptz,
    row_count   bigint,
    status      text        NOT NULL DEFAULT 'running'
                CHECK (status IN ('running','ok','failed')),
    error_text  text
);
CREATE INDEX ON mirror.refresh_log (table_name, started_at DESC);

-- 刷新约定：TRUNCATE + COPY 放在同一事务里。Postgres 的 TRUNCATE 是事务性的，
-- 提交前读者始终看到上一版完整数据，刷新期间网页不会出现空窗。
-- 不做增量：F_PaidAmt 会在老单据上被后续收付款改写，按创建日期做增量必然漏掉回款。
-- 注意：ref 层刻意不对 mirror 建外键，否则 TRUNCATE 会被外键挡住。


-- =============================================================================
-- ref —— 人工资产（R5 / R6 的判断都落在这里）
-- =============================================================================

-- 实体 = 合并后的真实主体。
-- 源系统把同一家公司拆成多个账号（BLUE SKY INVESTMENTS 与 BLUE SKY INVESTMENTS -DUTY），
-- 不合并就算不出真实敞口：实测这两家的敞口各被掩盖了一半。
CREATE TABLE ref.entity (
    entity_id        bigserial PRIMARY KEY,
    entity_name      text NOT NULL,
    -- R5 最重要的一条约束：直客按单开票，代理按结算周期批量开票。
    -- 2024 年起应收里代理占 43%，其收入无法归集到单票。
    -- 所有单票级指标必须按此维度分流，混算必错。
    business_model   text NOT NULL DEFAULT 'direct'
                     CHECK (business_model IN ('direct','agency','internal','unknown')),
    -- R6：Knights CHB 是关联方。不进常规催收队列（否则长期挂账的自己人会刷屏），
    -- 但通过 mart.related_party_ledger 单独做往来分析。
    is_related_party boolean NOT NULL DEFAULT false,
    risk_tier        text CHECK (risk_tier IN ('low','normal','watch','high')),
    -- 自动初始化时记下来源公司，供种子脚本确定性回填 entity_member；
    -- 人工合并出来的实体此列为空。
    seed_company_id  integer,
    note             text,
    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON ref.entity (business_model);
CREATE INDEX ON ref.entity (is_related_party) WHERE is_related_party;

CREATE TABLE ref.entity_member (
    company_id integer PRIMARY KEY,                   -- 刻意不设 FK：ref 不依赖可重建的 mirror
    entity_id  bigint  NOT NULL REFERENCES ref.entity(entity_id) ON DELETE CASCADE,
    leg        text    NOT NULL DEFAULT 'freight'
               CHECK (leg IN ('freight','duty')),     -- 区分主账号与 -DUTY 账号
    note       text
);
CREATE INDEX ON ref.entity_member (entity_id);

-- R5a 客户信用额度预警。源库的 F_CreditLimit 不起作用（开单时无校验），
-- 实际管控额度在这里维护。
CREATE TABLE ref.credit_policy (
    entity_id     bigint PRIMARY KEY REFERENCES ref.entity(entity_id) ON DELETE CASCADE,
    credit_limit  numeric(18,2),
    duty_limit    numeric(18,2),                      -- 关税敞口单独设限：性质与运费完全不同
    warn_ratio    numeric(5,3) NOT NULL DEFAULT 0.80, -- 用到 80% 先预警，不等超限
    effective_at  date NOT NULL DEFAULT CURRENT_DATE,
    review_at     date,
    set_by        text,
    rationale     text,
    updated_at    timestamptz NOT NULL DEFAULT now()
);

-- R5b 回款滞期。名义账期在这套数据里是失效的：57% 的发票账期为 0 天、
-- 全库准时率仅 20%，用名义到期日判逾期会把 80% 的发票标红。
-- 默认基线由 mart.payment_baseline 从历史算出，此处允许人工钉死。
CREATE TABLE ref.terms_override (
    entity_id     bigint PRIMARY KEY REFERENCES ref.entity(entity_id) ON DELETE CASCADE,
    expected_days integer NOT NULL,
    rationale     text,
    set_by        text,
    updated_at    timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- R5c 的关键表：费用分类 + 是否应当转嫁给客户
-- 「不该由 TransKnights 支付的款项由 TransKnights 支付了」＝
--   存在应付、且该费用类别本应转嫁、但同一票货上没有对应的应收。
-- 哪些类别应当转嫁是业务判断，必须人工维护，不能从源库推断。
-- ---------------------------------------------------------------------------
CREATE TABLE ref.charge_class (
    billing_code        text PRIMARY KEY,             -- 对应 mirror.charge_codes.code
    class               text NOT NULL
                        CHECK (class IN ('demurrage','detention','storage','chassis',
                                         'freight','duty','trucking','customs','exam',
                                         'warehouse','insurance','handling','other')),
    -- true = 这笔成本正常情况下应向客户收回。为 true 且收不回的，就是 R5c 要抓的。
    passthrough_expected boolean NOT NULL DEFAULT false,
    -- 超过此金额才进预警，避免被几十块的小额刷屏
    min_alert_amount    numeric(18,2) NOT NULL DEFAULT 100,
    note                text
);
COMMENT ON TABLE ref.charge_class IS
  '实测：2024 年滞期类应付 618 万，其中 107 票已开客户账单却没有滞期科目（94.5 万）。
   另有 4,214 票在提单层没有任何应收——那是代理业务按周期结算，不是漏收。
   所以本表必须与 ref.entity.business_model 一起使用，否则会产出不存在的缺口。';


-- =============================================================================
-- ops —— 处理工作流（所有分析维度共用一套案件模型）
-- 催运费、追滞期、额度超限、错付款项，都是同一个模式：
-- 发现例外 → 定优先级 → 派人 → 跟进 → 记结果。不该做四套工作台。
-- =============================================================================

CREATE TABLE ops.work_case (
    case_id        bigserial PRIMARY KEY,
    case_type      text NOT NULL
                   CHECK (case_type IN ('ar_collection',      -- 应收催收
                                        'credit_breach',      -- 额度超限
                                        'unrecovered_cost',   -- 成本未转嫁（R5c）
                                        'demurrage',          -- 滞期罚款
                                        'duplicate_payment',  -- 重复付款
                                        'billing_delay',      -- 开票超期
                                        'other')),
    entity_id      bigint REFERENCES ref.entity(entity_id),
    shipment_id    integer,                           -- 可空：客户级案件不挂具体票
    status         text NOT NULL DEFAULT 'open'
                   CHECK (status IN ('open','in_progress','waiting','resolved','dismissed')),
    priority       integer NOT NULL DEFAULT 0,        -- 打分公式写入，界面按此排序
    severity       text CHECK (severity IN ('info','warning','serious','critical')),
    assignee       text,
    title          text NOT NULL,
    amount         numeric(18,2),
    trigger_reason text,                              -- 为什么进队列：超基线 / 超额度 / 未转嫁
    opened_at      timestamptz NOT NULL DEFAULT now(),
    next_action_at date,
    closed_at      timestamptz,
    updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON ops.work_case (case_type, status, priority DESC);
CREATE INDEX ON ops.work_case (entity_id);
CREATE INDEX ON ops.work_case (assignee, next_action_at);
-- 同一实体同一类型只允许一个未关闭案件，避免每次刷新都重复开单
CREATE UNIQUE INDEX case_one_open_per_entity_type
    ON ops.work_case (case_type, entity_id)
    WHERE status NOT IN ('resolved','dismissed') AND entity_id IS NOT NULL;

CREATE TABLE ops.case_action (
    action_id         bigserial PRIMARY KEY,
    case_id           bigint NOT NULL REFERENCES ops.work_case(case_id) ON DELETE CASCADE,
    acted_at          timestamptz NOT NULL DEFAULT now(),
    actor             text,
    channel           text CHECK (channel IN ('email','phone','meeting','portal','internal','other')),
    outcome           text CHECK (outcome IN ('promised','paid','disputed','rebilled',
                                              'written_off','no_response','wrong_contact','other')),
    promised_pay_date date,
    promised_amount   numeric(18,2),
    note              text
);
CREATE INDEX ON ops.case_action (case_id, acted_at DESC);
CREATE INDEX ON ops.case_action (promised_pay_date) WHERE promised_pay_date IS NOT NULL;

-- 案件关联的源单据（多态，支持一个案件覆盖多张单/多个箱）
CREATE TABLE ops.case_link (
    case_id   bigint NOT NULL REFERENCES ops.work_case(case_id) ON DELETE CASCADE,
    ref_type  text   NOT NULL CHECK (ref_type IN ('invoice','ap_voucher','shipment','container','charge_line')),
    ref_id    bigint NOT NULL,
    disputed  boolean NOT NULL DEFAULT false,
    PRIMARY KEY (case_id, ref_type, ref_id)
);


-- =============================================================================
-- notify —— R4 通知层
-- 渠道可插拔：现在只做 email，以后加 telegram / teams 只是往 channel 插一行，
-- 不动 schema、不动规则、不动视图。
-- =============================================================================

CREATE TABLE notify.channel (
    channel_id  bigserial PRIMARY KEY,
    kind        text NOT NULL CHECK (kind IN ('email','telegram','teams','slack','webhook','sms')),
    name        text NOT NULL,
    config_json jsonb NOT NULL DEFAULT '{}'::jsonb,   -- SMTP / bot token / webhook url 等
    enabled     boolean NOT NULL DEFAULT true,
    created_at  timestamptz NOT NULL DEFAULT now(),
    UNIQUE (kind, name)
);
COMMENT ON COLUMN notify.channel.config_json IS
  '密钥不要直接写在这里。存 secret 引用（如 {"secret_ref":"tenant:secrets/smtp/main"}），
   由应用在运行时解析，与 FreightStream.yaml 里的 passwordSecretRef 做法一致。';

CREATE TABLE notify.recipient (
    recipient_id bigserial PRIMARY KEY,
    display_name text NOT NULL,
    channel_id   bigint NOT NULL REFERENCES notify.channel(channel_id) ON DELETE CASCADE,
    address      text NOT NULL,                       -- email / chat id / webhook target
    lang         text NOT NULL DEFAULT 'zh' CHECK (lang IN ('zh','en')),
    enabled      boolean NOT NULL DEFAULT true,
    UNIQUE (channel_id, address)
);

-- 规则不存 SQL 片段，而是指向一个 mart.alert_* 视图。
-- 每个告警视图必须返回统一契约（见下方 mart 段），这样通知器是一个通用循环：
-- 新增一类告警 = 建一个视图 + 插一行规则，应用代码不用改。
CREATE TABLE notify.rule (
    rule_id       bigserial PRIMARY KEY,
    alert_code    text NOT NULL UNIQUE,
    title_zh      text NOT NULL,
    title_en      text NOT NULL,
    source_view   text NOT NULL,                      -- 如 'mart.alert_credit_breach'
    min_severity  text NOT NULL DEFAULT 'warning'
                  CHECK (min_severity IN ('info','warning','serious','critical')),
    schedule_cron text NOT NULL DEFAULT '0 8 * * 1-5',-- 工作日早八点
    -- 同一 dedup_key 在此小时数内不重复发送。
    -- 没有这一条，同一个告警会天天发，两周后所有人都把邮件规则静音了。
    throttle_hours integer NOT NULL DEFAULT 168,
    auto_open_case boolean NOT NULL DEFAULT false,    -- 是否同时在 ops.work_case 开单
    case_type      text,
    enabled        boolean NOT NULL DEFAULT true,
    updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE notify.rule_recipient (
    rule_id      bigint NOT NULL REFERENCES notify.rule(rule_id) ON DELETE CASCADE,
    recipient_id bigint NOT NULL REFERENCES notify.recipient(recipient_id) ON DELETE CASCADE,
    PRIMARY KEY (rule_id, recipient_id)
);

CREATE TABLE notify.outbox (
    outbox_id    bigserial PRIMARY KEY,
    rule_id      bigint NOT NULL REFERENCES notify.rule(rule_id),
    recipient_id bigint NOT NULL REFERENCES notify.recipient(recipient_id),
    dedup_key    text   NOT NULL,                     -- 由告警视图给出，如 'credit:1234:2026-09'
    severity     text   NOT NULL,
    subject      text   NOT NULL,
    body         text   NOT NULL,
    detail_json  jsonb,
    state        text   NOT NULL DEFAULT 'pending'
                 CHECK (state IN ('pending','sent','failed','suppressed')),
    attempts     integer NOT NULL DEFAULT 0,
    last_error   text,
    queued_at    timestamptz NOT NULL DEFAULT now(),
    sent_at      timestamptz
);
CREATE INDEX ON notify.outbox (state, queued_at) WHERE state IN ('pending','failed');
CREATE INDEX ON notify.outbox (rule_id, recipient_id, dedup_key, queued_at DESC);


-- =============================================================================
-- mart —— 派生层（R3 网页 与 R4 通知 的统一入口）
--
-- 告警视图契约：所有 mart.alert_* 必须返回以下列，通知器只认这个形状——
--     alert_code   text        与 notify.rule.alert_code 对应
--     dedup_key    text        同一问题的稳定标识，用于去重与限流
--     entity_id    bigint      可空
--     shipment_id  integer     可空
--     severity     text        info | warning | serious | critical
--     amount       numeric     可空
--     subject_zh   text
--     subject_en   text
--     detail_json  jsonb       渲染邮件正文与网页详情用
-- =============================================================================

-- 客户实际付款行为基线（R5b 的地基）
CREATE MATERIALIZED VIEW mart.payment_baseline AS
SELECT em.entity_id,
       count(*)                                                                  AS sample_n,
       percentile_cont(0.5) WITHIN GROUP (ORDER BY i.paid_date - i.invoice_date)  AS median_days_to_pay,
       percentile_cont(0.9) WITHIN GROUP (ORDER BY i.paid_date - i.invoice_date)  AS p90_days_to_pay,
       avg((i.paid_date <= i.due_date)::int)::numeric(5,4)                        AS on_time_rate,
       mode() WITHIN GROUP (ORDER BY i.terms_days)                                AS nominal_terms_days
FROM mirror.invoices i
JOIN ref.entity_member em ON em.company_id = i.bill_to_id
WHERE i.void_flag = 0
  AND i.paid_date IS NOT NULL AND i.invoice_date IS NOT NULL
  AND i.invoice_amt > 0
  AND i.invoice_date >= CURRENT_DATE - INTERVAL '4 years'
GROUP BY em.entity_id;
CREATE UNIQUE INDEX ON mart.payment_baseline (entity_id);

-- 未清应收。同时给出【名义逾期】与【行为逾期】两个口径：
-- 名义口径用于账务与合规报表，行为口径用于催收队列。
CREATE VIEW mart.open_item AS
SELECT i.invoice_id,
       i.invoice_no,
       i.bill_to_id,
       em.entity_id,
       e.entity_name,
       e.business_model,
       e.is_related_party,
       i.invoice_date,
       i.due_date,
       i.terms_days                                                    AS nominal_terms_days,
       GREATEST(i.invoice_amt - i.paid_amt, 0)                         AS freight_balance,
       -- 源数据里出现过 duty_paid_amt 为负导致虚增应收，这里做防御
       GREATEST(i.duty_amt - GREATEST(i.duty_paid_amt, 0), 0)          AS duty_balance,
       GREATEST(i.invoice_amt - i.paid_amt, 0)
         + GREATEST(i.duty_amt - GREATEST(i.duty_paid_amt, 0), 0)      AS total_balance,
       (CURRENT_DATE - i.due_date)                                     AS days_past_due_nominal,
       (CURRENT_DATE - i.invoice_date)
         - COALESCE(o.expected_days, round(b.median_days_to_pay)::int, i.terms_days)
                                                                       AS days_past_baseline,
       i.src_table,
       i.src_id                                                        AS shipment_id
FROM mirror.invoices i
LEFT JOIN ref.entity_member  em ON em.company_id = i.bill_to_id
LEFT JOIN ref.entity          e ON e.entity_id   = em.entity_id
LEFT JOIN mart.payment_baseline b ON b.entity_id = em.entity_id
LEFT JOIN ref.terms_override  o ON o.entity_id   = em.entity_id
WHERE i.void_flag = 0
  AND ( i.invoice_amt - i.paid_amt > 0.005
     OR i.duty_amt - GREATEST(i.duty_paid_amt, 0) > 0.005 );

-- 实体敞口：客户 360 页与额度预警的数据源（R5a）
CREATE VIEW mart.entity_exposure AS
SELECT e.entity_id,
       e.entity_name,
       e.business_model,
       e.is_related_party,
       e.risk_tier,
       count(oi.invoice_id)                                            AS open_invoices,
       COALESCE(sum(oi.freight_balance), 0)                            AS freight_open,
       COALESCE(sum(oi.duty_balance), 0)                               AS duty_open,
       COALESCE(sum(oi.total_balance), 0)                              AS total_open,
       COALESCE(sum(oi.total_balance) FILTER (WHERE oi.days_past_baseline > 0), 0)
                                                                       AS overdue_by_baseline,
       max(oi.days_past_baseline)                                      AS max_days_past_baseline,
       cp.credit_limit,
       cp.duty_limit,
       cp.warn_ratio,
       CASE WHEN cp.credit_limit > 0
            THEN round(COALESCE(sum(oi.total_balance),0) / cp.credit_limit, 3) END
                                                                       AS limit_utilization,
       b.median_days_to_pay,
       b.on_time_rate,
       b.sample_n
FROM ref.entity e
LEFT JOIN mart.open_item        oi ON oi.entity_id = e.entity_id
LEFT JOIN ref.credit_policy     cp ON cp.entity_id = e.entity_id
LEFT JOIN mart.payment_baseline  b ON b.entity_id  = e.entity_id
GROUP BY e.entity_id, e.entity_name, e.business_model, e.is_related_party, e.risk_tier,
         cp.credit_limit, cp.duty_limit, cp.warn_ratio,
         b.median_days_to_pay, b.on_time_rate, b.sample_n;

-- 费用明细全景：所有主题分析的共同起点
CREATE VIEW mart.charge_line AS
SELECT cl.line_id,
       cl.direction,
       cl.billing_code,
       cc.class,
       cc.passthrough_expected,
       cl.description,
       cl.amount,
       cl.doc_date,
       cl.src_table,
       cl.src_id                                                       AS shipment_id,
       s.operator,
       s.hbl_no,
       em.entity_id,
       e.entity_name,
       e.business_model,
       e.is_related_party
FROM mirror.charge_lines cl
LEFT JOIN ref.charge_class   cc ON cc.billing_code = cl.billing_code
LEFT JOIN mirror.shipments    s ON s.shipment_id   = cl.src_id AND cl.src_table = 'T_OIHMAIN'
LEFT JOIN ref.entity_member  em ON em.company_id   = COALESCE(s.customer_id, cl.counterparty_id)
LEFT JOIN ref.entity          e ON e.entity_id     = em.entity_id
WHERE cl.void_flag = 0;

-- ---------------------------------------------------------------------------
-- R5c 成本未转嫁：按票比对「应转嫁的应付」与「实际开出的应收」
-- 四种状态明确区分，避免把业务模式问题误判成漏收——
-- 这正是之前算出「1,120 万缺口」却不存在的原因。
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
)
SELECT ap.shipment_id,
       s.hbl_no,
       s.operator,
       em.entity_id,
       e.entity_name,
       e.business_model,
       ap.class,
       ap.ap_amount,
       COALESCE(ar.ar_amount, 0)                    AS ar_amount,
       ap.ap_amount - COALESCE(ar.ar_amount, 0)      AS gap,
       CASE
         WHEN ha.shipment_id IS NULL             THEN 'no_ar_invoice'   -- 整票无应收：先查开票模式
         WHEN COALESCE(ar.ar_amount,0) = 0       THEN 'not_rebilled'    -- 有账单但没这项：真正要抓的
         WHEN ar.ar_amount < ap.ap_amount * 0.9  THEN 'under_rebilled'
         ELSE 'recovered'
       END                                          AS recovery_state,
       s.created_at
FROM ap
LEFT JOIN ar ON ar.shipment_id = ap.shipment_id AND ar.class = ap.class
LEFT JOIN has_ar ha ON ha.shipment_id = ap.shipment_id
LEFT JOIN mirror.shipments  s ON s.shipment_id = ap.shipment_id
LEFT JOIN ref.entity_member em ON em.company_id = s.customer_id
LEFT JOIN ref.entity         e ON e.entity_id  = em.entity_id;
COMMENT ON VIEW mart.unrecovered_cost IS
  '只有 business_model = ''direct'' 且 recovery_state = ''not_rebilled''/''under_rebilled''
   才是真的漏收。代理业务（agency）按周期批量结算，recovery_state 恒为 no_ar_invoice，
   不是问题。实测 2024 年：not_rebilled 107 票 / 94.5 万；no_ar_invoice 4,214 票，
   其中 3,595 票属 TESLA 一家的代理业务。';

-- R5d 超期罚款：滞期类成本归因。100% 的滞期应付单都挂在提单上，这一层完全可靠。
CREATE VIEW mart.demurrage_penalty AS
SELECT cl.src_id                     AS shipment_id,
       s.hbl_no,
       s.operator,
       em.entity_id,
       e.entity_name,
       e.business_model,
       cc.class,
       sum(cl.amount) FILTER (WHERE cl.direction = 'ap') AS paid_out,
       sum(cl.amount) FILTER (WHERE cl.direction = 'ar') AS recovered,
       min(cl.doc_date)                                  AS first_charge_date,
       s.last_free_day
FROM mirror.charge_lines cl
JOIN ref.charge_class cc ON cc.billing_code = cl.billing_code
LEFT JOIN mirror.shipments  s ON s.shipment_id = cl.src_id AND cl.src_table = 'T_OIHMAIN'
LEFT JOIN ref.entity_member em ON em.company_id = s.customer_id
LEFT JOIN ref.entity         e ON e.entity_id  = em.entity_id
WHERE cl.void_flag = 0
  AND cc.class IN ('demurrage','detention','storage')
GROUP BY cl.src_id, s.hbl_no, s.operator, em.entity_id, e.entity_name,
         e.business_model, cc.class, s.last_free_day;

-- R5d 提柜延期。⚠ 覆盖率极低，视图会把分母一起报出来，
-- 让看的人知道这是 0.9% 样本而不是全量结论。
CREATE VIEW mart.container_dwell AS
SELECT c.container_row_id,
       c.container_no,
       c.master_id,
       c.last_free_day,
       c.pickup_date,
       c.out_date,
       c.empty_return,
       CASE WHEN c.pickup_date IS NOT NULL AND c.last_free_day IS NOT NULL
            THEN c.pickup_date - c.last_free_day END          AS days_past_lfd,
       (c.pickup_date IS NOT NULL AND c.last_free_day IS NOT NULL) AS is_measurable
FROM mirror.containers c;
COMMENT ON VIEW mart.container_dwell IS
  '实测覆盖率：提柜日 1,187/134,591 (0.9%)，免费期 19,857/134,591 (14.8%)，
   两者同时存在的更少。所以「提柜延期列表」目前不能作为管理指标，
   只能作为已录入部分的抽样。要做成真正的预警，必须先让操作录入提柜时间与免费期
   ——这是流程改造，不是分析工作。超期罚款金额请用 mart.demurrage_penalty，那一层是可靠的。';

-- R6 关联方往来：Knights CHB 这类主体不进催收队列，但单独出账
CREATE VIEW mart.related_party_ledger AS
SELECT e.entity_id,
       e.entity_name,
       date_trunc('month', cl.doc_date)::date                           AS period,
       sum(cl.amount) FILTER (WHERE cl.direction = 'ar')                AS billed_to_them,
       sum(cl.amount) FILTER (WHERE cl.direction = 'ap')                AS billed_by_them,
       sum(cl.amount) FILTER (WHERE cl.direction = 'ar')
         - sum(cl.amount) FILTER (WHERE cl.direction = 'ap')            AS net_position,
       count(DISTINCT cl.src_id)                                        AS shipments
FROM mirror.charge_lines cl
LEFT JOIN mirror.shipments  s ON s.shipment_id = cl.src_id AND cl.src_table = 'T_OIHMAIN'
LEFT JOIN ref.entity_member em ON em.company_id = COALESCE(s.customer_id, cl.counterparty_id)
JOIN ref.entity e ON e.entity_id = em.entity_id AND e.is_related_party
WHERE cl.void_flag = 0 AND cl.doc_date IS NOT NULL
GROUP BY e.entity_id, e.entity_name, date_trunc('month', cl.doc_date);

-- 开票及时性（能力清单第 1 项）：建单 → 开票 的时效
CREATE VIEW mart.billing_lag AS
SELECT s.shipment_id,
       s.hbl_no,
       s.operator,
       em.entity_id,
       e.entity_name,
       e.business_model,
       s.created_at::date                                    AS file_opened,
       min(i.invoice_date)                                   AS first_invoice_date,
       min(i.invoice_date) - s.created_at::date              AS lag_days,
       CASE WHEN min(i.invoice_date) IS NULL
            THEN CURRENT_DATE - s.created_at::date END        AS unbilled_days
FROM mirror.shipments s
LEFT JOIN mirror.invoices i ON i.src_table = 'T_OIHMAIN' AND i.src_id = s.shipment_id
                            AND i.void_flag = 0
LEFT JOIN ref.entity_member em ON em.company_id = s.customer_id
LEFT JOIN ref.entity         e ON e.entity_id  = em.entity_id
WHERE s.created_at IS NOT NULL
GROUP BY s.shipment_id, s.hbl_no, s.operator, em.entity_id, e.entity_name,
         e.business_model, s.created_at;

-- ---------------------------------------------------------------------------
-- 告警视图（R4 的数据源，遵循上文契约）
-- ---------------------------------------------------------------------------

-- R5a 额度预警
CREATE VIEW mart.alert_credit_breach AS
SELECT 'credit_breach'::text                                            AS alert_code,
       'credit_breach:' || x.entity_id || ':' || to_char(CURRENT_DATE,'IYYY-IW') AS dedup_key,
       x.entity_id,
       NULL::integer                                                    AS shipment_id,
       CASE WHEN x.limit_utilization >= 1.0 THEN 'critical' ELSE 'warning' END AS severity,
       x.total_open                                                     AS amount,
       x.entity_name || ' 敞口 ' || to_char(x.total_open,'FM999,999,999')
         || ' / 额度 ' || to_char(x.credit_limit,'FM999,999,999')
         || '（' || to_char(x.limit_utilization*100,'FM990.0') || '%）'  AS subject_zh,
       x.entity_name || ' exposure ' || to_char(x.total_open,'FM999,999,999')
         || ' of ' || to_char(x.credit_limit,'FM999,999,999')
         || ' limit (' || to_char(x.limit_utilization*100,'FM990.0') || '%)' AS subject_en,
       to_jsonb(x)                                                      AS detail_json
FROM mart.entity_exposure x
WHERE NOT x.is_related_party
  AND x.credit_limit > 0
  AND x.limit_utilization >= x.warn_ratio;

-- R5c 成本未转嫁预警（只看直客，且排除整票无应收的业务模式噪音）
CREATE VIEW mart.alert_unrecovered_cost AS
SELECT 'unrecovered_cost'::text                                         AS alert_code,
       'unrecovered:' || u.shipment_id || ':' || u.class                AS dedup_key,
       u.entity_id,
       u.shipment_id,
       CASE WHEN u.gap >= 5000 THEN 'serious' ELSE 'warning' END        AS severity,
       u.gap                                                            AS amount,
       COALESCE(u.entity_name,'(未归属)') || ' 提单 ' || COALESCE(u.hbl_no,'?')
         || ' 的 ' || u.class || ' 成本 ' || to_char(u.ap_amount,'FM999,999,999')
         || ' 未转嫁（缺口 ' || to_char(u.gap,'FM999,999,999') || '）'    AS subject_zh,
       COALESCE(u.entity_name,'(unassigned)') || ' B/L ' || COALESCE(u.hbl_no,'?')
         || ': ' || u.class || ' cost of ' || to_char(u.ap_amount,'FM999,999,999')
         || ' not rebilled (gap ' || to_char(u.gap,'FM999,999,999') || ')' AS subject_en,
       to_jsonb(u)                                                      AS detail_json
FROM mart.unrecovered_cost u
-- 按类别取阈值：charge_class 主键是 billing_code，直接按 class 连会使行数翻倍
JOIN (SELECT class, min(min_alert_amount) AS min_alert_amount
      FROM ref.charge_class WHERE passthrough_expected GROUP BY class) cc
  ON cc.class = u.class
WHERE u.business_model = 'direct'
  AND u.recovery_state IN ('not_rebilled','under_rebilled')
  AND u.gap >= cc.min_alert_amount;

-- R5b 回款滞期预警（行为口径，非名义到期日）
CREATE VIEW mart.alert_payment_overdue AS
SELECT 'payment_overdue'::text                                          AS alert_code,
       'overdue:' || x.entity_id || ':' || to_char(CURRENT_DATE,'IYYY-IW') AS dedup_key,
       x.entity_id,
       NULL::integer                                                    AS shipment_id,
       CASE WHEN x.max_days_past_baseline >= 60 THEN 'serious'
            WHEN x.max_days_past_baseline >= 30 THEN 'warning'
            ELSE 'info' END                                             AS severity,
       x.overdue_by_baseline                                            AS amount,
       x.entity_name || ' 超自身付款基线 ' || x.max_days_past_baseline
         || ' 天，涉及 ' || to_char(x.overdue_by_baseline,'FM999,999,999') AS subject_zh,
       x.entity_name || ' is ' || x.max_days_past_baseline
         || ' days past its own payment baseline on '
         || to_char(x.overdue_by_baseline,'FM999,999,999')              AS subject_en,
       to_jsonb(x)                                                      AS detail_json
FROM mart.entity_exposure x
WHERE NOT x.is_related_party
  AND x.overdue_by_baseline > 0
  AND x.max_days_past_baseline >= 15;

-- 重复付款预警（同供应商 + 同发票号；绝不用金额匹配）
CREATE VIEW mart.alert_duplicate_payment AS
SELECT 'duplicate_payment'::text                                        AS alert_code,
       'dup:' || d.pay_to_id || ':' || d.invoice_no                     AS dedup_key,
       NULL::bigint                                                     AS entity_id,
       NULL::integer                                                    AS shipment_id,
       CASE WHEN d.extra_amount >= 5000 THEN 'critical' ELSE 'serious' END AS severity,
       d.extra_amount                                                   AS amount,
       COALESCE(c.full_name,'供应商#'||d.pay_to_id) || ' 发票 ' || d.invoice_no
         || ' 被录入 ' || d.n || ' 次，多出 '
         || to_char(d.extra_amount,'FM999,999,999')                     AS subject_zh,
       COALESCE(c.full_name,'Vendor #'||d.pay_to_id) || ' invoice ' || d.invoice_no
         || ' entered ' || d.n || ' times, surplus '
         || to_char(d.extra_amount,'FM999,999,999')                     AS subject_en,
       to_jsonb(d)                                                      AS detail_json
FROM (
    SELECT v.pay_to_id, v.invoice_no, count(*) AS n,
           min(v.invoice_amt) AS each_amount,
           min(v.invoice_amt) * (count(*) - 1) AS extra_amount
    FROM mirror.ap_vouchers v
    WHERE v.void_flag = 0
      AND v.invoice_no IS NOT NULL AND btrim(v.invoice_no) <> ''
      AND v.invoice_amt > 0
    GROUP BY v.pay_to_id, v.invoice_no
    HAVING count(*) > 1 AND count(DISTINCT v.invoice_amt) = 1
) d
LEFT JOIN mirror.companies c ON c.company_id = d.pay_to_id;

-- 开票超期预警
CREATE VIEW mart.alert_billing_delay AS
SELECT 'billing_delay'::text                                            AS alert_code,
       'billing:' || l.shipment_id                                      AS dedup_key,
       l.entity_id,
       l.shipment_id,
       CASE WHEN l.unbilled_days >= 60 THEN 'serious' ELSE 'warning' END AS severity,
       NULL::numeric                                                    AS amount,
       COALESCE(l.entity_name,'(未归属)') || ' 提单 ' || COALESCE(l.hbl_no,'?')
         || ' 建单 ' || l.unbilled_days || ' 天仍未开票'                  AS subject_zh,
       COALESCE(l.entity_name,'(unassigned)') || ' B/L ' || COALESCE(l.hbl_no,'?')
         || ' opened ' || l.unbilled_days || ' days ago, still unbilled' AS subject_en,
       to_jsonb(l)                                                      AS detail_json
FROM mart.billing_lag l
WHERE l.business_model = 'direct'
  AND l.first_invoice_date IS NULL
  AND l.unbilled_days >= 30;


-- =============================================================================
-- 权限：每个角色只拿它职责需要的那一份
-- =============================================================================

GRANT USAGE ON SCHEMA mirror, ref, ops, notify, mart TO fs_etl, fs_app, fs_read;

-- ETL：只动 mirror
GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE ON ALL TABLES IN SCHEMA mirror TO fs_etl;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA mirror TO fs_etl;
GRANT SELECT ON ALL TABLES IN SCHEMA ref TO fs_etl;          -- 读实体映射，不写

-- 应用：读全部，写 ops / ref / notify
GRANT SELECT ON ALL TABLES IN SCHEMA mirror, mart TO fs_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ops, ref, notify TO fs_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA ops, ref, notify TO fs_app;

-- 只读分析 / BI
GRANT SELECT ON ALL TABLES IN SCHEMA mirror, ref, ops, notify, mart TO fs_read;

-- 后续 migration 新建的对象自动继承
ALTER DEFAULT PRIVILEGES FOR ROLE fs_owner IN SCHEMA mirror
  GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE ON TABLES TO fs_etl;
ALTER DEFAULT PRIVILEGES FOR ROLE fs_owner IN SCHEMA mirror, mart
  GRANT SELECT ON TABLES TO fs_app;
ALTER DEFAULT PRIVILEGES FOR ROLE fs_owner IN SCHEMA ops, ref, notify
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO fs_app;
ALTER DEFAULT PRIVILEGES FOR ROLE fs_owner IN SCHEMA ops, ref, notify
  GRANT USAGE, SELECT ON SEQUENCES TO fs_app;
ALTER DEFAULT PRIVILEGES FOR ROLE fs_owner IN SCHEMA mirror, ref, ops, notify, mart
  GRANT SELECT ON TABLES TO fs_read;
