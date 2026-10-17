import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    port: 5173,
    proxy: { "/api": { target: "http://127.0.0.1:8787", changeOrigin: true } },
  },
  // npm run preview：用生产构建产物 + 本地 API，部署前的完整本地测试
  preview: {
    host: true,               // 监听 0.0.0.0，局域网可用 IP 访问
    port: 4173,
    proxy: { "/api": { target: "http://127.0.0.1:8787", changeOrigin: true } },
  },
  build: {
    rollupOptions: {
      output: {
        // 语言包与图表库单独分块，按需加载
        manualChunks: {
          antd: ["antd", "@ant-design/pro-components", "@ant-design/icons"],
          echarts: ["echarts", "echarts-for-react"],
        },
      },
    },
  },
});
