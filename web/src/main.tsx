import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { initI18n } from "./i18n";
import App from "./App";

// 语言包加载完成后再渲染，避免首屏闪现 key
initI18n().then(() => {
  createRoot(document.getElementById("root")!).render(<StrictMode><App /></StrictMode>);
});
