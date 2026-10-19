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

  const value = useMemo<I18nContextValue>(() => {
    const dictionary = DICTIONARIES[locale];
    const fallbackDictionary = DICTIONARIES[DEFAULT_LOCALE];

    const t = (key: TranslationKey, params?: Record<string, string | number>): string => {
      let message = resolvePath(dictionary as unknown as Record<string, unknown>, key);
      if (!message) {
        message = resolvePath(fallbackDictionary as unknown as Record<string, unknown>, key) ?? '';
      }

      if (params) {
        for (const [k, v] of Object.entries(params)) {
          message = message.replace(new RegExp(`\\{\\{${k}\\}\\}|\\{${k}\\}`, 'g'), String(v));
        }
      }

      return message;
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
  t: (key: TranslationKey, params?: Record<string, string | number>): string => {
    let message = resolvePath(ptBR as unknown as Record<string, unknown>, key) ?? '';
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        message = message.replace(new RegExp(`\\{\\{${k}\\}\\}|\\{${k}\\}`, 'g'), String(v));
      }
    }
    return message;
  },
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
