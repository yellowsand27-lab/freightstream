import { useEffect, useState } from "react";
import { Alert, Space, Tag, Typography } from "antd";
import { ProTable, type ProColumns } from "@ant-design/pro-components";
import { useSearchParams, Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { api } from "../lib/api";
import { useFmt } from "../lib/format";
import Severity from "../components/Severity";
import InfoLabel from "../components/InfoLabel";

interface AlertRow {
  alert_code: string; dedup_key: string; entity_id: number | null; shipment_id: number | null;
  severity: string; amount: string | null; subject_zh: string; subject_en: string; detail_json: Record<string, unknown>;
}
interface Rule { alert_code: string; title_zh: string; title_en: string; schedule_cron: string; throttle_hours: number; enabled: boolean }

const CODES = ["credit_breach", "payment_overdue", "unrecovered_cost", "duplicate_payment", "billing_delay"];

export default function AlertsPage() {
  const { t, i18n } = useTranslation();
  const f = useFmt();
  const [sp] = useSearchParams();
  const [rules, setRules] = useState<Rule[]>([]);
  useEffect(() => { api.get<Rule[]>("/api/alerts/rules").then(setRules); }, []);
  const zh = i18n.language.startsWith("zh");

  const columns: ProColumns<AlertRow>[] = [
    { title: <InfoLabel title={t("alerts.severity")} help={t("alerts.severityHelp")} />, dataIndex: "severity", width: 100, render: (_, r) => <Severity value={r.severity} />,
      valueType: "select", valueEnum: { critical: t("severity.critical"), serious: t("severity.serious"), warning: t("severity.warning") } },
    { title: t("alerts.code"), dataIndex: "alert_code", width: 170, render: (_, r) => <Tag>{t(`alertCode.${r.alert_code}`)}</Tag>,
      valueType: "select", valueEnum: Object.fromEntries(CODES.map((c) => [c, t(`alertCode.${c}`)])), initialValue: sp.get("code") ?? undefined },
    { title: t("alerts.subject"), dataIndex: "subject", search: false,
      render: (_, r) => r.entity_id ? <Link to={`/customers/${r.entity_id}`}>{zh ? r.subject_zh : r.subject_en}</Link> : (zh ? r.subject_zh : r.subject_en) },
    { title: <InfoLabel title={t("alerts.amount")} help={t("alerts.amountHelp")} />, dataIndex: "amount", width: 140, align: "right", search: false, render: (_, r) => f.money(r.amount) },
  ];

  return (
    <Space direction="vertical" size={16} style={{ width: "100%" }}>
      <Alert type="info" showIcon message={t("alerts.intro")} />
      <ProTable<AlertRow> rowKey="dedup_key" columns={columns} search={{ labelWidth: "auto" }}
        request={async (params) => {
          const r = await api.get<{ data: AlertRow[]; total: number }>("/api/alerts", { code: params.alert_code, severity: params.severity });
          return { data: r.data, total: r.total, success: true };
        }}
        pagination={{ pageSize: 20 }} options={{ density: false, setting: false }} />

      <ProTable<Rule> rowKey="alert_code" headerTitle={t("alerts.rules")} dataSource={rules} search={false} pagination={false}
        options={false} toolBarRender={false}
        columns={[
          { title: t("alerts.code"), dataIndex: "alert_code", render: (_, r) => zh ? r.title_zh : r.title_en },
          { title: <InfoLabel title={t("alerts.schedule")} help={t("alerts.scheduleHelp")} />, dataIndex: "schedule_cron", render: (v) => <Typography.Text code>{String(v)}</Typography.Text> },
          { title: <InfoLabel title={t("alerts.throttle")} help={t("alerts.throttleHelp")} />, dataIndex: "throttle_hours", align: "right" },
          { title: t("alerts.enabled"), dataIndex: "enabled", render: (_, r) => <Tag color={r.enabled ? "green" : "default"}>{r.enabled ? t("alerts.enabled") : t("alerts.disabled")}</Tag> },
        ]} />
      <Typography.Text type="secondary">{t("alerts.rulesHint")}</Typography.Text>
    </Space>
  );
}
