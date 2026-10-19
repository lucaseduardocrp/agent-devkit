// Configuration model of the ADK setup wizard, shared by the browser and setup/server.mjs.
// Pure functions only: no DOM, no file system. The wizard edits a `state` object; this module
// turns it into the `.env` that compose.yaml reads, and back.

export const SECRET_FIELDS = [
  { key: 'databasePassword', env: 'DATABASE_PASSWORD', bytes: 24, locked: true },
  { key: 'encryptionKey', env: 'INTEGRATION_ENCRYPTION_KEY', bytes: 32, locked: true },
  { key: 'oauthStateSecret', env: 'OAUTH_STATE_SECRET', bytes: 32 },
  { key: 'authCodeSecret', env: 'AUTH_CODE_SECRET', bytes: 32 },
  { key: 'workerToken', env: 'E2E_WORKER_TOKEN', bytes: 24 },
  { key: 'mcpOauthSecret', env: 'ADK_MCP_OAUTH_SECRET', bytes: 24 },
];

export const EMAIL_PRESETS = {
  gmail: { smtpHost: 'smtp.gmail.com', smtpPort: '465', smtpSecure: true },
  outlook: { smtpHost: 'smtp.office365.com', smtpPort: '587', smtpSecure: false },
  sendgrid: { smtpHost: 'smtp.sendgrid.net', smtpPort: '587', smtpSecure: false, smtpUser: 'apikey' },
  resend: { smtpHost: 'smtp.resend.com', smtpPort: '465', smtpSecure: true, smtpUser: 'resend' },
};

/** Every variable the wizard owns. Anything else found in `.env` is kept untouched. */
const MANAGED_KEYS = new Set([
  'COMPOSE_PROFILES',
  'ADK_HOST',
  'ADK_BIND_ADDRESS',
  'ADK_WEB_PORT',
  'ADK_API_PORT',
  'ADK_MCP_PORT',
  'ADK_MAIL_PORT',
  'FRONTEND_URL',
  'API_PUBLIC_URL',
  'ADK_MCP_PUBLIC_URL',
  'ADK_MCP_ALLOWED_HOSTS',
  'SMTP_HOST',
  'SMTP_PORT',
  'SMTP_SECURE',
  'SMTP_USER',
  'SMTP_PASSWORD',
  'SMTP_FROM',
  'GOOGLE_CLIENT_ID',
  'GOOGLE_CLIENT_SECRET',
  'GITHUB_CLIENT_ID',
  'GITHUB_CLIENT_SECRET',
  'E2E_WORKER_URL',
  'E2E_WORKER_CONCURRENCY',
  'E2E_R2_URL',
  'E2E_R2_ACCESS_KEY_ID',
  'E2E_R2_SECRET_ACCESS_KEY',
  'E2E_R2_PREFIX',
  'LOG_LEVEL',
  ...SECRET_FIELDS.map((field) => field.env),
]);

