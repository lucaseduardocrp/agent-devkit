import type { RenderResult } from '@testing-library/react';
import { fireEvent } from '@testing-library/react';

/**
 * The export settings of the test plans live in a dialog: this opens it when it is closed and
 * returns the format select, so a test can change it the way a person would.
 */
export function exportFormatSelect(
  ui: Pick<RenderResult, 'getByLabelText' | 'queryByLabelText' | 'getByTestId'>,
) {
  if (!ui.queryByLabelText('Formato de exportação'))
    fireEvent.click(ui.getByTestId('btn-csv-configuration'));
  return ui.getByLabelText('Formato de exportação');
}

/** Closes the export settings dialog, so the page behind it is reachable again. */
export function closeExportSettings(ui: Pick<RenderResult, 'getByRole'>) {
  fireEvent.click(ui.getByRole('button', { name: 'Fechar' }));
}
