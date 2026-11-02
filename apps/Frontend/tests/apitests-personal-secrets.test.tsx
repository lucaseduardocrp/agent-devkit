import { useState } from 'react';
import { fireEvent, render, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type {
  ApiEnvironment,
  AuthType,
  RequestAuth,
  Variable,
} from '../src/features/apitests/api-test-types.js';
import { VariablesEditor } from '../src/features/apitests/ApiTestShared.js';
import { AuthEditor } from '../src/features/apitests/integration/AuthEditor.js';
import { EnvironmentsPane } from '../src/features/apitests/integration/EnvironmentsPane.js';
import {
  errorText,
  readFileBase64,
  readFileText,
  relativeName,
} from '../src/features/apitests/integration/file-read.js';
import { PersonalSecretField } from '../src/features/apitests/integration/PersonalSecretField.js';
import type { ApiClient } from '../src/lib/api-client.js';

describe('PersonalSecretField', () => {
  it('masks a personal value, clears it and notes literals that will be kept personal', () => {
    const onClear = vi.fn();
    const onValueChange = vi.fn();
    const view = render(
      <PersonalSecretField
        label="Token"
        value=""
        personal
        onClear={onClear}
        readOnly={false}
        onValueChange={onValueChange}
      />,
    );
    const input = view.getByLabelText('Token') as HTMLInputElement;
    expect(input.placeholder).toBe('•••••• (pessoal)');
    expect(view.getByTestId('personal-badge').textContent).toContain('Pessoal');
    fireEvent.click(view.getByTestId('clear-personal'));
    expect(onClear).toHaveBeenCalled();
    fireEvent.change(input, { target: { value: 'abc' } });
    expect(onValueChange).toHaveBeenCalledWith('abc');
    expect(view.queryByRole('note')).toBeNull();

    view.rerender(
      <PersonalSecretField
        label="Token"
        value="literal-token"
        personal={false}
        placeholder="{{token}}"
        readOnly={false}
        onValueChange={onValueChange}
      />,
    );
    expect(view.getByRole('note').textContent).toContain('mantido pessoal');
    expect(view.queryByTestId('clear-personal')).toBeNull();

    view.rerender(
      <PersonalSecretField
        label="Token"
        value="{{token}}"
        personal={false}
        readOnly={false}
        onValueChange={onValueChange}
      />,
    );
    expect(view.queryByRole('note')).toBeNull();
  });

  it('edits several lines and hides the clear action when read-only', () => {
    const onValueChange = vi.fn();
    const view = render(
      <PersonalSecretField
        multiline
        mono={false}
        label="Key"
        value=""
        personal
        onClear={vi.fn()}
        readOnly
        onValueChange={onValueChange}
      />,
    );
    const area = view.getByLabelText('Key') as HTMLTextAreaElement;
    expect(area.tagName).toBe('TEXTAREA');
    expect(area.placeholder).toBe('•••••• (pessoal)');
    expect(view.queryByTestId('clear-personal')).toBeNull();
    view.rerender(
      <PersonalSecretField
        multiline
        label="Key"
        value="x"
        personal={false}
        placeholder="PEM"
        readOnly={false}
        onValueChange={onValueChange}
      />,
    );
    fireEvent.change(view.getByLabelText('Key'), { target: { value: 'line1\nline2' } });
    expect(onValueChange).toHaveBeenCalledWith('line1\nline2');
  });
});

function AuthHarness({
  initial,
  allowInherit = true,
  personalSecrets,
  onClearPersonal,
  onChange,
  inherited,
}: {
  initial: RequestAuth;
  allowInherit?: boolean;
  personalSecrets?: string[];
  onClearPersonal?: (ref: string) => void;
  onChange?: (auth: RequestAuth) => void;
  inherited?: { from: string; auth: RequestAuth } | null;
}) {
  const [auth, setAuth] = useState(initial);
  return (
    <AuthEditor
      auth={auth}
      allowInherit={allowInherit}
      readOnly={false}
      owner="collection"
      personalSecrets={personalSecrets}
      onClearPersonal={onClearPersonal}
      inherited={inherited}
      onChange={(next) => {
        setAuth(next);
        onChange?.(next);
      }}
    />
  );
}

describe('AuthEditor', () => {
  const types: AuthType[] = [
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
    'inherit',
  ];

  it('offers every type and starts each with its defaults', () => {
    const onChange = vi.fn();
    const view = render(<AuthHarness initial={{ type: 'none' }} onChange={onChange} />);
    const select = view.getByTestId('auth-type') as HTMLSelectElement;
    expect([...select.options].map((option) => option.value)).toEqual([
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
    ]);
    for (const type of types) {
      fireEvent.change(select, { target: { value: type } });
      expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ type }));
    }
    expect(onChange).toHaveBeenCalledWith({ type: 'bearer', token: '{{token}}' });
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'oauth2', grantType: 'client_credentials' }),
    );
    // Without a parent there is nothing to inherit.
    const root = render(<AuthHarness initial={{ type: 'none' }} allowInherit={false} />);
    const rootSelect = within(root.container).getByTestId<HTMLSelectElement>('auth-type');
    expect([...rootSelect.options].some((option) => option.value === 'inherit')).toBe(false);
  });

  it('shows the OAuth 2.0 fields of the chosen grant and token placement', () => {
    const onChange = vi.fn();
    const view = render(
      <AuthHarness
        initial={{
          type: 'oauth2',
          grantType: 'client_credentials',
          accessTokenUrl: '',
          clientId: '',
          clientSecret: '',
        }}
        onChange={onChange}
      />,
    );
    expect(view.queryByTestId('auth-field-username')).toBeNull();
    fireEvent.change(view.getByLabelText('Tipo de concessão'), { target: { value: 'password' } });
    expect(view.getByTestId('auth-field-username')).toBeTruthy();
    expect(view.getByTestId('auth-field-password')).toBeTruthy();
    fireEvent.change(view.getByLabelText('Tipo de concessão'), {
      target: { value: 'refresh_token' },
    });
    expect(view.getByTestId('auth-field-refreshToken')).toBeTruthy();
    expect(view.getByTestId('auth-field-tokenPrefix')).toBeTruthy();
    fireEvent.change(view.getByLabelText('Adicionar token em'), { target: { value: 'query' } });
    expect(view.getByTestId('auth-field-tokenQueryKey')).toBeTruthy();
    fireEvent.change(view.getByLabelText('Escopo'), { target: { value: 'read' } });
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ scope: 'read' }));
    fireEvent.change(view.getByLabelText('Client secret'), { target: { value: 's3cr3t' } });
    expect(view.getAllByRole('note').length).toBe(1);
  });

  it('marks personal credentials and clears them by ref', () => {
    const onClearPersonal = vi.fn();
    const view = render(
      <AuthHarness
        initial={{ type: 'basic', username: '', password: '' }}
        personalSecrets={['auth:collection:password']}
        onClearPersonal={onClearPersonal}
      />,
    );
    const password = view.getByTestId('auth-field-password');
    expect(within(password).getByTestId('personal-badge')).toBeTruthy();
    expect(
      within(view.getByTestId('auth-field-username')).queryByTestId('personal-badge'),
    ).toBeNull();
    fireEvent.click(within(password).getByTestId('clear-personal'));
    expect(onClearPersonal).toHaveBeenCalledWith('auth:collection:password');
  });

  it('edits the other types: API key, OAuth 1.0, AWS, EdgeGrid', () => {
    const onChange = vi.fn();
    const view = render(
      <AuthHarness
        initial={{ type: 'apikey', key: 'X-Key', value: '', in: 'header' }}
        onChange={onChange}
      />,
    );
    fireEvent.change(view.getByLabelText('Adicionar em'), { target: { value: 'query' } });
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ in: 'query' }));

    const oauth1 = render(
      <AuthHarness
        initial={{
          type: 'oauth1',
          consumerKey: '',
          consumerSecret: '',
          signatureMethod: 'HMAC-SHA1',
        }}
        onChange={onChange}
      />,
    );
    fireEvent.change(oauth1.getByLabelText('Método de assinatura'), {
      target: { value: 'PLAINTEXT' },
    });
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ signatureMethod: 'PLAINTEXT' }),
    );
    expect(oauth1.getByTestId('auth-field-realm')).toBeTruthy();

    const aws = render(
      <AuthHarness
        initial={{ type: 'awsv4', accessKeyId: '', secretAccessKey: '', service: '', region: '' }}
        onChange={onChange}
      />,
    );
    fireEvent.change(aws.getByLabelText('Região'), { target: { value: 'us-east-1' } });
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ region: 'us-east-1' }));

    const edge = render(
      <AuthHarness
        initial={{ type: 'edgegrid', clientToken: '', clientSecret: '', accessToken: '' }}
        onChange={onChange}
      />,
    );
    const size = edge.getByLabelText('Tamanho máximo do corpo (bytes)');
    fireEvent.change(size, { target: { value: '12a' } });
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ maxBodySize: 12 }));
    fireEvent.change(size, { target: { value: 'x' } });
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ maxBodySize: 0 }));
    fireEvent.change(size, { target: { value: ' ' } });
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ maxBodySize: undefined }));
  });

  it('says where an inherited auth comes from', () => {
    const view = render(
      <AuthHarness
        initial={{ type: 'inherit' }}
        inherited={{ from: 'Admin', auth: { type: 'basic', username: '', password: '' } }}
      />,
    );
    expect(view.getByTestId('auth-inherited').textContent).toBe('Herda Basic auth de Admin.');
    const plain = render(<AuthHarness initial={{ type: 'inherit' }} />);
    expect(plain.getAllByTestId('auth-inherited')[1]!.textContent).not.toContain('Admin');
    const none = render(
      <AuthHarness
        initial={{ type: 'inherit' }}
        inherited={{ from: 'Root', auth: { type: 'none' } }}
      />,
    );
    expect(none.getAllByTestId('auth-inherited')[2]!.textContent).toContain('Root');
  });
});

