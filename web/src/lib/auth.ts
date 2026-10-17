/**
 * 前端登录态。token 存 localStorage；身份/角色从后端签发的 JWT 载荷读。
 * 审计身份不再由前端提供——后端从 token 解出，前端无法伪造。
 */
import { useSyncExternalStore } from "react";

export interface AuthUser { sub: string; name: string; email: string | null; role: "admin" | "editor" | "viewer"; }

const TOKEN_KEY = "fs.token";
const USER_KEY = "fs.user";
const listeners = new Set<() => void>();

function read<T>(k: string): T | null {
  try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : null; } catch { return null; }
}
let token: string | null = (() => { try { return localStorage.getItem(TOKEN_KEY); } catch { return null; } })();
let user: AuthUser | null = read<AuthUser>(USER_KEY);

function emit() { listeners.forEach((l) => l()); }

export function getToken() { return token; }
export function getUser() { return user; }
export function isAuthed() { return !!token; }

export function setSession(t: string, u: AuthUser) {
  token = t; user = u;
  try { localStorage.setItem(TOKEN_KEY, t); localStorage.setItem(USER_KEY, JSON.stringify(u)); } catch { /* ignore */ }
  emit();
}
export function clearSession() {
  token = null; user = null;
  try { localStorage.removeItem(TOKEN_KEY); localStorage.removeItem(USER_KEY); } catch { /* ignore */ }
  emit();
}
export function subscribeAuth(l: () => void) { listeners.add(l); return () => { listeners.delete(l); }; }

export function useAuth() {
  return useSyncExternalStore(subscribeAuth, () => user, () => user);
}
export function canEdit(u: AuthUser | null) { return u?.role === "admin" || u?.role === "editor"; }
