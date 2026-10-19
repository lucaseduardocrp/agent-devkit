import { ApplicationError } from '../../../shared/errors.js';
import type {
  PublishableTestSuite,
  PublishedTestSuite,
  RemoteTestPlan,
  RemoteTestSuite,
  TestSuiteDestinationProvider,
} from '../application/publish-test-suite.js';
import type { TestPlan } from '../domain/test-plan.js';
import {
  resolveFieldMapping,
  type FieldDefinition,
  type FieldValue,
  type FieldMappingTemplate,
} from '../../field-mapping/field-mapping.js';

interface AzureReference {
  readonly id?: number;
  readonly rootSuite?: { readonly id?: number };
  readonly suiteType?: string;
}

const escapeXml = (value: string): string =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');

export function azureTestSteps(testCase: TestPlan): string {
  return `<steps id="0" last="${testCase.steps.length}">${testCase.steps
    .map(
      (step, index) =>
        `<step id="${index + 1}" type="ActionStep"><parameterizedString isformatted="true">${escapeXml(step.action)}${step.data ? `&lt;br/&gt;${escapeXml(step.data)}` : ''}</parameterizedString><parameterizedString isformatted="true">${escapeXml(step.expectedResult)}</parameterizedString><description/></step>`,
    )
    .join('')}</steps>`;
}

