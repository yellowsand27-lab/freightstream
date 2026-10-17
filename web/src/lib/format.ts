/**
 * 所有数字 / 日期 / 货币格式化的唯一出口。
 * 组件里不允许直接 toFixed / toLocaleString——那样时区和语言切换就管不到了。
 * 全库单一币种 USD（已核实），所以货币格式固定 USD，但数字分隔符跟随语言。
 */
import { useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { getPrefs, subscribePrefs } from "./prefs";

export function usePrefs() {
  return useSyncExternalStore(subscribePrefs, getPrefs, getPrefs);
}

export function useFmt() {
  const { i18n } = useTranslation();
  const { timezone } = usePrefs();
  const lng = i18n.language;

  const money = new Intl.NumberFormat(lng, { style: "currency", currency: "USD", maximumFractionDigits: 0 });
  const moneyCompact = new Intl.NumberFormat(lng, { style: "currency", currency: "USD", notation: "compact", maximumFractionDigits: 1 });
  const money2 = new Intl.NumberFormat(lng, { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const num = new Intl.NumberFormat(lng, { maximumFractionDigits: 0 });
  const pct = new Intl.NumberFormat(lng, { style: "percent", maximumFractionDigits: 1 });
  const date = new Intl.DateTimeFormat(lng, { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" });
  const datetime = new Intl.DateTimeFormat(lng, { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", timeZoneName: "short" });
  const monthShort = new Intl.DateTimeFormat(lng, { timeZone: "UTC", year: "2-digit", month: "short" });

  const n = (v: unknown): number | null => (v === null || v === undefined || v === "" ? null : Number(v));
  return {
    money: (v: unknown) => { const x = n(v); return x === null ? "—" : money.format(x); },
    moneyShort: (v: unknown) => { const x = n(v); return x === null ? "—" : moneyCompact.format(x); },
    money2: (v: unknown) => { const x = n(v); return x === null ? "—" : money2.format(x); },
    num: (v: unknown) => { const x = n(v); return x === null ? "—" : num.format(x); },
    pct: (v: unknown, ratio = true) => { const x = n(v); return x === null ? "—" : pct.format(ratio ? x : x / 100); },
    date: (v: unknown) => (v ? date.format(new Date(String(v))) : "—"),
    datetime: (v: unknown) => (v ? datetime.format(new Date(String(v))) : "—"),
    /** 'YYYY-MM' 期间标签 → 本地化短月份 */
    period: (yyyymm: string) => monthShort.format(new Date(`${yyyymm}-01T00:00:00Z`)),
    days: (v: unknown) => { const x = n(v); return x === null ? "—" : num.format(x); },
    timezone,
    locale: lng,
  };
}
