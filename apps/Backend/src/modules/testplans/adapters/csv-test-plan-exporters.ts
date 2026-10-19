import type { TestPlan } from '../domain/test-plan.js';
import type { TestPlanExporter, TestPlanExportRequest } from '../application/test-plan-export.js';

const serializeRows = (rows: readonly (readonly string[])[]): string =>
  `${rows.map((row) => row.map(escapeCsvValue).join(',')).join('\r\n')}\r\n`;

export class StandardCsvTestPlanExporter implements TestPlanExporter {
  public readonly id = 'standard';
  public readonly mediaType = 'text/csv';
  public readonly extension = 'csv';

  public export({ plans }: TestPlanExportRequest): string {
    return serializeRows([
      ['Title', 'Description', 'Step', 'Action', 'Expected Result', 'Data'],
      ...plans.flatMap((plan) =>
        plan.steps.map((step, index) => [
          plan.title,
          plan.description,
          String(step.order ?? index + 1),
          step.action,
          step.expectedResult,
          step.data ?? '',
        ]),
      ),
    ]);
  }
}

export class AzureCsvTestPlanExporter implements TestPlanExporter {
  public readonly id = 'azure';
  public readonly mediaType = 'text/csv';
  public readonly extension = 'csv';

  public export({ plans, options }: TestPlanExportRequest): string {
    const rows: string[][] = [
      [
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
      ],
    ];
    for (const plan of plans) {
      rows.push([
        '',
        'Test Case',
        plan.title,
        plan.description,
        '',
        '',
        '',
        options?.areaPath ?? '',
        options?.assignedTo ?? '',
        'Design',
      ]);
      for (const [index, step] of plan.steps.entries()) {
        rows.push([
          '',
          '',
          '',
          '',
          String(index + 1),
          step.data?.trim() ? `${step.action}\n\nDados: ${step.data}` : step.action,
          step.expectedResult,
          '',
          '',
          '',
        ]);
      }
    }
    return serializeRows(rows);
  }
}

export function serializeStandardTestPlanCsv(plans: readonly TestPlan[]): string {
  return new StandardCsvTestPlanExporter().export({ plans });
}

export function serializeAzureTestPlanCsv(
  plans: readonly TestPlan[],
  options?: { areaPath?: string; assignedTo?: string },
): string {
  return new AzureCsvTestPlanExporter().export({ plans, options });
}

export function serializeTestPlanCsv(
  testPlanOrPlans: TestPlan | readonly TestPlan[],
  options?: { platform?: string; areaPath?: string; assignedTo?: string },
): string {
  const plans = Array.isArray(testPlanOrPlans) ? testPlanOrPlans : [testPlanOrPlans];
  return options?.platform === 'azure' || options?.areaPath || options?.assignedTo
    ? serializeAzureTestPlanCsv(plans, options)
    : serializeStandardTestPlanCsv(plans);
}

function escapeCsvValue(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}
