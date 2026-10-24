// Mock values for requests: `{{$randomFullName}}`, `{{$randomEmail}}`, `{{$randomCPF}}`...
// Names follow Postman's where it has one, so imported collections keep working. The data is
// Brazilian Portuguese (people, streets, cities, phone numbers, CPF and CNPJ with valid check
// digits); emails and URLs use the reserved example.* domains, so a test never reaches a real one.
// Plain functions of Math.random: the server, `devkit runner` (a copy of this file) and the k6 export
// draw from the same catalog.

export type DynamicGroup =
  | 'ids'
  | 'person'
  | 'address'
  | 'contact'
  | 'company'
  | 'finance'
  | 'numbers'
  | 'dates'
  | 'internet'
  | 'text'
  | 'documents';

/** The order the groups are shown in. */
export const DYNAMIC_GROUPS: readonly DynamicGroup[] = [
  'ids',
  'person',
  'address',
  'contact',
  'company',
  'finance',
  'numbers',
  'dates',
  'internet',
  'text',
  'documents',
];

export interface DynamicValueInfo {
  readonly name: string;
  readonly group: DynamicGroup;
  /** A value just generated, to show what the helper looks like. */
  readonly sample: string;
}

const pick = <T>(list: readonly T[]): T => list[Math.floor(Math.random() * list.length)]!;
const int = (min: number, max: number) => min + Math.floor(Math.random() * (max - min + 1));
const digits = (count: number) => Array.from({ length: count }, () => int(0, 9)).join('');
const pad = (value: number) => String(value).padStart(2, '0');
const slug = (text: string, separator = '.') =>
  text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, separator)
    .replace(new RegExp(`^\\${separator}+|\\${separator}+$`, 'g'), '');
const hex = (count: number) =>
  Array.from({ length: count }, () => int(0, 15).toString(16)).join('');
const DAY = 24 * 60 * 60 * 1000;