function VariablesHarness({
  initial,
  personalSecrets,
  onClearPersonal,
  readOnly,
}: {
  initial: Variable[];
  personalSecrets?: string[];
  onClearPersonal?: (ref: string) => void;
  readOnly?: boolean;
}) {
  const [variables, setVariables] = useState(initial);
  return (
    <VariablesEditor
      variables={variables}
      personalSecrets={personalSecrets}
      onClearPersonal={onClearPersonal}
      readOnly={readOnly}
      onChange={setVariables}
    />
  );
}

describe('VariablesEditor', () => {
  it('shows personal secrets masked, clears them and explains the secret switch', () => {
    const onClearPersonal = vi.fn();
    const view = render(
      <VariablesHarness
        initial={[
          { key: 'baseUrl', value: 'https://x' },
          { key: 'password', value: '', secret: true, hasValue: true },
          { key: 'apiKey', value: '', secret: true },
          { key: 'pin', value: '', secret: true },
        ]}
        personalSecrets={['var:apiKey']}
        onClearPersonal={onClearPersonal}
      />,
    );
    expect((view.getByLabelText('password') as HTMLInputElement).placeholder).toBe(
      '•••••• (pessoal)',
    );
    expect((view.getByLabelText('apiKey') as HTMLInputElement).placeholder).toBe(
      '•••••• (pessoal)',
    );
    expect((view.getByLabelText('pin') as HTMLInputElement).placeholder).toBe('Seu valor pessoal');
    expect((view.getByLabelText('baseUrl') as HTMLInputElement).placeholder).toBe('Valor');
    expect(view.getAllByTestId('personal-badge')).toHaveLength(2);
    fireEvent.click(view.getAllByTestId('clear-personal')[0]!);
    expect(onClearPersonal).toHaveBeenCalledWith('var:password');

    // Typing a value replaces the mask.
    fireEvent.change(view.getByLabelText('password'), { target: { value: 'mine' } });
    expect((view.getByLabelText('password') as HTMLInputElement).placeholder).not.toBe(
      '•••••• (pessoal)',
    );
    const rows = view.getAllByTestId('variable-row');
    fireEvent.change(within(rows[0]!).getAllByLabelText('Chave')[0]!, { target: { value: 'url' } });
    fireEvent.click(within(rows[0]!).getByRole('checkbox'));
    expect((view.getByLabelText('url') as HTMLInputElement).type).toBe('password');
    fireEvent.click(within(rows[3]!).getByRole('button', { name: 'Remover' }));
    expect(view.getAllByTestId('variable-row')).toHaveLength(3);
    fireEvent.click(view.getByRole('button', { name: /Adicionar variável/ }));
    expect(view.getAllByTestId('variable-row')).toHaveLength(4);
  });

  it('explains the secret switch when there is no secret and hides editing when read-only', () => {
    const view = render(<VariablesHarness initial={[{ key: 'a', value: '1' }]} />);
    expect(view.getByText(/Secreto: cada membro/)).toBeTruthy();
    const readOnly = render(
      <VariablesHarness
        readOnly
        initial={[{ key: 'p', value: '', secret: true, hasValue: true }]}
        onClearPersonal={vi.fn()}
      />,
    );
    expect(readOnly.queryByTestId('clear-personal')).toBeNull();
    expect(readOnly.getByTestId('personal-badge')).toBeTruthy();
  });
});

