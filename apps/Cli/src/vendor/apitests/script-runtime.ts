// Program of the script child process (see script-sandbox.ts). Node built-ins only.
//
// The child is started with a tiny `-e` bootstrap that waits for the host program over IPC (the
// full source does not fit the Windows command line limit). The host program runs in the child's
// main realm; the prelude runs inside each script's vm context, so `adk`, `req`, `expect`... are
// objects of the script's own realm and only a few bridge functions belong to the main realm.
// Both are plain JavaScript in strings because they are evaluated in another process.

/** Name of the user script in stack traces; error line numbers are read from it. */
export const SCRIPT_FILENAME = 'adk-script.js';

/** Runs the host program received as the first IPC message, handing it `require`. */
export const SCRIPT_CHILD_BOOTSTRAP =
  "'use strict';process.once('message',function(m){require('node:vm').runInThisContext(m.source,{filename:'adk-script-host.js'})(require)})";

/** `--permission` became stable in Node 22.13 / 23.5; older versions only have the experimental flag. */
export function permissionFlag(version: string = process.versions.node): string {
  const [major = 0, minor = 0] = version.split('.').map(Number);
  const stable = major >= 24 || (major === 23 && minor >= 5) || (major === 22 && minor >= 13);
  return stable ? '--permission' : '--experimental-permission';
}

export function scriptChildArguments(memoryMb: number, version?: string): string[] {
  return [
    // No --allow-* flag: no file system, child processes, workers, addons, WASI or inspector.
    permissionFlag(version),
    // Blocks eval/new Function in the child's main realm, which closes the classic vm escape
    // (`this.constructor.constructor('return process')()`); script contexts re-enable it for
    // themselves through `codeGeneration`.
    '--disallow-code-generation-from-strings',
    `--max-old-space-size=${Math.max(16, Math.floor(memoryMb))}`,
    '--no-addons',
    '-e',
    SCRIPT_CHILD_BOOTSTRAP,
  ];
}

/** Only what Node needs to start: nothing of the parent's environment reaches the child. */
export function scriptChildEnvironment(
  platform: NodeJS.Platform = process.platform,
  parent: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  if (platform !== 'win32') return {};
  const environment: Record<string, string> = {};
  for (const name of ['SystemRoot', 'windir']) {
    const value = parent[name] ?? parent[name.toUpperCase()];
    if (value) environment[name] = value;
  }
  return environment;
}

