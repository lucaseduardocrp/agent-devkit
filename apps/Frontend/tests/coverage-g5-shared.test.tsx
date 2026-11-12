import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { useRef, useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AttachmentPanel } from '../src/features/shared/AttachmentPanel.js';
import { MarkdownImageTextarea } from '../src/features/shared/MarkdownImageTextarea.js';
import {
  attachmentKind,
  fileKind,
  formatBytes,
  type Attachment,
} from '../src/features/shared/attachment-types.js';
import { highlightPassage } from '../src/features/shared/highlight-passage.js';
import {
  ImageInputStatus,
  MediaImage,
  MediaProvider,
  createDraft,
  discardDrafts,
  editorHtml,
  markdownImage,
  resolveInlineImages,
  resolveMedia,
  saveWithDrafts,
  useInlineImages,
  useMarkdownImageInput,
  useMediaSource,
  useRichTextImageInput,
} from '../src/features/shared/media.js';
import { ApiClient } from '../src/lib/api-client.js';
import { I18nProvider } from '../src/lib/i18n/index.js';

const FILE = '/attachments/files/0f8fad5b-d9cb-469f-a165-70867728950e';
const OTHER = '/attachments/files/1f8fad5b-d9cb-469f-a165-70867728950e';

function newClient(blob: Blob | Error = new Blob(['x'], { type: 'image/png' })) {
  const apiClient = new ApiClient({ baseUrl: 'http://api.test' });
  const getMedia = vi
    .spyOn(apiClient, 'getMedia')
    .mockImplementation(() =>
      blob instanceof Error ? Promise.reject(blob) : Promise.resolve(blob),
    );
  return { apiClient, getMedia };
}

const png = (name = 'shot.png') => new File(['png'], name, { type: 'image/png' });

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('attachment-types helpers', () => {
  it('derives the kind of stored attachments', () => {
    expect(attachmentKind({ name: 'a', kind: 'video' })).toBe('video');
    expect(attachmentKind({ name: 'a', mimeType: 'video/mp4' })).toBe('video');
    expect(attachmentKind({ name: 'a', mimeType: 'application/pdf' })).toBe('document');
    expect(attachmentKind({ name: 'a', mimeType: 'image/png' })).toBe('image');
    expect(attachmentKind({ name: 'a' })).toBe('image');
  });

  it('derives the kind of local files', () => {
    expect(fileKind(png())).toBe('image');
    expect(fileKind(new File([''], 'a.bin', { type: 'video/webm' }))).toBe('video');
    expect(fileKind(new File([''], 'clip.MOV'))).toBe('video');
    expect(fileKind(new File([''], 'notes.md'))).toBe('document');
    expect(fileKind(new File([''], 'program.exe'))).toBeNull();
    expect(fileKind(new File([''], 'noextension'))).toBeNull();
  });

  it('formats byte sizes', () => {
    expect(formatBytes(undefined)).toBe('');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2 KB');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB');
    expect(formatBytes(50 * 1024 * 1024)).toBe('50 MB');
  });
});

describe('highlightPassage text nodes', () => {
  it('treats a text node without a value as empty', () => {
    const root = document.createElement('div');
    root.append('Alpha beta');
    const node = root.firstChild as Text;
    Object.defineProperty(node, 'nodeValue', { value: null });
    document.body.append(root);
    expect(highlightPassage(root, 'alpha')).toBe(false);
    root.remove();
  });
});

describe('media resolution', () => {
  it('caches loaded files per client and retries after a failure', async () => {
    const { apiClient, getMedia } = newClient();
    const first = await resolveMedia(apiClient, FILE);
    await expect(resolveMedia(apiClient, FILE)).resolves.toBe(first);
    expect(getMedia).toHaveBeenCalledTimes(1);

    const failing = newClient(new Error('down'));
    await expect(resolveMedia(failing.apiClient, FILE)).rejects.toThrow('down');
    await expect(resolveMedia(failing.apiClient, FILE)).rejects.toThrow('down');
    expect(failing.getMedia).toHaveBeenCalledTimes(2);
  });

  it('resolves drafts from the browser and rejects discarded ones', async () => {
    const { apiClient } = newClient();
    const draft = createDraft('issue', png());
    await expect(resolveMedia(apiClient, draft.url)).resolves.toMatch(/^blob:/);
    discardDrafts({ text: draft.url });
    await expect(resolveMedia(apiClient, draft.url)).rejects.toThrow('Rascunho descartado');
  });

  it('reports a pasted file that is no longer available when saving', async () => {
    const { apiClient } = newClient();
    const ghost = '/attachments/drafts/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const save = vi.fn();
    await expect(saveWithDrafts(apiClient, 'pbi', { text: ghost }, save)).rejects.toThrow(
      'não está mais disponível',
    );
    expect(save).not.toHaveBeenCalled();
  });

  it('keeps the original value when nothing is drafted and ignores unserializable input', async () => {
    const { apiClient } = newClient();
    const result = await saveWithDrafts(apiClient, 'pbi', { text: 'plain' }, (v) =>
      Promise.resolve(v),
    );
    expect(result).toEqual({ text: 'plain' });
    expect(() => discardDrafts(undefined)).not.toThrow();
    await expect(
      saveWithDrafts(apiClient, 'pbi', undefined, () => Promise.resolve('ok')),
    ).rejects.toThrow();
  });

  it('refuses unsupported draft files and builds markdown images', () => {
    expect(() => createDraft('issue', new File([''], 'x.exe'))).toThrow(
      'tipo de arquivo não suportado',
    );
    const nameless = createDraft('issue', new File(['a'], '', { type: 'image/png' }));
    expect(nameless.name).toBe('file');
    const noMime = createDraft('issue', new File(['a'], 'notes.txt'));
    expect(noMime.mimeType).toBeUndefined();
    expect(markdownImage({ ...nameless, name: 'a[b]\nc', url: '/attachments/drafts/1' })).toBe(
      '![a b  c](/attachments/drafts/1)',
    );
  });
});

