import { en } from './locales/en';

/**
 * Japanese source strings are the keys; other languages map them to translations.
 * The webview reads <html lang>, the extension host reads VS Code's NLS config.
 * Without either (unit tests, browser fixtures) the original Japanese is used.
 */
export type Locale = 'ja' | 'en';
let locale: Locale = 'ja';
let dictionary: Record<string, string> = {};

export function setLocale(value: string | undefined | null): Locale {
  locale = !value ? 'ja' : value.toLowerCase().startsWith('ja') ? 'ja' : 'en';
  dictionary = locale === 'en' ? en : {};
  return locale;
}
export const currentLocale = (): Locale => locale;
/** BCP 47 tag for dates and numbers in the current UI language. */
export const dateLocale = (): string => locale === 'ja' ? 'ja-JP' : 'en-US';

export function t(text: string, ...args: (string | number)[]): string {
  const template = dictionary[text] ?? text;
  return args.length ? template.replace(/\{(\d+)\}/g, (match, index: string) => index in args ? String(args[+index]) : match) : template;
}

function detect(): string | undefined {
  try {
    if (typeof document !== 'undefined') return document.documentElement.lang || undefined;
    const config = typeof process !== 'undefined' ? process.env.VSCODE_NLS_CONFIG : undefined;
    if (config) return (JSON.parse(config) as { locale?: string }).locale;
    if (typeof process !== 'undefined' && process.env.MARKDOWN_LENS_LOCALE) return process.env.MARKDOWN_LENS_LOCALE;
  } catch { /* Keep the default language. */ }
  return undefined;
}
setLocale(detect());
