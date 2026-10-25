import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createDefaultState,
  derivedUrls,
  effectiveUrls,
  envSections,
  parseEnv,
  serializeEnv,
  stateFromEnv,
  validate,
  warnings,
} from '../public/model.js';

test('IPv6 hosts are bracketed in URLs, an empty host falls back to localhost', () => {
  assert.equal(derivedUrls({ ...createDefaultState(), host: '::1' }).webUrl, 'http://[::1]:8080');
  assert.equal(derivedUrls({ ...createDefaultState(), host: '[::1]' }).apiUrl, 'http://[::1]:3000');
  assert.equal(derivedUrls({ ...createDefaultState(), host: '  ' }).mcpUrl, 'http://localhost:3333');
});

test('empty custom URLs fall back to the derived ones', () => {
  const urls = effectiveUrls({ ...createDefaultState(), customUrls: true, webUrl: ' ', apiUrl: '', mcpUrl: '' });
  assert.deepEqual(urls, derivedUrls(createDefaultState()));
});

test('custom URLs must be http or https; the MCP URL only when MCP is on', () => {
  const base = { ...createDefaultState(), customUrls: true };
  const errors = validate({ ...base, webUrl: 'not a url', apiUrl: 'ftp://adk.lan', mcpUrl: 'nope' });
  assert.equal(errors.webUrl.key, 'error.url');
  assert.equal(errors.apiUrl.key, 'error.url');
  assert.equal(errors.mcpUrl.key, 'error.url');
  assert.equal(validate({ ...base, mcp: false, mcpUrl: 'nope' }).mcpUrl, undefined);
  assert.deepEqual(validate({ ...base, webUrl: 'https://adk.example.com' }), {});
});

test('invalid ports are reported', () => {
  const errors = validate({ ...createDefaultState(), webPort: '70000', apiPort: 'abc' });
  assert.equal(errors.webPort.key, 'error.port');
  assert.equal(errors.apiPort.key, 'error.port');
});

test('E2E concurrency and R2 storage are validated', () => {
  const errors = validate({ ...createDefaultState(), e2eConcurrency: '0', e2eStorage: 'r2', r2Url: '' });
  assert.equal(errors.e2eConcurrency.key, 'error.concurrency');
  assert.equal(errors.r2AccessKeyId.key, 'error.required');
  assert.equal(errors.r2SecretAccessKey.key, 'error.required');
  assert.equal(validate({ ...createDefaultState(), e2eConcurrency: '17' }).e2eConcurrency.key, 'error.concurrency');
  assert.equal(validate({ ...createDefaultState(), e2eConcurrency: '1.5' }).e2eConcurrency.key, 'error.concurrency');
  assert.deepEqual(validate({ ...createDefaultState(), e2e: false, e2eConcurrency: 'x' }), {});
});

test('SMTP settings are validated', () => {
  const smtp = { ...createDefaultState(), emailMode: 'smtp', smtpHost: 'smtp.example.com' };
  const errors = validate({ ...smtp, smtpPort: 'x', smtpFrom: ' ', smtpUser: 'me' });
  assert.equal(errors.smtpPort.key, 'error.port');
  assert.equal(errors.smtpFrom.key, 'error.required');
  assert.equal(errors.smtpPassword.key, 'error.pair');
  assert.equal(validate({ ...smtp, smtpPassword: 'secret' }).smtpUser.key, 'error.pair');
  assert.deepEqual(validate({ ...smtp, smtpUser: 'me', smtpPassword: 'secret' }), {});
});

test('a sign-in secret without its client ID is reported', () => {
  const errors = validate({ ...createDefaultState(), githubClientSecret: 'secret' });
  assert.equal(errors.githubClientId.key, 'error.pair');
});

test('short secrets are reported with their minimum length', () => {
  const errors = validate({
    ...createDefaultState(),
    encryptionKey: 'x',
    oauthStateSecret: 'x',
    authCodeSecret: 'x',
    workerToken: 'x',
    mcpOauthSecret: 'x',
  });
  assert.deepEqual(errors.encryptionKey, { key: 'error.secretLength', params: { min: 32 } });
  assert.deepEqual(errors.oauthStateSecret, { key: 'error.secretLength', params: { min: 32 } });
  assert.deepEqual(errors.authCodeSecret, { key: 'error.secretLength', params: { min: 32 } });
  assert.deepEqual(errors.workerToken, { key: 'error.secretLength', params: { min: 16 } });
  assert.deepEqual(errors.mcpOauthSecret, { key: 'error.secretLength', params: { min: 32 } });
});

test('opening ADK to the network without HTTPS URLs warns', () => {
  const state = { ...createDefaultState(), network: true, host: 'adk.lan' };
  assert.deepEqual(warnings(state), ['warning.networkHttp']);
  assert.deepEqual(warnings({ ...state, customUrls: true }), []);
});

test('parseEnv skips invalid lines and reads unterminated quotes to the end', () => {
  const env = parseEnv(['not a setting', "OPEN_SINGLE='abc", 'OPEN_DOUBLE="a\\nb', ' SPACED = v '].join('\r\n'));
  assert.equal(env.size, 3);
  assert.equal(env.get('OPEN_SINGLE'), 'abc');
  assert.equal(env.get('OPEN_DOUBLE'), 'a\nb');
  assert.equal(env.get('SPACED'), 'v');
});

test('unmanaged settings with quotes are double-quoted and read back', () => {
  const value = 'it\'s "quoted" $HOME \\ path\nnext';
  const restored = stateFromEnv(parseEnv(serializeEnv({ ...createDefaultState(), extra: { QUOTED: value } })));
  assert.equal(restored.extra.QUOTED, value);
});

test('only valid, unmanaged, string extra settings are written', () => {
  const sections = envSections({
    ...createDefaultState(),
    extra: { GOOD: 'yes', 'bad key': 'no', LOG_LEVEL: 'debug', NUMBER: 1 },
  });
  const other = sections.find(([comment]) => comment === 'Other settings');
  assert.deepEqual(other[1], [['GOOD', 'yes']]);
  const withoutExtra = envSections({ ...createDefaultState(), extra: undefined });
  assert.equal(withoutExtra.find(([comment]) => comment === 'Other settings'), undefined);
});

test('R2 storage, log level and SMTP defaults survive a round trip', () => {
  const state = {
    ...createDefaultState(),
    e2eStorage: 'r2',
    r2Url: 'https://account.r2.cloudflarestorage.com/bucket',
    r2AccessKeyId: 'key',
    r2SecretAccessKey: 'secret',
    r2Prefix: 'adk/',
    logLevel: 'debug',
  };
  const restored = stateFromEnv(parseEnv(serializeEnv(state)));
  assert.equal(restored.e2eStorage, 'r2');
  assert.equal(restored.r2Prefix, 'adk/');
  assert.equal(restored.logLevel, 'debug');

  const smtp = stateFromEnv(parseEnv('SMTP_HOST=smtp.example.com\n'));
  assert.equal(smtp.emailMode, 'smtp');
  assert.equal(smtp.smtpPort, '587');
  assert.equal(smtp.smtpSecure, false);
  assert.equal(stateFromEnv(new Map()).emailMode, 'none');
});

test('R2 settings are left out when E2E storage is the database', () => {
  const env = parseEnv(serializeEnv({ ...createDefaultState(), r2Url: 'https://x', r2Prefix: 'p' }));
  assert.equal(env.get('E2E_R2_URL'), undefined);
  assert.equal(env.get('E2E_R2_PREFIX'), undefined);
});
