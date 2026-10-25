import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useRef, useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AttachmentPanel } from '../src/features/shared/AttachmentPanel.js';
import { MarkdownImageTextarea } from '../src/features/shared/MarkdownImageTextarea.js';
import type { Attachment } from '../src/features/shared/attachment-types.js';
import {
  MediaImage,
  MediaProvider,
  createDraft,
  discardDrafts,
  editorHtml,
  resolveInlineImages,
  saveWithDrafts,
  useMarkdownImageInput,
  useRichTextImageInput,
} from '../src/features/shared/media.js';
import { ApiClient } from '../src/lib/api-client.js';
import { I18nProvider } from '../src/lib/i18n/index.js';

const FILE = '/attachments/files/0f8fad5b-d9cb-469f-a165-70867728950e';
const REMOTE = 'https://cdn.example.com/shot.png';
const png = (name = 'shot.png') => new File(['png'], name, { type: 'image/png' });
const big = () => new File([new Uint8Array(11 * 1024 * 1024)], 'big.png', { type: 'image/png' });

function client() {
  const apiClient = new ApiClient({ baseUrl: 'http://api.test' });
  const getMedia = vi
    .spyOn(apiClient, 'getMedia')
    .mockResolvedValue(new Blob(['png'], { type: 'image/png' }));
  return { apiClient, getMedia };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('drafts edge cases', () => {
  it('describes files without name or type and rejects unsupported ones', () => {
    const unnamed = createDraft('issue', new File(['x'], '', { type: 'image/png' }));
    expect(unnamed.name).toBe('file');
    const pdf = createDraft('issue', new File(['x'], 'notes.pdf'));
    expect(pdf).not.toHaveProperty('mimeType');
    expect(pdf.kind).toBe('document');
    expect(() => createDraft('issue', new File(['x'], 'run.exe'))).toThrow('unsupported');
    expect(() => discardDrafts(undefined)).not.toThrow();
    discardDrafts([unnamed, pdf]);
  });

  it('saves values without drafts untouched', async () => {
    const { apiClient } = client();
    const upload = vi.spyOn(apiClient, 'uploadAttachment');
    await expect(saveWithDrafts(apiClient, 'issue', undefined, async (v) => v)).resolves.toBe(
      undefined,
    );
    expect(upload).not.toHaveBeenCalled();
  });

  it('removes earlier uploads when a referenced draft is gone', async () => {
    const { apiClient } = client();
    const kept = createDraft('issue', png());
    const gone = createDraft('issue', png());
    discardDrafts(gone);
    vi.spyOn(apiClient, 'uploadAttachment').mockResolvedValue({
      ...kept,
      id: 'stored',
      url: FILE,
    });
    const remove = vi.spyOn(apiClient, 'deleteAttachment').mockRejectedValue(new Error('x'));
    const save = vi.fn();
    await expect(
      saveWithDrafts(apiClient, 'issue', { text: `${kept.url} ${gone.url}` }, save),
    ).rejects.toThrow('no longer available');
    expect(remove).toHaveBeenCalledWith('stored');
    expect(save).not.toHaveBeenCalled();
  });
});

describe('MediaImage', () => {
  it('keeps the original address without a provider', () => {
    render(<MediaImage src={FILE} alt="static" />);
    expect(screen.getByRole('img', { name: 'static' }).getAttribute('src')).toBe(FILE);
  });

  it('loads provider files directly and through the server when that fails', async () => {
    const { apiClient, getMedia } = client();
    render(
      <MediaProvider apiClient={apiClient}>
        <MediaImage src={REMOTE} alt="remote" />
      </MediaProvider>,
    );
    const image = screen.getByRole('img', { name: 'remote' });
    expect(image.getAttribute('src')).toBe(REMOTE);
    fireEvent.error(image);
    await waitFor(() => expect(image.getAttribute('src')).toMatch(/^blob:/));
    expect(getMedia).toHaveBeenCalledWith(REMOTE);
    fireEvent.error(image);
    expect(await screen.findByTitle('remote')).toHaveTextContent('remote');
  });

  it('shows a placeholder when an ADK file cannot be loaded', async () => {
    const { apiClient, getMedia } = client();
    getMedia.mockRejectedValue(new Error('404'));
    render(
      <MediaProvider apiClient={apiClient}>
        <MediaImage src={FILE.replace('0f8f', '2f8f')} alt="missing" />
      </MediaProvider>,
    );
    expect(screen.getByLabelText('missing').getAttribute('aria-busy')).toBe('true');
    expect(await screen.findByTitle('missing')).toHaveTextContent('missing');
  });
});

describe('resolveInlineImages', () => {
  it('skips images without address or already resolved, and proxies failed provider images', async () => {
    const { apiClient, getMedia } = client();
    getMedia.mockRejectedValue(new Error('denied'));
    const root = document.createElement('div');
    root.innerHTML = `<img alt="empty"><img src="${REMOTE}" class="x">`;
    root.append(document.createElementNS('http://www.w3.org/2000/svg', 'img'));
    resolveInlineImages(root, apiClient);
    resolveInlineImages(root, apiClient);
    const remote = root.querySelectorAll('img')[1] as HTMLImageElement;
    expect(remote.getAttribute('src')).toBe(REMOTE);
    remote.dispatchEvent(new Event('error'));
    await waitFor(() => expect(remote.classList.contains('opacity-40')).toBe(true));
    expect(remote.alt).toBe('shot.png');
    expect(getMedia).toHaveBeenCalledTimes(1);
    expect(editorHtml(root)).toContain(`<img src="${REMOTE}" class="x" alt="shot.png">`);
  });

  it('names an unloadable image after its address', async () => {
    const { apiClient, getMedia } = client();
    getMedia.mockRejectedValue(new Error('denied'));
    const root = document.createElement('div');
    root.innerHTML = '<img src="https://cdn.example.com/">';
    resolveInlineImages(root, apiClient);
    const image = root.querySelector('img')!;
    image.dispatchEvent(new Event('error'));
    await waitFor(() => expect(image.classList.contains('opacity-40')).toBe(true));
    expect(image.alt).toBe('');
  });
});

function MarkdownHarness({ quiet = false, initial = '' }: { quiet?: boolean; initial?: string }) {
  const [value, setValue] = useState(initial);
  return (
    <>
      <MarkdownImageTextarea
        scope="spec"
        aria-label="Texto"
        quiet={quiet}
        value={value}
        onValueChange={setValue}
      />
      <output data-testid="value">{value}</output>
    </>
  );
}

describe('MarkdownImageTextarea', () => {
  it('types text and writes pasted and dropped images where the cursor is', () => {
    const { apiClient } = client();
    render(
      <MediaProvider apiClient={apiClient}>
        <MarkdownHarness initial="Ant" />
      </MediaProvider>,
    );
    expect(screen.getByText('Cole ou arraste imagens para colocá-las no texto.')).toBeTruthy();
    const textarea = screen.getByLabelText<HTMLTextAreaElement>('Texto');
    fireEvent.change(textarea, { target: { value: 'Antes' } });
    textarea.setSelectionRange(5, 5);
    fireEvent.paste(textarea, { clipboardData: { files: [png('a[1].png')] } });
    const value = screen.getByTestId('value').textContent;
    expect(value).toMatch(/^Antes\n\n!\[a 1 \.png\]\(\/attachments\/drafts\/[0-9a-f-]+\)\n\n$/);

    textarea.setSelectionRange(0, 0);
    fireEvent.drop(textarea, { dataTransfer: { files: [png('b.png')] } });
    expect(screen.getByTestId('value').textContent).toMatch(/^!\[b\.png\]/);

    // Text and non-image files are left to the browser.
    fireEvent.paste(textarea, { clipboardData: { files: [new File(['x'], 'a.pdf')] } });
    fireEvent.drop(textarea, { dataTransfer: null });
    discardDrafts(screen.getByTestId('value').textContent);
  });

  it('starts after a line break without extra blank lines and reports oversize images', () => {
    const { apiClient } = client();
    render(
      <MediaProvider apiClient={apiClient}>
        <MarkdownHarness quiet initial={'Linha\n'} />
      </MediaProvider>,
    );
    expect(screen.queryByText(/Cole ou arraste/)).toBeNull();
    const textarea = screen.getByLabelText<HTMLTextAreaElement>('Texto');
    textarea.setSelectionRange(6, 6);
    fireEvent.paste(textarea, { clipboardData: { files: [png()] } });
    expect(screen.getByTestId('value').textContent).toMatch(/^Linha\n!\[shot\.png\]/);
    fireEvent.drop(textarea, { dataTransfer: { files: [big()] } });
    expect(screen.getByRole('alert')).toHaveTextContent('big.png: max 10 MB');
    fireEvent.paste(textarea, { clipboardData: { files: [png()] } });
    expect(screen.queryByRole('alert')).toBeNull();
    discardDrafts(screen.getByTestId('value').textContent);
  });

  it('ignores images without a media provider and shows the English hint', () => {
    render(
      <I18nProvider initialLocale="en-US">
        <MarkdownHarness />
      </I18nProvider>,
    );
    expect(screen.getByText('Paste or drop images to place them in the text.')).toBeTruthy();
    const textarea = screen.getByLabelText<HTMLTextAreaElement>('Texto');
    fireEvent.paste(textarea, { clipboardData: { files: [png()] } });
    fireEvent.drop(textarea, { dataTransfer: { files: [png()] } });
    expect(screen.getByTestId('value').textContent).toBe('');
  });
});

function RichHarness({ attachment }: { attachment?: Attachment }) {
  const editor = useRef<HTMLDivElement>(null);
  const [html, setHtml] = useState('');
  const images = useRichTextImageInput('pbi', editor, setHtml);
  return (
    <>
      <div
        ref={editor}
        data-testid="editor"
        contentEditable
        suppressContentEditableWarning
        onPaste={images.onPaste}
        onDrop={images.onDrop}
      >
        <p>Texto</p>
      </div>
      <button type="button" onClick={() => images.insertFiles([png('button.png')])}>
        inserir arquivo
      </button>
      {attachment && (
        <button type="button" onClick={() => images.insertAttachment(attachment)}>
          inserir anexo
        </button>
      )}
      {images.error && <p role="alert">{images.error}</p>}
      <output data-testid="html">{html}</output>
    </>
  );
}

describe('useRichTextImageInput', () => {
  afterEach(() => {
    window.getSelection()?.removeAllRanges();
    delete (document as { caretRangeFromPoint?: unknown }).caretRangeFromPoint;
  });

  it('inserts pasted images at the caret, or at the end when the caret is outside', () => {
    const { apiClient } = client();
    render(
      <MediaProvider apiClient={apiClient}>
        <RichHarness
          attachment={{ id: 'a1', name: 'anexo.png', scope: 'pbi', source: 'adk', url: FILE }}
        />
      </MediaProvider>,
    );
    const editor = screen.getByTestId('editor');
    const range = document.createRange();
    range.setStart(editor.firstChild!, 0);
    range.collapse(true);
    window.getSelection()!.addRange(range);
    fireEvent.paste(editor, { clipboardData: { files: [png('first.png')] } });
    expect(editor.firstElementChild!.querySelector('img')?.getAttribute('alt')).toBe('first.png');
    expect(screen.getByTestId('html').textContent).toContain('alt="first.png"');

    window.getSelection()!.removeAllRanges();
    fireEvent.click(screen.getByRole('button', { name: 'inserir arquivo' }));
    expect(editor.lastElementChild!.querySelector('img')?.getAttribute('alt')).toBe('button.png');

    const outside = document.createRange();
    outside.selectNodeContents(screen.getByTestId('html'));
    window.getSelection()!.addRange(outside);
    fireEvent.click(screen.getByRole('button', { name: 'inserir anexo' }));
    expect(editor.lastElementChild!.querySelector('img')?.getAttribute('data-adk-src')).toBe(FILE);
    discardDrafts(screen.getByTestId('html').textContent);
  });

  it('drops images where the pointer is and reports invalid files', () => {
    const { apiClient } = client();
    render(
      <MediaProvider apiClient={apiClient}>
        <RichHarness />
      </MediaProvider>,
    );
    const editor = screen.getByTestId('editor');
    fireEvent.drop(editor, { dataTransfer: { files: [png('end.png')] } });
    expect(editor.lastElementChild!.querySelector('img')?.getAttribute('alt')).toBe('end.png');

    const caret = vi.fn(() => {
      const range = document.createRange();
      range.setStart(editor.firstChild!, 0);
      return range;
    });
    (document as { caretRangeFromPoint?: unknown }).caretRangeFromPoint = caret;
    fireEvent.drop(editor, { dataTransfer: { files: [png('start.png')] } });
    expect(caret).toHaveBeenCalled();
    expect(editor.firstElementChild!.querySelector('img')?.getAttribute('alt')).toBe('start.png');

    (document as { caretRangeFromPoint?: unknown }).caretRangeFromPoint = () => null;
    fireEvent.paste(editor, { clipboardData: { files: [big()] } });
    expect(screen.getByRole('alert')).toHaveTextContent('big.png: max 10 MB');
    fireEvent.drop(editor, { dataTransfer: { files: [png('again.png')] } });
    expect(screen.queryByRole('alert')).toBeNull();
    fireEvent.paste(editor, { clipboardData: { files: [] } });
    fireEvent.drop(editor, { dataTransfer: null });
    discardDrafts(screen.getByTestId('html').textContent);
  });

  it('does nothing without a media provider', () => {
    render(
      <RichHarness
        attachment={{ id: 'a1', name: 'anexo.png', scope: 'pbi', source: 'adk', url: FILE }}
      />,
    );
    const editor = screen.getByTestId('editor');
    fireEvent.paste(editor, { clipboardData: { files: [png()] } });
    fireEvent.drop(editor, { dataTransfer: { files: [png()] } });
    fireEvent.click(screen.getByRole('button', { name: 'inserir arquivo' }));
    fireEvent.click(screen.getByRole('button', { name: 'inserir anexo' }));
    expect(editor.querySelector('img')).toBeNull();
  });

  it('ignores calls after the editor is gone', () => {
    const { apiClient } = client();
    let api: ReturnType<typeof useRichTextImageInput> | undefined;
    function Detached() {
      const editor = useRef<HTMLDivElement>(null);
      api = useRichTextImageInput('pbi', editor, () => {});
      return null;
    }
    render(
      <MediaProvider apiClient={apiClient}>
        <Detached />
      </MediaProvider>,
    );
    act(() => {
      api!.insertFiles([png()]);
      api!.insertAttachment({ id: 'a', name: 'a.png', scope: 'pbi', source: 'adk', url: FILE });
    });
    expect(api!.error).toBeNull();
  });
});

const IMAGE: Attachment = { id: '1', name: 'print.png', scope: 'issue', source: 'adk', url: FILE };

function PanelHarness({
  initial = [],
  onInsertInline,
  withContext = true,
}: {
  initial?: Attachment[];
  onInsertInline?: (attachment: Attachment) => void;
  withContext?: boolean;
}) {
  const [attachments, setAttachments] = useState<Attachment[]>(initial);
  const panel = (
    <AttachmentPanel
      scope="issue"
      attachments={attachments}
      onChange={setAttachments}
      onInsertInline={onInsertInline}
    />
  );
  return withContext ? (
    <MediaProvider apiClient={client().apiClient}>{panel}</MediaProvider>
  ) : (
    panel
  );
}

describe('AttachmentPanel editing', () => {
  it('adds links, validates them and removes attachments', () => {
    render(<PanelHarness />);
    const input = screen.getByLabelText('URL do arquivo');
    fireEvent.change(input, { target: { value: 'http://insecure.test/a.pdf' } });
    fireEvent.click(screen.getByRole('button', { name: 'Adicionar URL' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Informe uma URL HTTPS válida.');

    fireEvent.change(input, { target: { value: ' https://files.test/docs/Relat%C3%B3rio.docx ' } });
    fireEvent.keyDown(input, { key: 'a' });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByText('Relatório.docx')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Abrir no provedor: Relatório.docx' })).toBeTruthy();

    fireEvent.change(input, { target: { value: 'https://host.test' } });
    fireEvent.click(screen.getByRole('button', { name: 'Adicionar URL' }));
    expect(screen.getByText('host.test')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Remover anexo: host.test' }));
    expect(screen.queryByText('host.test')).toBeNull();
  });

  it('shows document icons by extension', () => {
    const docs = ['a.pdf', 'b.docx', 'c.csv', 'd.pptx', 'e.zip', 'f.txt', 'noext'].map(
      (name, index): Attachment => ({
        id: String(index),
        name,
        kind: 'document',
        scope: 'issue',
        source: 'url',
        url: `https://files.test/${name}`,
      }),
    );
    const { container } = render(<AttachmentPanel scope="issue" attachments={docs} />);
    const icons = [...container.querySelectorAll('li i.text-lg')].map((icon) =>
      [...icon.classList].find((name) => name.startsWith('ti-')),
    );
    expect(icons).toEqual([
      'ti-file-type-pdf',
      'ti-file-type-doc',
      'ti-file-spreadsheet',
      'ti-presentation',
      'ti-file-zip',
      'ti-file-text',
      'ti-file-text',
    ]);
  });

  it('keeps chosen and dropped files as drafts and validates them', async () => {
    const { container } = render(<PanelHarness />);
    const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(fileInput, { target: { files: [new File(['x'], 'run.exe')] } });
    expect(screen.getByRole('alert')).toHaveTextContent('run.exe: Tipo de arquivo não suportado.');
    fireEvent.change(fileInput, { target: { files: [big()] } });
    expect(screen.getByRole('alert')).toHaveTextContent('big.png passa do limite de 10 MB.');
    fireEvent.change(fileInput, { target: { files: [png()] } });
    expect(screen.queryByRole('alert')).toBeNull();
    expect(await screen.findByRole('img', { name: 'shot.png' })).toBeTruthy();

    const section = screen.getByRole('region', { name: 'Anexos' });
    fireEvent.dragOver(section, { dataTransfer: { types: ['text/plain'] } });
    expect(section.className).not.toContain('outline-2');
    fireEvent.dragOver(section, { dataTransfer: { types: ['Files'] } });
    expect(section.className).toContain('outline-2');
    fireEvent.dragLeave(section);
    expect(section.className).not.toContain('outline-2');
    fireEvent.dragOver(section, { dataTransfer: { types: ['Files'] } });
    fireEvent.drop(section, { dataTransfer: { files: [new File(['v'], 'clip.mp4')] } });
    expect(section.className).not.toContain('outline-2');
    expect(await screen.findByLabelText('clip.mp4')).toBeTruthy();
    fireEvent.drop(section, { dataTransfer: { files: [] } });
  });

  it('enforces the attachment limit', () => {
    const many = Array.from({ length: 20 }, (_, index): Attachment => ({
      id: String(index),
      name: `doc${index}.pdf`,
      kind: 'document',
      scope: 'issue',
      source: 'url',
      url: `https://files.test/doc${index}.pdf`,
    }));
    const { container } = render(<PanelHarness initial={many} />);
    const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(fileInput, { target: { files: [png()] } });
    expect(screen.getByRole('alert')).toHaveTextContent('Máximo de 20 anexos.');
    fireEvent.keyDown(screen.getByLabelText('URL do arquivo'), { key: 'Enter' });
    expect(screen.getByRole('alert')).toHaveTextContent('Máximo de 20 anexos.');
  });

  it('inserts images in the text', async () => {
    const insert = vi.fn();
    render(<PanelHarness initial={[IMAGE]} onInsertInline={insert} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Inserir no texto: print.png' }));
    await screen.findByRole('img', { name: 'print.png' });
    expect(insert).toHaveBeenCalledWith(IMAGE);
  });

  it('ignores drops and keeps read-only lists without the editor', () => {
    const { container } = render(
      <AttachmentPanel scope="issue" attachments={[IMAGE]} disabled onChange={vi.fn()} />,
    );
    const section = screen.getByRole('region', { name: 'Anexos' });
    fireEvent.dragOver(section, { dataTransfer: { types: ['Files'] } });
    fireEvent.drop(section, { dataTransfer: { files: [png()] } });
    expect(container.querySelectorAll('li')).toHaveLength(1);
    expect(render(<AttachmentPanel scope="issue" attachments={[]} />).container.innerHTML).toBe('');
  });
});

describe('AttachmentPanel downloads and previews', () => {
  it('downloads stored files and opens provider files that cannot be fetched', async () => {
    const { apiClient, getMedia } = client();
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    const remote: Attachment = {
      id: '2',
      name: 'logs.pdf',
      kind: 'document',
      scope: 'issue',
      source: 'url',
      url: 'https://files.test/logs.pdf',
    };
    render(<AttachmentPanel apiClient={apiClient} scope="issue" attachments={[IMAGE, remote]} />);
    fireEvent.click(screen.getByRole('button', { name: 'Baixar: print.png' }));
    await waitFor(() => expect(click).toHaveBeenCalled());

    getMedia.mockRejectedValue(new Error('denied'));
    fireEvent.click(screen.getByRole('button', { name: 'Baixar: logs.pdf' }));
    await waitFor(() =>
      expect(open).toHaveBeenCalledWith(remote.url, '_blank', 'noopener,noreferrer'),
    );
  });

  it('reports stored files that are unavailable', async () => {
    render(<PanelHarness withContext={false} initial={[IMAGE]} />);
    // No client at all: nothing is editable and stored files cannot be fetched.
    expect(screen.queryByLabelText('URL do arquivo')).toBeNull();
    const { apiClient, getMedia } = client();
    getMedia.mockRejectedValue(new Error('gone'));
    render(
      <AttachmentPanel
        apiClient={apiClient}
        scope="issue"
        attachments={[{ ...IMAGE, id: '9', name: 'gone.png', url: FILE.replace('0f8f', '9f8f') }]}
        onChange={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Baixar: gone.png' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Arquivo indisponível');
  });

  it('falls back to opening the link when no client is available', async () => {
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    render(
      <AttachmentPanel
        scope="issue"
        attachments={[{ ...IMAGE, name: 'web.png', source: 'url', url: REMOTE }]}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Baixar: web.png' }));
    await waitFor(() => expect(open).toHaveBeenCalledWith(REMOTE, '_blank', 'noopener,noreferrer'));
  });

  it('plays provider videos and shows a notice when a video cannot load', async () => {
    const { apiClient, getMedia } = client();
    getMedia.mockRejectedValue(new Error('denied'));
    const videos: Attachment[] = [
      { id: 'v1', name: 'remote.mp4', kind: 'video', scope: 'issue', source: 'url', url: REMOTE },
      { id: 'v2', name: 'stored.mp4', kind: 'video', scope: 'issue', source: 'adk', url: FILE },
    ];
    // Given client without a MediaProvider: stored videos cannot be resolved.
    render(<AttachmentPanel apiClient={apiClient} scope="issue" attachments={videos} />);
    const video = screen.getByLabelText('remote.mp4');
    expect(video.getAttribute('src')).toBe(REMOTE);
    expect(screen.getByText('Arquivo indisponível')).toBeTruthy();
    fireEvent.error(video);
    await waitFor(() => expect(screen.getAllByText('Arquivo indisponível')).toHaveLength(2));
  });
});

describe('direct image insertion', () => {
  it('keeps the alt text of failed images and ignores empty or client-less insertions', async () => {
    const { apiClient, getMedia } = client();
    getMedia.mockRejectedValue(new Error('denied'));
    const root = document.createElement('div');
    root.innerHTML = `<img src="${REMOTE}" alt="Diagrama">`;
    resolveInlineImages(root, apiClient);
    const image = root.querySelector('img')!;
    image.dispatchEvent(new Event('error'));
    await waitFor(() => expect(image.classList.contains('opacity-40')).toBe(true));
    expect(image.alt).toBe('Diagrama');

    const onChange = vi.fn();
    let api: ReturnType<typeof useMarkdownImageInput> | undefined;
    function Probe() {
      api = useMarkdownImageInput('brain', onChange);
      return null;
    }
    const textarea = document.createElement('textarea');
    const view = render(
      <MediaProvider apiClient={apiClient}>
        <Probe />
      </MediaProvider>,
    );
    act(() => api!.insertFiles(textarea, []));
    view.unmount();
    render(<Probe />);
    act(() => api!.insertFiles(textarea, [png()]));
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe('AttachmentPanel in English', () => {
  it('reports oversize files', () => {
    const { container } = render(
      <I18nProvider initialLocale="en-US">
        <PanelHarness />
      </I18nProvider>,
    );
    fireEvent.change(container.querySelector('input[type="file"]')!, {
      target: { files: [big()] },
    });
    expect(screen.getByRole('alert')).toHaveTextContent('big.png is over the 10 MB limit.');
  });
});
