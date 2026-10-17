-- =============================================================================
-- 013 —— 登录认证：以 FS 账户为身份来源
--
-- 执行身份：fs_owner
--     psql -U fs_owner -d freightstream -f sql/013_auth.sql
--
-- 背景：FS 的 T_USER.F_Password 是明文 + 末尾一个 0x1C 结束符（已核实 76/76）。
--   我们不把明文搬进分析库——ETL 读出后当场 bcrypt，明文只在 ETL 内存过一遍。
--   登录时比对 bcrypt 哈希；用户名/邮箱/角色也来自 FS。
--   密码同步有夜间刷新的延迟，这是刻意的取舍（见 RUNBOOK）。
-- =============================================================================

-- 用户镜像。属于 mirror（每晚由 ETL 重建，可丢弃）——
-- 但注意 pw_bcrypt 是派生凭据，不是原文照搬，且分析库里只有它、没有明文。
CREATE TABLE mirror.fs_users (
    user_id        text PRIMARY KEY,          -- T_USER.F_UserID
    user_name      text,                       -- F_UserName（First Last）
    email          text,                       -- F_EMail
    group_id       integer,                    -- F_GroupID
    group_name     text,                       -- 关联 T_SECURITYGROUP.F_Name
    login_enabled  boolean NOT NULL DEFAULT false,  -- F_InactiveDate IS NULL 且有密码
    pw_bcrypt      text                        -- bcrypt(明文)，可能为空（无密码用户不能登录）
);
CREATE INDEX ON mirror.fs_users (lower(email));

COMMENT ON COLUMN mirror.fs_users.pw_bcrypt IS
  'bcrypt 哈希，由 ETL 从 T_USER.F_Password（去掉末尾 0x1C）当场计算。分析库不存明文。';

-- 角色映射：FS 分组 → 分析系统角色。人工可调，走 ref 层审计。
-- editor 能改额度/业务模式等（对应现有审计写权限）；viewer 只读。
CREATE TABLE ref.role_map (
    group_name text PRIMARY KEY,
    role       text NOT NULL CHECK (role IN ('admin','editor','viewer')),
    note       text
);
INSERT INTO ref.role_map (group_name, role, note) VALUES
    ('Admin',      'admin',  '系统管理员'),
    ('Managers',   'editor', '经理，可维护额度与分类'),
    ('CPA & GM',   'editor', '总经理 / 财务负责人'),
    ('Accounting', 'editor', '财务，可维护额度'),
    ('Operation',  'viewer', '操作，只读'),
    ('Sales',      'viewer', '销售，只读'),
    ('Guest',      'viewer', '访客，只读')
ON CONFLICT (group_name) DO NOTHING;

-- 登录视图：给 API 用。缺角色映射的分组默认 viewer（最小权限）。
CREATE OR REPLACE VIEW mart.login_user AS
SELECT u.user_id,
       u.user_name,
       u.email,
       u.group_name,
       COALESCE(rm.role, 'viewer') AS role,
       u.login_enabled,
       u.pw_bcrypt
FROM mirror.fs_users u
LEFT JOIN ref.role_map rm ON rm.group_name = u.group_name;

GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE ON mirror.fs_users TO fs_etl;
GRANT SELECT ON mirror.fs_users TO fs_app, fs_read;
GRANT SELECT ON mart.login_user TO fs_app, fs_read;
-- role_map 走 002 的 ref 默认授权（fs_app 可读写、审计触发器覆盖）；补一条以防万一
GRANT SELECT, INSERT, UPDATE, DELETE ON ref.role_map TO fs_app;

-- 审计：把 role_map 纳入变更审计（额度以外，谁能编辑也该留痕）
CREATE TRIGGER audit_role_map
    AFTER INSERT OR UPDATE OR DELETE ON ref.role_map
    FOR EACH ROW EXECUTE FUNCTION ref.log_change('{group_name}');
