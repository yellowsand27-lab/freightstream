import { useEffect } from "react";
import { App } from "antd";
import { useTranslation } from "react-i18next";
import { ApiError } from "../lib/api";

/**
 * API 失败的全局兜底提示。
 *
 * 页面里大量地方是 `api.get(...).then(setX)` 没有 .catch——请求一失败 state 永远是
 * null，`loading={!x}` 的卡片/表格就永远转骨架屏，不报错也不提示。2026-09-29 生产
 * 首页就是这样：/api/overview 连续 500 了七次，页面上什么都看不出来。
 *
 * 这里监听 unhandledrejection：没被接住的 ApiError 一律弹一条。骨架屏仍会转
 * （那要各页自己处理，见 pages/Overview 的错误态），但至少"坏了"这件事是可见的。
 * 自己 catch 过的不会触发这个事件，所以不会和页面内的错误提示重复。
 */
export default function ApiErrorToast() {
  const { message } = App.useApp();
  const { t } = useTranslation();

  useEffect(() => {
    const onRejection = (e: PromiseRejectionEvent) => {
      // 只认 API 失败；其余 rejection 照常留给控制台，别把无关报错也弹成 toast
      if (!(e.reason instanceof ApiError)) return;
      const err = e.reason;
      // 故意不调 e.preventDefault()：浏览器控制台里那条 Uncaught (in promise)
      // 是排查时唯一能拿到调用栈的地方，压掉它等于用一个静默换另一个静默
      // 401 已经清了会话，路由层会弹回登录页，再弹一条提示是噪音
      if (err.status === 401) return;
      // 按状态码共用 key：一个页面并发五个请求一起挂时只弹一条，而不是五条
      message.error({ key: `api-${err.status}`, content: t(err.errorKey) });
    };
    window.addEventListener("unhandledrejection", onRejection);
    return () => window.removeEventListener("unhandledrejection", onRejection);
  }, [message, t]);

  return null;
}
