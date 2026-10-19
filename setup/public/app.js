import { getLocale, LOCALES, setLocale, t } from './i18n.js';
import {
  createDefaultState,
  derivedUrls,
  effectiveUrls,
  EMAIL_PRESETS,
  generateSecret,
  SECRET_FIELDS,
  validate,
  warnings,
} from './model.js';

const STEPS = [
  { id: 'welcome', icon: 'sparkles', fields: [] },
  {
    id: 'access',
    icon: 'globe',
    fields: ['host', 'webPort', 'apiPort', 'mcpPort', 'mailPort', 'webUrl', 'apiUrl', 'mcpUrl'],
  },
  {
    id: 'features',
    icon: 'layers',
    fields: ['e2eConcurrency', 'r2Url', 'r2AccessKeyId', 'r2SecretAccessKey', 'mcpAllowedHosts'],
  },
  { id: 'email', icon: 'mail', fields: ['smtpHost', 'smtpPort', 'smtpUser', 'smtpPassword', 'smtpFrom'] },
  {
    id: 'signin',
    icon: 'user',
    fields: ['googleClientId', 'googleClientSecret', 'githubClientId', 'githubClientSecret'],
  },
  { id: 'security', icon: 'key', fields: SECRET_FIELDS.map((field) => field.key) },
  { id: 'review', icon: 'check', fields: [] },
];

const app = {
  phase: 'loading', // loading | wizard | launch | closed | error
  state: null,
  original: null,
  exists: false,
  launcher: false,
  step: 0,
  visited: new Set([0]),
  submitted: new Set(),
  touched: new Set(),
  revealed: new Set(),
  unlocked: new Set(),
  confirmUnlock: null,
  saving: false,
  saveError: null,
  serverErrors: {},
  launch: null,
};

const root = document.getElementById('app');
const isWindows = /Win/i.test(navigator.userAgent);

// ---------------------------------------------------------------------------------------------
// DOM helpers

function h(tag, props, ...children) {
  const element = document.createElement(tag);
  for (const [name, value] of Object.entries(props ?? {})) {
    if (value === null || value === undefined || value === false) continue;
    if (name === 'class') element.className = value;
    else if (name.startsWith('on')) element.addEventListener(name.slice(2).toLowerCase(), value);
    // CSSOM, not the style attribute, which the page's Content-Security-Policy blocks.
    else if (name === 'style') element.style.cssText = value;
    else if (name === 'value') element.value = value;
    else if (name === 'checked') element.checked = Boolean(value);
    else element.setAttribute(name, value === true ? '' : value);
  }
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    element.append(child instanceof Node ? child : String(child));
  }
  return element;
}

const ICONS = {
  sparkles: 'M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z M19 16l.8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8z',
  globe: 'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20z M2 12h20 M12 2a15 15 0 0 1 0 20 M12 2a15 15 0 0 0 0 20',
  layers: 'M12 2l10 5-10 5L2 7z M2 17l10 5 10-5 M2 12l10 5 10-5',
  mail: 'M3 5h18v14H3z M3 6l9 7 9-7',
  user: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8z M4 21a8 8 0 0 1 16 0',
  key: 'M15 7a4 4 0 1 1-3.9 5H3v3h3v3h3v-3h2.1A4 4 0 0 1 15 7z M16 10h.01',
  check: 'M20 6L9 17l-5-5',
  copy: 'M9 9h11v11H9z M5 15H4V4h11v1',
  eye: 'M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
  eyeOff: 'M3 3l18 18 M10.6 5.1A10 10 0 0 1 12 5c6.5 0 10 7 10 7a17 17 0 0 1-2.2 3.1 M6.6 6.6A17 17 0 0 0 2 12s3.5 7 10 7a9.700 9.700 0 0 0 5.4-1.6 M9.9 9.9a3 3 0 0 0 4.2 4.2',
  refresh: 'M21 12a9 9 0 1 1-2.6-6.4L21 8 M21 3v5h-5',
  lock: 'M5 11h14v10H5z M8 11V7a4 4 0 0 1 8 0v4',
  unlock: 'M5 11h14v10H5z M8 11V7a4 4 0 0 1 7.7-1.5',
  arrowLeft: 'M19 12H5 M12 19l-7-7 7-7',
  arrowRight: 'M5 12h14 M12 5l7 7-7 7',
  external: 'M15 3h6v6 M10 14L21 3 M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6',
  alert: 'M12 3l10 18H2z M12 10v4 M12 17h.01',
  info: 'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20z M12 11v6 M12 7h.01',
  server: 'M3 4h18v6H3z M3 14h18v6H3z M7 7h.01 M7 17h.01',
  database: 'M12 3c5 0 8 1.3 8 3s-3 3-8 3-8-1.3-8-3 3-3 8-3z M4 6v12c0 1.7 3 3 8 3s8-1.3 8-3V6 M4 12c0 1.7 3 3 8 3s8-1.3 8-3',
  flask: 'M9 3h6 M10 3v6L4 20h16L14 9V3 M7 14h10',
  bot: 'M5 8h14v12H5z M12 4v4 M9 13h.01 M15 13h.01 M9 17h6',
  terminal: 'M4 17l6-6-6-6 M12 19h8',
  play: 'M6 4l14 8-14 8z',
  x: 'M18 6L6 18 M6 6l12 12',
  github: 'M9 19c-4.300 1.400-4.300-2.500-6-3m12 5v-3.500c0-1 .1-1.400-.5-2 2.800-.3 5.500-1.400 5.500-6a4.600 4.600 0 0 0-1.300-3.200 4.200 4.200 0 0 0-.1-3.200s-1.100-.3-3.500 1.300a12.300 12.300 0 0 0-6.200 0C6.500 2.800 5.400 3.100 5.400 3.100a4.200 4.200 0 0 0-.1 3.200A4.600 4.600 0 0 0 4 9.500c0 4.600 2.700 5.700 5.500 6-.6.600-.6 1.200-.5 2V21',
};

