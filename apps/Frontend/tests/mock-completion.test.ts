import { describe, expect, it } from 'vitest';
import { applyEdit } from '../src/features/apitests/integration/code-editing.js';
import {
  completeValue,
  keyBefore,
  rankMocksForKey,
  valueQuote,
} from '../src/features/apitests/integration/mock-completion.js';
import type { VariableSuggestion } from '../src/features/apitests/variables-context.js';

const NAMES = [
  '$guid',
  '$randomFirstName',
  '$randomLastName',
  '$randomFullName',
  '$randomJobTitle',
  '$randomStreetAddress',
  '$randomCity',
  '$randomCEP',
  '$randomEmail',
  '$randomPhoneNumber',
  '$randomUserName',
  '$randomPassword',
  '$randomCompanyName',
  '$randomPrice',
  '$randomAge',
  '$randomBoolean',
  '$randomDateBirth',
  '$randomCPF',
  '$randomCNPJ',
  '$isoTimestamp',
  '$randomLoremSentence',
];
const ITEMS: VariableSuggestion[] = [
  { name: 'baseUrl', source: 'collection', value: 'https://api.test' },
  { name: 'token', source: 'capture' },
  ...NAMES.map((name) => ({ name, source: 'dynamic' as const, value: 'sample' })),
];
const names = (list: readonly VariableSuggestion[]) => list.map((item) => item.name);

describe('valueQuote', () => {
  it('finds the opening quote of a value, with the key and what was typed after it', () => {
    const text = '{\n  "name": "';
    expect(valueQuote(text, text.length)).toEqual({
      quote: text.length - 1,
      query: '',
      key: 'name',
    });
    const typed = '{\n  "email": "em';
    expect(valueQuote(typed, typed.length)).toEqual({
      quote: typed.length - 3,
      query: 'em',
      key: 'email',
    });
  });

  it('works without spaces, in arrays (no key) and on the first line', () => {
    expect(valueQuote('{"a":"', 6)).toEqual({ quote: 5, query: '', key: 'a' });
    expect(valueQuote('{"tags": ["', 11)).toEqual({ quote: 10, query: '', key: null });
    expect(valueQuote('["', 2)).toEqual({ quote: 1, query: '', key: null });
  });

  it('does not take keys, closed strings or text with spaces for a value being opened', () => {
    expect(valueQuote('{"na', 4)).toBeNull();
    expect(valueQuote('{"a": 1, "b', 11)).toBeNull();
    expect(valueQuote('{"a": "x"', 9)).toBeNull();
    expect(valueQuote('{"a": "two words', 16)).toBeNull();
    expect(valueQuote('{"a": ', 6)).toBeNull();
    expect(valueQuote('', 0)).toBeNull();
  });

  it('only looks at the line of the caret', () => {
    const text = '{\n  "a": "x",\n  "b": "';
    expect(valueQuote(text, text.length)).toMatchObject({ key: 'b', query: '' });
    expect(valueQuote('"a": \n"', 7)).toBeNull();
  });

  it('is not fooled by a colon inside a string', () => {
    // The `: "` here is text of a string, and the quote after it closes that string.
    expect(valueQuote('{"a": "x: "', 11)).toBeNull();
  });
});

describe('keyBefore', () => {
  it('names the key whose value is being written', () => {
    expect(keyBefore('{"email": ', 10)).toBe('email');
    expect(keyBefore('{"email": "', 11)).toBe('email');
    expect(keyBefore('{"email": "ab', 13)).toBe('email');
    expect(keyBefore('{\n  "birth_date":', 17)).toBe('birth_date');
  });

  it('keeps the key while text with spaces is typed inside the string', () => {
    expect(keyBefore('{"name": "Dr. ', 14)).toBe('name');
    expect(keyBefore('{"bio": "Rua das Flores, 12', 27)).toBe('bio');
  });

  it('has no key after a finished value, or outside a value', () => {
    expect(keyBefore('{"a": 1, ', 9)).toBeNull();
    expect(keyBefore('{"a": "x", ', 11)).toBeNull();
    expect(keyBefore('{"a": "x", "b', 13)).toBeNull();
    expect(keyBefore('{', 1)).toBeNull();
    expect(keyBefore('{"a": 1,\n  ', 11)).toBeNull();
    expect(keyBefore('["', 2)).toBeNull();
  });
});

