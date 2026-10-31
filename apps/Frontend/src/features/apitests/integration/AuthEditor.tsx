import React from 'react';
import { Select } from '../../../components/ui/select.js';
import { useI18n } from '../../../lib/i18n/index.js';
import {
  AUTH_SECRET_FIELDS,
  OAUTH2_GRANTS,
  secretRef,
  type AuthType,
  type RequestAuth,
} from '../api-test-types.js';
import { VariableInput } from '../VariableInput.js';
import { PersonalHint, PersonalSecretField } from './PersonalSecretField.js';

// Auth of the collection, a folder or a request. Credential fields (AUTH_SECRET_FIELDS) are
// personal: see PersonalSecretField.

/** Every type, in the order of the select; `inherit` only where there is a parent. */
const AUTH_TYPES = [
  'inherit',
  'none',
  'bearer',
  'basic',
  'apikey',
  'digest',
  'oauth2',
  'oauth1',
  'awsv4',
  'wsse',
  'edgegrid',
] as const satisfies readonly AuthType[];

/** Product names: the same in every language. */
const TYPE_NAMES: Partial<Record<AuthType, string>> = {
  bearer: 'Bearer token',
  basic: 'Basic auth',
  apikey: 'API key',
  digest: 'Digest auth',
  oauth2: 'OAuth 2.0',
  oauth1: 'OAuth 1.0',
  awsv4: 'AWS Signature v4',
  wsse: 'WSSE',
  edgegrid: 'Akamai EdgeGrid',
};

/** A new auth of `type`, with its usual defaults. */
function defaultAuth(type: AuthType): RequestAuth {
  switch (type) {
    case 'bearer':
      return { type, token: '{{token}}' };
    case 'basic':
    case 'digest':
    case 'wsse':
      return { type, username: '', password: '' };
    case 'apikey':
      return { type, key: 'X-API-Key', value: '', in: 'header' };
    case 'oauth2':
      return {
        type,
        grantType: 'client_credentials',
        accessTokenUrl: '',
        clientId: '',
        clientSecret: '',
        scope: '',
        credentialsPlacement: 'body',
        tokenPlacement: 'header',
        tokenPrefix: 'Bearer',
      };
    case 'oauth1':
      return {
        type,
        consumerKey: '',
        consumerSecret: '',
        token: '',
        tokenSecret: '',
        signatureMethod: 'HMAC-SHA1',
        addTo: 'header',
      };
    case 'awsv4':
      return {
        type,
        accessKeyId: '',
        secretAccessKey: '',
        sessionToken: '',
        service: '',
        region: '',
      };
    case 'edgegrid':
      return { type, clientToken: '', clientSecret: '', accessToken: '', headersToSign: '' };
    default:
      return { type };
  }
}

type FieldName =
  | 'token'
  | 'username'
  | 'password'
  | 'key'
  | 'value'
  | 'accessTokenUrl'
  | 'clientId'
  | 'clientSecret'
  | 'refreshToken'
  | 'scope'
  | 'audience'
  | 'tokenPrefix'
  | 'tokenQueryKey'
  | 'accessKeyId'
  | 'secretAccessKey'
  | 'sessionToken'
  | 'service'
  | 'region'
  | 'consumerKey'
  | 'consumerSecret'
  | 'tokenSecret'
  | 'realm'
  | 'clientToken'
  | 'accessToken'
  | 'headersToSign'
  | 'maxBodySize';

interface SelectSpec {
  readonly name: string;
  readonly label: string;
  readonly options: readonly { value: string; label: string }[];
}

/** The text fields of an auth, in order; some depend on the other choices. */
function textFields(auth: RequestAuth): FieldName[] {
  switch (auth.type) {
    case 'bearer':
      return ['token'];
    case 'basic':
    case 'digest':
    case 'wsse':
      return ['username', 'password'];
    case 'apikey':
      return ['key', 'value'];
    case 'oauth2':
      return [
        'accessTokenUrl',
        'clientId',
        'clientSecret',
        ...(auth.grantType === 'password' ? (['username', 'password'] as const) : []),
        ...(auth.grantType === 'refresh_token' ? (['refreshToken'] as const) : []),
        'scope',
        'audience',
        auth.tokenPlacement === 'query' ? 'tokenQueryKey' : 'tokenPrefix',
      ];
    case 'oauth1':
      return ['consumerKey', 'consumerSecret', 'token', 'tokenSecret', 'realm'];
    case 'awsv4':
      return ['accessKeyId', 'secretAccessKey', 'sessionToken', 'service', 'region'];
    case 'edgegrid':
      return ['clientToken', 'clientSecret', 'accessToken', 'headersToSign', 'maxBodySize'];
    default:
      return [];
  }
}