function icon(name, className = 'icon') {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', className);
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', ICONS[name] ?? '');
  svg.append(path);
  return svg;
}

// ---------------------------------------------------------------------------------------------
// State helpers

function urls() {
  return effectiveUrls(app.state);
}

function allErrors() {
  return { ...validate(app.state), ...app.serverErrors };
}

function stepFields(index) {
  return STEPS[index].fields;
}

function stepHasErrors(index, errors = allErrors()) {
  return stepFields(index).some((field) => errors[field]);
}

function errorFor(field) {
  const errors = allErrors();
  if (!errors[field]) return null;
  const owner = STEPS.findIndex((step) => step.fields.includes(field));
  if (!app.touched.has(field) && !app.submitted.has(owner) && !app.serverErrors[field]) return null;
  return t(errors[field].key, errors[field].params);
}

function update(field, value) {
  app.state[field] = value;
  delete app.serverErrors[field];
  render();
}

function goTo(index) {
  app.step = Math.max(0, Math.min(STEPS.length - 1, index));
  app.visited.add(app.step);
  app.confirmUnlock = null;
  render();
  document.querySelector('.panel-scroll')?.scrollTo({ top: 0 });
  document.getElementById('step-title')?.focus({ preventScroll: true });
}

function next() {
  const errors = allErrors();
  if (stepHasErrors(app.step, errors)) {
    app.submitted.add(app.step);
    render();
    const first = stepFields(app.step).find((field) => errors[field]);
    document.getElementById(first)?.focus();
    return;
  }
  goTo(app.step + 1);
}

async function copy(text, button) {
  try {
    await navigator.clipboard.writeText(text);
    const label = button.querySelector('.btn-label');
    if (label) {
      const previous = label.textContent;
      label.textContent = t('common.copied');
      setTimeout(() => (label.textContent = previous), 1500);
    }
    button.classList.add('is-done');
    setTimeout(() => button.classList.remove('is-done'), 1500);
  } catch {
    window.prompt(t('common.copyManually'), text);
  }
}

// ---------------------------------------------------------------------------------------------
// Building blocks

function field({ id, label, hint, placeholder, type = 'text', mono, readOnly, inputmode, autocomplete }) {
  const error = errorFor(id);
  const hintId = `${id}-hint`;
  return h(
    'div',
    { class: `field${error ? ' has-error' : ''}` },
    h('label', { for: id }, label),
    h('input', {
      id,
      type,
      class: mono ? 'mono' : null,
      value: app.state[id] ?? '',
      placeholder,
      readonly: readOnly,
      inputmode,
      autocomplete: autocomplete ?? 'off',
      spellcheck: 'false',
      'aria-invalid': error ? 'true' : null,
      'aria-describedby': hint || error ? hintId : null,
      onInput: (event) => update(id, event.target.value),
      onBlur: () => {
        if (!app.touched.has(id)) {
          app.touched.add(id);
          render();
        }
      },
    }),
    error
      ? h('p', { class: 'field-error', id: hintId }, icon('alert', 'icon icon-sm'), error)
      : hint
        ? h('p', { class: 'field-hint', id: hintId }, hint)
        : null,
  );
}

function toggle({ id, title, description, disabled, badge }) {
  return h(
    'label',
    { class: `toggle${disabled ? ' is-disabled' : ''}`, for: id },
    h(
      'span',
      { class: 'toggle-text' },
      h('span', { class: 'toggle-title' }, title, badge ? h('span', { class: 'badge' }, badge) : null),
      description ? h('span', { class: 'toggle-description' }, description) : null,
    ),
    h('input', {
      id,
      type: 'checkbox',
      role: 'switch',
      checked: disabled ? true : app.state[id],
      disabled,
      onChange: (event) => update(id, event.target.checked),
    }),
    h('span', { class: 'switch', 'aria-hidden': 'true' }),
  );
}

function choiceCards(name, options) {
  return h(
    'div',
    { class: 'choices', role: 'radiogroup' },
    options.map((option) =>
      h(
        'label',
        { class: `choice${app.state[name] === option.value ? ' is-selected' : ''}` },
        h('input', {
          type: 'radio',
          name,
          value: option.value,
          checked: app.state[name] === option.value,
          onChange: () => update(name, option.value),
        }),
        h(
          'span',
          { class: 'choice-body' },
          h(
            'span',
            { class: 'choice-title' },
            option.title,
            option.badge ? h('span', { class: 'badge badge-accent' }, option.badge) : null,
          ),
          h('span', { class: 'choice-description' }, option.description),
        ),
      ),
    ),
  );
}

