import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Card, Col, Row, Segmented, Space, Statistic, Typography, Input, Drawer, Table, Tag } from "antd";
import type { ColumnsType } from "antd/es/table";
import { ProTable } from "@ant-design/pro-components";
import type { ProColumns } from "@ant-design/pro-components";
import ReactECharts from "echarts-for-react";
import { useTranslation } from "react-i18next";
import { api } from "../lib/api";
import { useFmt } from "../lib/format";
import InfoLabel from "../components/InfoLabel";

const C = { blue: "#2a78d6", orange: "#eb6834", aqua: "#1baf7a", red: "#e34948", green: "#008300" };
const GRID = { left: 72, right: 24, top: 36, bottom: 28 };

interface Summary { files: number; revenue: string; cost: string; gross_profit: string; avg_gp: string; margin_pct: string | null; loss_files: number }
interface Trend { period: string; files: number; gross_profit: string; revenue: string; margin_pct: string | null }
interface Cust { entity_id: number | null; customer_name: string; files: number; revenue: string; gross_profit: string; margin_pct: string | null }
interface Oper { operator: string; files: number; gross_profit: string; margin_pct: string | null }
interface FileRow { shipment_id: number; hbl_no: string | null; customer_name: string | null; operator: string | null; sman_id: string | null; eta: string | null; period_date: string; revenue: string; cost: string; gross_profit: string; margin_pct: string | null }
interface Line { direction: string; description: string | null; billing_code: string | null; rate: string | null; qty: string | null; amount: string; counterparty: string | null }
interface Paged<T> { data: T[]; total: number }

