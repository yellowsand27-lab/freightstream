import type { FastifyInstance } from "fastify";
import { createHmac, timingSafeEqual } from "node:crypto";
import { createReadStream, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { q } from "../db.js";

const here = dirname(fileURLToPath(import.meta.url));
const API_ROOT = resolve(here, "..", "..");
// documents for the console Documents page: the site's /share/ folder (server) or the repository's share/ (local)
const SHARE = process.env.FS_SHARE_DIR ?? ["/var/www/ai.transknights.com/share", resolve(API_ROOT, "..", "share")].find((d) => existsSync(d)) ?? "";
const TYPES: Record<string, string> = { ".pdf": "application/pdf", ".html": "text/html; charset=utf-8", ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" };
// signed links (a new tab cannot send the Bearer token): HMAC with a key that only lives in this process' environment
const LINK_KEY = process.env.FS_JWT_SECRET ?? process.env.FS_PG_DSN ?? "fs-local";
const sig = (file: string, exp: number) => createHmac("sha256", LINK_KEY).update(`file:${file}:${exp}`).digest("base64url");
const shareFile = (name: string) => { const f = resolve(SHARE, name); return SHARE && dirname(f) === SHARE && TYPES[extname(f).toLowerCase()] && existsSync(f) ? f : null; };

/** 数据水位线：网页上的「数据截至 X」直接读这里，让看的人知道数据是什么时候的 */
export default async function meta(app: FastifyInstance) {
  app.get("/api/meta/refresh", async () => {
    const rows = await q<{ table_name: string; status: string; row_count: number; finished_at: string }>(`
      SELECT DISTINCT ON (table_name) table_name, status, row_count, finished_at
      FROM mirror.refresh_log
      WHERE status = 'ok'
      ORDER BY table_name, started_at DESC`);
    const asOf = rows.reduce<string | null>((m, r) => (!m || r.finished_at > m ? r.finished_at : m), null);
    return { asOf, tables: rows };
  });

  // 中台「运行状态」页用（docs/03-module-contract.md）：夜间同步任务的最近一次结果 + 数据时间
  app.get("/api/status", async () => {
    const [last] = await q<{ finished_at: string | null; started_at: string; ok: number; failed: number; rows: number }>(`
      WITH run AS (SELECT * FROM mirror.refresh_log WHERE started_at > (SELECT MAX(started_at) FROM mirror.refresh_log) - interval '6 hours')
      SELECT MAX(finished_at) finished_at, MIN(started_at) started_at,
             COUNT(*) FILTER (WHERE status = 'ok')::int ok, COUNT(*) FILTER (WHERE status <> 'ok')::int failed,
             COALESCE(SUM(row_count) FILTER (WHERE status = 'ok'), 0)::int rows
      FROM run`);
    const status = !last?.started_at ? "planned" : last.failed ? "partial" : "ok";
    // fs-etl.timer: every day 03:00 UTC
    const next = new Date(); next.setUTCHours(3, 0, 0, 0); if (next.getTime() <= Date.now()) next.setUTCDate(next.getUTCDate() + 1);
    return {
      jobs: [{ id: "etl", title: { en: "Nightly refresh from iFMS", zh: "每晚从 iFMS 同步" }, schedule: "03:00 UTC", next: next.toISOString(),
        last: last?.started_at ? { at: last.finished_at ?? last.started_at, status, summary: { tables: last.ok + last.failed, failed: last.failed, rows: last.rows } } : null }],
      alerts: last?.failed ? [{ level: "warn", text: { en: `${last.failed} table(s) failed in the last refresh`, zh: `最近一次同步有 ${last.failed} 张表失败` }, at: last.finished_at }] : [],
      data: { asOf: last?.finished_at ?? null }
    };
  });

  // ---- TransKnights AI Console: documents, signed file links, milestones (docs/03-module-contract.md)
  app.get("/api/docs", async () => ({
    docs: (SHARE ? readdirSync(SHARE) : []).filter((f) => TYPES[extname(f).toLowerCase()]).map((f) => ({
      path: `s/${f}`, title: f.replace(/\.[^.]+$/, "").replace(/-/g, " "), type: extname(f).slice(1).toLowerCase(),
      updated: statSync(join(SHARE, f)).mtime.toISOString(), group: "reference", lang: /[\u4e00-\u9fff]/.test(f) ? "zh" : "en" }))
  }));
  app.post<{ Body: { path?: string } }>("/api/files/link", async (req, reply) => {
    const p = String(req.body?.path ?? "");
    if (!p.startsWith("s/") || !shareFile(p.slice(2))) return reply.code(404).send({ error: "not_found" });
    const exp = Date.now() + 10 * 60_000;
    return { url: `/files/${exp}.${sig(p, exp)}/${p.split("/").map(encodeURIComponent).join("/")}` };
  });
  app.get<{ Params: { exp: string; sig: string; "*": string } }>("/api/files/:exp.:sig/*", async (req, reply) => {
    const p = req.params["*"]; const exp = Number(req.params.exp);
    const good = Buffer.from(sig(p, exp)); const got = Buffer.from(req.params.sig);
    const f = exp > Date.now() && good.length === got.length && timingSafeEqual(good, got) && p.startsWith("s/") ? shareFile(p.slice(2)) : null;
    if (!f) return reply.code(404).send("Not found or link expired");
    return reply.type(TYPES[extname(f).toLowerCase()]).header("Cache-Control", "private, max-age=300").send(createReadStream(f));
  });
  app.get("/api/milestones", async () => {
    const raw = parseYaml(readFileSync(join(API_ROOT, "milestones.yaml"), "utf8"));
    return { ...raw, id: "fs" };
  });
}