function callout(kind, ...children) {
  const iconName = kind === 'warning' || kind === 'danger' ? 'alert' : kind === 'success' ? 'check' : 'info';
  return h('div', { class: `callout callout-${kind}`, role: kind === 'danger' ? 'alert' : null }, icon(iconName), h('div', null, ...children));
}

function copyButton(text, { label = t('common.copy'), compact } = {}) {
  return h(
    'button',
    {
      type: 'button',
      class: `btn btn-ghost${compact ? ' btn-icon' : ' btn-sm'}`,
      title: t('common.copy'),
      'aria-label': `${t('common.copy')}: ${text}`,
      onClick: (event) => copy(text, event.currentTarget),
    },
    icon('copy'),
    compact ? null : h('span', { class: 'btn-label' }, label),
  );
}

function codeLine(text) {
  return h('div', { class: 'code-line' }, h('code', null, text), copyButton(text, { compact: true }));
}

function section(title, description, ...children) {
  return h(
    'section',
    { class: 'section' },
    title ? h('h2', null, title) : null,
    description ? h('p', { class: 'section-description' }, description) : null,
    ...children,
  );
}

function card(...children) {
  return h('div', { class: 'card' }, ...children);
}

function externalLink(href, label) {
  return h('a', { href, target: '_blank', rel: 'noreferrer noopener', class: 'link' }, label, icon('external', 'icon icon-xs'));
}

// ---------------------------------------------------------------------------------------------
// Steps

function welcomeStep() {
  const features = [
    ['server', t('welcome.item.app.title'), t('welcome.item.app.text')],
    ['flask', t('welcome.item.e2e.title'), t('welcome.item.e2e.text')],
    ['bot', t('welcome.item.mcp.title'), t('welcome.item.mcp.text')],
    ['key', t('welcome.item.keys.title'), t('welcome.item.keys.text')],
  ];
  return [
    app.exists
      ? callout('info', h('strong', null, t('welcome.existing.title')), h('p', null, t('welcome.existing.text')))
      : null,
    h('div', { class: 'feature-grid' }, features.map(([name, title, text]) =>
      h('div', { class: 'feature' }, h('span', { class: 'feature-icon' }, icon(name)), h('div', null, h('h3', null, title), h('p', null, text))),
    )),
    card(
      h('h3', { class: 'card-title' }, t('welcome.quick.title')),
      h('p', { class: 'muted' }, t('welcome.quick.text')),
      h(
        'div',
        { class: 'button-row' },
        h('button', { type: 'button', class: 'btn btn-primary', onClick: () => goTo(STEPS.length - 1) }, icon('play'), t('welcome.quick.recommended')),
        h('button', { type: 'button', class: 'btn btn-secondary', onClick: () => goTo(1) }, t('welcome.quick.customize'), icon('arrowRight')),
      ),
    ),
    h('p', { class: 'fine-print' }, t('welcome.requirements')),
  ];
}

function accessStep() {
  const state = app.state;
  const derived = derivedUrls(state);
  const current = urls();
  const notes = warnings(state);
  return [
    section(
      t('access.address.title'),
      t('access.address.text'),
      field({ id: 'host', label: t('access.host.label'), hint: t('access.host.hint'), placeholder: 'localhost', mono: true }),
      toggle({ id: 'network', title: t('access.network.title'), description: t('access.network.text') }),
      notes.map((key) => callout('warning', h('p', null, t(key)))),
    ),
    section(
      t('access.ports.title'),
      t('access.ports.text'),
      h(
        'div',
        { class: 'grid-4' },
        field({ id: 'webPort', label: t('access.port.web'), inputmode: 'numeric', mono: true }),
        field({ id: 'apiPort', label: t('access.port.api'), inputmode: 'numeric', mono: true }),
        state.mcp ? field({ id: 'mcpPort', label: t('access.port.mcp'), inputmode: 'numeric', mono: true }) : null,
        state.emailMode === 'mailpit'
          ? field({ id: 'mailPort', label: t('access.port.mail'), inputmode: 'numeric', mono: true })
          : null,
      ),
    ),
    section(
      t('access.urls.title'),
      null,
      toggle({ id: 'customUrls', title: t('access.custom.title'), description: t('access.custom.text') }),
      state.customUrls
        ? h(
            'div',
            { class: 'stack' },
            field({ id: 'webUrl', label: t('access.url.web'), placeholder: derived.webUrl, mono: true }),
            field({ id: 'apiUrl', label: t('access.url.api'), placeholder: derived.apiUrl, mono: true }),
            state.mcp
              ? field({ id: 'mcpUrl', label: t('access.url.mcp'), placeholder: derived.mcpUrl, mono: true, hint: t('access.url.mcpHint') })
              : null,
          )
        : h(
            'dl',
            { class: 'url-list' },
            h('dt', null, t('access.url.web')),
            h('dd', null, h('code', null, current.webUrl)),
            h('dt', null, t('access.url.api')),
            h('dd', null, h('code', null, current.apiUrl)),
            state.mcp ? [h('dt', null, t('access.url.mcp')), h('dd', null, h('code', null, `${current.mcpUrl}/mcp`))] : null,
          ),
    ),
  ];
}

