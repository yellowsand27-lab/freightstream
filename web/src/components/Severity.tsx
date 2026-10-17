import { Tag } from "antd";
import { useTranslation } from "react-i18next";

const COLOR: Record<string, string> = { critical: "red", serious: "volcano", warning: "gold", info: "blue" };

export default function Severity({ value }: { value: string }) {
  const { t } = useTranslation();
  return <Tag color={COLOR[value] ?? "default"}>{t(`severity.${value}`, { defaultValue: value })}</Tag>;
}
