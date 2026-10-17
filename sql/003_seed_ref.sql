-- =============================================================================
-- FreightStream 分析库 —— ref 层种子数据
--
-- 执行身份：fs_app（或 fs_owner）
--     psql -U fs_app -d freightstream -f 003_seed_ref.sql
--
-- ⚠ 执行顺序：本脚本的 B / C 段依赖 mirror 已有数据，
--   必须在第一次 ETL 全量加载之后执行。A 段可以随时跑。
--
-- 安全默认值：所有自动生成的记录都是「不产生告警」的状态——
--   业务模式默认 unknown，而告警视图只认 direct；
--   费用类别默认 passthrough_expected = false。
-- 也就是说人工确认之前，系统一条告警都不会发。这是刻意的：
-- 宁可漏报也不能在上线第一周就用误报把收件人劝退。
-- =============================================================================


-- =============================================================================
-- A 段 —— 费用分类（R5c 的判断依据）。与 mirror 无依赖，可随时执行。
--
-- passthrough_expected = true 的含义：这笔成本正常情况下应向客户收回。
-- 只有这些类别会进「成本未转嫁」预警。
-- 运费与拖车没有标 true——它们是正常的销货成本，不是代垫款项；
-- 标了会在每一票上产生毛利差异噪音，那属于盈利分析，不属于错付款项。
-- =============================================================================

-- note 列是入库的数据值，会显示在界面上，因此统一用英文（界面文案走 i18n，
-- 但这类库内数据无法按用户语言切换，取英文为基准语）。译文须与 019 迁移一致。
INSERT INTO ref.charge_class (billing_code, class, passthrough_expected, min_alert_amount, note) VALUES
  -- 滞期与仓储：码头/船司收的超期费用，本应转嫁给造成延误的一方
  ('DEMURRAGE.OI',             'demurrage',  true,   200, 'Port demurrage'),
  ('DEMURRAGE.OT',             'demurrage',  true,   200, 'Port demurrage (other)'),
  ('DEMURRAGE.OE',             'demurrage',  true,   200, 'Port demurrage (export)'),
  ('DETENTION.OI',             'detention',  true,   200, 'Container detention'),
  ('STORAGE.OI',               'storage',    true,   200, 'Terminal storage (demurrage-side)'),
  -- 注意：STORAGE.OT / WAREHOUSE.OT 是自有仓库的仓储服务，属自营收入，不是代垫
  ('STORAGE.OT',               'warehouse',  false,  500, 'Own-warehouse storage service; own-service revenue'),
  ('WAREHOUSE.OT',             'warehouse',  false,  500, 'Own warehouse'),
  ('WAREHOUSE.OI',             'warehouse',  false,  500, 'Own warehouse'),

  -- 设备与场站：代垫性质明确
  ('CHASSIS.OI',               'chassis',    true,   100, 'Chassis rental'),
  ('CHASSIS.OT',               'chassis',    true,   100, 'Chassis rental'),
  ('CHASSIS SPLIT.OI',         'chassis',    true,   100, 'Chassis split fee'),
  ('PRE-PULL.OI',              'storage',    true,   100, 'Pre-pull (often to avoid demurrage)'),
  ('PIER PASS.OI',             'other',      true,   100, 'PierPass terminal fee'),
  ('OAKLAND EXTENDED GATE.OI', 'other',      true,   100, 'Oakland extended gate fee'),
  ('CLEAN TRUCK FEE.OI',       'other',      true,   100, 'Clean truck fee'),

  -- 政府与查验：全部代垫
  ('DUTY.OI',                  'duty',       true,  1000, 'Advanced customs duty; zero-margin, hard CBP deadline'),
  ('DUTY.OT',                  'duty',       true,  1000, 'Advanced customs duty'),
  ('DUTY.AI',                  'duty',       true,  1000, 'Advanced customs duty (air import)'),
  ('EXAM.OI',                  'exam',       true,   100, 'CBP exam fee'),
  ('EXAM.OT',                  'exam',       true,   100, 'CBP exam fee'),
  ('OGA.OI',                   'customs',    true,   100, 'Other government agency (OGA) fee'),
  ('AMS.OI',                   'customs',    true,    50, 'AMS filing fee'),
  ('CUSTOMS ENTRY.OI',         'customs',    false,  100, 'Customs entry service fee; own-service revenue'),
  ('CUSTOMS ENTRY.OT',         'customs',    false,  100, 'Customs entry service fee; own-service revenue'),

  -- 主营成本：不属于「不该由我们支付」的范畴，差异归盈利分析
  ('FREIGHT.OI',               'freight',    false, 1000, 'Core freight cost'),
  ('FREIGHT.OT',               'freight',    false, 1000, 'Core freight cost'),
  ('FREIGHT.OE',               'freight',    false, 1000, 'Core freight cost'),
  ('TRUCKING.OI',              'trucking',   false,  500, 'Trucking cost'),
  ('TRUCKING.OT',              'trucking',   false,  500, 'Trucking cost'),
  ('TRUCKING WITH CHASSIS.OT', 'trucking',   false,  500, 'Trucking incl. chassis'),
  ('DRAYAGE.OI',               'trucking',   false,  500, 'Drayage'),
  ('DELIVERY.OI',              'trucking',   false,  500, 'Delivery'),
  ('TRANSLOADING.OI',          'handling',   false,  500, 'Transloading'),
  ('FORKLIFT.OI',              'handling',   false,  200, 'Forklift'),
  ('INSURANCE.OI',             'insurance',  false,  200, 'Cargo insurance'),
  ('H/C (CUSTOMER).OI',        'handling',   false,  100, 'Customer handling charge; own-service revenue'),
  ('H/C (CUSTOMER).OT',        'handling',   false,  100, 'Customer handling charge; own-service revenue'),
  ('FSC.OI',                   'other',      false,  200, 'Fuel surcharge'),
  ('LOCAL CHARGE.OI',          'other',      false,  200, 'Local charge')
