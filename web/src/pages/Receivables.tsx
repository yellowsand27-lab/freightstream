import { useEffect, useState } from "react";
import { Input, Space, Tabs, Tag, Typography } from "antd";
import { ProTable, type ProColumns } from "@ant-design/pro-components";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { api, type Paged } from "../lib/api";
import { useFmt } from "../lib/format";
import ModelTag from "../components/ModelTag";
import InfoLabel from "../components/InfoLabel";

interface OpenItem {
  invoice_id: number; invoice_no: string; entity_id: number | null; entity_name: string | null; business_model: string | null;
  invoice_date: string; due_date: string; freight_balance: string; duty_balance: string; total_balance: string;
  days_past_due_nominal: number; days_past_baseline: number | null;
}
interface Ledger { entity_id: number; entity_name: string; period: string; billed_to_them: string; billed_by_them: string; net_position: string; shipments: number }

function DaysTag({ v }: { v: number | null }) {
  if (v === null) return <>—</>;
  const c = v > 60 ? "red" : v > 30 ? "volcano" : v > 0 ? "gold" : "default";
  return <Tag color={c}>{v}</Tag>;
}

export default function ReceivablesPage() {
  const { t } = useTranslation();
  const f = useFmt();
  const [ledger, setLedger] = useState<Ledger[]>([]);
  const [rpQuery, setRpQuery] = useState("");
  useEffect(() => { api.get<Ledger[]>("/api/receivables/related-party").then(setLedger); }, []);
  const ledgerFiltered = rpQuery.trim()
    ? ledger.filter((r) => (r.entity_name ?? "").toLowerCase().includes(rpQuery.trim().toLowerCase()))
    : ledger;

  const cols: ProColumns<OpenItem>[] = [
    { title: t("recv.invoiceNo"), dataIndex: "invoice_no", width: 150, search: false },
    { title: t("recv.entity"), dataIndex: "entity_name", ellipsis: true, search: false,
      render: (_, r) => r.entity_id ? <Space><Link to={`/customers/${r.entity_id}`}>{r.entity_name}</Link><ModelTag value={r.business_model} /></Space> : "—" },
    { title: t("recv.invoiceDate"), dataIndex: "invoice_date", width: 110, sorter: true, search: false, render: (_, r) => f.date(r.invoice_date) },
    { title: t("recv.dueDate"), dataIndex: "due_date", width: 110, sorter: true, search: false, render: (_, r) => f.date(r.due_date) },
    { title: t("recv.freight"), dataIndex: "freight_balance", width: 120, align: "right", search: false, render: (_, r) => f.money2(r.freight_balance) },
    { title: <InfoLabel title={t("recv.duty")} help={t("recv.dutyHelp")} />, dataIndex: "duty_balance", width: 120, align: "right", search: false, render: (_, r) => Number(r.duty_balance) ? f.money2(r.duty_balance) : "—" },
    { title: t("recv.total"), dataIndex: "total_balance", width: 130, align: "right", sorter: true, search: false, render: (_, r) => <b>{f.money2(r.total_balance)}</b> },
    { title: <InfoLabel title={t("recv.pastDueNominal")} help={t("recv.pastDueNominalHelp")} />, dataIndex: "days_past_due_nominal", width: 120, align: "right", sorter: true, search: false, render: (_, r) => <DaysTag v={r.days_past_due_nominal} /> },
    { title: <InfoLabel title={t("recv.pastBaseline")} help={t("recv.pastBaselineHelp")} />, dataIndex: "days_past_baseline", width: 120, align: "right", sorter: true, search: false, render: (_, r) => <DaysTag v={r.days_past_baseline} /> },
    { title: t("common.search"), dataIndex: "search", valueType: "text", hideInTable: true,
      fieldProps: { placeholder: t("recv.searchPlaceholder"), allowClear: true } },
    { title: t("recv.overdueOnly"), dataIndex: "overdueOnly", valueType: "switch", hideInTable: true },
  ];

  const ledgerCols: ProColumns<Ledger>[] = [
    { title: t("recv.period"), dataIndex: "period", width: 100, render: (_, r) => f.period(r.period.slice(0, 7)) },
    { title: t("recv.entity"), dataIndex: "entity_name" },
    { title: <InfoLabel title={t("recv.billedToThem")} help={t("recv.billedToThemHelp")} />, dataIndex: "billed_to_them", align: "right", render: (_, r) => f.money(r.billed_to_them) },
    { title: <InfoLabel title={t("recv.billedByThem")} help={t("recv.billedByThemHelp")} />, dataIndex: "billed_by_them", align: "right", render: (_, r) => f.money(r.billed_by_them) },
    { title: <InfoLabel title={t("recv.net")} help={t("recv.netHelp")} />, dataIndex: "net_position", align: "right", render: (_, r) => <Typography.Text type={Number(r.net_position) < 0 ? "danger" : undefined}>{f.money(r.net_position)}</Typography.Text> },
    { title: t("recv.shipments"), dataIndex: "shipments", align: "right" },
  ];

  return (
    <Tabs items={[
      { key: "open", label: t("recv.title"), children:
        <ProTable<OpenItem> rowKey="invoice_id" columns={cols} search={{ labelWidth: "auto" }}
          request={async (params, sort) => {
            const [sortKey] = Object.keys(sort);
            const r = await api.get<Paged<OpenItem>>("/api/receivables/open", {
              page: params.current, pageSize: params.pageSize, search: params.search, overdueOnly: params.overdueOnly,
              sort: sortKey, order: sortKey ? (sort[sortKey] === "ascend" ? "asc" : "desc") : undefined });
            return { data: r.data, total: r.total, success: true };
          }}
          pagination={{ pageSize: 50, showSizeChanger: true }} options={{ density: false }} scroll={{ x: 1200 }} /> },
      { key: "related", label: t("recv.relatedLedger"), children:
        <Space direction="vertical" size={12} style={{ width: "100%" }}>
          <Typography.Text type="secondary">{t("recv.relatedHint")}</Typography.Text>
          <Input.Search allowClear placeholder={t("recv.searchEntity")} style={{ maxWidth: 320 }}
            onChange={(e) => setRpQuery(e.target.value)} />
          <ProTable<Ledger> rowKey={(r) => `${r.entity_id}-${r.period}`} columns={ledgerCols} dataSource={ledgerFiltered} search={false} options={false} pagination={{ pageSize: 24 }} />
        </Space> },
    ]} />
  );
}
