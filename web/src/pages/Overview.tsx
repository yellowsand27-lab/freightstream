import { useCallback, useEffect, useState } from "react";
import { Alert, Button, Col, Row, Space, Typography } from "antd";
import { StatisticCard } from "@ant-design/pro-components";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { api, ApiError } from "../lib/api";
import { useFmt } from "../lib/format";
import AgingTrend from "../components/AgingTrend";
import InfoLabel from "../components/InfoLabel";

interface Overview {
  kpi: Record<string, string | number | null>;
  alerts: { alert_code: string; n: number; amount: string | null }[];
}

export default function OverviewPage() {
  const { t } = useTranslation();
  const f = useFmt();
  const [d, setD] = useState<Overview | null>(null);
  // 错误必须显式建模：只靠 d===null 判 loading 的话，/api/overview 一失败
  // 整页就永远停在骨架屏，看不出是坏了还是在加载（2026-09-29 生产就是这样）。
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(() => {
    setErr(null);
    setD(null);
    api.get<Overview>("/api/overview")
      .then(setD)
      .catch((e) => setErr(e instanceof ApiError ? e.errorKey : "error.request"));
  }, []);
  useEffect(load, [load]);

  const k = d?.kpi ?? {};
  const loading = !d && !err;

  return (
    <Space direction="vertical" size={16} style={{ width: "100%" }}>
      {err && (
        <Alert type="error" showIcon message={t(err)}
          action={<Button size="small" onClick={load}>{t("common.retry")}</Button>} />
      )}

      <StatisticCard.Group loading={loading}>
        <StatisticCard statistic={{ title: <InfoLabel title={t("kpi.openReceivables")} help={t("kpi.openReceivablesHelp")} />, value: f.money(k.open_total), description: t("kpi.invoices", { n: f.num(k.open_invoices) }) }} />
        <StatisticCard statistic={{ title: <InfoLabel title={t("kpi.overdueByBaseline")} help={t("kpi.overdueByBaselineHelp")} />, value: f.money(k.overdue_by_baseline), valueStyle: { color: "#d03b3b" } }} />
        <StatisticCard statistic={{ title: <InfoLabel title={t("kpi.creditBreaches")} help={t("kpi.creditBreachesHelp")} />, value: f.num(k.credit_breaches), description: t("kpi.customers", { n: f.num(k.credit_breaches) }), valueStyle: { color: "#d03b3b" } }} />
        <StatisticCard statistic={{ title: <InfoLabel title={t("kpi.unrecovered12m")} help={t("kpi.unrecovered12mHelp")} />, value: f.money(k.unrecovered_12m), valueStyle: { color: "#ec835a" } }} />
        <StatisticCard statistic={{ title: <InfoLabel title={t("kpi.billingLagMedian")} help={t("kpi.billingLagMedianHelp")} />, value: f.days(k.billing_lag_median), suffix: t("kpi.days", { n: "" }).trim() }} />
        <StatisticCard statistic={{ title: <InfoLabel title={t("kpi.unbilledFiles")} help={t("kpi.unbilledFilesHelp")} />, value: f.num(k.unbilled_files), valueStyle: { color: "#ec835a" } }} />
      </StatisticCard.Group>

      <Row gutter={16}>
        <Col xs={24} xl={16}><AgingTrend /></Col>
        <Col xs={24} xl={8}>
          <StatisticCard title={t("alerts.title")} loading={loading}
            extra={<Link to="/alerts">{t("common.view")}</Link>}>
            <Space direction="vertical" style={{ width: "100%" }} size={8}>
              {d?.alerts.map((a) => (
                <Row key={a.alert_code} justify="space-between" align="middle">
                  <Link to={`/alerts?code=${a.alert_code}`}>{t(`alertCode.${a.alert_code}`)}</Link>
                  <Space>
                    <Typography.Text type="secondary">{a.amount ? f.money(a.amount) : ""}</Typography.Text>
                    <Typography.Text strong>{f.num(a.n)}</Typography.Text>
                  </Space>
                </Row>
              ))}
            </Space>
          </StatisticCard>
        </Col>
      </Row>
    </Space>
  );
}
