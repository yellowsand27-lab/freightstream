-- =============================================================================
-- 015 —— 移除 ref.role_map，角色改由 API 按 FS 分组判定
--
-- 执行身份：fs_owner
--     psql -U fs_owner -d freightstream -f sql/015_drop_role_map.sql
--
-- 原因：分组成员在 FS 系统里维护（维护人员的日常操作）。再在 Postgres 维护
--   一张组→角色映射表等于两处维护。组→角色的固定策略移到 API（可环境变量覆盖），
--   Postgres 不再掺和登录授权。
-- =============================================================================

DROP TRIGGER IF EXISTS audit_role_map ON ref.role_map;
DROP TABLE IF EXISTS ref.role_map;
