import { useMemo, useState, useSyncExternalStore, type ReactNode } from "react";
import { App as AntApp, ConfigProvider, Grid, theme } from "antd";
import type { Locale as AntLocale } from "antd/es/locale";
import enUS from "antd/locale/en_US";
import zhCN from "antd/locale/zh_CN";
import esES from "antd/locale/es_ES";
import { ProLayout } from "@ant-design/pro-components";
import { DashboardOutlined, AlertOutlined, DollarOutlined, TeamOutlined, ReconciliationOutlined, FieldTimeOutlined, SettingOutlined, BarChartOutlined, FundOutlined, TrophyOutlined } from "@ant-design/icons";
import { BrowserRouter, Routes, Route, Link, useLocation, Navigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import dayjs from "dayjs";
import "dayjs/locale/zh-cn";
import "dayjs/locale/es";
import ApiErrorToast from "./components/ApiErrorToast";
import Footer, { FOOTER_HEIGHT } from "./components/Footer";
import { LanguageMenu, UserMenu } from "./components/TopBar";
import LoginPage from "./pages/Login";
import { isAuthed, subscribeAuth } from "./lib/auth";
import OverviewPage from "./pages/Overview";
import AlertsPage from "./pages/Alerts";
import ReceivablesPage from "./pages/Receivables";
import CustomersPage from "./pages/Customers";
import CustomerDetailPage from "./pages/CustomerDetail";
import CostRecoveryPage from "./pages/CostRecovery";
import BillingLagPage from "./pages/BillingLag";
import AnalyticsPage from "./pages/Analytics";
import ProfitabilityPage from "./pages/Profitability";
import OpScorecardPage from "./pages/OpScorecard";
import SettingsPage from "./pages/Settings";

/** 品牌色，取自 transknights.com 的盾形标 */
const BRAND = { blue: "#0F64AA", navy: "#212D59", sky: "#55A7D6", amber: "#FBB03B" } as const;

const ANT_LOCALE: Record<string, AntLocale> = { "en-US": enUS, "zh-CN": zhCN, "es-ES": esES };
const DAYJS_LOCALE: Record<string, string> = { "en-US": "en", "zh-CN": "zh-cn", "es-ES": "es" };

function Providers({ children }: { children: ReactNode }) {
  const { i18n } = useTranslation();
  const lng = i18n.language;
  dayjs.locale(DAYJS_LOCALE[lng] ?? "en");
  return (
    <ConfigProvider locale={ANT_LOCALE[lng] ?? enUS} theme={{ algorithm: theme.defaultAlgorithm, token: { colorPrimary: BRAND.blue, colorInfo: BRAND.blue, borderRadius: 4 } }}>
      <AntApp style={{ height: "100%" }}><ApiErrorToast />{children}</AntApp>
    </ConfigProvider>
  );
}

function Shell() {
  const { t, i18n } = useTranslation();
  const loc = useLocation();
  const lng = i18n.language;
  dayjs.locale(DAYJS_LOCALE[lng] ?? "en");

  // 侧栏宽度受控，页脚据此对齐；移动端侧栏变抽屉，页脚通栏
  const [collapsed, setCollapsed] = useState(false);
  const screens = Grid.useBreakpoint();
  const SIDER = 216;
  const siderOffset = screens.md === false ? 0 : collapsed ? 64 : SIDER;

  // 菜单文案全部走 locale key
  const route = useMemo(() => ({
    routes: [
      { path: "/", name: t("nav.overview"), icon: <DashboardOutlined /> },
      { path: "/analytics", name: t("nav.analytics"), icon: <BarChartOutlined /> },
      { path: "/alerts", name: t("nav.alerts"), icon: <AlertOutlined /> },
      { path: "/receivables", name: t("nav.receivables"), icon: <DollarOutlined /> },
      { path: "/customers", name: t("nav.customers"), icon: <TeamOutlined /> },
      { path: "/profit", name: t("nav.profit"), icon: <FundOutlined /> },
      { path: "/costs", name: t("nav.costs"), icon: <ReconciliationOutlined /> },
      { path: "/billing", name: t("nav.billing"), icon: <FieldTimeOutlined /> },
      { path: "/op", name: t("nav.op"), icon: <TrophyOutlined /> },
      { path: "/settings", name: t("nav.settings"), icon: <SettingOutlined /> },
    ],
  }), [t]);

  return (
    <ProLayout title={t("app.title")} logo={<img src="/brand/shield.png" alt="" style={{ height: 28 }} />} layout="mix" fixSiderbar fixedHeader
          siderWidth={SIDER} collapsed={collapsed} onCollapse={setCollapsed}
          route={route} location={{ pathname: loc.pathname }}
          menuItemRender={(item, dom) => <Link to={item.path ?? "/"}>{dom}</Link>}
          actionsRender={() => [<LanguageMenu key="lang" />, <UserMenu key="user" />]}
          footerRender={() => <Footer offsetLeft={siderOffset} />}
          token={{ header: { colorBgHeader: BRAND.navy, colorHeaderTitle: "#fff", colorTextMenu: "#C5CDE6", colorTextMenuSelected: "#fff", colorBgMenuItemSelected: BRAND.blue },
                   sider: { colorTextMenuSelected: BRAND.blue, colorBgMenuItemSelected: "#E8F1FA" } }}
          contentStyle={{ padding: 20, paddingBottom: FOOTER_HEIGHT + 20 }}>
          <Routes>
            <Route path="/" element={<OverviewPage />} />
            <Route path="/analytics" element={<AnalyticsPage />} />
            <Route path="/alerts" element={<AlertsPage />} />
            <Route path="/receivables" element={<ReceivablesPage />} />
            <Route path="/customers" element={<CustomersPage />} />
            <Route path="/customers/:id" element={<CustomerDetailPage />} />
            <Route path="/profit" element={<ProfitabilityPage />} />
            <Route path="/costs" element={<CostRecoveryPage />} />
            <Route path="/billing" element={<BillingLagPage />} />
            <Route path="/op" element={<OpScorecardPage />} />
            <Route path="/settings" element={<SettingsPage />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
      </ProLayout>
  );
}

function Root() {
  // 订阅登录态：登录/登出即时切换，无需刷新
  const authed = useSyncExternalStore(subscribeAuth, isAuthed, isAuthed);
  return <Providers>{authed ? <BrowserRouter><Shell /></BrowserRouter> : <LoginPage />}</Providers>;
}

export default function App() {
  // 语言 / 主题 需在登录页也生效，所以 ConfigProvider 提到最外层
  return <Root />;
}
