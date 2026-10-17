import { useEffect, useMemo, useState } from "react";
import { Card, Col, Row, Segmented, Space, Typography } from "antd";
import ReactECharts from "echarts-for-react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { api } from "../lib/api";
import { useFmt } from "../lib/format";
import InfoLabel from "../components/InfoLabel";
import AgingTrend from "../components/AgingTrend";
import StaffOutput from "../components/StaffOutput";

// 校验过的分类色板（light）
const C = { blue: "#2a78d6", orange: "#eb6834", aqua: "#1baf7a", yellow: "#eda100",
            magenta: "#e87ba4", violet: "#4a3aa7", red: "#e34948", green: "#008300" };
const GRID = { left: 72, right: 24, top: 36, bottom: 28 };

interface BizRow { period: string; invoices: number; billing: string; import_shipments: number }
interface DsoRow { period: string; median_days: string | null; p90_days: string | null; sample: number }
interface TopRow { entity_id: number; entity_name: string; total_open: string; overdue_by_baseline: string }
interface ClsRow { class: string; files: number; gap: string }
interface DemRow { year: number; class: string; paid_out: string; recovered: string; recovery_pct: string | null }

export default function AnalyticsPage() {
  const { t } = useTranslation();
  const f = useFmt();
  const [months, setMonths] = useState(24);
  const [biz, setBiz] = useState<BizRow[]>([]);
  const [dso, setDso] = useState<DsoRow[]>([]);
  const [top, setTop] = useState<TopRow[]>([]);
  const [cls, setCls] = useState<ClsRow[]>([]);
  const [dem, setDem] = useState<DemRow[]>([]);

  useEffect(() => {
    api.get<BizRow[]>("/api/analytics/business-trend", { months }).then(setBiz);
    api.get<DsoRow[]>("/api/analytics/dso-trend", { months }).then(setDso);
  }, [months]);
  useEffect(() => {
    api.get<TopRow[]>("/api/analytics/top-customers", { limit: 12 }).then(setTop);
    api.get<ClsRow[]>("/api/analytics/unrecovered-by-class").then(setCls);
    api.get<DemRow[]>("/api/costs/demurrage/trend", { fromYear: 2023, businessModel: "direct" }).then(setDem);
  }, []);

  const axisMoney = { axisLabel: { formatter: (v: number) => f.moneyShort(v) }, splitLine: { lineStyle: { type: "dashed" as const } } };
  const periodAxis = (rows: { period: string }[]) => ({ type: "category" as const, data: rows.map((r) => r.period),
    axisLabel: { formatter: (v: string) => f.period(v) } });

  // 1. 月度开票额（柱）
  const billingOpt = useMemo(() => ({
    grid: GRID, tooltip: { trigger: "axis" as const, valueFormatter: (v: number) => f.money(v) },
    xAxis: periodAxis(biz), yAxis: { type: "value", ...axisMoney },
    series: [{ name: t("an.billing"), type: "bar", barMaxWidth: 28, itemStyle: { color: C.blue, borderRadius: [3,3,0,0] },
      data: biz.map((r) => Number(r.billing)) }],
  }), [biz, t, f]);

  // 2. 月度业务量（发票数 + 进口提单，双线，同为"件数"量纲，可同轴）
  const volumeOpt = useMemo(() => ({
    grid: GRID, tooltip: { trigger: "axis" as const }, legend: { top: 0 },
    xAxis: periodAxis(biz), yAxis: { type: "value", splitLine: { lineStyle: { type: "dashed" } } },
    series: [
      { name: t("an.invoices"), type: "line", smooth: true, symbol: "circle", symbolSize: 6, itemStyle: { color: C.blue }, data: biz.map((r) => r.invoices) },
      { name: t("an.shipments"), type: "line", smooth: true, symbol: "circle", symbolSize: 6, itemStyle: { color: C.aqua }, data: biz.map((r) => r.import_shipments) },
    ],
  }), [biz, t]);

  // 3. 回款速度 DSO（中位 + P90 线）
  const dsoOpt = useMemo(() => ({
    grid: GRID, tooltip: { trigger: "axis" as const, valueFormatter: (v: number) => `${Math.round(v)} d` }, legend: { top: 0 },
    xAxis: periodAxis(dso), yAxis: { type: "value", axisLabel: { formatter: "{value} d" }, splitLine: { lineStyle: { type: "dashed" } } },
    series: [
      { name: t("an.median"), type: "line", smooth: true, symbol: "circle", symbolSize: 6, itemStyle: { color: C.blue }, areaStyle: { color: "rgba(42,120,214,.10)" }, data: dso.map((r) => r.median_days === null ? null : Math.round(Number(r.median_days))) },
      { name: t("an.p90"), type: "line", smooth: true, symbol: "none", lineStyle: { type: "dashed" }, itemStyle: { color: C.orange }, data: dso.map((r) => r.p90_days === null ? null : Math.round(Number(r.p90_days))) },
    ],
  }), [dso, t]);

  // 4. Top 客户敞口（横向条形）
  const topOpt = useMemo(() => {
    const rows = [...top].reverse();
    return {
      grid: { left: 180, right: 60, top: 12, bottom: 24 },
      tooltip: { trigger: "axis" as const, axisPointer: { type: "shadow" as const }, valueFormatter: (v: number) => f.money(v) },
      xAxis: { type: "value", ...axisMoney },
      yAxis: { type: "category", data: rows.map((r) => r.entity_name.length > 24 ? r.entity_name.slice(0,23)+"…" : r.entity_name), axisLabel: { fontSize: 11 } },
      series: [{ type: "bar", barMaxWidth: 18, itemStyle: { color: C.blue, borderRadius: [0,3,3,0] },
        data: rows.map((r) => Number(r.total_open)),
        label: { show: true, position: "right" as const, formatter: (p: {value:number}) => f.money(p.value), fontSize: 11 } }],
    };
  }, [top, f]);

  // 5. 成本未转嫁按类别（条形）
  const clsOpt = useMemo(() => ({
    grid: { left: 90, right: 60, top: 12, bottom: 24 },
    tooltip: { trigger: "axis" as const, axisPointer: { type: "shadow" as const }, valueFormatter: (v: number) => f.money(v) },
    xAxis: { type: "value", ...axisMoney },
    yAxis: { type: "category", data: [...cls].reverse().map((r) => r.class) },
    series: [{ type: "bar", barMaxWidth: 18, itemStyle: { color: C.orange, borderRadius: [0,3,3,0] },
      data: [...cls].reverse().map((r) => Number(r.gap)),
      label: { show: true, position: "right" as const, formatter: (p:{value:number}) => f.money(p.value), fontSize: 11 } }],
  }), [cls, f]);

  // 6. 滞期回收（按年，付出 vs 收回 分组柱 + 回收率标签）
  const demByYear = useMemo(() => {
    const m = new Map<number, { paid: number; recov: number }>();
    dem.forEach((r) => { const y=r.year; const e=m.get(y)??{paid:0,recov:0}; e.paid+=Number(r.paid_out); e.recov+=Number(r.recovered); m.set(y,e); });
    return [...m.entries()].sort((a,b)=>a[0]-b[0]);
  }, [dem]);
  const demOpt = useMemo(() => ({
    grid: GRID, legend: { top: 0 },
    tooltip: { trigger: "axis" as const, axisPointer: { type: "shadow" as const }, valueFormatter: (v: number) => f.money(v) },
    xAxis: { type: "category", data: demByYear.map(([y]) => String(y)) },
    yAxis: { type: "value", ...axisMoney },
    series: [
      { name: t("an.paidOut"), type: "bar", barMaxWidth: 26, itemStyle: { color: C.orange, borderRadius:[3,3,0,0] }, data: demByYear.map(([,v]) => v.paid) },
      { name: t("an.recovered"), type: "bar", barMaxWidth: 26, itemStyle: { color: C.aqua, borderRadius:[3,3,0,0] }, data: demByYear.map(([,v]) => v.recov),
        label: { show: true, position: "top" as const, fontSize: 11, color: "#666",
          formatter: (p:{dataIndex:number}) => { const [,v]=demByYear[p.dataIndex]; return v.paid? Math.round(100*v.recov/v.paid)+"%":""; } } },
    ],
  }), [demByYear, t, f]);

  const chart = (h=300) => ({ height: h });
  const monthsCtl = <Segmented size="small" value={months} onChange={(v)=>setMonths(Number(v))}
    options={[12,24,36].map((n)=>({label:t("an.months",{n}),value:n}))} />;

  return (
    <Space direction="vertical" size={16} style={{ width: "100%" }}>
      <Row justify="space-between" align="middle">
        <Typography.Text type="secondary">{t("an.note")}</Typography.Text>
        {monthsCtl}
      </Row>
      <Row gutter={[16,16]}>
        <Col xs={24} xl={12}><Card title={t("an.billingTrend")} size="small"><ReactECharts option={billingOpt} style={chart()} notMerge /></Card></Col>
        <Col xs={24} xl={12}><Card title={t("an.invoices")+" / "+t("an.shipments")} size="small"><ReactECharts option={volumeOpt} style={chart()} notMerge /></Card></Col>
        <Col xs={24} xl={12}><Card size="small" title={<InfoLabel title={t("an.dsoTrend")} help={t("an.dsoNote")} />}><ReactECharts option={dsoOpt} style={chart()} notMerge /></Card></Col>
        <Col xs={24} xl={12}><Card title={t("an.agingTrend")} size="small" styles={{ body: { padding: 0 } }}><AgingTrend embed /></Card></Col>
        <Col xs={24} xl={12}><Card title={t("an.demurrageTrend")} size="small"><ReactECharts option={demOpt} style={chart()} notMerge /></Card></Col>
        <Col xs={24} xl={12}><Card title={<InfoLabel title={t("an.topCustomers")} help={t("cust.utilizationHelp")} />} size="small"
          extra={<Link to="/customers">{t("common.view")}</Link>}><ReactECharts option={topOpt} style={chart(340)} notMerge /></Card></Col>
        <Col xs={24} xl={12}><Card title={t("an.unrecByClass")} size="small"
          extra={<Link to="/costs">{t("common.view")}</Link>}><ReactECharts option={clsOpt} style={chart(300)} notMerge /></Card></Col>
        <Col xs={24}><StaffOutput /></Col>
      </Row>
    </Space>
  );
}
