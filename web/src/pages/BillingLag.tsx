import { useEffect, useState } from "react";
import { Space, Tag, Typography, InputNumber } from "antd";
import { ProTable, type ProColumns } from "@ant-design/pro-components";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { api, type Paged } from "../lib/api";
import { useFmt } from "../lib/format";
import InfoLabel from "../components/InfoLabel";

interface Op { operator: string; files: number; billed: number; median_lag: string | null; unbilled_over_threshold: number; oldest_unbilled: number | null }
interface FileRow { shipment_id: number; hbl_no: string; operator: string; entity_id: number | null; entity_name: string | null; file_opened: string; first_invoice_date: string | null; lag_days: number | null; unbilled_days: number | null }

export default function BillingLagPage() {
  const { t } = useTranslation();
  const f = useFmt();
  const [threshold, setThreshold] = useState(45);
  const [ops, setOps] = useState<Op[]>([]);
  const [operator, setOperator] = useState<string | undefined>();
  useEffect(() => { api.get<Op[]>("/api/billing/by-operator", { threshold }).then(setOps); }, [threshold]);

  const opCols: ProColumns<Op>[] = [
    { title: t("bill.operator"), dataIndex: "operator", render: (_, r) => <a onClick={() => setOperator(r.operator === operator ? undefined : r.operator)} style={{ fontWeight: r.operator === operator ? 600 : undefined }}>{r.operator}</a> },
    { title: t("bill.files"), dataIndex: "files", align: "right", width: 80 },
    { title: <InfoLabel title={t("bill.billed")} help={t("bill.billedHelp")} />, dataIndex: "billed", align: "right", width: 80 },
    { title: <InfoLabel title={t("bill.medianLag")} help={t("bill.medianLagHelp")} />, dataIndex: "median_lag", align: "right", width: 110, render: (_, r) => r.median_lag === null ? "—" : t("kpi.days", { n: Math.round(Number(r.median_lag)) }) },
    { title: <InfoLabel title={t("bill.unbilledOver", { n: threshold })} help={t("bill.unbilledOverHelp")} />, dataIndex: "unbilled_over_threshold", align: "right", width: 170, render: (v) => Number(v) ? <Tag color="red">{String(v)}</Tag> : "0" },
    { title: <InfoLabel title={t("bill.oldest")} help={t("bill.oldestHelp")} />, dataIndex: "oldest_unbilled", align: "right", width: 110, render: (v) => v === null ? "—" : t("kpi.days", { n: v }) },
  ];

  const fileCols: ProColumns<FileRow>[] = [
    { title: t("bill.hbl"), dataIndex: "hbl_no", width: 140, search: false },
    { title: t("bill.entity"), dataIndex: "entity_name", ellipsis: true, search: false, render: (_, r) => r.entity_id ? <Link to={`/customers/${r.entity_id}`}>{r.entity_name}</Link> : "—" },
    { title: t("bill.operator"), dataIndex: "operator", width: 100, search: false },
    { title: t("bill.fileOpened"), dataIndex: "file_opened", width: 110, sorter: true, search: false, render: (_, r) => f.date(r.file_opened) },
    { title: t("bill.firstInvoice"), dataIndex: "first_invoice_date", width: 110, search: false, render: (_, r) => f.date(r.first_invoice_date) },
    { title: <InfoLabel title={t("bill.lagDays")} help={t("bill.lagDaysHelp")} />, dataIndex: "lag_days", align: "right", width: 90, sorter: true, search: false, render: (v) => v === null ? "—" : String(v) },
    { title: <InfoLabel title={t("bill.unbilledDays")} help={t("bill.unbilledDaysHelp")} />, dataIndex: "unbilled_days", align: "right", width: 100, sorter: true, search: false,
      render: (v) => v === null ? "—" : <Tag color={Number(v) >= 90 ? "red" : Number(v) >= threshold ? "volcano" : "default"}>{String(v)}</Tag> },
    { title: t("bill.unbilledOnly"), dataIndex: "unbilledOnly", valueType: "switch", hideInTable: true, initialValue: true },
  ];

  return (
    <Space direction="vertical" size={16} style={{ width: "100%" }}>
      <Typography.Text type="secondary">{t("bill.hint")}</Typography.Text>
      <ProTable<Op> rowKey="operator" columns={opCols} dataSource={ops} search={false} options={false} pagination={false}
        headerTitle={t("bill.operator")}
        toolBarRender={() => [<Space key="t">{t("bill.threshold")}<InputNumber size="small" min={0} value={threshold} onChange={(v) => setThreshold(Number(v ?? 45))} /></Space>]} />
      <ProTable<FileRow> rowKey="shipment_id" columns={fileCols} search={{ labelWidth: "auto" }} params={{ operator }}
        headerTitle={operator ? `${t("bill.operator")}: ${operator}` : undefined}
        request={async (params, sort) => {
          const [sortKey] = Object.keys(sort);
          const r = await api.get<Paged<FileRow>>("/api/billing/files", { page: params.current, pageSize: params.pageSize, operator,
            unbilledOnly: params.unbilledOnly === undefined ? true : params.unbilledOnly,
            sort: sortKey, order: sortKey ? (sort[sortKey] === "ascend" ? "asc" : "desc") : undefined });
          return { data: r.data, total: r.total, success: true };
        }}
        pagination={{ pageSize: 25 }} options={{ density: false }} scroll={{ x: 1000 }} />
    </Space>
  );
}
