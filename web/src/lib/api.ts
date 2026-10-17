/**
 * API 客户端。所有写请求带 x-user 头——后端用它设置审计上下文。
 * 后端错误文本会被映射成本地化消息（见 errorKey）。
 */
import { getToken, clearSession } from "./auth";

export class ApiError extends Error {
  constructor(public status: number, public body: unknown) {
    super(`HTTP ${status}`);
  }
  /** 把后端错误映射到 locale key；映射不到时返回通用 key */
  get errorKey(): string {
    if (this.status === 0) return "error.network";   // 请求压根没发出去/没回来
    if (this.status === 401) return "error.unauthenticated";
    if (this.status === 404) return "error.notFound";
    if (this.status >= 500) return "error.server";
    return "error.request";
  }
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (body !== undefined) headers["content-type"] = "application/json";
  const tok = getToken();
  if (tok) headers["authorization"] = `Bearer ${tok}`;
  // 断网 / DNS 失败时 fetch 抛的是 TypeError，不是 ApiError。统一收敛成 status 0 的
  // ApiError，这样调用方和全局兜底（components/ApiErrorToast）只需要认一种错误类型。
  let res: Response;
  try {
    res = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch (e) {
    throw new ApiError(0, { cause: e instanceof Error ? e.message : String(e) });
  }
  if (!res.ok) {
    // token 失效/过期：清除会话，路由层会弹回登录页
    if (res.status === 401 && path !== "/api/auth/login") clearSession();
    let payload: unknown = null;
    try { payload = await res.json(); } catch { /* non-json */ }
    throw new ApiError(res.status, payload);
  }
  return (await res.json()) as T;
}

export const api = {
  post: <T>(path: string, body: unknown) => call<T>("POST", path, body),
  get: <T>(path: string, params?: Record<string, unknown>) => {
    const qs = params
      ? "?" + Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== "")
          .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`).join("&")
      : "";
    return call<T>("GET", path + (qs === "?" ? "" : qs));
  },
  put: <T>(path: string, body: unknown) => call<T>("PUT", path, body),
};

export interface Paged<T> { data: T[]; total: number; }
