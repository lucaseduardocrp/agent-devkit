import { spawn } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ScriptSandbox,
  type ScriptHost,
  type ScriptInput,
} from '../src/modules/apitests/engine/script-sandbox.js';
import type * as Runtime from '../src/modules/apitests/engine/script-runtime.js';
import {
  permissionFlag,
  scriptChildArguments,
  scriptChildEnvironment,
} from '../src/modules/apitests/engine/script-runtime.js';

// Lets a test replace the child program (a hostile or broken child) without touching the sandbox.
const override = vi.hoisted(() => ({ args: undefined as string[] | undefined }));
vi.mock('../src/modules/apitests/engine/script-runtime.js', async (importActual) => {
  const actual = await importActual<typeof Runtime>();
  return {
    ...actual,
    scriptChildArguments: (memoryMb: number, version?: string) =>
      override.args ?? actual.scriptChildArguments(memoryMb, version),
  };
});

const okHost: ScriptHost = {
  sendRequest: async (request) => ({
    status: 201,
    statusText: 'Created',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ echo: request }),
    durationMs: 7,
  }),
};

const sandboxes: ScriptSandbox[] = [];
function sandbox(options: Partial<ConstructorParameters<typeof ScriptSandbox>[0]> = {}) {
  const created = new ScriptSandbox({ host: okHost, ...options });
  sandboxes.push(created);
  return created;
}

afterEach(async () => {
  override.args = undefined;
  vi.useRealTimers();
  delete process.env.SECRET_FOR_TEST;
  await Promise.all(sandboxes.splice(0).map((item) => item.close()));
});

function script(code: string, overrides: Partial<ScriptInput> = {}): ScriptInput {
  return {
    phase: 'post-response',
    source: 'request tests',
    code,
    collectionName: 'Shop',
    environmentName: 'dev',
    request: {
      id: 'r1',
      name: 'List items',
      kind: 'http',
      method: 'POST',
      url: 'https://api.test/items',
      headers: { 'Content-Type': 'application/json', 'X-Trace': 'a' },
      body: '{"name":"pen"}',
      timeoutMs: 5000,
      authType: 'bearer',
    },
    response: {
      status: 200,
      statusText: 'OK',
      headers: { 'Content-Type': 'application/json', 'X-Rate': '10' },
      body: JSON.stringify({ data: { items: [{ id: 1 }, { id: 2, tags: ['a'] }] }, ok: true }),
      durationMs: 42,
      sizeBytes: 64,
    },
    variables: {
      runtime: { token: 'rt', shared: 'runtime' },
      data: { row: 'd1', shared: 'data' },
      request: { reqVar: 'rq', shared: 'request' },
      folder: { folderVar: 'f', shared: 'folder' },
      environment: { host: 'api.test', shared: 'environment' },
      collection: { col: 'c', shared: 'collection' },
    },
    iteration: { index: 2, total: 5 },
    ...overrides,
  };
}

const pre = (code: string, overrides: Partial<ScriptInput> = {}) =>
  script(code, {
    phase: 'pre-request',
    source: 'request pre-request',
    response: undefined,
    ...overrides,
  });

/** Runs code that logs one JSON value and returns it parsed. */
async function evaluate(box: ScriptSandbox, code: string, input = script) {
  const output = await box.run(
    input(`console.log(JSON.stringify(await (async () => { ${code} })()))`),
  );
  expect(output.error).toBeUndefined();
  return JSON.parse(output.logs[0]!.message) as unknown;
}

describe('ScriptSandbox variables and request', () => {
  it('reads variables with precedence and writes to the right scope', async () => {
    const box = sandbox();
    const output = await box.run(
      script(`
        console.log(adk.interpolate('{{shared}} {{host}} {{col}} {{folderVar}} {{reqVar}} {{row}} {{missing}} {{$guid}}'));
        console.log(adk.getVar('token'), adk.getEnvVar('host'), adk.getCollectionVar('col'), adk.getFolderVar('folderVar'), adk.getRequestVar('reqVar'));
        console.log(adk.getEnvName(), adk.getCollectionName(), adk.getProcessEnv('PATH'), adk.cwd() === '', adk.isSafeMode());
        console.log(adk.hasVar('token'), adk.hasEnvVar('nope'), adk.hasCollectionVar('col'));
        adk.setVar('obj', { a: 1 });
        adk.setVar('num', 5);
        adk.setVar('token', undefined);
        adk.setEnvVar('host', 'other.test');
        adk.deleteEnvVar('shared');
        adk.setCollectionVar('col', true);
        adk.deleteCollectionVar('shared');
        adk.deleteVar('shared');
        console.log(JSON.stringify(adk.getAllVars()), JSON.stringify(adk.getAllEnvVars()));
        console.log(JSON.stringify(adk.interpolate({ u: '{{host}}' })));
        adk.setVar('__proto__', 'safe');
      `),
    );
    expect(output.error).toBeUndefined();
    expect(output.logs.map((log) => log.message)).toEqual([
      'runtime api.test c f rq d1 {{missing}} {{$guid}}',
      'rt api.test c f rq',
      'dev Shop undefined true true',
      'true false true',
      '{"obj":"{\\"a\\":1}","num":"5"} {"host":"other.test"}',
      '{"u":"other.test"}',
    ]);
    expect(output.logs[0]!.source).toBe('request tests');
    expect(output.variables.runtime).toEqual({ obj: '{"a":1}', num: '5', ['__proto__']: 'safe' });
    expect(Object.getPrototypeOf(output.variables.runtime)).toBe(Object.prototype);
    expect(output.variables.environment).toEqual({ host: 'other.test' });
    expect(output.variables.collection).toEqual({ col: 'true' });
    expect(output.variables.request).toEqual({ reqVar: 'rq', shared: 'request' });
  });

  it('changes the request in pre-request scripts only', async () => {
    const box = sandbox();
    const code = `
      const seen = [req.getUrl(), req.getMethod(), req.getName(), req.getHeader('content-type'), req.getBody().name, req.getTimeout(), req.getAuthMode(), req.url, req.method, req.name, req.body.name, req.timeout, Object.keys(req.headers).length, Object.keys(req.getHeaders()).length];
      console.log(JSON.stringify(seen));
      req.setUrl('https://api.test/v2');
      req.setMethod('put');
      req.setHeader('x-trace', 'b');
      req.deleteHeader('content-type');
      req.setBody({ name: 'ink' });
      req.setTimeout(900);
    `;
    const changed = await box.run(pre(code));
    expect(JSON.parse(changed.logs[0]!.message)).toEqual([
      'https://api.test/items',
      'POST',
      'List items',
      'application/json',
      'pen',
      5000,
      'bearer',
      'https://api.test/items',
      'POST',
      'List items',
      'pen',
      5000,
      2,
      2,
    ]);
    expect(changed.request).toMatchObject({
      id: 'r1',
      method: 'PUT',
      url: 'https://api.test/v2',
      headers: { 'x-trace': 'b' },
      body: '{"name":"ink"}',
      timeoutMs: 900,
    });
    const more = await box.run(
      pre(
        `req.setHeaders({ A: '1', B: null }); req.body = 'plain'; req.url = 'u'; req.method = 'get'; req.setBody(null);`,
      ),
    );
    expect(more.request).toMatchObject({ headers: { A: '1' }, url: 'u', method: 'GET' });
    expect(more.request.body).toBeUndefined();
    expect(more.request).not.toHaveProperty('timeoutMs', undefined);

    const untouched = await box.run(script(code));
    expect(untouched.request).toEqual(script('').request);
  });
});

