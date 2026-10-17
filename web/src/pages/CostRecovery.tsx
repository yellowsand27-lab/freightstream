import { useEffect, useState } from "react";
import { Drawer, Space, Table, Tabs, Tag, Typography, Segmented } from "antd";
import { ProTable, type ProColumns } from "@ant-design/pro-components";
import type { ColumnsType } from "antd/es/table";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { api, type Paged } from "../lib/api";
import { useFmt } from "../lib/format";
import ModelTag from "../components/ModelTag";
import InfoLabel from "../components/InfoLabel";

interface Summary { entity_id: number; entity_name: string; business_model: string; files: number; cost_total: string; gap_total: string; latest_file: string }
interface Line { shipment_id: number; hbl_no: string; operator: string; entity_id: number | null; entity_name: string | null; class: string; ap_amount: string; ar_amount: string; gap: string; recovery_state: string; created_at: string }
interface Dem { entity_id: number | null; entity_name: string; business_model: string | null; class: string; files: number; paid_out: string; recovered: string; net_cost: string; recovery_pct: string | null }
interface Trend { year: number; class: string; files: number; paid_out: string; recovered: string; net_cost: string; recovery_pct: string | null }
interface DemFile { shipment_id: number; hbl_no: string; operator: string; entity_id: number | null; entity_name: string | null; class: string; paid_out: string; recovered: string; net_cost: string; first_charge_date: string }
interface DupVoucher { voucher_id: number; invoice_amt: string; paid_amt: string; paid_date: string | null; invoice_date: string | null; void_flag: number; created_at: string; created_by: string; hbl_no: string | null; rate: string | null; qty: string | null; description: string | null }
interface Dup { pay_to_id: number; vendor_name: string | null; invoice_no: string; shipment_id: number | null; hbl_no: string | null; entry_count: number; paid_count: number; dup_line_count: number; entered_surplus: string; extra_amount: string; max_gap_hours: string; first_entered: string; last_entered: string }

const STATE_COLOR: Record<string, string> = { not_rebilled: "red", under_rebilled: "volcano", no_ar_invoice: "default", recovered: "green", recovered_via_agent: "blue", agent_partial: "gold" };