describe('useMediaSource and MediaImage', () => {
  it('fails ADK files when there is no client and passes provider files through', () => {
    const adk = renderHook(() => useMediaSource(FILE));
    expect(adk.result.current.failed).toBe(true);
    expect(adk.result.current.src).toBeUndefined();
    act(() => adk.result.current.onError());
    expect(adk.result.current.failed).toBe(true);

    const provider = renderHook(() => useMediaSource('https://cdn.test/a.png'));
    expect(provider.result.current.src).toBe('https://cdn.test/a.png');
    expect(provider.result.current.failed).toBe(false);
  });

  it('goes through the server when a direct load fails, then fails for good', async () => {
    const { apiClient, getMedia } = newClient();
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <MediaProvider apiClient={apiClient}>{children}</MediaProvider>
    );
    const { result } = renderHook(() => useMediaSource('https://cdn.test/a.png'), { wrapper });
    await act(async () => result.current.onError());
    await waitFor(() => expect(result.current.src).toMatch(/^blob:/));
    expect(getMedia).toHaveBeenCalledWith('https://cdn.test/a.png');
    act(() => result.current.onError());
    expect(result.current.failed).toBe(true);
  });

  it('fails when the server proxy cannot load a provider file', async () => {
    const { apiClient } = newClient(new Error('403'));
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <MediaProvider apiClient={apiClient}>{children}</MediaProvider>
    );
    const { result } = renderHook(() => useMediaSource('https://cdn.test/b.png'), { wrapper });
    await act(async () => result.current.onError());
    await waitFor(() => expect(result.current.failed).toBe(true));
  });

  it('ignores the answer of a source that was replaced meanwhile', async () => {
    let release: (blob: Blob) => void = () => {};
    const apiClient = new ApiClient({ baseUrl: 'http://api.test' });
    vi.spyOn(apiClient, 'getMedia').mockImplementation(
      () => new Promise<Blob>((resolve) => (release = resolve)),
    );
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <MediaProvider apiClient={apiClient}>{children}</MediaProvider>
    );
    const first = renderHook(() => useMediaSource(FILE), { wrapper });
    first.unmount();
    await act(async () => release(new Blob(['x'])));
    expect(first.result.current.src).toBeUndefined();

    const failing = new ApiClient({ baseUrl: 'http://api.test' });
    let reject: (reason: Error) => void = () => {};
    vi.spyOn(failing, 'getMedia').mockImplementation(
      () => new Promise<Blob>((_, fail) => (reject = fail)),
    );
    const second = renderHook(() => useMediaSource(OTHER), {
      wrapper: ({ children }: { children: React.ReactNode }) => (
        <MediaProvider apiClient={failing}>{children}</MediaProvider>
      ),
    });
    second.unmount();
    await act(async () => reject(new Error('late')));
    expect(second.result.current.failed).toBe(false);
  });

  it('renders the static image, the loading state, the loaded image and the failure', async () => {
    const plain = render(<MediaImage src="https://cdn.test/a.png" alt="static" />);
    expect(plain.getByRole('img', { name: 'static' }).getAttribute('src')).toBe(
      'https://cdn.test/a.png',
    );
    plain.unmount();

    const ok = newClient();
    const loaded = render(
      <MediaProvider apiClient={ok.apiClient}>
        <MediaImage src={FILE} alt="shot" className="x" />
      </MediaProvider>,
    );
    expect(loaded.container.querySelector('[aria-busy="true"]')).not.toBeNull();
    const image = await loaded.findByRole('img', { name: 'shot' });
    expect(image.getAttribute('src')).toMatch(/^blob:/);
    expect(image.hasAttribute('data-media-managed')).toBe(true);
    loaded.unmount();

    const bad = newClient(new Error('x'));
    const failed = render(
      <MediaProvider apiClient={bad.apiClient}>
        <MediaImage src={FILE} alt="broken" />
      </MediaProvider>,
    );
    const fallback = await failed.findByRole('img', { name: 'broken' });
    expect(fallback.tagName).toBe('SPAN');
  });

  it('retries a provider image through the server when it fails to load', async () => {
    const { apiClient } = newClient();
    const view = render(
      <MediaProvider apiClient={apiClient}>
        <MediaImage src="https://cdn.test/a.png" alt="remote" />
      </MediaProvider>,
    );
    const image = await view.findByRole('img', { name: 'remote' });
    fireEvent.error(image);
    await waitFor(() => expect(image.getAttribute('src')).toMatch(/^blob:/));
  });
});

