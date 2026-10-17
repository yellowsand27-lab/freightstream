import { Avatar, Dropdown, Space, Tag, Typography } from "antd";
import { GlobalOutlined, LogoutOutlined, CheckOutlined } from "@ant-design/icons";
import { useTranslation } from "react-i18next";
import { changeLocale } from "../i18n";
import { SUPPORTED_LOCALES, detectLocale, setPrefs, type Locale } from "../lib/prefs";
import { usePrefs } from "../lib/format";
import { useAuth, clearSession } from "../lib/auth";

const LOCALE_LABEL: Record<Locale, string> = { "en-US": "English", "zh-CN": "中文", "es-ES": "Español" };

export function LanguageMenu({ dark }: { dark?: boolean }) {
  const { t } = useTranslation();
  const { locale } = usePrefs();
  const current = locale ?? detectLocale();
  const pick = async (v: Locale | null) => { setPrefs({ locale: v }); await changeLocale(v ?? detectLocale()); };
  return (
    <Dropdown trigger={["click"]} menu={{
      selectedKeys: [locale ?? "auto"],
      items: [
        { key: "auto", label: t("topbar.followBrowser"), icon: locale === null ? <CheckOutlined /> : <span style={{ width: 14, display: "inline-block" }} />, onClick: () => pick(null) },
        { type: "divider" },
        ...SUPPORTED_LOCALES.map((l) => ({ key: l, label: LOCALE_LABEL[l], icon: locale === l ? <CheckOutlined /> : <span style={{ width: 14, display: "inline-block" }} />, onClick: () => pick(l) })),
      ] }}>
      <Space style={{ cursor: "pointer", color: dark ? "#C5CDE6" : "#C5CDE6", padding: "0 8px" }} title={t("topbar.language")}>
        <GlobalOutlined /><span>{LOCALE_LABEL[current]}</span>
      </Space>
    </Dropdown>
  );
}

const ROLE_COLOR: Record<string, string> = { admin: "purple", editor: "blue", viewer: "default" };

export function UserMenu() {
  const { t } = useTranslation();
  const user = useAuth();
  if (!user) return null;
  const initials = user.name.replace(/[^A-Za-z ]/g, "").split(/\s+/).map((w) => w[0]).join("").slice(0, 2).toUpperCase() || user.sub.slice(0, 2).toUpperCase();
  return (
    <Dropdown trigger={["click"]} menu={{ items: [
      { key: "who", disabled: true, label: (
        <div style={{ padding: "4px 0" }}>
          <div style={{ fontWeight: 600 }}>{user.name}</div>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>{user.email || user.sub}</Typography.Text>
          <div style={{ marginTop: 4 }}><Tag color={ROLE_COLOR[user.role]}>{t(`role.${user.role}`)}</Tag></div>
        </div>) },
      { type: "divider" },
      { key: "out", icon: <LogoutOutlined />, label: t("topbar.signOut"), onClick: () => clearSession() },
    ] }}>
      <Space style={{ cursor: "pointer", padding: "0 8px" }}>
        <Avatar size="small" style={{ background: "#0F64AA" }}>{initials}</Avatar>
        <span style={{ color: "#C5CDE6" }}>{user.name}</span>
      </Space>
    </Dropdown>
  );
}