function featuresStep() {
  const state = app.state;
  return [
    card(
      h(
        'div',
        { class: 'card-head' },
        h('span', { class: 'feature-icon' }, icon('database')),
        h('div', null, h('h3', { class: 'card-title' }, t('features.core.title')), h('p', { class: 'muted' }, t('features.core.text'))),
        h('span', { class: 'badge' }, t('features.alwaysOn')),
      ),
    ),
    card(
      toggle({ id: 'e2e', title: t('features.e2e.title'), description: t('features.e2e.text'), badge: t('features.e2e.size') }),
      state.e2e
        ? h(
            'div',
            { class: 'nested' },
            field({ id: 'e2eConcurrency', label: t('features.e2e.concurrency'), hint: t('features.e2e.concurrencyHint'), inputmode: 'numeric', mono: true }),
            h('p', { class: 'label' }, t('features.e2e.storage')),
            choiceCards('e2eStorage', [
              { value: 'postgres', title: t('features.storage.postgres.title'), description: t('features.storage.postgres.text'), badge: t('common.recommended') },
              { value: 'r2', title: t('features.storage.r2.title'), description: t('features.storage.r2.text') },
            ]),
            state.e2eStorage === 'r2'
              ? h(
                  'div',
                  { class: 'stack' },
                  field({ id: 'r2Url', label: t('features.r2.url'), placeholder: 'https://<account-id>.r2.cloudflarestorage.com/<bucket>', mono: true }),
                  h('div', { class: 'grid-2' },
                    field({ id: 'r2AccessKeyId', label: t('features.r2.keyId'), mono: true }),
                    field({ id: 'r2SecretAccessKey', label: t('features.r2.secret'), type: 'password', mono: true, autocomplete: 'new-password' }),
                  ),
                  field({ id: 'r2Prefix', label: t('features.r2.prefix'), placeholder: 'e2e', mono: true }),
                )
              : null,
            callout('info', h('p', null, t('features.e2e.localTarget'), ' ', h('code', null, 'http://host.docker.internal:<port>'))),
          )
        : null,
    ),
    card(
      toggle({ id: 'mcp', title: t('features.mcp.title'), description: t('features.mcp.text') }),
      state.mcp
        ? h(
            'div',
            { class: 'nested' },
            h('p', { class: 'label' }, t('features.mcp.endpoint')),
            codeLine(`${urls().mcpUrl}/mcp`),
            h('p', { class: 'field-hint' }, t('features.mcp.publicHint')),
            field({ id: 'mcpAllowedHosts', label: t('features.mcp.allowedHosts'), hint: t('features.mcp.allowedHostsHint'), placeholder: 'mcp.example.com', mono: true }),
          )
        : null,
    ),
  ];
}

function emailStep() {
  const state = app.state;
  const presets = [
    ['gmail', 'Gmail'],
    ['outlook', 'Outlook / Microsoft 365'],
    ['sendgrid', 'SendGrid'],
    ['resend', 'Resend'],
  ];
  return [
    choiceCards('emailMode', [
      { value: 'mailpit', title: t('email.mailpit.title'), description: t('email.mailpit.text', { url: urls().mailUrl }), badge: t('common.recommended') },
      { value: 'smtp', title: t('email.smtp.title'), description: t('email.smtp.text') },
      { value: 'none', title: t('email.none.title'), description: t('email.none.text') },
    ]),
    state.emailMode === 'smtp'
      ? section(
          t('email.server.title'),
          t('email.server.text'),
          h(
            'div',
            { class: 'chips', role: 'group', 'aria-label': t('email.presets') },
            presets.map(([key, label]) =>
              h('button', {
                type: 'button',
                class: 'chip',
                onClick: () => {
                  Object.assign(app.state, { smtpUser: '' }, EMAIL_PRESETS[key]);
                  render();
                },
              }, label),
            ),
          ),
          h('div', { class: 'grid-host-port' },
            field({ id: 'smtpHost', label: t('email.host'), placeholder: 'smtp.example.com', mono: true }),
            field({ id: 'smtpPort', label: t('email.port'), inputmode: 'numeric', mono: true }),
          ),
          toggle({ id: 'smtpSecure', title: t('email.secure.title'), description: t('email.secure.text') }),
          h('div', { class: 'grid-2' },
            field({ id: 'smtpUser', label: t('email.user'), autocomplete: 'off', mono: true }),
            field({ id: 'smtpPassword', label: t('email.password'), type: 'password', hint: t('email.passwordHint'), autocomplete: 'new-password', mono: true }),
          ),
        )
      : null,
    state.emailMode !== 'none'
      ? section(null, null, field({ id: 'smtpFrom', label: t('email.from'), hint: t('email.fromHint'), placeholder: 'ADK <no-reply@example.com>' }))
      : null,
  ];
}

function providerCard({ name, mark, consoleUrl, consoleLabel, steps, idField, secretField }) {
  const configured = app.state[idField].trim() && app.state[secretField].trim();
  return card(
    h(
      'div',
      { class: 'card-head' },
      h('span', { class: 'feature-icon' }, mark),
      h('div', null, h('h3', { class: 'card-title' }, name), h('p', { class: 'muted' }, configured ? t('signin.enabled') : t('signin.disabled'))),
      configured ? h('span', { class: 'badge badge-success' }, icon('check', 'icon icon-xs'), t('signin.on')) : null,
    ),
    h('ol', { class: 'howto' }, h('li', null, externalLink(consoleUrl, consoleLabel)), steps.map((step) => h('li', null, ...step))),
    h('div', { class: 'grid-2' },
      field({ id: idField, label: t('signin.clientId'), mono: true }),
      field({ id: secretField, label: t('signin.clientSecret'), type: 'password', autocomplete: 'new-password', mono: true }),
    ),
  );
}

