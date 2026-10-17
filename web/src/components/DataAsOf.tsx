import { useEffect, useState } from "react";
import { Tag, Tooltip } from "antd";
import { ClockCircleOutlined } from "@ant-design/icons";
import { useTranslation } from "react-i18next";
import { api } from "../lib/api";
import { useFmt } from "../lib/format";

/** 数据水位线：读 mirror.refresh_log 最新成功记录。让看的人知道数据是什么时候的。 */
export default function DataAsOf() {
  const { t } = useTranslation();
  const f = useFmt();
  const [asOf, setAsOf] = useState<string | null>(null);
  useEffect(() => { api.get<{ asOf: string | null }>("/api/meta/refresh").then((r) => setAsOf(r.asOf)).catch(() => {}); }, []);
  if (!asOf) return null;
  return (
    <Tooltip title={f.timezone}>
      <Tag icon={<ClockCircleOutlined />} color="default" style={{ marginInlineEnd: 0 }}>
        {t("app.dataAsOf", { ts: f.datetime(asOf) })}
      </Tag>
    </Tooltip>
  );
}