describe('inline images', () => {
  it('retries provider images through the server and marks the ones that stay broken', async () => {
    const ok = newClient();
    const root = document.createElement('div');
    root.innerHTML =
      '<img src="https://cdn.test/a.png" alt="named"><img src="https://cdn.test/dir/b.png">' +
      '<img><img data-media-managed="" src="https://cdn.test/c.png">';
    resolveInlineImages(root, ok.apiClient);
    const [named, nameless, empty, managed] = [...root.querySelectorAll('img')];
    expect(empty!.hasAttribute('data-adk-src')).toBe(false);
    expect(managed!.hasAttribute('data-adk-src')).toBe(false);

    fireEvent.error(named!);
    await waitFor(() => expect(named!.src).toMatch(/^blob:/));

    const bad = newClient(new Error('x'));
    resolveInlineImages(root, bad.apiClient);
    // Already resolved addresses are not processed twice.
    expect(bad.getMedia).not.toHaveBeenCalled();
    const fresh = document.createElement('div');
    fresh.innerHTML =
      '<img src="https://cdn.test/dir/b.png"><img src="https://cdn.test/n.png" alt="has">';
    resolveInlineImages(fresh, bad.apiClient);
    const [noAlt, withAlt] = [...fresh.querySelectorAll('img')];
    fireEvent.error(noAlt!);
    fireEvent.error(withAlt!);
    await waitFor(() => expect(noAlt!.alt).toBe('b.png'));
    expect(withAlt!.alt).toBe('has');
    expect(noAlt!.classList.contains('opacity-40')).toBe(true);
    expect(nameless!.getAttribute('data-adk-src')).toBe('https://cdn.test/dir/b.png');
  });

  it('names images with an empty path segment and skips images from other documents', async () => {
    const bad = newClient(new Error('x'));
    const root = document.createElement('div');
    root.innerHTML = `<img src="${FILE}">`;
    resolveInlineImages(root, bad.apiClient);
    const image = root.querySelector('img')!;
    await waitFor(() => expect(image.classList.contains('opacity-40')).toBe(true));
    expect(image.alt).toBe('0f8fad5b-d9cb-469f-a165-70867728950e');

    const frame = document.createElement('iframe');
    document.body.append(frame);
    const foreign = frame.contentDocument!.createElement('div');
    foreign.innerHTML = '<img src="https://cdn.test/f.png">';
    resolveInlineImages(foreign, bad.apiClient);
    expect(foreign.querySelector('img')!.hasAttribute('data-adk-src')).toBe(false);
    frame.remove();
  });

  it('resolves inline images of rendered HTML through the hook', async () => {
    const { apiClient, getMedia } = newClient();
    function Html({ html }: { html: string }) {
      const ref = useRef<HTMLDivElement>(null);
      useInlineImages(ref, html);
      return <div ref={ref} dangerouslySetInnerHTML={{ __html: html }} data-testid="html" />;
    }
    const view = render(
      <MediaProvider apiClient={apiClient}>
        <Html html={`<img src="${FILE}" alt="a">`} />
      </MediaProvider>,
    );
    await waitFor(() => expect(getMedia).toHaveBeenCalledWith(FILE));
    view.unmount();

    const without = render(<Html html={`<img src="${FILE}" alt="a">`} />);
    expect(without.getByTestId('html').querySelector('img')!.hasAttribute('data-adk-src')).toBe(
      false,
    );
  });

  it('restores original addresses and keeps unrelated classes in editor HTML', () => {
    const root = document.createElement('div');
    root.innerHTML =
      `<img src="blob:x" data-adk-src="${FILE}" class="opacity-40 keep" loading="lazy" alt="a">` +
      '<img src="https://cdn.test/a.png" class="opacity-40">';
    const html = editorHtml(root);
    expect(html).toContain(`src="${FILE}"`);
    expect(html).toContain('class="keep"');
    expect(html).not.toContain('opacity-40');
    expect(html).toContain('src="https://cdn.test/a.png"');
  });
});