export default function ProfitabilityPage() {
  const { t } = useTranslation();
  const f = useFmt();
  const [months, setMonths] = useState(24);
  const [sum, setSum] = useState<Summary | null>(null);
  const [trend, setTrend] = useState<Trend[]>([]);
  const [cust, setCust] = useState<Cust[]>([]);
  const [oper, setOper] = useState<Oper[]>([]);
  const [kw, setKw] = useState("");
  const [drill, setDrill] = useState<FileRow | null>(null);
  const [lines, setLines] = useState<Line[]>([]);

  useEffect(() => { api.get<Trend[]>("/api/profit/trend", { months }).then(setTrend); }, [months]);
  useEffect(() => {
    api.get<Summary>("/api/profit/summary").then(setSum);
    api.get<Cust[]>("/api/profit/by-customer", { limit: 12 }).then(setCust);
    api.get<Oper[]>("/api/profit/by-operator", { limit: 12 }).then(setOper);
  }, []);
  useEffect(() => {
    if (!drill) { setLines([]); return; }
    api.get<Line[]>(`/api/profit/file/${drill.shipment_id}/lines`).then(setLines);
  }, [drill]);

  const axisMoney = { axisLabel: { formatter: (v: number) => f.moneyShort(v) }, splitLine: { lineStyle: { type: "dashed" as const } } };

  // 月度毛利趋势：柱=毛利，线=毛利率(右轴)
  const trendOpt = useMemo(() => ({
    grid: { ...GRID, right: 56 }, legend: { top: 0 },
    tooltip: { trigger: "axis" as const },
    xAxis: { type: "category" as const, data: trend.map((r) => r.period), axisLabel: { formatter: (v: string) => f.period(v) } },
    yAxis: [
      { type: "value", ...axisMoney },
      { type: "value", axisLabel: { formatter: "{value}%" }, splitLine: { show: false }, max: 60, min: 0 },
    ],
    series: [
      { name: t("prof.grossProfit"), type: "bar", barMaxWidth: 24, yAxisIndex: 0, itemStyle: { color: C.blue, borderRadius: [3, 3, 0, 0] }, data: trend.map((r) => Number(r.gross_profit)) },
      { name: t("prof.margin"), type: "line", smooth: true, symbol: "circle", symbolSize: 5, yAxisIndex: 1, itemStyle: { color: C.orange }, data: trend.map((r) => r.margin_pct === null ? null : Number(r.margin_pct)) },
    ],
  }), [trend, t, f]);

  const barMoney = (rows: { name: string; gp: number }[], color: string) => ({
    grid: { left: 180, right: 70, top: 12, bottom: 24 },
    tooltip: { trigger: "axis" as const, axisPointer: { type: "shadow" as const }, valueFormatter: (v: number) => f.money(v) },
    xAxis: { type: "value" as const, ...axisMoney },
    yAxis: { type: "category" as const, data: rows.map((r) => r.name.length > 24 ? r.name.slice(0, 23) + "…" : r.name), axisLabel: { fontSize: 11 } },
    series: [{ type: "bar", barMaxWidth: 18, itemStyle: { color, borderRadius: [0, 3, 3, 0] },
      data: rows.map((r) => r.gp),
      label: { show: true, position: "right" as const, formatter: (p: { value: number }) => f.moneyShort(p.value), fontSize: 11 } }],
  });
  const custOpt = useMemo(() => barMoney([...cust].reverse().map((r) => ({ name: r.customer_name, gp: Number(r.gross_profit) })), C.blue), [cust, f]);
  const operOpt = useMemo(() => barMoney([...oper].reverse().map((r) => ({ name: r.operator, gp: Number(r.gross_profit) })), C.aqua), [oper, f]);

  const gpCell = (v: string | number) => { const n = Number(v); return <b style={{ color: n < 0 ? C.red : C.green }}>{f.money2(n)}</b>; };
  const marginCell = (v: string | null) => v == null ? "—" : <span style={{ color: Number(v) < 0 ? C.red : undefined }}>{v}%</span>;

  const cols: ProColumns<FileRow>[] = [
    { title: t("prof.hbl"), dataIndex: "hbl_no", width: 150, render: (v) => v || "—" },
    { title: t("prof.customer"), dataIndex: "customer_name", ellipsis: true, render: (v) => v || "—" },
    { title: t("prof.operator"), dataIndex: "operator", width: 110, render: (v) => v || "—" },
    { title: t("prof.eta"), dataIndex: "period_date", width: 110, sorter: true, render: (_, r) => f.date(r.period_date) },
    { title: t("prof.revenue"), dataIndex: "revenue", align: "right", width: 120, sorter: true, render: (_, r) => f.money2(r.revenue) },
    { title: t("prof.cost"), dataIndex: "cost", align: "right", width: 120, sorter: true, render: (_, r) => f.money2(r.cost) },
    { title: t("prof.grossProfit"), dataIndex: "gross_profit", align: "right", width: 130, sorter: true, defaultSortOrder: "descend", render: (_, r) => gpCell(r.gross_profit) },
    { title: t("prof.margin"), dataIndex: "margin_pct", align: "right", width: 90, sorter: true, render: (_, r) => marginCell(r.margin_pct) },
    { title: "", width: 90, render: (_, r) => <a onClick={() => setDrill(r)}>{t("prof.viewLines")}</a> },
  ];

  const lineCols: ColumnsType<Line> = [
    { title: t("prof.dir"), dataIndex: "direction", width: 90, render: (v) => v === "ar" ? <Tag color="green">{t("prof.revenue")}</Tag> : <Tag color="volcano">{t("prof.cost")}</Tag> },
    { title: t("prof.service"), dataIndex: "description", ellipsis: true, render: (v) => v || "—" },
    { title: t("prof.counterparty"), dataIndex: "counterparty", ellipsis: true, render: (v) => v || "—" },
    { title: t("cost.rate"), dataIndex: "rate", align: "right", width: 90, render: (v) => v != null ? f.money2(v) : "—" },
    { title: t("cost.qty"), dataIndex: "qty", align: "right", width: 60, render: (v) => v != null ? Number(v) : "—" },
    { title: t("prof.amount"), dataIndex: "amount", align: "right", width: 110, render: (v) => f.money2(v) },
  ];

  const kpi = (label: ReactNode, value: ReactNode, color?: string) =>
    <Col xs={12} md={8} lg={6} xl={4}><Card size="small"><Statistic title={label} valueStyle={color ? { color } : undefined} value={value as string} /></Card></Col>;

  return (
    <Space direction="vertical" size={16} style={{ width: "100%" }}>
      <Typography.Text type="secondary">{t("prof.hint")}</Typography.Text>

      <Row gutter={[16, 16]}>
        {kpi(<InfoLabel title={t("prof.kpiGp")} help={t("prof.kpiGpHelp")} />, sum ? f.money(sum.gross_profit) : "—", C.green)}
        {kpi(t("prof.kpiMargin"), sum?.margin_pct != null ? `${sum.margin_pct}%` : "—")}
        {kpi(t("prof.kpiFiles"), sum ? f.num(sum.files) : "—")}
        {kpi(t("prof.kpiAvg"), sum ? f.money(sum.avg_gp) : "—")}
        {kpi(t("prof.kpiRevenue"), sum ? f.money(sum.revenue) : "—")}
        {kpi(<InfoLabel title={t("prof.kpiLoss")} help={t("prof.kpiLossHelp")} />, sum ? f.num(sum.loss_files) : "—", C.red)}
      </Row>

      <Card size="small" title={<Space><InfoLabel title={t("prof.trendTitle")} help={t("prof.trendHelp")} /><Segmented size="small" value={months} onChange={(v) => setMonths(Number(v))} options={[{ label: "12M", value: 12 }, { label: "24M", value: 24 }, { label: "36M", value: 36 }]} /></Space>}>
        <ReactECharts option={trendOpt} style={{ height: 300 }} notMerge />
      </Card>

      <Row gutter={[16, 16]}>
        <Col xs={24} lg={12}><Card size="small" title={<InfoLabel title={t("prof.topCust")} help={t("prof.topCustHelp")} />}><ReactECharts option={custOpt} style={{ height: 320 }} notMerge /></Card></Col>
        <Col xs={24} lg={12}><Card size="small" title={<InfoLabel title={t("prof.topOper")} help={t("prof.topOperHelp")} />}><ReactECharts option={operOpt} style={{ height: 320 }} notMerge /></Card></Col>
      </Row>

      <Card size="small" title={t("prof.filesTitle")} extra={<Input.Search allowClear placeholder={t("prof.search")} style={{ width: 260 }} onSearch={setKw} />}>
        <ProTable<FileRow>
          rowKey="shipment_id" columns={cols} search={false} options={false}
          params={{ kw }}
          request={async (params, sort) => {
            const [sortKey] = Object.keys(sort ?? {});
            const map: Record<string, string> = { period_date: "period_date", revenue: "revenue", cost: "cost", gross_profit: "gross_profit", margin_pct: "margin_pct" };
            const r = await api.get<Paged<FileRow>>("/api/profit/files", {
              page: params.current, pageSize: params.pageSize, q: kw || undefined,
              sort: sortKey ? map[sortKey] : "gross_profit", order: sortKey ? (sort[sortKey] === "ascend" ? "asc" : "desc") : "desc",
            });
            return { data: r.data, total: r.total, success: true };
          }}
          pagination={{ pageSize: 25 }} scroll={{ x: 1000 }} />
      </Card>

      <Drawer open={!!drill} onClose={() => setDrill(null)} width={840}
        title={drill ? `${drill.hbl_no ?? "#" + drill.shipment_id} · ${drill.customer_name ?? ""}` : ""}>
        {drill && (
          <Space direction="vertical" size={12} style={{ width: "100%" }}>
            <Space size={24}>
              <Statistic title={t("prof.revenue")} value={f.money2(drill.revenue)} valueStyle={{ fontSize: 16 }} />
              <Statistic title={t("prof.cost")} value={f.money2(drill.cost)} valueStyle={{ fontSize: 16 }} />
              <Statistic title={t("prof.grossProfit")} value={f.money2(drill.gross_profit)} valueStyle={{ fontSize: 16, color: Number(drill.gross_profit) < 0 ? C.red : C.green }} />
              <Statistic title={t("prof.margin")} value={drill.margin_pct != null ? `${drill.margin_pct}%` : "—"} valueStyle={{ fontSize: 16 }} />
            </Space>
            <Table<Line> rowKey={(r, i) => `${r.direction}-${i}`} size="small" columns={lineCols} dataSource={lines} pagination={false} scroll={{ x: "max-content" }} />
          </Space>
        )}
      </Drawer>
    </Space>
  );
}