/** Evaluated inside each script context: `(bridge, inputJson) => { finish, collect, log }`. */
export const SCRIPT_PRELUDE_SOURCE = String.raw`(function (bridge, inputJson) {
  'use strict';
  const input = JSON.parse(inputJson);
  const stringify = JSON.stringify;
  const parseJson = JSON.parse;
  const PromiseCtor = Promise;
  const allSettled = Promise.allSettled.bind(Promise);
  const arrayFrom = Array.from;
  const isArray = Array.isArray;
  const objectKeys = Object.keys;
  const defineProperty = Object.defineProperty;
  const hasOwn = Object.prototype.hasOwnProperty;
  const toTag = Object.prototype.toString;
  const LOG_LIMIT = 200;
  const LOG_SIZE = 10000;
  const TEST_LIMIT = 500;
  const phase = String(input.phase);
  const show = function (value) { return String(bridge.inspectShort(value)); };

  // ---- helpers ----
  function table(record) {
    const map = Object.create(null);
    if (record && typeof record === 'object') {
      for (const key of objectKeys(record)) map[key] = String(record[key]);
    }
    return map;
  }
  function plain(map) {
    const out = {};
    for (const key of objectKeys(map)) {
      defineProperty(out, key, { value: map[key], enumerable: true, writable: true, configurable: true });
    }
    return out;
  }
  function errorMessage(error) {
    try {
      if (error !== null && typeof error === 'object' && typeof error.message === 'string') return error.message;
      return String(error);
    } catch (e) {
      return 'Unknown error';
    }
  }
  function parseMaybeJson(text) {
    if (typeof text !== 'string' || text === '') return text;
    try { return parseJson(text); } catch (e) { return text; }
  }
  function bodyText(value) {
    if (value === undefined || value === null) return undefined;
    return typeof value === 'string' ? value : stringify(value);
  }
  function headerKey(headers, name) {
    const lower = String(name).toLowerCase();
    for (const key of objectKeys(headers)) if (key.toLowerCase() === lower) return key;
    return undefined;
  }
  function getHeader(headers, name) {
    const key = headerKey(headers, name);
    return key === undefined ? undefined : headers[key];
  }
  function setHeader(headers, name, value) {
    const existing = headerKey(headers, name);
    if (existing !== undefined) delete headers[existing];
    headers[String(name)] = String(value);
  }
  function deleteHeader(headers, name) {
    const key = headerKey(headers, name);
    if (key !== undefined) delete headers[key];
  }
  function headerTable(value) {
    const headers = Object.create(null);
    if (isArray(value)) {
      for (const item of value) {
        if (item && typeof item === 'object' && item.key !== undefined && !item.disabled) setHeader(headers, item.key, item.value);
        else if (typeof item === 'string' && item.indexOf(':') > 0) setHeader(headers, item.slice(0, item.indexOf(':')).trim(), item.slice(item.indexOf(':') + 1).trim());
      }
    } else if (value && typeof value === 'object') {
      for (const key of objectKeys(value)) if (value[key] !== undefined && value[key] !== null) setHeader(headers, key, value[key]);
    }
    return headers;
  }
  function query(data, path) {
    if (path === undefined || path === null || path === '') return data;
    const pattern = /\[\s*(?:(-?\d+)|'([^']*)'|"([^"]*)")\s*\]|([^.[\]]+)/g;
    let value = data;
    let match;
    const text = String(path);
    while ((match = pattern.exec(text))) {
      if (value === null || value === undefined) return undefined;
      if (match[1] !== undefined) {
        const index = Number(match[1]);
        value = isArray(value) && index < 0 ? value[value.length + index] : value[index];
      } else {
        value = value[match[2] !== undefined ? match[2] : match[3] !== undefined ? match[3] : match[4]];
      }
    }
    return value;
  }

  // ---- async bookkeeping: the script ends when everything it started has settled ----
  const pending = new Set();
  function track(promise) {
    pending.add(promise);
    const done = function () { pending.delete(promise); };
    promise.then(done, done);
    return promise;
  }
  async function idle() {
    while (pending.size > 0) await allSettled(arrayFrom(pending));
  }
  const timers = new Map();
  function setTimeoutShim(callback, ms) {
    if (typeof callback !== 'function') throw new TypeError('setTimeout expects a function');
    const args = arrayFrom(arguments).slice(2);
    let settle;
    track(new PromiseCtor(function (resolve) { settle = resolve; }));
    const id = bridge.setTimer(function () {
      timers.delete(id);
      try { callback.apply(undefined, args); } catch (error) { log('error', ['Uncaught error in setTimeout: ' + errorMessage(error)]); }
      settle();
    }, ms);
    timers.set(id, settle);
    return id;
  }
  function clearTimeoutShim(id) {
    const settle = timers.get(id);
    if (!settle) return;
    bridge.clearTimer(id);
    timers.delete(id);
    settle();
  }
  function sleep(ms) {
    return new PromiseCtor(function (resolve) { setTimeoutShim(resolve, ms); });
  }

  // ---- logs ----
  const logs = [];
  function log(level, args) {
    if (logs.length >= LOG_LIMIT) return;
    if (logs.length === LOG_LIMIT - 1) {
      logs.push({ level: 'warn', message: 'Log limit of ' + LOG_LIMIT + ' entries reached; later output was dropped' });
      return;
    }
    let message;
    try { message = String(bridge.format(arrayFrom(args))); } catch (error) { message = '[unprintable value]'; }
    if (message.length > LOG_SIZE) message = message.slice(0, LOG_SIZE) + '... (truncated)';
    logs.push({ level: level, message: message });
  }
  const consoleShim = {
    log: function () { log('log', arguments); },
    info: function () { log('info', arguments); },
    warn: function () { log('warn', arguments); },
    error: function () { log('error', arguments); },
    debug: function () { log('debug', arguments); },
    trace: function () { log('debug', arguments); },
    dir: function (value) { log('log', [value]); },
    table: function (value) { log('log', [value]); },
    assert: function (condition) {
      if (!condition) log('error', ['Assertion failed'].concat(arrayFrom(arguments).slice(1)));
    },
  };

  // ---- variables: runtime > data > request > folder > environment > collection ----
  const vars = input.variables || {};
  const scopes = {
    runtime: table(vars.runtime),
    data: table(vars.data),
    request: table(vars.request),
    folder: table(vars.folder),
    environment: table(vars.environment),
    collection: table(vars.collection),
  };
  const ORDER = ['runtime', 'data', 'request', 'folder', 'environment', 'collection'];
  function resolve(name) {
    const key = String(name);
    for (const scope of ORDER) if (key in scopes[scope]) return scopes[scope][key];
    return undefined;
  }
  function merged() {
    const out = {};
    for (let index = ORDER.length - 1; index >= 0; index -= 1) {
      const map = scopes[ORDER[index]];
      for (const key of objectKeys(map)) defineProperty(out, key, { value: map[key], enumerable: true, writable: true, configurable: true });
    }
    return out;
  }
  // Values are stored as strings: objects as JSON text, other values with String().
  function write(map, name, value) {
    const key = String(name);
    if (value === undefined) delete map[key];
    else map[key] = typeof value === 'string' ? value : value !== null && typeof value === 'object' ? stringify(value) : String(value);
  }
  function read(map, name) {
    const key = String(name);
    return key in map ? map[key] : undefined;
  }
  function clear(map) {
    for (const key of objectKeys(map)) delete map[key];
  }
  function interpolate(value) {
    if (typeof value === 'string') {
      return value.replace(/\{\{([^{}]+)\}\}/g, function (match, raw) {
        const name = raw.trim();
        if (name.charAt(0) === '$') return match;
        const found = resolve(name);
        return found === undefined ? match : found;
      });
    }
    if (value !== null && typeof value === 'object') {
      try { return parseJson(interpolate(stringify(value))); } catch (error) { return value; }
    }
    return value;
  }

  // ---- request ----
  const source = input.request || {};
  const request = {
    method: String(source.method || 'GET'),
    url: String(source.url || ''),
    headers: table(source.headers),
    body: source.body === undefined || source.body === null ? undefined : String(source.body),
    timeoutMs: typeof source.timeoutMs === 'number' ? source.timeoutMs : undefined,
  };
  const req = {
    getUrl: function () { return request.url; },
    setUrl: function (url) { request.url = String(url); },
    getMethod: function () { return request.method; },
    setMethod: function (method) { request.method = String(method).toUpperCase(); },
    getName: function () { return String(source.name || ''); },
    getHeader: function (name) { return getHeader(request.headers, name); },
    getHeaders: function () { return plain(request.headers); },
    setHeader: function (name, value) { setHeader(request.headers, name, value); },
    setHeaders: function (headers) {
      clear(request.headers);
      const next = headerTable(headers);
      for (const key of objectKeys(next)) request.headers[key] = next[key];
    },
    deleteHeader: function (name) { deleteHeader(request.headers, name); },
    getBody: function () { return parseMaybeJson(request.body); },
    setBody: function (body) { request.body = bodyText(body); },
    getTimeout: function () { return request.timeoutMs; },
    setTimeout: function (ms) { request.timeoutMs = Number(ms); },
    getAuthMode: function () { return String(source.authType || 'none'); },
  };
  Object.defineProperties(req, {
    url: { get: function () { return request.url; }, set: function (v) { request.url = String(v); }, enumerable: true },
    method: { get: function () { return request.method; }, set: function (v) { request.method = String(v).toUpperCase(); }, enumerable: true },
    headers: { get: function () { return plain(request.headers); }, enumerable: true },
    body: { get: function () { return parseMaybeJson(request.body); }, set: function (v) { request.body = bodyText(v); }, enumerable: true },
    timeout: { get: function () { return request.timeoutMs; }, enumerable: true },
    name: { get: function () { return String(source.name || ''); }, enumerable: true },
  });

  // ---- response ----
  const response = input.response;
  let res;
  if (response && typeof response === 'object') {
    const responseHeaders = table(response.headers);
    const responseBody = parseMaybeJson(String(response.body === undefined ? '' : response.body));
    const headerSize = objectKeys(responseHeaders).reduce(function (sum, key) { return sum + key.length + responseHeaders[key].length + 4; }, 0);
    res = function res(path) { return query(responseBody, path); };
    const responseApi = {
      status: response.status,
      statusText: String(response.statusText || ''),
      headers: plain(responseHeaders),
      body: responseBody,
      responseTime: response.durationMs,
      getStatus: function () { return response.status; },
      getStatusText: function () { return String(response.statusText || ''); },
      getHeader: function (name) { return getHeader(responseHeaders, name); },
      getHeaders: function () { return plain(responseHeaders); },
      getBody: function () { return responseBody; },
      getResponseTime: function () { return response.durationMs; },
      getSize: function () { return { header: headerSize, body: response.sizeBytes, total: headerSize + response.sizeBytes }; },
    };
    for (const key of objectKeys(responseApi)) {
      defineProperty(res, key, { value: responseApi[key], enumerable: true, writable: true, configurable: true });
    }
  }

  // ---- chai-compatible expect / assert ----
  const STATE = Symbol('assertion');
  const P = {};
  function AssertionError(message) {
    const error = new Error(message);
    error.name = 'AssertionError';
    return error;
  }
  function typeOf(value) {
    if (value === null) return 'null';
    if (isArray(value)) return 'array';
    const type = typeof value;
    if (type !== 'object') return type;
    return toTag.call(value).slice(8, -1).toLowerCase();
  }
  function deepEqual(a, b, seen) {
    if (a === b) return true;
    if (a !== a && b !== b) return true;
    if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
    const tag = toTag.call(a);
    if (tag !== toTag.call(b)) return false;
    const pairs = seen || [];
    for (const pair of pairs) if (pair[0] === a && pair[1] === b) return true;
    pairs.push([a, b]);
    if (tag === '[object Date]') return a.getTime() === b.getTime();
    if (tag === '[object RegExp]') return String(a) === String(b);
    if (tag === '[object Map]' || tag === '[object Set]') {
      if (a.size !== b.size) return false;
      const left = arrayFrom(a.entries());
      const right = arrayFrom(b.entries());
      return left.every(function (entry) { return right.some(function (other) { return deepEqual(entry, other, pairs); }); });
    }
    if (isArray(a)) {
      if (a.length !== b.length) return false;
      for (let index = 0; index < a.length; index += 1) if (!deepEqual(a[index], b[index], pairs)) return false;
      return true;
    }
    const keys = objectKeys(a);
    if (keys.length !== objectKeys(b).length) return false;
    return keys.every(function (key) { return hasOwn.call(b, key) && deepEqual(a[key], b[key], pairs); });
  }
  function sizeOf(value) {
    if (value instanceof Map || value instanceof Set) return value.size;
    return value === null || value === undefined ? undefined : value.length;
  }
  function state(self) { return self[STATE]; }
  function check(self, pass, message, negated) {
    const s = state(self);
    if (s.negate ? pass : !pass) throw AssertionError((s.message ? s.message + ': ' : '') + (s.negate ? negated : message));
    return self;
  }
  function getter(names, get) {
    for (const name of [].concat(names)) defineProperty(P, name, { get: get, configurable: true });
  }
  function method(names, fn) {
    for (const name of [].concat(names)) defineProperty(P, name, { value: fn, writable: true, configurable: true });
  }
  // Callable and chainable at once, like chai's include / length.
  function chainable(names, fn, flag) {
    getter(names, function () {
      const s = state(this);
      if (flag) flag(s);
      const call = function () { return fn.apply(call, arguments); };
      // Own length / name of the function would hide the chain properties of the same names.
      delete call.length;
      delete call.name;
      Object.setPrototypeOf(call, P);
      call[STATE] = s;
      return call;
    });
  }
  function expect(value, message) {
    const assertion = Object.create(P);
    assertion[STATE] = { value: value, message: message, negate: false, deep: false, own: false, contains: false, any: false, length: false };
    return assertion;
  }
  getter(['to', 'be', 'been', 'is', 'that', 'which', 'and', 'has', 'have', 'with', 'at', 'of', 'same', 'does', 'but', 'also', 'itself'], function () { return this; });
  getter('not', function () { state(this).negate = !state(this).negate; return this; });
  getter('deep', function () { state(this).deep = true; return this; });
  getter('own', function () { state(this).own = true; return this; });
  getter('any', function () { state(this).any = true; return this; });
  getter('all', function () { state(this).any = false; return this; });
  function not(s) { return s.negate ? 'not ' : ''; }
  method(['equal', 'equals', 'eq'], function (expected) {
    const s = state(this);
    const pass = s.deep ? deepEqual(s.value, expected) : s.value === expected;
    const word = s.deep ? 'deeply equal ' : 'equal ';
    return check(this, pass, 'expected ' + show(s.value) + ' to ' + word + show(expected), 'expected ' + show(s.value) + ' to not ' + word + show(expected));
  });
  method(['eql', 'eqls'], function (expected) {
    const s = state(this);
    return check(this, deepEqual(s.value, expected), 'expected ' + show(s.value) + ' to deeply equal ' + show(expected), 'expected ' + show(s.value) + ' to not deeply equal ' + show(expected));
  });
  method(['a', 'an'], function (type) {
    const s = state(this);
    const expected = String(type).toLowerCase();
    const article = /^[aeiou]/.test(expected) ? 'an ' : 'a ';
    return check(this, typeOf(s.value) === expected, 'expected ' + show(s.value) + ' to be ' + article + expected, 'expected ' + show(s.value) + ' not to be ' + article + expected);
  });
  function includes(s, expected) {
    const value = s.value;
    const same = function (a, b) { return s.deep ? deepEqual(a, b) : a === b; };
    if (typeof value === 'string') return value.indexOf(String(expected)) !== -1;
    if (isArray(value)) return value.some(function (item) { return same(item, expected); });
    if (value instanceof Set) return arrayFrom(value).some(function (item) { return same(item, expected); });
    if (value instanceof Map) return arrayFrom(value.values()).some(function (item) { return same(item, expected); });
    if (value !== null && typeof value === 'object' && expected !== null && typeof expected === 'object') {
      return objectKeys(expected).every(function (key) { return key in value && same(value[key], expected[key]); });
    }
    return false;
  }
  chainable(['include', 'includes', 'contain', 'contains'], function (expected) {
    const s = state(this);
    return check(this, includes(s, expected), 'expected ' + show(s.value) + ' to ' + (s.deep ? 'deep ' : '') + 'include ' + show(expected), 'expected ' + show(s.value) + ' to not ' + (s.deep ? 'deep ' : '') + 'include ' + show(expected));
  }, function (s) { s.contains = true; });
  method('property', function (name, value) {
    const s = state(this);
    const target = s.value;
    const key = typeof name === 'symbol' ? name : String(name);
    const has = target !== null && target !== undefined && (s.own ? hasOwn.call(target, key) : key in Object(target));
    const actual = has ? target[key] : undefined;
    const kind = (s.deep ? 'deep ' : '') + (s.own ? 'own ' : '') + 'property ';
    if (arguments.length > 1) {
      const pass = has && (s.deep ? deepEqual(actual, value) : actual === value);
      check(this, pass, 'expected ' + show(target) + ' to have ' + kind + show(key) + ' of ' + show(value) + ', but got ' + show(actual), 'expected ' + show(target) + ' to not have ' + kind + show(key) + ' of ' + show(value));
    } else {
      check(this, has, 'expected ' + show(target) + ' to have ' + kind + show(key), 'expected ' + show(target) + ' to not have ' + kind + show(key));
    }
    s.value = actual;
    return this;
  });
  method(['ownProperty', 'haveOwnProperty'], function () {
    state(this).own = true;
    return P.property.apply(this, arguments);
  });
  chainable(['length', 'lengthOf'], function (expected) {
    const s = state(this);
    const actual = sizeOf(s.value);
    return check(this, actual === expected, 'expected ' + show(s.value) + ' to have a length of ' + show(expected) + ' but got ' + show(actual), 'expected ' + show(s.value) + ' to not have a length of ' + show(expected));
  }, function (s) { s.length = true; });
  function flagCheck(names, test, word) {
    getter(names, function () {
      const s = state(this);
      return check(this, test(s.value), 'expected ' + show(s.value) + ' to ' + word, 'expected ' + show(s.value) + ' to not ' + word);
    });
  }
  flagCheck('ok', function (v) { return !!v; }, 'be truthy');
  flagCheck('true', function (v) { return v === true; }, 'be true');
  flagCheck('false', function (v) { return v === false; }, 'be false');
  flagCheck('null', function (v) { return v === null; }, 'be null');
  flagCheck('undefined', function (v) { return v === undefined; }, 'be undefined');
  flagCheck('NaN', function (v) { return typeof v === 'number' && v !== v; }, 'be NaN');
  flagCheck(['exist', 'exists'], function (v) { return v !== null && v !== undefined; }, 'exist');
  flagCheck('empty', function (v) {
    if (typeof v === 'string' || isArray(v)) return v.length === 0;
    if (v instanceof Map || v instanceof Set) return v.size === 0;
    return v !== null && typeof v === 'object' && objectKeys(v).length === 0;
  }, 'be empty');
  function compare(names, word, test) {
    method(names, function (expected) {
      const s = state(this);
      if (s.length) {
        const size = sizeOf(s.value);
        return check(this, test(size, expected), 'expected ' + show(s.value) + ' to have a length ' + word + ' ' + show(expected) + ' but got ' + show(size), 'expected ' + show(s.value) + ' to not have a length ' + word + ' ' + show(expected));
      }
      return check(this, test(s.value, expected), 'expected ' + show(s.value) + ' to be ' + word + ' ' + show(expected), 'expected ' + show(s.value) + ' to not be ' + word + ' ' + show(expected));
    });
  }
  compare(['above', 'gt', 'greaterThan'], 'above', function (a, b) { return a > b; });
  compare(['below', 'lt', 'lessThan'], 'below', function (a, b) { return a < b; });
  compare(['least', 'gte', 'greaterThanOrEqual'], 'at least', function (a, b) { return a >= b; });
  compare(['most', 'lte', 'lessThanOrEqual'], 'at most', function (a, b) { return a <= b; });
  method('within', function (low, high) {
    const s = state(this);
    const actual = s.length ? sizeOf(s.value) : s.value;
    const range = show(low) + '..' + show(high);
    return check(this, actual >= low && actual <= high, 'expected ' + show(s.value) + ' to be within ' + range, 'expected ' + show(s.value) + ' to not be within ' + range);
  });
  method(['closeTo', 'approximately'], function (expected, delta) {
    const s = state(this);
    return check(this, Math.abs(s.value - expected) <= delta, 'expected ' + show(s.value) + ' to be close to ' + show(expected) + ' +/- ' + show(delta), 'expected ' + show(s.value) + ' not to be close to ' + show(expected) + ' +/- ' + show(delta));
  });
  method(['match', 'matches'], function (pattern) {
    const s = state(this);
    return check(this, pattern.test(String(s.value)), 'expected ' + show(s.value) + ' to match ' + show(pattern), 'expected ' + show(s.value) + ' not to match ' + show(pattern));
  });
  method('string', function (text) {
    const s = state(this);
    return check(this, String(s.value).indexOf(text) !== -1, 'expected ' + show(s.value) + ' to contain ' + show(text), 'expected ' + show(s.value) + ' to not contain ' + show(text));
  });
  method('oneOf', function (list) {
    const s = state(this);
    const pass = arrayFrom(list).some(function (item) { return s.deep ? deepEqual(item, s.value) : item === s.value; });
    return check(this, pass, 'expected ' + show(s.value) + ' to be one of ' + show(list), 'expected ' + show(s.value) + ' to not be one of ' + show(list));
  });
  method(['keys', 'key'], function () {
    const s = state(this);
    const first = arguments[0];
    let expected = arguments.length === 1 && isArray(first) ? first
      : arguments.length === 1 && first !== null && typeof first === 'object' ? objectKeys(first)
      : arrayFrom(arguments);
    expected = expected.map(String);
    const actual = s.value instanceof Map ? arrayFrom(s.value.keys()).map(String) : objectKeys(Object(s.value));
    const present = function (key) { return actual.indexOf(key) !== -1; };
    const pass = s.any ? expected.some(present)
      : s.contains ? expected.every(present)
      : expected.length === actual.length && expected.every(present);
    const list = expected.map(show).join(', ');
    const word = s.any ? 'have any of keys ' : s.contains ? 'contain keys ' : 'have keys ';
    return check(this, pass, 'expected ' + show(s.value) + ' to ' + word + list, 'expected ' + show(s.value) + ' to not ' + word + list);
  });
  method('members', function (list) {
    const s = state(this);
    const actual = arrayFrom(s.value || []);
    const expected = arrayFrom(list);
    const same = function (a, b) { return s.deep ? deepEqual(a, b) : a === b; };
    const covers = function (from, to) { return from.every(function (item) { return to.some(function (other) { return same(item, other); }); }); };
    const pass = s.contains ? covers(expected, actual) : actual.length === expected.length && covers(expected, actual) && covers(actual, expected);
    const word = s.contains ? 'be a superset of ' : 'have the same members as ';
    return check(this, pass, 'expected ' + show(s.value) + ' to ' + word + show(list), 'expected ' + show(s.value) + ' to not ' + word + show(list));
  });
  method(['instanceOf', 'instanceof'], function (constructor) {
    const s = state(this);
    const name = constructor && constructor.name ? constructor.name : 'the constructor';
    return check(this, s.value instanceof constructor, 'expected ' + show(s.value) + ' to be an instance of ' + name, 'expected ' + show(s.value) + ' to not be an instance of ' + name);
  });
  method(['throw', 'throws', 'Throw'], function (expected, text) {
    const s = state(this);
    let thrown = false;
    let error;
    try { s.value(); } catch (e) { thrown = true; error = e; }
    let pass = thrown;
    let detail = '';
    if (thrown && typeof expected === 'function') { pass = error instanceof expected; detail = ' ' + (expected.name || 'error'); }
    if (thrown && expected instanceof RegExp) { pass = expected.test(errorMessage(error)); detail = ' matching ' + show(expected); }
    if (thrown && typeof expected === 'string') { pass = errorMessage(error).indexOf(expected) !== -1; detail = ' including ' + show(expected); }
    if (pass && text !== undefined) {
      pass = text instanceof RegExp ? text.test(errorMessage(error)) : errorMessage(error).indexOf(String(text)) !== -1;
      detail += ' with message ' + show(text);
    }
    return check(this, pass, 'expected [Function] to throw an error' + detail, 'expected [Function] to not throw an error' + detail + (thrown ? ' but ' + show(errorMessage(error)) + ' was thrown' : ''));
  });
  method('satisfy', function (predicate) {
    const s = state(this);
    return check(this, !!predicate(s.value), 'expected ' + show(s.value) + ' to satisfy ' + show(predicate), 'expected ' + show(s.value) + ' to not satisfy ' + show(predicate));
  });
  expect.fail = function (message) { throw AssertionError(message === undefined ? 'expect.fail()' : String(message)); };

  function assert(value, message) {
    if (!value) throw AssertionError(message || 'expected ' + show(value) + ' to be truthy');
  }
  function assertWith(pass, message, fallback) {
    if (!pass) throw AssertionError(message || fallback);
  }
  assert.ok = assert;
  assert.isOk = assert;
  assert.equal = function (a, b, m) { assertWith(a == b, m, 'expected ' + show(a) + ' to equal ' + show(b)); };
  assert.notEqual = function (a, b, m) { assertWith(a != b, m, 'expected ' + show(a) + ' to not equal ' + show(b)); };
  assert.strictEqual = function (a, b, m) { assertWith(a === b, m, 'expected ' + show(a) + ' to equal ' + show(b)); };
  assert.notStrictEqual = function (a, b, m) { assertWith(a !== b, m, 'expected ' + show(a) + ' to not equal ' + show(b)); };
  assert.deepEqual = function (a, b, m) { assertWith(deepEqual(a, b), m, 'expected ' + show(a) + ' to deeply equal ' + show(b)); };
  assert.deepStrictEqual = assert.deepEqual;
  assert.notDeepEqual = function (a, b, m) { assertWith(!deepEqual(a, b), m, 'expected ' + show(a) + ' to not deeply equal ' + show(b)); };
  assert.isTrue = function (a, m) { assertWith(a === true, m, 'expected ' + show(a) + ' to be true'); };
  assert.isFalse = function (a, m) { assertWith(a === false, m, 'expected ' + show(a) + ' to be false'); };
  assert.isNull = function (a, m) { assertWith(a === null, m, 'expected ' + show(a) + ' to be null'); };
  assert.isUndefined = function (a, m) { assertWith(a === undefined, m, 'expected ' + show(a) + ' to be undefined'); };
  assert.exists = function (a, m) { assertWith(a !== null && a !== undefined, m, 'expected ' + show(a) + ' to exist'); };
  assert.include = function (a, b, m) { assertWith(includes({ value: a, deep: false }, b), m, 'expected ' + show(a) + ' to include ' + show(b)); };
  assert.fail = function (m) { throw AssertionError(m === undefined ? 'assert.fail()' : String(m)); };

  // ---- tests ----
  const tests = [];
  function test(name, fn) {
    if (tests.length >= TEST_LIMIT) return;
    const entry = { name: String(name), passed: true };
    tests.push(entry);
    const fail = function (error) { entry.passed = false; entry.error = errorMessage(error); };
    try {
      const result = typeof fn === 'function' ? fn() : undefined;
      if (result !== null && typeof result === 'object' && typeof result.then === 'function') {
        track(PromiseCtor.resolve(result).then(undefined, fail));
      }
    } catch (error) {
      fail(error);
    }
  }

  // ---- runner flags ----
  const flags = { hasNext: false, next: null, skip: false, stop: false };
  function setNextRequest(name) {
    flags.hasNext = true;
    flags.next = name === null || name === undefined ? null : String(name);
  }
  function skipRequest() { flags.skip = true; }
  function stopExecution() { flags.stop = true; }

  // ---- network through the parent ----
  function hostSend(options) {
    const promise = new PromiseCtor(function (resolveSend, rejectSend) {
      bridge.sendRequest(stringify(options)).then(
        function (text) { resolveSend(parseJson(text)); },
        function (error) { rejectSend(new Error(errorMessage(error))); }
      );
    });
    track(promise);
    return promise;
  }
  function withCallback(promise, callback, adapt) {
    if (typeof callback !== 'function') return promise;
    const report = function (error) { log('error', ['Uncaught error in sendRequest callback: ' + errorMessage(error)]); };
    return track(promise.then(
      function (result) { try { callback(null, result); } catch (error) { report(error); } return result; },
      function (error) { try { callback(error, null); } catch (inner) { report(inner); } return adapt(error); }
    ));
  }
  function pmHeaderList(headers) {
    return {
      get: function (name) { return getHeader(headers, name); },
      has: function (name) { return headerKey(headers, name) !== undefined; },
      toObject: function () { return plain(headers); },
      all: function () { return objectKeys(headers).map(function (key) { return { key: key, value: headers[key] }; }); },
      each: function (fn) { objectKeys(headers).forEach(function (key) { fn({ key: key, value: headers[key] }); }); },
    };
  }
  function pmResponse(r) {
    const headers = table(r.headers);
    return {
      code: r.status,
      status: r.statusText,
      headers: pmHeaderList(headers),
      responseTime: r.durationMs,
      responseSize: r.sizeBytes,
      json: function () { return parseJson(r.body); },
      text: function () { return r.body; },
      reason: function () { return r.statusText; },
    };
  }
  // One sendRequest for the option styles of both tools scripts come from: Bruno's
  // ({ headers, data }) and Postman's ({ header, url: { raw }, body: { mode, raw | urlencoded } }).
  // Its response answers both too: status (the code, as in Bruno) and code, data and json(),
  // body and text(), plain headers that also have Postman's get/has/toObject.
  function sendRequest(options, callback) {
    const o = typeof options === 'string' ? { url: options } : options || {};
    const headers = headerTable(o.header !== undefined ? o.header : o.headers);
    const spec = o.data !== undefined ? o.data : o.body;
    let body;
    if (spec && typeof spec === 'object' && typeof spec.mode === 'string') {
      if (spec.mode === 'raw') body = spec.raw === undefined ? undefined : String(spec.raw);
      else if (spec.mode === 'urlencoded') {
        body = arrayFrom(spec.urlencoded || []).filter(function (p) { return p && !p.disabled; }).map(function (p) {
          return encodeURIComponent(String(p.key)) + '=' + encodeURIComponent(p.value === undefined ? '' : String(p.value));
        }).join('&');
        if (headerKey(headers, 'content-type') === undefined) headers['Content-Type'] = 'application/x-www-form-urlencoded';
      }
    } else if (spec !== undefined && spec !== null && typeof spec !== 'string') {
      body = stringify(spec);
      if (headerKey(headers, 'content-type') === undefined) headers['Content-Type'] = 'application/json';
    } else if (typeof spec === 'string') body = spec;
    const url = o.url !== null && typeof o.url === 'object' && typeof o.url.raw === 'string' ? o.url.raw : String(o.url || '');
    const promise = hostSend({
      method: String(o.method || 'GET').toUpperCase(),
      url: url,
      headers: plain(headers),
      body: body,
      timeoutMs: o.timeout === undefined ? undefined : Number(o.timeout),
    }).then(function (r) {
      const answer = pmResponse({ status: r.status, statusText: r.statusText, headers: r.headers, body: r.body, durationMs: r.durationMs, sizeBytes: r.body.length });
      const headerBag = plain(table(r.headers));
      const list = answer.headers;
      for (const key of objectKeys(list)) defineProperty(headerBag, key, { value: list[key], enumerable: false, writable: true, configurable: true });
      answer.headers = headerBag;
      answer.status = r.status;
      answer.statusText = r.statusText;
      answer.data = parseMaybeJson(r.body);
      answer.body = r.body;
      return answer;
    });
    return withCallback(promise, callback, function () { return undefined; });
  }

  // ---- adk: variable scopes, request and response in Postman's shape ----
  function scopeApi(map) {
    return {
      get: function (name) { return read(map, name); },
      set: function (name, value) { write(map, name, value); },
      unset: function (name) { delete map[String(name)]; },
      has: function (name) { return String(name) in map; },
      clear: function () { clear(map); },
      toObject: function () { return plain(map); },
      replaceIn: interpolate,
    };
  }
  const environmentApi = scopeApi(scopes.environment);
  environmentApi.name = input.environmentName;
  const pmRequest = {
    headers: {
      get: function (name) { return getHeader(request.headers, name); },
      has: function (name) { return headerKey(request.headers, name) !== undefined; },
      add: function (h) { if (h && h.key !== undefined) setHeader(request.headers, h.key, h.value); },
      upsert: function (h) { if (h && h.key !== undefined) setHeader(request.headers, h.key, h.value); },
      remove: function (name) { deleteHeader(request.headers, name); },
      toObject: function () { return plain(request.headers); },
      all: function () { return objectKeys(request.headers).map(function (key) { return { key: key, value: request.headers[key] }; }); },
    },
    addHeader: function (h) { if (h && h.key !== undefined) setHeader(request.headers, h.key, h.value); },
    upsertHeader: function (h) { if (h && h.key !== undefined) setHeader(request.headers, h.key, h.value); },
    removeHeader: function (name) { deleteHeader(request.headers, name); },
    body: {},
  };
  Object.defineProperties(pmRequest, {
    url: {
      get: function () { return { toString: function () { return request.url; } }; },
      set: function (value) { request.url = String(value); },
      enumerable: true,
    },
    method: {
      get: function () { return request.method; },
      set: function (value) { request.method = String(value).toUpperCase(); },
      enumerable: true,
    },
    name: { get: function () { return String(source.name || ''); }, enumerable: true },
  });
  Object.defineProperties(pmRequest.body, {
    mode: { get: function () { return 'raw'; }, enumerable: true },
    raw: { get: function () { return request.body; }, set: function (value) { request.body = bodyText(value); }, enumerable: true },
    toString: { value: function () { return request.body === undefined ? '' : request.body; } },
  });
  let pmResponseApi;
  if (response && typeof response === 'object') {
    pmResponseApi = pmResponse({ status: response.status, statusText: String(response.statusText || ''), headers: response.headers, body: String(response.body === undefined ? '' : response.body), durationMs: response.durationMs, sizeBytes: response.sizeBytes });
    const statusCheck = function (pass, message) { if (!pass) throw AssertionError(message); };
    const code = response.status;
    const range = function (low, high, label) {
      return { get: function () { statusCheck(code >= low && code <= high, 'expected response code to be ' + label + ' but got ' + code); return pmResponseApi.to; } };
    };
    const exact = function (expected, label) {
      return { get: function () { statusCheck(code === expected, 'expected response to be ' + label + ' but got ' + code); return pmResponseApi.to; } };
    };
    const be = {};
    Object.defineProperties(be, {
      ok: range(200, 299, '2XX'),
      success: range(200, 299, '2XX'),
      error: range(400, 599, '4XX or 5XX'),
      clientError: range(400, 499, '4XX'),
      serverError: range(500, 599, '5XX'),
      badRequest: exact(400, 'bad request'),
      unauthorized: exact(401, 'unauthorized'),
      forbidden: exact(403, 'forbidden'),
      notFound: exact(404, 'not found'),
      json: { get: function () { try { parseJson(String(response.body)); } catch (error) { throw AssertionError('expected response body to be a valid json'); } return pmResponseApi.to; } },
    });
    pmResponseApi.to = {
      be: be,
      have: {
        status: function (expected) {
          if (typeof expected === 'string') statusCheck(String(response.statusText) === expected, 'expected response to have status reason ' + show(expected) + ' but got ' + show(response.statusText));
          else statusCheck(code === expected, 'expected response to have status code ' + show(expected) + ' but got ' + show(code));
        },
        header: function (name, value) {
          const actual = getHeader(table(response.headers), name);
          statusCheck(actual !== undefined, 'expected response to have header ' + show(name));
          if (arguments.length > 1) statusCheck(actual === String(value), 'expected response header ' + show(name) + ' to be ' + show(value) + ' but got ' + show(actual));
        },
        body: function (expected) {
          const text = String(response.body === undefined ? '' : response.body);
          if (expected === undefined) statusCheck(text.length > 0, 'expected response to have content in body');
          else if (expected instanceof RegExp) statusCheck(expected.test(text), 'expected response body to match ' + show(expected));
          else statusCheck(text === String(expected), 'expected response body to equal ' + show(expected));
        },
        jsonBody: function (path, value) {
          let data;
          try { data = parseJson(String(response.body)); } catch (error) { throw AssertionError('expected response body to be a valid json'); }
          if (path === undefined) return;
          if (path !== null && typeof path === 'object') { statusCheck(deepEqual(data, path), 'expected response body json to equal ' + show(path)); return; }
          const found = query(data, path);
          statusCheck(found !== undefined, 'expected ' + show(data) + ' to have property ' + show(path));
          if (arguments.length > 1) statusCheck(deepEqual(found, value), 'expected response body json at ' + show(path) + ' to contain ' + show(value));
        },
      },
    };
  }
  const execution = { setNextRequest: setNextRequest, skipRequest: skipRequest };
  const iteration = input.iteration || {};
  const runtimeApi = scopeApi(scopes.runtime);
  // ---- adk ----
  // The one API object of ADK scripts. It answers the calls scripts bring from other tools once
  // their object is renamed to adk (imports do it): Bruno's bru (getVar, setVar, runner...),
  // Postman's pm (environment, variables, response.to...) and its legacy postman object.
  const adk = {
    // Variables, Bruno style
    getEnvName: function () { return input.environmentName === undefined ? undefined : String(input.environmentName); },
    getEnvVar: function (name) { return read(scopes.environment, name); },
    setEnvVar: function (name, value) { write(scopes.environment, name, value); },
    hasEnvVar: function (name) { return String(name) in scopes.environment; },
    deleteEnvVar: function (name) { delete scopes.environment[String(name)]; },
    getAllEnvVars: function () { return plain(scopes.environment); },
    getVar: function (name) { return read(scopes.runtime, name); },
    setVar: function (name, value) { write(scopes.runtime, name, value); },
    hasVar: function (name) { return String(name) in scopes.runtime; },
    deleteVar: function (name) { delete scopes.runtime[String(name)]; },
    deleteAllVars: function () { clear(scopes.runtime); },
    getAllVars: function () { return plain(scopes.runtime); },
    getCollectionVar: function (name) { return read(scopes.collection, name); },
    setCollectionVar: function (name, value) { write(scopes.collection, name, value); },
    hasCollectionVar: function (name) { return String(name) in scopes.collection; },
    deleteCollectionVar: function (name) { delete scopes.collection[String(name)]; },
    getFolderVar: function (name) { return read(scopes.folder, name); },
    getRequestVar: function (name) { return read(scopes.request, name); },
    getCollectionName: function () { return String(input.collectionName || ''); },
    getProcessEnv: function () { return undefined; },
    interpolate: interpolate,
    sleep: sleep,
    cwd: function () { return ''; },
    isSafeMode: function () { return true; },
    // Variables, Postman style
    environment: environmentApi,
    collectionVariables: scopeApi(scopes.collection),
    globals: runtimeApi,
    variables: {
      get: function (name) { return resolve(name); },
      set: function (name, value) { write(scopes.runtime, name, value); },
      has: function (name) { return resolve(name) !== undefined; },
      unset: function (name) { delete scopes.runtime[String(name)]; },
      toObject: merged,
      replaceIn: interpolate,
    },
    iterationData: {
      get: function (name) { return read(scopes.data, name); },
      has: function (name) { return String(name) in scopes.data; },
      toObject: function () { return plain(scopes.data); },
    },
    getEnvironmentVariable: environmentApi.get,
    setEnvironmentVariable: environmentApi.set,
    clearEnvironmentVariable: environmentApi.unset,
    getGlobalVariable: runtimeApi.get,
    setGlobalVariable: runtimeApi.set,
    clearGlobalVariable: runtimeApi.unset,
    // Request, response and checks (req, res, test and expect are also globals)
    request: pmRequest,
    response: pmResponseApi,
    test: test,
    expect: expect,
    sendRequest: sendRequest,
    info: {
      requestName: String(source.name || ''),
      requestId: String(source.id || ''),
      iteration: typeof iteration.index === 'number' ? iteration.index : 0,
      iterationCount: typeof iteration.total === 'number' ? iteration.total : 1,
      eventName: phase === 'pre-request' ? 'prerequest' : 'test',
    },
    // Flow of the run
    setNextRequest: setNextRequest,
    runner: { setNextRequest: setNextRequest, skipRequest: skipRequest, stopExecution: stopExecution },
    execution: execution,
  };

  // ---- require ----
  const chai = { expect: expect, assert: assert };
  function requireShim(name) {
    const key = String(name);
    if (key === 'chai') return chai;
    if (hasOwn.call(bridge.modules, key)) return bridge.modules[key];
    throw new Error("Module '" + key + "' is not available in ADK scripts");
  }

  // ---- globals ----
  const globals = {
    console: consoleShim,
    adk: adk,
    // Scripts saved before adk replaced them keep running; new and imported ones use adk.
    bru: adk,
    pm: adk,
    postman: adk,
    req: req,
    res: res,
    test: test,
    expect: expect,
    assert: assert,
    require: requireShim,
    setTimeout: setTimeoutShim,
    clearTimeout: clearTimeoutShim,
  };
  for (const key of objectKeys(bridge.globals)) globals[key] = bridge.globals[key];
  for (const key of objectKeys(globals)) {
    defineProperty(globalThis, key, { value: globals[key], writable: true, configurable: true, enumerable: false });
  }

  async function finish(promise) {
    let failed = false;
    let error;
    try { await promise; } catch (thrown) { failed = true; error = thrown; }
    try { await idle(); } catch (ignored) { /* idle only waits */ }
    return { failed: failed, error: error };
  }
  function collect() {
    return stringify({
      request: request,
      variables: { environment: scopes.environment, collection: scopes.collection, runtime: scopes.runtime, request: scopes.request },
      tests: tests,
      logs: logs,
      hasNextRequest: flags.hasNext,
      nextRequest: flags.next,
      skipRequest: flags.skip,
      stopExecution: flags.stop,
    });
  }
  return { finish: finish, collect: collect, log: function (level, message) { log(level, [message]); } };
})`;

