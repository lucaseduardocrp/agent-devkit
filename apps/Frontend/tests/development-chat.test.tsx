import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { ReviewComment, SessionEvent } from '../src/features/development/development-types.js';
import { button, click, mockClient, session, show } from './helpers/development.js';

const said = (id: string, at: string, text: string): SessionEvent => ({
  id,
  at,
  kind: 'message',
  text,
  subagentId: null,
});
const comment = (fields: Partial<ReviewComment>): ReviewComment => ({
  id: 'c1',
  author: 'user',
  authorName: 'Lucas',
  path: null,
  line: null,
  body: 'Use the existing helper',
  resolved: false,
  createdAt: '2026-11-10T10:02:00.000Z',
  ...fields,
});

const open = async (fields: Parameters<typeof session>[0] = {}, readOnly = false) => {
  const client = mockClient([session(fields)]);
  await show(client.api, { readOnly });
  click(/Implement login/);
  return client;
};
const chat = () => within(screen.getByRole('region', { name: 'Conversa' }));
const box = () => chat().getByLabelText('Escreva uma mensagem para o agente...');
const write = (value: string) => fireEvent.change(box(), { target: { value } });
const typed = () => (box() as HTMLInputElement).value;
const send = () => chat().getByRole<HTMLButtonElement>('button', { name: 'Enviar mensagem' });

