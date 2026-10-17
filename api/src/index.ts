/**
 * FreightStream 分析 API
 *
 * 一个薄层：把 mart.* 视图暴露为 JSON，写路径只有 ref（额度、业务模式），且全部走审计事务。
 * 不含任何业务计算——口径全部在数据库视图里，这样网页、通知器、BI 看到的是同一套数字。
 */
import Fastify from "fastify";
import cors from "@fastify/cors";
import { authRoutes, requireAuth } from "./auth.js";
import meta from "./routes/meta.js";
import overview from "./routes/overview.js";
import alerts from "./routes/alerts.js";
import receivables from "./routes/receivables.js";
import customers from "./routes/customers.js";
import costs from "./routes/costs.js";
import billing from "./routes/billing.js";
import analytics from "./routes/analytics.js";
import profit from "./routes/profit.js";
import staff from "./routes/staff.js";

const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? "info" } });

await app.register(cors, { origin: true, methods: ["GET", "PUT", "POST"], allowedHeaders: ["content-type", "authorization"] });

app.get("/api/health", async () => ({ ok: true, version: "0.2.0", ts: new Date().toISOString() }));

// 登录接口（公开）
await app.register(authRoutes);

// 其余所有 /api 接口都要登录。onRequest 钩子只拦 /api，放过 /api/health 与 /api/auth/*
app.addHook("onRequest", async (req, reply) => {
  const url = req.url.split("?")[0];
  if (!url.startsWith("/api/")) return;
  if (url === "/api/health" || url.startsWith("/api/auth/")) return;
  await requireAuth(req, reply);
});

await app.register(meta);
await app.register(overview);
await app.register(alerts);
await app.register(receivables);
await app.register(customers);
await app.register(costs);
await app.register(billing);
await app.register(analytics);
await app.register(profit);
await app.register(staff);

const port = Number(process.env.PORT ?? 8787);
await app.listen({ port, host: process.env.HOST ?? "127.0.0.1" });