describe('ScriptSandbox response, tests and expect', () => {
  it('exposes res with query paths', async () => {
    const box = sandbox();
    expect(
      await evaluate(
        box,
        `return [res.status, res.statusText, res.getStatus(), res.getStatusText(), res.getHeader('x-rate'), res.headers['X-Rate'],
          res.getHeaders()['Content-Type'], res.body.ok, res.getBody().ok, res.responseTime, res.getResponseTime(), res.getSize().body,
          res('data.items[1].id'), res('data.items[-1].tags[0]'), res("data['items'][0].id"), res('nope.deeper'), res().ok, typeof res];`,
      ),
    ).toEqual([
      200,
      'OK',
      200,
      'OK',
      '10',
      '10',
      'application/json',
      true,
      true,
      42,
      42,
      64,
      2,
      'a',
      1,
      null,
      true,
      'function',
    ]);
    expect(await evaluate(box, 'return [typeof res, typeof adk.response];', pre)).toEqual([
      'undefined',
      'undefined',
    ]);
    const text = await box.run(
      script('console.log(res.body, res("x"))', {
        response: { ...script('').response!, body: 'plain' },
      }),
    );
    expect(text.logs[0]!.message).toBe('plain undefined');
  });

  it('records sync, async and failing tests with chai messages', async () => {
    const box = sandbox();
    const output = await box.run(
      script(`
        test('status', () => expect(res.status).to.equal(200));
        test('wrong status', () => expect(404).to.equal(200));
        test('async', async () => { await adk.sleep(5); expect(res.body.data.items).to.have.lengthOf(3); });
        test('throws string', () => { throw 'plain'; });
        test('no fn');
        await adk.sleep(1);
        test('top level await ran', () => expect(true).to.be.true);
      `),
    );
    expect(output.tests).toEqual([
      { name: 'status', passed: true },
      { name: 'wrong status', passed: false, error: 'expected 404 to equal 200' },
      {
        name: 'async',
        passed: false,
        error: "expected [ { id: 1 }, { id: 2, tags: [ 'a' ] } ] to have a length of 3 but got 2",
      },
      { name: 'throws string', passed: false, error: 'plain' },
      { name: 'no fn', passed: true },
      { name: 'top level await ran', passed: true },
    ]);
  });

  it('implements the chai BDD subset and assert', async () => {
    const box = sandbox();
    const passing = `
      expect({ a: 1, b: { c: [1, 2] } }).to.deep.equal({ a: 1, b: { c: [1, 2] } });
      expect({ a: 1 }).to.eql({ a: 1 }).and.not.eql({ a: 2 });
      expect([1, 2]).to.be.an('array').with.length(2).that.includes(2);
      expect(null).to.be.a('null'); expect({}).to.be.an('object'); expect('s').to.be.a('string');
      expect(new Date(1)).to.be.a('date').and.deep.equal(new Date(1)); expect(/x/g).to.eql(/x/g);
      expect('hello').to.include('ell').and.contain('he').and.have.lengthOf(5).and.match(/^h/).and.have.string('llo');
      expect({ a: 1, b: 2 }).to.include({ a: 1 }); expect([{ a: 1 }]).to.deep.include({ a: 1 });
      expect(new Set([1])).to.include(1); expect(new Map([['k', 2]])).to.include(2);
      expect({ a: { b: 1 } }).to.have.property('a').that.has.property('b', 1);
      expect({ a: { b: 1 } }).to.have.deep.property('a', { b: 1 }); expect({ a: 1 }).to.have.own.property('a');
      expect({ a: 1 }).to.haveOwnProperty('a'); expect({ a: 1 }).to.have.ownProperty('a', 1); expect({}).not.to.have.property('toString', 1);
      expect(1).to.be.ok; expect(true).to.be.true; expect(false).to.be.false; expect(undefined).to.be.undefined; expect(NaN).to.be.NaN;
      expect(0).to.exist; expect(null).to.not.exist; expect('').to.be.empty; expect([]).to.be.empty; expect({}).to.be.empty;
      expect(new Map()).to.be.empty; expect(1).not.to.be.empty;
      expect(5).to.be.above(4).and.gt(1).and.greaterThan(0).and.below(6).and.lt(7).and.lessThan(8);
      expect(5).to.be.at.least(5).and.gte(5).and.at.most(5).and.lte(5).and.within(1, 5).and.closeTo(5.1, 0.2);
      expect([1, 2, 3]).to.have.length.above(2).and.length.within(1, 3); expect(new Set([1])).to.have.lengthOf(1);
      expect(2).to.be.oneOf([1, 2]); expect({ a: 1 }).to.be.deep.oneOf([{ a: 1 }]);
      expect({ a: 1, b: 2 }).to.have.keys('a', 'b').and.have.keys(['a', 'b']).and.have.keys({ a: 0, b: 0 });
      expect({ a: 1, b: 2 }).to.contain.keys('a').and.have.any.keys('a', 'z').and.all.keys('a', 'b');
      expect(new Map([['k', 1]])).to.have.key('k');
      expect([1, 2]).to.have.members([2, 1]).and.include.members([1]); expect([{ a: 1 }]).to.have.deep.members([{ a: 1 }]);
      expect(new Error('x')).to.be.instanceOf(Error).and.instanceof(Object);
      expect(() => { throw new TypeError('boom here'); }).to.throw().and.throws(TypeError).and.Throw(/boom/).and.throw('here').and.throw(TypeError, 'boom');
      expect(() => { throw new Error('a'); }).to.throw(Error, /a/);
      expect(() => 1).to.not.throw(); expect(3).to.satisfy((n) => n > 2); expect(-0).to.equal(0);
      expect(NaN).to.eql(NaN); expect(new Set([1])).to.eql(new Set([1])); expect([1]).not.to.eql([1, 2]); expect({ a: 1 }).not.to.eql({ b: 1 });
      expect([1]).not.to.eql({ 0: 1 }); expect({ a: 1 }).not.to.eql({ a: 1, b: 2 }); expect(new Map([[1, 1]])).not.to.eql(new Map());
      const cyclic = { }; cyclic.self = cyclic; const other = { }; other.self = other; expect(cyclic).to.eql(other);
      expect(5).to.be.a('number').that.is.not.a('string'); expect(1).to.not.include(1); expect('ab').not.to.include('z');
      assert(true); assert.ok(1); assert.isOk(1); assert.equal(1, '1'); assert.notEqual(1, 2); assert.strictEqual(1, 1);
      assert.notStrictEqual(1, '1'); assert.deepEqual({ a: [1] }, { a: [1] }); assert.deepStrictEqual([1], [1]); assert.notDeepEqual([1], [2]);
      assert.isTrue(true); assert.isFalse(false); assert.isNull(null); assert.isUndefined(undefined); assert.exists(0); assert.include('abc', 'b');
      const chai = require('chai'); chai.expect(1).to.equal(1); chai.assert.ok(1);
      return 'ok';
    `;
    expect(await evaluate(box, passing)).toBe('ok');

    const failures: [string, string][] = [
      ['expect(404, "status").to.equal(200)', 'status: expected 404 to equal 200'],
      ['expect(1).to.not.equal(1)', 'expected 1 to not equal 1'],
      ['expect({ a: 1 }).to.deep.equal({ a: 2 })', 'expected { a: 1 } to deeply equal { a: 2 }'],
      ['expect({ a: 1 }).not.to.eql({ a: 1 })', 'expected { a: 1 } to not deeply equal { a: 1 }'],
      ['expect(1).to.be.a("string")', 'expected 1 to be a string'],
      ['expect([]).to.not.be.an("array")', 'expected [] not to be an array'],
      ['expect("abc").to.include("z")', "expected 'abc' to include 'z'"],
      ['expect([1]).not.to.deep.include(1)', 'expected [ 1 ] to not deep include 1'],
      ['expect(1).to.include(1)', 'expected 1 to include 1'],
      ['expect({ a: 1 }).to.have.property("b")', "expected { a: 1 } to have property 'b'"],
      [
        'expect({ a: 1 }).to.not.have.own.property("a")',
        "expected { a: 1 } to not have own property 'a'",
      ],
      [
        'expect({ a: 1 }).to.have.property("a", 2)',
        "expected { a: 1 } to have property 'a' of 2, but got 1",
      ],
      [
        'expect({ a: 1 }).to.not.have.property("a", 1)',
        "expected { a: 1 } to not have property 'a' of 1",
      ],
      ['expect(null).to.have.property("a")', "expected null to have property 'a'"],
      ['expect([1]).to.not.have.lengthOf(1)', 'expected [ 1 ] to not have a length of 1'],
      ['expect(0).to.be.ok', 'expected 0 to be truthy'],
      ['expect(1).to.not.be.ok', 'expected 1 to not be truthy'],
      ['expect(null).to.exist', 'expected null to exist'],
      ['expect([1]).to.be.empty', 'expected [ 1 ] to be empty'],
      ['expect(1).to.be.above(2)', 'expected 1 to be above 2'],
      ['expect(3).to.not.be.below(4)', 'expected 3 to not be below 4'],
      ['expect([1]).to.have.length.above(2)', 'expected [ 1 ] to have a length above 2 but got 1'],
      [
        'expect([1]).to.not.have.length.at.most(2)',
        'expected [ 1 ] to not have a length at most 2',
      ],
      ['expect(9).to.be.within(1, 3)', 'expected 9 to be within 1..3'],
      ['expect(2).to.not.be.within(1, 3)', 'expected 2 to not be within 1..3'],
      ['expect(1).to.be.closeTo(5, 1)', 'expected 1 to be close to 5 +/- 1'],
      ['expect(5).not.to.be.closeTo(5, 1)', 'expected 5 not to be close to 5 +/- 1'],
      ['expect("a").to.match(/b/)', "expected 'a' to match /b/"],
      ['expect("a").not.to.match(/a/)', "expected 'a' not to match /a/"],
      ['expect("a").to.have.string("b")', "expected 'a' to contain 'b'"],
      ['expect("a").to.not.have.string("a")', "expected 'a' to not contain 'a'"],
      ['expect(3).to.be.oneOf([1, 2])', 'expected 3 to be one of [ 1, 2 ]'],
      ['expect(1).not.to.be.oneOf([1])', 'expected 1 to not be one of [ 1 ]'],
      ['expect({ a: 1 }).to.have.keys("a", "b")', "expected { a: 1 } to have keys 'a', 'b'"],
      ['expect({ a: 1 }).to.contain.keys("b")', "expected { a: 1 } to contain keys 'b'"],
      [
        'expect({ a: 1 }).to.not.have.any.keys("a")',
        "expected { a: 1 } to not have any of keys 'a'",
      ],
      ['expect([1]).to.have.members([2])', 'expected [ 1 ] to have the same members as [ 2 ]'],
      ['expect([1]).to.not.include.members([1])', 'expected [ 1 ] to not be a superset of [ 1 ]'],
      ['expect(1).to.be.instanceOf(Error)', 'expected 1 to be an instance of Error'],
      [
        'expect(Number).to.not.be.instanceOf(Function)',
        'expected [Function: Number] to not be an instance of Function',
      ],
      [
        'expect(1).to.be.instanceOf(function () {}.bind())',
        'expected 1 to be an instance of bound ',
      ],
      ['expect(() => 1).to.throw()', 'expected [Function] to throw an error'],
      [
        'expect(() => { throw new Error("x"); }).to.not.throw()',
        "expected [Function] to not throw an error but 'x' was thrown",
      ],
      [
        'expect(() => { throw new Error("x"); }).to.throw(TypeError)',
        'expected [Function] to throw an error TypeError',
      ],
      [
        'expect(() => { throw new Error("x"); }).to.throw(function () {}.bind())',
        'expected [Function] to throw an error bound ',
      ],
      [
        'expect(() => { throw new Error("x"); }).to.throw("y")',
        "expected [Function] to throw an error including 'y'",
      ],
      [
        'expect(() => { throw new Error("x"); }).to.throw(Error, "y")',
        "expected [Function] to throw an error Error with message 'y'",
      ],
      ['expect(1).to.satisfy((n) => n > 1)', 'expected 1 to satisfy [Function (anonymous)]'],
      ['expect(1).not.to.satisfy(() => true)', 'expected 1 to not satisfy [Function (anonymous)]'],
      ['expect.fail("custom")', 'custom'],
      ['expect.fail()', 'expect.fail()'],
      ['assert(false)', 'expected false to be truthy'],
      ['assert(0, "zero")', 'zero'],
      ['assert.equal(1, 2)', 'expected 1 to equal 2'],
      ['assert.notEqual(1, 1)', 'expected 1 to not equal 1'],
      ['assert.strictEqual(1, "1")', "expected 1 to equal '1'"],
      ['assert.notStrictEqual(1, 1)', 'expected 1 to not equal 1'],
      ['assert.deepEqual([1], [2], "deep")', 'deep'],
      ['assert.notDeepEqual([1], [1])', 'expected [ 1 ] to not deeply equal [ 1 ]'],
      ['assert.isTrue(1)', 'expected 1 to be true'],
      ['assert.isFalse(1)', 'expected 1 to be false'],
      ['assert.isNull(1)', 'expected 1 to be null'],
      ['assert.isUndefined(1)', 'expected 1 to be undefined'],
      ['assert.exists(null)', 'expected null to exist'],
      ['assert.include("a", "b")', "expected 'a' to include 'b'"],
      ['assert.fail("f")', 'f'],
      ['assert.fail()', 'assert.fail()'],
    ];
    const code = failures
      .map(([line], index) => `test('${index}', () => { ${line}; });`)
      .join('\n');
    const output = await box.run(script(code));
    expect(output.tests.map((test) => test.error)).toEqual(failures.map(([, message]) => message));
  });
});

