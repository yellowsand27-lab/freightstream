import { Progress, Space } from "antd";
import { ProTable, type ProColumns } from "@ant-design/pro-components";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { api, type Paged } from "../lib/api";
import { useFmt } from "../lib/format";
import ModelTag from "../components/ModelTag";
import InfoLabel from "../components/InfoLabel";

interface Exposure {
  entity_id: number; entity_name: string; business_model: string; open_invoices: number; total_open: string;
  overdue_by_baseline: string; max_days_past_baseline: number | null; credit_limit: string | null;
  limit_utilization: string | null; median_days_to_pay: string | null; on_time_rate: string | null; sample_n: number | null;
}

export default function CustomersPage() {
  const { t } = useTranslation();
  const f = useFmt();

  const cols: ProColumns<Exposure>[] = [
    { title: t("cust.name"), dataIndex: "search", ellipsis: true, sorter: true,
      render: (_, r) => <Space><Link to={`/customers/${r.entity_id}`}>{r.entity_name}</Link><ModelTag value={r.business_model} /></Space>,
      fieldProps: { placeholder: t("cust.search") } },
    { title: t("cust.model"), dataIndex: "model", valueType: "select", hideInTable: true,
      valueEnum: { direct: t("cust.modelValue.direct"), agency: t("cust.modelValue.agency"), unknown: t("cust.modelValue.unknown") } },
    { title: <InfoLabel title={t("cust.openInvoices")} help={t("cust.openInvoicesHelp")} />, dataIndex: "open_invoices", width: 80, align: "right", sorter: true, search: false },
    { title: <InfoLabel title={t("cust.totalOpen")} help={t("cust.totalOpenHelp")} />, dataIndex: "total_open", width: 130, align: "right", sorter: true, search: false, render: (_, r) => <b>{f.money(r.total_open)}</b> },
    { title: <InfoLabel title={t("cust.overdue")} help={t("cust.overdueHelp")} />, dataIndex: "overdue_by_baseline", width: 130, align: "right", sorter: true, search: false,
      render: (_, r) => Number(r.overdue_by_baseline) ? <span style={{ color: "#d03b3b" }}>{f.money(r.overdue_by_baseline)}</span> : "—" },
    { title: t("cust.limit"), dataIndex: "credit_limit", width: 110, align: "right", search: false, render: (_, r) => r.credit_limit && Number(r.credit_limit) >= 100 ? f.money(r.credit_limit) : "—" },
    { title: <InfoLabel title={t("cust.utilization")} help={t("cust.utilizationHelp")} />, dataIndex: "limit_utilization", width: 160, sorter: true, search: false,
      render: (_, r) => {
        if (!r.limit_utilization || Number(r.credit_limit) < 100) return "—";
        const u = Number(r.limit_utilization);
        return <Progress percent={Math.min(100, u * 100)} size="small" status={u >= 1 ? "exception" : u >= 0.8 ? "active" : "normal"}
          format={() => f.pct(u)} strokeColor={u >= 1 ? "#d03b3b" : u >= 0.8 ? "#fab219" : undefined} />;
      } },
    { title: <InfoLabel title={t("cust.medianDays")} help={t("cust.medianDaysHelp")} />, dataIndex: "median_days_to_pay", width: 110, align: "right", search: false, render: (_, r) => r.median_days_to_pay ? f.days(Math.round(Number(r.median_days_to_pay))) : "—" },
    { title: <InfoLabel title={t("cust.onTime")} help={t("cust.onTimeHelp")} />, dataIndex: "on_time_rate", width: 90, align: "right", search: false, render: (_, r) => r.on_time_rate ? f.pct(r.on_time_rate) : "—" },
    { title: t("cust.openOnly"), dataIndex: "openOnly", valueType: "switch", hideInTable: true, initialValue: true },
  ];

  return (
    <ProTable<Exposure> rowKey="entity_id" columns={cols} search={{ labelWidth: "auto" }}
      request={async (params, sort) => {
        const [sortKey] = Object.keys(sort);
        const r = await api.get<Paged<Exposure>>("/api/customers", {
          page: params.current, pageSize: params.pageSize, search: params.search, model: params.model,
          openOnly: params.openOnly === undefined ? true : params.openOnly,
          sort: sortKey === "search" ? "entity_name" : sortKey, order: sortKey ? (sort[sortKey] === "ascend" ? "asc" : "desc") : undefined });
        return { data: r.data, total: r.total, success: true };
      }}
      pagination={{ pageSize: 50, showSizeChanger: true }} options={{ density: false }} scroll={{ x: 1100 }} />
  );
}
