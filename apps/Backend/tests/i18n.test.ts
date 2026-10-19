import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LOCALE,
  SUPPORTED_LOCALES,
  resolveLocale,
  translateContent,
  translateErrorMessage,
} from '../src/shared/i18n.js';

describe('i18n shared module', () => {
  it('exports default locale and supported locales list', () => {
    expect(DEFAULT_LOCALE).toBe('pt-BR');
    expect(SUPPORTED_LOCALES).toEqual(['pt-BR', 'en-US']);
  });

  it('resolves null or empty inputs to default locale pt-BR', () => {
    expect(resolveLocale(null)).toBe('pt-BR');
    expect(resolveLocale(undefined)).toBe('pt-BR');
    expect(resolveLocale('')).toBe('pt-BR');
    expect(resolveLocale('   ')).toBe('pt-BR');
  });

  it('resolves exact matches case-insensitively', () => {
    expect(resolveLocale('pt-BR')).toBe('pt-BR');
    expect(resolveLocale('pt-br')).toBe('pt-BR');
    expect(resolveLocale('en-US')).toBe('en-US');
    expect(resolveLocale('en-us')).toBe('en-US');
  });

  it('resolves language prefixes', () => {
    expect(resolveLocale('pt')).toBe('pt-BR');
    expect(resolveLocale('pt-PT')).toBe('pt-BR');
    expect(resolveLocale('en')).toBe('en-US');
    expect(resolveLocale('en-GB')).toBe('en-US');
    expect(resolveLocale('en-CA')).toBe('en-US');
  });

  it('resolves complex Accept-Language headers', () => {
    expect(resolveLocale('en-US,en;q=0.9,pt;q=0.8')).toBe('en-US');
    expect(resolveLocale('pt-BR,pt;q=0.9,en-US;q=0.8')).toBe('pt-BR');
    expect(resolveLocale('fr-FR,fr;q=0.9,en;q=0.8')).toBe('en-US');
    expect(resolveLocale('fr-FR,de-DE')).toBe('pt-BR');
    expect(resolveLocale('en-US;q=0,pt-BR;q=0.5')).toBe('pt-BR');
    expect(resolveLocale('en-US;q=0.4,pt-BR;q=0.9')).toBe('pt-BR');
    expect(resolveLocale('unknown')).toBe('pt-BR');
  });

  it('translates known error codes into pt-BR', () => {
    expect(translateErrorMessage('UNAUTHORIZED', 'pt-BR')).toBe(
      'Credenciais inválidas ou ausentes.',
    );
    expect(translateErrorMessage('VALIDATION_ERROR', 'pt-BR')).toBe(
      'A requisição contém dados inválidos.',
    );
    expect(translateErrorMessage('INTERNAL_ERROR', 'pt-BR')).toBe('Ocorreu um erro inesperado.');
    expect(translateErrorMessage('SPEC_PARENT_NOT_FOUND', 'pt-BR')).toBe(
      'Especificação pai não encontrada.',
    );
    expect(translateErrorMessage('INVALID_SPEC_PARENT', 'pt-BR')).toBe(
      'A hierarquia de especificações é inválida.',
    );
  });

  it('translates known error codes into en-US', () => {
    expect(translateErrorMessage('UNAUTHORIZED', 'en-US')).toBe('Invalid or missing credentials.');
    expect(translateErrorMessage('VALIDATION_ERROR', 'en-US')).toBe(
      'The request contains invalid data.',
    );
    expect(translateErrorMessage('INTERNAL_ERROR', 'en-US')).toBe('An unexpected error occurred.');
    expect(translateErrorMessage('SPEC_PARENT_NOT_FOUND', 'en-US')).toBe(
      'Parent specification not found.',
    );
    expect(translateErrorMessage('INVALID_SPEC_PARENT', 'en-US')).toBe(
      'The specification hierarchy is invalid.',
    );
  });

  it('falls back to provided fallback message or code for unknown codes', () => {
    expect(translateErrorMessage('CUSTOM_CODE', 'pt-BR', 'Mensagem customizada')).toBe(
      'Mensagem customizada',
    );
    expect(translateErrorMessage('CUSTOM_CODE', 'en-US')).toBe('An error occurred.');
  });

  it('localizes generated and mock content with interpolation', () => {
    expect(translateContent('defaultTestPlanTitle', 'pt-BR')).toBe('Plano de Testes Gerado');
    expect(translateContent('defaultTestPlanTitle', 'en-US')).toBe('Generated Test Plan');
    expect(translateContent('fallbackAction', 'en-US', { subject: 'checkout' })).toBe(
      'Access and perform the checkout flow',
    );
    expect(translateContent('documentDeleted', 'pt-BR')).toBe('Documento excluído com sucesso.');
    expect(translateContent('documentDeleted', 'en-US')).toBe('Document deleted successfully.');
  });
});
