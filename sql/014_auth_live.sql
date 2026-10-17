-- =============================================================================
-- 014 —— 登录改为实时直连 FS 校验，分析库不再存任何密码
--
-- 执行身份：fs_owner
--     psql -U fs_owner -d freightstream -f sql/014_auth_live.sql
--
-- 变更：013 曾把密码 bcrypt 后同步到 mirror.fs_users。现改为登录时由 API 直连
--   FS 生产库（只读）实时校验，分析库连哈希都不存。于是删除该表与登录视图；
--   ref.role_map 保留——登录成功后仍用它把 FS 分组映射成角色。
-- =============================================================================

DROP VIEW IF EXISTS mart.login_user;
DROP TABLE IF EXISTS mirror.fs_users;

-- ref.role_map 保留（013 已建并植入种子 + 审计触发器），此处无需改动。