/** Host program in the child's main realm; called with `require` by the bootstrap. */
const HOST_TEMPLATE = String.raw`(function (require) {
  'use strict';
  const vm = require('node:vm');
  const util = require('node:util');
  const nodeCrypto = require('node:crypto');
  const { Buffer } = require('node:buffer');
  const querystring = require('node:querystring');
  const PRELUDE = __PRELUDE__;
  const SCRIPT_FILE = __SCRIPT_FILE__;
  const proc = process;
  const send = function (message) { if (proc.connected) proc.send(message); };

  // Nothing of the parent's environment is meant to be here; clear what the OS added anyway.
  for (const key of Object.keys(proc.env)) delete proc.env[key];
  for (const name of ['require', 'module', 'exports', '__filename', '__dirname', 'fetch', 'WebSocket', 'EventSource']) {
    try { delete globalThis[name]; } catch (error) { /* not configurable */ }
  }
  for (const name of ['getBuiltinModule', 'binding', '_linkedBinding', 'dlopen', 'mainModule']) {
    try { delete proc[name]; } catch (error) { /* not configurable */ }
  }

  const permission = proc.permission;
  const isolated = !!permission && typeof permission.has === 'function' &&
    !permission.has('fs.read') && !permission.has('fs.write') && !permission.has('child') && !permission.has('worker');

  let current = null;

  function setTimer(callback, ms) {
    const run = current;
    if (!run) throw new Error('No script is running');
    const key = run.nextKey++;
    const delay = Math.min(Math.max(Number(ms) || 0, 0), 2147483647);
    const handle = setTimeout(function () {
      run.timers.delete(key);
      if (current === run) callback();
    }, delay);
    run.timers.set(key, handle);
    return key;
  }
  function clearTimer(key) {
    const run = current;
    if (!run) return;
    const handle = run.timers.get(key);
    if (handle !== undefined) clearTimeout(handle);
    run.timers.delete(key);
  }
  function sendRequest(json) {
    const run = current;
    if (!run) return Promise.reject('No script is running');
    let request;
    try { request = JSON.parse(String(json)); } catch (error) { return Promise.reject('Invalid request'); }
    const requestId = run.nextKey++;
    return new Promise(function (resolve, reject) {
      run.sends.set(requestId, { resolve: resolve, reject: reject });
      send({ type: 'send', id: run.id, requestId: requestId, request: request });
    });
  }
  function inspectShort(value) {
    let text;
    try {
      text = typeof value === 'string' ? "'" + value + "'" : util.inspect(value, { depth: 2, breakLength: Infinity, maxArrayLength: 20, maxStringLength: 200 });
    } catch (error) {
      text = '[value]';
    }
    return text.length > 300 ? text.slice(0, 300) + '...' : text;
  }
  function format(args) {
    return util.formatWithOptions.apply(util, [{ depth: 4, maxStringLength: 10000, maxArrayLength: 100 }].concat(args));
  }

  const cryptoModule = Object.freeze({
    createHash: function (algorithm, options) { return nodeCrypto.createHash(algorithm, options); },
    createHmac: function (algorithm, key, options) { return nodeCrypto.createHmac(algorithm, key, options); },
    randomBytes: function (size) { return nodeCrypto.randomBytes(Math.min(Number(size) || 0, 65536)); },
    randomUUID: function () { return nodeCrypto.randomUUID(); },
    timingSafeEqual: function (a, b) { return nodeCrypto.timingSafeEqual(a, b); },
    getRandomValues: function (array) { return nodeCrypto.getRandomValues(array); },
  });
  const bufferModule = Object.freeze({ Buffer: Buffer });
  const urlModule = Object.freeze({ URL: URL, URLSearchParams: URLSearchParams });
  const querystringModule = Object.freeze({
    parse: function (text, sep, eq) { return querystring.parse(text, sep, eq); },
    stringify: function (value, sep, eq) { return querystring.stringify(value, sep, eq); },
    escape: function (text) { return querystring.escape(text); },
    unescape: function (text) { return querystring.unescape(text); },
  });
  const utilModule = Object.freeze({
    format: function () { return util.format.apply(util, arguments); },
    inspect: function (value, options) { return util.inspect(value, options); },
  });
  const modules = Object.freeze({
    crypto: cryptoModule, 'node:crypto': cryptoModule,
    buffer: bufferModule, 'node:buffer': bufferModule,
    url: urlModule, 'node:url': urlModule,
    querystring: querystringModule, 'node:querystring': querystringModule,
    util: utilModule, 'node:util': utilModule,
  });
  const bridge = Object.freeze({
    inspectShort: inspectShort,
    format: format,
    setTimer: setTimer,
    clearTimer: clearTimer,
    sendRequest: sendRequest,
    modules: modules,
    globals: Object.freeze({
      URL: URL,
      URLSearchParams: URLSearchParams,
      TextEncoder: TextEncoder,
      TextDecoder: TextDecoder,
      atob: atob,
      btoa: btoa,
      Buffer: Buffer,
      structuredClone: structuredClone,
      crypto: Object.freeze({ randomUUID: cryptoModule.randomUUID, getRandomValues: cryptoModule.getRandomValues }),
    }),
  });

  function describe(error) {
    let message;
    let stack = '';
    try {
      message = error !== null && typeof error === 'object' && typeof error.message === 'string' ? error.message : String(error);
    } catch (ignored) {
      message = 'Script failed';
    }
    try { if (error !== null && typeof error === 'object' && typeof error.stack === 'string') stack = error.stack; } catch (ignored) { /* no stack */ }
    const at = new RegExp(SCRIPT_FILE.replace(/[.]/g, '\\.') + ':(\\d+)').exec(stack);
    const line = at ? Number(at[1]) : 0;
    return line > 0 ? message + ' (line ' + line + ')' : message;
  }
  function isTimeout(error) {
    try { return error !== null && typeof error === 'object' && error.code === 'ERR_SCRIPT_EXECUTION_TIMEOUT'; } catch (ignored) { return false; }
  }

  async function runScript(message) {
    if (current) return;
    const input = message.input;
    const timeoutMs = Number(message.timeoutMs);
    const run = { id: message.id, nextKey: 1, timers: new Map(), sends: new Map(), extraLogs: [] };
    current = run;
    let api;
    let error;
    try {
      const context = vm.createContext(Object.create(null), { name: 'ADK script', codeGeneration: { strings: true, wasm: false } });
      const factory = new vm.Script(PRELUDE, { filename: 'adk-prelude.js' }).runInContext(context);
      api = factory(bridge, JSON.stringify(input));
      const script = new vm.Script('(async function () {\n' + String(input.code) + '\n})()', { filename: SCRIPT_FILE, lineOffset: -1 });
      const promise = script.runInContext(context, { timeout: timeoutMs, breakOnSigint: false });
      const outcome = await api.finish(promise);
      if (outcome.failed) error = describe(outcome.error);
    } catch (thrown) {
      error = isTimeout(thrown) ? 'Script timed out after ' + timeoutMs + ' ms' : describe(thrown);
    }
    let output;
    try { if (api) output = JSON.parse(api.collect()); } catch (ignored) { output = undefined; }
    if (output && run.extraLogs.length > 0) output.logs = output.logs.concat(run.extraLogs);
    for (const handle of run.timers.values()) clearTimeout(handle);
    for (const pending of run.sends.values()) pending.reject('Script finished');
    current = null;
    send({ type: 'done', id: run.id, output: output, error: error });
  }

  function settleSend(message) {
    const run = current;
    if (!run || run.id !== message.id) return;
    const pending = run.sends.get(message.requestId);
    if (!pending) return;
    run.sends.delete(message.requestId);
    if (typeof message.error === 'string') pending.reject(message.error);
    else pending.resolve(JSON.stringify(message.response));
  }

  function report(prefix, reason) {
    if (current && current.extraLogs.length < 20) current.extraLogs.push({ level: 'error', message: prefix + describe(reason) });
  }
  proc.on('unhandledRejection', function (reason) { report('Unhandled promise rejection: ', reason); });
  proc.on('uncaughtException', function (error) { report('Uncaught error: ', error); });
  proc.on('disconnect', function () { proc.exit(0); });
  proc.on('message', function (message) {
    if (!message || typeof message !== 'object') return;
    if (message.type === 'run') void runScript(message);
    else if (message.type === 'send-result') settleSend(message);
  });
  send({ type: 'ready', isolated: isolated });
})`;

/** The host program sent to the child; the prelude and script file name are embedded as literals. */
export const SCRIPT_HOST_SOURCE = HOST_TEMPLATE.replace('__PRELUDE__', () =>
  JSON.stringify(SCRIPT_PRELUDE_SOURCE),
).replace('__SCRIPT_FILE__', () => JSON.stringify(SCRIPT_FILENAME));
