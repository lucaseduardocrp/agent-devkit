import { fireEvent, render, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { E2eCaseRevision } from '../src/lib/api-client.js';
import { ApiClient } from '../src/lib/api-client.js';
import { MediaProvider } from '../src/features/shared/media.js';
import {
  TestCaseFixChat,
  type TestCaseFixAssistant,
} from '../src/features/testplans/TestCaseFixChat.js';
import { TestCaseModal } from '../src/features/testplans/TestCaseModal.js';
import {
  applyRevision,
  caseToDraft,
  richTextToPlain,
} from '../src/features/testplans/test-case-revision.js';
import type { TestCase } from '../src/features/testplans/TestPlansView.js';

const original: TestCase = {
  id: 'CT-01',
  caseId: 'case-1',
  title: 'Pay with card',
  scenario: '<p>Pay the <b>cart</b></p><p>Second line</p>',
  steps: [{ order: 1, action: 'Open the cart', expectedResult: 'Cart shown', data: 'x' }],
};

const rewritten: E2eCaseRevision = {
  reply: 'Corrigi o fluxo: agora começa pelo menu.',
  testCase: {
    title: 'Pay with card from the menu',
    description: 'Start at the menu\n\nThen pay',
    steps: [
      { action: 'Open the menu', expectedResult: 'Menu shown' },
      { action: 'Pay', expectedResult: 'Paid' },
    ],
  },
};

beforeEach(() => {
  Object.defineProperty(document, 'execCommand', { configurable: true, value: vi.fn(() => true) });
});
afterEach(() => vi.restoreAllMocks());

describe('test case revision', () => {
  it('turns rich text and Markdown into plain text', () => {
    expect(
      richTextToPlain('<p>Pay the <b>cart</b> &amp; go</p><img src="x"><ul><li>One</li></ul>'),
    ).toBe('Pay the cart & go\nOne');
    expect(richTextToPlain('<p>One</p>   \n\n\n<p>Two<br>three</p>')).toBe('One\n\nTwo\nthree');
    // The pictures of a Markdown description are not read by the AI either.
    expect(richTextToPlain('See\n\n![shot](/attachments/drafts/x)\n\nDone')).toBe('See\n\nDone');
    expect(richTextToPlain('')).toBe('');
  });

  it('reads a case the way the AI does, with or without steps', () => {
    expect(caseToDraft(original)).toEqual({
      title: 'Pay with card',
      description: 'Pay the cart\nSecond line',
      steps: [{ action: 'Open the cart', expectedResult: 'Cart shown' }],
    });
    expect(caseToDraft({ ...original, steps: undefined }).steps).toEqual([]);
  });

  it('replaces what the AI rewrote and keeps the text of a description it left alone', () => {
    const next = applyRevision(original, rewritten.testCase!);
    expect(next).toMatchObject({
      id: 'CT-01',
      caseId: 'case-1',
      title: 'Pay with card from the menu',
      scenario: 'Start at the menu\n\nThen pay',
      steps: [
        { order: 1, action: 'Open the menu', expectedResult: 'Menu shown' },
        { order: 2, action: 'Pay', expectedResult: 'Paid' },
      ],
    });
    const same = applyRevision(original, {
      ...caseToDraft(original),
      description: ' Pay the cart   Second line ',
      steps: [],
    });
    expect(same.scenario).toBe(original.scenario);
    expect(same.steps).toEqual([]);
  });
});

function Chat({
  assistant,
  onRegenerate = vi.fn(),
  onClose = vi.fn(),
  onChange,
  withClient = true,
  testCase = original,
}: {
  assistant: TestCaseFixAssistant;
  onRegenerate?: () => void;
  onClose?: () => void;
  onChange?: (testCase: TestCase) => void;
  withClient?: boolean;
  testCase?: TestCase;
}) {
  const [current, setCurrent] = useState(testCase);
  const chat = (
    <TestCaseFixChat
      assistant={assistant}
      testCase={current}
      onChange={(next) => {
        setCurrent(next);
        onChange?.(next);
      }}
      onRegenerate={onRegenerate}
      isRegenerating={false}
      onClose={onClose}
    />
  );
  return (
    <>
      <output data-testid="current-title">{current.title}</output>
      {withClient ? <MediaProvider apiClient={apiClient}>{chat}</MediaProvider> : chat}
    </>
  );
}

const apiClient = new ApiClient({ baseUrl: 'http://api.test' });
const value = (element: HTMLElement) => (element as HTMLInputElement).value;

/** The answers in order; an Error or a string is a failure. */
function assistantOf(...answers: (E2eCaseRevision | Error | string)[]): TestCaseFixAssistant & {
  ask: ReturnType<typeof vi.fn>;
} {
  const ask = vi.fn();
  for (const answer of answers)
    ask.mockImplementationOnce(() =>
      answer instanceof Error || typeof answer === 'string'
        ? Promise.reject(answer as Error)
        : Promise.resolve(answer),
    );
  return { ask, saveAndRegenerate: vi.fn() };
}

const box = (view: ReturnType<typeof render>) =>
  view.getByRole('textbox', { name: /Descreva o que está errado/ }) as HTMLTextAreaElement;
const send = (view: ReturnType<typeof render>) => view.getByRole('button', { name: 'Enviar' });
const image = (name = 'flow.png') => new File(['png'], name, { type: 'image/png' });

describe('TestCaseFixChat', () => {
  it('sends what the user says with the case, applies the rewrite and lets the user undo it', async () => {
    const assistant = assistantOf(rewritten);
    const onChange = vi.fn();
    const view = render(<Chat assistant={assistant} onChange={onChange} />);
    expect(view.getByText(/Diga o que o teste faz de errado/)).toBeInTheDocument();
    // Nothing to send until the user writes something.
    expect((send(view) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(box(view), { target: { value: '  O fluxo começa pelo menu  ' } });
    fireEvent.click(send(view));
    expect(await view.findByText(rewritten.reply)).toBeInTheDocument();

    expect(assistant.ask).toHaveBeenCalledWith({
      messages: [{ role: 'user', content: 'O fluxo começa pelo menu' }],
      testCase: caseToDraft(original),
      imageIds: [],
    });
    expect(box(view).value).toBe('');
    expect(view.getByTestId('current-title')).toHaveTextContent('Pay with card from the menu');
    expect(view.getByText('Caso de teste atualizado')).toBeInTheDocument();

    fireEvent.click(view.getByRole('button', { name: 'Desfazer' }));
    expect(onChange).toHaveBeenLastCalledWith(original);
    expect(view.getByTestId('current-title')).toHaveTextContent('Pay with card');
    expect(view.queryByText('Caso de teste atualizado')).toBeNull();
  });

  it('keeps the whole conversation and offers to undo only the latest rewrite', async () => {
    const assistant = assistantOf(rewritten, { reply: 'Qual tela abre depois?', testCase: null });
    const view = render(<Chat assistant={assistant} />);
    fireEvent.change(box(view), { target: { value: 'Primeiro' } });
    fireEvent.keyDown(box(view), { key: 'Enter' });
    await view.findByText(rewritten.reply);
    fireEvent.change(box(view), { target: { value: 'Segundo' } });
    fireEvent.keyDown(box(view), { key: 'Enter' });
    await view.findByText('Qual tela abre depois?');
    expect(assistant.ask.mock.calls[1]![0].messages).toEqual([
      { role: 'user', content: 'Primeiro' },
      { role: 'assistant', content: rewritten.reply },
      { role: 'user', content: 'Segundo' },
    ]);
    // The case the second turn saw is the one the first turn left.
    expect(assistant.ask.mock.calls[1]![0].testCase.title).toBe('Pay with card from the menu');
    // A rewrite older than the last message can no longer be undone.
    expect(view.queryByRole('button', { name: 'Desfazer' })).toBeNull();
  });

  it('says so when the AI rewrites the case without a message', async () => {
    const view = render(
      <Chat assistant={assistantOf({ reply: '', testCase: rewritten.testCase })} />,
    );
    fireEvent.change(box(view), { target: { value: 'Ajuste' } });
    fireEvent.click(send(view));
    expect(await view.findByText('Atualizei o caso de teste.')).toBeInTheDocument();
  });

  it('keeps an empty answer from the AI as an empty message', async () => {
    const view = render(<Chat assistant={assistantOf({ reply: '', testCase: null })} />);
    fireEvent.change(box(view), { target: { value: 'Ajuste' } });
    fireEvent.click(send(view));
    await waitFor(() => expect(view.getAllByTestId('fix-chat-assistant')).toHaveLength(1));
    expect(view.getByTestId('fix-chat-assistant')).not.toHaveTextContent(
      'Caso de teste atualizado',
    );
  });

  it('names an image that has no name in the message it is sent with', async () => {
    vi.spyOn(apiClient, 'uploadAttachment').mockResolvedValue({ id: 'id-1' } as Awaited<
      ReturnType<ApiClient['uploadAttachment']>
    >);
    const view = render(<Chat assistant={assistantOf({ reply: 'Vi', testCase: null })} />);
    fireEvent.change(view.getByLabelText('Anexar imagem'), {
      target: { files: [new File(['x'], '', { type: 'image/png' })] },
    });
    fireEvent.change(box(view), { target: { value: 'Veja' } });
    fireEvent.click(send(view));
    await view.findByText('Vi');
    expect(within(view.getByTestId('fix-chat-user')).getByText('image')).toBeInTheDocument();
  });

  it('sends on Enter, not on Shift+Enter, and locks the box while the AI answers', async () => {
    let answer: (revision: E2eCaseRevision) => void = () => undefined;
    const assistant = assistantOf();
    assistant.ask.mockReturnValue(new Promise((resolve) => (answer = resolve)));
    const view = render(<Chat assistant={assistant} />);
    fireEvent.keyDown(box(view), { key: 'Enter' });
    expect(assistant.ask).not.toHaveBeenCalled();
    fireEvent.change(box(view), { target: { value: 'Um' } });
    fireEvent.keyDown(box(view), { key: 'Enter', shiftKey: true });
    fireEvent.keyDown(box(view), { key: 'a' });
    expect(assistant.ask).not.toHaveBeenCalled();
    fireEvent.keyDown(box(view), { key: 'Enter' });
    expect(await view.findByText(/A IA está trabalhando/)).toBeInTheDocument();
    expect(box(view).disabled).toBe(true);
    expect(assistant.ask).toHaveBeenCalledOnce();
    answer({ reply: 'Pronto', testCase: null });
    expect(await view.findByText('Pronto')).toBeInTheDocument();
    expect(view.queryByText(/A IA está trabalhando/)).toBeNull();
  });

  it('puts the message back and says why when the AI cannot answer', async () => {
    const assistant = assistantOf(new Error('Provider offline'), new Error(''), 'offline', {
      reply: 'ok',
      testCase: null,
    });
    const view = render(<Chat assistant={assistant} />);
    fireEvent.change(box(view), { target: { value: 'Tentar' } });
    fireEvent.click(send(view));
    expect(await view.findByRole('alert')).toHaveTextContent('Provider offline');
    expect(box(view).value).toBe('Tentar');
    expect(view.queryByTestId('fix-chat-user')).toBeNull();

    fireEvent.click(send(view));
    await waitFor(() =>
      expect(view.getByRole('alert')).toHaveTextContent('A IA não conseguiu responder'),
    );
    expect(box(view).value).toBe('Tentar');
    // Something that is not an Error says nothing useful either.
    fireEvent.click(send(view));
    await waitFor(() => expect(assistant.ask).toHaveBeenCalledTimes(3));
    await waitFor(() =>
      expect(view.getByRole('alert')).toHaveTextContent('A IA não conseguiu responder'),
    );

    fireEvent.click(send(view));
    expect(await view.findByText('ok')).toBeInTheDocument();
    expect(view.queryByRole('alert')).toBeNull();
  });

  it('uploads the images, keeps showing them to the AI and keeps the latest five', async () => {
    const upload = vi
      .spyOn(apiClient, 'uploadAttachment')
      .mockImplementation((_scope, file) =>
        Promise.resolve({ id: `id-${file.name}` } as Awaited<
          ReturnType<ApiClient['uploadAttachment']>
        >),
      );
    const assistant = assistantOf(
      { reply: 'Vi', testCase: null },
      { reply: 'Vi de novo', testCase: null },
    );
    const view = render(<Chat assistant={assistant} />);
    const attach = view.getByLabelText('Anexar imagem') as HTMLInputElement;
    fireEvent.change(attach, { target: { files: [image('a.png'), image('b.png')] } });
    expect(view.getByText('a.png')).toBeInTheDocument();
    fireEvent.click(view.getByRole('button', { name: 'Remover b.png' }));
    expect(view.queryByText('b.png')).toBeNull();
    fireEvent.change(box(view), { target: { value: 'Veja' } });
    fireEvent.click(send(view));
    await view.findByText('Vi');
    expect(upload).toHaveBeenCalledWith('e2e', expect.objectContaining({ name: 'a.png' }));
    expect(assistant.ask.mock.calls[0]![0].imageIds).toEqual(['id-a.png']);
    // The sent images stay on the message and out of the box.
    expect(within(view.getByTestId('fix-chat-user')).getByText('a.png')).toBeInTheDocument();
    expect(view.queryByRole('button', { name: 'Remover a.png' })).toBeNull();

    fireEvent.change(attach, {
      target: { files: ['c', 'd', 'e', 'f', 'g'].map((name) => image(`${name}.png`)) },
    });
    fireEvent.change(box(view), { target: { value: 'Mais' } });
    fireEvent.click(send(view));
    await view.findByText('Vi de novo');
    expect(assistant.ask.mock.calls[1]![0].imageIds).toEqual([
      'id-c.png',
      'id-d.png',
      'id-e.png',
      'id-f.png',
      'id-g.png',
    ]);
  });

  it('refuses what is not an image, what is too big and more than five at once', () => {
    const view = render(<Chat assistant={assistantOf()} />);
    const attach = view.getByLabelText('Anexar imagem') as HTMLInputElement;
    fireEvent.change(attach, {
      target: { files: [new File(['x'], 'notes.pdf', { type: 'application/pdf' })] },
    });
    expect(view.getByRole('alert')).toHaveTextContent('notes.pdf: só é possível enviar imagens');
    fireEvent.change(attach, {
      target: { files: [new File(['x'], '', { type: 'application/pdf' })] },
    });
    expect(view.getByRole('alert')).toHaveTextContent('image: só é possível enviar imagens');
    fireEvent.change(attach, {
      target: {
        files: [new File([new Uint8Array(5 * 1024 * 1024 + 1)], 'big.png', { type: 'image/png' })],
      },
    });
    expect(view.getByRole('alert')).toHaveTextContent('big.png');
    fireEvent.change(attach, { target: { files: [new File(['x'], '', { type: 'image/png' })] } });
    expect(view.queryByRole('alert')).toBeNull();
    expect(view.getByText('image')).toBeInTheDocument();
    fireEvent.click(view.getByRole('button', { name: 'Remover image' }));
    fireEvent.change(attach, {
      target: { files: ['a', 'b', 'c', 'd', 'e', 'f'].map((name) => image(`${name}.png`)) },
    });
    expect(view.getByRole('alert')).toHaveTextContent('No máximo 5 imagens por mensagem.');
    // Picking nothing changes nothing.
    fireEvent.change(attach, { target: { files: [] } });
    expect(view.getByRole('alert')).toHaveTextContent('No máximo 5 imagens');
    fireEvent.change(attach, { target: { files: [new File(['x'], '', { type: 'image/gif' })] } });
    fireEvent.change(attach, { target: { files: [new File(['x'], '', { type: 'image/gif' })] } });
    expect(view.queryByRole('alert')).toBeNull();
  });

  it('takes images pasted into the box and lets other pastes through', () => {
    const view = render(<Chat assistant={assistantOf()} />);
    const text = fireEvent.paste(box(view), { clipboardData: { files: [] } });
    expect(text).toBe(true);
    const mixed = fireEvent.paste(box(view), {
      clipboardData: { files: [new File(['x'], 'notes.txt', { type: 'text/plain' })] },
    });
    expect(mixed).toBe(true);
    const pasted = fireEvent.paste(box(view), { clipboardData: { files: [image('shot.png')] } });
    expect(pasted).toBe(false);
    expect(view.getByText('shot.png')).toBeInTheDocument();
  });

  it('cannot send images without a connection to the server', () => {
    const view = render(<Chat assistant={assistantOf()} withClient={false} />);
    expect((view.getByLabelText('Anexar imagem') as HTMLInputElement).disabled).toBe(true);
    const pasted = fireEvent.paste(box(view), { clipboardData: { files: [image('shot.png')] } });
    expect(pasted).toBe(true);
    expect(view.queryByText('shot.png')).toBeNull();
  });

  it('saves and regenerates from the case it left, and closes', async () => {
    const onRegenerate = vi.fn();
    const onClose = vi.fn();
    const view = render(
      <Chat assistant={assistantOf()} onRegenerate={onRegenerate} onClose={onClose} />,
    );
    fireEvent.click(view.getByRole('button', { name: 'Salvar e regenerar script' }));
    expect(onRegenerate).toHaveBeenCalledOnce();
    fireEvent.click(view.getByRole('button', { name: 'Fechar o chat' }));
    expect(onClose).toHaveBeenCalledOnce();
  });
});

describe('TestCaseModal with Fix with AI', () => {
  function open(
    options: {
      readOnly?: boolean;
      assistant?: TestCaseFixAssistant | null;
      withClient?: boolean;
      testCase?: TestCase;
    } = {},
  ) {
    const assistant =
      options.assistant === null
        ? undefined
        : (options.assistant ?? {
            ask: vi.fn().mockResolvedValue(rewritten),
            saveAndRegenerate: vi.fn().mockResolvedValue(undefined),
          });
    const onSave = vi.fn();
    const modal = (
      <TestCaseModal
        testCase={options.testCase ?? original}
        {...(options.readOnly ? { readOnly: true } : {})}
        {...(assistant ? { fixWithAi: assistant } : {})}
        onSave={onSave}
        onClose={vi.fn()}
      />
    );
    const view = render(
      options.withClient === false ? (
        modal
      ) : (
        <MediaProvider apiClient={apiClient}>{modal}</MediaProvider>
      ),
    );
    return { view, assistant, onSave };
  }

  it('offers the chat only where the case can be fixed', () => {
    expect(open({ assistant: null }).view.queryByTestId('btn-fix-with-ai')).toBeNull();
    const readOnly = open({ readOnly: true });
    expect(readOnly.view.queryByTestId('btn-fix-with-ai')).toBeNull();
  });

  it('opens the chat beside the case and closes it again', () => {
    const { view } = open();
    const button = view.getByTestId('btn-fix-with-ai');
    expect(button).toHaveAttribute('aria-pressed', 'false');
    expect(view.queryByTestId('test-case-fix-chat')).toBeNull();
    expect(view.getByText('Origem', { selector: 'h3' })).toBeInTheDocument();
    fireEvent.click(button);
    expect(button).toHaveAttribute('aria-pressed', 'true');
    expect(view.getByTestId('test-case-fix-chat')).toBeInTheDocument();
    expect(view.queryByText('Origem', { selector: 'h3' })).toBeNull();
    fireEvent.click(view.getByRole('button', { name: 'Fechar o chat' }));
    expect(view.queryByTestId('test-case-fix-chat')).toBeNull();
    expect(view.getByText('Origem', { selector: 'h3' })).toBeInTheDocument();
  });

  it('lets the user resize the chat against the case', () => {
    const { view } = open();
    // The handle only exists beside the chat.
    expect(view.queryByRole('separator')).toBeNull();
    fireEvent.click(view.getByTestId('btn-fix-with-ai'));
    const handle = view.getByRole('separator', { name: 'Redimensionar o chat' });
    const grid = view.getByTestId('test-case-fix-chat').parentElement!;
    expect(grid.style.getPropertyValue('--chat-width')).toBe('460px');
    fireEvent.keyDown(handle, { key: 'ArrowLeft' });
    expect(grid.style.getPropertyValue('--chat-width')).toBe('484px');
    expect(handle).toHaveAttribute('aria-valuenow', '484');
    fireEvent.keyDown(handle, { key: 'ArrowRight' });
    expect(grid.style.getPropertyValue('--chat-width')).toBe('460px');
  });

  it('shows what the AI rewrote in the title, the description and the steps, and saves it', async () => {
    const { view, onSave } = open();
    fireEvent.click(view.getByTestId('btn-fix-with-ai'));
    fireEvent.change(box(view), { target: { value: 'Comece pelo menu' } });
    fireEvent.click(send(view));
    await view.findByText(rewritten.reply);

    expect(value(view.getByTestId('input-edit-test-title'))).toBe('Pay with card from the menu');
    const scenario = view.getByTestId('input-edit-test-scenario-formatted');
    expect(scenario).toHaveTextContent('Start at the menuThen pay');
    expect(value(view.getByTestId('input-step-action-1'))).toBe('Open the menu');
    expect(value(view.getByTestId('input-step-expected-2'))).toBe('Paid');
    expect(view.queryByTestId('input-step-action-3')).toBeNull();

    // The user keeps editing after the AI, and an undo gives the case back as it was.
    // (The Markdown editor has an undo of its own in its toolbar.)
    fireEvent.click(
      within(view.getByTestId('test-case-fix-chat')).getByRole('button', { name: 'Desfazer' }),
    );
    expect(value(view.getByTestId('input-edit-test-title'))).toBe('Pay with card');
    expect(scenario).toHaveTextContent('Pay the cartSecond line');
    expect(scenario.querySelector('strong')).not.toBeNull();
    expect(value(view.getByTestId('input-step-action-1'))).toBe('Open the cart');

    fireEvent.change(box(view), { target: { value: 'De novo' } });
    fireEvent.click(send(view));
    await waitFor(() => expect(view.getAllByTestId('fix-chat-assistant')).toHaveLength(2));
    fireEvent.change(view.getByTestId('input-step-action-1'), {
      target: { value: 'Open the menu!' },
    });
    fireEvent.click(view.getByTestId('btn-save-test-case-modal'));
    await waitFor(() => expect(onSave).toHaveBeenCalledOnce());
    expect(onSave.mock.calls[0]![0]).toMatchObject({
      title: 'Pay with card from the menu',
      steps: [
        { order: 1, action: 'Open the menu!', expectedResult: 'Menu shown' },
        { order: 2, action: 'Pay', expectedResult: 'Paid' },
      ],
    });
  });

  it('saves the case and regenerates the script from the chat', async () => {
    const { view, assistant, onSave } = open();
    fireEvent.click(view.getByTestId('btn-fix-with-ai'));
    fireEvent.change(box(view), { target: { value: 'Comece pelo menu' } });
    fireEvent.click(send(view));
    await view.findByText(rewritten.reply);
    fireEvent.click(view.getByTestId('btn-fix-regenerate'));
    await waitFor(() => expect(assistant!.saveAndRegenerate).toHaveBeenCalledOnce());
    expect(vi.mocked(assistant!.saveAndRegenerate).mock.calls[0]![0]).toMatchObject({
      title: 'Pay with card from the menu',
      scenario: 'Start at the menu\n\nThen pay',
    });
    // Saving the case alone is not what this button does.
    expect(onSave).not.toHaveBeenCalled();
  });

  it('shows in the editor why the case could not be saved for the new script', async () => {
    const assistant = {
      ask: vi.fn(),
      saveAndRegenerate: vi.fn().mockRejectedValue(new Error('Plan is locked')),
    };
    const { view } = open({ assistant });
    fireEvent.click(view.getByTestId('btn-fix-with-ai'));
    fireEvent.click(view.getByTestId('btn-fix-regenerate'));
    expect(await view.findByText('Plan is locked')).toBeInTheDocument();
    expect(view.getByTestId('test-case-fix-chat')).toBeInTheDocument();
  });

  it('regenerates without a connection to the media storage too', async () => {
    const { view, assistant } = open({ withClient: false });
    fireEvent.click(view.getByTestId('btn-fix-with-ai'));
    fireEvent.click(view.getByTestId('btn-fix-regenerate'));
    // The case reaches the script as the Markdown the editor wrote.
    await waitFor(() =>
      expect(assistant!.saveAndRegenerate).toHaveBeenCalledWith({
        ...original,
        scenario: 'Pay the **cart**\n\nSecond line',
      }),
    );
  });
});
