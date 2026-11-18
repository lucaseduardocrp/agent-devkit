import { useState } from 'react';
import { fireEvent, render, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ApiCollection, ApiFolder } from '../src/features/apitests/api-test-types.js';
import { CollectionSettingsPane } from '../src/features/apitests/integration/CollectionSettingsPane.js';
import { FolderSettingsPane } from '../src/features/apitests/integration/FolderSettingsPane.js';

const base: ApiCollection = {
  id: 'c1',
  workspaceId: 'w1',
  name: 'Orders API',
  variables: [{ key: 'token', value: '', secret: true, hasValue: true }],
  auth: { type: 'bearer', token: '' },
  source: { kind: 'custom-kind' },
  updatedAt: '',
  personalSecrets: ['auth:collection:token', 'proxy:password', 'cert:0:pfx', 'cert:0:passphrase'],
  items: [
    {
      id: 'f1',
      type: 'folder',
      name: 'Admin',
      items: [],
    },
  ],
};

function Harness({
  initial,
  onChange,
  onClearPersonal,
  onError,
  onExport,
  onDelete,
  readOnly = false,
}: {
  initial: ApiCollection;
  onChange?: (collection: ApiCollection) => void;
  onClearPersonal?: (ref: string) => void;
  onError?: (message: string) => void;
  onExport?: (format: string) => void;
  onDelete?: () => void;
  readOnly?: boolean;
}) {
  const [collection, setCollection] = useState(initial);
  return (
    <CollectionSettingsPane
      collection={collection}
      readOnly={readOnly}
      onChange={(next) => {
        setCollection(next);
        onChange?.(next);
      }}
      onExport={onExport ?? vi.fn()}
      onDelete={onDelete ?? vi.fn()}
      onClearPersonal={onClearPersonal}
      onError={onError}
    />
  );
}

const tab = (view: ReturnType<typeof render>, name: RegExp) =>
  fireEvent.click(view.getByRole('tab', { name }));
const last = (fn: ReturnType<typeof vi.fn>) =>
  fn.mock.calls[fn.mock.calls.length - 1]![0] as ApiCollection;