function signinStep() {
  const { apiUrl, webUrl } = urls();
  const googleCallback = `${apiUrl}/auth/oauth/google/callback`;
  const githubCallback = `${apiUrl}/auth/oauth/github/callback`;
  const insecureRemote = !/^http:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(apiUrl) && apiUrl.startsWith('http:');
  return [
    callout('info', h('p', null, t('signin.intro'))),
    providerCard({
      name: 'Google',
      mark: h('span', { class: 'monogram' }, 'G'),
      consoleUrl: 'https://console.cloud.google.com/apis/credentials',
      consoleLabel: t('signin.google.console'),
      steps: [[t('signin.google.step')], [t('signin.redirect'), codeLine(googleCallback)]],
      idField: 'googleClientId',
      secretField: 'googleClientSecret',
    }),
    insecureRemote ? callout('warning', h('p', null, t('signin.google.https'))) : null,
    providerCard({
      name: 'GitHub',
      mark: icon('github'),
      consoleUrl: 'https://github.com/settings/applications/new',
      consoleLabel: t('signin.github.console'),
      steps: [[t('signin.homepage'), codeLine(webUrl)], [t('signin.callback'), codeLine(githubCallback)]],
      idField: 'githubClientId',
      secretField: 'githubClientSecret',
    }),
  ];
}

function secretRow(definition) {
  const { key, locked } = definition;
  const isLocked = locked && app.exists && !app.unlocked.has(key);
  const revealed = app.revealed.has(key);
  const error = errorFor(key);
  return h(
    'div',
    { class: `secret${error ? ' has-error' : ''}` },
    h(
      'div',
      { class: 'secret-head' },
      h('label', { for: key, class: 'secret-name' }, t(`security.${key}.title`), isLocked ? h('span', { class: 'badge' }, icon('lock', 'icon icon-xs'), t('security.locked')) : null),
      h('p', { class: 'muted small' }, t(`security.${key}.text`)),
    ),
    h(
      'div',
      { class: 'secret-input' },
      h('input', {
        id: key,
        type: revealed ? 'text' : 'password',
        class: 'mono',
        value: app.state[key],
        readonly: isLocked,
        autocomplete: 'off',
        spellcheck: 'false',
        'aria-invalid': error ? 'true' : null,
        onInput: (event) => update(key, event.target.value.trim()),
      }),
      h('button', {
        type: 'button',
        class: 'btn btn-ghost btn-icon',
        title: revealed ? t('security.hide') : t('security.show'),
        'aria-label': revealed ? t('security.hide') : t('security.show'),
        'aria-pressed': revealed ? 'true' : 'false',
        onClick: () => {
          if (revealed) app.revealed.delete(key);
          else app.revealed.add(key);
          render();
        },
      }, icon(revealed ? 'eyeOff' : 'eye')),
      copyButton(app.state[key], { compact: true }),
      isLocked
        ? h('button', { type: 'button', class: 'btn btn-ghost btn-sm', onClick: () => { app.confirmUnlock = key; render(); } }, icon('unlock'), t('security.change'))
        : h('button', {
            type: 'button',
            class: 'btn btn-ghost btn-icon',
            title: t('security.regenerate'),
            'aria-label': t('security.regenerate'),
            onClick: () => update(key, generateSecret(definition.bytes)),
          }, icon('refresh')),
    ),
    error ? h('p', { class: 'field-error' }, icon('alert', 'icon icon-sm'), error) : null,
    app.confirmUnlock === key
      ? callout(
          'danger',
          h('strong', null, t('security.unlock.title')),
          h('p', null, t(`security.${key}.danger`)),
          h('div', { class: 'button-row' },
            h('button', { type: 'button', class: 'btn btn-danger btn-sm', onClick: () => { app.unlocked.add(key); app.confirmUnlock = null; render(); } }, t('security.unlock.confirm')),
            h('button', { type: 'button', class: 'btn btn-ghost btn-sm', onClick: () => { app.confirmUnlock = null; render(); } }, t('common.cancel')),
          ),
        )
      : null,
  );
}

function securityStep() {
  return [
    callout(
      app.exists ? 'info' : 'success',
      h('p', null, app.exists ? t('security.introExisting') : t('security.intro')),
    ),
    !app.exists ? callout('warning', h('p', null, t('security.backup'))) : null,
    h('div', { class: 'secrets' }, SECRET_FIELDS.map(secretRow)),
  ];
}