export function generateSecret(bytes) {
  const buffer = new Uint8Array(bytes);
  globalThis.crypto.getRandomValues(buffer);
  return Array.from(buffer, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function createDefaultState() {
  const state = {
    host: 'localhost',
    network: false,
    webPort: '8080',
    apiPort: '3000',
    mcpPort: '3333',
    mailPort: '8025',
    customUrls: false,
    webUrl: '',
    apiUrl: '',
    mcpUrl: '',
    e2e: true,
    e2eConcurrency: '2',
    e2eStorage: 'postgres',
    r2Url: '',
    r2AccessKeyId: '',
    r2SecretAccessKey: '',
    r2Prefix: '',
    mcp: true,
    mcpAllowedHosts: '',
    emailMode: 'mailpit',
    smtpHost: '',
    smtpPort: '587',
    smtpSecure: false,
    smtpUser: '',
    smtpPassword: '',
    smtpFrom: 'ADK <no-reply@localhost>',
    googleClientId: '',
    googleClientSecret: '',
    githubClientId: '',
    githubClientSecret: '',
    logLevel: 'info',
    extra: {},
  };
  for (const field of SECRET_FIELDS) state[field.key] = generateSecret(field.bytes);
  return state;
}

function hostForUrl(host) {
  return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
}

/** Public URLs as they follow from the address and ports, unless the user overrides them. */
export function derivedUrls(state) {
  const host = hostForUrl(state.host.trim() || 'localhost');
  return {
    webUrl: `http://${host}:${state.webPort}`,
    apiUrl: `http://${host}:${state.apiPort}`,
    mcpUrl: `http://${host}:${state.mcpPort}`,
    mailUrl: `http://${host}:${state.mailPort}`,
  };
}

export function effectiveUrls(state) {
  const derived = derivedUrls(state);
  if (!state.customUrls) return derived;
  const clean = (value, fallback) => value.trim().replace(/\/+$/, '') || fallback;
  return {
    webUrl: clean(state.webUrl, derived.webUrl),
    apiUrl: clean(state.apiUrl, derived.apiUrl),
    mcpUrl: clean(state.mcpUrl, derived.mcpUrl),
    mailUrl: derived.mailUrl,
  };
}

export function composeProfiles(state) {
  return [
    state.e2e ? 'e2e' : null,
    state.mcp ? 'mcp' : null,
    state.emailMode === 'mailpit' ? 'mail' : null,
  ].filter(Boolean);
}

// ---------------------------------------------------------------------------------------------
// Validation. Errors are message keys (see i18n.js) with optional parameters.

const PORT_FIELDS = ['webPort', 'apiPort', 'mcpPort', 'mailPort'];

function isPort(value) {
  return /^\d{1,5}$/.test(String(value)) && Number(value) >= 1 && Number(value) <= 65535;
}

function isHttpUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

/** Returns `{ field: { key, params } }` for every invalid field. Empty object when valid. */
export function validate(state) {
  const errors = {};
  const fail = (field, key, params) => {
    if (!errors[field]) errors[field] = { key, params };
  };

  if (!/^(?:[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*|\[[0-9A-Fa-f:.]+\])$/.test(state.host.trim())) {
    fail('host', 'error.host');
  }

  const activePorts = PORT_FIELDS.filter(
    (field) =>
      (field !== 'mcpPort' || state.mcp) && (field !== 'mailPort' || state.emailMode === 'mailpit'),
  );
  const seen = new Map();
  for (const field of activePorts) {
    const value = String(state[field]).trim();
    if (!isPort(value)) {
      fail(field, 'error.port');
      continue;
    }
    if (seen.has(value)) fail(field, 'error.portTaken', { port: value });
    seen.set(value, field);
  }

  if (state.customUrls) {
    for (const field of ['webUrl', 'apiUrl', ...(state.mcp ? ['mcpUrl'] : [])]) {
      if (state[field].trim() && !isHttpUrl(state[field].trim())) fail(field, 'error.url');
    }
  }

  if (state.e2e) {
    const concurrency = Number(state.e2eConcurrency);
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 16) {
      fail('e2eConcurrency', 'error.concurrency');
    }
    if (state.e2eStorage === 'r2') {
      if (!/^https:\/\/[^/]+\.r2\.cloudflarestorage\.com\/[^/]+\/?$/.test(state.r2Url.trim())) {
        fail('r2Url', 'error.r2Url');
      }
      if (!state.r2AccessKeyId.trim()) fail('r2AccessKeyId', 'error.required');
      if (!state.r2SecretAccessKey.trim()) fail('r2SecretAccessKey', 'error.required');
    }
  }

  if (state.emailMode === 'smtp') {
    if (!state.smtpHost.trim()) fail('smtpHost', 'error.required');
    if (!isPort(state.smtpPort)) fail('smtpPort', 'error.port');
    if (!state.smtpFrom.trim()) fail('smtpFrom', 'error.required');
    if (Boolean(state.smtpUser.trim()) !== Boolean(state.smtpPassword)) {
      fail(state.smtpUser.trim() ? 'smtpPassword' : 'smtpUser', 'error.pair');
    }
  }

  for (const [id, secret] of [
    ['googleClientId', 'googleClientSecret'],
    ['githubClientId', 'githubClientSecret'],
  ]) {
    if (Boolean(state[id].trim()) !== Boolean(state[secret].trim())) {
      fail(state[id].trim() ? secret : id, 'error.pair');
    }
  }

  if (!/^[A-Za-z0-9._~-]{12,}$/.test(state.databasePassword)) {
    fail('databasePassword', 'error.databasePassword');
  }
  if (state.encryptionKey.trim().length < 32) fail('encryptionKey', 'error.secretLength', { min: 32 });
  if (state.oauthStateSecret.trim().length < 32) {
    fail('oauthStateSecret', 'error.secretLength', { min: 32 });
  }
  if (state.authCodeSecret.trim().length < 32) fail('authCodeSecret', 'error.secretLength', { min: 32 });
  if (state.workerToken.trim().length < 16) fail('workerToken', 'error.secretLength', { min: 16 });
  if (state.mcpOauthSecret.trim().length < 32) fail('mcpOauthSecret', 'error.secretLength', { min: 32 });

  // `.env` values are written single-quoted when needed, so they cannot hold quotes or newlines.
  for (const [field, value] of Object.entries(state)) {
    if (typeof value === 'string' && /['\r\n]/.test(value)) fail(field, 'error.characters');
  }
  return errors;
}

/** Problems worth a warning that do not block saving. */
export function warnings(state) {
  const list = [];
  if (state.network && ['localhost', '127.0.0.1', '[::1]'].includes(state.host.trim())) {
    list.push('warning.networkLocalhost');
  }
  if (state.network && !state.customUrls) list.push('warning.networkHttp');
  return list;
}

// ---------------------------------------------------------------------------------------------
// .env reading and writing.

/** Parses dotenv text into an ordered map, following Docker Compose's rules for quotes. */
export function parseEnv(text) {
  const values = new Map();
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    const [, key, rest] = match;
    let value = rest;
    if (value.startsWith("'")) {
      const end = value.indexOf("'", 1);
      value = end === -1 ? value.slice(1) : value.slice(1, end);
    } else if (value.startsWith('"')) {
      const end = value.slice(1).search(/(?<!\\)"/);
      value = (end === -1 ? value.slice(1) : value.slice(1, end + 1))
        .replace(/\\n/g, '\n')
        .replace(/\\(["\\$])/g, '$1');
    } else {
      value = value.replace(/\s+#.*$/, '').trim();
    }
    values.set(key, value);
  }
  return values;
}

function formatValue(value) {
  if (/^[A-Za-z0-9_./:@,+=-]*$/.test(value)) return value;
  // Single quotes keep the value literal: no `$` interpolation, spaces and `#` allowed.
  if (!value.includes("'")) return `'${value}'`;
  // Only settings the wizard does not manage can get here (validate() rejects quotes).
  return `"${value.replace(/[\\"$]/g, '\\$&').replace(/\n/g, '\\n')}"`;
}

export function stateFromEnv(env) {
  const state = createDefaultState();
  const get = (key) => env.get(key) ?? '';
  const profiles = get('COMPOSE_PROFILES')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);

  state.host = get('ADK_HOST') || state.host;
  state.network = get('ADK_BIND_ADDRESS') === '0.0.0.0';
  state.webPort = get('ADK_WEB_PORT') || state.webPort;
  state.apiPort = get('ADK_API_PORT') || state.apiPort;
  state.mcpPort = get('ADK_MCP_PORT') || state.mcpPort;
  state.mailPort = get('ADK_MAIL_PORT') || state.mailPort;

  const derived = derivedUrls(state);
  state.webUrl = get('FRONTEND_URL') || derived.webUrl;
  state.apiUrl = get('API_PUBLIC_URL') || derived.apiUrl;
  state.mcpUrl = get('ADK_MCP_PUBLIC_URL') || derived.mcpUrl;
  state.customUrls =
    state.webUrl !== derived.webUrl ||
    state.apiUrl !== derived.apiUrl ||
    state.mcpUrl !== derived.mcpUrl;

  state.e2e = profiles.includes('e2e');
  state.e2eConcurrency = get('E2E_WORKER_CONCURRENCY') || state.e2eConcurrency;
  state.e2eStorage = get('E2E_R2_URL') ? 'r2' : 'postgres';
  state.r2Url = get('E2E_R2_URL');
  state.r2AccessKeyId = get('E2E_R2_ACCESS_KEY_ID');
  state.r2SecretAccessKey = get('E2E_R2_SECRET_ACCESS_KEY');
  state.r2Prefix = get('E2E_R2_PREFIX');

  state.mcp = profiles.includes('mcp');
  state.mcpAllowedHosts = get('ADK_MCP_ALLOWED_HOSTS');

  state.emailMode = profiles.includes('mail') ? 'mailpit' : get('SMTP_HOST') ? 'smtp' : 'none';
  if (state.emailMode === 'smtp') {
    state.smtpHost = get('SMTP_HOST');
    state.smtpPort = get('SMTP_PORT') || '587';
    state.smtpSecure = get('SMTP_SECURE') === 'true';
    state.smtpUser = get('SMTP_USER');
    state.smtpPassword = get('SMTP_PASSWORD');
  }
  state.smtpFrom = get('SMTP_FROM') || state.smtpFrom;

  state.googleClientId = get('GOOGLE_CLIENT_ID');
  state.googleClientSecret = get('GOOGLE_CLIENT_SECRET');
  state.githubClientId = get('GITHUB_CLIENT_ID');
  state.githubClientSecret = get('GITHUB_CLIENT_SECRET');
  state.logLevel = get('LOG_LEVEL') || 'info';

  // Keys missing from an older file are generated now; existing ones are never replaced.
  for (const field of SECRET_FIELDS) state[field.key] = get(field.env) || state[field.key];

  state.extra = {};
  for (const [key, value] of env) if (!MANAGED_KEYS.has(key)) state.extra[key] = value;
  return state;
}

/** Ordered `[comment, [[KEY, value], ...]]` sections; empty values are left out. */
export function envSections(state) {
  const urls = effectiveUrls(state);
  const smtp =
    state.emailMode === 'mailpit'
      ? { host: 'mailpit', port: '1025', secure: 'false', user: '', password: '' }
      : state.emailMode === 'smtp'
        ? {
            host: state.smtpHost.trim(),
            port: String(state.smtpPort).trim(),
            secure: String(state.smtpSecure),
            user: state.smtpUser.trim(),
            password: state.smtpPassword,
          }
        : null;
  const r2 = state.e2e && state.e2eStorage === 'r2';

  const sections = [
    ['Optional services: e2e (Playwright worker), mcp (remote MCP server), mail (Mailpit inbox)', [
      ['COMPOSE_PROFILES', composeProfiles(state).join(',')],
    ]],
    ['Where ADK is reachable. ADK_BIND_ADDRESS=0.0.0.0 opens the ports to other devices.', [
      ['ADK_HOST', state.host.trim()],
      ['ADK_BIND_ADDRESS', state.network ? '0.0.0.0' : '127.0.0.1'],
      ['ADK_WEB_PORT', String(state.webPort).trim()],
      ['ADK_API_PORT', String(state.apiPort).trim()],
      ['ADK_MCP_PORT', String(state.mcpPort).trim()],
      ['ADK_MAIL_PORT', String(state.mailPort).trim()],
      ['FRONTEND_URL', urls.webUrl],
      ['API_PUBLIC_URL', urls.apiUrl],
      ['ADK_MCP_PUBLIC_URL', urls.mcpUrl],
      ['ADK_MCP_ALLOWED_HOSTS', state.mcpAllowedHosts.trim()],
    ]],
    [
      'Generated keys. Keep a copy of INTEGRATION_ENCRYPTION_KEY: without it, saved integrations\n' +
        '# cannot be decrypted. DATABASE_PASSWORD only applies when the database is first created.',
      SECRET_FIELDS.map((field) => [field.env, state[field.key].trim()]),
    ],
    ['Email (account recovery)', smtp
      ? [
          ['SMTP_HOST', smtp.host],
          ['SMTP_PORT', smtp.port],
          ['SMTP_SECURE', smtp.secure],
          ['SMTP_USER', smtp.user],
          ['SMTP_PASSWORD', smtp.password],
          ['SMTP_FROM', state.smtpFrom.trim()],
        ]
      : []],
    ['Sign in with Google and GitHub', [
      ['GOOGLE_CLIENT_ID', state.googleClientId.trim()],
      ['GOOGLE_CLIENT_SECRET', state.googleClientSecret.trim()],
      ['GITHUB_CLIENT_ID', state.githubClientId.trim()],
      ['GITHUB_CLIENT_SECRET', state.githubClientSecret.trim()],
    ]],
    ['E2E automation', state.e2e
      ? [
          ['E2E_WORKER_URL', 'http://worker:3001'],
          ['E2E_WORKER_CONCURRENCY', String(state.e2eConcurrency).trim()],
          ['E2E_R2_URL', r2 ? state.r2Url.trim() : ''],
          ['E2E_R2_ACCESS_KEY_ID', r2 ? state.r2AccessKeyId.trim() : ''],
          ['E2E_R2_SECRET_ACCESS_KEY', r2 ? state.r2SecretAccessKey.trim() : ''],
          ['E2E_R2_PREFIX', r2 ? state.r2Prefix.trim() : ''],
        ]
      : []],
    ['Other settings', [
      ['LOG_LEVEL', state.logLevel === 'info' ? '' : state.logLevel],
      ...Object.entries(state.extra ?? {}).filter(
        ([key, value]) =>
          /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && !MANAGED_KEYS.has(key) && typeof value === 'string',
      ),
    ]],
  ];
  return sections
    .map(([comment, entries]) => [comment, entries.filter(([, value]) => value !== '')])
    .filter(([, entries]) => entries.length > 0);
}

export function serializeEnv(state) {
  const lines = [
    '# ADK configuration, written by the setup wizard (adk.cmd on Windows, ./adk.sh setup',
    '# on macOS/Linux). Run the wizard again to change it. Keep this file private.',
  ];
  for (const [comment, entries] of envSections(state)) {
    lines.push('', `# ${comment}`);
    for (const [key, value] of entries) lines.push(`${key}=${formatValue(value)}`);
  }
  return `${lines.join('\n')}\n`;
}