describe('CollectionSettingsPane', () => {
  it('edits the overview, headers, variables, auth and docs', () => {
    const onChange = vi.fn();
    const onExport = vi.fn();
    const onDelete = vi.fn();
    const onClearPersonal = vi.fn();
    const view = render(
      <Harness
        initial={{ ...base, updatedAt: '2026-10-24T10:00:00Z', source: { kind: 'postman' } }}
        onChange={onChange}
        onExport={onExport}
        onDelete={onDelete}
        onClearPersonal={onClearPersonal}
      />,
    );
    fireEvent.change(view.getByTestId('collection-name'), { target: { value: 'Orders v2' } });
    expect(last(onChange).name).toBe('Orders v2');
    fireEvent.click(view.getByRole('button', { name: /Postman v2.1/ }));
    expect(onExport).toHaveBeenCalledWith('postman');
    fireEvent.click(view.getByRole('button', { name: /Excluir coleção/ }));
    expect(onDelete).toHaveBeenCalled();
    expect(view.getByText('Postman')).toBeTruthy();

    tab(view, /Headers/);
    fireEvent.click(view.getByRole('button', { name: /Adicionar/ }));
    expect(last(onChange).headers).toEqual([{ key: '', value: '' }]);
    expect(view.getByRole('tab', { name: /Headers/ }).textContent).toContain('1');

    tab(view, /Variáveis/);
    fireEvent.click(view.getByTestId('clear-personal'));
    expect(onClearPersonal).toHaveBeenCalledWith('var:token');
    fireEvent.click(view.getByRole('button', { name: /Adicionar variável/ }));
    expect(last(onChange).variables).toHaveLength(2);

    tab(view, /Auth/);
    fireEvent.click(within(view.getByTestId('auth-field-token')).getByTestId('clear-personal'));
    expect(onClearPersonal).toHaveBeenCalledWith('auth:collection:token');
    fireEvent.change(view.getByTestId('auth-type'), { target: { value: 'none' } });
    expect(last(onChange).auth).toEqual({ type: 'none' });

    tab(view, /Descrição/);
    fireEvent.change(view.getByTestId('collection-docs'), { target: { value: '# Orders' } });
    expect(last(onChange).description).toBe('# Orders');
  });

  it('writes the docs in Markdown and renders them in the preview', () => {
    const onChange = vi.fn();
    const view = render(
      <Harness
        initial={{ ...base, description: '# Orders\n\nNotes for the team.' }}
        onChange={onChange}
      />,
    );
    tab(view, /Descrição/);
    // Notes written by someone else open rendered, not as source.
    const preview = view.getByTestId('collection-docs-preview');
    expect(within(preview).getByRole('heading', { name: 'Orders' })).toBeInTheDocument();
    expect(view.queryByTestId('collection-docs')).toBeNull();

    fireEvent.click(view.getByRole('button', { name: 'Código' }));
    const editor = view.getByTestId('collection-docs') as HTMLTextAreaElement;
    expect(editor.value).toBe('# Orders\n\nNotes for the team.');
    fireEvent.change(editor, { target: { value: '## Edited' } });
    expect(last(onChange).description).toBe('## Edited');

    fireEvent.click(view.getByRole('button', { name: 'Pré-visualização' }));
    expect(
      within(view.getByTestId('collection-docs-preview')).getByRole('heading', { name: 'Edited' }),
    ).toBeInTheDocument();
  });

  it('opens empty docs in the editor and explains the empty preview', () => {
    const view = render(<Harness initial={base} />);
    tab(view, /Descrição/);
    expect(view.getByTestId('collection-docs')).toBeInTheDocument();
    fireEvent.click(view.getByRole('button', { name: 'Pré-visualização' }));
    expect(view.getByTestId('collection-docs-preview').textContent).toContain(
      'Ainda não há anotações',
    );
  });

  it('edits the collection scripts, tests and script flow', () => {
    const onChange = vi.fn();
    const view = render(<Harness initial={base} onChange={onChange} />);
    tab(view, /^Script/);
    const script = view.getByTestId('collection-script');
    fireEvent.change(within(script).getByLabelText('Antes da requisição'), {
      target: { value: "req.setHeader('a', 'b');" },
    });
    expect(last(onChange).scripts).toEqual({ preRequest: "req.setHeader('a', 'b');" });
    fireEvent.click(within(script).getByRole('tab', { name: /Depois da resposta/ }));
    fireEvent.change(within(script).getByLabelText('Depois da resposta'), {
      target: { value: 'adk.setVar("x", 1);' },
    });
    expect(last(onChange).scripts).toMatchObject({ postResponse: 'adk.setVar("x", 1);' });
    fireEvent.click(within(script).getByRole('radio', { name: /Sequencial/ }));
    expect(last(onChange).scriptFlow).toBe('sequential');
    expect(view.getByRole('tab', { name: /^Script/ }).textContent).toContain('•');

    tab(view, /^Testes/);
    fireEvent.change(within(view.getByTestId('collection-tests')).getByLabelText('Testes'), {
      target: { value: 'test("ok", () => {});' },
    });
    expect(last(onChange).scripts).toMatchObject({ tests: 'test("ok", () => {});' });
  });

  it('opens on the after-response script when only it is set', () => {
    const view = render(
      <Harness initial={{ ...base, scripts: { postResponse: 'x' }, scriptFlow: 'sandwich' }} />,
    );
    tab(view, /^Script/);
    expect(
      view.getByRole('tab', { name: /Depois da resposta/ }).getAttribute('aria-selected'),
    ).toBe('true');
  });

  it('configures the proxy with personal credentials', () => {
    const onChange = vi.fn();
    const onClearPersonal = vi.fn();
    const view = render(
      <Harness initial={base} onChange={onChange} onClearPersonal={onClearPersonal} />,
    );
    tab(view, /Proxy/);
    const proxy = view.getByTestId('proxy-settings');
    expect((within(proxy).getByLabelText('Host') as HTMLInputElement).disabled).toBe(true);
    fireEvent.click(view.getByTestId('proxy-enabled'));
    fireEvent.change(within(proxy).getByLabelText('Protocolo'), { target: { value: 'socks5' } });
    fireEvent.change(within(proxy).getByLabelText('Host'), { target: { value: 'proxy.local' } });
    fireEvent.change(within(proxy).getByLabelText('Porta'), { target: { value: '3128' } });
    fireEvent.change(within(proxy).getByLabelText('Porta'), { target: { value: '' } });
    fireEvent.change(within(proxy).getByLabelText('Usuário'), { target: { value: 'me' } });
    fireEvent.change(within(proxy).getByLabelText('Exceções'), { target: { value: 'localhost' } });
    expect(last(onChange).settings?.proxy).toEqual({
      enabled: true,
      protocol: 'socks5',
      hostname: 'proxy.local',
      port: 0,
      username: 'me',
      bypass: 'localhost',
    });
    fireEvent.click(within(view.getByTestId('proxy-password')).getByTestId('clear-personal'));
    expect(onClearPersonal).toHaveBeenCalledWith('proxy:password');
    expect(view.getByRole('tab', { name: /Proxy/ }).textContent).toContain('•');
  });

  it('manages client certificates, their files and personal parts', async () => {
    const onChange = vi.fn();
    const onClearPersonal = vi.fn();
    const onError = vi.fn();
    const view = render(
      <Harness
        initial={base}
        onChange={onChange}
        onClearPersonal={onClearPersonal}
        onError={onError}
      />,
    );
    tab(view, /Certificados de cliente/);
    expect(view.getByText('Nenhum certificado de cliente.')).toBeTruthy();
    fireEvent.click(view.getByTestId('add-certificate'));
    const certificate = view.getByTestId('certificate');
    fireEvent.change(within(certificate).getByLabelText('Domínio'), {
      target: { value: 'api.test' },
    });
    fireEvent.change(within(certificate).getByLabelText('Certificado'), {
      target: { value: '-----BEGIN CERTIFICATE-----' },
    });
    fireEvent.change(within(certificate).getByLabelText('Chave privada'), {
      target: { value: 'KEY' },
    });
    const [certFile, keyFile] = within(certificate).getAllByLabelText('Carregar arquivo', {
      selector: 'input',
    });
    fireEvent.change(certFile!, { target: { files: [new File(['CERT'], 'c.pem')] } });
    await waitFor(() =>
      expect(last(onChange).settings?.clientCertificates?.[0]?.cert).toBe('CERT'),
    );
    fireEvent.change(keyFile!, { target: { files: [new File(['PEMKEY'], 'k.pem')] } });
    await waitFor(() =>
      expect(last(onChange).settings?.clientCertificates?.[0]?.key).toBe('PEMKEY'),
    );
    // A picker closed without a file changes nothing.
    fireEvent.change(keyFile!, { target: { files: [] } });
    fireEvent.change(keyFile!, { target: { files: [{} as File] } });
    await waitFor(() => expect(onError).toHaveBeenCalled());

    fireEvent.change(within(certificate).getByLabelText('Tipo'), { target: { value: 'pfx' } });
    expect(view.getByTestId('pfx-state').textContent).toBe('•••••• (pessoal)');
    fireEvent.click(view.getByRole('button', { name: /^Limpar meu valor$/ }));
    expect(onClearPersonal).toHaveBeenCalledWith('cert:0:pfx');
    fireEvent.click(
      within(view.getByTestId('certificate-passphrase')).getByTestId('clear-personal'),
    );
    expect(onClearPersonal).toHaveBeenCalledWith('cert:0:passphrase');
    const pfxInput = within(view.getByTestId('certificate')).getByLabelText('Carregar arquivo', {
      selector: 'input',
    });
    fireEvent.change(pfxInput, { target: { files: [new File(['hi'], 'c.pfx')] } });
    await waitFor(() =>
      expect(view.getByTestId('pfx-state').textContent).toBe('Arquivo carregado'),
    );
    expect(last(onChange).settings?.clientCertificates?.[0]?.pfx).toBe('aGk=');
    fireEvent.change(
      within(view.getByTestId('certificate-passphrase')).getByLabelText('Senha do certificado'),
      {
        target: { value: 'pass' },
      },
    );
    expect(last(onChange).settings?.clientCertificates?.[0]?.passphrase).toBe('pass');

    // A second certificate: editing one leaves the other as it is.
    fireEvent.click(view.getByTestId('add-certificate'));
    const rows = view.getAllByTestId('certificate');
    fireEvent.change(within(rows[1]!).getByLabelText('Domínio'), { target: { value: 'two.test' } });
    expect(last(onChange).settings?.clientCertificates?.map((item) => item.domain)).toEqual([
      'api.test',
      'two.test',
    ]);
    // The visible button opens the hidden file input; a dialog closed without a file changes nothing.
    const before = onChange.mock.calls.length;
    fireEvent.click(within(rows[1]!).getAllByRole('button', { name: /Carregar arquivo/ })[0]!);
    fireEvent.change(
      within(rows[1]!).getAllByLabelText('Carregar arquivo', { selector: 'input' })[0]!,
      {
        target: { files: null },
      },
    );
    expect(onChange.mock.calls.length).toBe(before);

    fireEvent.click(within(rows[0]!).getByRole('button', { name: 'Remover' }));
    expect(last(onChange).settings?.clientCertificates?.map((item) => item.domain)).toEqual([
      'two.test',
    ]);
  });

  it('shows a certificate without a PFX and without personal values', () => {
    const view = render(
      <Harness
        initial={{
          ...base,
          personalSecrets: [],
          settings: { clientCertificates: [{ domain: 'x', type: 'pfx' }] },
        }}
      />,
    );
    tab(view, /Certificados de cliente/);
    expect(view.getByTestId('pfx-state').textContent).toBe('Nenhum arquivo');
    expect(view.getByRole('tab', { name: /Certificados de cliente/ }).textContent).toContain('1');
  });

  it('shows a PEM certificate that has no content yet', () => {
    const view = render(
      <Harness
        initial={{
          ...base,
          personalSecrets: [],
          settings: { clientCertificates: [{ domain: 'x', type: 'pem' }] },
        }}
      />,
    );
    tab(view, /Certificados de cliente/);
    expect((view.getByLabelText('Certificado') as HTMLTextAreaElement).value).toBe('');
    expect((view.getByLabelText('Chave privada') as HTMLTextAreaElement).value).toBe('');
  });

  it('marks the TLS tab when only the CA certificate is set', () => {
    const view = render(
      <Harness initial={{ ...base, settings: { tls: { caCertificate: 'CA' } } }} />,
    );
    expect(view.getByRole('tab', { name: /TLS/ }).textContent).toContain('•');
  });

  it('sets TLS verification and the CA certificate', async () => {
    const onChange = vi.fn();
    const onError = vi.fn();
    const view = render(<Harness initial={base} onChange={onChange} onError={onError} />);
    tab(view, /TLS/);
    fireEvent.click(view.getByTestId('tls-verify'));
    expect(last(onChange).settings?.tls).toEqual({ verify: false });
    expect(view.getByRole('tab', { name: /TLS/ }).textContent).toContain('•');
    fireEvent.change(view.getByLabelText('Certificado da CA (PEM)', { selector: 'textarea' }), {
      target: { value: 'CA' },
    });
    expect(last(onChange).settings?.tls).toEqual({ verify: false, caCertificate: 'CA' });
    const file = view.getByLabelText('Carregar arquivo', { selector: 'input' }) as HTMLInputElement;
    fireEvent.change(file, { target: { files: [new File(['ROOT'], 'ca.pem')] } });
    await waitFor(() => expect(last(onChange).settings?.tls?.caCertificate).toBe('ROOT'));
    fireEvent.change(file, { target: { files: [{} as File] } });
    await waitFor(() => expect(onError).toHaveBeenCalled());
  });

  it('adds, renames, edits and removes proto files', async () => {
    const onChange = vi.fn();
    const onError = vi.fn();
    const view = render(<Harness initial={base} onChange={onChange} onError={onError} />);
    tab(view, /Protobuf/);
    expect(view.getByText('Nenhum arquivo proto.')).toBeTruthy();
    const nested = new File(['syntax = "proto3";'], 'orders.proto');
    Object.defineProperty(nested, 'webkitRelativePath', { value: 'protos/orders.proto' });
    fireEvent.change(view.getByTestId('proto-input'), {
      target: { files: [nested, new File(['message A {}'], 'a.proto')] },
    });
    await waitFor(() => expect(view.getAllByTestId('proto-file')).toHaveLength(2));
    expect(last(onChange).protoFiles?.map((file) => file.name)).toEqual([
      'protos/orders.proto',
      'a.proto',
    ]);
    // Picking a file again replaces it.
    fireEvent.change(view.getByTestId('proto-input'), {
      target: { files: [new File(['message B {}'], 'a.proto')] },
    });
    await waitFor(() =>
      expect(last(onChange).protoFiles?.[1]).toEqual({ name: 'a.proto', content: 'message B {}' }),
    );
    fireEvent.change(view.getAllByLabelText('Nome do arquivo')[0]!, {
      target: { value: 'orders/v1.proto' },
    });
    expect(last(onChange).protoFiles?.[0]?.name).toBe('orders/v1.proto');
    fireEvent.click(view.getByRole('button', { name: 'Editar orders/v1.proto' }));
    fireEvent.change(view.getByLabelText('orders/v1.proto', { selector: 'textarea' }), {
      target: { value: 'syntax = "proto2";' },
    });
    expect(last(onChange).protoFiles?.[0]?.content).toBe('syntax = "proto2";');
    fireEvent.click(view.getByRole('button', { name: /Novo arquivo/ }));
    expect(last(onChange).protoFiles).toHaveLength(3);
    fireEvent.click(view.getByRole('button', { name: 'Remover a.proto' }));
    expect(last(onChange).protoFiles?.map((file) => file.name)).toEqual([
      'orders/v1.proto',
      'file3.proto',
    ]);
    fireEvent.change(view.getByTestId('proto-input'), { target: { files: [{} as File] } });
    await waitFor(() => expect(onError).toHaveBeenCalled());
  });

  it('sets redirects, timeout, cookies and new request defaults', () => {
    const onChange = vi.fn();
    const view = render(<Harness initial={base} onChange={onChange} />);
    tab(view, /Rede/);
    const network = view.getByTestId('network-settings');
    fireEvent.change(within(network).getByLabelText('Máximo de redirecionamentos'), {
      target: { value: '3' },
    });
    const timeout = within(network).getByLabelText('Timeout (ms)');
    fireEvent.change(timeout, { target: { value: '5000' } });
    expect(last(onChange).settings?.timeoutMs).toBe(5000);
    // A literal zero reads as the number 0, not as "no timeout" (that is an empty field).
    fireEvent.change(timeout, { target: { value: '0' } });
    expect(last(onChange).settings?.timeoutMs).toBe(0);
    // A negative timeout is read as none at all. (Goes through '7' first so the field's
    // displayed value actually changes from '0' before landing on '-5', which also computes
    // to 0 - otherwise the no-op re-render never fires a change event at all.)
    fireEvent.change(timeout, { target: { value: '7' } });
    fireEvent.change(timeout, { target: { value: '-5' } });
    expect(last(onChange).settings?.timeoutMs).toBe(0);
    fireEvent.change(timeout, { target: { value: '' } });
    fireEvent.click(within(network).getByLabelText(/Seguir redirecionamentos/));
    fireEvent.click(view.getByTestId('cookie-jar'));
    fireEvent.change(within(network).getByLabelText('Tipo de requisição'), {
      target: { value: 'grpc' },
    });
    fireEvent.change(within(network).getByLabelText('URL base'), {
      target: { value: '{{host}}' },
    });
    expect(last(onChange).settings).toEqual({
      maxRedirects: 3,
      timeoutMs: undefined,
      followRedirects: false,
      cookies: false,
      presets: { kind: 'grpc', baseUrl: '{{host}}' },
    });
    expect(
      (within(network).getByLabelText('Máximo de redirecionamentos') as HTMLInputElement).disabled,
    ).toBe(true);
  });

  it('shows everything read-only', () => {
    const view = render(<Harness initial={base} readOnly />);
    expect(view.queryByRole('button', { name: /Excluir coleção/ })).toBeNull();
    tab(view, /Protobuf/);
    expect(view.queryByTestId('proto-input')).toBeNull();
    tab(view, /Certificados de cliente/);
    expect(view.queryByTestId('add-certificate')).toBeNull();
    tab(view, /TLS/);
    expect(view.queryByRole('button', { name: /Carregar arquivo/ })).toBeNull();
    tab(view, /Proxy/);
    expect(view.queryByTestId('clear-personal')).toBeNull();
    expect((view.getByTestId('proxy-enabled') as HTMLInputElement).disabled).toBe(true);
    tab(view, /^Script/);
    expect((view.getByRole('radio', { name: /Sanduíche/ }) as HTMLInputElement).disabled).toBe(
      true,
    );
  });

  it('swallows a file-read error when the caller gave no onError', async () => {
    const view = render(<Harness initial={base} />);
    tab(view, /Certificados de cliente/);
    fireEvent.click(view.getByTestId('add-certificate'));
    const certificate = view.getByTestId('certificate');
    const [certFile] = within(certificate).getAllByLabelText('Carregar arquivo', {
      selector: 'input',
    });
    fireEvent.change(certFile!, { target: { files: [{} as File] } });
    await waitFor(() => expect(view.getByTestId('certificate')).toBeInTheDocument());
  });
});

