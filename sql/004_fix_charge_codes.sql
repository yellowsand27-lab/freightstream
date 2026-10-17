-- =============================================================================
-- 004 —— 修正费用代码来源表
--
-- 执行身份：fs_owner
--     psql -U fs_owner -d freightstream -f sql/004_fix_charge_codes.sql
--
-- 原因：002 里 mirror.charge_codes 镜像的是 T_CODECHARGE，但那是张废表。
--   实测明细里在用的 377 个费用代码，命中 T_CODECHARGE 0 个、命中 T_NCODECHARGE 377 个。
--   两者是不同的编码体系：旧表用 8 位短码（AISTORAG / OISTORAG），
--   现行体系用 <名称>.<模块> 格式（STORAGE.OI / DEMURRAGE.OI）。
--
-- 同样的修正已同步回 002_schema.sql，新建库不需要再跑本文件。
-- mirror 层声明为可重建，所以这里直接 DROP 重建；
-- mart 层不引用 mirror.charge_codes（它连的是 ref.charge_class），无级联影响。
-- =============================================================================

DROP TABLE IF EXISTS mirror.charge_codes;

CREATE TABLE mirror.charge_codes (
    code            text PRIMARY KEY,       -- T_NCODECHARGE.F_Code，如 'DEMURRAGE.OI'
    code_id         integer,                -- F_ID
    description     text,
    local_desc      text,                   -- F_LocalDesc，本地语言描述
    inactive        boolean NOT NULL DEFAULT false,
    use_in_invoice  boolean NOT NULL DEFAULT false,   -- 可用于应收
    use_in_bill     boolean NOT NULL DEFAULT false,   -- 可用于应付
    mod_oi          text,                   -- 海运进口
    mod_oo          text,                   -- 海运出口
    mod_ai          text,                   -- 空运进口
    mod_ao          text,                   -- 空运出口
    mod_wh          text,                   -- 仓储
    mod_ot          text                    -- 其他
);
COMMENT ON TABLE mirror.charge_codes IS
  '来源 T_NCODECHARGE（513 行）。旧表 T_CODECHARGE 是另一套已废弃的短码体系，不要用。';

GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE ON mirror.charge_codes TO fs_etl;
GRANT SELECT ON mirror.charge_codes TO fs_app, fs_read;