function reviewStep() {
  const state = app.state;
  const current = urls();
  const errors = allErrors();
  const broken = STEPS.map((step, index) => (stepHasErrors(index, errors) ? index : -1)).filter((index) => index >= 0);
  const services = [
    t('review.service.web'),
    t('review.service.api'),
    'PostgreSQL',
    state.e2e ? t('review.service.e2e') : null,
    state.mcp ? t('review.service.mcp') : null,
    state.emailMode === 'mailpit' ? 'Mailpit' : null,
  ].filter(Boolean);
  const signin = [t('review.signin.password'), state.googleClientId.trim() ? 'Google' : null, state.githubClientId.trim() ? 'GitHub' : null].filter(Boolean);
  const keysKept = app.exists ? t('review.keys.kept') : t('review.keys.generated', { count: SECRET_FIELDS.length });

  const group = (stepIndex, rows) =>
    h(
      'div',
      { class: 'review-group' },
      h(
        'div',
        { class: 'review-head' },
        h('h3', null, t(`step.${STEPS[stepIndex].id}.title`)),
        h('button', { type: 'button', class: 'btn btn-ghost btn-sm', onClick: () => goTo(stepIndex) }, t('common.edit')),
      ),
      h('dl', { class: 'review-list' }, rows.filter(Boolean).map(([label, value]) => [h('dt', null, label), h('dd', null, value)])),
    );

  return [
    broken.length
      ? callout(
          'danger',
          h('strong', null, t('review.errors')),
          h('ul', { class: 'plain-list' }, broken.map((index) => h('li', null, h('button', { type: 'button', class: 'link-button', onClick: () => { app.submitted.add(index); goTo(index); } }, t(`step.${STEPS[index].id}.title`))))),
        )
      : null,
    h('div', { class: 'service-chips' }, services.map((name) => h('span', { class: 'service-chip' }, icon('check', 'icon icon-xs'), name))),
    group(1, [
      [t('access.url.web'), h('code', null, current.webUrl)],
      [t('access.url.api'), h('code', null, current.apiUrl)],
      state.mcp ? [t('access.url.mcp'), h('code', null, `${current.mcpUrl}/mcp`)] : null,
      [t('review.network'), state.network ? t('review.network.on') : t('review.network.off')],
    ]),
    group(2, [
      [t('features.e2e.title'), state.e2e ? t('review.e2e.on', { count: state.e2eConcurrency, storage: state.e2eStorage === 'r2' ? 'Cloudflare R2' : 'PostgreSQL' }) : t('common.off')],
      [t('features.mcp.title'), state.mcp ? t('common.on') : t('common.off')],
    ]),
    group(3, [[t('review.email'), t(`review.email.${state.emailMode}`, { host: state.smtpHost, url: current.mailUrl })]]),
    group(4, [[t('review.signin'), signin.join(' · ')]]),
    group(5, [[t('review.keys'), keysKept]]),
    h('p', { class: 'fine-print' }, t('review.where', { file: '.env' })),
    app.saveError ? callout('danger', h('p', null, app.saveError)) : null,
  ];
}

const STEP_RENDERERS = {
  welcome: welcomeStep,
  access: accessStep,
  features: featuresStep,
  email: emailStep,
  signin: signinStep,
  security: securityStep,
  review: reviewStep,
};

// ---------------------------------------------------------------------------------------------
// Saving and launching

async function save(start) {
  const errors = allErrors();
  if (Object.keys(errors).length) {
    STEPS.forEach((_, index) => app.submitted.add(index));
    render();
    return;
  }
  app.saving = true;
  app.saveError = null;
  render();
  try {
    const response = await fetch('/api/save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-ADK-Setup': '1' },
      body: JSON.stringify({ state: app.state, start }),
    });
    const body = await response.json().catch(() => ({}));
    if (response.status === 422 && body.errors) {
      app.serverErrors = body.errors;
      STEPS.forEach((_, index) => app.submitted.add(index));
      throw new Error(t('review.errors'));
    }
    if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
    startLaunch(start);
  } catch (error) {
    app.saveError = t('review.saveFailed', { reason: error instanceof Error ? error.message : String(error) });
  } finally {
    app.saving = false;
    render();
  }
}

async function cancelSetup() {
  if (!window.confirm(t('exit.confirm'))) return;
  try {
    await fetch('/api/cancel', { method: 'POST', headers: { 'X-ADK-Setup': '1' } });
  } catch {
    // The server may already be gone; the page still closes the session.
  }
  app.phase = 'closed';
  render();
}

function startLaunch(start) {
  const current = urls();
  app.phase = 'launch';
  app.launch = {
    start,
    urls: current,
    mcp: app.state.mcp,
    mailpit: app.state.emailMode === 'mailpit',
    startedAt: Date.now(),
    checks: { api: 'pending', web: 'pending', ...(app.state.mcp ? { mcp: 'pending' } : {}) },
  };
  if (start || !app.launcher) pollServices();
}

async function probe(url, readable) {
  try {
    const response = await fetch(url, { cache: 'no-store', mode: readable ? 'cors' : 'no-cors' });
    return readable ? response.ok : true;
  } catch {
    return false;
  }
}

async function pollServices() {
  const launch = app.launch;
  if (!launch || app.phase !== 'launch') return;
  const { urls: current } = launch;
  const targets = {
    api: () => probe(`${current.apiUrl}/health/ready`, true),
    web: () => probe(`${current.webUrl}/health`, false),
    mcp: () => probe(`${current.mcpUrl}/healthz`, false),
  };
  await Promise.all(
    Object.keys(launch.checks).map(async (name) => {
      if (launch.checks[name] !== 'ok' && (await targets[name]())) launch.checks[name] = 'ok';
    }),
  );
  render();
  const done = Object.values(launch.checks).every((status) => status === 'ok');
  if (!done && Date.now() - launch.startedAt < 45 * 60 * 1000) setTimeout(pollServices, 3000);
}