export class AzureTestSuitePublisher implements TestSuiteDestinationProvider {
  public constructor(
    private readonly baseUrl: string,
    private readonly project: string,
    private readonly token: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  private async requestPage<T>(
    path: string,
    method: 'GET' | 'POST' | 'PATCH',
    body?: unknown,
    patch = false,
    query: Readonly<Record<string, string>> = {},
  ): Promise<{ readonly data: T; readonly continuationToken?: string }> {
    let response: Response;
    try {
      const url = new URL(`${this.baseUrl}/${encodeURIComponent(this.project)}/_apis/${path}`);
      url.searchParams.set('api-version', '7.1');
      for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
      response = await this.fetcher(url, {
        method,
        headers: {
          authorization:
            this.token.startsWith('Basic ') || this.token.startsWith('Bearer ')
              ? this.token
              : `Basic ${Buffer.from(`:${this.token}`).toString('base64')}`,
          accept: 'application/json',
          ...(body === undefined
            ? {}
            : { 'content-type': patch ? 'application/json-patch+json' : 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      throw new ApplicationError(
        'TEST_SUITE_PUBLISH_FAILED',
        'Falha de comunicação com o provedor de testes.',
        502,
        [{ stage: path }],
      );
    }
    if (!response.ok || response.status === 203)
      throw new ApplicationError(
        'TEST_SUITE_PUBLISH_FAILED',
        `Falha ao publicar no Azure DevOps (HTTP ${response.status}).`,
        502,
        [{ stage: path, status: response.status }],
      );
    if (response.status === 204) return { data: {} as T };
    try {
      return {
        data: (await response.json()) as T,
        continuationToken: response.headers?.get('x-ms-continuationtoken') || undefined,
      };
    } catch {
      throw new ApplicationError(
        'TEST_SUITE_PUBLISH_FAILED',
        'Resposta inválida do Azure DevOps.',
        502,
        [{ stage: path }],
      );
    }
  }

  private async request(
    path: string,
    method: 'GET' | 'POST' | 'PATCH',
    body?: unknown,
    patch = false,
  ): Promise<AzureReference> {
    return (await this.requestPage<AzureReference>(path, method, body, patch)).data;
  }

  private async listAll<T>(path: string): Promise<readonly T[]> {
    const items: T[] = [];
    const tokens = new Set<string>();
    let continuationToken: string | undefined;
    do {
      const page = await this.requestPage<{ value?: T[] }>(
        path,
        'GET',
        undefined,
        false,
        continuationToken ? { continuationToken } : {},
      );
      if (!Array.isArray(page.data?.value))
        throw new ApplicationError(
          'TEST_SUITE_PUBLISH_FAILED',
          'O provedor retornou uma lista inválida.',
          502,
        );
      items.push(...page.data.value);
      continuationToken = page.continuationToken;
      if (continuationToken) {
        if (tokens.has(continuationToken) || tokens.size >= 1000)
          throw new ApplicationError(
            'TEST_SUITE_PUBLISH_FAILED',
            'A paginação do provedor não avançou.',
            502,
          );
        tokens.add(continuationToken);
      }
    } while (continuationToken);
    return items;
  }

  public async listPlans(): Promise<readonly RemoteTestPlan[]> {
    const items = await this.listAll<{ id?: number; name?: string }>('testplan/plans');
    return items
      .filter(
        (item): item is { id: number; name: string } =>
          Number.isSafeInteger(item.id) && typeof item.name === 'string',
      )
      .map((item) => ({ id: String(item.id), name: item.name }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  public async listSuites(remotePlanId: string): Promise<readonly RemoteTestSuite[]> {
    const planId = this.parseId(remotePlanId);
    const items = await this.listAll<{
      id?: number;
      name?: string;
      parentSuite?: { id?: number };
      suiteType?: string;
    }>(`testplan/Plans/${planId}/suites`);
    return items
      .filter(
        (item): item is typeof item & { id: number; name: string } =>
          Number.isSafeInteger(item.id) && typeof item.name === 'string',
      )
      .map((item) => ({
        id: String(item.id),
        name: item.name,
        ...(Number.isSafeInteger(item.parentSuite?.id)
          ? { parentId: String(item.parentSuite!.id) }
          : {}),
        suiteType: item.suiteType ?? 'unknown',
      }));
  }

  public async listCaseFields(): Promise<readonly FieldDefinition[]> {
    const [type, catalog] = await Promise.all([
      // Azure only returns picklist values for this endpoint when they are expanded.
      this.requestPage<{
        value?: {
          name: string;
          referenceName: string;
          alwaysRequired?: boolean;
          allowedValues?: string[];
        }[];
      }>('wit/workitemtypes/Test%20Case/fields', 'GET', undefined, false, {
        $expand: 'allowedValues',
      }),
      this.requestPage<{ value?: { referenceName: string; type?: string; readOnly?: boolean }[] }>(
        'wit/fields',
        'GET',
      ),
    ]);
    const details = new Map(
      (catalog.data.value ?? []).map((field) => [field.referenceName, field]),
    );
    const core = new Set(['System.Title', 'System.Description', 'Microsoft.VSTS.TCM.Steps']);
    return (type.data.value ?? [])
      .filter((field) => !core.has(field.referenceName))
      .map((field): FieldDefinition => {
        const info = details.get(field.referenceName);
        const typeName = info?.type?.toLowerCase() ?? '';
        return {
          id: field.referenceName,
          name: field.name,
          type: field.allowedValues?.length
            ? 'single_select'
            : ['integer', 'double', 'number'].includes(typeName)
              ? 'number'
              : typeName === 'boolean'
                ? 'boolean'
                : typeName === 'datetime'
                  ? 'date'
                  : 'text',
          required: field.alwaysRequired ?? false,
          readOnly: info?.readOnly ?? false,
          ...(field.allowedValues?.length
            ? { options: field.allowedValues.map((name) => ({ id: name, name })) }
            : {}),
        };
      });
  }

  private parseId(id: string): number {
    const value = Number(id);
    if (!/^[1-9]\d*$/.test(id) || !Number.isSafeInteger(value))
      throw new ApplicationError('INVALID_REMOTE_PLAN_ID', 'Identificador remoto inválido.', 400);
    return value;
  }

  private requireId(value: AzureReference, stage: string): number {
    if (!Number.isSafeInteger(value.id) || !value.id || value.id < 1)
      throw new ApplicationError(
        'TEST_SUITE_PUBLISH_FAILED',
        'O Azure DevOps não retornou um identificador válido.',
        502,
        [{ stage }],
      );
    return value.id;
  }

  public async publish(
    suite: PublishableTestSuite,
    options: {
      readonly remotePlanId?: string;
      readonly remoteParentSuiteId?: string;
      readonly remoteSuiteId?: string;
      readonly remoteSuiteName?: string;
      readonly fieldTemplate?: FieldMappingTemplate;
    },
  ): Promise<PublishedTestSuite> {
    if (
      options.fieldTemplate &&
      (options.fieldTemplate.providerId !== 'azure_devops' ||
        options.fieldTemplate.entityType !== 'test_case' ||
        (options.fieldTemplate.scope && options.fieldTemplate.scope !== this.project) ||
        (options.fieldTemplate.itemType && options.fieldTemplate.itemType !== 'Test Case'))
    )
      throw new ApplicationError(
        'FIELD_MAPPING_INVALID',
        'Template does not match Azure Test Cases in this project.',
        400,
      );
    const mapped = new Map<TestPlan, Record<string, FieldValue>>();
    if (options.fieldTemplate) {
      const fields = await this.listCaseFields();
      const collect = (node: PublishableTestSuite): void => {
        for (const testCase of node.cases)
          mapped.set(testCase, resolveFieldMapping(testCase, options.fieldTemplate!, fields));
        for (const child of node.children) collect(child);
      };
      collect(suite);
    }
    if ((options.remoteParentSuiteId || options.remoteSuiteId) && !options.remotePlanId)
      throw new ApplicationError(
        'INVALID_REMOTE_SUITE_ID',
        'Selecione um Test Plan para a suite de destino.',
        400,
      );
    if (options.remoteParentSuiteId && options.remoteSuiteId)
      throw new ApplicationError(
        'INVALID_REMOTE_SUITE_ID',
        'Escolha apenas um destino para a suite.',
        400,
      );
    const remotePlanId = options.remotePlanId
      ? this.parseId(options.remotePlanId)
      : this.requireId(
          await this.request('testplan/plans', 'POST', { name: suite.name }),
          'create-plan',
        );
    const plan = await this.request(`testplan/plans/${remotePlanId}`, 'GET');
    const rootId = plan.rootSuite?.id;
    if (!Number.isSafeInteger(rootId) || !rootId || rootId < 1)
      throw new ApplicationError(
        'TEST_SUITE_PUBLISH_FAILED',
        'O Test Plan remoto não possui uma suíte raiz válida.',
        502,
      );

    let parentId = rootId;
    const destinationId = options.remoteParentSuiteId ?? options.remoteSuiteId;
    if (destinationId) {
      parentId = this.parseId(destinationId);
      const remoteDestination = await this.request(
        `testplan/Plans/${remotePlanId}/suites/${parentId}`,
        'GET',
      );
      if (remoteDestination.id !== parentId)
        throw new ApplicationError(
          'INVALID_REMOTE_SUITE_ID',
          'A suite de destino não pertence ao Test Plan escolhido.',
          400,
        );
      const acceptedTypes = options.remoteSuiteId
        ? ['staticTestSuite', 'requirementTestSuite']
        : ['staticTestSuite'];
      if (remoteDestination.suiteType && !acceptedTypes.includes(remoteDestination.suiteType))
        throw new ApplicationError(
          'INVALID_REMOTE_SUITE_ID',
          options.remoteSuiteId
            ? 'A suite de destino não aceita inclusão manual de test cases.'
            : 'Escolha uma suite estática como destino.',
          400,
        );
    }

    let suitesCount = 0;
    let casesCount = 0;
    const caseLinks: Record<string, string> = {};
    const caseLocations: Record<string, { planId: string; suiteId: string }> = {};
    const publishCases = async (node: PublishableTestSuite, suiteId: number): Promise<void> => {
      for (const testCase of node.cases) {
        const changes = [
          { op: 'add', path: '/fields/System.Title', value: testCase.title },
          { op: 'add', path: '/fields/System.Description', value: testCase.description },
          { op: 'add', path: '/fields/Microsoft.VSTS.TCM.Steps', value: azureTestSteps(testCase) },
          ...Object.entries(mapped.get(testCase) ?? {}).map(([id, value]) => ({
            op: 'add',
            path: `/fields/${id}`,
            value,
          })),
        ];
        const existing = (
          testCase.metadata?.['remoteCaseIds'] as Record<string, unknown> | undefined
        )?.['azure_devops'];
        const existingId =
          typeof existing === 'string' && /^[1-9]\d*$/.test(existing) ? existing : null;
        const caseId = this.requireId(
          await this.request(
            existingId ? `wit/workitems/${existingId}` : 'wit/workitems/$Test%20Case',
            existingId ? 'PATCH' : 'POST',
            changes,
            true,
          ),
          existingId ? 'update-case' : 'create-case',
        );
        const originalLocation = (
          testCase.metadata?.['remoteCaseLocations'] as
            Record<string, { planId?: string; suiteId?: string }> | undefined
        )?.['azure_devops'];
        if (
          !existingId ||
          originalLocation?.planId !== String(remotePlanId) ||
          originalLocation?.suiteId !== String(suiteId)
        )
          await this.request(
            `test/Plans/${remotePlanId}/suites/${suiteId}/testcases/${caseId}`,
            'POST',
          );
        const localId = testCase.metadata?.['caseId'];
        if (typeof localId === 'string') {
          caseLinks[localId] = String(caseId);
          caseLocations[localId] = { planId: String(remotePlanId), suiteId: String(suiteId) };
        }
        casesCount++;
      }
    };
    if (options.remoteSuiteId) {
      const publishAllCases = async (node: PublishableTestSuite): Promise<void> => {
        await publishCases(node, parentId);
        for (const child of node.children) await publishAllCases(child);
      };
      await publishAllCases(suite);
      return {
        provider: 'azure_devops',
        remotePlanId: String(remotePlanId),
        remoteSuiteId: String(parentId),
        remoteUrl: `${this.baseUrl}/${encodeURIComponent(this.project)}/_testPlans/define?planId=${remotePlanId}&suiteId=${parentId}`,
        suitesCount,
        casesCount,
        caseLinks,
        caseLocations,
      };
    }
    const publishNode = async (node: PublishableTestSuite, parentId: number): Promise<number> => {
      const suiteId = this.requireId(
        await this.request(`testplan/Plans/${remotePlanId}/suites`, 'POST', {
          suiteType: 'staticTestSuite',
          name: node === suite ? (options.remoteSuiteName ?? node.name) : node.name,
          parentSuite: { id: parentId },
        }),
        'create-suite',
      );
      suitesCount++;
      await publishCases(node, suiteId);
      for (const child of node.children) await publishNode(child, suiteId);
      return suiteId;
    };
    const remoteSuiteId = await publishNode(suite, parentId);
    return {
      provider: 'azure_devops',
      remotePlanId: String(remotePlanId),
      remoteSuiteId: String(remoteSuiteId),
      remoteUrl: `${this.baseUrl}/${encodeURIComponent(this.project)}/_testPlans/define?planId=${remotePlanId}&suiteId=${remoteSuiteId}`,
      suitesCount,
      casesCount,
      caseLinks,
      caseLocations,
    };
  }
}
