import { fireEvent, screen, waitFor } from '@testing-library/react';
import { expect } from 'vitest';

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Picks a repository in the searchable select of the E2E repository picker: opens the list and
 * clicks the option named after the repository (the label may add the host: "acme/app (GitHub)").
 * `names` maps the "provider:id" key a test works with to the repository's name.
 */
export async function pickRepository(
  names: Readonly<Record<string, string>>,
  key: string,
  scope: Pick<typeof screen, 'findByRole'> = screen,
): Promise<void> {
  const field = await scope.findByRole('combobox', { name: 'Repositório' });
  await waitFor(() => expect((field as HTMLInputElement).disabled).toBe(false));
  fireEvent.focus(field);
  const name = names[key] ?? key;
  fireEvent.click(
    await screen.findByRole('option', { name: new RegExp(`^${escapeRegExp(name)}`) }),
  );
}
