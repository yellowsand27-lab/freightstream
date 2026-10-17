import { Space, Typography } from "antd";
import { useTranslation } from "react-i18next";
import DataAsOf from "./DataAsOf";

export const FOOTER_HEIGHT = 44;

/**
 * 框架级页脚：固定在视口底部，与头栏对称，任何页面、任何滚动位置都可见。
 * offsetLeft = 侧栏宽度（展开 / 收起 / 移动端抽屉时为 0），由外层传入。
 */
export default function Footer({ offsetLeft }: { offsetLeft: number }) {
  const { t } = useTranslation();
  return (
    <footer style={{
      position: "fixed", bottom: 0, right: 0, left: offsetLeft, height: FOOTER_HEIGHT, zIndex: 90,
      display: "flex", alignItems: "center", justifyContent: "space-between", gap: 24, padding: "0 20px",
      background: "#fff", borderTop: "1px solid #E6EAF0", fontSize: 12,
      transition: "left .2s",
    }}>
      <Space size={16}>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>{t("footer.product")}</Typography.Text>
        <DataAsOf />
      </Space>
      <Typography.Text type="secondary" style={{ fontSize: 12, whiteSpace: "nowrap" }}>
        {t("footer.copyright", { year: new Date().getFullYear() })}
      </Typography.Text>
    </footer>
  );
}
