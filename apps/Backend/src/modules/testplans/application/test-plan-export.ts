import type { TestPlan } from '../domain/test-plan.js';

export interface TestPlanExportRequest {
  readonly plans: readonly TestPlan[];
  readonly options?: Readonly<Record<string, string | undefined>>;
}

export interface TestPlanExporter {
  readonly id: string;
  readonly mediaType: string;
  readonly extension: string;
  export(request: TestPlanExportRequest): string;
}

export class TestPlanExporterRegistry {
  private readonly exporters = new Map<string, TestPlanExporter>();

  public constructor(exporters: readonly TestPlanExporter[]) {
    for (const exporter of exporters) this.exporters.set(exporter.id, exporter);
  }

  public export(id: string, request: TestPlanExportRequest): string {
    const exporter = this.exporters.get(id);
    if (!exporter) throw new Error(`Unsupported Test Plan export format: ${id}`);
    return exporter.export(request);
  }
}
