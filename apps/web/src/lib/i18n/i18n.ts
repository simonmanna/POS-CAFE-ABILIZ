/**
 * i18n bootstrap. Primary languages: English (default), Tigrinya, Luganda,
 * Swahili. Spanish and French are kept as legacy extras.
 * Translations live in `./locales/<lng>.json` and are imported eagerly so
 * the bundle ships fully-localized strings — no runtime fetch.
 *
 * Locale auto-detection order:
 *   1. localStorage 'cafe-pos.locale' (set by the LanguageSwitcher)
 *   2. browser `navigator.language`
 *   3. fallback 'en'
 */
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import LanguageDetector from 'i18next-browser-languagedetector';
import en from './locales/en.json';
import ti from './locales/ti.json';
import lg from './locales/lg.json';
import sw from './locales/sw.json';
import es from './locales/es.json';
import fr from './locales/fr.json';

export const SUPPORTED_LOCALES = ['en', 'ti', 'lg', 'sw', 'es', 'fr'] as const;
export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number];

/** Native names shown in the language picker. */
export const LOCALE_NAMES: Record<SupportedLocale, string> = {
  en: 'English',
  ti: 'ትግርኛ',
  lg: 'Luganda',
  sw: 'Kiswahili',
  es: 'Español',
  fr: 'Français',
};

/** Short badge labels (header button, compact UI). */
export const LOCALE_LABELS: Record<SupportedLocale, string> = {
  en: 'EN',
  ti: 'ትግ',
  lg: 'LG',
  sw: 'SW',
  es: 'ES',
  fr: 'FR',
};

void i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources: {
      en: { translation: en },
      ti: { translation: ti },
      lg: { translation: lg },
      sw: { translation: sw },
      es: { translation: es },
      fr: { translation: fr },
    },
    fallbackLng: 'en',
    supportedLngs: SUPPORTED_LOCALES as unknown as string[],
    detection: {
      order: ['localStorage', 'navigator', 'htmlTag'],
      caches: ['localStorage'],
      lookupLocalStorage: 'cafe-pos.locale',
    },
    interpolation: { escapeValue: false },
    react: { useSuspense: false },
  });

/** Keep <html lang> in sync so screen readers and fonts pick the right locale. */
const applyHtmlLang = (lng: string) => {
  if (typeof document !== 'undefined') document.documentElement.lang = lng.slice(0, 2);
};
applyHtmlLang(i18n.resolvedLanguage ?? i18n.language ?? 'en');
i18n.on('languageChanged', applyHtmlLang);

export default i18n;
