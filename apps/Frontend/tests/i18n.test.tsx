import { render, screen, fireEvent, renderHook } from '@testing-library/react';
import { describe, expect, it, beforeEach, vi } from 'vitest';
import {
  I18nProvider,
  useI18n,
  getInitialLocale,
  LOCALE_STORAGE_KEY,
  DEFAULT_LOCALE,
  SUPPORTED_LOCALES,
  ptBR,
  enUS,
  type TranslationKey,
} from '../src/lib/i18n/index.js';

describe('Frontend i18n subsystem', () => {
  const flatten = (value: unknown, prefix = ''): Record<string, string> => {
    if (typeof value === 'string') return { [prefix]: value };
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).flatMap(([key, child]) =>
        Object.entries(flatten(child, prefix ? `${prefix}.${key}` : key)),
      ),
    );
  };

  const placeholders = (message: string): string[] =>
    [...message.matchAll(/\{\{?([A-Za-z0-9_]+)\}?\}/g)]
      .map((match) => match[1])
      .filter((value): value is string => value !== undefined)
      .sort();

  beforeEach(() => {
    localStorage.clear();
    document.documentElement.lang = 'pt-BR';
  });

  it('exports default locale and supported locales list', () => {
    expect(DEFAULT_LOCALE).toBe('pt-BR');
    expect(SUPPORTED_LOCALES).toEqual(['pt-BR', 'en-US']);
    expect(ptBR.common.save).toBe('Salvar');
    expect(enUS.common.save).toBe('Save');
  });

  it('keeps locale keys and interpolation placeholders in parity', () => {
    const pt = flatten(ptBR);
    const en = flatten(enUS);

    expect(Object.keys(en).sort()).toEqual(Object.keys(pt).sort());
    for (const key of Object.keys(pt)) {
      expect(placeholders(en[key] ?? ''), key).toEqual(placeholders(pt[key] ?? ''));
    }
  });

  it('resolves initial locale from localStorage or browser settings', () => {
    const originalLanguage = navigator.language;
    try {
      Object.defineProperty(navigator, 'language', { value: 'pt-BR', configurable: true });
      expect(getInitialLocale()).toBe('pt-BR');

      localStorage.setItem(LOCALE_STORAGE_KEY, 'en-US');
      expect(getInitialLocale()).toBe('en-US');

      localStorage.setItem(LOCALE_STORAGE_KEY, 'invalid');
      expect(getInitialLocale()).toBe('pt-BR');

      localStorage.removeItem(LOCALE_STORAGE_KEY);
      Object.defineProperty(navigator, 'language', { value: 'en-US', configurable: true });
      expect(getInitialLocale()).toBe('en-US');

      Object.defineProperty(navigator, 'language', { value: '', configurable: true });
      expect(getInitialLocale()).toBe('pt-BR');

      Object.defineProperty(navigator, 'language', { value: undefined, configurable: true });
      expect(getInitialLocale()).toBe('pt-BR');
    } finally {
      Object.defineProperty(navigator, 'language', { value: originalLanguage, configurable: true });
    }
  });

  it('provides fallback values when useI18n is used outside I18nProvider', () => {
    const { result } = renderHook(() => useI18n());
    expect(result.current.locale).toBe('pt-BR');
    expect(result.current.t('common.save')).toBe('Salvar');
    expect(result.current.t('missing.key' as TranslationKey)).toBe('');
    expect(result.current.t('common' as TranslationKey)).toBe('');
    expect(result.current.formatNumber(100)).toBe('100');
    expect(result.current.formatDate(new Date('2026-09-14T12:00:00Z'))).toContain('2026');
    expect(result.current.formatDate('2026-09-14T12:00:00Z')).toContain('2026');

    // Calling setLocale on fallback shouldn't throw
    expect(() => result.current.setLocale('en-US')).not.toThrow();
  });

  it('translates strings and replaces template parameters', () => {
    function Consumer() {
      const { t, locale, setLocale, formatDate, formatNumber } = useI18n();
      return (
        <div>
          <span data-testid="current-locale">{locale}</span>
          <span data-testid="translated-save">{t('common.save')}</span>
          <span data-testid="missing-key">{t('non.existent.key' as TranslationKey)}</span>
          <span data-testid="object-key">{t('common' as TranslationKey)}</span>
          <span data-testid="formatted-date">
            {formatDate(new Date('2026-01-01T00:00:00Z'), { timeZone: 'UTC' })}
          </span>
          <span data-testid="formatted-date-str">
            {formatDate('2026-01-01T00:00:00Z', { timeZone: 'UTC' })}
          </span>
          <span data-testid="formatted-number">{formatNumber(1234.56)}</span>
          <button onClick={() => setLocale('en-US')} data-testid="switch-en">
            Switch EN
          </button>
        </div>
      );
    }

    const onLocaleChange = vi.fn();
    render(
      <I18nProvider initialLocale="pt-BR" onLocaleChange={onLocaleChange}>
        <Consumer />
      </I18nProvider>,
    );

    expect(screen.getByTestId('current-locale')).toHaveTextContent('pt-BR');
    expect(screen.getByTestId('translated-save')).toHaveTextContent('Salvar');
    expect(screen.getByTestId('missing-key').textContent).toBe('');

    // Switch to English
    fireEvent.click(screen.getByTestId('switch-en'));
    expect(screen.getByTestId('current-locale')).toHaveTextContent('en-US');
    expect(screen.getByTestId('translated-save')).toHaveTextContent('Save');
    expect(onLocaleChange).toHaveBeenCalledWith('en-US');
    expect(localStorage.getItem(LOCALE_STORAGE_KEY)).toBe('en-US');
    expect(document.documentElement.lang).toBe('en-US');
  });

  it('supports parameterized translations in provider and standalone', () => {
    const { result } = renderHook(() => useI18n(), {
      wrapper: ({ children }) => <I18nProvider initialLocale="pt-BR">{children}</I18nProvider>,
    });

    expect(result.current.t('common.details', { name: 'Ana' })).toBe('Detalhes');

    const { result: standalone } = renderHook(() => useI18n());
    expect(standalone.current.t('common.details', { name: 'Ana' })).toBe('Detalhes');
  });
});
