import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/adapters/http/app.js';
import { InMemoryApiTestStore } from '../src/modules/apitests/application/api-test-store.js';
import {
  DYNAMIC_GROUPS,
  DYNAMIC_VALUE_NAMES,
  listDynamicValues,
  resolveDynamicValue,
} from '../src/modules/apitests/engine/dynamic-values.js';
import { interpolate, scopeOf } from '../src/modules/apitests/engine/http-request.js';
import type { ApiItem } from '../src/modules/apitests/engine/types.js';
import { exportK6 } from '../src/modules/apitests/formats/k6.js';
import { InMemoryAuthRepository } from '../src/modules/identity/adapters/in-memory-auth-repository.js';
import { AuthService } from '../src/modules/identity/application/auth-service.js';
import { InMemoryWorkspaceRepository } from '../src/modules/workspaces/adapters/in-memory-workspace-repository.js';
import { WorkspaceService } from '../src/modules/workspaces/application/workspace-service.js';

afterEach(() => vi.restoreAllMocks());

const many = (name: string, count = 200) =>
  Array.from({ length: count }, () => resolveDynamicValue(name)!);

/** Independent check of the CPF/CNPJ rule, so the generator is not tested against itself. */
function validDocument(text: string, weights: readonly number[][]): boolean {
  const numbers = text.replace(/\D/g, '').split('').map(Number);
  return weights.every((list, index) => {
    const base = numbers.slice(0, list.length);
    const rest = base.reduce((sum, value, position) => sum + value * list[position]!, 0) % 11;
    return (
      numbers[list.length] === (rest < 2 ? 0 : 11 - rest) &&
      base.length === list.length &&
      index >= 0
    );
  });
}

describe('dynamic values catalog', () => {
  it('has unique $names in known groups, and every helper makes a value', () => {
    expect(new Set(DYNAMIC_VALUE_NAMES).size).toBe(DYNAMIC_VALUE_NAMES.length);
    expect(DYNAMIC_VALUE_NAMES.length).toBeGreaterThanOrEqual(50);
    const list = listDynamicValues();
    expect(list.map((item) => item.name)).toEqual(DYNAMIC_VALUE_NAMES);
    for (const item of list) {
      expect(item.name).toMatch(/^\$[A-Za-z0-9]+$/);
      expect(DYNAMIC_GROUPS).toContain(item.group);
      expect(item.sample.length).toBeGreaterThan(0);
    }
    // Every group has something to offer.
    for (const group of DYNAMIC_GROUPS)
      expect(list.some((item) => item.group === group)).toBe(true);
  });

  it('does not know names that are not helpers', () => {
    expect(resolveDynamicValue('baseUrl')).toBeUndefined();
    expect(resolveDynamicValue('$nope')).toBeUndefined();
    expect(resolveDynamicValue('randomFullName')).toBeUndefined();
  });

  it('makes people, contacts and addresses that look real', () => {
    for (const email of many('$randomEmail')) {
      expect(email).toMatch(/^[a-z]+\.[a-z]+\d{1,2}@example\.(com|org|net)$/);
    }
    for (const phone of many('$randomPhoneNumber')) {
      expect(phone).toMatch(/^\(\d{2}\) 9\d{4}-\d{4}$/);
    }
    for (const cep of many('$randomCEP')) expect(cep).toMatch(/^\d{5}-\d{3}$/);
    for (const name of many('$randomFullName')) expect(name).toMatch(/^\S+ \S+$/);
    for (const address of many('$randomStreetAddress')) expect(address).toMatch(/, \d{1,4}$/);
    for (const user of many('$randomUserName')) expect(user).toMatch(/^[a-z]+_\d{2,3}$/);
    for (const password of many('$randomPassword')) expect(password).toHaveLength(12);
    for (const state of many('$randomState')) expect(state).toMatch(/^[A-Z]{2}$/);
  });

  it('makes numbers, dates and ids in their formats', () => {
    for (const value of many('$randomAge')) {
      expect(Number(value)).toBeGreaterThanOrEqual(18);
      expect(Number(value)).toBeLessThanOrEqual(80);
    }
    for (const value of many('$randomPrice')) expect(value).toMatch(/^\d{2,3}\.\d{2}$/);
    for (const value of many('$randomBoolean')) expect(['true', 'false']).toContain(value);
    for (const value of many('$randomInt')) expect(value).toMatch(/^\d{1,3}$/);
    for (const value of many('$guid', 5)) expect(value).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4/);
    for (const value of many('$randomDateBirth')) {
      expect(value).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      const age = new Date().getFullYear() - Number(value.slice(0, 4));
      expect(age).toBeGreaterThanOrEqual(18);
      expect(age).toBeLessThanOrEqual(80);
    }
    const now = Date.now();
    for (const value of many('$randomDatePast', 50))
      expect(Date.parse(value)).toBeLessThanOrEqual(now);
    for (const value of many('$randomDateFuture', 50))
      expect(Date.parse(value)).toBeGreaterThanOrEqual(now);
    expect(resolveDynamicValue('$isoTimestamp')).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(resolveDynamicValue('$timestamp')).toMatch(/^\d{10}$/);
    for (const value of many('$randomIP', 20)) expect(value).toMatch(/^\d{1,3}(\.\d{1,3}){3}$/);
    for (const value of many('$randomMACAddress', 20)) {
      expect(value).toMatch(/^([0-9a-f]{2}:){5}[0-9a-f]{2}$/);
    }
    for (const value of many('$randomHexColor', 20)) expect(value).toMatch(/^#[0-9a-f]{6}$/);
  });

  it('makes CPF and CNPJ with valid check digits, formatted', () => {
    const cpfs = many('$randomCPF', 300);
    for (const value of cpfs) {
      expect(value).toMatch(/^\d{3}\.\d{3}\.\d{3}-\d{2}$/);
      expect(
        validDocument(value, [
          [10, 9, 8, 7, 6, 5, 4, 3, 2],
          [11, 10, 9, 8, 7, 6, 5, 4, 3, 2],
        ]),
      ).toBe(true);
      expect(new Set(value.replace(/\D/g, '')).size).toBeGreaterThan(1);
    }
    for (const value of many('$randomCNPJ', 300)) {
      expect(value).toMatch(/^\d{2}\.\d{3}\.\d{3}\/0001-\d{2}$/);
      expect(
        validDocument(value, [
          [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2],
          [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2],
        ]),
      ).toBe(true);
    }
    // A known CPF: 529.982.247-25 is valid.
    expect(
      validDocument('529.982.247-25', [
        [10, 9, 8, 7, 6, 5, 4, 3, 2],
        [11, 10, 9, 8, 7, 6, 5, 4, 3, 2],
      ]),
    ).toBe(true);
  });

  it('does not repeat itself', () => {
    expect(new Set(many('$randomFullName', 200)).size).toBeGreaterThan(50);
    expect(new Set(many('$randomCPF', 200)).size).toBeGreaterThan(190);
  });
});

