/**
 * 数据库连接
 *
 * 连接串来源（优先级）：FS_PG_DSN 环境变量 → documents/analytics-db.connection.yaml 的 endpoints.app
 * 应用以 fs_app 连库：读全部，写 ops / ref / notify；mirror 与 mart 只读。
 */
import { Pool, type PoolClient } from "pg";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { parse as parseYaml } from "yaml";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, "..", "..");

function resolveDsn(): string {
  if (process.env.FS_PG_DSN) return process.env.FS_PG_DSN;
  const p = resolve(ROOT, "documents", "analytics-db.connection.yaml");
  if (existsSync(p)) {
    const doc = parseYaml(readFileSync(p, "utf8"));
    const dsn = doc?.endpoints?.app?.connectionString;
    if (dsn) return dsn;
  }
  throw new Error(
    "缺少 Postgres 连接串：设置 FS_PG_DSN，或在 documents/analytics-db.connection.yaml 的 endpoints.app 提供",
  );
}

export const pool = new Pool({ connectionString: resolveDsn(), max: 8 });

/** 只读查询 */
export async function q<T = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T[]> {
  const r = await pool.query(text, params);
  return r.rows as T[];
}

/**
 * 带审计身份的写事务。
 * ref.log_change 触发器读取 app.user_id 记录真实操作人——不设的话审计只记到 fs_app，等于没做。
 */
export async function withUser<T>(userId: string, fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    // set_config 的第三个参数 true = SET LOCAL，事务结束自动清除
    await c.query("SELECT set_config('app.user_id', $1, true)", [userId]);
    const out = await fn(c);
    await c.query("COMMIT");
    return out;
  } catch (e) {
    await c.query("ROLLBACK");
    throw e;
  } finally {
    c.release();
  }
}