const FIRST_NAMES = [
  'Ana',
  'Beatriz',
  'Bruno',
  'Camila',
  'Carlos',
  'Daniel',
  'Eduarda',
  'Felipe',
  'Fernanda',
  'Gabriel',
  'Helena',
  'Isabela',
  'João',
  'Juliana',
  'Larissa',
  'Lucas',
  'Mariana',
  'Mateus',
  'Paulo',
  'Rafael',
  'Renata',
  'Sofia',
  'Thiago',
  'Vitória',
];
const LAST_NAMES = [
  'Almeida',
  'Barbosa',
  'Cardoso',
  'Carvalho',
  'Costa',
  'Dias',
  'Ferreira',
  'Gomes',
  'Lima',
  'Martins',
  'Melo',
  'Moreira',
  'Oliveira',
  'Pereira',
  'Ribeiro',
  'Rocha',
  'Santos',
  'Silva',
  'Souza',
  'Teixeira',
];
const JOB_TITLES = [
  'Analista de Sistemas',
  'Desenvolvedor',
  'Gerente de Projetos',
  'Analista de QA',
  'Designer de Produto',
  'Engenheiro de Dados',
  'Coordenador de Vendas',
  'Contador',
  'Arquiteto de Software',
  'Analista Financeiro',
];
const STREETS = [
  'Rua das Flores',
  'Avenida Paulista',
  'Rua Augusta',
  'Avenida Brasil',
  'Rua XV de Novembro',
  'Rua da Liberdade',
  'Avenida Atlântica',
  'Rua Sete de Setembro',
  'Alameda Santos',
  'Rua dos Andradas',
  'Avenida Getúlio Vargas',
  'Rua Voluntários da Pátria',
];
const CITIES = [
  'São Paulo',
  'Rio de Janeiro',
  'Belo Horizonte',
  'Curitiba',
  'Porto Alegre',
  'Salvador',
  'Recife',
  'Fortaleza',
  'Brasília',
  'Florianópolis',
  'Goiânia',
  'Manaus',
];
const STATES = ['SP', 'RJ', 'MG', 'PR', 'RS', 'BA', 'PE', 'CE', 'DF', 'SC', 'GO', 'AM'];
const COUNTRIES = [
  'Brasil',
  'Argentina',
  'Chile',
  'Portugal',
  'Estados Unidos',
  'Canadá',
  'Alemanha',
  'Japão',
];
const COUNTRY_CODES = ['BR', 'AR', 'CL', 'PT', 'US', 'CA', 'DE', 'JP'];
const AREA_CODES = [11, 21, 31, 41, 48, 51, 61, 71, 81, 85];
const COMPANY_NAMES = [
  'Alfa',
  'Beta',
  'Delta',
  'Ômega',
  'Horizonte',
  'Nova Era',
  'Vale Verde',
  'Cerrado',
  'Atlântica',
  'Pioneira',
  'Estrela',
  'Rede',
];
const COMPANY_SECTORS = [
  'Tecnologia',
  'Logística',
  'Comércio',
  'Serviços',
  'Consultoria',
  'Alimentos',
  'Engenharia',
  'Saúde',
];
const COMPANY_SUFFIXES = ['Ltda', 'S.A.', 'ME', 'EIRELI'];
const CATCH_PHRASES = [
  'Soluções simples para problemas reais',
  'Qualidade que você percebe',
  'Tecnologia a serviço de pessoas',
  'Entrega rápida, resultado garantido',
  'Inovação em cada detalhe',
];
const PRODUCTS = [
  'Camiseta',
  'Tênis',
  'Mochila',
  'Fone de ouvido',
  'Cadeira',
  'Garrafa térmica',
  'Teclado',
  'Caneca',
];
const PRODUCT_LINES = ['Premium', 'Pro', 'Plus', 'Eco', 'Max', 'Classic'];
const CURRENCIES = ['BRL', 'USD', 'EUR', 'GBP', 'ARS', 'CLP'];
const WORDS = [
  'casa',
  'tempo',
  'pessoa',
  'caminho',
  'projeto',
  'cliente',
  'sistema',
  'empresa',
  'mercado',
  'serviço',
  'produto',
  'valor',
  'prazo',
  'equipe',
  'resultado',
  'processo',
  'qualidade',
  'pedido',
];
const COLORS = ['azul', 'verde', 'vermelho', 'amarelo', 'preto', 'branco', 'roxo', 'laranja'];
const MONTHS = [
  'janeiro',
  'fevereiro',
  'março',
  'abril',
  'maio',
  'junho',
  'julho',
  'agosto',
  'setembro',
  'outubro',
  'novembro',
  'dezembro',
];
const WEEKDAYS = [
  'segunda-feira',
  'terça-feira',
  'quarta-feira',
  'quinta-feira',
  'sexta-feira',
  'sábado',
  'domingo',
];
const FILE_EXTENSIONS = ['pdf', 'png', 'jpg', 'csv', 'json', 'txt', 'xlsx', 'docx'];
const MIME_TYPES = [
  'application/pdf',
  'image/png',
  'image/jpeg',
  'text/csv',
  'application/json',
  'text/plain',
];
const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
  'Mozilla/5.0 (X11; Linux x86_64; rv:127.0) Gecko/20100101 Firefox/127.0',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
];
const PASSWORD_CHARS = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789!@#$%&*';

const firstName = () => pick(FIRST_NAMES);
const lastName = () => pick(LAST_NAMES);
const word = () => pick(WORDS);
const sentence = () => {
  const words = Array.from({ length: int(5, 9) }, word);
  return `${words[0]![0]!.toUpperCase()}${words[0]!.slice(1)} ${words.slice(1).join(' ')}.`;
};
const pastDate = (maxDays: number) => new Date(Date.now() - Math.random() * maxDays * DAY);
const futureDate = (maxDays: number) => new Date(Date.now() + Math.random() * maxDays * DAY);

/** Check digit of a CPF or CNPJ: weights run over the digits so far. */
const checkDigit = (numbers: readonly number[], weights: readonly number[]) => {
  const rest = numbers.reduce((sum, value, index) => sum + value * weights[index]!, 0) % 11;
  return rest < 2 ? 0 : 11 - rest;
};