describe('interpolate with mock values', () => {
  const scope = scopeOf([{ key: 'baseUrl', value: 'https://api.test' }]);

  it('puts a new value on every {{$helper}} and keeps variables and unknown names', () => {
    const text =
      '{"name":"{{$randomFullName}}","other":"{{ $randomFullName }}","cpf":"{{$randomCPF}}","url":"{{baseUrl}}","x":"{{$nope}}","y":"{{missing}}"}';
    const body = JSON.parse(interpolate(text, scope));
    expect(body.name).toMatch(/^\S+ \S+$/);
    expect(body.cpf).toMatch(/^\d{3}\.\d{3}\.\d{3}-\d{2}$/);
    expect(body.url).toBe('https://api.test');
    expect(body.x).toBe('{{$nope}}');
    expect(body.y).toBe('{{missing}}');
    const twice = interpolate('{{$guid}} {{$guid}}', scope).split(' ');
    expect(twice[0]).not.toBe(twice[1]);
  });

  it('keeps the helpers every collection already used', () => {
    const out = interpolate(
      '{{$guid}}|{{$randomUUID}}|{{$timestamp}}|{{$isoTimestamp}}|{{$randomInt}}',
      scope,
    );
    const [guid, uuid, timestamp, iso, int] = out.split('|');
    expect(guid).toMatch(/^[0-9a-f-]{36}$/);
    expect(uuid).toMatch(/^[0-9a-f-]{36}$/);
    expect(timestamp).toMatch(/^\d{10}$/);
    expect(iso).toMatch(/^\d{4}-/);
    expect(int).toMatch(/^\d+$/);
  });

  it('draws the value from Math.random, so a test can pin it', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    expect(interpolate('{{$randomFullName}}', scope)).toBe('Ana Almeida');
  });
});

