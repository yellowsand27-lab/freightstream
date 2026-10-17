-- =============================================================================
-- R2 的强制手段：在 FreightStream 生产库上建一个只读登录
--
-- 目标库：MSSQL TRANSKNIGHTS @ 47.176.245.212  (SQL Server 2016 Standard)
-- 执行身份：sysadmin（由你们的 DBA 执行）
--
-- ⚠ 这是唯一需要在生产库上执行写操作的脚本，而且只动权限、不动业务数据。
--   我不会执行它，也没有执行它的意图——分析侧始终保持只读。
--
-- 为什么需要它：
--   目前 ETL 用的是 sa 超级账号，跨公网连生产库，"只读"靠客户端脚本自律保证。
--   一个手滑就是事故。正确做法是让数据库本身强制这个约束：
--   下面这个账号在物理上无法写入任何一张表，即使脚本写错也不会。
--
--   另外 SQL Server 2016 Standard 没有 Resource Governor（Enterprise 特性），
--   所以无法在服务端限制查询资源。客户端超时（FreightStream.yaml 里的
--   requestTimeoutMs）是现有的最后一道闸。
-- =============================================================================

USE [master];
GO

-- 1. 建登录。密码请用不含 @ : / ? # 的字符集，否则连接串里要 percent-encode
--    （前面两个 Postgres 角色的密码都因为带 @ 踩过这个坑）
CREATE LOGIN [freightstream_reader]
    WITH PASSWORD = N'CHANGE_ME',
         DEFAULT_DATABASE = [TRANSKNIGHTS],
         CHECK_POLICY = ON;
GO

USE [TRANSKNIGHTS];
GO

-- 2. 建用户并只给读权限
CREATE USER [freightstream_reader] FOR LOGIN [freightstream_reader];
GO

ALTER ROLE [db_datareader] ADD MEMBER [freightstream_reader];
GO

-- 3. 显式拒绝写入。db_datareader 本来就不含写权限，
--    这几条 DENY 是防止将来有人误把该用户加进其他角色时权限被叠加上来。
--
--    ⚠ 千万不要在这里加 CONTROL。SQL Server 的权限是有层级的，DENY 沿层级
--      向下传递，而实测层级链为 CONNECT ← CONNECT REPLICATION ← CONTROL，
--      且 CONTROL 直接涵盖 SELECT。一条 DENY CONTROL 会传递否掉 73 项权限，
--      包含账号赖以工作的 CONNECT 与 SELECT，结果是直连报 4060、
--      EXECUTE AS 报 916。下面这五项实测都不涵盖 CONNECT / SELECT，是安全的。
DENY INSERT, UPDATE, DELETE, ALTER, REFERENCES
    ON DATABASE::[TRANSKNIGHTS] TO [freightstream_reader];
GO

-- 确保连接权限明确授予（CREATE USER 通常会隐式给，这里显式重申）
GRANT CONNECT TO [freightstream_reader];
GO

-- 4. 允许读取系统目录视图（ETL 需要查字段结构与行数做校验）
GRANT VIEW DEFINITION TO [freightstream_reader];
GO

-- 5. 验证
--
-- ⚠ 不要用 EXECUTE AS USER 来验证。它产生的模拟上下文没有服务器级令牌，
--   并且不允许再切换数据库上下文；而 SSMS / DataGrip 这类工具常会在语句前
--   注入 USE [库名] 或在语句间发元数据查询，一旦发生就会抛：
--       [916] The server principal "freightstream_reader" is not able to
--             access the database "TRANSKNIGHTS" under the current security context.
--   这是验证方法的问题，不代表权限配错了。
--
-- 方法 A（推荐）：用 freightstream_reader 单独开一个连接，直接跑这两句
--     SELECT TOP 1 F_ID FROM dbo.T_INVOHD;
--     -- 预期：成功
--     UPDATE dbo.T_COMPANY SET F_CreditLimit = F_CreditLimit WHERE 1 = 0;
--     -- 预期：报 permission denied（WHERE 1=0 不会改动任何行，安全）
--
-- 方法 B：不开新连接，以 sa 身份直接查有效权限配置。
--         SQL Server 中 DENY 永远压过 GRANT，所以下面这组结果即可证明写入被封。

SELECT 'login_exists'  AS item,
       CAST(COUNT(*) AS VARCHAR) AS value
FROM sys.server_principals WHERE name = 'freightstream_reader'
UNION ALL
SELECT 'orphaned',
       CASE WHEN EXISTS (SELECT 1 FROM sys.database_principals dp
                         JOIN sys.server_principals sp ON sp.sid = dp.sid
                         WHERE dp.name = 'freightstream_reader')
            THEN 'NO - login matched' ELSE 'YES - fix required' END
UNION ALL
SELECT 'role', r.name
FROM sys.database_role_members m
JOIN sys.database_principals r ON r.principal_id = m.role_principal_id
JOIN sys.database_principals u ON u.principal_id = m.member_principal_id
WHERE u.name = 'freightstream_reader'
UNION ALL
SELECT p.state_desc, p.permission_name
FROM sys.database_permissions p
JOIN sys.database_principals u ON u.principal_id = p.grantee_principal_id
WHERE u.name = 'freightstream_reader' AND p.class = 0;
GO

-- 预期结果：
--   login_exists  1
--   orphaned      NO - login matched
--   role          db_datareader
--   GRANT         CONNECT
--   GRANT         VIEW DEFINITION
--   DENY          INSERT / UPDATE / DELETE / ALTER / REFERENCES

-- =============================================================================
-- 建好之后，ETL 侧改这两个环境变量即可，refresh_mirror.py 不需要改代码：
--     export FS_MSSQL_USER=freightstream_reader
--     export FS_MSSQL_PASSWORD='CHANGE_ME'
--
-- 同时建议：
--   · 把 documents/FreightStream.yaml 里的 sa 明文密码去掉，
--     改用已经预留的 passwordSecretRef 字段
--   · 检查 47.176.245.212:1433 是否真的需要对公网开放；
--     若可以，限制为只允许分析主机的 IP 访问
--   · FreightStream.yaml 目前是 encrypt: false，跨公网传输未加密，
--     建议开启 encrypt = true（SQL Server 2016 支持，需配置证书）
-- =============================================================================
