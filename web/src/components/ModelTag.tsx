import { Tag } from "antd";
import { useTranslation } from "react-i18next";

const COLOR: Record<string, string> = { direct: "green", agency: "geekblue", internal: "purple", unknown: "default" };

export default function ModelTag({ value }: { value?: string | null }) {
  const { t } = useTranslation();
  const v = value ?? "unknown";
  return <Tag color={COLOR[v] ?? "default"}>{t(`cust.modelValue.${v}`, { defaultValue: v })}</Tag>;
}
