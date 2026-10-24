// Bodies the Mocks menu inserts. Every `{{$name}}` is a mock value the engine fills on each send
// (apps/Backend/src/modules/apitests/engine/dynamic-values.ts); numbers are written without quotes.

export type MockTemplateId = 'customer' | 'address' | 'company' | 'order' | 'user';

export interface MockTemplate {
  readonly id: MockTemplateId;
  readonly body: string;
}

export const MOCK_TEMPLATES: readonly MockTemplate[] = [
  {
    id: 'customer',
    body: `{
  "name": "{{$randomFullName}}",
  "email": "{{$randomEmail}}",
  "cpf": "{{$randomCPF}}",
  "phone": "{{$randomPhoneNumber}}",
  "birthDate": "{{$randomDateBirth}}"
}`,
  },
  {
    id: 'address',
    body: `{
  "street": "{{$randomStreetName}}",
  "number": {{$randomInt}},
  "city": "{{$randomCity}}",
  "state": "{{$randomState}}",
  "zipCode": "{{$randomCEP}}",
  "country": "{{$randomCountry}}"
}`,
  },
  {
    id: 'company',
    body: `{
  "name": "{{$randomCompanyName}}",
  "cnpj": "{{$randomCNPJ}}",
  "email": "{{$randomExampleEmail}}",
  "phone": "{{$randomPhoneNumber}}",
  "website": "{{$randomUrl}}"
}`,
  },
  {
    id: 'order',
    body: `{
  "id": "{{$guid}}",
  "customer": {
    "name": "{{$randomFullName}}",
    "email": "{{$randomEmail}}"
  },
  "items": [
    {
      "sku": "SKU-{{$randomInt}}",
      "name": "{{$randomProductName}}",
      "quantity": 2,
      "unitPrice": {{$randomPrice}}
    }
  ],
  "currency": "{{$randomCurrencyCode}}",
  "createdAt": "{{$isoTimestamp}}"
}`,
  },
  {
    id: 'user',
    body: `{
  "username": "{{$randomUserName}}",
  "email": "{{$randomEmail}}",
  "password": "{{$randomPassword}}"
}`,
  },
];

/** Mock values that are numbers or booleans: in JSON they go without quotes. */
export const BARE_MOCKS: ReadonlySet<string> = new Set([
  '$randomInt',
  '$randomFloat',
  '$randomAge',
  '$randomBoolean',
  '$timestamp',
  '$randomPrice',
  '$randomLatitude',
  '$randomLongitude',
]);

/** True when `caret` is between the quotes of a JSON string (the line before it has an odd number of them). */
export function insideJsonString(value: string, caret: number): boolean {
  const lineStart = caret <= 0 ? 0 : value.lastIndexOf('\n', caret - 1) + 1;
  let open = false;
  for (let index = lineStart; index < caret; index += 1) {
    if (value[index] === '\\') index += 1;
    else if (value[index] === '"') open = !open;
  }
  return open;
}

/** What to insert for a mock value: `{{$randomEmail}}`, quoted in JSON where a string is expected. */
export function mockSnippet(name: string, language: 'json' | 'xml' | 'text', inString: boolean) {
  const variable = `{{${name}}}`;
  if (language !== 'json' || inString || BARE_MOCKS.has(name)) return variable;
  return `"${variable}"`;
}
