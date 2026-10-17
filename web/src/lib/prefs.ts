/**
 * 用户偏好：语言、时区、操作人身份。
 * 持久化在 localStorage；正式上线后 user 应来自认证会话，这里只是开发期占位。
 *
 * 时区默认值属于「租户/系统策略」：Transknights 主营美西港口业务，默认太平洋时间。
 */
export const SUPPORTED_LOCALES = ["en-US", "zh-CN", "es-ES"] as const;
export type Locale = (typeof SUPPORTED_LOCALES)[number];
export const FALLBACK_LOCALE: Locale = "en-US";
export const DEFAULT_TIMEZONE = "America/Los_Angeles";

const KEY = "fs.prefs.v1";

export interface Prefs {
  locale: Locale | null; // null = 跟随浏览器
  timezone: string;
  user: string;
}

function read(): Prefs {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return { locale: null, timezone: DEFAULT_TIMEZONE, user: "", ...JSON.parse(raw) };
  } catch { /* 隐私模式或被禁用时静默回退 */ }
  return { locale: null, timezone: DEFAULT_TIMEZONE, user: "" };
}

let cache = read();
const listeners = new Set<() => void>();

export function getPrefs(): Prefs { return cache; }
export function setPrefs(patch: Partial<Prefs>) {
  cache = { ...cache, ...patch };
  try { localStorage.setItem(KEY, JSON.stringify(cache)); } catch { /* ignore */ }
  listeners.forEach((l) => l());
}
export function subscribePrefs(l: () => void) { listeners.add(l); return () => { listeners.delete(l); }; }

/** 浏览器语言 → 支持的语言，取不到就回退 en-US */
export function detectLocale(): Locale {
  const cands = [...(navigator.languages ?? []), navigator.language].map((s) => s.toLowerCase());
  for (const c of cands) {
    if (c.startsWith("zh")) return "zh-CN";
    if (c.startsWith("es")) return "es-ES";
    if (c.startsWith("en")) return "en-US";
  }
  return FALLBACK_LOCALE;
}
export function effectiveLocale(): Locale { return cache.locale ?? detectLocale(); }
