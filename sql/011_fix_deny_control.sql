-- =============================================================================
-- 011 —— 修正 010 的一个错误：DENY CONTROL 把 CONNECT 一起否掉了
--
-- 执行身份：sysadmin（sa），在 TRANSKNIGHTS 上执行
--
-- 症状：
--   直连时     [4060] Cannot open database "TRANSKNIGHTS" requested by the login.
--   EXECUTE AS  [916] The server principal ... is not able to access the database
--   两者是同一个原因的两种表现。
--
-- 根因：SQL Server 的权限是有层级的，DENY 沿层级向下传递。实测层级链为
--       CONNECT  ←  CONNECT REPLICATION  ←  CONTROL
--   即 CONTROL 传递涵盖 CONNECT；它同时直接涵盖 SELECT。
--   核算下来 DENY CONTROL 一条就否掉了 73 项权限，其中包含账号赖以工作的
--   CONNECT 与 SELECT，而 DENY 永远压过 GRANT。
--
--   010 里加 DENY CONTROL 的本意是「防止将来被误加进高权限角色」，
--   但它选错了工具——正确做法是只 DENY 具体的写权限。
--   实测其余五条（INSERT / UPDATE / DELETE / ALTER / REFERENCES）
--   传递涵盖的权限里都不含 CONNECT 或 SELECT，可以保留。
-- =============================================================================

USE [TRANSKNIGHTS];
GO

-- REVOKE 会同时清除该权限上的 GRANT 与 DENY 条目
REVOKE CONTROL ON DATABASE::[TRANSKNIGHTS] FROM [freightstream_reader];
GO

-- 明确重申连接与读取权限（db_datareader 已提供 SELECT，这里只确保 CONNECT）
GRANT CONNECT TO [freightstream_reader];
GO

-- ---------------------------------------------------------------------------
-- 验证（以 sa 执行即可，不要用 EXECUTE AS）
-- ---------------------------------------------------------------------------
SELECT p.state_desc AS state, p.permission_name AS permission
FROM sys.database_permissions p
JOIN sys.database_principals u ON u.principal_id = p.grantee_principal_id
WHERE u.name = 'freightstream_reader' AND p.class = 0
ORDER BY p.state_desc DESC, p.permission_name;
GO

-- 预期结果（关键是 DENY 列表里不再出现 CONTROL）：
--   GRANT  CONNECT
--   GRANT  VIEW DEFINITION
--   DENY   ALTER
--   DENY   DELETE
--   DENY   INSERT
--   DENY   REFERENCES
--   DENY   UPDATE
--
-- 之后用 freightstream_reader 单独开一个连接实测：
--   SELECT TOP 1 F_ID FROM dbo.T_INVOHD;                                  -- 应成功
--   UPDATE dbo.T_COMPANY SET F_CreditLimit = F_CreditLimit WHERE 1 = 0;   -- 应报 permission denied
