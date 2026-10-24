// Completing a JSON value with a mock: `"name": "|` offers `$randomFullName` first, because the key
// says what the value is. Pure functions over the text; CodeEditor opens the list and applies them.

import type { VariableSuggestion } from '../variables-context.js';
import type { Edit } from './code-editing.js';
import { BARE_MOCKS, insideJsonString } from './mock-templates.js';

/** An opening quote of a JSON value, typed after `:` or `[`, with what was typed after it. */
export interface ValueQuote {
  /** Offset of the quote. */
  readonly quote: number;
  /** The word typed since the quote: `em` in `"email": "em|`. */
  readonly query: string;
  /** The key of the value (`email`), when the value belongs to one. */
  readonly key: string | null;
}

/** The text of the line before `caret`. */
function lineBefore(value: string, caret: number): { text: string; start: number } {
  const start = caret <= 0 ? 0 : value.lastIndexOf('\n', caret - 1) + 1;
  return { text: value.slice(start, caret), start };
}

/**
 * The key whose value is being written: `"email": |`, `"email": "|`, `"email": "em|` or a longer
 * text inside the string (`"name": "Dr. |`). After a finished value (`"a": 1, |`) there is none.
 */
export function keyBefore(value: string, caret: number): string | null {
  const { text } = lineBefore(value, caret);
  return /"([^"\\]+)"\s*:\s*(?:"[^"]*|[\w.$-]*)$/.exec(text)?.[1] ?? null;
}

/**
 * The value string being opened at `caret`: `"name": "|`, `["|` or `"name": "na|`. Keys do not
 * count (`{"na|`), nor a closing quote, nor a string that already has other characters in it.
 */
export function valueQuote(value: string, caret: number): ValueQuote | null {
  const { text, start } = lineBefore(value, caret);
  const match = /[:[]\s*"([\w.$-]*)$/.exec(text);
  if (!match) return null;
  const quote = start + match.index + match[0].length - match[1]!.length - 1;
  // The `:` or `[` has to be outside a string, and the quote has to open one.
  if (insideJsonString(value, quote)) return null;
  return { quote, query: match[1]!, key: keyBefore(value, caret) };
}

/** What each common key (in English or Portuguese) is best filled with. */
const PREFERRED: Record<string, string> = {
  name: '$randomFullName',
  nome: '$randomFullName',
  fullname: '$randomFullName',
  nomecompleto: '$randomFullName',
  firstname: '$randomFirstName',
  primeironome: '$randomFirstName',
  lastname: '$randomLastName',
  sobrenome: '$randomLastName',
  email: '$randomEmail',
  mail: '$randomEmail',
  phone: '$randomPhoneNumber',
  telefone: '$randomPhoneNumber',
  celular: '$randomPhoneNumber',
  mobile: '$randomPhoneNumber',
  username: '$randomUserName',
  login: '$randomUserName',
  user: '$randomUserName',
  usuario: '$randomUserName',
  password: '$randomPassword',
  senha: '$randomPassword',
  address: '$randomStreetAddress',
  endereco: '$randomStreetAddress',
  street: '$randomStreetName',
  rua: '$randomStreetName',
  logradouro: '$randomStreetName',
  city: '$randomCity',
  cidade: '$randomCity',
  state: '$randomState',
  estado: '$randomState',
  uf: '$randomState',
  zip: '$randomCEP',
  zipcode: '$randomCEP',
  postalcode: '$randomCEP',
  cep: '$randomCEP',
  country: '$randomCountry',
  pais: '$randomCountry',
  company: '$randomCompanyName',
  empresa: '$randomCompanyName',
  razaosocial: '$randomCompanyName',
  cpf: '$randomCPF',
  cnpj: '$randomCNPJ',
  price: '$randomPrice',
  preco: '$randomPrice',
  amount: '$randomPrice',
  valor: '$randomPrice',
  total: '$randomPrice',
  age: '$randomAge',
  idade: '$randomAge',
  birthdate: '$randomDateBirth',
  birthday: '$randomDateBirth',
  nascimento: '$randomDateBirth',
  datanascimento: '$randomDateBirth',
  id: '$guid',
  uuid: '$guid',
  guid: '$guid',
  url: '$randomUrl',
  website: '$randomUrl',
  site: '$randomUrl',
  currency: '$randomCurrencyCode',
  moeda: '$randomCurrencyCode',
  createdat: '$isoTimestamp',
  updatedat: '$isoTimestamp',
  timestamp: '$isoTimestamp',
  ip: '$randomIP',
  description: '$randomLoremSentence',
  descricao: '$randomLoremSentence',
  title: '$randomLoremSentence',
  titulo: '$randomLoremSentence',
  active: '$randomBoolean',
  ativo: '$randomBoolean',
  quantity: '$randomInt',
  quantidade: '$randomInt',
};

const letters = (text: string) =>
  text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');

/** `$randomPhoneNumber` → `phonenumber`; `$guid` → `guid`. */
const bareName = (name: string) => letters(name.replace(/^\$random/i, '').replace(/^\$/, ''));

/**
 * The mocks that fit `query`, the ones that fit the `key` first: the one `PREFERRED` names, then
 * those whose name is the key (`userName`), then those sharing a word with it (`birthDate`).
 */
export function rankMocksForKey(
  items: readonly VariableSuggestion[],
  key: string | null,
  query: string,
): VariableSuggestion[] {
  const typed = query.toLowerCase();
  const mocks = items.filter(
    (item) => item.source === 'dynamic' && (!typed || item.name.toLowerCase().includes(typed)),
  );
  if (!key) return mocks.slice(0, 8);
  const normalized = letters(key);
  const preferred = PREFERRED[normalized];
  const words = new Set(
    key
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(Boolean),
  );
  const score = (item: VariableSuggestion) => {
    if (item.name === preferred) return 100;
    if (bareName(item.name) === normalized) return 50;
    const own = item.name
      .replace(/^\$random/i, '')
      .replace(/^\$/, '')
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .toLowerCase()
      .split(' ');
    return own.filter((word) => words.has(word)).length;
  };
  return mocks
    .map((item, index) => ({ item, index, score: score(item) }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map(({ item }) => item)
    .slice(0, 8);
}

/**
 * The edit that completes `"key": "que|` with `name`. A text mock keeps the string and closes it;
 * a number or boolean replaces the quote the user typed, since `"age": "34"` is not what they want.
 */
export function completeValue(
  value: string,
  opened: ValueQuote,
  caret: number,
  name: string,
): Edit {
  const variable = `{{${name}}}`;
  // A closing quote that is already there (`"|"`) is used, not repeated.
  const to = caret + (value[caret] === '"' ? 1 : 0);
  if (BARE_MOCKS.has(name)) {
    const end = opened.quote + variable.length;
    return { from: opened.quote, to, text: variable, selection: [end, end] };
  }
  const text = `${variable}"`;
  const end = opened.quote + 1 + text.length;
  return { from: opened.quote + 1, to, text, selection: [end, end] };
}
