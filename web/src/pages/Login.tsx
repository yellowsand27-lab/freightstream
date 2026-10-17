import { useState } from "react";
import { App, Button, Card, Form, Input, Space, Typography } from "antd";
import { UserOutlined, LockOutlined } from "@ant-design/icons";
import { useTranslation } from "react-i18next";
import { api, ApiError } from "../lib/api";
import { setSession, type AuthUser } from "../lib/auth";
import { LanguageMenu } from "../components/TopBar";

export default function LoginPage() {
  const { t } = useTranslation();
  const { message } = App.useApp();
  const [loading, setLoading] = useState(false);

  const submit = async (v: { userId: string; password: string }) => {
    setLoading(true);
    try {
      const r = await api.post<{ token: string; user: AuthUser }>("/api/auth/login", v);
      setSession(r.token, r.user);
    } catch (e) {
      message.error(t(e instanceof ApiError && e.status === 401 ? "login.invalid" : "error.server"));
    } finally { setLoading(false); }
  };

  return (
    <div style={{ minHeight: "100vh", display: "grid", placeItems: "center", background: "#212D59" }}>
      <div style={{ position: "fixed", top: 16, right: 20 }}><LanguageMenu dark /></div>
      <Card style={{ width: 380, boxShadow: "0 8px 32px rgba(0,0,0,.2)" }}>
        <Space direction="vertical" size={20} style={{ width: "100%" }}>
          <div style={{ textAlign: "center" }}>
            <img src="/brand/shield.png" alt="" style={{ height: 56 }} />
            <Typography.Title level={4} style={{ margin: "12px 0 0" }}>{t("app.title")}</Typography.Title>
            <Typography.Text type="secondary">{t("login.subtitle")}</Typography.Text>
          </div>
          <Form onFinish={submit} layout="vertical" requiredMark={false}>
            <Form.Item name="userId" rules={[{ required: true }]}>
              <Input size="large" prefix={<UserOutlined />} placeholder={t("login.userId")} autoFocus autoComplete="username" />
            </Form.Item>
            <Form.Item name="password" rules={[{ required: true }]}>
              <Input.Password size="large" prefix={<LockOutlined />} placeholder={t("login.password")} autoComplete="current-password" />
            </Form.Item>
            <Button type="primary" size="large" htmlType="submit" block loading={loading}>{t("login.submit")}</Button>
          </Form>
          <Typography.Text type="secondary" style={{ fontSize: 12, display: "block", textAlign: "center" }}>{t("login.hint")}</Typography.Text>
        </Space>
      </Card>
    </div>
  );
}
