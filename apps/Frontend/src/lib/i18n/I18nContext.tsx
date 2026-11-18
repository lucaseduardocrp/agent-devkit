/* eslint-disable react-refresh/only-export-components */
import React, { createContext, useContext, useEffect, useMemo, useState, useCallback } from 'react';
import { enUS } from './locales/en-US';
import { ptBR } from './locales/pt-BR';
import {
  DEFAULT_LOCALE,
  type I18nDictionary,
  type SupportedLocale,
  type TranslationKey,
} from './types';

export const LOCALE_STORAGE_KEY = 'adk_locale';

const DICTIONARIES: Record<SupportedLocale, I18nDictionary> = {
  'pt-BR': ptBR,
  'en-US': enUS,
};

export interface I18nContextValue {
  readonly locale: SupportedLocale;
  readonly setLocale: (locale: SupportedLocale) => void;
  /** Typed dictionary for the active locale, read as `messages.feature.key`. */
  readonly messages: I18nDictionary;
  readonly t: (key: TranslationKey, params?: Record<string, string | number>) => string;
  readonly formatDate: (
    date: Date | string | number,
    options?: Intl.DateTimeFormatOptions,
  ) => string;
  readonly formatNumber: (value: number, options?: Intl.NumberFormatOptions) => string;
}

const I18nContext = createContext<I18nContextValue | null>(null);

export function getInitialLocale(): SupportedLocale {
  const saved = localStorage.getItem(LOCALE_STORAGE_KEY);
  if (saved === 'pt-BR' || saved === 'en-US') {
    return saved;
  }

  const browserLang = navigator.language?.toLowerCase() ?? '';
  if (browserLang.startsWith('en')) {
    return 'en-US';
  }

  return DEFAULT_LOCALE;
}

export type MessageParams = Record<string, string | number>;

/**
 * Replaces `{name}` and `{{name}}` placeholders in a dictionary template in one pass, so values
 * are inserted verbatim (a `$&` or a `{other}` inside a value is never expanded).
 * Placeholders without a value are kept.
 */
export function formatMessage(template: string, params?: MessageParams): string {
  if (!params) return template;
  return template.replace(/\{\{(\w+)\}\}|\{(\w+)\}/g, (match, double?: string, single?: string) => {
    const key = (double ?? single) as string;
    return Object.hasOwn(params, key) ? String(params[key]) : match;
  });
}

/** Locale of the mounted provider, recorded while it renders so its children already read it. */
let activeLocale: SupportedLocale = DEFAULT_LOCALE;

/**
 * Dictionary for code outside React components (pure helpers, thrown errors), in the locale of
 * the mounted provider. Inside components prefer `useI18n().messages`, which re-renders on change.
 */
export function getMessages(locale: SupportedLocale = activeLocale): I18nDictionary {
  return DICTIONARIES[locale];
}

function resolvePath(obj: Record<string, unknown>, path: string): string | undefined {
  const parts = path.split('.');
  let current: unknown = obj;
  for (const part of parts) {
    if (current == null || typeof current !== 'object') {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }
  return typeof current === 'string' ? current : undefined;
}

export interface I18nProviderProps {
  readonly initialLocale?: SupportedLocale;
  readonly onLocaleChange?: (locale: SupportedLocale) => void;
  readonly children: React.ReactNode;
}

export const I18nProvider: React.FC<I18nProviderProps> = ({
  initialLocale,
  onLocaleChange,
  children,
}) => {
  const [locale, setLocaleState] = useState<SupportedLocale>(
    () => initialLocale ?? getInitialLocale(),
  );

  const setLocale = useCallback(
    (newLocale: SupportedLocale) => {
      setLocaleState(newLocale);
      localStorage.setItem(LOCALE_STORAGE_KEY, newLocale);
      document.documentElement.lang = newLocale;
      onLocaleChange?.(newLocale);
    },
    [onLocaleChange],
  );

  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  useEffect(
    () => () => {
      activeLocale = DEFAULT_LOCALE;
    },
    [],
  );

  const value = useMemo<I18nContextValue>(() => {
    activeLocale = locale;
    const dictionary = DICTIONARIES[locale];
    const fallbackDictionary = DICTIONARIES[DEFAULT_LOCALE];

    const t = (key: TranslationKey, params?: Record<string, string | number>): string => {
      const message =
        resolvePath(dictionary as unknown as Record<string, unknown>, key) ||
        resolvePath(fallbackDictionary as unknown as Record<string, unknown>, key) ||
        '';
      return formatMessage(message, params);
    };

    const formatDate = (
      date: Date | string | number,
      options?: Intl.DateTimeFormatOptions,
    ): string => {
      const d = date instanceof Date ? date : new Date(date);
      return new Intl.DateTimeFormat(locale, options).format(d);
    };

    const formatNumber = (value: number, options?: Intl.NumberFormatOptions): string => {
      return new Intl.NumberFormat(locale, options).format(value);
    };

    return {
      locale,
      setLocale,
      messages: dictionary,
      t,
      formatDate,
      formatNumber,
    };
  }, [locale, setLocale]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
};

const defaultI18nValue: I18nContextValue = {
  locale: 'pt-BR',
  setLocale: () => {},
  messages: ptBR,
  t: (key: TranslationKey, params?: Record<string, string | number>): string =>
    formatMessage(resolvePath(ptBR as unknown as Record<string, unknown>, key) ?? '', params),
  formatDate: (date: Date | string | number, options?: Intl.DateTimeFormatOptions): string => {
    const d = date instanceof Date ? date : new Date(date);
    return new Intl.DateTimeFormat('pt-BR', options).format(d);
  },
  formatNumber: (value: number, options?: Intl.NumberFormatOptions): string => {
    return new Intl.NumberFormat('pt-BR', options).format(value);
  },
};

export function useI18n(): I18nContextValue {
  const context = useContext(I18nContext);
  return context ?? defaultI18nValue;
}