describe('ScriptSandbox Postman shim and flow control', () => {
  it('maps pm scopes, request, response and tests', async () => {
    const box = sandbox();
    const output = await box.run(
      script(`
        adk.environment.set('token', { a: 1 });
        adk.environment.unset('shared');
        adk.collectionVariables.set('col', 2);
        adk.globals.set('g', 'x');
        adk.variables.set('local', 'l');
        adk.variables.unset('shared');
        console.log(adk.environment.get('token'), adk.environment.has('host'), adk.environment.name, adk.environment.replaceIn('{{host}}'));
        console.log(adk.variables.get('shared'), adk.variables.has('nope'), adk.variables.replaceIn('{{local}}'), adk.variables.toObject().shared);
        console.log(adk.iterationData.get('row'), adk.iterationData.has('row'), JSON.stringify(adk.iterationData.toObject()));
        console.log(JSON.stringify(adk.collectionVariables.toObject()), JSON.stringify(adk.info));
        console.log(String(adk.request.url), adk.request.method, adk.request.name, adk.request.headers.get('x-trace'), adk.request.headers.has('nope'), adk.request.body.mode, adk.request.body.raw, String(adk.request.body));
        console.log(adk.response.code, adk.response.status, adk.response.headers.get('x-rate'), adk.response.headers.has('x-rate'), adk.response.responseTime, adk.response.responseSize, adk.response.json().ok, adk.response.text().length, adk.response.reason());
        console.log(JSON.stringify(adk.response.headers.toObject()), JSON.stringify(adk.response.headers.all()), JSON.stringify(adk.request.headers.all()));
        adk.response.headers.each((h) => console.log('header', h.key));
        adk.test('status is 200', () => { adk.response.to.have.status(200); adk.response.to.be.ok; adk.response.to.be.success; adk.response.to.be.json; });
        adk.test('reason', () => adk.response.to.have.status('OK'));
        adk.test('header', () => { adk.response.to.have.header('x-rate'); adk.response.to.have.header('X-Rate', '10'); });
        adk.test('body', () => { adk.response.to.have.body(); adk.response.to.have.body(/items/); adk.response.to.have.jsonBody(); adk.response.to.have.jsonBody('data.items[0].id', 1); adk.response.to.have.jsonBody('ok'); adk.response.to.have.jsonBody({ data: { items: [{ id: 1 }, { id: 2, tags: ['a'] }] }, ok: true }); });
        adk.test('json', () => adk.expect(adk.response.json().data.items).to.have.lengthOf(2));
        adk.test('wrong status', () => adk.response.to.have.status(404));
        adk.test('wrong reason', () => adk.response.to.have.status('Nope'));
        adk.test('error range', () => adk.response.to.be.error);
        adk.test('client', () => adk.response.to.be.clientError);
        adk.test('server', () => adk.response.to.be.serverError);
        adk.test('400', () => adk.response.to.be.badRequest);
        adk.test('401', () => adk.response.to.be.unauthorized);
        adk.test('403', () => adk.response.to.be.forbidden);
        adk.test('404', () => adk.response.to.be.notFound);
        adk.test('missing header', () => adk.response.to.have.header('nope'));
        adk.test('header value', () => adk.response.to.have.header('x-rate', '11'));
        adk.test('body text', () => adk.response.to.have.body('nope'));
        adk.test('body regex', () => adk.response.to.have.body(/nope/));
        adk.test('json path', () => adk.response.to.have.jsonBody('data.nope'));
        adk.test('json value', () => adk.response.to.have.jsonBody('ok', false));
        adk.test('json equal', () => adk.response.to.have.jsonBody({}));
        adk.collectionVariables.clear();
      `),
    );
    expect(output.error).toBeUndefined();
    expect(output.logs.map((log) => log.message)).toEqual([
      '{"a":1} true dev api.test',
      'data false l data',
      'd1 true {"row":"d1","shared":"data"}',
      '{"col":"2","shared":"collection"} {"requestName":"List items","requestId":"r1","iteration":2,"iterationCount":5,"eventName":"test"}',
      'https://api.test/items POST List items a false raw {"name":"pen"} {"name":"pen"}',
      '200 OK 10 true 42 64 true 61 OK',
      '{"Content-Type":"application/json","X-Rate":"10"} [{"key":"Content-Type","value":"application/json"},{"key":"X-Rate","value":"10"}] [{"key":"Content-Type","value":"application/json"},{"key":"X-Trace","value":"a"}]',
      'header Content-Type',
      'header X-Rate',
    ]);
    expect(output.tests.filter((test) => test.passed).map((test) => test.name)).toEqual([
      'status is 200',
      'reason',
      'header',
      'body',
      'json',
    ]);
    expect(output.tests.filter((test) => !test.passed).map((test) => test.error)).toEqual([
      'expected response to have status code 404 but got 200',
      "expected response to have status reason 'Nope' but got 'OK'",
      'expected response code to be 4XX or 5XX but got 200',
      'expected response code to be 4XX but got 200',
      'expected response code to be 5XX but got 200',
      'expected response to be bad request but got 200',
      'expected response to be unauthorized but got 200',
      'expected response to be forbidden but got 200',
      'expected response to be not found but got 200',
      "expected response to have header 'nope'",
      "expected response header 'x-rate' to be '11' but got '10'",
      "expected response body to equal 'nope'",
      'expected response body to match /nope/',
      "expected { data: { items: [ [Object], [Object] ] }, ok: true } to have property 'data.nope'",
      "expected response body json at 'ok' to contain false",
      'expected response body json to equal {}',
    ]);
    expect(output.variables.environment.token).toBe('{"a":1}');
    expect(output.variables.environment).not.toHaveProperty('shared');
    expect(output.variables.runtime).toMatchObject({ g: 'x', local: 'l' });
    expect(output.variables.runtime).not.toHaveProperty('shared');
    expect(output.variables.collection).toEqual({});

    const invalid = await box.run(
      script(
        `adk.test('json', () => adk.response.to.be.json); adk.test('jsonBody', () => adk.response.to.have.jsonBody()); adk.test('empty', () => adk.response.to.have.body());`,
        { response: { ...script('').response!, body: '' } },
      ),
    );
    expect(invalid.tests.map((test) => test.error)).toEqual([
      'expected response body to be a valid json',
      'expected response body to be a valid json',
      'expected response to have content in body',
    ]);
  });

  it('lets pm change the request in pre-request scripts', async () => {
    const box = sandbox();
    const output = await box.run(
      pre(`
        adk.request.headers.add({ key: 'X-A', value: '1' });
        adk.request.headers.upsert({ key: 'x-trace', value: 'z' });
        adk.request.headers.remove('content-type');
        adk.request.addHeader({ key: 'X-B', value: 2 });
        adk.request.upsertHeader({ key: 'X-B', value: 3 });
        adk.request.removeHeader('X-A');
        adk.request.headers.add(null); adk.request.addHeader({}); adk.request.upsertHeader(null); adk.request.headers.upsert({});
        adk.request.url = 'https://other.test';
        adk.request.method = 'patch';
        adk.request.body.raw = { b: 1 };
        console.log(adk.info.eventName, JSON.stringify(adk.request.headers.toObject()));
        adk.setEnvironmentVariable('e', 1);
        adk.setGlobalVariable('g', 2);
        console.log(adk.getEnvironmentVariable('e'), adk.getGlobalVariable('g'));
        adk.clearEnvironmentVariable('e');
        adk.clearGlobalVariable('g');
      `),
    );
    expect(output.logs.map((log) => log.message)).toEqual([
      'prerequest {"x-trace":"z","X-B":"3"}',
      '1 2',
    ]);
    expect(output.request).toMatchObject({
      url: 'https://other.test',
      method: 'PATCH',
      body: '{"b":1}',
    });
    expect(output.variables.environment).not.toHaveProperty('e');
    expect(output.variables.runtime).not.toHaveProperty('g');
    const empty = await box.run(
      pre(
        'console.log(String(adk.request.body), adk.info.iteration, adk.info.iterationCount, adk.environment.name)',
        {
          request: { ...script('').request, body: undefined },
          iteration: undefined,
          environmentName: undefined,
        },
      ),
    );
    expect(empty.logs[0]!.message).toBe(' 0 1 undefined');
  });

  it('reports next request, skip and stop', async () => {
    const box = sandbox();
    const none = await box.run(script(''));
    expect(none).not.toHaveProperty('nextRequest');
    expect(none).toMatchObject({ skipRequest: false, stopExecution: false, tests: [], logs: [] });
    expect((await box.run(script("adk.setNextRequest('Login')"))).nextRequest).toBe('Login');
    expect((await box.run(script('adk.runner.setNextRequest(null)'))).nextRequest).toBeNull();
    expect((await box.run(script('adk.setNextRequest()'))).nextRequest).toBeNull();
    expect((await box.run(script("adk.execution.setNextRequest('B')"))).nextRequest).toBe('B');
    expect((await box.run(pre('adk.runner.skipRequest()'))).skipRequest).toBe(true);
    expect((await box.run(pre('adk.execution.skipRequest()'))).skipRequest).toBe(true);
    expect((await box.run(script('adk.runner.stopExecution()'))).stopExecution).toBe(true);
  });

  it('keeps scripts saved before adk running: bru, pm and postman are adk', async () => {
    const box = sandbox();
    const output = await box.run(
      script(`
        console.log(bru === adk, pm === adk, postman === adk);
        bru.setVar('fromBruno', 1);
        pm.environment.set('fromPostman', 2);
        postman.setGlobalVariable('fromLegacy', 3);
        console.log(adk.getVar('fromBruno'), adk.getEnvVar('fromPostman'), adk.getVar('fromLegacy'));
      `),
    );
    expect(output.error).toBeUndefined();
    expect(output.logs.map((log) => log.message)).toEqual(['true true true', '1 2 3']);
  });
});

