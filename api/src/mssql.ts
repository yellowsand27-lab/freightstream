/**
 * FreightStream 生产库（MSSQL）只读连接——仅用于登录时实时校验密码。
 *
 * 连接信息从 documents/FreightStream.yaml 读（与 ETL 同源）。
 * 账号是 freightstream_reader：db_datareader + DENY 所有写，物理上无法改数据。
 * 除了登录校验，本进程不对 MSSQL 做任何其他事。
 */
import sql from "mssql";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { parse as parseYaml } from "yaml";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, "..", "..");

interface MsCfg { server: string; port: number; user: string; password: string; database: string; encrypt: boolean; trust: boolean; }

function loadCfg(): MsCfg {
  // 环境变量优先，其次 yaml（enabled 的 mssql 组）
  const p = resolve(ROOT, "documents", "FreightStream.yaml");
  let g: Record<string, unknown> = {};
  // 服务器上连接信息全在环境变量里（fs-api 以普通账号运行，读不了 root 的 documents/）；yaml 只给本机开发用
  if (!process.env.FS_MSSQL_PASSWORD && existsSync(p)) {
    try {
      const doc = parseYaml(readFileSync(p, "utf8"));
      g = (doc?.dbGroups ?? []).find((x: Record<string, unknown>) => x.enabled && x.driver === "mssql") ?? {};
    } catch { /* 读不了就只用环境变量 */ }
  }
  const opt = (g.options ?? {}) as Record<string, unknown>;
  return {
    server: process.env.FS_MSSQL_HOST ?? String(g.host ?? ""),
    port: Number(process.env.FS_MSSQL_PORT ?? g.port ?? 1433),
    user: process.env.FS_MSSQL_USER ?? String(g.user ?? ""),
    password: process.env.FS_MSSQL_PASSWORD ?? String(g.password ?? ""),
    database: process.env.FS_MSSQL_DATABASE ?? String(g.database ?? "TRANSKNIGHTS"),
    encrypt: opt.encrypt === true,
    trust: opt.trustServerCertificate !== false,
  };
}

let poolPromise: Promise<sql.ConnectionPool> | null = null;

function getPool(): Promise<sql.ConnectionPool> {
  if (!poolPromise) {
    const c = loadCfg();
    poolPromise = new sql.ConnectionPool({
      server: c.server, port: c.port, user: c.user, password: c.password, database: c.database,
      pool: { max: 4, min: 0, idleTimeoutMillis: 30000 },
      options: { encrypt: c.encrypt, trustServerCertificate: c.trust, enableArithAbort: true },
      requestTimeout: 15000, connectionTimeout: 15000,
    }).connect().catch((e) => { poolPromise = null; throw e; }); // 连接失败别缓存坏 promise
  }
  return poolPromise;
}

export interface FsUser { userId: string; userName: string | null; email: string | null; groupName: string | null; enabled: boolean; password: string | null; }

/** 按用户名（大小写不敏感）取一个 FS 用户；找不到返回 null。只读。 */
export async function fetchFsUser(userId: string): Promise<FsUser | null> {
  const pool = await getPool();
  const r = await pool.request()
    .input("uid", sql.VarChar(10), userId)
    .query(`
      SET TRANSACTION ISOLATION LEVEL READ UNCOMMITTED;
      SELECT TOP 1 u.F_UserID uid, u.F_UserName uname, u.F_EMail email,
             g.F_Name grp, u.F_InactiveDate inact, u.F_Password pw
      FROM dbo.T_USER u
      LEFT JOIN dbo.T_SECURITYGROUP g ON g.F_Iden = u.F_GroupID
      WHERE LOWER(u.F_UserID) = LOWER(@uid)`);
  const row = r.recordset[0];
  if (!row) return null;
  return {
    userId: String(row.uid).trim(),
    userName: row.uname ? String(row.uname).trim() : null,
    email: row.email ? String(row.email).trim() : null,
    groupName: row.grp ? String(row.grp).trim() : null,
    enabled: row.inact == null,
    password: row.pw ?? null,
  };
}