function elapsed(since) {
  const seconds = Math.floor((Date.now() - since) / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

function command(name) {
  return isWindows ? `adk.cmd ${name}`.trim() : `./adk.sh ${name}`.trim();
}

function launchView() {
  const launch = app.launch;
  const { urls: current } = launch;
  const ready = launch.checks.api === 'ok' && launch.checks.web === 'ok';
  const watching = launch.start || !app.launcher;
  const statusRow = (name, label) =>
    h(
      'li',
      { class: `status status-${launch.checks[name]}` },
      launch.checks[name] === 'ok' ? icon('check') : h('span', { class: 'spinner', 'aria-hidden': 'true' }),
      h('span', null, label),
      h('span', { class: 'muted small' }, launch.checks[name] === 'ok' ? t('launch.ready') : t('launch.waiting')),
    );

  return h(
    'div',
    { class: 'launch' },
    h('div', { class: 'launch-hero' },
      h('span', { class: `hero-icon${ready ? ' is-ready' : ''}` }, icon(ready ? 'check' : 'server')),
      h('h1', { id: 'step-title', tabindex: '-1' }, ready ? t('launch.readyTitle') : t('launch.savedTitle')),
      h('p', { class: 'lead' },
        ready
          ? t('launch.readyText')
          : launch.start
            ? t('launch.startingText')
            : app.launcher
              ? t('launch.savedOnlyText')
              : t('launch.manualText')),
    ),
    !launch.start
      ? card(h('p', { class: 'label' }, t('launch.startWith')), codeLine(app.launcher ? command('') : 'docker compose up -d --build'))
      : null,
    watching
      ? card(
          h('div', { class: 'card-head' },
            h('h3', { class: 'card-title' }, t('launch.services')),
            ready ? null : h('span', { class: 'muted small', id: 'elapsed' }, t('launch.elapsed', { time: elapsed(launch.startedAt) })),
          ),
          h('ul', { class: 'status-list' },
            statusRow('api', t('review.service.api')),
            statusRow('web', t('review.service.web')),
            launch.mcp ? statusRow('mcp', t('review.service.mcp')) : null,
          ),
          ready ? null : h('p', { class: 'field-hint' }, t('launch.firstRun')),
        )
      : null,
    ready
      ? h('div', { class: 'button-row center' }, h('a', { class: 'btn btn-primary btn-lg', href: current.webUrl }, t('launch.open'), icon('arrowRight')))
      : null,
    section(
      t('launch.next.title'),
      null,
      h('ol', { class: 'next-steps' },
        h('li', null, h('strong', null, t('launch.next.account.title')), h('p', null, t('launch.next.account.text', { url: current.webUrl }))),
        h('li', null,
          h('strong', null, t('launch.next.assistant.title')),
          h('p', null, t('launch.next.assistant.text')),
          codeLine('npm install -g @agent-devkit/cli'),
          codeLine(`devkit login --api-url ${current.apiUrl}`),
          launch.mcp ? [h('p', null, t('launch.next.assistant.remote')), codeLine(`${current.mcpUrl}/mcp`)] : null,
        ),
        h('li', null, h('strong', null, t('launch.next.llm.title')), h('p', null, t('launch.next.llm.text'))),
        launch.mailpit ? h('li', null, h('strong', null, t('launch.next.mail.title')), h('p', null, t('launch.next.mail.text')), codeLine(current.mailUrl)) : null,
      ),
    ),
    section(
      t('launch.commands.title'),
      null,
      h('dl', { class: 'command-list' },
        [['', 'launch.commands.start'], ['stop', 'launch.commands.stop'], ['logs', 'launch.commands.logs'], ['setup', 'launch.commands.setup'], ['update', 'launch.commands.update']].map(([name, key]) => [
          h('dt', null, h('code', null, command(name))),
          h('dd', null, t(key)),
        ]),
      ),
    ),
  );
}

// ---------------------------------------------------------------------------------------------
// Layout

function topbar() {
  return h(
    'header',
    { class: 'topbar' },
    h('div', { class: 'brand' }, h('img', { src: '/logo.png', alt: '', width: '28', height: '28' }), h('span', null, 'ADK'), h('span', { class: 'brand-sub' }, t('app.subtitle'))),
    h(
      'div',
      { class: 'topbar-actions' },
      h('label', { class: 'sr-only', for: 'language' }, t('app.language')),
      h('select', { id: 'language', class: 'select-compact', onChange: (event) => { setLocale(event.target.value); render(); } },
        LOCALES.map(([value, label]) => h('option', { value, selected: value === getLocale() ? 'selected' : null }, label)),
      ),
      app.phase === 'wizard'
        ? h('button', { type: 'button', class: 'btn btn-ghost btn-sm', onClick: cancelSetup }, icon('x'), t('exit.button'))
        : null,
    ),
  );
}

function stepper() {
  const errors = allErrors();
  return h(
    'nav',
    { class: 'stepper', 'aria-label': t('app.steps') },
    h('ol', null,
      STEPS.map((step, index) => {
        const current = index === app.step;
        const invalid = (app.submitted.has(index) || app.visited.has(index)) && index !== app.step && stepHasErrors(index, errors);
        const done = app.visited.has(index) && index < app.step && !invalid;
        return h(
          'li',
          null,
          h(
            'button',
            {
              type: 'button',
              class: `step${current ? ' is-current' : ''}${done ? ' is-done' : ''}${invalid ? ' is-invalid' : ''}`,
              'aria-current': current ? 'step' : null,
              onClick: () => goTo(index),
            },
            h('span', { class: 'step-marker' }, invalid ? icon('alert', 'icon icon-sm') : done ? icon('check', 'icon icon-sm') : String(index + 1)),
            h('span', { class: 'step-text' }, h('span', { class: 'step-title' }, t(`step.${step.id}.title`)), h('span', { class: 'step-sub' }, t(`step.${step.id}.short`))),
          ),
        );
      }),
    ),
  );
}

function wizardView() {
  const step = STEPS[app.step];
  const last = app.step === STEPS.length - 1;
  const hasErrors = Object.keys(allErrors()).length > 0;
  return h(
    'div',
    { class: 'body' },
    stepper(),
    h(
      'main',
      { class: 'panel' },
      h('div', { class: 'progress', 'aria-hidden': 'true' }, h('span', { style: `width:${((app.step + 1) / STEPS.length) * 100}%` })),
      h(
        'div',
        { class: 'panel-scroll' },
        h(
          'div',
          { class: 'panel-inner' },
          h('p', { class: 'eyebrow' }, t('app.stepOf', { current: app.step + 1, total: STEPS.length })),
          h('h1', { id: 'step-title', tabindex: '-1' }, t(`step.${step.id}.heading`)),
          h('p', { class: 'lead' }, t(`step.${step.id}.lead`)),
          h('div', { class: 'step-content' }, STEP_RENDERERS[step.id]()),
        ),
      ),
      h(
        'footer',
        { class: 'actions' },
        app.step > 0
          ? h('button', { type: 'button', class: 'btn btn-ghost', onClick: () => goTo(app.step - 1) }, icon('arrowLeft'), t('common.back'))
          : h('span'),
        last
          ? h(
              'div',
              { class: 'button-row' },
              app.launcher
                ? h('button', { type: 'button', class: 'btn btn-secondary', disabled: app.saving || hasErrors, onClick: () => save(false) }, t('review.saveOnly'))
                : null,
              h('button', { type: 'button', class: 'btn btn-primary', disabled: app.saving || hasErrors, onClick: () => save(true) },
                app.saving ? h('span', { class: 'spinner', 'aria-hidden': 'true' }) : icon('play'),
                app.launcher ? t('review.saveStart') : t('review.save'),
              ),
            )
          : h('button', { type: 'button', class: 'btn btn-primary', onClick: next }, t('common.next'), icon('arrowRight')),
      ),
    ),
  );
}

function messageView(title, text) {
  return h('div', { class: 'message' }, h('h1', { id: 'step-title', tabindex: '-1' }, title), h('p', { class: 'lead' }, text));
}

function render() {
  const active = document.activeElement;
  const focusId = active?.id;
  const selection = active && 'selectionStart' in active ? [active.selectionStart, active.selectionEnd] : null;
  document.documentElement.lang = getLocale();
  document.title = t('app.title');

  let content;
  if (app.phase === 'loading') content = messageView(t('app.loading'), '');
  else if (app.phase === 'error') content = messageView(t('app.errorTitle'), app.saveError ?? '');
  else if (app.phase === 'closed') content = messageView(t('exit.closedTitle'), t('exit.closedText'));
  else if (app.phase === 'launch') content = h('div', { class: 'body body-single' }, h('main', { class: 'panel' }, h('div', { class: 'panel-scroll' }, h('div', { class: 'panel-inner' }, launchView()))));
  else content = wizardView();

  const scroll = document.querySelector('.panel-scroll')?.scrollTop ?? 0;
  root.replaceChildren(h('div', { class: 'shell' }, topbar(), content));
  const panel = document.querySelector('.panel-scroll');
  if (panel) panel.scrollTop = scroll;

  if (focusId) {
    const element = document.getElementById(focusId);
    if (element && element !== document.activeElement) {
      element.focus({ preventScroll: true });
      if (selection && 'setSelectionRange' in element) {
        try {
          element.setSelectionRange(selection[0], selection[1]);
        } catch {
          // Inputs such as checkboxes have no text selection.
        }
      }
    }
  }
}

async function init() {
  render();
  try {
    const response = await fetch('/api/state', { cache: 'no-store' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = await response.json();
    app.state = { ...createDefaultState(), ...body.state };
    app.original = { ...app.state };
    app.exists = body.exists;
    app.launcher = body.launcher;
    app.phase = 'wizard';
  } catch (error) {
    app.phase = 'error';
    app.saveError = t('app.errorText', { reason: error instanceof Error ? error.message : String(error) });
  }
  render();
}

window.addEventListener('beforeunload', (event) => {
  if (app.phase === 'wizard') event.preventDefault();
});

// Keep the elapsed-time counter moving while ADK starts.
setInterval(() => {
  if (app.phase === 'launch' && app.launch && Object.values(app.launch.checks).some((status) => status !== 'ok')) {
    const counter = document.getElementById('elapsed');
    if (counter) counter.textContent = t('launch.elapsed', { time: elapsed(app.launch.startedAt) });
  }
}, 1000);

init();
