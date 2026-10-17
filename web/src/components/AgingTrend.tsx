import { useEffect, useMemo, useState } from "react";
import ReactECharts from "echarts-for-react";
import { Card, Segmented, Space, Switch, Typography } from "antd";
import { useTranslation } from "react-i18next";
import { api } from "../lib/api";
import { useFmt } from "../lib/format";

interface Row { period: string; aging_bucket: string; invoices: number; balance: string }

const BUCKETS = ["0_current", "1_1-30", "2_31-60", "3_61-90", "4_91-180", "5_181-365", "6_365+"];
// 序数色阶：严重度递增 → 蓝色加深。取自校验过的调色板。
const RAMP = ["#86b6ef", "#6da7ec", "#5598e7", "#3987e5", "#2a78d6", "#256abf", "#1c5cab"];

/** 账龄趋势。每个点由 mart.aging_as_of 回溯计算，不依赖快照表。 */
export default function AgingTrend({ embed = false }: { embed?: boolean } = {}) {
  const { t } = useTranslation();
  const f = useFmt();
  const [months, setMonths] = useState(12);
  const [incl, setIncl] = useState(false);
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    setLoading(true);
    api.get<Row[]>("/api/aging/trend", { months, includeRelated: incl }).then(setRows).finally(() => setLoading(false));
  }, [months, incl]);

  const option = useMemo(() => {
    const periods = [...new Set(rows.map((r) => r.period))].sort();
    const series = BUCKETS.map((b, i) => ({
      name: t(`aging.bucket.${b}`),
      type: "bar", stack: "total", barMaxWidth: 36,
      itemStyle: { color: RAMP[i], borderColor: "#fff", borderWidth: 1 },
      emphasis: { focus: "series" },
      data: periods.map((p) => Number(rows.find((r) => r.period === p && r.aging_bucket === b)?.balance ?? 0)),
    }));
    return {
      grid: { left: 64, right: 16, top: 40, bottom: 28 },
      tooltip: { trigger: "axis", axisPointer: { type: "shadow" },
        formatter: (ps: { seriesName: string; value: number; axisValue: string; color: string }[]) => {
          const tot = ps.reduce((s, p) => s + p.value, 0);
          return `<b>${f.period(ps[0].axisValue)}</b><br/>` +
            ps.filter((p) => p.value > 0).map((p) => `<span style="display:inline-block;width:9px;height:9px;border-radius:2px;background:${p.color};margin-right:6px"></span>${p.seriesName}: ${f.money(p.value)}`).join("<br/>") +
            `<br/><b>${t("common.total")}: ${f.money(tot)}</b>`;
        } },
      legend: { top: 0, type: "scroll" },
      xAxis: { type: "category", data: periods, axisLabel: { formatter: (v: string) => f.period(v) } },
      yAxis: { type: "value", axisLabel: { formatter: (v: number) => f.moneyShort(v) }, splitLine: { lineStyle: { type: "dashed" } } },
      series,
    };
  }, [rows, t, f]);

  const controls = (<Space>
        <Segmented size="small" value={months} onChange={(v) => setMonths(Number(v))}
          options={[6, 12, 24, 36].map((n) => ({ label: t("common.months", { n }), value: n }))} />
        <Switch size="small" checked={incl} onChange={setIncl} /> <Typography.Text type="secondary">{t("aging.includeRelated")}</Typography.Text>
      </Space>);
  const inner = (<>
    <ReactECharts option={option} style={{ height: embed ? 300 : 320 }} notMerge lazyUpdate />
    <Typography.Paragraph type="secondary" style={{ margin: embed ? "8px 12px 4px" : "12px 0 0", fontSize: 12 }}>{t("aging.note")}</Typography.Paragraph>
  </>);
  if (embed) return (<div style={{ padding: 12 }}><div style={{ textAlign: "right", marginBottom: 8 }}>{controls}</div>{inner}</div>);
  return (
    <Card title={t("aging.trend")} loading={loading && rows.length === 0} extra={controls}>
      {inner}
    </Card>
  );
}
