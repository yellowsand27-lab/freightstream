import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Card, Col, Drawer, Row, Segmented, Space, Statistic, Table, Tag, Typography, Alert } from "antd";
import type { ColumnsType } from "antd/es/table";
import ReactECharts from "echarts-for-react";
import { useTranslation } from "react-i18next";
import { api } from "../lib/api";
import { useFmt } from "../lib/format";
import InfoLabel from "../components/InfoLabel";

const C = { blue: "#2a78d6", orange: "#eb6834", aqua: "#1baf7a", red: "#e34948", green: "#008300", grey: "#8c8c8c" };

interface Summary {
  operators: number; files: number; direct_files: number; med_lag_days: string | null;
  unbilled_over_45: number; unrec_gap: string; dem_paid: string; dem_recovered: string;
  dem_recovery_pct: string | null; dup_groups: number; dup_extra: string;
}
interface Row_ {
  operator: string; files: number; direct_files: number; customers: number; last_file_at: string | null;
  med_lag_days: string | null; lag_over_45: number; unbilled_over_45: number; ar_billed: string;
  unrec_gap: string; unrec_files: number; agent_debit: string; dem_paid: string; dem_recovered: string;
  dem_recovery_pct: string | null; dup_groups: number; dup_extra: string;
}
interface Trend { period: string; files: number; direct_files: number; med_lag_days: string | null; unrec_gap: string }
interface FileRow {
  shipment_id: number; hbl_no: string | null; operator: string; entity_name: string | null;
  business_model: string | null; file_opened: string; eta: string | null; first_invoice_date: string | null;
  lag_days: number | null; unbilled_days: number | null; ar_billed: string; ap_cost: string;
  unrec_gap: string; agent_debit: string; dem_paid: string; dem_recovered: string; dup_groups: number; dup_extra: string;
  dup_max_gap_hours: string | null;
}
interface Paged<T> { data: T[]; total: number }

/** 点开某个数字时要钻取的问题类别，与后端 /api/staff/files?issue= 一一对应 */
type Issue = "unbilled" | "slow_billing" | "unrecovered" | "demurrage" | "duplicate";

