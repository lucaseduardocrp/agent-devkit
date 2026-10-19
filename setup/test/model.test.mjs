// Run with: node --test setup/test
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createDefaultState,
  parseEnv,
  serializeEnv,
  stateFromEnv,
  validate,
  warnings,
} from '../public/model.js';

test('default state is valid and starts every optional service', () => {
  const state = createDefaultState();
  assert.deepEqual(validate(state), {});
  const env = parseEnv(serializeEnv(state));
  assert.equal(env.get('COMPOSE_PROFILES'), 'e2e,mcp,mail');
  assert.equal(env.get('FRONTEND_URL'), 'http://localhost:8080');
  assert.equal(env.get('API_PUBLIC_URL'), 'http://localhost:3000');
  assert.equal(env.get('E2E_WORKER_URL'), 'http://worker:3001');
  assert.equal(env.get('SMTP_HOST'), 'mailpit');
  assert.match(env.get('INTEGRATION_ENCRYPTION_KEY'), /^[0-9a-f]{64}$/);
});

test('every generated key is unique', () => {
  const a = createDefaultState();
  const b = createDefaultState();
  assert.notEqual(a.encryptionKey, b.encryptionKey);
  assert.notEqual(a.databasePassword, b.databasePassword);
});

test('a saved configuration reads back unchanged', () => {
  const state = {
    ...createDefaultState(),
    host: 'adk.lan',
    network: true,
    webPort: '9080',
    e2e: false,
    emailMode: 'smtp',
    smtpHost: 'smtp.example.com',
    smtpPort: '465',
    smtpSecure: true,
    smtpUser: 'me',
    smtpPassword: 'p@ss word #1 $HOME',
    smtpFrom: 'ADK <no-reply@example.com>',
    githubClientId: 'id',
    githubClientSecret: 'secret',
    extra: { CUSTOM_SETTING: 'kept' },
  };
  const restored = stateFromEnv(parseEnv(serializeEnv(state)));
  for (const key of Object.keys(state)) {
    if (['webUrl', 'apiUrl', 'mcpUrl', 'r2Prefix'].includes(key)) continue;
    assert.deepEqual(restored[key], state[key], key);
  }
});

test('values with spaces, # and $ are written literally', () => {
  const text = serializeEnv({ ...createDefaultState(), emailMode: 'smtp', smtpHost: 'h', smtpFrom: 'A #1 <$x@y>' });
  assert.match(text, /^SMTP_FROM='A #1 <\$x@y>'$/m);
});

test('disabled services leave their settings out', () => {
  const env = parseEnv(
    serializeEnv({ ...createDefaultState(), e2e: false, mcp: false, emailMode: 'none' }),
  );
  assert.equal(env.get('COMPOSE_PROFILES'), undefined);
  assert.equal(env.get('E2E_WORKER_URL'), undefined);
  assert.equal(env.get('SMTP_HOST'), undefined);
  // Secrets are still written so that turning a service on later needs no new keys.
  assert.ok(env.get('E2E_WORKER_TOKEN'));
});

test('custom public URLs survive a round trip', () => {
  const state = {
    ...createDefaultState(),
    customUrls: true,
    webUrl: 'https://adk.example.com/',
    apiUrl: 'https://api.adk.example.com',
    mcpUrl: 'https://mcp.adk.example.com',
  };
  const restored = stateFromEnv(parseEnv(serializeEnv(state)));
  assert.equal(restored.customUrls, true);
  assert.equal(restored.webUrl, 'https://adk.example.com');
});

test('validation catches the common mistakes', () => {
  const errors = validate({
    ...createDefaultState(),
    host: 'not a host',
    apiPort: '8080',
    emailMode: 'smtp',
    smtpHost: '',
    googleClientId: 'only-the-id',
    databasePassword: 'short',
    e2eStorage: 'r2',
    r2Url: 'https://example.com',
  });
  assert.equal(errors.host.key, 'error.host');
  assert.equal(errors.apiPort.key, 'error.portTaken');
  assert.equal(errors.smtpHost.key, 'error.required');
  assert.equal(errors.googleClientSecret.key, 'error.pair');
  assert.equal(errors.databasePassword.key, 'error.databasePassword');
  assert.equal(errors.r2Url.key, 'error.r2Url');
});

test('ports of disabled services are not checked for conflicts', () => {
  const state = { ...createDefaultState(), mcp: false, mcpPort: '8080', emailMode: 'none', mailPort: 'x' };
  assert.deepEqual(validate(state), {});
});

test('quotes are rejected because .env values are single-quoted', () => {
  const errors = validate({ ...createDefaultState(), smtpFrom: "O'Brien <a@b>" });
  assert.equal(errors.smtpFrom.key, 'error.characters');
});

test('opening ADK to the network on localhost warns', () => {
  assert.ok(warnings({ ...createDefaultState(), network: true }).includes('warning.networkLocalhost'));
  assert.deepEqual(warnings(createDefaultState()), []);
});

test('parseEnv follows Docker Compose quoting', () => {
  const env = parseEnv(
    [
      '# comment',
      'PLAIN=value # trailing comment',
      "SINGLE='a # b $c'",
      'DOUBLE="x \\"y\\" z"',
      'export EXPORTED=1',
      'EMPTY=',
    ].join('\n'),
  );
  assert.equal(env.get('PLAIN'), 'value');
  assert.equal(env.get('SINGLE'), 'a # b $c');
  assert.equal(env.get('DOUBLE'), 'x "y" z');
  assert.equal(env.get('EXPORTED'), '1');
  assert.equal(env.get('EMPTY'), '');
});

test('older files get the keys they are missing, existing keys are kept', () => {
  const restored = stateFromEnv(parseEnv('INTEGRATION_ENCRYPTION_KEY=existing-key-that-must-stay-the-same\n'));
  assert.equal(restored.encryptionKey, 'existing-key-that-must-stay-the-same');
  assert.match(restored.mcpOauthSecret, /^[0-9a-f]{48}$/);
});
