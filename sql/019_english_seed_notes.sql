-- =============================================================================
-- 019 —— 库内系统生成文案统一为英文
--
-- 执行身份：fs_owner（含 UPDATE，走 ref 审计触发器）
--     psql -U fs_owner -d freightstream -f sql/019_english_seed_notes.sql
--
-- 背景：种子/迁移脚本(003/006/016)往库里写了中文 note/rationale。这些是
-- 存进库的"数据值"，不是界面文案（界面走 i18n）——没法按用户语言切换，
-- 一个非中文用户看到中文更糟。统一改成英文基准语。
-- 源脚本已同步改英文；本文件修正存量数据。仅翻译已知的系统生成串，
-- 用精确匹配，不动任何真人手填的自由文本。
-- =============================================================================

-- credit_policy.rationale（种子起点值）
UPDATE ref.credit_policy
SET rationale = 'Seed value imported from T_COMPANY.F_CreditLimit; to be re-assessed by the business'
WHERE rationale = '自源库 T_COMPANY.F_CreditLimit 导入的起点值，需业务重新核定';

-- entity.note —— 组合串，分段用 regexp 保留其中的数字
UPDATE ref.entity
SET note = replace(note, 'ETL 自动初始化，待人工确认业务模式',
                   'Auto-initialized by ETL; business model pending confirmation')
WHERE note LIKE '%ETL 自动初始化%';

UPDATE ref.entity
SET note = regexp_replace(note,
      '业务模式由开票挂载表推导（([0-9]+) 张按单 / ([0-9]+) 张按周期）',
      'business model inferred from billing table (\1 per-file / \2 per-cycle)')
WHERE note LIKE '%业务模式由开票挂载表推导%';

UPDATE ref.entity
SET note = 'Agency / nominated cargo. Revenue billed in bulk per settlement cycle (T_GENMAIN), not attributed per file.'
WHERE note = '代理/提名货。收入按结算周期批量开票（T_GENMAIN），不归集到单票。';

UPDATE ref.entity
SET note = 'Related party. Excluded from collections and credit alerts; intercompany position tracked separately (mart.related_party_ledger).'
WHERE note = '关联方。排除于催收与额度告警，往来单独出账（mart.related_party_ledger）。';

-- entity_member.note（1:1 建实体时写的初始化标记）
UPDATE ref.entity_member
SET note = 'Auto-initialized'
WHERE note = '自动初始化';

-- system_account.note
UPDATE ref.system_account
SET note = 'AMS auto-generated vouchers, not a person'
WHERE note = 'AMS 报文自动建单，非真人';

-- charge_class.note —— 逐串映射（含兜底）
UPDATE ref.charge_class SET note = CASE note
  WHEN '兜底分类，待业务确认'          THEN 'Fallback classification; pending business confirmation'
  WHEN '主营运费成本'                  THEN 'Core freight cost'
  WHEN '拖车成本'                      THEN 'Trucking cost'
  WHEN '含底盘拖车'                    THEN 'Trucking incl. chassis'
  WHEN '短驳'                          THEN 'Drayage'
  WHEN '派送'                          THEN 'Delivery'
  WHEN '转运装卸'                      THEN 'Transloading'
  WHEN '叉车'                          THEN 'Forklift'
  WHEN '客户手续费，自营收入'          THEN 'Customer handling charge; own-service revenue'
  WHEN '报关服务费，自营收入'          THEN 'Customs entry service fee; own-service revenue'
  WHEN 'CBP 查验费'                    THEN 'CBP exam fee'
  WHEN '底盘租金'                      THEN 'Chassis rental'
  WHEN '底盘分离费'                    THEN 'Chassis split fee'
  WHEN '自有仓库'                      THEN 'Own warehouse'
  WHEN '自有仓库仓储服务，自营收入'    THEN 'Own-warehouse storage service; own-service revenue'
  WHEN '码头堆存费'                    THEN 'Terminal storage (demurrage-side)'
  WHEN '港口滞期费'                    THEN 'Port demurrage'
  WHEN '港口滞期费（其他）'            THEN 'Port demurrage (other)'
  WHEN '港口滞期费（出口）'            THEN 'Port demurrage (export)'
  WHEN '滞箱费'                        THEN 'Container detention'
  WHEN '代垫关税'                      THEN 'Advanced customs duty'
  WHEN '代垫关税，零毛利且 CBP 有硬时限' THEN 'Advanced customs duty; zero-margin, hard CBP deadline'
  WHEN '代垫关税（空运进口）'          THEN 'Advanced customs duty (air import)'
  WHEN '其他政府机构费用'              THEN 'Other government agency (OGA) fee'
  WHEN 'AMS 报送费'                    THEN 'AMS filing fee'
  WHEN '货物保险'                      THEN 'Cargo insurance'
  WHEN '燃油附加费'                    THEN 'Fuel surcharge'
  WHEN '当地费用'                      THEN 'Local charge'
  WHEN '清洁卡车费'                    THEN 'Clean truck fee'
  WHEN '奥克兰延时闸口费'              THEN 'Oakland extended gate fee'
  WHEN 'PierPass 码头通行费'           THEN 'PierPass terminal fee'
  WHEN '预提柜（多为规避滞期而发生）'  THEN 'Pre-pull (often to avoid demurrage)'
  ELSE note END
WHERE note ~ '[一-鿿]';

-- 校验：还剩多少含中文
DO $$
DECLARE n int;
BEGIN
  SELECT (SELECT count(*) FROM ref.charge_class WHERE note ~ '[一-鿿]')
       + (SELECT count(*) FROM ref.entity WHERE note ~ '[一-鿿]')
       + (SELECT count(*) FROM ref.entity_member WHERE note ~ '[一-鿿]')
       + (SELECT count(*) FROM ref.credit_policy WHERE rationale ~ '[一-鿿]')
       + (SELECT count(*) FROM ref.system_account WHERE note ~ '[一-鿿]') INTO n;
  RAISE NOTICE '仍含中文的系统生成字段: %', n;
END $$;
