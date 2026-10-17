/**
 * 认证：以 FS 账户登录，密码实时直连 FS 校验。
 *
 * - 登录时直连 FS 生产库（只读账号）读 T_USER，当场核对密码——
 *   分析库不存任何密码（连哈希都不存），改了 FS 密码/新增用户立即生效
 * - FS 密码是明文 + 末尾 0x1C 结束符，去掉结束符后做常量时间比较
 * - 角色按 FS 分组直接判定（组成员在 FS 维护，组→角色为固定策略，可环境变量覆盖）
 * - 登录成功签发 JWT（HS256）；之后受保护接口读 Bearer token
 * - 审计身份来自 token，不信任客户端头
 * - 代价：FS 库不可达时无法登录（登录是唯一依赖 FS 的在线路径）
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import jwt from "jsonwebtoken";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { fetchFsUser } from "./mssql.js";
import { verifyConsoleToken } from "./consoleToken.js";

const here = dirname(fileURLToPath(import.meta.url));
const SECRET_FILE = resolve(here, "..", ".jwt_secret");

/** 签名密钥：优先环境变量；否则本地文件（首次生成），让 dev 重启后 token 不失效 */
function jwtSecret(): string {
  if (process.env.FS_JWT_SECRET) return process.env.FS_JWT_SECRET;
  if (existsSync(SECRET_FILE)) return readFileSync(SECRET_FILE, "utf8").trim();
  const s = randomBytes(48).toString("base64url");
  writeFileSync(SECRET_FILE, s, { mode: 0o600 });
  return s;
}
const SECRET = jwtSecret();
const TTL_HOURS = Number(process.env.FS_JWT_TTL_HOURS ?? 12);

/**
 * FS 分组 → 应用角色。分组成员在 FS 系统里维护（谁属于哪个组），
 * 这里只是"哪些组算可写"的固定策略，很少变动。
 * 可用环境变量覆盖（逗号分隔，大小写不敏感）：
 *   FS_ADMIN_GROUPS="Admin"
 *   FS_EDITOR_GROUPS="Managers,CPA & GM,Accounting"
 * 未列入的分组一律 viewer（最小权限）。
 */
const norm = (s: string) => s.trim().toLowerCase();
const parseGroups = (env: string | undefined, def: string[]) =>
  new Set((env ? env.split(",") : def).map(norm).filter(Boolean));
const ADMIN_GROUPS = parseGroups(process.env.FS_ADMIN_GROUPS, ["Admin"]);
const EDITOR_GROUPS = parseGroups(process.env.FS_EDITOR_GROUPS, ["Managers", "CPA & GM", "Accounting"]);

function roleForGroup(groupName: string | null): AuthUser["role"] {
  const g = norm(groupName ?? "");
  if (ADMIN_GROUPS.has(g)) return "admin";
  if (EDITOR_GROUPS.has(g)) return "editor";
  return "viewer";
}

export interface AuthUser { sub: string; name: string; email: string | null; role: "admin" | "editor" | "viewer"; }

declare module "fastify" {
  interface FastifyRequest { user?: AuthUser; }
}

export async function authRoutes(app: FastifyInstance) {
  app.post<{ Body: { userId?: string; password?: string } }>("/api/auth/login", async (req, reply) => {
    const userId = String(req.body?.userId ?? "").trim();
    const password = String(req.body?.password ?? "");
    if (!userId || !password) return reply.code(400).send({ error: "userId and password required" });

    let fsu;
    try {
      fsu = await fetchFsUser(userId);            // 直连 FS 只读查询
    } catch (e) {
      req.log.error({ err: e }, "FS auth lookup failed");
      return reply.code(503).send({ error: "auth_source_unavailable" }); // FS 库不可达
    }

    // 无论用户是否存在都做一次等长比较，避免用用户名探测
    const stored = fsu?.password ? stripSentinel(fsu.password) : null;
    const ok = constantTimeEqual(password, stored);
    if (!fsu || !fsu.enabled || !stored || !ok) {
      return reply.code(401).send({ error: "invalid_credentials" });
    }

    // 角色按 FS 分组直接判定，分组成员在 FS 里维护
    const role = roleForGroup(fsu.groupName);

    const user: AuthUser = { sub: fsu.userId, name: fsu.userName ?? fsu.userId, email: fsu.email, role };
    const token = jwt.sign(user, SECRET, { expiresIn: `${TTL_HOURS}h` });
    return { token, user, expiresInHours: TTL_HOURS };
  });

  app.get("/api/auth/me", { preHandler: requireAuth }, async (req) => ({ user: req.user }));
}

/** FS 密码 = 明文 + 末尾 0x1C；去掉结束符还原明文 */
function stripSentinel(pw: string): string {
  return pw.endsWith("\u001c") ? pw.slice(0, -1) : pw;
}

/** 常量时间比较，长度不同也不早退（避免时序侧信道） */
function constantTimeEqual(a: string, b: string | null): boolean {
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b ?? "", "utf8");
  const len = Math.max(ba.length, bb.length, 1);
  const pa = Buffer.alloc(len); ba.copy(pa);
  const pb = Buffer.alloc(len); bb.copy(pb);
  const eq = timingSafeEqual(pa, pb);
  return eq && b !== null && ba.length === bb.length;
}

/** 校验 Bearer token，挂到 req.user */
export async function requireAuth(req: FastifyRequest, reply: FastifyReply) {
  const h = req.headers.authorization;
  if (!h?.startsWith("Bearer ")) return reply.code(401).send({ error: "unauthenticated" });
  // 中台令牌（Ed25519）优先；旧的 FreightStream 令牌（HS256）在切换到中台前仍然接受
  const c = await verifyConsoleToken(h.slice(7));
  if (c) {
    if (c.level === "none") return reply.code(403).send({ error: "forbidden" });
    req.user = { sub: c.sub, name: c.name, email: c.email, role: c.level };
    return;
  }
  try {
    req.user = jwt.verify(h.slice(7), SECRET) as AuthUser;
  } catch {
    return reply.code(401).send({ error: "token_expired_or_invalid" });
  }
}

/** 要求可写角色（admin / editor）——用于额度、分类等写接口 */
export async function requireEditor(req: FastifyRequest, reply: FastifyReply) {
  await requireAuth(req, reply);
  if (reply.sent) return;
  if (req.user!.role === "viewer") return reply.code(403).send({ error: "forbidden_read_only" });
}