export default function CostRecoveryPage() {
  const { t } = useTranslation();
  const f = useFmt();
  const [months, setMonths] = useState(12);
  const [summary, setSummary] = useState<Summary[]>([]);
  const [dem, setDem] = useState<Dem[]>([]);
  const [dups, setDups] = useState<Dup[]>([]);
  // 滞期回收趋势 + 钻取
  const [trend, setTrend] = useState<Trend[]>([]);
  const [trendBm, setTrendBm] = useState<string>("");   // "" = 全部, "direct" = 仅直客
  const [drill, setDrill] = useState<{ year: number; cls: string } | null>(null);
  const [drillRows, setDrillRows] = useState<DemFile[]>([]);
  const [drillGapOnly, setDrillGapOnly] = useState(true);
  const [dupDrill, setDupDrill] = useState<Dup | null>(null);
  const [dupVouchers, setDupVouchers] = useState<DupVoucher[]>([]);
  useEffect(() => {
    api.get<Summary[]>("/api/costs/unrecovered/summary", { months }).then(setSummary);
    api.get<Dem[]>("/api/costs/demurrage", { months }).then(setDem);
  }, [months]);
  useEffect(() => { api.get<Dup[]>("/api/costs/duplicates").then(setDups); }, []);
  useEffect(() => {
    if (!dupDrill) { setDupVouchers([]); return; }
    api.get<DupVoucher[]>("/api/costs/duplicates/vouchers", { payToId: dupDrill.pay_to_id, invoiceNo: dupDrill.invoice_no, shipmentId: dupDrill.shipment_id ?? undefined }).then(setDupVouchers);
  }, [dupDrill]);
  useEffect(() => { api.get<Trend[]>("/api/costs/demurrage/trend", { fromYear: 2023, businessModel: trendBm || undefined }).then(setTrend); }, [trendBm]);
  useEffect(() => {
    if (!drill) return;
    api.get<{ data: DemFile[] }>("/api/costs/demurrage/files", {
      year: drill.year, class: drill.cls, businessModel: trendBm || undefined,
      recoveredState: drillGapOnly ? "gap" : undefined, pageSize: 200,
    }).then((r) => setDrillRows(r.data));
  }, [drill, drillGapOnly, trendBm]);

  const monthsCtl = <Segmented size="small" value={months} onChange={(v) => setMonths(Number(v))}
    options={[6, 12, 24].map((n) => ({ label: t("common.months", { n }), value: n }))} />;

  const numSort = <T,>(k: keyof T) => (a: T, b: T) => Number(a[k] ?? 0) - Number(b[k] ?? 0);
  const dateSort = <T,>(k: keyof T) => (a: T, b: T) =>
    new Date(String(a[k] ?? 0)).getTime() - new Date(String(b[k] ?? 0)).getTime();
  const strSort = <T,>(k: keyof T) => (a: T, b: T) => String(a[k] ?? "").localeCompare(String(b[k] ?? ""));

  const sumCols: ProColumns<Summary>[] = [
    { title: t("cust.name"), dataIndex: "entity_name", sorter: strSort<Summary>("entity_name"), render: (_, r) => <Space><Link to={`/customers/${r.entity_id}`}>{r.entity_name}</Link><ModelTag value={r.business_model} /></Space> },
    { title: t("cost.files"), dataIndex: "files", align: "right", width: 80, sorter: numSort<Summary>("files") },
    { title: t("cost.costTotal"), dataIndex: "cost_total", align: "right", width: 130, sorter: numSort<Summary>("cost_total"), render: (_, r) => f.money(r.cost_total) },
    { title: <InfoLabel title={t("cost.gap")} help={t("cost.gapHelp")} />, dataIndex: "gap_total", align: "right", width: 130, sorter: numSort<Summary>("gap_total"), defaultSortOrder: "descend", render: (_, r) => <b style={{ color: "#d03b3b" }}>{f.money(r.gap_total)}</b> },
    { title: t("cost.latest"), dataIndex: "latest_file", width: 110, sorter: dateSort<Summary>("latest_file"), render: (_, r) => f.date(r.latest_file) },
  ];

  const lineCols: ProColumns<Line>[] = [
    { title: t("cost.hbl"), dataIndex: "hbl_no", width: 140, search: false },
    { title: t("cust.name"), dataIndex: "entity_name", ellipsis: true, search: false, render: (_, r) => r.entity_id ? <Link to={`/customers/${r.entity_id}`}>{r.entity_name}</Link> : "—" },
    { title: t("cost.operator"), dataIndex: "operator", width: 100, search: false },
    { title: t("cost.class"), dataIndex: "class", width: 110, search: false, render: (v) => <Tag>{String(v)}</Tag> },
    { title: <InfoLabel title={t("cost.state")} help={t("cost.stateHelp")} />, dataIndex: "state", width: 130, valueType: "select",
      valueEnum: { not_rebilled: t("cost.stateValue.not_rebilled"), under_rebilled: t("cost.stateValue.under_rebilled"), recovered_via_agent: t("cost.stateValue.recovered_via_agent"), agent_partial: t("cost.stateValue.agent_partial"), no_ar_invoice: t("cost.stateValue.no_ar_invoice"), recovered: t("cost.stateValue.recovered") },
      render: (_, r) => <Tag color={STATE_COLOR[r.recovery_state]}>{t(`cost.stateValue.${r.recovery_state}`)}</Tag> },
    { title: t("cost.paidOut"), dataIndex: "ap_amount", align: "right", width: 110, sorter: true, search: false, render: (_, r) => f.money2(r.ap_amount) },
    { title: t("cost.recovered"), dataIndex: "ar_amount", align: "right", width: 110, search: false, render: (_, r) => f.money2(r.ar_amount) },
    { title: <InfoLabel title={t("cost.gap")} help={t("cost.gapHelp")} />, dataIndex: "gap", align: "right", width: 110, sorter: true, search: false, render: (_, r) => <b>{f.money2(r.gap)}</b> },
    { title: t("bill.fileOpened"), dataIndex: "created_at", width: 110, sorter: true, search: false, render: (_, r) => f.date(r.created_at) },
  ];

  const demCols: ProColumns<Dem>[] = [
    { title: t("cust.name"), dataIndex: "entity_name", sorter: strSort<Dem>("entity_name"), render: (_, r) => <Space>{r.entity_id ? <Link to={`/customers/${r.entity_id}`}>{r.entity_name}</Link> : r.entity_name}<ModelTag value={r.business_model} /></Space> },
    { title: t("cost.class"), dataIndex: "class", width: 110, sorter: strSort<Dem>("class"), render: (v) => <Tag>{String(v)}</Tag> },
    { title: t("cost.files"), dataIndex: "files", align: "right", width: 70, sorter: numSort<Dem>("files") },
    { title: t("cost.paidOut"), dataIndex: "paid_out", align: "right", width: 120, sorter: numSort<Dem>("paid_out"), render: (_, r) => f.money(r.paid_out) },
    { title: t("cost.recovered"), dataIndex: "recovered", align: "right", width: 120, sorter: numSort<Dem>("recovered"), render: (_, r) => f.money(r.recovered) },
    { title: <InfoLabel title={t("cost.netCost")} help={t("cost.netCostHelp")} />, dataIndex: "net_cost", align: "right", width: 120, sorter: numSort<Dem>("net_cost"), defaultSortOrder: "descend", render: (_, r) => <b style={{ color: Number(r.net_cost) > 0 ? "#d03b3b" : "#0ca30c" }}>{f.money(r.net_cost)}</b> },
    { title: <InfoLabel title={t("cost.recoveryPct")} help={t("cost.recoveryPctHelp")} />, dataIndex: "recovery_pct", align: "right", width: 90, sorter: (a: Dem, b: Dem) => Number(a.recovery_pct ?? -1) - Number(b.recovery_pct ?? -1), render: (_, r) => r.recovery_pct === null ? "—" : f.pct(r.recovery_pct, false) },
  ];

  const CLS_LABEL: Record<string,string> = { demurrage: "Demurrage", detention: "Detention", storage: "Storage" };
  const trendCols: ProColumns<Trend>[] = [
    { title: t("cost.year"), dataIndex: "year", width: 80 },
    { title: t("cost.class"), dataIndex: "class", width: 120, render: (v) => <Tag>{CLS_LABEL[String(v)] ?? String(v)}</Tag> },
    { title: t("cost.files"), dataIndex: "files", align: "right", width: 80 },
    { title: t("cost.paidOut"), dataIndex: "paid_out", align: "right", width: 130, render: (_, r) => f.money(r.paid_out) },
    { title: t("cost.recovered"), dataIndex: "recovered", align: "right", width: 130, render: (_, r) => f.money(r.recovered) },
    { title: <InfoLabel title={t("cost.netCost")} help={t("cost.netCostHelp")} />, dataIndex: "net_cost", align: "right", width: 130,
      render: (_, r) => <b style={{ color: Number(r.net_cost) > 0 ? "#d03b3b" : "#0ca30c" }}>{f.money(r.net_cost)}</b> },
    { title: <InfoLabel title={t("cost.recoveryPct")} help={t("cost.recoveryPctHelp2")} />, dataIndex: "recovery_pct", align: "right", width: 110,
      render: (_, r) => {
        if (r.recovery_pct === null) return "—";
        const v = Number(r.recovery_pct);
        return <Tag color={v >= 80 ? "green" : v >= 40 ? "gold" : "red"}>{f.pct(v, false)}</Tag>;
      } },
    { title: "", dataIndex: "_drill", width: 90, render: (_, r) => <a onClick={() => setDrill({ year: r.year, cls: r.class })}>{t("cost.viewFiles")}</a> },
  ];

  const drillCols: ColumnsType<DemFile> = [
    { title: t("cost.hbl"), dataIndex: "hbl_no", width: 140 },
    { title: t("cust.name"), dataIndex: "entity_name", ellipsis: true, render: (_, r) => r.entity_id ? <Link to={`/customers/${r.entity_id}`}>{r.entity_name}</Link> : "—" },
    { title: t("cost.operator"), dataIndex: "operator", width: 96 },
    { title: t("cost.paidOut"), dataIndex: "paid_out", align: "right", width: 110, render: (_, r) => f.money2(r.paid_out) },
    { title: t("cost.recovered"), dataIndex: "recovered", align: "right", width: 110, render: (_, r) => f.money2(r.recovered) },
    { title: t("cost.netCost"), dataIndex: "net_cost", align: "right", width: 110, render: (_, r) => <b style={{ color: Number(r.net_cost) > 0 ? "#d03b3b" : undefined }}>{f.money2(r.net_cost)}</b> },
  ];

  const dupCols: ProColumns<Dup>[] = [
    { title: t("cost.vendor"), dataIndex: "vendor_name", ellipsis: true, sorter: strSort("vendor_name"), render: (v, r) => v ?? `#${r.pay_to_id}` },
    { title: t("cost.invoiceNo"), dataIndex: "invoice_no", width: 160, sorter: strSort("invoice_no") },
    { title: t("cost.hbl"), dataIndex: "hbl_no", width: 150, sorter: strSort("hbl_no"), render: (v) => v || "—" },
    { title: t("cost.entries"), dataIndex: "entry_count", align: "right", width: 80, sorter: numSort("entry_count") },
    { title: t("cost.paidCount"), dataIndex: "paid_count", align: "right", width: 90, sorter: numSort("paid_count"),
      render: (v) => <span style={{ color: Number(v) > 1 ? "#d03b3b" : undefined }}>{v}</span> },
    { title: t("cost.enteredSurplus"), dataIndex: "entered_surplus", align: "right", width: 130, sorter: numSort("entered_surplus"), defaultSortOrder: "descend", render: (_, r) => f.money2(r.entered_surplus) },
    { title: t("cost.extra"), dataIndex: "extra_amount", align: "right", width: 120, sorter: numSort("extra_amount"),
      render: (_, r) => <b style={{ color: "#d03b3b" }}>{f.money2(r.extra_amount)}</b> },
    { title: t("cost.enterGap"), dataIndex: "max_gap_hours", align: "right", width: 110, sorter: numSort("max_gap_hours"),
      render: (_, r) => { const h = Number(r.max_gap_hours); const txt = h < 1 ? "<1h" : h < 48 ? `${h.toFixed(1)}h` : `${Math.round(h / 24)}d`;
        return <span style={{ color: h >= 1 ? "#d03b3b" : "#999" }}>{txt}</span>; } },
    { title: t("cost.firstEntered"), dataIndex: "first_entered", width: 130, sorter: dateSort("first_entered"), render: (_, r) => f.date(r.first_entered) },
    { title: t("cost.lastEntered"), dataIndex: "last_entered", width: 130, sorter: dateSort("last_entered"), render: (_, r) => f.date(r.last_entered) },
    { title: "", dataIndex: "_d", width: 96, render: (_, r) => <a onClick={() => setDupDrill(r)}>{t("cost.viewVouchers")}</a> },
  ];

  const dupVoucherCols: ColumnsType<DupVoucher> = [
    { title: t("cost.voucherId"), dataIndex: "voucher_id", width: 90 },
    { title: t("cost.created"), dataIndex: "created_at", width: 140, render: (v) => f.datetime(v) },
    { title: t("cost.createdBy"), dataIndex: "created_by", width: 100 },
    { title: t("cost.hbl"), dataIndex: "hbl_no", width: 130, render: (v) => v || "—" },
    { title: t("recv.invoiceDate"), dataIndex: "invoice_date", width: 110, render: (v) => f.date(v) },
    { title: t("cost.service"), dataIndex: "description", width: 200, ellipsis: true, render: (v) => v || "—" },
    { title: t("cost.rate"), dataIndex: "rate", align: "right", width: 100, render: (v) => v != null ? f.money2(v) : "—" },
    { title: t("cost.qty"), dataIndex: "qty", align: "right", width: 70, render: (v) => v != null ? Number(v) : "—" },
    { title: t("cost.each"), dataIndex: "invoice_amt", align: "right", width: 110, render: (v) => f.money2(v) },
    { title: t("cost.paid"), dataIndex: "paid_amt", align: "center", width: 90,
      render: (_, r) => Number(r.paid_amt) > 0 ? <Tag color="red">{t("cost.yes")}</Tag> : <Tag>{t("cost.no")}</Tag> },
    { title: t("cost.voided"), dataIndex: "void_flag", width: 90, align: "center",
      render: (v) => Number(v) ? <Tag color="green">{t("cost.yes")}</Tag> : <Tag>{t("cost.no")}</Tag> },
  ];

  return (
    <>
    <Tabs tabBarExtraContent={monthsCtl} items={[
      { key: "unrecovered", label: t("cost.unrecovered"), children:
        <Space direction="vertical" size={16} style={{ width: "100%" }}>
          <Typography.Text type="secondary">{t("cost.unrecoveredHint")}</Typography.Text>
          <ProTable<Summary> rowKey="entity_id" columns={sumCols} dataSource={summary} search={false} options={false} pagination={false} headerTitle={t("kpi.customers", { n: summary.length })} />
          <ProTable<Line> rowKey={(r) => `${r.shipment_id}-${r.class}`} columns={lineCols} search={{ labelWidth: "auto" }}
            request={async (params, sort) => {
              const [sortKey] = Object.keys(sort);
              const r = await api.get<Paged<Line>>("/api/costs/unrecovered", { page: params.current, pageSize: params.pageSize, state: params.state, months,
                sort: sortKey, order: sortKey ? (sort[sortKey] === "ascend" ? "asc" : "desc") : undefined });
              return { data: r.data, total: r.total, success: true };
            }}
            params={{ months }} pagination={{ pageSize: 25 }} options={{ density: false }} scroll={{ x: 1100 }} />
        </Space> },
      { key: "trend", label: t("cost.trend"), children:
        <Space direction="vertical" size={12} style={{ width: "100%" }}>
          <Space>
            <Typography.Text type="secondary">{t("cost.businessModel")}:</Typography.Text>
            <Segmented size="small" value={trendBm} onChange={(v) => setTrendBm(String(v))}
              options={[{ label: t("cost.allModels"), value: "" }, { label: t("cost.directOnly"), value: "direct" }]} />
          </Space>
          <Typography.Text type="secondary">{t("cost.trendHint")}</Typography.Text>
          <ProTable<Trend> rowKey={(r) => `${r.year}-${r.class}`} columns={trendCols} dataSource={trend}
            search={false} options={false} pagination={false}
            onRow={(r) => ({ onClick: () => setDrill({ year: r.year, cls: r.class }), style: { cursor: "pointer" } })} />
        </Space> },
      { key: "demurrage", label: t("cost.demurrage"), children:
        <ProTable<Dem> rowKey={(r) => `${r.entity_id}-${r.class}`} columns={demCols} dataSource={dem} search={false} options={false} pagination={{ pageSize: 25 }} /> },
      { key: "duplicates", label: t("cost.duplicates"), children:
        <Space direction="vertical" size={12} style={{ width: "100%" }}>
          <Typography.Text type="secondary">{t("cost.duplicatesHint")}</Typography.Text>
          <ProTable<Dup> rowKey={(r) => `${r.pay_to_id}-${r.invoice_no}`} columns={dupCols} dataSource={dups} search={false} options={false} pagination={{ pageSize: 25 }}
            summary={() => {
              // 汇总整个数据集（不是当前页）
              const entries = dups.reduce((a, r) => a + Number(r.entry_count || 0), 0);
              const paid = dups.reduce((a, r) => a + Number(r.paid_count || 0), 0);
              const surplus = dups.reduce((a, r) => a + Number(r.entered_surplus || 0), 0);
              const extra = dups.reduce((a, r) => a + Number(r.extra_amount || 0), 0);
              return (
                <Table.Summary fixed>
                  <Table.Summary.Row style={{ background: "#fafafa", fontWeight: 600 }}>
                    <Table.Summary.Cell index={0}>{t("cost.total")}</Table.Summary.Cell>
                    <Table.Summary.Cell index={1} />
                    <Table.Summary.Cell index={2}>{t("cost.groups", { n: dups.length })}</Table.Summary.Cell>
                    <Table.Summary.Cell index={3} align="right">{f.num(entries)}</Table.Summary.Cell>
                    <Table.Summary.Cell index={4} align="right">{f.num(paid)}</Table.Summary.Cell>
                    <Table.Summary.Cell index={5} align="right">{f.money(surplus)}</Table.Summary.Cell>
                    <Table.Summary.Cell index={6} align="right"><span style={{ color: "#d03b3b" }}>{f.money(extra)}</span></Table.Summary.Cell>
                    <Table.Summary.Cell index={7} /><Table.Summary.Cell index={8} /><Table.Summary.Cell index={9} /><Table.Summary.Cell index={10} />
                  </Table.Summary.Row>
                </Table.Summary>
              );
            }} />
        </Space> },
    ]} />
    <Drawer open={!!drill} onClose={() => setDrill(null)} width={880}
      title={drill ? t("cost.drillTitle", { year: drill.year, cls: (CLS_LABEL[drill.cls] ?? drill.cls) }) : ""}>
      <Space direction="vertical" size={12} style={{ width: "100%" }}>
        <Space>
          <Segmented size="small" value={drillGapOnly ? "gap" : "all"} onChange={(v) => setDrillGapOnly(v === "gap")}
            options={[{ label: t("cost.gapOnly"), value: "gap" }, { label: t("common.all"), value: "all" }]} />
          <Typography.Text type="secondary">{drillRows.length} {t("cost.files")}</Typography.Text>
        </Space>
        <Table<DemFile> rowKey="shipment_id" size="small" columns={drillCols} dataSource={drillRows}
          pagination={{ pageSize: 20 }} />
      </Space>
    </Drawer>
    <Drawer open={!!dupDrill} onClose={() => setDupDrill(null)} width={860}
      title={dupDrill ? t("cost.dupDrillTitle", { vendor: dupDrill.vendor_name ?? ("#"+dupDrill.pay_to_id), no: dupDrill.invoice_no }) + (dupDrill.hbl_no ? " · "+dupDrill.hbl_no : "") : ""}>
      <Space direction="vertical" size={12} style={{ width: "100%" }}>
        <Typography.Text type="secondary">{t("cost.dupDrillHint")}</Typography.Text>
        <Table<DupVoucher> rowKey="voucher_id" size="small" columns={dupVoucherCols} dataSource={dupVouchers} pagination={false} scroll={{ x: "max-content" }} />
      </Space>
    </Drawer>
    </>
  );
}
