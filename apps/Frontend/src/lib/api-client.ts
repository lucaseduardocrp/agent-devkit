import type { AuthResponse, UserProfile } from '../features/auth/auth-types.js';
import type {
  ModuleAccessMap,
  PermissionGroup,
  UserWorkspaceMembership,
  Workspace,
  WorkspaceMember,
  WorkspaceRole,
  WorkspacePermissions,
} from '../features/workspaces/workspace-types.js';
import type {
  CustomAgentDto,
  CreateAgentDto,
  UpdateAgentDto,
  ExecuteAgentDto,
  ExecuteAgentResponse,
  AgentWorkflowDto,
  HubAgentCatalogDto,
} from '../features/agents/agent-types.js';
import type { SupportedLocale } from './i18n/types.js';
import type {
  ApiCollection,
  ApiCollectionSummary,
  ApiEnvironment,
  ApiMockValue,
  ApiRun,
  ApiRunTarget,
  ExportFormat,
  GenerationRequest,
  LoadProfileDefaults,
  LoadScenario,
  LoadScenarioInput,
} from '../features/apitests/api-test-types.js';
import type {
  Issue,
  IssueChanges,
  IssueComment,
  InboxItem,
  DashboardSummary,
  AgentRun,
  CostRate,
  CostSummary,
} from '../features/issues/issue-types.js';
import type {
  PbiFields,
  PbiComment,
  PbiItem,
  PbiProvider,
  PbiProviderId,
  PbiPullResult,
  PbiPushContract,
  PbiRelation,
  PbiLinkType,
} from '../features/pbi/pbi-types.js';
import type { Attachment, AttachmentScope } from '../features/shared/attachment-types.js';
import type {
  GenerateReleaseNoteFields,
  ReleaseNote,
  ReleaseNoteExportFormat,
  ReleaseNoteFields,
} from '../features/release-notes/release-note-types.js';
import type {
  E2eCreationDetail,
  E2eCreationInput,
  E2eCreationSummary,
  E2eExecutionTarget,
  E2eLocalRunner,
  E2eTestDetail,
  E2eBranch,
  E2ePullResult,
  E2eRepository,
  E2eRepositoryProvider,
  E2eRepositoryWarning,
  E2eScript,
  E2eCreationView,
  E2eImportCasesInput,
  E2eImportResult,
  E2eReportingInput,
  ExternalCaseRef,
  ExternalTestCase,
  RemoteContainer,
  TestManagementProvider,
  TestManagementProviderId,
} from '../features/e2e/e2e-types.js';
import { ptBR } from './i18n/locales/pt-BR.js';
import { enUS } from './i18n/locales/en-US.js';
import type {
  FieldDefinition,
  FieldMappingTemplate,
  FieldMappingTemplateInput,
  FieldValue,
} from '../features/field-mapping/types.js';

/** What this ADK install can do (GET /capabilities). */
export interface ServerCapabilities {
  /** A local install: runs on the ADK workers reach http://localhost on the user's computer. */
  readonly workersReachLocalhost: boolean;
}

export interface HealthResponse {
  readonly status: 'ok';
  readonly requestId: string;
}
export interface ReadinessCheck {
  readonly name: string;
  readonly status: 'ready' | 'not-ready';
}

export interface ReadinessResponse {
  readonly status: 'ready' | 'not-ready';
  readonly checks: readonly ReadinessCheck[];
}

export interface KnowledgeChunkDto {
  readonly source: string;
  readonly pageId: string;
  readonly chunkIndex: number;
  readonly content: string;
  readonly createdAt: string;
}

export interface KnowledgeSyncResultDto {
  readonly success: boolean;
  readonly provider: string;
  readonly chunksCount: number;
  readonly archived?: readonly {
    readonly pageId: string;
    readonly oldSource: string;
    readonly newSource: string;
  }[];
}

export interface KnowledgeStatsDto {
  readonly documentsCount: number;
  readonly chunksCount: number;
}

export interface KnowledgeDocumentDto {
  readonly id: string;
  readonly pageId: string;
  readonly source: string;
  readonly title: string;
  readonly content?: string;
  readonly chunksCount: number;
  readonly totalCharacters: number;
  readonly updatedAt: string;
  readonly isCustom?: boolean;
  readonly parentPageId?: string;
  readonly pagePath?: string;
}

export interface KnowledgePushProviderDto {
  readonly providerId: string;
  readonly name: string;
  readonly settings: Record<string, unknown>;
}

export interface KnowledgePushDestinationDto {
  readonly id: string;
  readonly label: string;
}

export interface KnowledgePushInput {
  readonly providerId: string;
  readonly destination: {
    readonly parentPath?: string;
    readonly wikiIdentifier?: string;
    readonly listId?: string;
    readonly parentExternalId?: string;
    readonly issueType?: string;
    readonly externalId?: string;
  };
}

export type AccessTokenScope = 'full' | 'read';

/** Personal access token metadata; the secret is only returned once, at creation. */
export interface AccessTokenDto {
  readonly id: string;
  readonly name: string;
  readonly tokenPrefix: string;
  readonly scope: AccessTokenScope;
  readonly expiresAt: string | null;
  readonly lastUsedAt: string | null;
  readonly createdAt: string;
}

export interface CreatedAccessTokenDto {
  readonly token: string;
  readonly accessToken: AccessTokenDto;
}

export interface KnowledgeRelationDto {
  readonly sourcePageId: string;
  readonly targetPageId: string;
  readonly createdAt: string;
}

export type IntegrationCategory = 'KNOWLEDGE' | 'LLM' | 'PROJECT_MANAGEMENT' | 'CI_CD';

export interface UserIntegrationDto {
  readonly id: string;
  readonly category: IntegrationCategory;
  readonly providerId: string;
  readonly isEnabled: boolean;
  readonly settings: Record<string, unknown>;
  readonly hasSecret: boolean;
  readonly maskedSecret: string | null;
  readonly updatedAt: string;
}

export interface ConnectivityProbeDto {
  readonly ok: boolean;
  readonly message: string;
}

export interface AzureDevOpsMemberDto {
  readonly id: string;
  readonly displayName: string;
  readonly email: string;
  readonly avatarUrl?: string;
}

export interface AzureDevOpsProjectMembersResponse {
  readonly areaPaths?: readonly string[];
  readonly states?: readonly string[];
  readonly configured: boolean;
  readonly organization: string | null;
  readonly project: string | null;
  readonly members: readonly AzureDevOpsMemberDto[];
}

export interface GeneratedTestStepDto {
  readonly order?: number;
  readonly action: string;
  readonly expectedResult: string;
  readonly data?: string;
}

export interface GeneratedTestPlanDto {
  readonly title: string;
  readonly description: string;
  readonly steps: readonly GeneratedTestStepDto[];
  readonly metadata?: Record<string, unknown>;
}

export interface GenerateTestPlanResponse {
  readonly plans: readonly GeneratedTestPlanDto[];
  readonly csv: string;
  readonly savedPlan?: SavedTestPlanDto;
}

export interface SavedTestPlanDto {
  readonly id: string;
  readonly workspaceId: string;
  readonly title: string;
  readonly assignedTo?: string;
  readonly suiteId?: string | null;
  /** `test_management` marks a Test Plan imported from Azure DevOps, TestRail or Xray. */
  readonly sourceType?: 'manual' | 'brain' | 'spec' | 'pbi' | 'test_management';
  readonly sourceId?: string;
  readonly plans: readonly GeneratedTestPlanDto[];
  readonly createdAt: string;
  readonly updatedAt: string;
}
export interface ImportTestCasesInput {
  readonly providerId: string;
  readonly planId: string;
  /** Only this remote suite; the whole plan when omitted. */
  readonly suiteId?: string;
  readonly includeChildSuites?: boolean;
  /** Local suite that receives the import; one named after the plan when omitted. */
  readonly localSuiteId?: string;
  readonly caseIds?: readonly string[];
}

export interface ImportTestCasesResultDto {
  readonly rootSuiteId: string;
  readonly suitesCreated: number;
  readonly plans: readonly SavedTestPlanDto[];
  readonly created: number;
  readonly updated: number;
}

export interface TestSuiteDto {
  readonly id: string;
  readonly workspaceId: string;
  readonly parentId?: string;
  readonly name: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface PublishedTestSuiteDto {
  readonly provider: string;
  readonly remotePlanId: string;
  readonly remoteSuiteId: string;
  readonly remoteUrl: string;
  readonly suitesCount: number;
  readonly casesCount: number;
  /** The work items the cases were linked to, when any were given. */
  readonly workItems?: readonly {
    readonly id: string;
    readonly type: string;
    readonly title: string;
  }[];
  /** Kind of the suite created; absent when the cases went into an existing suite. */
  readonly suiteKind?: RemoteSuiteKind;
}

/** Azure DevOps suite kinds: a requirement suite belongs to a work item. */
export type RemoteSuiteKind = 'static' | 'requirement';

export interface TestSuiteProviderDto {
  readonly id: string;
  readonly name: string;
  readonly configured: boolean;
}

export interface RemoteTestPlanDto {
  readonly id: string;
  readonly name: string;
}

export interface RemoteTestSuiteDto {
  readonly id: string;
  readonly name: string;
  readonly parentId?: string;
  readonly suiteType: string;
}

export interface PublishTestSuiteInput {
  readonly providerId: string;
  readonly remotePlanId?: string;
  readonly remoteParentSuiteId?: string;
  readonly remoteSuiteId?: string;
  readonly remoteSuiteName?: string;
  /** Kind of the suite created (Azure DevOps); requirement suites need workItemIds. */
  readonly suiteKind?: RemoteSuiteKind;
  /** Remote work items the published cases test (PBI, bug, task...). */
  readonly workItemIds?: readonly string[];
  readonly templateId?: string;
  /** Values filled in for template fields, keyed by destination field. */
  readonly fieldValues?: Readonly<Record<string, FieldValue>>;
}

export interface SavedTestPlansPageDto {
  readonly items: readonly SavedTestPlanDto[];
  readonly page: number;
  readonly pageSize: number;
  readonly total: number;
  readonly totalPages: number;
}

export interface GenerateTestPlanOptions {
  readonly title?: string;
  readonly criteria?: string;
  readonly userPrompt?: string;
  readonly areaPath?: string;
  readonly assignedTo?: string;
  readonly platformProvider?: string;
  readonly llmProvider?: string;
  readonly format?: 'azure' | 'standard';
  readonly workspaceId?: string;
  readonly agentId?: string;
  readonly sourceType?: 'manual' | 'brain' | 'spec' | 'pbi';
  readonly sourceId?: string;
  readonly suiteId?: string | null;
  readonly signal?: AbortSignal;
}

export interface SpecTemplateSectionDto {
  readonly id: string;
  readonly title: string;
  readonly guidance?: string;
  readonly required: boolean;
}
export interface SpecTemplateDto {
  readonly id: string;
  readonly workspaceId: string;
  readonly name: string;
  readonly sections: readonly SpecTemplateSectionDto[];
  readonly createdAt: string;
  readonly updatedAt: string;
}
export interface SpecificationSectionDto {
  readonly templateSectionId: string;
  readonly title: string;
  readonly content: string;
}
export interface SpecMessageDto {
  readonly id: string;
  readonly role: 'user' | 'assistant';
  readonly content: string;
  readonly createdAt: string;
}
export interface SpecificationDto {
  readonly id: string;
  readonly workspaceId: string;
  readonly templateId?: string;
  readonly agentId?: string;
  readonly parentId?: string;
  readonly title: string;
  readonly sections: readonly SpecificationSectionDto[];
  readonly messages: readonly SpecMessageDto[];
  readonly attachments?: readonly Attachment[];
  readonly proposal?: {
    readonly title?: string;
    readonly sections: readonly { templateSectionId: string; content: string }[];
  };
  readonly createdAt: string;
  readonly updatedAt: string;
}

export class ApiClientError extends Error {
  public constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiClientError';
  }
}

const EMPTY_AGENT_WORKFLOW: AgentWorkflowDto = {
  enabled: false,
  autonomy: 'balanced',
  finalReview: true,
  uncertaintyBehavior: 'ask',
  issueCreationBehavior: 'ask',
  defaultAction: 'allow',
  steps: [],
  rules: [],
};

