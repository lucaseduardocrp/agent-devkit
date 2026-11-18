import { fireEvent, screen } from '@testing-library/react';

/**
 * Picks an option in a searchable select: opens its list (drawn in the page body, so it is found
 * on `screen`, not inside a dialog) and clicks the option with that name.
 */
export async function pickOption(combobox: HTMLElement, name: string | RegExp): Promise<void> {
  fireEvent.focus(combobox);
  fireEvent.click(await screen.findByRole('option', { name }));
}