describe('EnvironmentsPane personal secrets', () => {
  it('clears the current user value of a secret and reports failures', async () => {
    const environment: ApiEnvironment = {
      id: 'e1',
      name: 'Staging',
      variables: [
        { key: 'token', value: '', secret: true, hasValue: true },
        { key: 'other', value: 'kept' },
      ],
      personalSecrets: ['var:token'],
    };
    const api = {
      clearPersonalSecret: vi.fn(() => Promise.resolve()),
      saveApiEnvironment: vi.fn(() =>
        Promise.resolve({ ...environment, personalSecrets: undefined }),
      ),
    };
    const onChanged = vi.fn();
    const view = render(
      <EnvironmentsPane
        apiClient={api as unknown as ApiClient}
        environments={[environment]}
        activeId="e1"
        readOnly={false}
        onChanged={onChanged}
        onActivate={vi.fn()}
      />,
    );
    expect((view.getByLabelText('token') as HTMLInputElement).placeholder).toBe('•••••• (pessoal)');
    fireEvent.click(view.getByTestId('clear-personal'));
    await waitFor(() =>
      expect(api.clearPersonalSecret).toHaveBeenCalledWith({
        scope: 'environment',
        scopeId: 'e1',
        ref: 'var:token',
      }),
    );
    expect(await view.findByText('Seu valor pessoal foi limpo.')).toBeTruthy();
    expect(view.queryByTestId('personal-badge')).toBeNull();
    expect(onChanged).toHaveBeenCalled();

    // A save brings the new list back.
    fireEvent.change(view.getByTestId('environment-name'), { target: { value: 'Stage' } });
    fireEvent.click(view.getByTestId('save-environment'));
    await waitFor(() => expect(api.saveApiEnvironment).toHaveBeenCalled());

    api.clearPersonalSecret.mockRejectedValueOnce(new Error('denied'));
    const again = render(
      <EnvironmentsPane
        apiClient={api as unknown as ApiClient}
        environments={[environment]}
        activeId=""
        readOnly={false}
        onChanged={onChanged}
        onActivate={vi.fn()}
      />,
    );
    fireEvent.click(within(again.container).getByTestId('clear-personal'));
    expect(await again.findByText('denied')).toBeTruthy();
  });
});

describe('file-read', () => {
  it('reads text and base64, names files by their relative path and words errors', async () => {
    const file = new File(['hello'], 'a.proto');
    expect(await readFileText(file)).toBe('hello');
    expect(await readFileBase64(file)).toBe('aGVsbG8=');
    expect(relativeName(file)).toBe('a.proto');
    Object.defineProperty(file, 'webkitRelativePath', { value: 'protos/a.proto' });
    expect(relativeName(file)).toBe('protos/a.proto');
    expect(errorText(new Error('boom'))).toBe('boom');
    expect(errorText('plain')).toBe('plain');
  });

  it('fails when the browser cannot read the file', async () => {
    const original = globalThis.FileReader;
    class FailingReader {
      result: unknown = null;
      error: Error | null = null;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      readAsText() {
        this.onerror?.();
      }
      readAsDataURL() {
        this.result = new ArrayBuffer(1);
        this.onload?.();
      }
    }
    globalThis.FileReader = FailingReader as unknown as typeof FileReader;
    try {
      await expect(readFileText(new Blob(['x']))).rejects.toThrow('read failed');
      // A result that is not text reads as empty.
      expect(await readFileBase64(new Blob(['x']))).toBe('');
    } finally {
      globalThis.FileReader = original;
    }
  });
});