function cpf(): string {
  let base: number[];
  do {
    base = Array.from({ length: 9 }, () => int(0, 9));
  } while (base.every((value) => value === base[0])); // 111.111.111-11 is not a valid CPF
  base.push(checkDigit(base, [10, 9, 8, 7, 6, 5, 4, 3, 2]));
  base.push(checkDigit(base, [11, 10, 9, 8, 7, 6, 5, 4, 3, 2]));
  const text = base.join('');
  return `${text.slice(0, 3)}.${text.slice(3, 6)}.${text.slice(6, 9)}-${text.slice(9)}`;
}

function cnpj(): string {
  const base = [...Array.from({ length: 8 }, () => int(0, 9)), 0, 0, 0, 1];
  base.push(checkDigit(base, [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]));
  base.push(checkDigit(base, [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]));
  const text = base.join('');
  return `${text.slice(0, 2)}.${text.slice(2, 5)}.${text.slice(5, 8)}/${text.slice(8, 12)}-${text.slice(12)}`;
}

interface DynamicValue {
  readonly name: string;
  readonly group: DynamicGroup;
  readonly generate: () => string;
}

const entry = (name: string, group: DynamicGroup, generate: () => string): DynamicValue => ({
  name,
  group,
  generate,
});

const uuid = () => crypto.randomUUID();
const email = (domain: string) => `${slug(firstName())}.${slug(lastName())}${int(1, 99)}@${domain}`;

