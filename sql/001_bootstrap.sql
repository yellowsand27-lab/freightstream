-- =============================================================
-- FreightStream 分析库 —— 引导脚本
-- 执行身份：超级用户（psql -U postgres）
-- 只跑一次。之后所有 DDL 走 002 及后续 migration，由 fs_owner 执行。
-- =============================================================

-- ---------- 角色：按职责分离，不共用 ----------
-- fs_owner : 拥有所有 schema，只用于跑 migration（DDL）
-- fs_etl   : 只刷新 mirror 里的镜像数据，无 DDL 权限
-- fs_app   : 应用运行时。读全部，只写 ops/ref
-- fs_read  : 只读，给 BI / 临时分析用
-- 密码请用不含 @ : / ? # 的字符集，或在连接串里 percent-encode

CREATE ROLE fs_owner LOGIN PASSWORD 'CHANGE_ME';
CREATE ROLE fs_etl   LOGIN PASSWORD 'CHANGE_ME';
CREATE ROLE fs_app   LOGIN PASSWORD 'CHANGE_ME';
CREATE ROLE fs_read  LOGIN PASSWORD 'CHANGE_ME';

-- ---------- 数据库 ----------
-- 全小写命名：Postgres 对大小写敏感的标识符必须处处加引号，"TransKnights_FS" 会一直恶心人
CREATE DATABASE freightstream
  OWNER    fs_owner
  ENCODING 'UTF8'
  LC_COLLATE 'en_US.UTF-8'
  LC_CTYPE   'en_US.UTF-8'
  TEMPLATE   template0;

COMMENT ON DATABASE freightstream IS
  'FreightStream AR 分析与催收工具。镜像数据源自 MSSQL TRANSKNIGHTS（只读）。';

-- 收回 public 的默认连接权，显式授权
REVOKE ALL ON DATABASE freightstream FROM PUBLIC;
GRANT CONNECT ON DATABASE freightstream TO fs_owner, fs_etl, fs_app, fs_read;

\c freightstream

-- Postgres 15+ 默认已收紧 public schema，这里再确认一次
REVOKE ALL ON SCHEMA public FROM PUBLIC;
