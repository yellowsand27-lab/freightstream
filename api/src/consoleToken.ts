/**
 * TransKnights AI 中台令牌（Ed25519 JWT）校验。
 *
 * 中台 console-api 用私钥签发；这里只拿公钥（GET /api/console/auth/jwks）校验，所以本服务无法伪造令牌。
 * 权限：令牌里的 perms.fs（none / viewer / editor / admin）。
 */
import { createPublicKey, verify, type JsonWebKey, type KeyObject } from "node:crypto";

const JWKS_URL = process.env.TK_CONSOLE_JWKS ?? "http://127.0.0.1:1450/api/console/auth/jwks";
const ISSUER = "tk-console";
const AUDIENCE = "tk-modules";
const MODULE = "fs";

let keys = new Map<string, KeyObject>();
let fetchedAt = 0;

/** 公钥缓存；遇到没见过的 kid 才重新拉（最多每分钟一次），console-api 换钥后自动跟上 */
async function keyFor(kid: string): Promise<KeyObject | null> {
  if (!keys.has(kid) && Date.now() - fetchedAt > 60_000) {
    fetchedAt = Date.now();
    try {
      const r = await fetch(JWKS_URL, { signal: AbortSignal.timeout(5000) });
      const { keys: list } = (await r.json()) as { keys: (JsonWebKey & { kid: string })[] };
      keys = new Map(list.map((k) => [k.kid, createPublicKey({ key: k, format: "jwk" })]));
    } catch { /* console-api 不可达：用已缓存的公钥 */ }
  }
  return keys.get(kid) ?? null;
}

export interface ConsoleClaims { sub: string; name: string; email: string | null; level: "none" | "viewer" | "editor" | "admin"; }

/** 是中台令牌 → 解出的身份与 fs 权限；不是（或无效）→ null */
export async function verifyConsoleToken(token: string): Promise<ConsoleClaims | null> {
  const [h, b, s] = token.split(".");
  if (!h || !b || !s) return null;
  let head: { alg?: string; kid?: string };
  try { head = JSON.parse(Buffer.from(h, "base64url").toString()); } catch { return null; }
  if (head.alg !== "EdDSA" || !head.kid) return null;
  const key = await keyFor(head.kid);
  if (!key || !verify(null, Buffer.from(`${h}.${b}`), key, Buffer.from(s, "base64url"))) return null;
  const c = JSON.parse(Buffer.from(b, "base64url").toString());
  if (c.iss !== ISSUER || c.aud !== AUDIENCE || !c.exp || c.exp * 1000 < Date.now()) return null;
  return { sub: c.sub, name: c.name ?? c.sub, email: c.email ?? null, level: c.perms?.[MODULE] ?? "none" };
}