describe('rankMocksForKey', () => {
  const first = (key: string | null, query = '') => names(rankMocksForKey(ITEMS, key, query))[0];

  it('puts the mock that fits the key first, in English and Portuguese', () => {
    expect(first('name')).toBe('$randomFullName');
    expect(first('nome')).toBe('$randomFullName');
    expect(first('firstName')).toBe('$randomFirstName');
    expect(first('email')).toBe('$randomEmail');
    expect(first('E-mail')).toBe('$randomEmail');
    expect(first('telefone')).toBe('$randomPhoneNumber');
    expect(first('cpf')).toBe('$randomCPF');
    expect(first('cnpj')).toBe('$randomCNPJ');
    expect(first('zipCode')).toBe('$randomCEP');
    expect(first('city')).toBe('$randomCity');
    expect(first('senha')).toBe('$randomPassword');
    expect(first('userName')).toBe('$randomUserName');
    expect(first('birthDate')).toBe('$randomDateBirth');
    expect(first('data_nascimento')).toBe('$randomDateBirth');
    expect(first('age')).toBe('$randomAge');
    expect(first('id')).toBe('$guid');
    expect(first('createdAt')).toBe('$isoTimestamp');
    expect(first('Descrição')).toBe('$randomLoremSentence');
  });

  it('matches a key made of the words of a mock, even one that is not in the table', () => {
    expect(first('phoneNumber')).toBe('$randomPhoneNumber');
    expect(first('company_name')).toBe('$randomCompanyName');
    expect(first('jobTitle')).toBe('$randomJobTitle');
    expect(first('streetAddress')).toBe('$randomStreetAddress');
  });

  it('keeps the catalog order when nothing fits, and without a key', () => {
    expect(first('zzz')).toBe('$guid');
    expect(first(null)).toBe('$guid');
  });

  it('keeps the other mocks after the best one, and never lists plain variables', () => {
    const list = names(rankMocksForKey(ITEMS, 'name', ''));
    expect(list[0]).toBe('$randomFullName');
    expect(list.length).toBeGreaterThan(3);
    expect(list).not.toContain('baseUrl');
    expect(list).not.toContain('token');
    expect(new Set(list).size).toBe(list.length);
    expect(list.length).toBeLessThanOrEqual(8);
  });

  it('filters by what was typed after the quote', () => {
    const typed = names(rankMocksForKey(ITEMS, 'email', 'em'));
    expect(typed).toEqual(['$randomEmail', '$randomLoremSentence']);
    expect(names(rankMocksForKey(ITEMS, 'name', 'mail'))).toEqual(['$randomEmail']);
    expect(names(rankMocksForKey(ITEMS, 'email', 'CPF'))).toEqual(['$randomCPF']);
    expect(rankMocksForKey(ITEMS, 'name', 'zzzz')).toEqual([]);
    // The best match for the key still leads inside the filtered list.
    expect(first('name', 'name')).toBe('$randomFullName');
  });
});

describe('completeValue', () => {
  const complete = (text: string, name: string, caret = text.length) => {
    const opened = valueQuote(text, caret)!;
    const edit = completeValue(text, opened, caret, name);
    return `${applyEdit(text, edit).slice(0, edit.selection[0])}¦${applyEdit(text, edit).slice(edit.selection[0])}`;
  };

  it('fills a text value and closes the string', () => {
    expect(complete('{"name": "', '$randomFullName')).toBe('{"name": "{{$randomFullName}}"¦');
    expect(complete('{\n  "e": "em', '$randomEmail')).toBe('{\n  "e": "{{$randomEmail}}"¦');
  });

  it('uses a closing quote that is already there', () => {
    expect(complete('{"name": ""}', '$randomFullName', 10)).toBe(
      '{"name": "{{$randomFullName}}"¦}',
    );
  });

  it('replaces the quote of a number or boolean, which are not strings', () => {
    expect(complete('{"age": "', '$randomAge')).toBe('{"age": {{$randomAge}}¦');
    expect(complete('{"age": ""}', '$randomAge', 9)).toBe('{"age": {{$randomAge}}¦}');
    expect(complete('{"ok": "', '$randomBoolean')).toBe('{"ok": {{$randomBoolean}}¦');
  });

  it('keeps what follows on the line', () => {
    expect(complete('{"a": "x", "b": 1}', '$randomEmail', 8)).toBe(
      '{"a": "{{$randomEmail}}"¦, "b": 1}',
    );
  });
});
