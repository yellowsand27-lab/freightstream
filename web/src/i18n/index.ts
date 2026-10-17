/**
 * i18n 初始化。
 * - 所有界面文案走 locale key，组件里不出现硬编码业务文本
 * - 语言包按语言外置为 JSON，运行时动态 import（只加载当前语言，切换时再加载）
 * - 回退语言 en-US
 * - 浏览器自动检测 + 用户覆盖持久化（见 lib/prefs.ts）
 *
 * 注意：addResourceBundle 只在 init() 之后可用。初始语言包通过 init({ resources })
 * 传入，之后的按需加载才走 addResourceBundle。
 */
import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { FALLBACK_LOCALE, effectiveLocale, type Locale } from "../lib/prefs";

type Pack = Record<string, unknown>;
const loaders: Record<Locale, () => Promise<{ default: Pack }>> = {
  "en-US": () => import("./locales/en-US.json"),
  "zh-CN": () => import("./locales/zh-CN.json"),
  "es-ES": () => import("./locales/es-ES.json"),
};

const loaded = new Set<Locale>();

async function fetchPack(lng: Locale): Promise<Pack> {
  return (await loaders[lng]()).default;
}

export async function initI18n() {
  const initial = effectiveLocale();
  // 回退语言必须先就位，否则缺 key 时无兜底
  const want: Locale[] = initial === FALLBACK_LOCALE ? [FALLBACK_LOCALE] : [FALLBACK_LOCALE, initial];
  const packs = await Promise.all(want.map(fetchPack));
  const resources = Object.fromEntries(want.map((l, i) => [l, { common: packs[i] }]));
  want.forEach((l) => loaded.add(l));

  await i18n.use(initReactI18next).init({
    lng: initial,
    fallbackLng: FALLBACK_LOCALE,
    resources,
    ns: ["common"],
    defaultNS: "common",
    interpolation: { escapeValue: false },
    returnNull: false,
  });
  return i18n;
}

/** 切换语言：未加载过的语言包此时才拉取 */
export async function changeLocale(lng: Locale) {
  if (!loaded.has(lng)) {
    i18n.addResourceBundle(lng, "common", await fetchPack(lng), true, true);
    loaded.add(lng);
  }
  await i18n.changeLanguage(lng);
}

export default i18n;