const CATALOG: readonly DynamicValue[] = [
  // Identifiers
  entry('$guid', 'ids', uuid),
  entry('$randomUUID', 'ids', uuid),
  entry('$randomAlphaNumeric', 'ids', () => pick([...'abcdefghijklmnopqrstuvwxyz0123456789'])),

  // People
  entry('$randomFirstName', 'person', firstName),
  entry('$randomLastName', 'person', lastName),
  entry('$randomFullName', 'person', () => `${firstName()} ${lastName()}`),
  entry('$randomNamePrefix', 'person', () => pick(['Sr.', 'Sra.', 'Dr.', 'Dra.'])),
  entry('$randomNameSuffix', 'person', () => pick(['Jr.', 'Filho', 'Neto', 'Sobrinho'])),
  entry('$randomJobTitle', 'person', () => pick(JOB_TITLES)),

  // Addresses
  entry('$randomStreetName', 'address', () => pick(STREETS)),
  entry('$randomStreetAddress', 'address', () => `${pick(STREETS)}, ${int(1, 2999)}`),
  entry('$randomCity', 'address', () => pick(CITIES)),
  entry('$randomState', 'address', () => pick(STATES)),
  entry('$randomCEP', 'address', () => `${digits(5)}-${digits(3)}`),
  entry('$randomCountry', 'address', () => pick(COUNTRIES)),
  entry('$randomCountryCode', 'address', () => pick(COUNTRY_CODES)),
  entry('$randomLatitude', 'address', () => (Math.random() * 180 - 90).toFixed(6)),
  entry('$randomLongitude', 'address', () => (Math.random() * 360 - 180).toFixed(6)),

  // Contact
  entry('$randomEmail', 'contact', () =>
    email(pick(['example.com', 'example.org', 'example.net'])),
  ),
  entry('$randomExampleEmail', 'contact', () => email('example.com')),
  entry('$randomUserName', 'contact', () => `${slug(firstName(), '_')}_${int(10, 999)}`),
  entry('$randomPhoneNumber', 'contact', () => `(${pick(AREA_CODES)}) 9${digits(4)}-${digits(4)}`),
  entry('$randomPassword', 'contact', () =>
    Array.from({ length: 12 }, () => pick([...PASSWORD_CHARS])).join(''),
  ),

  // Companies and products
  entry(
    '$randomCompanyName',
    'company',
    () => `${pick(COMPANY_NAMES)} ${pick(COMPANY_SECTORS)} ${pick(COMPANY_SUFFIXES)}`,
  ),
  entry('$randomCompanySuffix', 'company', () => pick(COMPANY_SUFFIXES)),
  entry('$randomCatchPhrase', 'company', () => pick(CATCH_PHRASES)),
  entry('$randomProductName', 'company', () => `${pick(PRODUCTS)} ${pick(PRODUCT_LINES)}`),

  // Finance
  entry('$randomPrice', 'finance', () => (Math.random() * 990 + 10).toFixed(2)),
  entry('$randomCurrencyCode', 'finance', () => pick(CURRENCIES)),
  entry('$randomBankAccount', 'finance', () => digits(8)),
  entry('$randomBankAgency', 'finance', () => digits(4)),

  // Numbers
  entry('$randomInt', 'numbers', () => String(int(0, 999))),
  entry('$randomFloat', 'numbers', () => (Math.random() * 1000).toFixed(2)),
  entry('$randomAge', 'numbers', () => String(int(18, 80))),
  entry('$randomBoolean', 'numbers', () => String(Math.random() < 0.5)),

  // Dates
  entry('$timestamp', 'dates', () => String(Math.floor(Date.now() / 1000))),
  entry('$isoTimestamp', 'dates', () => new Date().toISOString()),
  entry('$randomDatePast', 'dates', () => pastDate(365).toISOString()),
  entry('$randomDateFuture', 'dates', () => futureDate(365).toISOString()),
  entry('$randomDateRecent', 'dates', () => pastDate(7).toISOString()),
  entry('$randomDateBirth', 'dates', () => {
    const year = new Date().getFullYear() - int(18, 80);
    return `${year}-${pad(int(1, 12))}-${pad(int(1, 28))}`;
  }),
  entry('$randomMonth', 'dates', () => pick(MONTHS)),
  entry('$randomWeekday', 'dates', () => pick(WEEKDAYS)),

  // Internet
  entry('$randomUrl', 'internet', () => `https://${slug(word())}.example.com/${slug(word())}`),
  entry('$randomDomainName', 'internet', () => `${slug(word())}.example.com`),
  entry('$randomImageUrl', 'internet', () => `https://example.com/images/${int(1, 999)}.jpg`),
  entry('$randomIP', 'internet', () => Array.from({ length: 4 }, () => int(1, 254)).join('.')),
  entry('$randomIPV6', 'internet', () => Array.from({ length: 8 }, () => hex(4)).join(':')),
  entry('$randomMACAddress', 'internet', () => Array.from({ length: 6 }, () => hex(2)).join(':')),
  entry('$randomUserAgent', 'internet', () => pick(USER_AGENTS)),
  entry('$randomProtocol', 'internet', () => pick(['http', 'https'])),
  entry('$randomSemver', 'internet', () => `${int(0, 9)}.${int(0, 20)}.${int(0, 50)}`),

  // Text and files
  entry('$randomWord', 'text', word),
  entry('$randomWords', 'text', () => Array.from({ length: 3 }, word).join(' ')),
  entry('$randomLoremSentence', 'text', sentence),
  entry('$randomLoremParagraph', 'text', () => Array.from({ length: 3 }, sentence).join(' ')),
  entry('$randomColor', 'text', () => pick(COLORS)),
  entry('$randomHexColor', 'text', () => `#${hex(6)}`),
  entry('$randomFileName', 'text', () => `${slug(word())}.${pick(FILE_EXTENSIONS)}`),
  entry('$randomFileExt', 'text', () => pick(FILE_EXTENSIONS)),
  entry('$randomMimeType', 'text', () => pick(MIME_TYPES)),

  // Brazilian documents
  entry('$randomCPF', 'documents', cpf),
  entry('$randomCNPJ', 'documents', cnpj),
];

const BY_NAME = new Map(CATALOG.map((value) => [value.name, value]));

/** Every helper name, e.g. `$randomFullName`. */
export const DYNAMIC_VALUE_NAMES: readonly string[] = CATALOG.map((value) => value.name);

/** A new value of the helper, or undefined when `name` is not one (`{{baseUrl}}`, `{{$nope}}`). */
export function resolveDynamicValue(name: string): string | undefined {
  return BY_NAME.get(name)?.generate();
}

/** The helpers with a fresh sample each, in the order they are shown. */
export function listDynamicValues(): DynamicValueInfo[] {
  return CATALOG.map(({ name, group, generate }) => ({ name, group, sample: generate() }));
}
