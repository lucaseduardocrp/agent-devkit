import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { NotificationRuleModal } from '../src/features/notifications/NotificationRuleModal.js';
import { previewTemplate } from '../src/features/notifications/notification-preview.js';
import type { NotificationEventDto } from '../src/features/notifications/notification-types.js';

const events: NotificationEventDto[] = [
  {
    key: 'issue.assigned',
    label: 'Issue assigned to a person',
    description: 'An issue is assigned to a member.',
    subjectLabel: 'The person it was assigned to',
    placeholders: ['issue.title', 'actor.name'],
    defaultSubject: 'Issue #{{issue.number}} was assigned to you',
    defaultMessage: '{{actor.name}} assigned you {{issue.title}}.',
  },
  {
    key: 'system.alert',
    label: 'System alert',
    description: 'Something nobody caused.',
    placeholders: [],
    defaultSubject: 'Alert',
    defaultMessage: 'Something happened.',
  },
];

function open(eventList: NotificationEventDto[] = events) {
  render(
    <NotificationRuleModal
      rule={null}
      events={eventList}
      channels={[{ id: 'email', label: 'E-mail', available: true }]}
      onSave={vi.fn()}
      onClose={vi.fn()}
    />,
  );
  return {
    subject: () => screen.getByTestId('rule-subject') as HTMLInputElement,
    message: () => screen.getByTestId('rule-message') as HTMLTextAreaElement,
    chip: (name: string) => screen.getByTestId(`rule-variable-${name}`),
  };
}

describe('previewTemplate', () => {
  it('fills the names it knows, with or without spaces, and keeps the ones it does not', () => {
    expect(previewTemplate('{{actor.name}} / {{ issue.number }} / {{what.ever}}')).toBe(
      'Ana / 42 / {{what.ever}}',
    );
  });
});

describe('the variables and the preview of a rule', () => {
  it('adds a variable to the message by default, and to the subject once it was last typed in', () => {
    const modal = open();
    fireEvent.click(modal.chip('issue.title'));
    fireEvent.click(modal.chip('actor.name'));
    expect(modal.message().value).toBe('{{issue.title}} {{actor.name}}');
    expect(modal.subject().value).toBe('');

    fireEvent.focus(modal.subject());
    fireEvent.change(modal.subject(), { target: { value: 'Done: ' } });
    fireEvent.click(modal.chip('issue.title'));
    // A text that already ends in a space gets no second one.
    expect(modal.subject().value).toBe('Done: {{issue.title}}');

    fireEvent.focus(modal.message());
    fireEvent.click(modal.chip('actor.name'));
    expect(modal.message().value).toBe('{{issue.title}} {{actor.name}} {{actor.name}}');
  });

  it('does not add a variable that would not fit in the text', () => {
    const modal = open();
    fireEvent.focus(modal.subject());
    fireEvent.change(modal.subject(), { target: { value: 'x'.repeat(195) } });
    fireEvent.click(modal.chip('issue.title'));
    expect(modal.subject().value).toBe('x'.repeat(195));

    fireEvent.focus(modal.message());
    fireEvent.change(modal.message(), { target: { value: 'y'.repeat(4995) } });
    fireEvent.click(modal.chip('issue.title'));
    expect(modal.message().value).toBe('y'.repeat(4995));
  });

  it('previews the wording of the event with example data, and then what was typed', () => {
    const modal = open();
    // The editor comes first; the preview replaces it, and the words are kept when going back.
    expect(screen.queryByTestId('rule-preview')).toBeNull();
    expect(screen.getByTestId('rule-tab-edit')).toHaveAttribute('aria-selected', 'true');
    fireEvent.click(screen.getByTestId('rule-tab-preview'));
    const preview = screen.getByTestId('rule-preview');
    expect(screen.queryByTestId('rule-message')).toBeNull();
    expect(screen.queryByTestId('rule-variables')).toBeNull();
    expect(preview).toHaveTextContent('Issue #42 was assigned to you');
    expect(preview).toHaveTextContent('Ana assigned you Fix the login page.');

    fireEvent.click(screen.getByTestId('rule-tab-edit'));
    fireEvent.change(modal.subject(), { target: { value: 'Hi {{recipient.name}}' } });
    fireEvent.change(modal.message(), { target: { value: 'Look at {{custom.thing}}' } });
    fireEvent.click(screen.getByTestId('rule-tab-preview'));
    expect(screen.getByTestId('rule-preview')).toHaveTextContent('Hi Ben');
    expect(screen.getByTestId('rule-preview')).toHaveTextContent('Look at {{custom.thing}}');
    fireEvent.click(screen.getByTestId('rule-tab-edit'));
    expect(modal.message().value).toBe('Look at {{custom.thing}}');
  });

  it('shows no variables for an event that has none, and an empty preview without events', () => {
    open();
    fireEvent.change(screen.getByTestId('rule-event'), { target: { value: 'system.alert' } });
    expect(screen.queryByTestId('rule-variables')).toBeNull();
    fireEvent.click(screen.getByTestId('rule-tab-preview'));
    expect(screen.getByTestId('rule-preview')).toHaveTextContent('Something happened.');
  });

  it('copes with a workspace that has no events', () => {
    open([]);
    expect(screen.queryByTestId('rule-variables')).toBeNull();
    fireEvent.click(screen.getByTestId('rule-tab-preview'));
    expect(screen.getByTestId('rule-preview')).toHaveTextContent('');
  });
});
