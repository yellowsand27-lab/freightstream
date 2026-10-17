import { useCallback, useEffect, useState } from "react";
import { App, Button, Card, Col, Descriptions, Form, InputNumber, Input, Modal, Row, Space, Table, Tag, Typography } from "antd";
import { EditOutlined } from "@ant-design/icons";
import { useParams, Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { api, ApiError } from "../lib/api";
import { useFmt } from "../lib/format";
import { useAuth, canEdit } from "../lib/auth";
import ModelTag from "../components/ModelTag";
import InfoLabel from "../components/InfoLabel";

interface Detail {
  exposure: Record<string, string | number | null> & { entity_name: string; business_model: string; is_related_party: boolean };
  entity: { risk_tier: string | null; note: string | null };
  members: { company_id: number; leg: string; full_name: string; city: string | null; state: string | null; country: string | null }[];
  policy: { credit_limit: string | null; duty_limit: string | null; warn_ratio: string; rationale: string | null; set_by: string | null; updated_at: string } | null;
  openItems: { invoice_id: number; invoice_no: string; invoice_date: string; due_date: string; total_balance: string; days_past_baseline: number | null; days_past_due_nominal: number }[];
  history: { changed_at: string; actor: string; op: string; old_limit: string | null; new_limit: string | null; rationale: string | null }[];
  baseline: { sample_n: number; median_days_to_pay: string; p90_days_to_pay: string; on_time_rate: string; nominal_terms_days: number } | null;
}

export default function CustomerDetailPage() {
  const { id } = useParams();
  const { t } = useTranslation();
  const f = useFmt();
  const me = useAuth();
  const editable = canEdit(me);
  const { message } = App.useApp();
  const [d, setD] = useState<Detail | null>(null);
  const [editing, setEditing] = useState(false);
  const [form] = Form.useForm();

  const load = useCallback(() => api.get<Detail>(`/api/customers/${id}`).then(setD), [id]);
  useEffect(() => { load(); }, [load]);

  if (!d) return <Card loading />;
  const x = d.exposure;

  const save = async () => {
    const v = await form.validateFields();
    try {
      await api.put(`/api/customers/${id}/credit-policy`, v);
      message.success(t("cust.saved"));
      setEditing(false);
      load();
    } catch (e) {
      message.error(t(e instanceof ApiError ? e.errorKey : "error.request"));
    }
  };

  return (
    <Space direction="vertical" size={16} style={{ width: "100%" }}>
      <Card title={<Space>{x.entity_name}<ModelTag value={x.business_model} />{x.is_related_party && <Tag color="purple">{t("cust.relatedParty")}</Tag>}</Space>}>
        <Descriptions column={{ xs: 1, md: 3 }} size="small">
          <Descriptions.Item label={<InfoLabel title={t("cust.totalOpen")} help={t("cust.totalOpenHelp")} />}><b>{f.money(x.total_open)}</b></Descriptions.Item>
          <Descriptions.Item label={<InfoLabel title={t("cust.overdue")} help={t("cust.overdueHelp")} />}><span style={{ color: Number(x.overdue_by_baseline) ? "#d03b3b" : undefined }}>{f.money(x.overdue_by_baseline)}</span></Descriptions.Item>
          <Descriptions.Item label={<InfoLabel title={t("cust.openInvoices")} help={t("cust.openInvoicesHelp")} />}>{f.num(x.open_invoices)}</Descriptions.Item>
          <Descriptions.Item label={t("recv.freight")}>{f.money(x.freight_open)}</Descriptions.Item>
          <Descriptions.Item label={t("recv.duty")}>{f.money(x.duty_open)}</Descriptions.Item>
          <Descriptions.Item label={t("cust.riskTier")}>{d.entity.risk_tier ?? "—"}</Descriptions.Item>
        </Descriptions>
      </Card>

      <Row gutter={16}>
        <Col xs={24} lg={12}>
          <Card title={<InfoLabel title={t("cust.policy")} help={t("cust.policyHelp")} />} extra={editable ? <Button icon={<EditOutlined />} size="small" onClick={() => {
              form.setFieldsValue({ credit_limit: d.policy?.credit_limit ? Number(d.policy.credit_limit) : null,
                duty_limit: d.policy?.duty_limit ? Number(d.policy.duty_limit) : null,
                warn_ratio: d.policy ? Number(d.policy.warn_ratio) : 0.8, rationale: d.policy?.rationale ?? "" });
              setEditing(true); }}>{t("common.edit")}</Button> : null}>
            {d.policy ? (
              <Descriptions column={1} size="small">
                <Descriptions.Item label={t("cust.creditLimit")}>{f.money(d.policy.credit_limit)}{x.limit_utilization && Number(d.policy.credit_limit) >= 100 && <Tag style={{ marginInlineStart: 8 }} color={Number(x.limit_utilization) >= 1 ? "red" : Number(x.limit_utilization) >= Number(d.policy.warn_ratio) ? "gold" : "green"}>{f.pct(x.limit_utilization)}</Tag>}</Descriptions.Item>
                <Descriptions.Item label={t("cust.dutyLimit")}>{f.money(d.policy.duty_limit)}</Descriptions.Item>
                <Descriptions.Item label={t("cust.warnRatio")}>{f.pct(d.policy.warn_ratio)}</Descriptions.Item>
                <Descriptions.Item label={t("cust.rationale")}>{d.policy.rationale ?? "—"}</Descriptions.Item>
                <Descriptions.Item label={t("cust.actor")}>{d.policy.set_by ?? "—"} · {f.datetime(d.policy.updated_at)}</Descriptions.Item>
              </Descriptions>
            ) : <Typography.Text type="secondary">{t("cust.noPolicy")}</Typography.Text>}
          </Card>
        </Col>
        <Col xs={24} lg={12}>
          <Card title={<InfoLabel title={t("cust.baseline")} help={t("cust.baselineHelp")} />}>
            {d.baseline ? (
              <Descriptions column={2} size="small">
                <Descriptions.Item label={t("cust.medianDays")}>{f.days(Math.round(Number(d.baseline.median_days_to_pay)))}</Descriptions.Item>
                <Descriptions.Item label={<InfoLabel title={t("cust.p90")} help={t("cust.p90Help")} />}>{f.days(Math.round(Number(d.baseline.p90_days_to_pay)))}</Descriptions.Item>
                <Descriptions.Item label={t("cust.onTime")}>{f.pct(d.baseline.on_time_rate)}</Descriptions.Item>
                <Descriptions.Item label={<InfoLabel title={t("cust.nominalTerms")} help={t("cust.nominalTermsHelp")} />}>{t("kpi.days", { n: d.baseline.nominal_terms_days })}</Descriptions.Item>
                <Descriptions.Item label={t("cust.sampleN")}>{t("kpi.invoices", { n: f.num(d.baseline.sample_n) })}</Descriptions.Item>
              </Descriptions>
            ) : <Typography.Text type="secondary">{t("cust.noBaseline")}</Typography.Text>}
          </Card>
        </Col>
      </Row>

      <Card title={<InfoLabel title={t("cust.openItems")} help={t("cust.openItemsHelp")} />} size="small">
        <Table size="small" rowKey="invoice_id" dataSource={d.openItems} pagination={{ pageSize: 10 }} columns={[
          { title: t("recv.invoiceNo"), dataIndex: "invoice_no" },
          { title: t("recv.invoiceDate"), dataIndex: "invoice_date", render: (v) => f.date(v) },
          { title: t("recv.dueDate"), dataIndex: "due_date", render: (v) => f.date(v) },
          { title: t("recv.total"), dataIndex: "total_balance", align: "right", render: (v) => f.money2(v) },
          { title: t("recv.pastDueNominal"), dataIndex: "days_past_due_nominal", align: "right" },
          { title: t("recv.pastBaseline"), dataIndex: "days_past_baseline", align: "right", render: (v) => v === null ? "—" : <Tag color={v > 30 ? "red" : v > 0 ? "gold" : "default"}>{v}</Tag> },
        ]} />
      </Card>

      <Row gutter={16}>
        <Col xs={24} lg={12}>
          <Card title={<InfoLabel title={t("cust.members")} help={t("cust.membersHelp")} />} size="small">
            <Table size="small" rowKey="company_id" dataSource={d.members} pagination={false} columns={[
              { title: t("cust.name"), dataIndex: "full_name" },
              { title: t("cust.leg"), dataIndex: "leg", render: (v) => <Tag>{v}</Tag> },
              { title: "", dataIndex: "city", render: (_, r) => [r.city, r.state, r.country].filter(Boolean).join(", ") },
            ]} />
          </Card>
        </Col>
        <Col xs={24} lg={12}>
          <Card title={<InfoLabel title={t("cust.history")} help={t("cust.historyHelp")} />} size="small">
            <Table size="small" rowKey="changed_at" dataSource={d.history} pagination={{ pageSize: 5 }} columns={[
              { title: t("cust.changedAt"), dataIndex: "changed_at", render: (v) => f.datetime(v) },
              { title: t("cust.actor"), dataIndex: "actor" },
              { title: t("cust.oldLimit"), dataIndex: "old_limit", align: "right", render: (v) => f.money(v) },
              { title: t("cust.newLimit"), dataIndex: "new_limit", align: "right", render: (v) => f.money(v) },
              { title: t("cust.rationale"), dataIndex: "rationale", ellipsis: true },
            ]} />
          </Card>
        </Col>
      </Row>

      <Modal title={t("cust.editPolicy")} open={editing} onCancel={() => setEditing(false)} onOk={save} okText={t("common.save")} cancelText={t("common.cancel")}>
        <Form form={form} layout="vertical">
          <Form.Item name="credit_limit" label={t("cust.creditLimit")}><InputNumber style={{ width: "100%" }} min={0} step={1000} /></Form.Item>
          <Form.Item name="duty_limit" label={<InfoLabel title={t("cust.dutyLimit")} help={t("cust.dutyLimitHelp")} />}><InputNumber style={{ width: "100%" }} min={0} step={1000} /></Form.Item>
          <Form.Item name="warn_ratio" label={<InfoLabel title={t("cust.warnRatio")} help={t("cust.warnRatioHelp")} />}><InputNumber style={{ width: "100%" }} min={0.1} max={1} step={0.05} /></Form.Item>
          <Form.Item name="rationale" label={t("cust.rationale")} rules={[{ required: true }]}><Input.TextArea rows={3} /></Form.Item>
        </Form>
        <Typography.Text type="secondary">{me?.email || me?.sub}</Typography.Text>
      </Modal>
      <Link to="/customers">← {t("cust.title")}</Link>
    </Space>
  );
}