describe('FolderSettingsPane', () => {
  const folder: ApiFolder = { id: 'f1', type: 'folder', name: 'Admin', items: [] };

  function FolderHarness({
    onChange,
    onClearPersonal,
    initial = folder,
  }: {
    onChange?: (folder: ApiFolder) => void;
    onClearPersonal?: (ref: string) => void;
    initial?: ApiFolder;
  }) {
    const [value, setValue] = useState(initial);
    return (
      <FolderSettingsPane
        folder={value}
        collection={{ ...base, auth: { type: 'basic', username: '', password: '' } }}
        readOnly={false}
        onClearPersonal={onClearPersonal}
        onChange={(next) => {
          setValue(next);
          onChange?.(next);
        }}
      />
    );
  }

  it('marks the folder script tab when only the after-response script is set', () => {
    const view = render(<FolderHarness initial={{ ...folder, scripts: { postResponse: 'x' } }} />);
    expect(view.getByRole('tab', { name: /^Script/ }).textContent).toContain('•');
  });

  it('edits headers, variables, auth, scripts, tests and docs of a folder', () => {
    const onChange = vi.fn();
    const onClearPersonal = vi.fn();
    const view = render(<FolderHarness onChange={onChange} onClearPersonal={onClearPersonal} />);
    const lastFolder = () => onChange.mock.calls[onChange.mock.calls.length - 1]![0] as ApiFolder;
    expect(view.getByTestId('folder-settings').textContent).toContain('Admin');

    fireEvent.click(view.getByRole('button', { name: /Adicionar/ }));
    expect(lastFolder().headers).toEqual([{ key: '', value: '' }]);

    fireEvent.click(view.getByRole('tab', { name: /Variáveis/ }));
    fireEvent.click(view.getByRole('button', { name: /Adicionar/ }));
    expect(lastFolder().vars).toEqual([{ key: '', value: '' }]);

    fireEvent.click(view.getByRole('tab', { name: /Auth/ }));
    expect(view.getByTestId('auth-inherited').textContent).toBe('Herda Basic auth de Orders API.');
    fireEvent.change(view.getByTestId('auth-type'), { target: { value: 'bearer' } });
    expect(lastFolder().auth).toEqual({ type: 'bearer', token: '{{token}}' });

    fireEvent.click(view.getByRole('tab', { name: /^Script/ }));
    fireEvent.change(view.getByLabelText('Antes da requisição'), { target: { value: 'x();' } });
    expect(lastFolder().scripts).toEqual({ preRequest: 'x();' });
    expect(view.queryByText('Fluxo dos scripts')).toBeNull();

    fireEvent.click(view.getByRole('tab', { name: /^Testes/ }));
    fireEvent.change(view.getByLabelText('Testes'), { target: { value: 't();' } });
    expect(lastFolder().scripts).toMatchObject({ tests: 't();' });

    fireEvent.click(view.getByRole('tab', { name: /Descrição/ }));
    fireEvent.change(view.getByLabelText('Descrição'), { target: { value: 'Admin calls' } });
    expect(lastFolder().description).toBe('Admin calls');
  });
});