describe('ScriptSandbox sendRequest', () => {
  it('round-trips requests through the host', async () => {
    const calls: unknown[] = [];
    const box = sandbox({
      host: {
        sendRequest: async (request) => {
          calls.push(request);
          return okHost.sendRequest(request);
        },
      },
    });
    const output = await box.run(
      script(`
        const r = await adk.sendRequest({ method: 'post', url: 'https://a.test', headers: { 'X-H': 1 }, data: { q: 1 }, timeout: 300 });
        console.log(r.status, r.statusText, r.data.echo.method, r.headers['content-type'], r.responseTime, typeof r.body);
        await adk.sendRequest({ url: 'https://b.test', headers: ['X-L: 2', { key: 'X-K', value: 'v' }, { key: 'X-D', value: 'd', disabled: true }] }, (err, res) => console.log('cb', err, res.status));
        await adk.sendRequest('https://c.test', () => { throw new Error('cb broke'); });
        adk.sendRequest({ url: 'https://d.test', body: 'raw', headers: { 'content-type': 'text/plain' } }).then((x) => console.log('later', x.status));
        adk.sendRequest('https://e.test', (err, res) => console.log('pm', err, res.code, res.json().echo.url, res.text().length > 0, res.headers.get('content-type')));
        const p = await adk.sendRequest({ url: { raw: 'https://f.test' }, method: 'put', header: [{ key: 'A', value: 'b' }], body: { mode: 'raw', raw: 'x' } });
        console.log('pm await', p.code, p.status, p.statusText, p.responseSize > 0);
        await adk.sendRequest({ url: 'https://g.test', header: { A: 'b' }, body: { mode: 'urlencoded', urlencoded: [{ key: 'a b', value: 'c&d' }, { key: 'x' }, { key: 'off', value: '1', disabled: true }] } });
        await adk.sendRequest({ url: 'https://h.test', body: 'text', timeout: 5 });
        await adk.sendRequest({ url: 'https://i.test', body: { mode: 'raw' } });
        await adk.sendRequest({ url: 'https://j.test', body: { mode: 'file' } });
      `),
    );
    expect(output.error).toBeUndefined();
    expect(output.logs.map((log) => log.message)).toEqual([
      '201 Created POST application/json 7 string',
      'cb null 201',
      'Uncaught error in sendRequest callback: cb broke',
      'later 201',
      'pm null 201 https://e.test true application/json',
      'pm await 201 201 Created true',
    ]);
    expect(calls).toEqual([
      {
        method: 'POST',
        url: 'https://a.test',
        headers: { 'X-H': '1', 'Content-Type': 'application/json' },
        body: '{"q":1}',
        timeoutMs: 300,
      },
      { method: 'GET', url: 'https://b.test', headers: { 'X-L': '2', 'X-K': 'v' } },
      { method: 'GET', url: 'https://c.test', headers: {} },
      {
        method: 'GET',
        url: 'https://d.test',
        headers: { 'content-type': 'text/plain' },
        body: 'raw',
      },
      { method: 'GET', url: 'https://e.test', headers: {} },
      { method: 'PUT', url: 'https://f.test', headers: { A: 'b' }, body: 'x' },
      {
        method: 'GET',
        url: 'https://g.test',
        headers: { A: 'b', 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'a%20b=c%26d&x=',
      },
      { method: 'GET', url: 'https://h.test', headers: {}, body: 'text', timeoutMs: 5 },
      { method: 'GET', url: 'https://i.test', headers: {} },
      { method: 'GET', url: 'https://j.test', headers: {} },
    ]);
  });

  it('reports host failures, invalid requests and the per-script limit', async () => {
    let count = 0;
    const box = sandbox({
      host: {
        sendRequest: async (request) => {
          count += 1;
          if (request.url.includes('error')) throw new Error('blocked by guard');
          if (request.url.includes('string')) throw 'plain failure';
          return okHost.sendRequest(request);
        },
      },
    });
    const output = await box.run(
      script(`
        await adk.sendRequest({ url: 'https://error.test' }).catch((e) => console.log(e.message));
        await adk.sendRequest({ url: 'https://string.test' }, (err) => console.log('cb', err.message));
        await adk.sendRequest({ url: '' }, (err, res) => console.log('pm', err.message, res));
        await adk.sendRequest({ url: 'https://error.test' }, () => { throw new Error('again'); });
        adk.sendRequest({ url: 'https://error.test' });
        const many = await Promise.allSettled(Array.from({ length: 100 }, () => adk.sendRequest({ url: 'https://ok.test' })));
        console.log(many.filter((r) => r.status === 'rejected').map((r) => r.reason.message).join('|'));
      `),
    );
    expect(output.logs.map((log) => log.message)).toEqual([
      'blocked by guard',
      'cb plain failure',
      'pm Invalid request: method and url are required null',
      'Uncaught error in sendRequest callback: again',
      Array.from({ length: 5 }, () => 'A script may send at most 100 requests').join('|'),
      // The unawaited failing request is reported like any unhandled rejection.
      'Unhandled promise rejection: blocked by guard',
    ]);
    // 5 earlier sends (one invalid, never reaching the host) + 95 of the batch.
    expect(count).toBe(99);
  });

  it('ignores a host answer that arrives after the script timed out', async () => {
    let release: () => void = () => undefined;
    const box = sandbox({
      timeoutMs: 300,
      host: {
        sendRequest: (request) =>
          new Promise((resolve) => {
            release = () => void okHost.sendRequest(request).then(resolve);
          }),
      },
    });
    const output = await box.run(script("await adk.sendRequest({ url: 'https://slow.test' })"));
    expect(output.error).toBe('request tests: Script timed out after 300 ms');
    release();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect((await box.run(script("console.log('alive')"))).logs[0]!.message).toBe('alive');
  });
});

describe('ScriptSandbox errors, limits and globals', () => {
  it('reports thrown errors with line numbers and the outputs so far', async () => {
    const box = sandbox();
    const thrown = await box.run(
      script("adk.setVar('before', 1);\nconsole.log('one');\nthrow new Error('boom');"),
    );
    expect(thrown.error).toBe('request tests: boom (line 3)');
    expect(thrown.variables.runtime.before).toBe('1');
    expect(thrown.logs).toHaveLength(1);
    expect((await box.run(script('await null;\nnull.x'))).error).toMatch(
      /^request tests: Cannot read properties of null.*\(line 2\)$/,
    );
    expect((await box.run(script('let = ;'))).error).toMatch(
      /^request tests: Unexpected token.*\(line 1\)$/,
    );
    expect((await box.run(script("throw 'text'"))).error).toBe('request tests: text');
    expect(
      (await box.run(script("throw { message: 5, toString() { throw new Error('no'); } }"))).error,
    ).toBe('request tests: Script failed');
    expect(
      (await box.run(script("const e = new Error('nostack'); e.stack = undefined; throw e"))).error,
    ).toBe('request tests: nostack');
    expect(
      (
        await box.run(
          script(
            "const e = new Error('getter'); Object.defineProperty(e, 'stack', { get() { throw 1; } }); throw e",
          ),
        )
      ).error,
    ).toBe('request tests: getter');
    const broken = await box.run(
      script("JSON.stringify = 1; console.log('x'); throw new Error('later')"),
    );
    expect(broken.error).toBe('request tests: later (line 1)');
  });

  it('caps logs and tests and captures async errors', async () => {
    const box = sandbox();
    const output = await box.run(
      script(`
        for (let i = 0; i < 300; i += 1) console.info('line', i);
        for (let i = 0; i < 600; i += 1) test('t' + i, () => {});
      `),
    );
    expect(output.logs).toHaveLength(200);
    expect(output.logs[199]).toMatchObject({
      level: 'warn',
      message: 'Log limit of 200 entries reached; later output was dropped',
    });
    expect(output.tests).toHaveLength(500);
    const levels = await box.run(
      script(`
        console.warn('w'); console.error('e'); console.debug('d'); console.trace('t'); console.dir({ a: 1 }); console.table([1]);
        console.assert(true, 'hidden'); console.assert(false, 'shown');
        console.log('x'.repeat(20000));
        console.log('%s=%d', 'a', 1, { deep: { a: { b: { c: { d: { e: 1 } } } } } });
        console.log({ [Symbol.for('nodejs.util.inspect.custom')]() { throw new Error('nope'); } });
        setTimeout(() => { throw new Error('in timer'); }, 1);
        Promise.reject(new Error('unhandled'));
      `),
    );
    expect(levels.logs.map((log) => [log.level, log.message.slice(0, 40)])).toEqual([
      ['warn', 'w'],
      ['error', 'e'],
      ['debug', 'd'],
      ['debug', 't'],
      ['log', '{ a: 1 }'],
      ['log', '[ 1 ]'],
      ['error', 'Assertion failed shown'],
      ['log', 'x'.repeat(40)],
      ['log', expect.stringContaining('d: [O') as unknown as string],
      ['log', '[unprintable value]'],
      ['error', 'Uncaught error in setTimeout: in timer'],
      ['error', 'Unhandled promise rejection: unhandled ('],
    ]);
    expect(levels.logs[7]!.message).toHaveLength(10_000 + '... (truncated)'.length);
  });

  it('provides timers, globals and only the whitelisted modules', async () => {
    const box = sandbox();
    const result = await evaluate(
      box,
      `
        const order = [];
        const id = setTimeout(() => order.push('cleared'), 5);
        clearTimeout(id); clearTimeout(12345);
        setTimeout((a, b) => order.push(a + b), 1, 'x', 'y');
        let threw = '';
        try { setTimeout('code'); } catch (e) { threw = e.message; }
        const crypto1 = require('crypto');
        const blocked = ['fs', 'node:fs', 'child_process', 'net', 'http', 'vm', 'worker_threads', 'lodash', 'process'].map((name) => {
          try { require(name); return name + ' loaded'; } catch (e) { return e.message; }
        });
        await adk.sleep(10);
        return {
          order, threw, blocked,
          hash: crypto1.createHash('sha256').update('a').digest('hex').slice(0, 8),
          hmac: require('node:crypto').createHmac('sha256', 'k').update('a').digest('base64').length,
          random: crypto1.randomBytes(8).length + crypto1.randomBytes(1e9).length,
          uuid: crypto1.randomUUID().length + crypto.randomUUID().length,
          safe: crypto1.timingSafeEqual(Buffer.from('a'), Buffer.from('a')),
          values: crypto.getRandomValues(new Uint8Array(4)).length + crypto1.getRandomValues(new Uint8Array(2)).length,
          buffer: require('buffer').Buffer.from('hi').toString('base64'),
          url: new (require('url').URL)('https://x.test/a?b=1').searchParams.get('b'),
          qs: require('querystring').stringify({ a: 1 }) + require('querystring').parse('b=2').b + require('querystring').escape(' ') + require('querystring').unescape('%20'),
          util: require('util').format('%s!', 'hi') + require('util').inspect({ a: 1 }),
          globals: [typeof URLSearchParams, typeof TextEncoder, typeof TextDecoder, atob(btoa('ok')), structuredClone({ a: 1 }).a, typeof JSON, typeof Math, typeof Date],
          hidden: [typeof process, typeof module, typeof exports, typeof __dirname, typeof fetch, typeof WebSocket, typeof __adk, typeof globalThis.bridge],
        };
      `,
    );
    expect(result).toEqual({
      order: ['xy'],
      threw: 'setTimeout expects a function',
      blocked: [
        'fs',
        'node:fs',
        'child_process',
        'net',
        'http',
        'vm',
        'worker_threads',
        'lodash',
        'process',
      ].map((name) => `Module '${name}' is not available in ADK scripts`),
      hash: 'ca978112',
      hmac: 44,
      random: 8 + 65536,
      uuid: 72,
      safe: true,
      values: 6,
      buffer: 'aGk=',
      url: '1',
      qs: 'a=12%20 ',
      util: 'hi!{ a: 1 }',
      globals: ['function', 'function', 'function', 'ok', 1, 'object', 'object', 'function'],
      hidden: [
        'undefined',
        'undefined',
        'undefined',
        'undefined',
        'undefined',
        'undefined',
        'undefined',
        'undefined',
      ],
    });
  });

  it('times out synchronous and asynchronous loops and keeps working', async () => {
    const box = sandbox({ timeoutMs: 400 });
    const sync = await box.run(script("adk.setVar('a', 1); while (true) {}"));
    expect(sync.error).toBe('request tests: Script timed out after 400 ms');
    expect(sync.variables.runtime.a).toBe('1');
    const async = await box.run(script('await adk.sleep(1); while (true) {}'));
    expect(async.error).toBe('request tests: Script timed out after 400 ms');
    expect(async.variables).toEqual({
      environment: script('').variables.environment,
      collection: script('').variables.collection,
      runtime: script('').variables.runtime,
      request: script('').variables.request,
    });
    const pending = await box.run(script('setTimeout(() => {}, 60000)'));
    expect(pending.error).toBe('request tests: Script timed out after 400 ms');
    const next = await box.run(script("console.log('respawned')"));
    expect(next.error).toBeUndefined();
    expect(next.logs[0]!.message).toBe('respawned');
  });

  it('stops a script that exhausts its memory', async () => {
    const box = sandbox({ memoryMb: 32, timeoutMs: 30_000 });
    const output = await box.run(
      script("const keep = []; while (true) keep.push(new Array(100000).fill('x' + keep.length));"),
    );
    expect(output.error).toBe('request tests: Script ran out of memory (limit 32 MB)');
    expect((await box.run(script("console.log('fine')"))).logs[0]!.message).toBe('fine');
  }, 40_000);
});

describe('ScriptSandbox isolation', () => {
  it('does not leak the parent environment to scripts', async () => {
    process.env.SECRET_FOR_TEST = 'top-secret-value';
    const box = sandbox();
    const output = await box.run(
      script(`
        const found = [];
        const tryIt = (label, fn) => { try { found.push(label + ':' + JSON.stringify(fn())); } catch (e) { found.push(label + ':' + e.constructor.name); } };
        tryIt('getProcessEnv', () => adk.getProcessEnv('SECRET_FOR_TEST'));
        tryIt('process', () => process.env.SECRET_FOR_TEST);
        tryIt('globalThis', () => globalThis.process.env.SECRET_FOR_TEST);
        tryIt('this', () => this.constructor.constructor('return process')().env.SECRET_FOR_TEST);
        tryIt('Buffer', () => Buffer.constructor('return process.env')().SECRET_FOR_TEST);
        tryIt('bridge fn', () => require('crypto').createHash.constructor('return process.env')());
        tryIt('url', () => URL.constructor('return process')().env);
        tryIt('interpolate', () => adk.interpolate('{{SECRET_FOR_TEST}} {{process.env.SECRET_FOR_TEST}}'));
        tryIt('eval', () => eval('typeof process'));
        tryIt('import', () => import('node:process'));
        console.log(found.join('\\n'));
      `),
    );
    const text = output.logs.map((log) => log.message).join('\n');
    expect(text).not.toContain('top-secret-value');
    expect(text).toContain('Buffer:EvalError');
    expect(text).toContain('bridge fn:EvalError');
    expect(text).toContain('eval:"undefined"');
  });

  it('starts the child with an empty environment and the permission model', async () => {
    process.env.SECRET_FOR_TEST = 'top-secret-value';
    // The probe stands in for code that fully escaped the vm: it runs in the child's main realm with `require`.
    const probe = `(function (require) {
      const result = { env: Object.keys(process.env) };
      const attempt = (name, fn) => { try { fn(); result[name] = 'ALLOWED'; } catch (error) { result[name] = error.code || error.message; } };
      attempt('readFile', () => require('node:fs').readFileSync(${JSON.stringify(process.execPath)}));
      attempt('readDir', () => require('node:fs').readdirSync('.'));
      attempt('writeFile', () => require('node:fs').writeFileSync('adk-escape.txt', 'x'));
      attempt('spawn', () => require('node:child_process').execFileSync(process.execPath, ['-v']));
      attempt('worker', () => new (require('node:worker_threads').Worker)('1', { eval: true }));
      attempt('binding', () => process.binding('fs'));
      attempt('eval', () => eval('1'));
      attempt('function', () => new Function('return 1')());
      process.send(result, () => process.exit(0));
    })`;
    const child = spawn(process.execPath, scriptChildArguments(64), {
      env: scriptChildEnvironment(),
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    });
    const result = await new Promise<Record<string, unknown>>((resolve, reject) => {
      child.once('message', (message) => resolve(message as Record<string, unknown>));
      child.once('error', reject);
      child.send({ source: probe });
    });
    child.kill();
    expect(result.env).not.toContain('SECRET_FOR_TEST');
    // Windows (libuv) always adds these few non-secret variables to a child's environment.
    const allowed = [
      'HOMEDRIVE',
      'HOMEPATH',
      'LOGONSERVER',
      'PATH',
      'SYSTEMDRIVE',
      'SYSTEMROOT',
      'TEMP',
      'USERDOMAIN',
      'USERNAME',
      'USERPROFILE',
      'WINDIR',
    ];
    for (const name of result.env as string[]) expect(allowed).toContain(name.toUpperCase());
    expect(result).toMatchObject({
      readFile: 'ERR_ACCESS_DENIED',
      readDir: 'ERR_ACCESS_DENIED',
      writeFile: 'ERR_ACCESS_DENIED',
      spawn: 'ERR_ACCESS_DENIED',
      worker: 'ERR_ACCESS_DENIED',
      binding: 'ERR_ACCESS_DENIED',
      eval: 'Code generation from strings disallowed for this context',
      function: 'Code generation from strings disallowed for this context',
    });
  });

  it('builds the child flags and environment', () => {
    expect(permissionFlag('20.18.0')).toBe('--experimental-permission');
    expect(permissionFlag('22.12.0')).toBe('--experimental-permission');
    expect(permissionFlag('22.13.0')).toBe('--permission');
    expect(permissionFlag('23.4.0')).toBe('--experimental-permission');
    expect(permissionFlag('23.5.0')).toBe('--permission');
    expect(permissionFlag('24.0.0')).toBe('--permission');
    expect(permissionFlag('')).toBe('--experimental-permission');
    expect(scriptChildArguments(128, '24.1.0').slice(0, 4)).toEqual([
      '--permission',
      '--disallow-code-generation-from-strings',
      '--max-old-space-size=128',
      '--no-addons',
    ]);
    expect(scriptChildArguments(1)[2]).toBe('--max-old-space-size=16');
    expect(scriptChildEnvironment('linux', { DATABASE_URL: 'x', PATH: '/bin' })).toEqual({});
    expect(
      scriptChildEnvironment('win32', {
        SYSTEMROOT: 'C:\\Windows',
        windir: 'C:\\Windows',
        DATABASE_URL: 'x',
      }),
    ).toEqual({
      SystemRoot: 'C:\\Windows',
      windir: 'C:\\Windows',
    });
    expect(scriptChildEnvironment('win32', {})).toEqual({});
    expect(scriptChildEnvironment()).not.toHaveProperty('DATABASE_URL');
  });
});

describe('ScriptSandbox against a broken or hostile child', () => {
  const fakeChild = (program: string) => ['-e', program];
  // Answers each run with the messages listed (as JSON) in the script code.
  const scripted = `process.on('message', (m) => {
    if (m.source) { process.send(1); process.send([1]); process.send({ type: 'ready', isolated: true }); return; }
    if (m.type === 'send-result') { process.send({ type: 'stray', id: m.id }); return; }
    if (m.type !== 'run') return;
    for (const reply of JSON.parse(m.input.code)) process.send({ ...reply, id: reply.id === 'other' ? -1 : m.id });
  });`;

  it('validates and bounds everything the child sends back', async () => {
    override.args = fakeChild(scripted);
    const box = sandbox();
    const run = (replies: unknown[], overrides: Partial<ScriptInput> = {}) =>
      box.run(script(JSON.stringify(replies), overrides));
    const garbage = await run([
      { type: 'done', id: 'other', output: {} },
      { type: 'unknown' },
      {
        type: 'done',
        output: {
          variables: 5,
          tests: 'x',
          logs: {},
          hasNextRequest: true,
          nextRequest: 7,
          skipRequest: 'yes',
        },
        error: 5,
      },
    ]);
    expect(garbage).toEqual({
      request: script('').request,
      variables: {
        environment: script('').variables.environment,
        collection: script('').variables.collection,
        runtime: script('').variables.runtime,
        request: script('').variables.request,
      },
      tests: [],
      logs: [],
      nextRequest: null,
      skipRequest: false,
      stopExecution: false,
    });
    const shaped = await run(
      [
        {
          type: 'done',
          output: {
            request: {
              method: '',
              url: 'x'.repeat(70_000),
              headers: { a: 1, b: 'ok' },
              body: 5,
              timeoutMs: Number.NaN,
            },
            variables: { runtime: { ['k'.repeat(1_500)]: 'v', n: 5 }, environment: [] },
            tests: [
              { name: 5, passed: 'yes', error: 1 },
              'bad',
              { name: 'n', passed: true, error: 'e' },
            ],
            logs: [
              { level: 'evil', message: 5 },
              null,
              { level: 'warn', message: 'w', source: 'forged' },
            ],
            hasNextRequest: true,
            nextRequest: 'Next',
            skipRequest: true,
            stopExecution: true,
          },
          error: 'bad',
        },
      ],
      {
        phase: 'pre-request',
        request: { ...script('').request, body: undefined, timeoutMs: undefined },
      },
    );
    expect(shaped.request).toEqual({
      ...script('').request,
      body: undefined,
      timeoutMs: undefined,
      method: 'POST',
      url: 'x'.repeat(65_536),
      headers: { b: 'ok' },
    });
    expect(shaped.request).not.toHaveProperty('body');
    expect(shaped.variables.runtime).toEqual({ ['k'.repeat(1_000)]: 'v' });
    expect(shaped.variables.environment).toEqual(script('').variables.environment);
    expect(shaped.tests).toEqual([
      { name: '', passed: false },
      { name: 'n', passed: true, error: 'e' },
    ]);
    expect(shaped.logs).toEqual([
      { level: 'log', message: '', source: 'request tests' },
      { level: 'warn', message: 'w', source: 'request tests' },
    ]);
    expect(shaped).toMatchObject({
      nextRequest: 'Next',
      skipRequest: true,
      stopExecution: true,
      error: 'request tests: bad',
    });
    const partial = await run([{ type: 'done', output: { request: { method: 'DELETE' } } }], {
      phase: 'pre-request',
    });
    expect(partial.request).toMatchObject({ method: 'DELETE', url: script('').request.url });
    const keepsRequest = await run([{ type: 'done', output: { request: 'nope' } }], {
      phase: 'pre-request',
    });
    expect(keepsRequest.request).toEqual(script('').request);
    const sends = await run([
      { type: 'send', requestId: 1, request: 'nope' },
      {
        type: 'send',
        requestId: 2,
        request: { method: 'GET', url: 'https://a.test', headers: 'h', body: 'b', timeoutMs: -1 },
      },
      {
        type: 'send',
        requestId: 3,
        request: { method: 'GET', url: 'https://a.test', timeoutMs: 50 },
      },
      { type: 'done', output: {} },
    ]);
    expect(sends.error).toBeUndefined();
    // The child answers each send-result with a stray message, which arrives between scripts.
    await new Promise((resolve) => setTimeout(resolve, 200));
  });

  it('refuses a child without the permission model', async () => {
    override.args = fakeChild(
      `process.on('message', () => process.send({ type: 'ready', isolated: false }));`,
    );
    const output = await sandbox().run(script(''));
    expect(output.error).toBe(
      'request tests: Script sandbox could not enable the Node.js permission model',
    );
  });

  it('reports a child that exits during startup or during a script', async () => {
    override.args = fakeChild('process.exit(3)');
    expect((await sandbox().run(script(''))).error).toBe(
      'request tests: Script process exited unexpectedly',
    );
    override.args = fakeChild(
      `process.on('message', (m) => { if (m.source) process.send({ type: 'ready', isolated: true }); else process.exit(1); });`,
    );
    expect((await sandbox().run(script(''))).error).toBe(
      'request tests: Script process exited unexpectedly',
    );
  });

  it('gives up on a child that never becomes ready', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    override.args = fakeChild('setInterval(() => {}, 1000)');
    const pending = sandbox().run(script(''));
    await vi.advanceTimersByTimeAsync(15_000);
    expect((await pending).error).toBe('request tests: Script sandbox did not start');
  });

  it('refuses scripts after close and closes idempotently', async () => {
    const box = sandbox();
    await box.close();
    expect((await box.run(script(''))).error).toBe('request tests: Script sandbox is closed');
    const used = sandbox();
    await used.run(script(''));
    override.args = undefined;
    await used.close();
    await used.close();
    override.args = fakeChild('process.exit(0)');
    const dead = sandbox();
    await dead.run(script(''));
    await dead.close();
  });
});