export default function OpScorecardPage() {
  const { t } = useTranslation();
  const f = useFmt();
  const [months, setMonths] = useState(12);
  const [sum, setSum] = useState<Summary | null>(null);
  const [rows, setRows] = useState<Row_[]>([]);
  const [trend, setTrend] = useState<Trend[]>([]);
  const [pick, setPick] = useState<string | undefined>();          // undefined = 全团队趋势
  const [drill, setDrill] = useState<{ operator: string; issue: Issue } | null>(null);
  const [files, setFiles] = useState<FileRow[]>([]);
  const [total, setTotal] = useState(0);

  useEffect(() => {
    api.get<Summary>("/api/staff/summary", { months }).then(setSum);
    api.get<Row_[]>("/api/staff/scorecard", { months, minFiles: 10 }).then(setRows);
  }, [months]);
  useEffect(() => { api.get<Trend[]>("/api/staff/trend", { months: 24, operator: pick }).then(setTrend); }, [pick]);
  useEffect(() => {
    if (!drill) { setFiles([]); setTotal(0); return; }
    api.get<Paged<FileRow>>("/api/staff/files", { months, operator: drill.operator, issue: drill.issue, pageSize: 100 })
      .then((r) => { setFiles(r.data); setTotal(r.total); });
  }, [drill, months]);

  /** 可点的数字：0 不给链接，避免制造"点了什么都没有"的挫败 */
  const drillNum = (v: number, operator: string, issue: Issue, color?: string) =>
    v === 0 ? <span style={{ color: C.grey }}>0</span>
            : <a style={{ color }} onClick={() => setDrill({ operator, issue })}>{f.num(v)}</a>;

  // 趋势：柱=票数(全口径/自营)，线=开票时效中位数(右轴)
  const trendOpt = useMemo(() => ({
    grid: { left: 56, right: 56, top: 32, bottom: 28 }, legend: { top: 0 },
    tooltip: { trigger: "axis" as const },
    xAxis: { type: "category" as const, data: trend.map((r) => r.period), axisLabel: { formatter: (v: string) => f.period(v) } },
    yAxis: [
      { type: "value", splitLine: { lineStyle: { type: "dashed" as const } } },
      { type: "value", axisLabel: { formatter: "{value}d" }, splitLine: { show: false } },
    ],
    series: [
      { name: t("op.legendDirect"), type: "bar", stack: "x", barMaxWidth: 22, itemStyle: { color: C.blue }, data: trend.map((r) => r.direct_files) },
      { name: t("op.agencyFiles"), type: "bar", stack: "x", barMaxWidth: 22, itemStyle: { color: "#c9d9ee" }, data: trend.map((r) => r.files - r.direct_files) },
      { name: t("op.medLag"), type: "line", smooth: true, symbol: "circle", symbolSize: 5, yAxisIndex: 1,
        itemStyle: { color: C.orange }, data: trend.map((r) => (r.med_lag_days === null ? null : Number(r.med_lag_days))) },
    ],
  }), [trend, t, f]);

  const lagCell = (v: string | null) => {
    if (v === null) return <span style={{ color: C.grey }}>—</span>;
    const n = Number(v);
    return <b style={{ color: n > 45 ? C.red : n > 30 ? C.orange : C.green }}>{f.days(n)}d</b>;
  };
  const recovCell = (v: string | null) => {
    if (v === null) return <span style={{ color: C.grey }}>—</span>;
    const n = Number(v);
    return <span style={{ color: n < 80 ? C.red : n < 100 ? C.orange : C.green }}>{n}%</span>;
  };

  const cols: ColumnsType<Row_> = [
    { title: t("op.operator"), dataIndex: "operator", fixed: "left", width: 110,
      render: (v: string) => <a onClick={() => setPick(v === pick ? undefined : v)}><b>{v}</b></a> },
    { title: t("op.files"), dataIndex: "files", align: "right", width: 90,
      sorter: (a, b) => a.files - b.files, defaultSortOrder: "descend", render: (v) => f.num(v) },
    { title: <InfoLabel title={t("op.directFiles")} help={t("op.directFilesHelp")} />, dataIndex: "direct_files",
      align: "right", width: 110, sorter: (a, b) => a.direct_files - b.direct_files,
      render: (v: number, r) => <span>{f.num(v)} <span style={{ color: C.grey, fontSize: 12 }}>
        ({r.files ? Math.round((100 * v) / r.files) : 0}%)</span></span> },
    { title: t("op.customers"), dataIndex: "customers", align: "right", width: 115, sorter: (a, b) => a.customers - b.customers, render: (v) => f.num(v) },
    { title: <InfoLabel title={t("op.medLag")} help={t("op.medLagHelp")} />, dataIndex: "med_lag_days",
      align: "right", width: 110, sorter: (a, b) => Number(a.med_lag_days ?? -1) - Number(b.med_lag_days ?? -1),
      render: (v: string | null) => lagCell(v) },
    { title: <InfoLabel title={t("op.unbilled45")} help={t("op.unbilled45Help")} />, dataIndex: "unbilled_over_45",
      align: "right", width: 120, sorter: (a, b) => a.unbilled_over_45 - b.unbilled_over_45,
      render: (v: number, r) => drillNum(v, r.operator, "unbilled", v > 0 ? C.red : undefined) },
    { title: <InfoLabel title={t("op.unrecGap")} help={t("op.unrecGapHelp")} />, dataIndex: "unrec_gap",
      align: "right", width: 130, sorter: (a, b) => Number(a.unrec_gap) - Number(b.unrec_gap),
      render: (v: string, r) => Number(v) === 0 ? <span style={{ color: C.grey }}>—</span>
        : <a style={{ color: C.red }} onClick={() => setDrill({ operator: r.operator, issue: "unrecovered" })}>{f.money(v)}</a> },
    { title: <InfoLabel title={t("op.demRecovery")} help={t("op.demRecoveryHelp")} />, dataIndex: "dem_recovery_pct",
      align: "right", width: 130, sorter: (a, b) => Number(a.dem_recovery_pct ?? -1) - Number(b.dem_recovery_pct ?? -1),
      render: (v: string | null, r) => Number(r.dem_paid) === 0 ? <span style={{ color: C.grey }}>—</span>
        : <a onClick={() => setDrill({ operator: r.operator, issue: "demurrage" })}>{recovCell(v)}</a> },
    { title: <InfoLabel title={t("op.dupGroups")} help={t("op.dupGroupsHelp")} />, dataIndex: "dup_groups",
      align: "right", width: 120, sorter: (a, b) => a.dup_groups - b.dup_groups,
      render: (v: number, r) => drillNum(v, r.operator, "duplicate", v > 0 ? C.orange : undefined) },
    { title: <InfoLabel title={t("op.arBilled")} help={t("op.arBilledHelp")} />, dataIndex: "ar_billed",
      align: "right", width: 130, sorter: (a, b) => Number(a.ar_billed) - Number(b.ar_billed), render: (v) => f.money(v) },
  ];

  const fileCols: ColumnsType<FileRow> = [
    { title: t("op.hbl"), dataIndex: "hbl_no", width: 150, render: (v) => v || "—" },
    { title: t("op.customer"), dataIndex: "entity_name", width: 240, ellipsis: true, render: (v) => v || "—" },
    { title: t("op.model"), dataIndex: "business_model", width: 90,
      render: (v: string | null) => v === "direct" ? <Tag color="blue">direct</Tag> : <Tag>{v || "—"}</Tag> },
    { title: t("op.fileOpened"), dataIndex: "file_opened", width: 110, render: (v) => f.date(v) },
    { title: t("op.lagDays"), dataIndex: "lag_days", align: "right", width: 100,
      render: (v: number | null, r) => v != null ? `${f.days(v)}d`
        : r.unbilled_days != null ? <b style={{ color: C.red }}>{t("op.unbilledFor", { n: f.days(r.unbilled_days) })}</b> : "—" },
    { title: t("op.apCost"), dataIndex: "ap_cost", align: "right", width: 110, render: (v) => f.money2(v) },
    { title: t("op.arBilled"), dataIndex: "ar_billed", align: "right", width: 110, render: (v) => f.money2(v) },
    { title: t("op.unrecGap"), dataIndex: "unrec_gap", align: "right", width: 110,
      render: (v: string) => Number(v) === 0 ? "—" : <b style={{ color: C.red }}>{f.money2(v)}</b> },
    { title: <InfoLabel title={t("op.agentDebit")} help={t("op.agentDebitHelp")} />, dataIndex: "agent_debit",
      align: "right", width: 130,
      render: (v: string) => Number(v) === 0 ? "—" : <span style={{ color: C.blue }}>{f.money2(v)}</span> },
    { title: t("op.demPaid"), dataIndex: "dem_paid", align: "right", width: 110,
      render: (v: string, r) => Number(v) === 0 ? "—" : <span>{f.money2(v)} → {f.money2(r.dem_recovered)}</span> },
    { title: t("op.dupExtra"), dataIndex: "dup_extra", align: "right", width: 120,
      render: (v: string, r) => r.dup_groups === 0 ? "—"
        : <span>{f.money2(v)}{r.dup_max_gap_hours != null && <span style={{ color: C.grey, fontSize: 12 }}> · {t("op.gapH", { h: r.dup_max_gap_hours })}</span>}</span> },
  ];

  const kpi = (label: ReactNode, value: ReactNode, color?: string) =>
    <Col xs={12} md={8} lg={6} xl={4}><Card size="small"><Statistic title={label} valueStyle={color ? { color } : undefined} value={value as string} /></Card></Col>;

  return (
    <Space direction="vertical" size={16} style={{ width: "100%" }}>
      <Typography.Text type="secondary">{t("op.hint")}</Typography.Text>
      <Alert type="info" showIcon message={t("op.noScoreTitle")} description={t("op.noScoreBody")} />

      <Space>
        <Segmented value={months} onChange={(v) => setMonths(Number(v))}
          options={[{ label: t("op.m3"), value: 3 }, { label: t("op.m12"), value: 12 }, { label: t("op.m24"), value: 24 }]} />
      </Space>

      <Row gutter={[16, 16]}>
        {kpi(t("op.kpiOps"), sum ? f.num(sum.operators) : "—")}
        {kpi(t("op.kpiFiles"), sum ? f.num(sum.files) : "—")}
        {kpi(<InfoLabel title={t("op.medLag")} help={t("op.medLagHelp")} />, sum?.med_lag_days != null ? `${sum.med_lag_days}d` : "—")}
        {kpi(<InfoLabel title={t("op.unbilled45")} help={t("op.unbilled45Help")} />, sum ? f.num(sum.unbilled_over_45) : "—", C.red)}
        {kpi(<InfoLabel title={t("op.unrecGap")} help={t("op.unrecGapHelp")} />, sum ? f.money(sum.unrec_gap) : "—", C.red)}
        {kpi(<InfoLabel title={t("op.demRecovery")} help={t("op.demRecoveryHelp")} />, sum?.dem_recovery_pct != null ? `${sum.dem_recovery_pct}%` : "—")}
      </Row>

      <Card size="small" title={<InfoLabel title={t("op.scorecardTitle")} help={t("op.scorecardHelp")} />}>
        <Table<Row_> rowKey="operator" size="small" columns={cols} dataSource={rows}
          pagination={false} scroll={{ x: 1180 }}
          rowClassName={(r) => (r.operator === pick ? "ant-table-row-selected" : "")} />
      </Card>

      <Card size="small"
        title={<Space><InfoLabel title={pick ? t("op.trendOne", { who: pick }) : t("op.trendAll")} help={t("op.trendHelp")} />
          {pick && <a onClick={() => setPick(undefined)}>{t("op.backToTeam")}</a>}</Space>}>
        <ReactECharts option={trendOpt} style={{ height: 300 }} notMerge />
      </Card>

      <Drawer open={!!drill} onClose={() => setDrill(null)} width={1100}
        title={drill ? `${drill.operator} · ${t(`op.issue.${drill.issue}`)} · ${t("op.nFiles", { n: total })}` : ""}>
        {drill && (
          <Space direction="vertical" size={12} style={{ width: "100%" }}>
            <Typography.Text type="secondary">{t(`op.issueHelp.${drill.issue}`)}</Typography.Text>
            <Table<FileRow> rowKey="shipment_id" size="small" columns={fileCols} dataSource={files}
              pagination={{ pageSize: 25, showSizeChanger: false }} scroll={{ x: "max-content" }} />
          </Space>
        )}
      </Drawer>
    </Space>
  );
}
