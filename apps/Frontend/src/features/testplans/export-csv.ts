import type { GeneratedTestPlanDto } from '../../lib/api-client.js';

export type CsvExportErrorCode =
  'INCOMPLETE_CASE' | 'MISSING_AZURE_DESTINATION' | 'INCOMPLETE_STEP';

export class CsvExportError extends Error {
  constructor(readonly code: CsvExportErrorCode) {
    super(code);
    this.name = 'CsvExportError';
  }
}

export function exportCasesCsv(
  plans: readonly GeneratedTestPlanDto[],
  options: { format: 'azure' | 'standard'; areaPath: string; assignedTo: string; state: string },
): string {
  if (!plans.length || plans.some((plan) => !plan.title.trim() || !plan.steps.length)) {
    throw new CsvExportError('INCOMPLETE_CASE');
  }
  const azure = options.format === 'azure';
  if (azure && (!options.areaPath.trim() || !options.assignedTo.trim() || !options.state.trim())) {
    throw new CsvExportError('MISSING_AZURE_DESTINATION');
  }
  const rows: string[][] = [
    azure
      ? [
          'ID',
          'Work Item Type',
          'Title',
          'Description',
          'Test Step',
          'Step Action',
          'Step Expected',
          'Area Path',
          'Assigned To',
          'State',
        ]
      : ['Title', 'Description', 'Step', 'Action', 'Expected Result', 'Data'],
  ];
  for (const plan of plans) {
    if (azure)
      rows.push([
        '',
        'Test Case',
        plan.title,
        plan.description,
        '',
        '',
        '',
        options.areaPath.trim(),
        options.assignedTo.trim(),
        options.state.trim(),
      ]);
    plan.steps.forEach((step, index) => {
      if (!step.action.trim() || !step.expectedResult.trim())
        throw new CsvExportError('INCOMPLETE_STEP');
      rows.push(
        azure
          ? [
              '',
              '',
              '',
              '',
              String(index + 1),
              step.data ? `${step.action}\nDados: ${step.data}` : step.action,
              step.expectedResult,
              '',
              '',
              '',
            ]
          : [
              plan.title,
              plan.description,
              String(index + 1),
              step.action,
              step.expectedResult,
              step.data ?? '',
            ],
      );
    });
  }
  return (
    '\uFEFF' +
    rows
      .map((row) =>
        row
          .map((value) => (/[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value))
          .join(','),
      )
      .join('\r\n') +
    '\r\n'
  );
}