describe('useMarkdownImageInput and MarkdownImageTextarea', () => {
  const wrapperFor =
    (apiClient: ApiClient) =>
    ({ children }: { children: React.ReactNode }) => (
      <MediaProvider apiClient={apiClient}>{children}</MediaProvider>
    );

  function textarea(value: string, start = value.length, end = start) {
    const el = document.createElement('textarea');
    el.value = value;
    el.setSelectionRange(start, end);
    return el;
  }

  it('writes pasted and dropped images where the caret was', () => {
    const { apiClient } = newClient();
    const onChange = vi.fn();
    const { result } = renderHook(() => useMarkdownImageInput('issue', onChange), {
      wrapper: wrapperFor(apiClient),
    });

    result.current.insertFiles(textarea('Hello'), [png('a.png')]);
    expect(onChange.mock.calls[0]![0]).toMatch(
      /^Hello\n\n!\[a\.png\]\(\/attachments\/drafts\/.+\)\n\n$/,
    );
    result.current.insertFiles(textarea('Hello\n', 6), [png('b.png')]);
    expect(onChange.mock.calls[1]![0]).toMatch(/^Hello\n!\[b\.png\]/);
    result.current.insertFiles(textarea('x', 0, 0), [png('c.png')]);
    expect(onChange.mock.calls[2]![0]).toMatch(/^!\[c\.png\]\(.+\)\n\nx$/);
    result.current.insertFiles(textarea('x'), []);
    expect(onChange).toHaveBeenCalledTimes(3);

    const target = textarea('Hi');
    const paste = {
      clipboardData: { files: [png('p.png'), new File([''], 'x.txt')] },
      preventDefault: vi.fn(),
      currentTarget: target,
    };
    result.current.onPaste(paste as never);
    expect(paste.preventDefault).toHaveBeenCalled();
    const drop = {
      dataTransfer: { files: [png('d.png')] },
      preventDefault: vi.fn(),
      currentTarget: target,
    };
    result.current.onDrop(drop as never);
    expect(drop.preventDefault).toHaveBeenCalled();
    expect(onChange).toHaveBeenCalledTimes(5);

    const none = { clipboardData: null, preventDefault: vi.fn(), currentTarget: target };
    result.current.onPaste(none as never);
    result.current.onDrop({
      dataTransfer: null,
      preventDefault: vi.fn(),
      currentTarget: target,
    } as never);
    expect(none.preventDefault).not.toHaveBeenCalled();
    expect(onChange).toHaveBeenCalledTimes(5);
  });

  it('does nothing without a media client', () => {
    const onChange = vi.fn();
    const { result } = renderHook(() => useMarkdownImageInput('issue', onChange));
    result.current.insertFiles(textarea('x'), [png()]);
    const event = {
      clipboardData: { files: [png()] },
      dataTransfer: { files: [png()] },
      preventDefault: vi.fn(),
      currentTarget: textarea('x'),
    };
    result.current.onPaste(event as never);
    result.current.onDrop(event as never);
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('shows the error of an image that cannot be kept, including non-Error causes', () => {
    const { apiClient } = newClient();
    const big = new File([new Uint8Array(11 * 1024 * 1024)], 'big.png', { type: 'image/png' });
    function Harness() {
      const [value, setValue] = useState('');
      return (
        <MarkdownImageTextarea
          scope="issue"
          value={value}
          onValueChange={setValue}
          aria-label="body"
        />
      );
    }
    render(
      <MediaProvider apiClient={apiClient}>
        <Harness />
      </MediaProvider>,
    );
    const field = screen.getByLabelText('body') as HTMLTextAreaElement;
    expect(screen.getByText(/Cole ou arraste imagens/)).toBeTruthy();
    fireEvent.paste(field, { clipboardData: { files: [big] } });
    expect(screen.getByRole('alert').textContent).toContain('10 MB');

    fireEvent.paste(field, { clipboardData: { files: [png('ok.png')] } });
    expect(screen.queryByRole('alert')).toBeNull();
    expect(field.value).toMatch(/!\[ok\.png\]/);

    fireEvent.change(field, { target: { value: 'typed' } });
    expect(field.value).toBe('typed');

    vi.spyOn(crypto, 'randomUUID').mockImplementation(() => {
      throw 'boom';
    });
    fireEvent.drop(field, { dataTransfer: { files: [png('z.png')] } });
    expect(screen.getByRole('alert').textContent).toBe('boom');
  });

  it('hides the hint when quiet but still shows errors', () => {
    const { apiClient } = newClient();
    const big = new File([new Uint8Array(11 * 1024 * 1024)], 'big.png', { type: 'image/png' });
    render(
      <MediaProvider apiClient={apiClient}>
        <MarkdownImageTextarea scope="pbi" value="" onValueChange={() => {}} quiet aria-label="q" />
      </MediaProvider>,
    );
    expect(screen.queryByText(/Cole ou arraste/)).toBeNull();
    fireEvent.paste(screen.getByLabelText('q'), { clipboardData: { files: [big] } });
    expect(screen.getByRole('alert')).toBeTruthy();
  });

  it('renders the status hint in English and Portuguese', () => {
    const en = render(
      <I18nProvider initialLocale="en-US">
        <ImageInputStatus state={{ error: null }} />
      </I18nProvider>,
    );
    expect(en.getByText('Paste or drop images to place them in the text.')).toBeTruthy();
  });
});

describe('useRichTextImageInput', () => {
  function Editor({
    onChange,
    attach,
  }: {
    onChange: (html: string) => void;
    attach?: (attachment: Attachment) => void;
  }) {
    const ref = useRef<HTMLDivElement>(null);
    const input = useRichTextImageInput('pbi', ref, onChange);
    return (
      <div>
        <div
          ref={ref}
          contentEditable
          data-testid="editor"
          onPaste={input.onPaste}
          onDrop={input.onDrop}
          suppressContentEditableWarning
        >
          <p>start</p>
        </div>
        <button onClick={() => input.insertFiles([png('i.png')])}>insert</button>
        <button onClick={() => input.insertFiles([])}>insert-none</button>
        <button
          onClick={() =>
            input.insertAttachment({
              id: '1',
              name: 'att.png',
              scope: 'pbi',
              source: 'adk',
              url: FILE,
            })
          }
        >
          attach
        </button>
        <button onClick={() => attach?.({} as Attachment)}>noop</button>
        {input.error && <span role="alert">{input.error}</span>}
      </div>
    );
  }

  const withClient = (ui: React.ReactElement) => {
    const { apiClient } = newClient();
    return render(<MediaProvider apiClient={apiClient}>{ui}</MediaProvider>);
  };

  it('appends images when the caret is outside and inserts at the caret when inside', () => {
    const onChange = vi.fn();
    withClient(<Editor onChange={onChange} />);
    const editor = screen.getByTestId('editor');
    window.getSelection()?.removeAllRanges();

    fireEvent.click(screen.getByText('insert'));
    expect(onChange.mock.calls[0]![0]).toContain('src="/attachments/drafts/');
    expect(editor.querySelectorAll('img').length).toBe(1);

    const range = document.createRange();
    range.setStart(editor.firstChild!.firstChild!, 2);
    range.collapse(true);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    fireEvent.click(screen.getByText('attach'));
    expect(onChange).toHaveBeenCalledTimes(2);
    expect(editor.querySelectorAll('img').length).toBe(2);
    expect(editor.firstElementChild!.tagName).toBe('P');

    const outside = document.createRange();
    outside.selectNodeContents(document.body);
    selection.removeAllRanges();
    selection.addRange(outside);
    fireEvent.click(screen.getByText('insert'));
    expect(editor.querySelectorAll('img').length).toBe(3);

    fireEvent.click(screen.getByText('insert-none'));
    expect(onChange).toHaveBeenCalledTimes(3);
  });

  it('handles paste and drop of images, with and without a caret position', () => {
    const onChange = vi.fn();
    withClient(<Editor onChange={onChange} />);
    const editor = screen.getByTestId('editor');

    fireEvent.paste(editor, { clipboardData: { files: [new File([''], 'a.txt')] } });
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.paste(editor, { clipboardData: { files: [png('p.png')] } });
    expect(onChange).toHaveBeenCalledTimes(1);

    fireEvent.drop(editor, { dataTransfer: { files: [png('d.png')] }, clientX: 1, clientY: 1 });
    expect(onChange).toHaveBeenCalledTimes(2);

    fireEvent.drop(editor, { dataTransfer: { files: [new File([''], 'a.txt')] } });
    expect(onChange).toHaveBeenCalledTimes(2);

    const caret = document.createRange();
    caret.setStart(editor.firstChild!.firstChild!, 1);
    Object.defineProperty(document, 'caretRangeFromPoint', {
      configurable: true,
      value: () => caret,
    });
    fireEvent.drop(editor, { dataTransfer: { files: [png('e.png')] }, clientX: 1, clientY: 1 });
    expect(onChange).toHaveBeenCalledTimes(3);
    Object.defineProperty(document, 'caretRangeFromPoint', {
      configurable: true,
      value: () => null,
    });
    fireEvent.drop(editor, { dataTransfer: { files: [png('f.png')] } });
    expect(onChange).toHaveBeenCalledTimes(4);
    Reflect.deleteProperty(document, 'caretRangeFromPoint');
  });

  it('reports images that cannot be kept and ignores everything without a client', () => {
    const onChange = vi.fn();
    const view = withClient(<Editor onChange={onChange} />);
    vi.spyOn(crypto, 'randomUUID').mockImplementationOnce(() => {
      throw new Error('no uuid');
    });
    fireEvent.click(screen.getByText('insert'));
    expect(screen.getByRole('alert').textContent).toBe('no uuid');
    vi.spyOn(crypto, 'randomUUID').mockImplementationOnce(() => {
      throw 'plain';
    });
    fireEvent.click(screen.getByText('insert'));
    expect(screen.getByRole('alert').textContent).toBe('plain');
    view.unmount();

    const bare = render(<Editor onChange={onChange} />);
    fireEvent.click(bare.getByText('insert'));
    fireEvent.click(bare.getByText('attach'));
    fireEvent.paste(bare.getByTestId('editor'), { clipboardData: { files: [png()] } });
    fireEvent.drop(bare.getByTestId('editor'), { dataTransfer: { files: [png()] } });
    fireEvent.click(bare.getByText('noop'));
    expect(onChange).not.toHaveBeenCalled();
  });

  it('ignores attachments when the editor is not mounted', () => {
    const { apiClient } = newClient();
    const onChange = vi.fn();
    const { result } = renderHook(() => useRichTextImageInput('pbi', { current: null }, onChange), {
      wrapper: ({ children }) => <MediaProvider apiClient={apiClient}>{children}</MediaProvider>,
    });
    result.current.insertAttachment({ id: '1', name: 'a', scope: 'pbi', source: 'adk', url: FILE });
    result.current.insertFiles([png()]);
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe('AttachmentPanel editing', () => {
  const adkImage: Attachment = {
    id: 'a1',
    name: 'print.png',
    scope: 'issue',
    source: 'adk',
    url: FILE,
    size: 800,
  };
  const remote: Attachment = {
    id: 'u1',
    name: 'sheet.xlsx',
    kind: 'document',
    scope: 'issue',
    source: 'url',
    url: 'https://cdn.test/files/sheet.xlsx',
  };

  function setup(props: Partial<React.ComponentProps<typeof AttachmentPanel>> = {}) {
    const { apiClient, getMedia } = newClient();
    const onChange = vi.fn();
    const view = render(
      <AttachmentPanel
        apiClient={apiClient}
        scope="issue"
        attachments={[]}
        onChange={onChange}
        {...props}
      />,
    );
    return { view, onChange, getMedia, apiClient };
  }

  it('renders nothing when there is nothing to show or edit', () => {
    const { view } = setup({ onChange: undefined });
    expect(view.container.innerHTML).toBe('');
  });

  it('adds HTTPS links and rejects invalid ones', () => {
    const { onChange } = setup();
    const input = screen.getByLabelText('URL do arquivo');
    fireEvent.change(input, { target: { value: 'http://insecure.test/a.png' } });
    fireEvent.click(screen.getByRole('button', { name: 'Adicionar URL' }));
    expect(screen.getByRole('alert').textContent).toBe('Informe uma URL HTTPS válida.');
    fireEvent.change(input, { target: { value: 'https://user:pw@cdn.test/a.png' } });
    fireEvent.click(screen.getByRole('button', { name: 'Adicionar URL' }));
    expect(onChange).not.toHaveBeenCalled();

    fireEvent.change(input, { target: { value: 'https://cdn.test/dir/my%20file.pdf' } });
    fireEvent.keyDown(input, { key: 'a' });
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onChange.mock.calls[0]![0][0]).toMatchObject({
      name: 'my file.pdf',
      kind: 'document',
      source: 'url',
    });
    expect(screen.queryByRole('alert')).toBeNull();

    fireEvent.change(input, { target: { value: 'https://host.test/' } });
    fireEvent.click(screen.getByRole('button', { name: 'Adicionar URL' }));
    expect(onChange.mock.calls[1]![0][0]).toMatchObject({ name: 'host.test', kind: 'document' });

    fireEvent.change(input, { target: { value: 'https://cdn.test/clip.mp4' } });
    fireEvent.click(screen.getByRole('button', { name: 'Adicionar URL' }));
    expect(onChange.mock.calls[2]![0][0].kind).toBe('video');
  });

  it('keeps the limit of attachments', () => {
    const many: Attachment[] = Array.from({ length: 20 }, (_, index) => ({
      ...remote,
      id: `r${index}`,
    }));
    setup({ attachments: many });
    expect((screen.getByLabelText('URL do arquivo') as HTMLInputElement).disabled).toBe(true);
    expect(
      (screen.getByRole('button', { name: 'Adicionar URL' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    const file = document.querySelector('input[type="file"]') as HTMLInputElement;
    expect(file.disabled).toBe(true);
  });

  it('shows the limit when adding a link or files past the maximum', () => {
    const almost: Attachment[] = Array.from({ length: 19 }, (_, index) => ({
      ...remote,
      id: `r${index}`,
    }));
    const { onChange } = setup({ attachments: almost });
    const file = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(file, { target: { files: [png('a.png'), png('b.png')] } });
    expect(screen.getByRole('alert').textContent).toBe('Máximo de 20 anexos.');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('refuses to add a link once full through the keyboard', () => {
    const full: Attachment[] = Array.from({ length: 20 }, (_, index) => ({
      ...remote,
      id: `r${index}`,
    }));
    const { onChange } = setup({ attachments: full });
    fireEvent.keyDown(screen.getByLabelText('URL do arquivo'), { key: 'Enter' });
    expect(screen.getByRole('alert').textContent).toBe('Máximo de 20 anexos.');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('validates the type and size of attached files before keeping them as drafts', () => {
    const { onChange } = setup();
    const file = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(file, { target: { files: [new File(['x'], 'run.exe')] } });
    expect(screen.getByRole('alert').textContent).toBe('run.exe: Tipo de arquivo não suportado.');

    const big = new File([new Uint8Array(11 * 1024 * 1024)], 'big.png', { type: 'image/png' });
    fireEvent.change(file, { target: { files: [big] } });
    expect(screen.getByRole('alert').textContent).toBe('big.png passa do limite de 10 MB.');
    expect(onChange).not.toHaveBeenCalled();

    fireEvent.change(file, { target: { files: [] } });
    expect(onChange).not.toHaveBeenCalled();

    fireEvent.change(file, { target: { files: [png('ok.png')] } });
    expect(screen.queryByRole('alert')).toBeNull();
    expect(onChange.mock.calls[0]![0][0]).toMatchObject({ name: 'ok.png', source: 'adk' });
  });

  it('accepts files dropped on the panel and highlights it while dragging', () => {
    const { onChange } = setup();
    const panel = screen.getByRole('region', { name: 'Anexos' });
    fireEvent.dragOver(panel, { dataTransfer: { types: ['text/plain'] } });
    expect(panel.className).not.toContain('outline-2');
    fireEvent.dragOver(panel, { dataTransfer: { types: ['Files'] } });
    expect(panel.className).toContain('outline-2');
    fireEvent.dragLeave(panel);
    expect(panel.className).not.toContain('outline-2');
    fireEvent.drop(panel, { dataTransfer: { files: [png('dropped.png')] } });
    expect(onChange.mock.calls[0]![0][0].name).toBe('dropped.png');
  });

  it('ignores drag and drop when it cannot edit', () => {
    const onChange = vi.fn();
    render(<AttachmentPanel scope="issue" attachments={[remote]} onChange={onChange} />);
    const panel = screen.getByRole('region', { name: 'Anexos' });
    fireEvent.dragOver(panel, { dataTransfer: { types: ['Files'] } });
    expect(panel.className).not.toContain('outline-2');
    fireEvent.drop(panel, { dataTransfer: { files: [png()] } });
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.queryByLabelText('URL do arquivo')).toBeNull();
  });

  it('is read-only when disabled and addFiles needs a client', () => {
    const { apiClient } = newClient();
    render(
      <AttachmentPanel
        apiClient={apiClient}
        scope="issue"
        attachments={[remote]}
        onChange={vi.fn()}
        disabled
      />,
    );
    expect(screen.queryByRole('button', { name: /Remover anexo/ })).toBeNull();
  });

  it('lists attachments with actions: insert inline, remove, open at the provider', () => {
    const onInsertInline = vi.fn();
    const { onChange } = setup({ attachments: [adkImage, remote], onInsertInline });
    expect(screen.getByText('· 800 B')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Inserir no texto: print.png' }));
    expect(onInsertInline).toHaveBeenCalledWith(adkImage);
    expect(screen.queryByRole('button', { name: 'Inserir no texto: sheet.xlsx' })).toBeNull();
    expect(screen.getByRole('link', { name: 'Abrir no provedor: sheet.xlsx' })).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Abrir no provedor: print.png' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Remover anexo: print.png' }));
    expect(onChange).toHaveBeenCalledWith([remote]);
    expect(document.querySelector('.ti-file-spreadsheet')).not.toBeNull();
  });

  it('picks document icons by extension', () => {
    const names = ['a.pdf', 'a.docx', 'a.csv', 'a.pptx', 'a.zip', 'a.txt', 'noext'];
    render(
      <AttachmentPanel
        scope="issue"
        attachments={names.map((name, index) => ({
          id: `d${index}`,
          name,
          kind: 'document' as const,
          scope: 'issue' as const,
          source: 'url' as const,
          url: `https://cdn.test/${name}`,
        }))}
      />,
    );
    for (const icon of [
      'ti-file-type-pdf',
      'ti-file-type-doc',
      'ti-file-spreadsheet',
      'ti-presentation',
      'ti-file-zip',
      'ti-file-text',
    ])
      expect(document.querySelector(`.${icon}`)).not.toBeNull();
  });

  it('treats a file input without files as empty', () => {
    const { onChange } = setup();
    const file = document.querySelector('input[type="file"]') as HTMLInputElement;
    Object.defineProperty(file, 'files', { configurable: true, value: null });
    fireEvent.change(file);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('shows the English copy with the I18nProvider', () => {
    const { apiClient } = newClient();
    const onChange = vi.fn();
    render(
      <I18nProvider initialLocale="en-US">
        <AttachmentPanel
          apiClient={apiClient}
          scope="issue"
          attachments={[remote]}
          onChange={onChange}
        />
      </I18nProvider>,
    );
    const big = new File([new Uint8Array(11 * 1024 * 1024)], 'big.png', { type: 'image/png' });
    fireEvent.change(document.querySelector('input[type="file"]') as HTMLInputElement, {
      target: { files: [big] },
    });
    expect(screen.getByRole('alert').textContent).toBe('big.png is over the 10 MB limit.');
    expect(screen.getByRole('region', { name: 'Attachments' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Download: sheet.xlsx' })).toBeTruthy();
  });

  it('downloads ADK files through the session and provider files directly or via popup', async () => {
    const click = vi
      .spyOn(window.HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => {});
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    const { getMedia } = setup({ attachments: [adkImage, remote] });

    fireEvent.click(screen.getByRole('button', { name: 'Baixar: print.png' }));
    await waitFor(() => expect(click).toHaveBeenCalledTimes(1));

    getMedia.mockRejectedValue(new Error('x'));
    fireEvent.click(screen.getByRole('button', { name: 'Baixar: sheet.xlsx' }));
    await waitFor(() =>
      expect(open).toHaveBeenCalledWith(
        'https://cdn.test/files/sheet.xlsx',
        '_blank',
        'noopener,noreferrer',
      ),
    );
  });

  function cleanupAndRender(attachment: Attachment) {
    const { apiClient } = newClient(new Error('gone'));
    render(
      <AttachmentPanel
        apiClient={apiClient}
        scope="issue"
        attachments={[attachment]}
        onChange={vi.fn()}
      />,
    );
  }

  it('reports an unavailable ADK file and downloads nothing without a client', async () => {
    cleanupAndRender({ ...adkImage, id: 'a3', url: OTHER });
    fireEvent.click(screen.getByRole('button', { name: 'Baixar: print.png' }));
    expect((await screen.findByRole('alert')).textContent).toBe('Arquivo indisponível');
  });

  it('opens a provider file when there is no client to download it', async () => {
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    render(<AttachmentPanel scope="issue" attachments={[remote]} />);
    fireEvent.click(screen.getByRole('button', { name: 'Baixar: sheet.xlsx' }));
    await waitFor(() => expect(open).toHaveBeenCalled());
  });

  it('previews videos: loading, loaded, retried through the server and unavailable', async () => {
    const video: Attachment = {
      id: 'v1',
      name: 'clip.mp4',
      kind: 'video',
      scope: 'issue',
      source: 'url',
      url: 'https://cdn.test/clip.mp4',
    };
    const { apiClient } = newClient();
    const view = render(
      <MediaProvider apiClient={apiClient}>
        <AttachmentPanel scope="issue" attachments={[video]} />
      </MediaProvider>,
    );
    const player = await view.findByLabelText('clip.mp4');
    fireEvent.error(player);
    await waitFor(() => expect(player.getAttribute('src')).toMatch(/^blob:/));
    fireEvent.error(player);
    expect(await view.findByText('Arquivo indisponível')).toBeTruthy();
    view.unmount();

    const adkVideo: Attachment = { ...video, id: 'v2', source: 'adk', url: FILE };
    const pending = render(
      <MediaProvider apiClient={newClient().apiClient}>
        <AttachmentPanel scope="issue" attachments={[adkVideo]} />
      </MediaProvider>,
    );
    expect(pending.container.querySelector('.animate-pulse')).not.toBeNull();
    await pending.findByLabelText('clip.mp4');
  });
});