describe('k6 export with mock values', () => {
  const requestItem = (body: string): ApiItem => ({
    id: 'create',
    type: 'request',
    name: 'Create customer',
    method: 'POST',
    url: '{{baseUrl}}/customers',
    query: [],
    pathParams: [],
    headers: [],
    body: { mode: 'json', content: body },
    auth: { type: 'inherit' },
    captures: [],
    assertions: [],
  });
  const collection = (body: string) => ({
    name: 'Customers',
    variables: [{ key: 'baseUrl', value: 'https://api.test' }],
    auth: { type: 'none' as const },
    items: [requestItem(body)],
  });
  const scenario = {
    name: 'Signups',
    requests: [{ requestId: 'create', weight: 1 }],
    stages: [{ durationSec: 10, targetVus: 2 }],
    thinkTimeMs: 0,
    thresholds: [],
  };

  /** The script's own `v()`, run without k6: its helpers are plain JavaScript. */
  function scriptResolver(script: string) {
    const start = script.indexOf('const vars');
    const end = script.indexOf('function json');
    return new Function('__ENV', `${script.slice(start, end)}\nreturn { v, pools, vars };`)({}) as {
      v: (text: string) => string;
      pools: Record<string, string[]>;
      vars: Record<string, string>;
    };
  }

  it('embeds pools only for the helpers the scenario uses, and resolves them in the script', () => {
    const script = exportK6(
      collection('{"name":"{{$randomFullName}}","cpf":"{{$randomCPF}}","id":"{{$guid}}"}'),
      scenario,
    );
    const { v, pools } = scriptResolver(script);
    expect(Object.keys(pools).sort()).toEqual(['$randomCPF', '$randomFullName']);
    expect(pools['$randomFullName']).toHaveLength(40);
    expect(new Set(pools['$randomFullName']).size).toBeGreaterThan(5);

    const body = JSON.parse(
      v('{"name":"{{$randomFullName}}","cpf":"{{$randomCPF}}","id":"{{$guid}}"}'),
    );
    expect(pools['$randomFullName']).toContain(body.name);
    expect(pools['$randomCPF']).toContain(body.cpf);
    expect(body.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(v('{{baseUrl}}|{{$timestamp}}|{{$nope}}|{{missing}}')).toMatch(
      /^https:\/\/api\.test\|\d{10}\|\{\{\$nope\}\}\|\{\{missing\}\}$/,
    );
    expect(v('{{$randomInt}} {{$isoTimestamp}}')).toMatch(/^\d{1,3} \d{4}-\d{2}-\d{2}T/);
  });

  it('adds no pools when the scenario uses no mock helpers', () => {
    const { pools } = scriptResolver(exportK6(collection('{"a":1}'), scenario));
    expect(pools).toEqual({});
  });
});

describe('mock values API', () => {
  async function setup() {
    const authRepo = new InMemoryAuthRepository();
    const app = createApp({
      authService: new AuthService(authRepo),
      workspaceService: new WorkspaceService(new InMemoryWorkspaceRepository(), authRepo),
      apiTestStore: new InMemoryApiTestStore(),
    });
    const registered = await request(app)
      .post('/auth/register')
      .send({ email: 'qa@example.com', password: 'StrongPassword123!', name: 'QA' });
    const token = registered.body.token as string;
    const workspace = await request(app)
      .post('/workspaces')
      .set('authorization', `Bearer ${token}`)
      .send({ name: 'Mocks WS', slug: 'mocks-ws' });
    return { app, token, workspaceId: workspace.body.workspace.id as string };
  }

  it('lists every helper with its group and a fresh sample', async () => {
    const { app, token, workspaceId } = await setup();
    const res = await request(app)
      .get('/integration-tests/dynamic-values')
      .set('authorization', `Bearer ${token}`)
      .set('x-workspace-id', workspaceId);
    expect(res.status).toBe(200);
    expect(res.body.values).toHaveLength(DYNAMIC_VALUE_NAMES.length);
    expect(res.body.values[0]).toEqual({
      name: '$guid',
      group: 'ids',
      sample: expect.stringMatching(/^[0-9a-f-]{36}$/),
    });
    expect(res.body.values.map((item: { name: string }) => item.name)).toContain('$randomCPF');
  });

  it('needs a signed-in user', async () => {
    const { app } = await setup();
    expect((await request(app).get('/integration-tests/dynamic-values')).status).toBe(401);
  });
});