ON CONFLICT (billing_code) DO NOTHING;


-- =============================================================================
-- B 段 —— 兜底分类：把剩余科目全部落到 other / 不告警
-- 依赖 mirror.charge_codes，需在首次 ETL 之后执行。
--
-- 源库在用的科目有 286 个，上面显式列出的只是金额最大、性质最明确的一批。
-- 其余（含 OFFICE RENT EXPENSE 这类内部总账科目）一律 other + 不告警，
-- 等业务确认后再逐个改成 true。
-- =============================================================================

-- 实测：T_CODECHARGE 只有 88 个代码，而明细里实际在用的有 286 个——
-- 只按代码表兜底会漏掉约 200 个科目，使 mart.charge_line.class 为空。
-- 所以取「代码表 ∪ 明细实际在用」的并集。
INSERT INTO ref.charge_class (billing_code, class, passthrough_expected, note)
SELECT code, 'other', false, 'Fallback classification; pending business confirmation'
FROM (
    SELECT code FROM mirror.charge_codes
    UNION
    SELECT DISTINCT billing_code
    FROM mirror.charge_lines
    WHERE billing_code IS NOT NULL AND btrim(billing_code) <> ''
) u
ON CONFLICT (billing_code) DO NOTHING;


-- =============================================================================
-- C 段 —— 实体初始化
-- 依赖 mirror.companies，需在首次 ETL 之后执行。
--
-- 策略：先给每个客户建 1:1 实体、业务模式标 unknown（不触发任何告警），
-- 再把已经确认的几家改成正确取值。之后的合并由人工在界面上做。
-- =============================================================================

-- C1. 为所有尚未映射的公司建 1:1 实体。
-- 用 seed_company_id 回填，不按名称回连——源库存在同名客户，按名称 JOIN 会产生笛卡尔积。
WITH missing AS (
    SELECT c.company_id, c.full_name
    FROM mirror.companies c
    LEFT JOIN ref.entity_member em ON em.company_id = c.company_id
    WHERE em.company_id IS NULL
),
created AS (
    INSERT INTO ref.entity (entity_name, business_model, seed_company_id, note)
    SELECT COALESCE(NULLIF(btrim(m.full_name),''), 'COMPANY #'||m.company_id),
           'unknown', m.company_id, 'Auto-initialized by ETL; business model pending confirmation'
    FROM missing m
    RETURNING entity_id, seed_company_id
)
INSERT INTO ref.entity_member (company_id, entity_id, leg, note)
SELECT cr.seed_company_id, cr.entity_id,
       CASE WHEN upper(COALESCE(mc.full_name,'')) LIKE '%DUTY%' THEN 'duty' ELSE 'freight' END,
       'Auto-initialized'