export function AuthEditor({
  auth,
  onChange,
  readOnly,
  allowInherit,
  owner,
  personalSecrets,
  onClearPersonal,
  inherited,
}: {
  readonly auth: RequestAuth;
  readonly onChange: (auth: RequestAuth) => void;
  readonly readOnly: boolean;
  readonly allowInherit: boolean;
  /** `collection`, or the id of the folder or request: the owner part of `secretRef.auth`. */
  readonly owner: string;
  /** Refs of the personal secrets the current user has set (`ApiCollection.personalSecrets`). */
  readonly personalSecrets?: readonly string[];
  readonly onClearPersonal?: (ref: string) => void;
  /** For `inherit`: the auth that applies and where it is set. */
  readonly inherited?: { readonly from: string; readonly auth: RequestAuth } | null;
}): React.JSX.Element {
  const { t } = useI18n();
  const typeName = (type: AuthType) =>
    type === 'inherit' || type === 'none' ? t(`apiTests.auth.${type}`) : TYPE_NAMES[type]!;
  const values = auth as unknown as Record<string, string | number | undefined>;
  const set = (name: string, value: string | number | undefined) =>
    onChange({ ...auth, [name]: value });
  const secretFields = AUTH_SECRET_FIELDS[auth.type];

  const selects: SelectSpec[] = [];
  if (auth.type === 'apikey')
    selects.push({
      name: 'in',
      label: t('apiTests.ui.addTo'),
      options: [
        { value: 'header', label: 'Header' },
        { value: 'query', label: 'Query' },
      ],
    });
  if (auth.type === 'oauth2')
    selects.push(
      {
        name: 'grantType',
        label: t('apiTests.workbench.authFields.grantType'),
        options: OAUTH2_GRANTS.map((grant) => ({
          value: grant,
          label: t(`apiTests.workbench.grants.${grant}`),
        })),
      },
      {
        name: 'credentialsPlacement',
        label: t('apiTests.workbench.authFields.credentialsPlacement'),
        options: [
          { value: 'body', label: t('apiTests.workbench.authFields.inBody') },
          { value: 'basic', label: t('apiTests.workbench.authFields.basicHeader') },
        ],
      },
      {
        name: 'tokenPlacement',
        label: t('apiTests.workbench.authFields.tokenPlacement'),
        options: [
          { value: 'header', label: 'Header' },
          { value: 'query', label: 'Query' },
        ],
      },
    );
  if (auth.type === 'oauth1')
    selects.push(
      {
        name: 'signatureMethod',
        label: t('apiTests.workbench.authFields.signatureMethod'),
        options: ['HMAC-SHA1', 'HMAC-SHA256', 'PLAINTEXT'].map((value) => ({
          value,
          label: value,
        })),
      },
      {
        name: 'addTo',
        label: t('apiTests.ui.addTo'),
        options: [
          { value: 'header', label: 'Header' },
          { value: 'query', label: 'Query' },
        ],
      },
    );

  const label = (name: FieldName) =>
    name === 'username'
      ? t('apiTests.username')
      : name === 'password'
        ? t('apiTests.ui.password')
        : name === 'key'
          ? t('apiTests.key')
          : name === 'value'
            ? t('apiTests.value')
            : t(`apiTests.workbench.authFields.${name}`);

  return (
    <div className="flex max-w-2xl flex-col gap-4" data-testid="auth-editor">
      <Select
        aria-label={t('apiTests.authType')}
        containerClassName="w-64"
        value={auth.type}
        disabled={readOnly}
        onChange={(event) => onChange(defaultAuth(event.target.value as AuthType))}
        data-testid="auth-type"
      >
        {AUTH_TYPES.filter((type) => allowInherit || type !== 'inherit').map((type) => (
          <option key={type} value={type}>
            {typeName(type)}
          </option>
        ))}
      </Select>
      {auth.type === 'inherit' && (
        <p className="text-xs text-[var(--text-secondary)]" data-testid="auth-inherited">
          {inherited
            ? t('apiTests.workbench.inheritsFrom', {
                name: inherited.from,
                type: typeName(inherited.auth.type),
              })
            : t('apiTests.ui.inheritHint')}
        </p>
      )}
      {auth.type === 'none' && (
        <p className="text-xs text-[var(--text-muted)]">{t('apiTests.workbench.authNoneHint')}</p>
      )}
      {secretFields.length > 0 && <PersonalHint />}
      {selects.length > 0 && (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
          {selects.map((spec) => (
            <label
              key={spec.name}
              className="flex flex-col gap-1.5 text-xs text-[var(--text-secondary)]"
            >
              {spec.label}
              <Select
                aria-label={spec.label}
                value={String(values[spec.name] ?? spec.options[0]!.value)}
                disabled={readOnly}
                onChange={(event) => set(spec.name, event.target.value)}
              >
                {spec.options.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </Select>
            </label>
          ))}
        </div>
      )}
      {textFields(auth).length > 0 && (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {textFields(auth).map((name) => {
            const value = values[name] === undefined ? '' : String(values[name]);
            if (secretFields.includes(name)) {
              const ref = secretRef.auth(owner, name);
              return (
                <PersonalSecretField
                  key={name}
                  label={label(name)}
                  value={value}
                  personal={Boolean(personalSecrets?.includes(ref))}
                  onClear={onClearPersonal ? () => onClearPersonal(ref) : undefined}
                  readOnly={readOnly}
                  placeholder={`{{${name}}}`}
                  onValueChange={(next) => set(name, next)}
                  testId={`auth-field-${name}`}
                />
              );
            }
            return (
              <label
                key={name}
                className="flex flex-col gap-1.5 text-xs text-[var(--text-secondary)]"
                data-testid={`auth-field-${name}`}
              >
                {label(name)}
                <VariableInput
                  mono={name !== 'service' && name !== 'region'}
                  aria-label={label(name)}
                  value={value}
                  disabled={readOnly}
                  inputMode={name === 'maxBodySize' ? 'numeric' : undefined}
                  onValueChange={(next) =>
                    set(
                      name,
                      name === 'maxBodySize'
                        ? next.trim()
                          ? Number(next.replace(/\D/g, '')) || 0
                          : undefined
                        : next,
                    )
                  }
                />
              </label>
            );
          })}
        </div>
      )}
      {auth.type !== 'inherit' && auth.type !== 'none' && (
        <p className="text-xs text-[var(--text-muted)]">{t('apiTests.variablesHint')}</p>
      )}
    </div>
  );
}
