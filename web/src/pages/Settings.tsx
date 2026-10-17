import { App, Card, Form, Select, Typography } from "antd";
import { useTranslation } from "react-i18next";
import { changeLocale } from "../i18n";
import { SUPPORTED_LOCALES, detectLocale, setPrefs, type Locale } from "../lib/prefs";
import { usePrefs } from "../lib/format";

const LOCALE_LABEL: Record<Locale, string> = { "en-US": "English (US)", "zh-CN": "中文（简体）", "es-ES": "Español" };

// 时区清单：Intl.supportedValuesOf 在现代浏览器可用；不可用时给一组常用值兜底
const TIMEZONES: string[] = (() => {
  try { return (Intl as unknown as { supportedValuesOf: (k: string) => string[] }).supportedValuesOf("timeZone"); }
  catch { return ["America/Los_Angeles", "America/New_York", "Asia/Shanghai", "Asia/Hong_Kong", "Europe/London", "UTC"]; }
})();

export default function SettingsPage() {
  const { t } = useTranslation();
  const prefs = usePrefs();
  const { message } = App.useApp();

  return (
    <Card title={t("settings.title")} style={{ maxWidth: 640 }}>
      <Form layout="vertical">
        <Form.Item label={t("settings.language")}>
          <Select value={prefs.locale ?? "auto"} onChange={async (v) => {
            const loc = v === "auto" ? null : (v as Locale);
            setPrefs({ locale: loc });
            await changeLocale(loc ?? detectLocale());
            message.success(t("settings.saved"));
          }} options={[{ value: "auto", label: t("settings.languageAuto", { detected: LOCALE_LABEL[detectLocale()] }) },
            ...SUPPORTED_LOCALES.map((l) => ({ value: l, label: LOCALE_LABEL[l] }))]} />
          <Typography.Text type="secondary">{t("settings.fallbackNote")}</Typography.Text>
        </Form.Item>
        <Form.Item label={t("settings.timezone")}>
          <Select showSearch value={prefs.timezone} options={TIMEZONES.map((z) => ({ value: z, label: z }))}
            onChange={(v) => { setPrefs({ timezone: v }); message.success(t("settings.saved")); }} />
        </Form.Item>
      </Form>
    </Card>
  );
}