FROM created cr
JOIN mirror.companies mc ON mc.company_id = cr.seed_company_id;


-- C2. R6：Knights CHB 是关联方。
-- 不进常规催收队列（它挂账 18.4 万、实际付款中位 91 天，会把队列刷屏），
-- 但通过 mart.related_party_ledger 单独做与 TransKnights 的往来分析。
UPDATE ref.entity e
SET is_related_party = true,
    business_model   = 'internal',
    note             = 'Related party. Excluded from collections and credit alerts; intercompany position tracked separately (mart.related_party_ledger).',
    updated_at       = now()
WHERE e.entity_id IN (
    SELECT em.entity_id FROM ref.entity_member em
    JOIN mirror.companies c ON c.company_id = em.company_id
    WHERE upper(c.full_name) LIKE 'KNIGHTS CHB%'
       OR upper(c.full_name) LIKE 'TRANS KNIGHTS%'
);

-- C3. 已确认的代理业务：收入按结算周期批量开票，不落单票。
-- 标成 agency 后，单票级告警自动跳过它们——这正是避免再算出
-- 「1,120 万缺口」那类假结论的机制。
UPDATE ref.entity e
SET business_model = 'agency',
    note = 'Agency / nominated cargo. Revenue billed in bulk per settlement cycle (T_GENMAIN), not attributed per file.',
    updated_at = now()
WHERE e.is_related_party = false
  AND e.entity_id IN (
    SELECT em.entity_id FROM ref.entity_member em
    JOIN mirror.companies c ON c.company_id = em.company_id
    WHERE upper(c.full_name) LIKE 'RICH SHIPPING%'
       OR upper(c.full_name) LIKE 'TESLA%'
  );


-- =============================================================================
-- D 段 —— 通知层初始化（R4）
-- 渠道配置里不要写明文密钥，只放 secret 引用，由应用在运行时解析。
-- =============================================================================

INSERT INTO notify.channel (kind, name, config_json, enabled) VALUES
  ('email', 'Primary SMTP',
   '{"secret_ref":"freightstream/smtp/primary","from":"freightstream@transknights.com"}'::jsonb,
   true)
ON CONFLICT DO NOTHING;

-- 五条规则对应 R5 的各个维度。默认全部 enabled = false，
-- 等收件人配好、且在真实数据上核对过一轮误报率之后再逐条打开。
INSERT INTO notify.rule
  (alert_code, title_zh, title_en, source_view, min_severity, schedule_cron,
   throttle_hours, auto_open_case, case_type, enabled)
VALUES
  ('credit_breach',     '客户信用额度预警',   'Customer credit limit breach',
   'mart.alert_credit_breach',     'warning',  '0 8 * * 1-5', 168, true,  'credit_breach',    false),
  ('payment_overdue',   '回款滞期预警',       'Payment overdue vs baseline',
   'mart.alert_payment_overdue',   'warning',  '0 8 * * 1',   168, true,  'ar_collection',    false),
  ('unrecovered_cost',  '成本未转嫁预警',     'Cost not rebilled to customer',
   'mart.alert_unrecovered_cost',  'warning',  '0 9 * * 1-5', 720, true,  'unrecovered_cost', false),
  ('duplicate_payment', '重复付款预警',       'Duplicate vendor invoice',
   'mart.alert_duplicate_payment', 'serious',  '0 9 * * 1-5',  24, true,  'duplicate_payment',false),
  ('billing_delay',     '开票超期预警',       'Shipment unbilled too long',
   'mart.alert_billing_delay',     'warning',  '0 8 * * 1-5', 168, true,  'billing_delay',    false)
ON CONFLICT (alert_code) DO NOTHING;