describe('Session chat', () => {
  it('shows what the agent said and what was written to it, in the order it happened', async () => {
    await open({
      events: [
        said('e2', '2026-11-10T10:03:00.000Z', 'Done, see the diff.'),
        said('e1', '2026-11-10T10:01:00.000Z', 'Reading the code.'),
        { ...said('e3', '2026-11-10T10:04:00.000Z', 'git status'), kind: 'tool' },
      ],
      comments: [
        comment({}),
        comment({
          id: 'c2',
          author: 'agent',
          body: 'Which helper?',
          createdAt: '2026-11-10T10:00:00.000Z',
        }),
        // Tied to a file: it belongs to the changes, not to the talk.
        comment({ id: 'c3', path: 'src/app.ts', body: 'Contexto anexado: src/app.ts' }),
      ],
    });
    const messages = chat().getAllByRole('article');
    expect(messages.map((item) => item.textContent)).toEqual([
      'Which helper?',
      'Reading the code.',
      'Use the existing helper',
      'Done, see the diff.',
    ]);
    expect(messages.map((item) => item.getAttribute('aria-label'))).toEqual([
      'Agente',
      'Agente',
      'Você',
      'Agente',
    ]);
    expect(chat().queryByText('git status')).toBeNull();
    expect(chat().queryByText('Nenhuma mensagem ainda. Escreva para o agente.')).toBeNull();
  });

  it('tells the person what became of the message as a note between the messages', async () => {
    await open({
      events: [
        {
          ...said('e1', '2026-11-10T10:05:00.000Z', 'Message from Lucas sent to the agent.'),
          kind: 'feedback',
        },
      ],
      comments: [comment({ createdAt: '2026-11-10T10:04:00.000Z' })],
    });
    expect(chat().getAllByRole('article')).toHaveLength(1);
    expect(chat().getByRole('status')).toHaveTextContent('Message from Lucas sent to the agent.');
    expect(chat().queryByText('Nenhuma mensagem ainda. Escreva para o agente.')).toBeNull();
  });

  it('starts empty and sends what is written with the button or with Enter', async () => {
    const { api } = await open();
    expect(chat().getByText('Nenhuma mensagem ainda. Escreva para o agente.')).toBeInTheDocument();
    expect(send().disabled).toBe(true);

    write('  Please add tests  ');
    fireEvent.click(send());
    await waitFor(() =>
      expect(api.addDevelopmentComment).toHaveBeenCalledWith('s1', 'Please add tests'),
    );
    await waitFor(() => expect(typed()).toBe(''));

    write('And a changelog');
    fireEvent.keyDown(box(), { key: 'Enter' });
    await waitFor(() =>
      expect(api.addDevelopmentComment).toHaveBeenLastCalledWith('s1', 'And a changelog'),
    );
    expect(api.addDevelopmentComment).toHaveBeenCalledTimes(2);
  });

  it('keeps a new line with Shift+Enter, ignores Enter while composing and other keys', async () => {
    const { api } = await open();
    write('first line');
    fireEvent.keyDown(box(), { key: 'Enter', shiftKey: true });
    fireEvent.keyDown(box(), { key: 'Enter', isComposing: true });
    fireEvent.keyDown(box(), { key: 'a' });
    // An Enter on nothing sends nothing.
    write('   ');
    fireEvent.keyDown(box(), { key: 'Enter' });
    expect(api.addDevelopmentComment).not.toHaveBeenCalled();
  });

  it('keeps the text when it could not be sent and does not send twice while it goes out', async () => {
    const { api } = await open();
    api.addDevelopmentComment.mockRejectedValueOnce(new Error('offline'));
    write('Will fail');
    fireEvent.keyDown(box(), { key: 'Enter' });
    expect(await screen.findByRole('alert')).toHaveTextContent('offline');
    expect(typed()).toBe('Will fail');

    let finish: () => void = () => undefined;
    api.addDevelopmentComment.mockImplementationOnce(
      () => new Promise((resolve) => (finish = () => resolve(session()))),
    );
    fireEvent.keyDown(box(), { key: 'Enter' });
    await waitFor(() => expect(send().disabled).toBe(true));
    fireEvent.keyDown(box(), { key: 'Enter' });
    expect(api.addDevelopmentComment).toHaveBeenCalledTimes(2);
    // What is typed while it goes out is not lost when it arrives.
    write('Next one');
    finish();
    await waitFor(() => expect(send().disabled).toBe(false));
    expect(typed()).toBe('Next one');
  });

  it('cannot be written to in a read-only view', async () => {
    await open({}, true);
    expect((box() as HTMLInputElement).disabled).toBe(true);
    expect(send().disabled).toBe(true);
  });

  it('is shown or hidden from the toolbar, and hiding it keeps the rest where it was', async () => {
    await open();
    const toggle = button('Conversa');
    expect(toggle).toHaveAttribute('aria-pressed', 'true');
    click('Arquivos');
    const files = screen.getByRole('region', { name: 'Arquivos' });

    click('Conversa');
    expect(screen.queryByRole('region', { name: 'Conversa' })).toBeNull();
    expect(screen.queryByRole('separator', { name: 'Redimensionar a conversa' })).toBeNull();
    expect(button('Conversa')).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByRole('region', { name: 'Arquivos' })).toBe(files);

    click('Conversa');
    expect(screen.getByRole('region', { name: 'Conversa' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Arquivos' })).toBe(files);
  });

  it('is resized by its divider and closes, releasing its button, once it is too narrow to read', async () => {
    await open({ events: [said('e1', '2026-11-10T10:01:00.000Z', 'Reading the code.')] });
    const divider = () => screen.getByRole('separator', { name: 'Redimensionar a conversa' });
    expect(divider()).toHaveAttribute('aria-valuenow', '380');

    for (let step = 0; step < 16; step += 1) fireEvent.keyDown(divider(), { key: 'ArrowLeft' });
    expect(divider()).toHaveAttribute('aria-valuenow', '220');
    expect(button('Conversa')).toHaveAttribute('aria-pressed', 'true');

    // No empty strip is left behind: the column and its divider go, and the button is released.
    fireEvent.keyDown(divider(), { key: 'ArrowLeft' });
    expect(screen.queryByRole('region', { name: 'Conversa' })).toBeNull();
    expect(screen.queryByRole('separator', { name: 'Redimensionar a conversa' })).toBeNull();
    expect(button('Conversa')).toHaveAttribute('aria-pressed', 'false');

    // Opened again, it is readable again.
    click('Conversa');
    expect(screen.getByRole('region', { name: 'Conversa' })).toBeInTheDocument();
    expect(divider()).toHaveAttribute('aria-valuenow', '380');
    expect(button('Conversa')).toHaveAttribute('aria-pressed', 'true');
  });
});