const AGENT_WORKFLOW_TOOLSETS = new Set([
  'all',
  'agents',
  'integrations',
  'brain',
  'issues',
  'pbi',
  'spec',
  'testplans',
  'design',
  'e2e',
  'releasenotes',
  'integrationtests',
  'loadtests',
  'audit',
  'workspaces',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeAgentWorkflow(
  raw: unknown,
  fallback: AgentWorkflowDto = EMPTY_AGENT_WORKFLOW,
): AgentWorkflowDto {
  const value = isRecord(raw) ? raw : {};
  const steps = Array.isArray(value['steps'])
    ? value['steps'].filter(
        (step): step is AgentWorkflowDto['steps'][number] =>
          isRecord(step) &&
          typeof step['id'] === 'string' &&
          typeof step['name'] === 'string' &&
          typeof step['instructions'] === 'string',
      )
    : fallback.steps;
  const rules = Array.isArray(value['rules'])
    ? value['rules'].flatMap((rule): AgentWorkflowDto['rules'][number][] => {
        if (
          !isRecord(rule) ||
          typeof rule['id'] !== 'string' ||
          typeof rule['name'] !== 'string' ||
          typeof rule['toolset'] !== 'string' ||
          !AGENT_WORKFLOW_TOOLSETS.has(rule['toolset']) ||
          (rule['effect'] !== 'allow' && rule['effect'] !== 'deny') ||
          (rule['allowedProviders'] !== undefined &&
            (!Array.isArray(rule['allowedProviders']) ||
              !rule['allowedProviders'].every((provider) => typeof provider === 'string')))
        )
          return [];
        const allowedProviders = rule['allowedProviders'];
        return [
          {
            id: rule['id'],
            name: rule['name'],
            toolset: rule['toolset'] as AgentWorkflowDto['rules'][number]['toolset'],
            effect: rule['effect'],
            ...(typeof rule['toolName'] === 'string' ? { toolName: rule['toolName'] } : {}),
            ...(allowedProviders ? { allowedProviders } : {}),
            ...(typeof rule['createIssueForAction'] === 'boolean'
              ? { createIssueForAction: rule['createIssueForAction'] }
              : {}),
            ...(typeof rule['requireApproval'] === 'boolean'
              ? { requireApproval: rule['requireApproval'] }
              : {}),
          },
        ];
      })
    : fallback.rules;

  return {
    enabled: typeof value['enabled'] === 'boolean' ? value['enabled'] : fallback.enabled,
    autonomy:
      value['autonomy'] === 'supervised' ||
      value['autonomy'] === 'balanced' ||
      value['autonomy'] === 'autonomous'
        ? value['autonomy']
        : fallback.autonomy,
    finalReview:
      typeof value['finalReview'] === 'boolean' ? value['finalReview'] : fallback.finalReview,
    uncertaintyBehavior:
      value['uncertaintyBehavior'] === 'ask' || value['uncertaintyBehavior'] === 'assume'
        ? value['uncertaintyBehavior']
        : fallback.uncertaintyBehavior,
    issueCreationBehavior:
      value['issueCreationBehavior'] === 'ask' || value['issueCreationBehavior'] === 'allow'
        ? value['issueCreationBehavior']
        : fallback.issueCreationBehavior,
    defaultAction:
      value['defaultAction'] === 'allow' || value['defaultAction'] === 'deny'
        ? value['defaultAction']
        : fallback.defaultAction,
    steps,
    rules,
    ...(typeof value['updatedAt'] === 'string'
      ? { updatedAt: value['updatedAt'] }
      : fallback.updatedAt
        ? { updatedAt: fallback.updatedAt }
        : {}),
  };
}

export interface ApiClientOptions {
  readonly baseUrl?: string;
  readonly fetcher?: typeof fetch;
  readonly token?: string | null;
  readonly workspaceId?: string | null;
  readonly locale?: SupportedLocale;
}

const defaultFetch: typeof fetch = (input, init) => globalThis.fetch(input, init);

export type AuditEntityType =
  | 'document'
  | 'specification'
  | 'template'
  | 'testplan'
  /** One case of a test plan; the entity ID is `<planId>:<caseId>`. */
  | 'testcase'
  | 'pbi'
  | 'issue'
  | 'release_note';

export interface PermissionGroupInput {
  readonly name?: string;
  readonly description?: string;
  readonly modules?: ModuleAccessMap;
  readonly memberIds?: readonly string[];
}
export type AuditSnapshot =
  null | string | number | boolean | AuditSnapshot[] | { [key: string]: AuditSnapshot };
export interface AuditEventDto {
  id: string;
  entityType: AuditEntityType;
  entityId: string;
  action: 'create' | 'update' | 'delete' | 'comment';
  actorId: string | null;
  actorName?: string | null;
  actorEmail?: string | null;
  requestId: string;
  operation: string;
  occurredAt: string;
  before: AuditSnapshot;
  after: AuditSnapshot;
}
export interface AuditHistoryPage {
  items: AuditEventDto[];
  total: number;
  page: number;
  totalPages: number;
}

export interface DesignFileDto {
  readonly name: string;
  readonly language: string;
  readonly content: string;
}
export interface DesignMessageDto {
  readonly role: 'user' | 'assistant';
  readonly content: string;
  readonly createdAt: string;
  readonly images?: readonly DesignImageInput[];
}
export interface DesignProjectDto {
  readonly id: string;
  readonly provider: 'github' | 'azure';
  readonly agentId: string;
  readonly title: string;
  readonly files: readonly DesignFileDto[];
  readonly messages: readonly DesignMessageDto[];
  readonly updatedAt: string;
}
export interface DesignSystemDto {
  readonly id: string;
  readonly name: string;
  readonly content: string;
  readonly updatedAt: string;
}

export interface DesignImageInput {
  readonly mimeType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';
  readonly data: string;
}

export class ApiClient {
  private async issueRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await this.fetchWithAuth(`${this.baseUrl}${path}`, init);
    if (!response.ok) return this.handleErrorResponse(response);
    return response.json() as Promise<T>;
  }

  public async getIssues(signal?: AbortSignal): Promise<readonly Issue[]> {
    return (await this.issueRequest<{ issues: Issue[] }>('/issues', { signal })).issues;
  }

  public async getReleaseNotes(signal?: AbortSignal): Promise<ReleaseNote[]> {
    return (await this.issueRequest<{ releaseNotes: ReleaseNote[] }>('/release-notes', { signal }))
      .releaseNotes;
  }
  public async createReleaseNote(fields: ReleaseNoteFields): Promise<ReleaseNote> {
    return (
      await this.issueRequest<{ releaseNote: ReleaseNote }>('/release-notes', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(fields),
      })
    ).releaseNote;
  }
  public async generateReleaseNote(fields: GenerateReleaseNoteFields): Promise<ReleaseNote> {
    return (
      await this.issueRequest<{ releaseNote: ReleaseNote }>('/release-notes/generate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(fields),
      })
    ).releaseNote;
  }
  public async updateReleaseNote(
    id: string,
    fields: Partial<ReleaseNoteFields>,
  ): Promise<ReleaseNote> {
    return (
      await this.issueRequest<{ releaseNote: ReleaseNote }>(
        `/release-notes/${encodeURIComponent(id)}`,
        {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(fields),
        },
      )
    ).releaseNote;
  }
  public async deleteReleaseNote(id: string): Promise<void> {
    const response = await this.fetchWithAuth(
      `${this.baseUrl}/release-notes/${encodeURIComponent(id)}`,
      { method: 'DELETE' },
    );
    if (!response.ok) return this.handleErrorResponse(response);
  }
  /** Downloads an export; the file name comes from the server's Content-Disposition. */
  public async exportReleaseNote(
    id: string,
    format: ReleaseNoteExportFormat,
  ): Promise<{ blob: Blob; fileName: string | null }> {
    const response = await this.fetchWithAuth(
      `${this.baseUrl}/release-notes/${encodeURIComponent(id)}/export?format=${format}`,
    );
    if (!response.ok) return this.handleErrorResponse(response);
    const disposition = response.headers.get('content-disposition') ?? '';
    const encoded = /filename*=UTF-8''([^;]+)/i.exec(disposition)?.[1];
    const plain = /filename="([^"]+)"/i.exec(disposition)?.[1];
    return {
      blob: await response.blob(),
      fileName: encoded ? decodeURIComponent(encoded) : (plain ?? null),
    };
  }

  /** Every item for the list, without its detail fields: see {@link PbiItem.partial}. */
  public async getPbiItems(signal?: AbortSignal): Promise<PbiItem[]> {
    const { items } = await this.issueRequest<{
      items: (Omit<PbiItem, 'description' | 'attachments' | 'partial'> & {
        descriptionExcerpt: string;
      })[];
    }>('/pbi?view=summary', { signal });
    return items.map(({ descriptionExcerpt, ...item }) => ({
      ...item,
      description: descriptionExcerpt,
      partial: true,
    }));
  }
  /** One item with every field. */
  public async getPbiItem(id: string, signal?: AbortSignal): Promise<PbiItem> {
    return (
      await this.issueRequest<{ item: PbiItem }>(`/pbi/items/${encodeURIComponent(id)}`, {
        signal,
      })
    ).item;
  }
  /** Uploads a file to the ADK storage; the server checks its real type and size. */
  public async uploadAttachment(scope: AttachmentScope, file: File): Promise<Attachment> {
    const query = new URLSearchParams({ scope, name: file.name || 'file' });
    const response = await this.fetchWithAuth(`${this.baseUrl}/attachments/files?${query}`, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: file,
    });
    if (!response.ok) return this.handleErrorResponse(response);
    return ((await response.json()) as { attachment: Attachment }).attachment;
  }
  /** Removes an upload whose item was not saved; saved files go away with their item. */
  public async deleteAttachment(id: string): Promise<void> {
    const response = await this.fetchWithAuth(
      `${this.baseUrl}/attachments/files/${encodeURIComponent(id)}`,
      { method: 'DELETE' },
    );
    if (!response.ok) return this.handleErrorResponse(response);
  }
  /**
   * Loads a file shown in the ADK: files stored by the ADK by their path, and files hosted
   * by an integration (Azure DevOps, Jira...) through the server, which holds the credentials.
   */
  public async getMedia(src: string, signal?: AbortSignal): Promise<Blob> {
    const path = src.startsWith('/attachments/')
      ? src
      : `/attachments/proxy?url=${encodeURIComponent(src)}`;
    const response = await this.fetchWithAuth(`${this.baseUrl}${path}`, { signal });
    if (!response.ok) return this.handleErrorResponse(response);
    return response.blob();
  }
  public async getDocumentAttachments(pageId: string): Promise<Attachment[]> {
    return (
      await this.issueRequest<{ attachments: Attachment[] }>(
        `/knowledge/documents/${encodeURIComponent(pageId)}/attachments`,
      )
    ).attachments;
  }
  public async saveDocumentAttachments(
    pageId: string,
    attachments: readonly Attachment[],
  ): Promise<Attachment[]> {
    return (
      await this.issueRequest<{ attachments: Attachment[] }>(
        `/knowledge/documents/${encodeURIComponent(pageId)}/attachments`,
        {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ attachments }),
        },
      )
    ).attachments;
  }
  public async getPbiContext(id: string): Promise<{ item: PbiItem; descendants: PbiItem[] }> {
    return this.issueRequest(`/pbi/items/${encodeURIComponent(id)}/context`);
  }
  public async getPbiComments(id: string): Promise<PbiComment[]> {
    return (
      await this.issueRequest<{ comments: PbiComment[] }>(
        `/pbi/items/${encodeURIComponent(id)}/comments`,
      )
    ).comments;
  }
  public async syncPbiChildren(id: string): Promise<PbiItem[]> {
    return (
      await this.issueRequest<{ items: PbiItem[] }>(
        `/pbi/items/${encodeURIComponent(id)}/sync-children`,
        { method: 'POST' },
      )
    ).items;
  }
  public async getPbiProviders(): Promise<PbiProvider[]> {
    return (await this.issueRequest<{ providers: PbiProvider[] }>('/pbi/providers')).providers;
  }
  public async getPbiCurrentIteration(): Promise<string | null> {
    return (await this.issueRequest<{ currentIteration: string | null }>('/pbi/current-iteration'))
      .currentIteration;
  }
  public async getFieldMappingTemplates(
    entityType: 'pbi' | 'test_case',
    providerId: string,
  ): Promise<FieldMappingTemplate[]> {
    const query = new URLSearchParams({ entityType, providerId });
    return (
      await this.issueRequest<{ templates: FieldMappingTemplate[] }>(`/field-mappings?${query}`)
    ).templates;
  }
  public async saveFieldMappingTemplate(
    input: FieldMappingTemplateInput,
    id?: string,
  ): Promise<FieldMappingTemplate> {
    return (
      await this.issueRequest<{ template: FieldMappingTemplate }>(
        id ? `/field-mappings/${encodeURIComponent(id)}` : '/field-mappings',
        {
          method: id ? 'PUT' : 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(input),
        },
      )
    ).template;
  }
  public async deleteFieldMappingTemplate(id: string): Promise<void> {
    const response = await this.fetchWithAuth(
      `${this.baseUrl}/field-mappings/${encodeURIComponent(id)}`,
      { method: 'DELETE' },
    );
    if (!response.ok) return this.handleErrorResponse(response);
  }
  public async getPbiFieldCatalog(
    providerId: PbiProviderId,
    scope = '',
    itemType = '',
  ): Promise<FieldDefinition[]> {
    const query = new URLSearchParams({ providerId, scope, itemType });
    return (await this.issueRequest<{ fields: FieldDefinition[] }>(`/pbi/field-catalog?${query}`))
      .fields;
  }
  public async previewPbiFields(
    id: string,
    providerId: PbiProviderId,
    templateId: string,
    scope = '',
    itemType = '',
  ): Promise<{ definitions: FieldDefinition[]; values: Record<string, FieldValue> }> {
    return this.issueRequest(`/pbi/items/${encodeURIComponent(id)}/field-preview`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ providerId, templateId, scope, itemType }),
    });
  }
  public async pullPbiBoards(): Promise<PbiPullResult> {
    return this.issueRequest('/pbi/pull', { method: 'POST' });
  }
  public async createPbiItem(fields: PbiFields): Promise<PbiItem> {
    return (
      await this.issueRequest<{ item: PbiItem }>('/pbi/items', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(fields),
      })
    ).item;
  }
  public async updatePbiItem(
    id: string,
    fields: Partial<Omit<PbiFields, 'kind'>>,
  ): Promise<PbiItem> {
    return (
      await this.issueRequest<{ item: PbiItem }>(`/pbi/items/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(fields),
      })
    ).item;
  }
  public async deletePbiItem(id: string): Promise<void> {
    const response = await this.fetchWithAuth(
      `${this.baseUrl}/pbi/items/${encodeURIComponent(id)}`,
      { method: 'DELETE' },
    );
    if (!response.ok) return this.handleErrorResponse(response);
  }
  public async getPbiPushContract(
    id: string,
    providerId: PbiProviderId,
    values: Record<string, string> = {},
  ): Promise<PbiPushContract> {
    return (
      await this.issueRequest<{ contract: PbiPushContract }>(
        `/pbi/items/${encodeURIComponent(id)}/push-contract`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ providerId, values }),
        },
      )
    ).contract;
  }
  public async pushPbiItem(
    id: string,
    fields: { providerId: PbiProviderId; fields?: Record<string, string>; templateId?: string },
  ): Promise<{ item: PbiItem; warnings: string[] }> {
    return this.issueRequest(`/pbi/items/${encodeURIComponent(id)}/push`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(fields),
    });
  }
  public async getPbiRelations(id: string): Promise<PbiRelation[]> {
    return (
      await this.issueRequest<{ relations: PbiRelation[] }>(
        `/pbi/items/${encodeURIComponent(id)}/relations`,
      )
    ).relations;
  }
  public async addPbiRelations(
    id: string,
    type: PbiLinkType,
    targetIds: readonly string[],
  ): Promise<PbiRelation[]> {
    return (
      await this.issueRequest<{ relations: PbiRelation[] }>(
        `/pbi/items/${encodeURIComponent(id)}/relations`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ type, targetIds }),
        },
      )
    ).relations;
  }
  public async removePbiRelation(
    id: string,
    type: PbiLinkType,
    targetId: string,
  ): Promise<PbiRelation[]> {
    return (
      await this.issueRequest<{ relations: PbiRelation[] }>(
        `/pbi/items/${encodeURIComponent(id)}/relations/${encodeURIComponent(type)}/${encodeURIComponent(targetId)}`,
        { method: 'DELETE' },
      )
    ).relations;
  }
  public async createIssueFromPbi(id: string): Promise<Issue> {
    return (
      await this.issueRequest<{ issue: Issue }>(`/pbi/items/${encodeURIComponent(id)}/issues`, {
        method: 'POST',
      })
    ).issue;
  }

  public async createIssue(changes: IssueChanges & { title: string }): Promise<Issue> {
    return (
      await this.issueRequest<{ issue: Issue }>('/issues', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(changes),
      })
    ).issue;
  }

  public async getIssue(
    id: string,
    signal?: AbortSignal,
  ): Promise<{ issue: Issue; comments: IssueComment[] }> {
    return this.issueRequest(`/issues/${encodeURIComponent(id)}`, { signal });
  }

  public async updateIssue(id: string, changes: IssueChanges): Promise<Issue> {
    return (
      await this.issueRequest<{ issue: Issue }>(`/issues/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(changes),
      })
    ).issue;
  }

  public async deleteIssue(id: string): Promise<void> {
    const response = await this.fetchWithAuth(`${this.baseUrl}/issues/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
    if (!response.ok) return this.handleErrorResponse(response);
  }

  public async addIssueComment(
    id: string,
    body: string,
  ): Promise<{
    comment: IssueComment;
    run?: AgentRun;
    pending?: boolean;
    automationError?: string;
  }> {
    return this.issueRequest(`/issues/${encodeURIComponent(id)}/comments`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ body }),
    });
  }

  public async getInbox(signal?: AbortSignal): Promise<readonly InboxItem[]> {
    const { items } = await this.issueRequest<{
      items: (Omit<InboxItem, 'runs'> & { runs?: InboxItem['runs'] })[];
    }>('/inbox', { signal });
    // An API older than the private inbox answers without runs.
    return items.map((item) => ({ ...item, runs: item.runs ?? [] }));
  }

  public async updateInboxItem(
    id: string,
    changes: { read?: boolean; archived?: boolean },
  ): Promise<void> {
    await this.issueRequest(`/inbox/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(changes),
    });
  }

  public async getDashboard(signal?: AbortSignal): Promise<DashboardSummary> {
    return this.issueRequest('/dashboard', { signal });
  }
  public async getAgentRuns(issueId?: string): Promise<readonly AgentRun[]> {
    const query = issueId ? `?issueId=${encodeURIComponent(issueId)}` : '';
    return (await this.issueRequest<{ runs: AgentRun[] }>(`/runs${query}`)).runs;
  }
  public async startIssueRun(issueId: string): Promise<AgentRun> {
    return (
      await this.issueRequest<{ run: AgentRun }>(`/issues/${encodeURIComponent(issueId)}/runs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mode: 'server' }),
      })
    ).run;
  }
  public async cancelAgentRun(runId: string): Promise<AgentRun> {
    return (
      await this.issueRequest<{ run: AgentRun }>(`/runs/${encodeURIComponent(runId)}/cancel`, {
        method: 'POST',
      })
    ).run;
  }
  public async continueAgentRun(
    runId: string,
    input: { action: 'approve' | 'answer' | 'revise'; answer?: string },
  ): Promise<AgentRun> {
    return (
      await this.issueRequest<{ run: AgentRun }>(`/runs/${encodeURIComponent(runId)}/continue`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(input),
      })
    ).run;
  }
  public async getCosts(): Promise<CostSummary> {
    return this.issueRequest('/costs');
  }
  public async setMonthlyBudget(monthlyBudgetMicros: number): Promise<CostSummary> {
    return this.issueRequest('/costs/budget', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ monthlyBudgetMicros }),
    });
  }
  public async setCostRate(rate: CostRate): Promise<CostRate> {
    return (
      await this.issueRequest<{ rate: CostRate }>('/costs/rates', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(rate),
      })
    ).rate;
  }
  public async deleteCostRate(provider: string, model: string): Promise<void> {
    const response = await this.fetchWithAuth(
      `${this.baseUrl}/costs/rates/${encodeURIComponent(provider)}/${encodeURIComponent(model)}`,
      { method: 'DELETE' },
    );
    if (!response.ok) return this.handleErrorResponse(response);
  }
  public async getAuditHistory(
    entityType: AuditEntityType,
    page = 1,
    signal?: AbortSignal,
    entityId?: string,
  ): Promise<AuditHistoryPage> {
    const query = new URLSearchParams({ entityType, page: String(page), pageSize: '20' });
    if (entityId) query.set('entityId', entityId);
    const response = await this.fetchWithAuth(this.baseUrl + '/audit/history?' + query.toString(), {
      signal,
    });
    if (!response.ok) return this.handleErrorResponse(response);
    if (response.status === 204) return { items: [], total: 0, page, totalPages: 0 };
    return response.json() as Promise<AuditHistoryPage>;
  }

  private readonly baseUrl: string;
  private readonly fetcher: typeof fetch;
  private token: string | null;
  private workspaceId: string | null;
  private locale: SupportedLocale;

  /** Address of the ADK API, e.g. for `devkit login --api-url`. */
  public get apiUrl(): string {
    return this.baseUrl;
  }

  public constructor(options: ApiClientOptions = {}) {
    this.baseUrl = options.baseUrl ?? 'http://localhost:3000';
    const suppliedFetcher = options.fetcher;
    this.fetcher = suppliedFetcher ? (input, init) => suppliedFetcher(input, init) : defaultFetch;
    this.token = options.token ?? null;
    this.workspaceId = options.workspaceId ?? null;
    this.locale = options.locale ?? 'pt-BR';
  }

  public setToken(token: string | null): void {
    this.token = token;
  }

  public getToken(): string | null {
    return this.token;
  }

  public setWorkspaceId(workspaceId: string | null): void {
    this.workspaceId = workspaceId;
  }

  public getWorkspaceId(): string | null {
    return this.workspaceId;
  }

  public setLocale(locale: SupportedLocale): void {
    this.locale = locale;
  }

  public getLocale(): SupportedLocale {
    return this.locale;
  }

  private async fetchWithAuth(url: string, init: RequestInit = {}): Promise<Response> {
    // The locale goes with every request; a caller's own header still wins.
    const headers: Record<string, string> = {
      'x-locale': this.locale,
      'Accept-Language': this.locale,
      ...(init.headers as Record<string, string> | undefined),
    };
    if (this.token && !headers['authorization']) {
      headers['authorization'] = `Bearer ${this.token}`;
    }
    if (this.workspaceId && !headers['x-workspace-id']) {
      headers['x-workspace-id'] = this.workspaceId;
    }
    return this.fetcher(url, { ...init, headers });
  }

  private message(key: keyof typeof ptBR.errors): string {
    return (this.locale === 'en-US' ? enUS : ptBR).errors[key];
  }

  private async handleErrorResponse(
    response: Response,
    fallbackMessage = this.message('networkError'),
  ): Promise<never> {
    try {
      const data = (await response.json()) as {
        message?: string;
        error?: string;
        code?: string;
        details?: Array<{ stage?: unknown; upstreamStatus?: unknown }>;
      };
      let message = data.message || data.error || fallbackMessage;
      if (data.code === 'AZURE_WIKI_ERROR') {
        const detail = data.details?.[0];
        if (typeof detail?.stage === 'string') {
          message +=
            typeof detail.upstreamStatus === 'number'
              ? ` (Azure HTTP ${detail.upstreamStatus}, ${detail.stage})`
              : ` (${detail.stage})`;
        }
      }
      throw new ApiClientError(response.status, message);
    } catch (err) {
      if (err instanceof ApiClientError) {
        throw err;
      }
      throw new ApiClientError(response.status, fallbackMessage);
    }
  }

  public async getHealth(signal?: AbortSignal): Promise<HealthResponse> {
    const response = await this.fetchWithAuth(`${this.baseUrl}/health`, { signal });
    if (!response.ok) {
      return this.handleErrorResponse(response);
    }

    const body = (await response.json()) as Partial<HealthResponse>;
    if (body.status !== 'ok' || typeof body.requestId !== 'string') {
      throw new ApiClientError(502, this.message('invalidResponse'));
    }

    return body as HealthResponse;
  }

  /** Servers older than the call answer 404: they have none of the capabilities. */
  public async getCapabilities(signal?: AbortSignal): Promise<ServerCapabilities> {
    const response = await this.fetchWithAuth(`${this.baseUrl}/capabilities`, { signal });
    if (!response.ok) return { workersReachLocalhost: false };
    const body = (await response.json()) as Partial<ServerCapabilities>;
    return { workersReachLocalhost: body.workersReachLocalhost === true };
  }

  public async getReadiness(signal?: AbortSignal): Promise<ReadinessResponse> {
    const response = await this.fetchWithAuth(`${this.baseUrl}/health/ready`, { signal });
    if (response.status !== 200 && response.status !== 503) {
      return this.handleErrorResponse(response);
    }

    const body = (await response.json()) as Partial<ReadinessResponse>;
    if ((body.status !== 'ready' && body.status !== 'not-ready') || !Array.isArray(body.checks)) {
      throw new ApiClientError(502, this.message('invalidResponse'));
    }

    return body as ReadinessResponse;
  }

  public async searchKnowledge(
    prompt: string,
    ownerId?: string,
    signal?: AbortSignal,
  ): Promise<readonly KnowledgeChunkDto[]> {
    const trimmed = prompt.trim();
    if (!trimmed) {
      throw new ApiClientError(400, this.message('requiredInput'));
    }

    const headers: Record<string, string> = {};
    if (ownerId?.trim()) {
      headers['x-owner-id'] = ownerId.trim();
    }

    const url = `${this.baseUrl}/TestPlan/search?prompt=${encodeURIComponent(trimmed)}`;
    const response = await this.fetchWithAuth(url, { headers, signal });

    if (response.status === 204) {
      return [];
    }

    if (!response.ok) {
      return this.handleErrorResponse(response);
    }

    const body = (await response.json()) as unknown;
    if (!Array.isArray(body)) {
      throw new ApiClientError(502, this.message('invalidResponse'));
    }

    return body as readonly KnowledgeChunkDto[];
  }

  public async generateTestPlan(
    prompt: string,
    options?: GenerateTestPlanOptions,
  ): Promise<GenerateTestPlanResponse> {
    const trimmed = prompt.trim();
    if (!trimmed) {
      throw new ApiClientError(400, this.message('requiredInput'));
    }

    const payload: Record<string, unknown> = {
      prompt: trimmed,
    };
    if (options?.title?.trim()) payload.title = options.title.trim();
    if (options?.criteria?.trim()) payload.criteria = options.criteria.trim();
    if (options?.userPrompt?.trim()) payload.userPrompt = options.userPrompt.trim();
    if (options?.areaPath?.trim()) payload.areaPath = options.areaPath.trim();
    if (options?.assignedTo?.trim()) payload.assignedTo = options.assignedTo.trim();
    if (options?.platformProvider?.trim())
      payload.platformProvider = options.platformProvider.trim();
    if (options?.llmProvider?.trim()) payload.llmProvider = options.llmProvider.trim();
    if (options?.format) payload.format = options.format;
    if (options?.agentId?.trim()) payload.agentId = options.agentId.trim();
    if (options?.sourceType) payload.sourceType = options.sourceType;
    if (options?.sourceId?.trim()) payload.sourceId = options.sourceId.trim();
    if (options?.suiteId !== undefined) payload.suiteId = options.suiteId;

    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (options?.workspaceId?.trim()) {
      headers['x-workspace-id'] = options.workspaceId.trim();
    }

    const response = await this.fetchWithAuth(`${this.baseUrl}/TestPlan/generate`, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: options?.signal,
    });

    if (!response.ok) {
      return this.handleErrorResponse(response);
    }

    const body = (await response.json()) as Partial<GenerateTestPlanResponse>;
    if (!body || !Array.isArray(body.plans) || typeof body.csv !== 'string') {
      throw new ApiClientError(502, this.message('invalidResponse'));
    }

    return body as GenerateTestPlanResponse;
  }

  public async generateTestPlanCsv(
    prompt: string,
    title?: string,
    signal?: AbortSignal,
    options?: {
      criteria?: string;
      userPrompt?: string;
      areaPath?: string;
      assignedTo?: string;
      platformProvider?: string;
      llmProvider?: string;
      format?: 'azure' | 'standard';
      workspaceId?: string;
      agentId?: string;
    },
  ): Promise<string> {
    const trimmed = prompt.trim();
    if (!trimmed) {
      throw new ApiClientError(400, this.message('requiredInput'));
    }

    const payload: Record<string, unknown> = {
      prompt: trimmed,
    };
    if (title?.trim()) payload.title = title.trim();
    if (options?.criteria?.trim()) payload.criteria = options.criteria.trim();
    if (options?.userPrompt?.trim()) payload.userPrompt = options.userPrompt.trim();
    if (options?.areaPath?.trim()) payload.areaPath = options.areaPath.trim();
    if (options?.assignedTo?.trim()) payload.assignedTo = options.assignedTo.trim();
    if (options?.platformProvider?.trim())
      payload.platformProvider = options.platformProvider.trim();
    if (options?.llmProvider?.trim()) payload.llmProvider = options.llmProvider.trim();
    if (options?.format) payload.format = options.format;
    if (options?.agentId?.trim()) payload.agentId = options.agentId.trim();

    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (options?.workspaceId?.trim()) {
      headers['x-workspace-id'] = options.workspaceId.trim();
    }

    const response = await this.fetchWithAuth(`${this.baseUrl}/TestPlan/generate/csv`, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal,
    });

    if (!response.ok) {
      return this.handleErrorResponse(response);
    }

    return response.text();
  }

  public async getSavedTestPlans(page = 1, pageSize = 10): Promise<SavedTestPlansPageDto> {
    const query = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
    const response = await this.fetchWithAuth(`${this.baseUrl}/TestPlan?${query.toString()}`);
    if (!response.ok) return this.handleErrorResponse(response);
    const body = (await response.json()) as Partial<SavedTestPlansPageDto>;
    if (!Array.isArray(body.items) || typeof body.total !== 'number') {
      throw new ApiClientError(502, this.message('invalidResponse'));
    }
    return body as SavedTestPlansPageDto;
  }

  public async updateSavedTestPlan(
    id: string,
    input: Pick<SavedTestPlanDto, 'title' | 'plans'> & { suiteId?: string | null },
  ): Promise<SavedTestPlanDto> {
    const response = await this.fetchWithAuth(
      `${this.baseUrl}/TestPlan/${encodeURIComponent(id)}`,
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(input),
      },
    );
    if (!response.ok) return this.handleErrorResponse(response);
    return (await response.json()) as SavedTestPlanDto;
  }

  public async deleteSavedTestPlan(id: string): Promise<void> {
    const response = await this.fetchWithAuth(
      `${this.baseUrl}/TestPlan/${encodeURIComponent(id)}`,
      { method: 'DELETE' },
    );
    if (!response.ok) return this.handleErrorResponse(response);
  }
  public async getTestSuites(): Promise<readonly TestSuiteDto[]> {
    return this.getJson('/TestPlan/suites');
  }
  public async createTestSuite(name: string, parentId?: string): Promise<TestSuiteDto> {
    return this.sendJson('/TestPlan/suites', 'POST', { name, ...(parentId ? { parentId } : {}) });
  }
  public async updateTestSuite(
    id: string,
    input: { name?: string; parentId?: string | null },
  ): Promise<TestSuiteDto> {
    return this.sendJson(`/TestPlan/suites/${encodeURIComponent(id)}`, 'PUT', input);
  }
  public async deleteTestSuite(id: string): Promise<void> {
    const response = await this.fetchWithAuth(
      `${this.baseUrl}/TestPlan/suites/${encodeURIComponent(id)}`,
      { method: 'DELETE' },
    );
    if (!response.ok) return this.handleErrorResponse(response);
  }
  public async getTestSuiteProviders(): Promise<readonly TestSuiteProviderDto[]> {
    return (
      await this.getJson<{ providers: readonly TestSuiteProviderDto[] }>(
        '/TestPlan/publish/providers',
      )
    ).providers;
  }
  public async getTestCaseFieldCatalog(providerId: string): Promise<FieldDefinition[]> {
    return (
      await this.issueRequest<{ fields: FieldDefinition[] }>(
        `/TestPlan/publish/fields?providerId=${encodeURIComponent(providerId)}`,
      )
    ).fields;
  }
  public async getTestSuiteFieldSources(
    suiteId: string,
  ): Promise<{ providerId: string; key: string }[]> {
    return (
      await this.issueRequest<{ sources: { providerId: string; key: string }[] }>(
        `/TestPlan/suites/${encodeURIComponent(suiteId)}/field-sources`,
      )
    ).sources;
  }
  public async previewTestSuiteFields(
    suiteId: string,
    providerId: string,
    templateId: string,
    fieldValues?: Readonly<Record<string, FieldValue>>,
  ): Promise<{ count: number; previews: { title: string; values: Record<string, FieldValue> }[] }> {
    return this.issueRequest(`/TestPlan/suites/${encodeURIComponent(suiteId)}/field-preview`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ providerId, templateId, ...(fieldValues ? { fieldValues } : {}) }),
    });
  }
  /** Imports a plan, a suite or chosen cases of a test management platform into ADK. */
  public async importTestCases(input: ImportTestCasesInput): Promise<ImportTestCasesResultDto> {
    return (
      await this.issueRequest<{ result: ImportTestCasesResultDto }>('/TestPlan/import', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(input),
      })
    ).result;
  }
  /** Every saved Test Plan of the workspace, read page by page. */
  public async getAllSavedTestPlans(): Promise<readonly SavedTestPlanDto[]> {
    const first = await this.getSavedTestPlans(1, 50);
    const rest = await Promise.all(
      Array.from({ length: Math.max(0, first.totalPages - 1) }, (_, index) =>
        this.getSavedTestPlans(index + 2, 50),
      ),
    );
    return [first, ...rest].flatMap((page) => page.items);
  }
  public async getRemoteTestPlans(providerId: string): Promise<readonly RemoteTestPlanDto[]> {
    return (
      await this.getJson<{ plans: readonly RemoteTestPlanDto[] }>(
        `/TestPlan/publish/plans?providerId=${encodeURIComponent(providerId)}`,
      )
    ).plans;
  }
  public async getRemoteTestSuites(
    providerId: string,
    planId: string,
  ): Promise<readonly RemoteTestSuiteDto[]> {
    return (
      await this.getJson<{ suites: readonly RemoteTestSuiteDto[] }>(
        `/TestPlan/publish/plans/${encodeURIComponent(planId)}/suites?providerId=${encodeURIComponent(providerId)}`,
      )
    ).suites;
  }
  public async pushTestSuite(
    id: string,
    input: PublishTestSuiteInput,
  ): Promise<PublishedTestSuiteDto> {
    return this.sendJson(`/TestPlan/suites/${encodeURIComponent(id)}/push`, 'POST', input);
  }

  public async getSpecTemplates(): Promise<readonly SpecTemplateDto[]> {
    return this.getJson('/spec/templates');
  }
  public async saveSpecTemplate(
    input: Pick<SpecTemplateDto, 'name' | 'sections'> & { id?: string },
  ): Promise<SpecTemplateDto> {
    return this.sendJson(
      input.id ? `/spec/templates/${input.id}` : '/spec/templates',
      input.id ? 'PUT' : 'POST',
      input,
    );
  }
  public async deleteSpecTemplate(id: string): Promise<void> {
    const response = await this.fetchWithAuth(
      `${this.baseUrl}/spec/templates/${encodeURIComponent(id)}`,
      { method: 'DELETE' },
    );
    if (!response.ok) return this.handleErrorResponse(response);
  }
  public async getSpecifications(): Promise<readonly SpecificationDto[]> {
    return this.getJson('/spec/specifications');
  }
  public async saveSpecification(
    input: Pick<SpecificationDto, 'title' | 'sections' | 'attachments'> & {
      id?: string;
      templateId?: string;
      agentId?: string;
      parentId?: string;
    },
  ): Promise<SpecificationDto> {
    return this.sendJson(
      input.id ? `/spec/specifications/${input.id}` : '/spec/specifications',
      input.id ? 'PUT' : 'POST',
      input,
    );
  }
  public async chatSpecification(
    id: string,
    agentId: string,
    content: string,
  ): Promise<SpecificationDto> {
    return this.sendJson(`/spec/specifications/${id}/chat`, 'POST', { agentId, content });
  }
  public async clearSpecificationMessages(id: string): Promise<SpecificationDto> {
    return this.sendJson(`/spec/specifications/${encodeURIComponent(id)}/messages`, 'DELETE', {});
  }
  public async publishSpecification(
    id: string,
  ): Promise<{ pageId: string; source: string; title: string }> {
    return this.sendJson(`/spec/specifications/${encodeURIComponent(id)}/knowledge`, 'POST', {});
  }
  public async createSpecificationFromKnowledge(input: {
    pageId: string;
    source: string;
    title: string;
    agentId: string;
  }): Promise<SpecificationDto> {
    return this.sendJson('/spec/from-knowledge', 'POST', input);
  }
  public async deleteSpecification(id: string): Promise<void> {
    const response = await this.fetchWithAuth(
      `${this.baseUrl}/spec/specifications/${encodeURIComponent(id)}`,
      { method: 'DELETE' },
    );
    if (!response.ok) {
      return this.handleErrorResponse(response);
    }
  }
  public async exportSpecification(id: string): Promise<string> {
    const response = await this.fetchWithAuth(
      `${this.baseUrl}/spec/specifications/${encodeURIComponent(id)}/export`,
    );
    if (!response.ok) return this.handleErrorResponse(response);
    return response.text();
  }

  public async getDesignProviders(): Promise<readonly ('github' | 'azure')[]> {
    return (await this.getJson<{ providers: readonly ('github' | 'azure')[] }>('/design/providers'))
      .providers;
  }
  public async getDesignProjects(
    provider: 'github' | 'azure',
  ): Promise<readonly DesignProjectDto[]> {
    return (
      await this.getJson<{ projects: readonly DesignProjectDto[] }>(
        `/design/projects?provider=${provider}`,
      )
    ).projects;
  }
  public async getDesignProject(
    id: string,
    provider: 'github' | 'azure',
  ): Promise<DesignProjectDto> {
    return this.getJson<DesignProjectDto>(
      `/design/projects/${encodeURIComponent(id)}?provider=${provider}`,
    );
  }
  public async createDesignProject(input: {
    title: string;
    agentId: string;
    prompt: string;
    designSystemId?: string;
    provider: 'github' | 'azure';
    images?: readonly DesignImageInput[];
  }): Promise<DesignProjectDto> {
    return this.sendJson('/design/projects', 'POST', input);
  }
  public async chatDesignProject(
    id: string,
    content: string,
    provider: 'github' | 'azure',
    agentId?: string,
    images?: readonly DesignImageInput[],
  ): Promise<DesignProjectDto> {
    return this.sendJson(
      `/design/projects/${encodeURIComponent(id)}/messages?provider=${provider}`,
      'POST',
      { content, agentId, ...(images?.length ? { images } : {}) },
    );
  }
  public async updateDesignFiles(
    id: string,
    files: readonly DesignFileDto[],
    provider: 'github' | 'azure',
  ): Promise<DesignProjectDto> {
    return this.sendJson(
      `/design/projects/${encodeURIComponent(id)}/files?provider=${provider}`,
      'PUT',
      { files },
    );
  }
  public async deleteDesignProject(id: string, provider: 'github' | 'azure'): Promise<void> {
    const response = await this.fetchWithAuth(
      `${this.baseUrl}/design/projects/${encodeURIComponent(id)}?provider=${provider}`,
      { method: 'DELETE' },
    );
    if (!response.ok) return this.handleErrorResponse(response);
  }
  public async getDesignSystems(provider: 'github' | 'azure'): Promise<readonly DesignSystemDto[]> {
    return (
      await this.getJson<{ systems: readonly DesignSystemDto[] }>(
        `/design/systems?provider=${provider}`,
      )
    ).systems;
  }
  public async saveDesignSystem(
    provider: 'github' | 'azure',
    input: { id?: string; name: string; content: string },
  ): Promise<DesignSystemDto> {
    return this.sendJson(`/design/systems?provider=${provider}`, 'PUT', input);
  }
  public async generateDesignSystem(
    agentId: string,
    prompt: string,
    images?: readonly DesignImageInput[],
  ): Promise<{ content: string }> {
    return this.sendJson('/design/systems/generate', 'POST', { agentId, prompt, images });
  }
  public async deleteDesignSystem(id: string, provider: 'github' | 'azure'): Promise<void> {
    const response = await this.fetchWithAuth(
      `${this.baseUrl}/design/systems/${encodeURIComponent(id)}?provider=${provider}`,
      { method: 'DELETE' },
    );
    if (!response.ok) return this.handleErrorResponse(response);
  }

  // --- E2E Automation ---

  public async checkE2eTunnel(
    url: string,
    access?: { accessClientId?: string; accessClientSecret?: string; creationId?: string },
  ): Promise<{
    readonly reachable: boolean;
    readonly reason: 'ok' | 'authentication' | 'origin_error' | 'network_error' | 'host_error';
    readonly status: number | null;
  }> {
    const response = await this.sendJson<{
      result: {
        reachable: boolean;
        reason: 'ok' | 'authentication' | 'origin_error' | 'network_error' | 'host_error';
        status: number | null;
      };
    }>('/e2e/tunnel/check', 'POST', { url, ...access });
    const result = response?.result;
    if (
      !result ||
      typeof result.reachable !== 'boolean' ||
      !['ok', 'authentication', 'origin_error', 'network_error', 'host_error'].includes(
        result.reason,
      ) ||
      (result.status !== null && typeof result.status !== 'number')
    )
      throw new Error('Unexpected tunnel check response.');
    return result;
  }

  public async getE2eCreations(signal?: AbortSignal): Promise<readonly E2eCreationSummary[]> {
    return (
      await this.issueRequest<{ creations: E2eCreationSummary[] }>('/e2e/creations', { signal })
    ).creations;
  }
  public async createE2eCreation(input: E2eCreationInput): Promise<E2eCreationSummary> {
    return (await this.sendJson<{ creation: E2eCreationSummary }>('/e2e/creations', 'POST', input))
      .creation;
  }
  public async getE2eCreation(id: string): Promise<E2eCreationDetail> {
    return (
      await this.issueRequest<{ creation: E2eCreationDetail }>(
        `/e2e/creations/${encodeURIComponent(id)}`,
      )
    ).creation;
  }
  public async updateE2eCreation(id: string, input: E2eCreationInput): Promise<E2eCreationSummary> {
    return (
      await this.sendJson<{ creation: E2eCreationSummary }>(
        `/e2e/creations/${encodeURIComponent(id)}`,
        'PUT',
        input,
      )
    ).creation;
  }
  /** The signed-in user's computers running `devkit runner`. */
  public async getE2eRunners(signal?: AbortSignal): Promise<readonly E2eLocalRunner[]> {
    return (await this.issueRequest<{ runners: E2eLocalRunner[] }>('/e2e/runners', { signal }))
      .runners;
  }
  public async setE2eExecutionTarget(
    id: string,
    executionTarget: E2eExecutionTarget,
  ): Promise<E2eCreationSummary> {
    return (
      await this.sendJson<{ creation: E2eCreationSummary }>(
        `/e2e/creations/${encodeURIComponent(id)}/execution`,
        'PUT',
        { executionTarget },
      )
    ).creation;
  }
  public async rerunE2eCreation(id: string): Promise<void> {
    await this.sendJson(`/e2e/creations/${encodeURIComponent(id)}/run`, 'POST', {});
  }
  public async cancelE2eCreation(id: string): Promise<void> {
    await this.sendJson(`/e2e/creations/${encodeURIComponent(id)}/cancel`, 'POST', {});
  }
  public async deleteE2eCreation(id: string): Promise<void> {
    const response = await this.fetchWithAuth(
      `${this.baseUrl}/e2e/creations/${encodeURIComponent(id)}`,
      { method: 'DELETE' },
    );
    if (!response.ok) return this.handleErrorResponse(response);
  }
  public async getE2eRepositories(): Promise<{
    readonly repositories: readonly E2eRepository[];
    readonly warnings: readonly E2eRepositoryWarning[];
  }> {
    return this.issueRequest('/e2e/repositories');
  }
  public async getE2eBranches(
    provider: E2eRepositoryProvider,
    repositoryId: string,
  ): Promise<readonly E2eBranch[]> {
    const query = new URLSearchParams({ provider, repositoryId });
    return (
      await this.issueRequest<{ branches: E2eBranch[] }>(
        `/e2e/repositories/branches?${query.toString()}`,
      )
    ).branches;
  }
  /** Pulls the test's spec straight from its repository. */
  public async getE2eScript(id: string): Promise<E2eScript> {
    return (
      await this.issueRequest<{ script: E2eScript }>(`/e2e/tests/${encodeURIComponent(id)}/script`)
    ).script;
  }
  /** Commits an edited spec to the run's repository branch. */
  public async pushE2eScript(id: string, content: string): Promise<E2eScript> {
    return (
      await this.sendJson<{ script: E2eScript }>(
        `/e2e/tests/${encodeURIComponent(id)}/script`,
        'PUT',
        { content },
      )
    ).script;
  }
  /** Syncs a run with the specs currently in its repository folder. */
  public async pullE2eCreation(id: string): Promise<E2ePullResult> {
    return (
      await this.sendJson<{ result: E2ePullResult }>(
        `/e2e/creations/${encodeURIComponent(id)}/pull`,
        'POST',
        {},
      )
    ).result;
  }
  public async getE2eTest(id: string, signal?: AbortSignal): Promise<E2eTestDetail> {
    return (
      await this.issueRequest<{ test: E2eTestDetail }>(`/e2e/tests/${encodeURIComponent(id)}`, {
        signal,
      })
    ).test;
  }
  public async rerunE2eTest(id: string, regenerate = false): Promise<void> {
    await this.sendJson(`/e2e/tests/${encodeURIComponent(id)}/run`, 'POST', { regenerate });
  }
  /** Videos need the bearer token, so they are fetched as a Blob instead of a plain src URL. */
  /**
   * Signed URL to stream the video straight from object storage (Cloudflare R2), or null
   * when the backend keeps videos elsewhere and they must be downloaded with getE2eTestVideo.
   */
  public async getE2eTestVideoUrl(
    id: string,
    signal?: AbortSignal,
  ): Promise<{ readonly url: string; readonly mimeType: string } | null> {
    return (
      await this.issueRequest<{ video: { url: string; mimeType: string } | null }>(
        `/e2e/tests/${encodeURIComponent(id)}/video-url`,
        { signal },
      )
    ).video;
  }
  public async getE2eTestVideo(id: string, signal?: AbortSignal): Promise<Blob> {
    const response = await this.fetchWithAuth(
      `${this.baseUrl}/e2e/tests/${encodeURIComponent(id)}/video`,
      { signal },
    );
    if (!response.ok) return this.handleErrorResponse(response);
    return response.blob();
  }

  // --- E2E test management (Azure Test Plans, TestRail, Xray) ---

  /** Platforms the workspace can import cases from and publish runs to. */
  public async getTestManagementProviders(): Promise<readonly TestManagementProvider[]> {
    return (
      await this.issueRequest<{ providers: TestManagementProvider[] }>(
        '/e2e/test-management/providers',
      )
    ).providers;
  }
  public async getTestManagementPlans(
    provider: TestManagementProviderId,
  ): Promise<readonly RemoteContainer[]> {
    return (
      await this.issueRequest<{ plans: RemoteContainer[] }>(
        `/e2e/test-management/${encodeURIComponent(provider)}/plans`,
      )
    ).plans;
  }
  public async getTestManagementSuites(
    provider: TestManagementProviderId,
    planId: string,
  ): Promise<readonly RemoteContainer[]> {
    return (
      await this.issueRequest<{ suites: RemoteContainer[] }>(
        `/e2e/test-management/${encodeURIComponent(provider)}/plans/${encodeURIComponent(planId)}/suites`,
      )
    ).suites;
  }
  public async getTestManagementCases(
    provider: TestManagementProviderId,
    location: { readonly planId?: string; readonly suiteId?: string } = {},
  ): Promise<readonly ExternalTestCase[]> {
    const query = new URLSearchParams();
    if (location.planId) query.set('planId', location.planId);
    if (location.suiteId) query.set('suiteId', location.suiteId);
    const search = query.toString();
    return (
      await this.issueRequest<{ cases: ExternalTestCase[] }>(
        `/e2e/test-management/${encodeURIComponent(provider)}/cases${search ? `?${search}` : ''}`,
      )
    ).cases;
  }
  /** Adds test management cases to a run as tests; cases already in the run are skipped. */
  public async importE2eCases(id: string, input: E2eImportCasesInput): Promise<E2eImportResult> {
    return (
      await this.sendJson<{ result: E2eImportResult }>(
        `/e2e/creations/${encodeURIComponent(id)}/import-cases`,
        'POST',
        input,
      )
    ).result;
  }
  /** Chooses (or clears, with null) the platform that receives the run's results. */
  public async setE2eReporting(
    id: string,
    reporting: E2eReportingInput | null,
  ): Promise<E2eCreationView> {
    return (
      await this.sendJson<{ creation: E2eCreationView }>(
        `/e2e/creations/${encodeURIComponent(id)}/reporting`,
        'PUT',
        { reporting },
      )
    ).creation;
  }
  /** Starts publishing the run's results; poll the run while `lastReport` is publishing. */
  public async publishE2eCreation(id: string): Promise<E2eCreationView> {
    return (
      await this.sendJson<{ creation: E2eCreationView }>(
        `/e2e/creations/${encodeURIComponent(id)}/publish`,
        'POST',
        {},
      )
    ).creation;
  }
  /** Links a test to a test management case, or unlinks it with null. */
  public async linkE2eTestCase(
    id: string,
    externalCase: ExternalCaseRef | null,
  ): Promise<E2eTestDetail> {
    return (
      await this.sendJson<{ test: E2eTestDetail }>(
        `/e2e/tests/${encodeURIComponent(id)}/external-case`,
        'PUT',
        { externalCase },
      )
    ).test;
  }
  /** Screenshots need the bearer token, so they are fetched as a Blob. */
  public async getE2eStepScreenshot(
    id: string,
    position: number,
    signal?: AbortSignal,
  ): Promise<Blob> {
    const response = await this.fetchWithAuth(
      `${this.baseUrl}/e2e/tests/${encodeURIComponent(id)}/steps/${position}/screenshot`,
      { signal },
    );
    if (!response.ok) return this.handleErrorResponse(response);
    return response.blob();
  }

  private async getJson<T>(path: string): Promise<T> {
    const response = await this.fetchWithAuth(`${this.baseUrl}${path}`);
    if (!response.ok) return this.handleErrorResponse(response);
    return response.json() as Promise<T>;
  }
  private async sendJson<T>(
    path: string,
    method: 'POST' | 'PUT' | 'DELETE',
    body: unknown,
  ): Promise<T> {
    const response = await this.fetchWithAuth(`${this.baseUrl}${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!response.ok) return this.handleErrorResponse(response);
    return response.json() as Promise<T>;
  }

  // --- Auth Endpoints ---

  public async login(
    credentials: { email: string; password: string },
    signal?: AbortSignal,
  ): Promise<AuthResponse> {
    const response = await this.fetchWithAuth(`${this.baseUrl}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(credentials),
      signal,
    });

    if (!response.ok) {
      return this.handleErrorResponse(response);
    }

    const body = (await response.json()) as AuthResponse;
    this.setToken(body.token);
    return body;
  }

  public async register(
    input: { email: string; password: string; name?: string },
    signal?: AbortSignal,
  ): Promise<AuthResponse> {
    const response = await this.fetchWithAuth(`${this.baseUrl}/auth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
      signal,
    });

    if (!response.ok) {
      return this.handleErrorResponse(response);
    }

    const body = (await response.json()) as AuthResponse;
    this.setToken(body.token);
    return body;
  }

  public requestPasswordReset(email: string): Promise<{ success: true }> {
    return this.sendJson('/auth/password/forgot', 'POST', { email });
  }

  public resetPassword(input: {
    email: string;
    code: string;
    password: string;
  }): Promise<AuthResponse> {
    return this.sendJson<AuthResponse>('/auth/password/reset', 'POST', input).then((response) => {
      this.setToken(response.token);
      return response;
    });
  }

  public getOAuthStartUrl(provider: 'google' | 'github'): string {
    return `${this.baseUrl}/auth/oauth/${provider}/start`;
  }

  public async getAuthOptions(): Promise<{ oauthProviders: readonly ('google' | 'github')[] }> {
    const response = await this.fetchWithAuth(`${this.baseUrl}/auth/options`);
    if (!response.ok) return this.handleErrorResponse(response);
    return response.json() as Promise<{ oauthProviders: readonly ('google' | 'github')[] }>;
  }

  public async getMe(signal?: AbortSignal): Promise<UserProfile> {
    const response = await this.fetchWithAuth(`${this.baseUrl}/auth/me`, { signal });
    if (!response.ok) {
      return this.handleErrorResponse(response);
    }

    const body = (await response.json()) as { user: UserProfile };
    return body.user;
  }

  public async logout(signal?: AbortSignal): Promise<void> {
    try {
      await this.fetchWithAuth(`${this.baseUrl}/auth/logout`, {
        method: 'POST',
        signal,
      });
    } finally {
      this.setToken(null);
    }
  }

  // --- Integrations Endpoints ---

  public async getIntegrations(signal?: AbortSignal): Promise<readonly UserIntegrationDto[]> {
    const response = await this.fetchWithAuth(`${this.baseUrl}/integrations`, { signal });
    if (!response.ok) {
      return this.handleErrorResponse(response);
    }

    const body = (await response.json()) as unknown;
    if (Array.isArray(body)) {
      return body as readonly UserIntegrationDto[];
    }
    return (body as { integrations: readonly UserIntegrationDto[] }).integrations;
  }

  public async saveIntegration(
    category: string,
    providerId: string,
    payload: {
      isEnabled?: boolean;
      settings?: Record<string, unknown>;
      secret?: string;
    },
    signal?: AbortSignal,
  ): Promise<UserIntegrationDto> {
    const response = await this.fetchWithAuth(
      `${this.baseUrl}/integrations/${category}/${providerId}`,
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal,
      },
    );

    if (!response.ok) {
      return this.handleErrorResponse(response);
    }

    const body = (await response.json()) as unknown;
    if (body && typeof body === 'object' && 'integration' in body) {
      return (body as { integration: UserIntegrationDto }).integration;
    }
    return body as UserIntegrationDto;
  }

  public async deleteIntegration(
    category: string,
    providerId: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const response = await this.fetchWithAuth(
      `${this.baseUrl}/integrations/${category}/${providerId}`,
      {
        method: 'DELETE',
        signal,
      },
    );

    if (!response.ok) {
      return this.handleErrorResponse(response);
    }
  }

  public async testIntegration(
    category: string,
    providerId: string,
    payload?: {
      settings?: Record<string, unknown>;
      secret?: string;
    },
    signal?: AbortSignal,
  ): Promise<ConnectivityProbeDto> {
    const response = await this.fetchWithAuth(
      `${this.baseUrl}/integrations/${category}/${providerId}/test`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload ?? {}),
        signal,
      },
    );

    if (!response.ok) {
      return this.handleErrorResponse(response);
    }

    return (await response.json()) as ConnectivityProbeDto;
  }

  public async getAzureDevOpsProjectMembers(
    signal?: AbortSignal,
    testOptions = false,
  ): Promise<AzureDevOpsProjectMembersResponse> {
    const response = await this.fetchWithAuth(
      `${this.baseUrl}/integrations/azure-devops/members${testOptions ? '?testOptions=true' : ''}`,
      {
        signal,
      },
    );

    if (!response.ok) {
      return this.handleErrorResponse(response);
    }

    return (await response.json()) as AzureDevOpsProjectMembersResponse;
  }

  // --- Knowledge Synchronization & Stats ---

  public async syncKnowledge(signal?: AbortSignal): Promise<KnowledgeSyncResultDto> {
    const response = await this.fetchWithAuth(`${this.baseUrl}/knowledge/sync`, {
      method: 'POST',
      signal,
    });

    if (!response.ok) {
      return this.handleErrorResponse(response);
    }

    return (await response.json()) as KnowledgeSyncResultDto;
  }

  public async getKnowledgePushProviders(): Promise<readonly KnowledgePushProviderDto[]> {
    return (
      await this.issueRequest<{ providers: KnowledgePushProviderDto[] }>(
        '/knowledge/push-providers',
      )
    ).providers;
  }

  public async getKnowledgePushDestinations(
    providerId: string,
  ): Promise<readonly KnowledgePushDestinationDto[]> {
    return (
      await this.issueRequest<{ destinations: KnowledgePushDestinationDto[] }>(
        `/knowledge/push-destinations/${encodeURIComponent(providerId)}`,
      )
    ).destinations;
  }

  public async pushKnowledgeDocument(
    pageId: string,
    input?: KnowledgePushInput,
    signal?: AbortSignal,
  ): Promise<{
    readonly success: true;
    readonly remoteUrl: string;
    readonly published?: readonly {
      readonly oldId: string;
      readonly newId: string;
      readonly remoteUrl: string;
    }[];
  }> {
    const response = await this.fetchWithAuth(
      `${this.baseUrl}/knowledge/documents/${encodeURIComponent(pageId)}/push`,
      {
        method: 'POST',
        ...(input
          ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) }
          : {}),
        signal,
      },
    );
    if (!response.ok) {
      return this.handleErrorResponse(response);
    }
    return (await response.json()) as {
      readonly success: true;
      readonly remoteUrl: string;
      readonly published?: readonly {
        readonly oldId: string;
        readonly newId: string;
        readonly remoteUrl: string;
      }[];
    };
  }

  public async getKnowledgeStats(
    ownerId?: string,
    signal?: AbortSignal,
  ): Promise<KnowledgeStatsDto> {
    const headers: Record<string, string> = {};
    if (ownerId?.trim()) {
      headers['x-owner-id'] = ownerId.trim();
    }
    const response = await this.fetchWithAuth(`${this.baseUrl}/knowledge/stats`, {
      headers,
      signal,
    });

    if (!response.ok) {
      return this.handleErrorResponse(response);
    }

    return (await response.json()) as KnowledgeStatsDto;
  }

  public async getKnowledgeDocuments(
    ownerId?: string,
    signal?: AbortSignal,
  ): Promise<readonly KnowledgeDocumentDto[]> {
    const headers: Record<string, string> = {};
    if (ownerId?.trim()) {
      headers['x-owner-id'] = ownerId.trim();
    }
    const response = await this.fetchWithAuth(`${this.baseUrl}/knowledge/documents`, {
      headers,
      signal,
    });

    if (!response.ok) {
      return this.handleErrorResponse(response);
    }

    const body = (await response.json()) as { documents: readonly KnowledgeDocumentDto[] };
    return body.documents;
  }

  public async getKnowledgeRelations(
    signal?: AbortSignal,
  ): Promise<readonly KnowledgeRelationDto[]> {
    const response = await this.fetchWithAuth(`${this.baseUrl}/knowledge/relations`, { signal });
    if (!response.ok) return this.handleErrorResponse(response);
    return ((await response.json()) as { relations: readonly KnowledgeRelationDto[] }).relations;
  }

  public async createKnowledgeRelation(
    sourcePageId: string,
    targetPageId: string,
  ): Promise<readonly KnowledgeRelationDto[]> {
    const response = await this.fetchWithAuth(`${this.baseUrl}/knowledge/relations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sourcePageId, targetPageId }),
    });
    if (!response.ok) return this.handleErrorResponse(response);
    return ((await response.json()) as { relations: readonly KnowledgeRelationDto[] }).relations;
  }

  public async deleteKnowledgeRelation(sourcePageId: string, targetPageId: string): Promise<void> {
    const url = new URL(`${this.baseUrl}/knowledge/relations`);
    url.searchParams.set('sourcePageId', sourcePageId);
    url.searchParams.set('targetPageId', targetPageId);
    const response = await this.fetchWithAuth(url.toString(), { method: 'DELETE' });
    if (!response.ok) return this.handleErrorResponse(response);
  }

  public async createKnowledgeDocument(
    title: string,
    content: string,
    signal?: AbortSignal,
    parentPageId?: string,
  ): Promise<KnowledgeDocumentDto> {
    const response = await this.fetchWithAuth(`${this.baseUrl}/knowledge/documents`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title, content, ...(parentPageId ? { parentPageId } : {}) }),
      signal,
    });

    if (!response.ok) {
      return this.handleErrorResponse(response);
    }

    const body = (await response.json()) as { document: KnowledgeDocumentDto };
    return body.document;
  }

  public async updateKnowledgeDocument(
    pageId: string,
    title: string,
    content: string,
    signal?: AbortSignal,
  ): Promise<KnowledgeDocumentDto> {
    const response = await this.fetchWithAuth(
      `${this.baseUrl}/knowledge/documents/${encodeURIComponent(pageId)}`,
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title, content }),
        signal,
      },
    );

    if (!response.ok) {
      return this.handleErrorResponse(response);
    }

    const body = (await response.json()) as { document: KnowledgeDocumentDto };
    return body.document;
  }

  public async deleteKnowledgeDocument(
    pageId: string,
    source?: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const url = new URL(`${this.baseUrl}/knowledge/documents/${encodeURIComponent(pageId)}`);
    if (source) {
      url.searchParams.set('source', source);
    }

    const response = await this.fetchWithAuth(url.toString(), {
      method: 'DELETE',
      signal,
    });

    if (!response.ok) {
      return this.handleErrorResponse(response);
    }
  }

  public async getWorkspaces(signal?: AbortSignal): Promise<readonly UserWorkspaceMembership[]> {
    const response = await this.fetchWithAuth(`${this.baseUrl}/workspaces`, { signal });
    if (!response.ok) {
      return this.handleErrorResponse(response);
    }
    return (await response.json()) as readonly UserWorkspaceMembership[];
  }

  public async createWorkspace(
    data: { name: string; slug?: string },
    signal?: AbortSignal,
  ): Promise<UserWorkspaceMembership> {
    const response = await this.fetchWithAuth(`${this.baseUrl}/workspaces`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(data),
      signal,
    });
    if (!response.ok) {
      return this.handleErrorResponse(response);
    }
    return (await response.json()) as UserWorkspaceMembership;
  }

  public async listAccessTokens(signal?: AbortSignal): Promise<readonly AccessTokenDto[]> {
    const response = await this.fetchWithAuth(`${this.baseUrl}/auth/tokens`, { signal });
    if (!response.ok) return this.handleErrorResponse(response);
    return ((await response.json()) as { tokens: AccessTokenDto[] }).tokens;
  }

  public async createAccessToken(
    input: { name: string; scope: AccessTokenScope; expiresInDays: number | null },
    signal?: AbortSignal,
  ): Promise<CreatedAccessTokenDto> {
    const response = await this.fetchWithAuth(`${this.baseUrl}/auth/tokens`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
      signal,
    });
    if (!response.ok) return this.handleErrorResponse(response);
    return (await response.json()) as CreatedAccessTokenDto;
  }

  public async revokeAccessToken(id: string, signal?: AbortSignal): Promise<void> {
    const response = await this.fetchWithAuth(
      `${this.baseUrl}/auth/tokens/${encodeURIComponent(id)}`,
      { method: 'DELETE', signal },
    );
    if (!response.ok) return this.handleErrorResponse(response);
  }

  public async getWorkspaceMembers(
    workspaceId: string,
    signal?: AbortSignal,
  ): Promise<readonly WorkspaceMember[]> {
    const response = await this.fetchWithAuth(
      `${this.baseUrl}/workspaces/${encodeURIComponent(workspaceId)}/members`,
      {
        signal,
      },
    );
    if (!response.ok) {
      return this.handleErrorResponse(response);
    }
    return (await response.json()) as readonly WorkspaceMember[];
  }

  public async addWorkspaceMember(
    workspaceId: string,
    data: {
      email: string;
      role: WorkspaceRole;
      permissions?: WorkspacePermissions;
      groupIds?: readonly string[];
    },
    signal?: AbortSignal,
  ): Promise<WorkspaceMember> {
    const response = await this.fetchWithAuth(
      `${this.baseUrl}/workspaces/${encodeURIComponent(workspaceId)}/members`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(data),
        signal,
      },
    );
    if (!response.ok) {
      return this.handleErrorResponse(response);
    }
    return (await response.json()) as WorkspaceMember;
  }

  public async updateWorkspaceMember(
    workspaceId: string,
    memberId: string,
    data: {
      role?: WorkspaceRole;
      permissions?: WorkspacePermissions;
      groupIds?: readonly string[];
    },
    signal?: AbortSignal,
  ): Promise<WorkspaceMember> {
    const response = await this.fetchWithAuth(
      `${this.baseUrl}/workspaces/${encodeURIComponent(workspaceId)}/members/${encodeURIComponent(memberId)}`,
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(data),
        signal,
      },
    );
    if (!response.ok) {
      return this.handleErrorResponse(response);
    }
    return (await response.json()) as WorkspaceMember;
  }

  public async removeWorkspaceMember(
    workspaceId: string,
    memberId: string,
    signal?: AbortSignal,
  ): Promise<{ success: boolean }> {
    const response = await this.fetchWithAuth(
      `${this.baseUrl}/workspaces/${encodeURIComponent(workspaceId)}/members/${encodeURIComponent(memberId)}`,
      {
        method: 'DELETE',
        signal,
      },
    );
    if (!response.ok) {
      return this.handleErrorResponse(response);
    }
    return (await response.json()) as { success: boolean };
  }

  public async renameWorkspace(workspaceId: string, name: string): Promise<Workspace> {
    const response = await this.fetchWithAuth(
      `${this.baseUrl}/workspaces/${encodeURIComponent(workspaceId)}`,
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name }),
      },
    );
    if (!response.ok) return this.handleErrorResponse(response);
    return (await response.json()) as Workspace;
  }

  public async getPermissionGroups(workspaceId: string): Promise<readonly PermissionGroup[]> {
    const response = await this.fetchWithAuth(
      `${this.baseUrl}/workspaces/${encodeURIComponent(workspaceId)}/groups`,
    );
    if (!response.ok) return this.handleErrorResponse(response);
    return (await response.json()) as readonly PermissionGroup[];
  }

  public async savePermissionGroup(
    workspaceId: string,
    group: PermissionGroupInput,
    groupId?: string,
  ): Promise<PermissionGroup> {
    const base = `${this.baseUrl}/workspaces/${encodeURIComponent(workspaceId)}/groups`;
    const response = await this.fetchWithAuth(
      groupId ? `${base}/${encodeURIComponent(groupId)}` : base,
      {
        method: groupId ? 'PATCH' : 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(group),
      },
    );
    if (!response.ok) return this.handleErrorResponse(response);
    return (await response.json()) as PermissionGroup;
  }

  public async deletePermissionGroup(workspaceId: string, groupId: string): Promise<void> {
    const response = await this.fetchWithAuth(
      `${this.baseUrl}/workspaces/${encodeURIComponent(workspaceId)}/groups/${encodeURIComponent(groupId)}`,
      { method: 'DELETE' },
    );
    if (!response.ok) return this.handleErrorResponse(response);
  }

  public async deleteWorkspace(
    workspaceId: string,
    signal?: AbortSignal,
  ): Promise<{ success: boolean }> {
    const response = await this.fetchWithAuth(
      `${this.baseUrl}/workspaces/${encodeURIComponent(workspaceId)}`,
      {
        method: 'DELETE',
        signal,
      },
    );
    if (!response.ok) {
      return this.handleErrorResponse(response);
    }
    return (await response.json()) as { success: boolean };
  }

  public async getAgents(signal?: AbortSignal): Promise<readonly CustomAgentDto[]> {
    const response = await this.fetchWithAuth(`${this.baseUrl}/agents`, { signal });
    if (!response.ok) {
      return this.handleErrorResponse(response);
    }
    const data: unknown = await response.json();
    if (Array.isArray(data)) {
      return data as readonly CustomAgentDto[];
    }
    if (
      typeof data === 'object' &&
      data !== null &&
      'agents' in data &&
      Array.isArray((data as { readonly agents?: unknown }).agents)
    ) {
      return (data as { readonly agents: readonly CustomAgentDto[] }).agents;
    }
    return [];
  }

  public async getAgentWorkflow(signal?: AbortSignal): Promise<AgentWorkflowDto> {
    const response = await this.fetchWithAuth(`${this.baseUrl}/agents/workflow`, { signal });
    if (!response.ok) return this.handleErrorResponse(response);
    const payload: unknown = await response.json();
    return normalizeAgentWorkflow(isRecord(payload) ? payload['workflow'] : undefined);
  }

  public async saveAgentWorkflow(
    workflow: AgentWorkflowDto,
    signal?: AbortSignal,
  ): Promise<AgentWorkflowDto> {
    const response = await this.fetchWithAuth(`${this.baseUrl}/agents/workflow`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        enabled: workflow.enabled,
        autonomy: workflow.autonomy,
        finalReview: workflow.finalReview,
        uncertaintyBehavior: workflow.uncertaintyBehavior,
        issueCreationBehavior: workflow.issueCreationBehavior,
        defaultAction: workflow.defaultAction,
        steps: workflow.steps,
        rules: workflow.rules,
      }),
      signal,
    });
    if (!response.ok) return this.handleErrorResponse(response);
    const payload: unknown = await response.json();
    return normalizeAgentWorkflow(isRecord(payload) ? payload['workflow'] : undefined, workflow);
  }

  public async getAgent(id: string, signal?: AbortSignal): Promise<CustomAgentDto> {
    const response = await this.fetchWithAuth(`${this.baseUrl}/agents/${encodeURIComponent(id)}`, {
      signal,
    });
    if (!response.ok) {
      return this.handleErrorResponse(response);
    }
    const data = (await response.json()) as CustomAgentDto | { agent?: CustomAgentDto };
    return 'agent' in data && data.agent ? data.agent : (data as CustomAgentDto);
  }

  public async createAgent(data: CreateAgentDto, signal?: AbortSignal): Promise<CustomAgentDto> {
    const response = await this.fetchWithAuth(`${this.baseUrl}/agents`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(data),
      signal,
    });
    if (!response.ok) {
      return this.handleErrorResponse(response);
    }
    const res = (await response.json()) as CustomAgentDto | { agent?: CustomAgentDto };
    return 'agent' in res && res.agent ? res.agent : (res as CustomAgentDto);
  }

  public async updateAgent(
    id: string,
    data: UpdateAgentDto,
    signal?: AbortSignal,
  ): Promise<CustomAgentDto> {
    const response = await this.fetchWithAuth(`${this.baseUrl}/agents/${encodeURIComponent(id)}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(data),
      signal,
    });
    if (!response.ok) {
      return this.handleErrorResponse(response);
    }
    const res = (await response.json()) as CustomAgentDto | { agent?: CustomAgentDto };
    return 'agent' in res && res.agent ? res.agent : (res as CustomAgentDto);
  }

  /** ADK Hub agents and plugin subagents, with what this workspace has installed. */
  public async listHubAgents(signal?: AbortSignal): Promise<HubAgentCatalogDto> {
    const response = await this.fetchWithAuth(`${this.baseUrl}/agents/hub`, { signal });
    if (!response.ok) return this.handleErrorResponse(response);
    return (await response.json()) as HubAgentCatalogDto;
  }

  /** Installs a hub agent (name), a plugin subagent (plugin + name) or all of a plugin's. */
  public async installHubAgent(
    ref: { readonly name?: string; readonly plugin?: string },
    signal?: AbortSignal,
  ): Promise<readonly CustomAgentDto[]> {
    const response = await this.fetchWithAuth(`${this.baseUrl}/agents/hub/install`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(ref),
      signal,
    });
    if (!response.ok) return this.handleErrorResponse(response);
    return ((await response.json()) as { agents: readonly CustomAgentDto[] }).agents;
  }

  /** Replaces an installed agent's name, description and instructions with the hub version. */
  public async updateHubAgent(id: string, signal?: AbortSignal): Promise<CustomAgentDto> {
    const response = await this.fetchWithAuth(
      `${this.baseUrl}/agents/${encodeURIComponent(id)}/hub-update`,
      { method: 'POST', signal },
    );
    if (!response.ok) return this.handleErrorResponse(response);
    return ((await response.json()) as { agent: CustomAgentDto }).agent;
  }

  public async deleteAgent(id: string, signal?: AbortSignal): Promise<{ success: boolean }> {
    const response = await this.fetchWithAuth(`${this.baseUrl}/agents/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      signal,
    });
    if (!response.ok) {
      return this.handleErrorResponse(response);
    }
    return (await response.json()) as { success: boolean };
  }

  public async executeAgent(
    id: string,
    data: ExecuteAgentDto,
    signal?: AbortSignal,
  ): Promise<ExecuteAgentResponse> {
    const response = await this.fetchWithAuth(
      `${this.baseUrl}/agents/${encodeURIComponent(id)}/execute`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(data),
        signal,
      },
    );
    if (!response.ok) {
      return this.handleErrorResponse(response);
    }
    const body = (await response.json()) as unknown;
    if (!body || typeof body !== 'object') {
      throw new ApiClientError(502, this.message('invalidResponse'));
    }
    const payload = body as Record<string, unknown>;
    const content =
      typeof payload['content'] === 'string'
        ? payload['content']
        : typeof payload['result'] === 'string'
          ? payload['result']
          : null;
    const rawAgent = payload['agent'];
    if (!content || !rawAgent || typeof rawAgent !== 'object') {
      throw new ApiClientError(502, this.message('invalidResponse'));
    }
    const agent = rawAgent as Record<string, unknown>;
    if (
      typeof agent['id'] !== 'string' ||
      typeof agent['name'] !== 'string' ||
      typeof agent['role'] !== 'string'
    ) {
      throw new ApiClientError(502, this.message('invalidResponse'));
    }
    return {
      content,
      agent: {
        id: agent['id'],
        name: agent['name'],
        role: agent['role'] as ExecuteAgentResponse['agent']['role'],
      },
      chunksUsed: typeof payload['chunksUsed'] === 'number' ? payload['chunksUsed'] : 0,
      provider: typeof payload['provider'] === 'string' ? payload['provider'] : undefined,
    };
  }

  public async queryBrain(
    prompt: string,
    history?: string,
    signal?: AbortSignal,
  ): Promise<{ content: string; agentName: string; provider?: string }> {
    const response = await this.fetchWithAuth(`${this.baseUrl}/agents/default/brain-query`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt, ...(history ? { history } : {}) }),
      signal,
    });
    if (!response.ok) return this.handleErrorResponse(response);
    const payload = (await response.json()) as {
      result: string;
      agent: { name: string };
      provider?: string;
    };
    return { content: payload.result, agentName: payload.agent.name, provider: payload.provider };
  }

  // ---------- Integration and overload tests ----------

  private async apiTestRequest<T>(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    path: string,
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<T> {
    const response = await this.fetchWithAuth(`${this.baseUrl}${path}`, {
      method,
      ...(body === undefined
        ? {}
        : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
      signal,
    });
    if (!response.ok) return this.handleErrorResponse(response);
    return (await response.json()) as T;
  }

  public async listApiCollections(signal?: AbortSignal): Promise<ApiCollectionSummary[]> {
    return (
      await this.apiTestRequest<{ collections: ApiCollectionSummary[] }>(
        'GET',
        '/integration-tests/collections',
        undefined,
        signal,
      )
    ).collections;
  }

  public async getApiCollection(id: string, signal?: AbortSignal): Promise<ApiCollection> {
    return (
      await this.apiTestRequest<{ collection: ApiCollection }>(
        'GET',
        `/integration-tests/collections/${encodeURIComponent(id)}`,
        undefined,
        signal,
      )
    ).collection;
  }

  /** Creates a collection, or replaces it when `id` is given. */
  public async saveApiCollection(
    collection: Partial<ApiCollection> & { name: string },
    id?: string,
  ): Promise<ApiCollection> {
    return (
      await this.apiTestRequest<{ collection: ApiCollection }>(
        id ? 'PUT' : 'POST',
        id
          ? `/integration-tests/collections/${encodeURIComponent(id)}`
          : '/integration-tests/collections',
        collection,
      )
    ).collection;
  }

  public async deleteApiCollection(id: string): Promise<void> {
    await this.apiTestRequest('DELETE', `/integration-tests/collections/${encodeURIComponent(id)}`);
  }

  public async importApiCollection(
    content: string,
    name?: string,
  ): Promise<{ format: string; collection: ApiCollection }> {
    return this.apiTestRequest('POST', '/integration-tests/collections/import', {
      content,
      ...(name ? { name } : {}),
    });
  }

  /** Downloads an export as a file (JSON or, for Bruno, a zip). */
  public async exportApiCollection(
    id: string,
    format: ExportFormat,
    environmentIds: readonly string[] = [],
  ): Promise<{ fileName: string; blob: Blob }> {
    const query = new URLSearchParams({
      format,
      ...(environmentIds.length ? { environmentIds: environmentIds.join(',') } : {}),
    });
    const response = await this.fetchWithAuth(
      `${this.baseUrl}/integration-tests/collections/${encodeURIComponent(id)}/export?${query.toString()}`,
    );
    if (!response.ok) return this.handleErrorResponse(response);
    const disposition = response.headers.get('content-disposition') ?? '';
    const fileName =
      /filename="([^"]+)"/.exec(disposition)?.[1] ??
      `collection.${format === 'bruno' ? 'zip' : 'json'}`;
    return { fileName, blob: await response.blob() };
  }

  /** The mock values (`{{$randomFullName}}`...) requests can use, each with a fresh sample. */
  public async listApiMockValues(signal?: AbortSignal): Promise<ApiMockValue[]> {
    return (
      await this.apiTestRequest<{ values: ApiMockValue[] }>(
        'GET',
        '/integration-tests/dynamic-values',
        undefined,
        signal,
      )
    ).values;
  }

  public async listApiEnvironments(signal?: AbortSignal): Promise<ApiEnvironment[]> {
    return (
      await this.apiTestRequest<{ environments: ApiEnvironment[] }>(
        'GET',
        '/integration-tests/environments',
        undefined,
        signal,
      )
    ).environments;
  }

  public async saveApiEnvironment(
    environment: Pick<ApiEnvironment, 'name' | 'variables'>,
    id?: string,
  ): Promise<ApiEnvironment> {
    return (
      await this.apiTestRequest<{ environment: ApiEnvironment }>(
        id ? 'PUT' : 'POST',
        id
          ? `/integration-tests/environments/${encodeURIComponent(id)}`
          : '/integration-tests/environments',
        environment,
      )
    ).environment;
  }

  public async deleteApiEnvironment(id: string): Promise<void> {
    await this.apiTestRequest(
      'DELETE',
      `/integration-tests/environments/${encodeURIComponent(id)}`,
    );
  }

  public async startIntegrationRun(input: {
    collectionId: string;
    environmentId?: string | null;
    itemIds?: string[];
    target: ApiRunTarget;
    bail?: boolean;
  }): Promise<ApiRun> {
    return (await this.apiTestRequest<{ run: ApiRun }>('POST', '/integration-tests/runs', input))
      .run;
  }

  public async listApiRuns(
    kind: 'integration' | 'load',
    filter: { collectionId?: string; scenarioId?: string } = {},
    signal?: AbortSignal,
  ): Promise<ApiRun[]> {
    const query = new URLSearchParams(Object.entries(filter).filter(([, value]) => Boolean(value)));
    const base = kind === 'integration' ? '/integration-tests/runs' : '/load-tests/runs';
    return (
      await this.apiTestRequest<{ runs: ApiRun[] }>(
        'GET',
        `${base}?${query.toString()}`,
        undefined,
        signal,
      )
    ).runs;
  }

  public async getApiRun(
    kind: 'integration' | 'load',
    id: string,
    signal?: AbortSignal,
  ): Promise<ApiRun> {
    const base = kind === 'integration' ? '/integration-tests/runs' : '/load-tests/runs';
    return (
      await this.apiTestRequest<{ run: ApiRun }>(
        'GET',
        `${base}/${encodeURIComponent(id)}`,
        undefined,
        signal,
      )
    ).run;
  }

  public async cancelApiRun(kind: 'integration' | 'load', id: string): Promise<ApiRun> {
    const base = kind === 'integration' ? '/integration-tests/runs' : '/load-tests/runs';
    return (
      await this.apiTestRequest<{ run: ApiRun }>('POST', `${base}/${encodeURIComponent(id)}/cancel`)
    ).run;
  }

  public async deleteApiRun(kind: 'integration' | 'load', id: string): Promise<void> {
    const base = kind === 'integration' ? '/integration-tests/runs' : '/load-tests/runs';
    await this.apiTestRequest('DELETE', `${base}/${encodeURIComponent(id)}`);
  }

  /** Server mode: the workspace model writes the tests and they are saved. */
  public async generateApiTests(
    kind: 'integration' | 'load',
    input: GenerationRequest,
  ): Promise<{ collection?: ApiCollection | null; scenario?: LoadScenario | null }> {
    return this.apiTestRequest(
      'POST',
      kind === 'integration' ? '/integration-tests/generate' : '/load-tests/generate',
      input,
    );
  }

  public async getLoadProfiles(vus: number, durationSec: number): Promise<LoadProfileDefaults[]> {
    return (
      await this.apiTestRequest<{ profiles: LoadProfileDefaults[] }>(
        'GET',
        `/load-tests/profiles?vus=${vus}&durationSec=${durationSec}`,
      )
    ).profiles;
  }

  public async listLoadScenarios(signal?: AbortSignal): Promise<LoadScenario[]> {
    return (
      await this.apiTestRequest<{ scenarios: LoadScenario[] }>(
        'GET',
        '/load-tests/scenarios',
        undefined,
        signal,
      )
    ).scenarios;
  }

  public async saveLoadScenario(scenario: LoadScenarioInput, id?: string): Promise<LoadScenario> {
    return (
      await this.apiTestRequest<{ scenario: LoadScenario }>(
        id ? 'PUT' : 'POST',
        id ? `/load-tests/scenarios/${encodeURIComponent(id)}` : '/load-tests/scenarios',
        scenario,
      )
    ).scenario;
  }

  public async deleteLoadScenario(id: string): Promise<void> {
    await this.apiTestRequest('DELETE', `/load-tests/scenarios/${encodeURIComponent(id)}`);
  }

  public async exportLoadScenarioK6(id: string): Promise<{ fileName: string; body: string }> {
    return this.apiTestRequest('GET', `/load-tests/scenarios/${encodeURIComponent(id)}/k6`);
  }

  public async startLoadRun(input: {
    scenarioId: string;
    target: ApiRunTarget;
    authorized: boolean;
  }): Promise<ApiRun> {
    return (await this.apiTestRequest<{ run: ApiRun }>('POST', '/load-tests/runs', input)).run;
  }
}
