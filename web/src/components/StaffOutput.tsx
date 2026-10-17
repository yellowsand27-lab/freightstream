import { useEffect, useMemo, useState } from "react";
import { App, Card, Drawer, Segmented, Select, Space, Table, Tag, Typography } from "antd";
import ReactECharts from "echarts-for-react";
import { Link } from "react-router-dom";
import type { ColumnsType } from "antd/es/table";
import { useTranslation } from "react-i18next";
import { api } from "../lib/api";
import { useFmt } from "../lib/format";
import InfoLabel from "./InfoLabel";

interface Board { staff: string; shipments: number; invoices: number; ap: number; total: number; active_days: number; last_active: string }
interface Daily { day: string; total: number; shipments: number; invoices: number; ap: number }
interface DayRec { activity_type: string; ref_id: number; ref_no: string; amount: string | null; at_time: string; entity_id: number | null; entity_name: string | null }

const TYPE_COLOR: Record<string, string> = { shipment: "blue", invoice: "green", ap: "orange" };

export default function StaffOutput() {
  const { t } = useTranslation();
  const f = useFmt();
  const { message } = App.useApp();
  const [months, setMonths] = useState(12);
  const [board, setBoard] = useState<Board[]>([]);
  const [staff, setStaff] = useState<string | undefined>();      // undefined = 全团队
  const [daily, setDaily] = useState<Daily[]>([]);
  const [day, setDay] = useState<string | null>(null);
  const [dayRecs, setDayRecs] = useState<DayRec[]>([]);

  useEffect(() => { api.get<Board[]>("/api/analytics/staff/leaderboard", { months: 3 }).then(setBoard); }, []);
  useEffect(() => { api.get<Daily[]>("/api/analytics/staff/daily", { months, staff }).then(setDaily); }, [months, staff]);
  useEffect(() => {
    if (!day || !staff) { setDayRecs([]); return; }
    api.get<DayRec[]>("/api/analytics/staff/day", { staff, day }).then(setDayRecs);
  }, [day, staff]);

  // ECharts 日历热力图
  const calOpt = useMemo(() => {
    if (daily.length === 0) return {};
    const data = daily.map((d) => [d.day, d.total] as [string, number]);
    const max = Math.max(...daily.map((d) => d.total), 1);
    const end = daily[daily.length - 1].day;
    const start = daily[0].day;
    // 起止跨年时 ECharts calendar 需要 range 数组
    return {
      tooltip: { formatter: (p: { value: [string, number] }) => `${p.value[0]}<br/>${t("staff.total")}: ${p.value[1]}` },
      visualMap: { min: 0, max, orient: "horizontal", left: "center", bottom: 0, calculable: true,
        inRange: { color: ["#e9eef4", "#86b6ef", "#2a78d6", "#184f95"] }, textStyle: { fontSize: 11 } },
      calendar: {
        top: 30, left: 40, right: 16, cellSize: ["auto", 16], range: [start, end],
        itemStyle: { borderWidth: 2, borderColor: "#fff", color: "#f6f8fa" },
        yearLabel: { show: false }, monthLabel: { fontSize: 11 }, dayLabel: { fontSize: 10, firstDay: 1 },
        splitLine: { lineStyle: { color: "#ddd" } },
      },
      series: [{ type: "heatmap", coordinateSystem: "calendar", data }],
    };
  }, [daily, t]);

  const boardCols: ColumnsType<Board> = [
    { title: t("staff.title"), dataIndex: "staff", fixed: "left",
      render: (v) => <a onClick={() => { setStaff(v === staff ? undefined : v); }} style={{ fontWeight: v === staff ? 700 : undefined }}>{v}</a> },
    { title: t("staff.shipments"), dataIndex: "shipments", align: "right", width: 80, sorter: (a,b)=>a.shipments-b.shipments },
    { title: t("staff.invoices"), dataIndex: "invoices", align: "right", width: 80, sorter: (a,b)=>a.invoices-b.invoices },
    { title: t("staff.ap"), dataIndex: "ap", align: "right", width: 80, sorter: (a,b)=>a.ap-b.ap },
    { title: t("staff.total"), dataIndex: "total", align: "right", width: 90, defaultSortOrder: "descend", sorter: (a,b)=>a.total-b.total,
      render: (v) => <b>{f.num(v)}</b> },
    { title: t("staff.activeDays"), dataIndex: "active_days", align: "right", width: 90 },
    { title: t("staff.lastActive"), dataIndex: "last_active", width: 110, render: (v) => f.date(v) },
  ];

  const dayCols: ColumnsType<DayRec> = [
    { title: t("staff.time"), dataIndex: "at_time", width: 64 },
    { title: t("staff.type"), dataIndex: "activity_type", width: 90, render: (v) => <Tag color={TYPE_COLOR[v]}>{t(`staff.typeName.${v}`)}</Tag> },
    { title: t("staff.ref"), dataIndex: "ref_no", render: (v) => v || "—" },
    { title: t("staff.party"), dataIndex: "entity_name", ellipsis: true, render: (_, r) => r.entity_id ? <Link to={`/customers/${r.entity_id}`}>{r.entity_name}</Link> : (r.entity_name || "—") },
    { title: t("staff.amount"), dataIndex: "amount", align: "right", width: 120, render: (v) => v == null ? "—" : f.money2(v) },
  ];

  return (
    <Card size="small" title={<InfoLabel title={t("staff.title")} help={t("staff.note")} />}
      extra={<Space>
        <Select allowClear size="small" style={{ width: 180 }} placeholder={t("staff.team")}
          value={staff} onChange={(v) => { setStaff(v); }}
          options={board.map((b) => ({ value: b.staff, label: b.staff }))} showSearch />
        <Segmented size="small" value={months} onChange={(v) => setMonths(Number(v))}
          options={[6,12,24].map((n)=>({label:t("an.months",{n}),value:n}))} />
      </Space>}>
      <Space direction="vertical" size={12} style={{ width: "100%" }}>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {staff ? `${staff} · ${t("staff.clickDay")}` : t("staff.clickDay")}
        </Typography.Text>
        <ReactECharts option={calOpt} style={{ height: 200 }} notMerge
          onEvents={{ click: (p: { value?: [string, number] }) => {
            if (!p.value) return;
            if (!staff) { message.info(t("staff.pick")); return; }
            setDay(p.value[0]);
          } }} />
        <Typography.Text strong style={{ fontSize: 13 }}>{t("staff.leaderboard")}（{t("an.months",{n:3})}）</Typography.Text>
        <Table<Board> rowKey="staff" size="small" columns={boardCols} dataSource={board}
          pagination={{ pageSize: 8 }} scroll={{ x: 640 }} />
      </Space>

      <Drawer open={!!day} onClose={() => setDay(null)} width={720}
        title={day && staff ? t("staff.dayDetail", { staff, day }) : ""}>
        <Space direction="vertical" size={8} style={{ width: "100%" }}>
          <Typography.Text type="secondary">{t("staff.records", { n: dayRecs.length })}</Typography.Text>
          <Table<DayRec> rowKey={(r) => `${r.activity_type}-${r.ref_id}`} size="small" columns={dayCols}
            dataSource={dayRecs} pagination={{ pageSize: 30 }} />
        </Space>
      </Drawer>
    </Card>
  );
}
