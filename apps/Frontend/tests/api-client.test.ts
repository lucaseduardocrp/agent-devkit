import { describe, expect, it, vi } from 'vitest';
import { ApiClient, ApiClientError } from '../src/lib/api-client.js';

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => body,
  } as Response;
}

function textResponse(text: string, ok = true, status = 200): Response {
  return {
    ok,
    status,
    text: async () => text,
  } as Response;
}

describe('ApiClient', () => {
  it('rejects an unexpected tunnel check response before it reaches the UI', async () => {
    const client = new ApiClient({
      fetcher: vi
        .fn()
        .mockResolvedValue(
          jsonResponse({ result: { reachable: false, reason: 'unknown', status: 200 } }),
        ),
    });

    await expect(client.checkE2eTunnel('https://sample.trycloudflare.com')).rejects.toThrow(
      'Unexpected tunnel check response.',
    );
  });

  it('checks tunnel reachability through the ADK API', async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe('http://localhost:3000/e2e/tunnel/check');
      expect(init?.method).toBe('POST');
      expect(JSON.parse(String(init?.body))).toEqual({ url: 'https://sample.trycloudflare.com' });
      return jsonResponse({ result: { reachable: true, reason: 'ok', status: 200 } });
    });
    const client = new ApiClient({ fetcher });
    await expect(client.checkE2eTunnel('https://sample.trycloudflare.com')).resolves.toEqual({
      reachable: true,
      reason: 'ok',
      status: 200,
    });
  });

  it('accepts a rejected Host header result from the tunnel check', async () => {
    const client = new ApiClient({
      fetcher: vi
        .fn()
        .mockResolvedValue(
          jsonResponse({ result: { reachable: false, reason: 'host_error', status: 200 } }),
        ),
    });
    await expect(client.checkE2eTunnel('https://sample.trycloudflare.com')).resolves.toEqual({
      reachable: false,
      reason: 'host_error',
      status: 200,
    });
  });
  it('pushes a native document to Azure and surfaces HTTP failures', async () => {
    const client = new ApiClient({
      fetcher: async (input, init) => {
        expect(String(input)).toBe('http://localhost:3000/knowledge/documents/doc-1/push');
        expect(init?.method).toBe('POST');
        return jsonResponse({ success: true, remoteUrl: 'https://dev.azure.com/wiki/page' });
      },
    });
    await expect(client.pushKnowledgeDocument('doc-1')).resolves.toMatchObject({ success: true });
    const failingClient = new ApiClient({ fetcher: async () => jsonResponse({}, false, 502) });
    await expect(failingClient.pushKnowledgeDocument('doc-1')).rejects.toMatchObject({
      status: 502,
    });
    const diagnosedClient = new ApiClient({
      fetcher: async () =>
        jsonResponse(
          {
            code: 'AZURE_WIKI_ERROR',
            message: 'Could not communicate with the Azure DevOps Wiki.',
            details: [{ stage: 'create-page', upstreamStatus: 400 }],
          },
          false,
          502,
        ),
    });
    await expect(diagnosedClient.pushKnowledgeDocument('doc-1')).rejects.toThrow(
      'Azure HTTP 400, create-page',
    );
    const networkClient = new ApiClient({
      fetcher: async () =>
        jsonResponse(
          {
            code: 'AZURE_WIKI_ERROR',
            message: 'Could not communicate with the Azure DevOps Wiki.',
            details: [{ stage: 'network' }],
          },
          false,
          502,
        ),
    });
    await expect(networkClient.pushKnowledgeDocument('doc-1')).rejects.toThrow('(network)');
  });

  it('synchronizes Wiki documents through the dedicated endpoint', async () => {
    const client = new ApiClient({
      fetcher: async (input, init) => {
        expect(String(input)).toBe('http://localhost:3000/knowledge/sync');
        expect(init?.method).toBe('POST');
        return jsonResponse({ success: true, provider: 'Azure DevOps Wiki', chunksCount: 2 });
      },
    });
    await expect(client.syncKnowledge()).resolves.toMatchObject({ chunksCount: 2 });
    const failingClient = new ApiClient({ fetcher: async () => jsonResponse({}, false, 503) });
    await expect(failingClient.syncKnowledge()).rejects.toMatchObject({ status: 503 });
  });
  describe('getHealth', () => {
    it('loads a valid health response', async () => {
      const client = new ApiClient({
        baseUrl: 'https://example.com',
        fetcher: async (input) => {
          expect(String(input)).toBe('https://example.com/health');
          return jsonResponse({ status: 'ok', requestId: 'request-1' });
        },
      });

      await expect(client.getHealth()).resolves.toEqual({
        status: 'ok',
        requestId: 'request-1',
      });
    });

    it('uses the default base URL', async () => {
      const client = new ApiClient({
        fetcher: async (input) => {
          expect(String(input)).toBe('http://localhost:3000/health');
          return jsonResponse({ status: 'ok', requestId: 'request-1' });
        },
      });
      await expect(client.getHealth()).resolves.toHaveProperty('status', 'ok');
    });

    it('rejects HTTP and invalid response failures', async () => {
      const failed = new ApiClient({ fetcher: async () => jsonResponse({}, false, 503) });
      await expect(failed.getHealth()).rejects.toMatchObject({ status: 503 });

      const invalidStatus = new ApiClient({
        fetcher: async () => jsonResponse({ status: 'down', requestId: 'r1' }),
      });
      await expect(invalidStatus.getHealth()).rejects.toMatchObject({ status: 502 });

      const invalidReqId = new ApiClient({
        fetcher: async () => jsonResponse({ status: 'ok', requestId: 123 }),
      });
      await expect(invalidReqId.getHealth()).rejects.toMatchObject({ status: 502 });

      expect(new ApiClientError(400, 'message')).toBeInstanceOf(Error);
    });
  });

  describe('getReadiness', () => {
    it('returns readiness data on status 200', async () => {
      const data = {
        status: 'ready',
        checks: [{ name: 'database:postgres', status: 'ready' }],
      };
      const client = new ApiClient({
        fetcher: async (input) => {
          expect(String(input)).toBe('http://localhost:3000/health/ready');
          return jsonResponse(data, true, 200);
        },
      });

      await expect(client.getReadiness()).resolves.toEqual(data);
    });

    it('returns readiness data on status 503 if response is valid not-ready', async () => {
      const data = {
        status: 'not-ready',
        checks: [{ name: 'database:postgres', status: 'not-ready' }],
      };
      const client = new ApiClient({
        fetcher: async () => jsonResponse(data, false, 503),
      });

      await expect(client.getReadiness()).resolves.toEqual(data);
    });

    it('throws ApiClientError when response status is neither 200 nor 503', async () => {
      const client = new ApiClient({
        fetcher: async () => jsonResponse({}, false, 500),
      });

      await expect(client.getReadiness()).rejects.toThrow('Falha de conexão com o servidor.');
    });

    it('throws 502 if status is unexpected', async () => {
      const client = new ApiClient({
        fetcher: async () => jsonResponse({ status: 'unknown', checks: [] }, true, 200),
      });

      await expect(client.getReadiness()).rejects.toMatchObject({ status: 502 });
    });

    it('throws 502 if checks is not an array', async () => {
      const client = new ApiClient({
        fetcher: async () => jsonResponse({ status: 'ready', checks: 'not-array' }, true, 200),
      });

      await expect(client.getReadiness()).rejects.toMatchObject({ status: 502 });
    });
  });

  describe('searchKnowledge', () => {
    it('throws 400 when prompt is empty or whitespace', async () => {
      const client = new ApiClient();
      await expect(client.searchKnowledge('   ')).rejects.toMatchObject({ status: 400 });
    });

    it('includes x-owner-id header if provided', async () => {
      let capturedHeaders: HeadersInit | undefined;
      const client = new ApiClient({
        fetcher: async (input, init) => {
          expect(String(input)).toContain('/TestPlan/search?prompt=test');
          capturedHeaders = init?.headers;
          return jsonResponse([]);
        },
      });

      const res = await client.searchKnowledge('test', 'my-owner');
      expect(res).toEqual([]);
      expect((capturedHeaders as Record<string, string>)['x-owner-id']).toBe('my-owner');
    });

    it('omits x-owner-id if ownerId is not provided or empty', async () => {
      let capturedHeaders: HeadersInit | undefined;
      const client = new ApiClient({
        fetcher: async (_input, init) => {
          capturedHeaders = init?.headers;
          return jsonResponse([]);
        },
      });

      await client.searchKnowledge('test', '  ');
      expect((capturedHeaders as Record<string, string>)['x-owner-id']).toBeUndefined();
    });

    it('returns empty array when status is 204 No Content', async () => {
      const client = new ApiClient({
        fetcher: async () =>
          ({
            status: 204,
            ok: true,
          }) as Response,
      });

      await expect(client.searchKnowledge('empty')).resolves.toEqual([]);
    });

    it('throws error when search request is not ok', async () => {
      const client = new ApiClient({
        fetcher: async () => jsonResponse({ error: 'Server error' }, false, 500),
      });

      await expect(client.searchKnowledge('query')).rejects.toMatchObject({ status: 500 });
    });

    it('throws 502 when response json is not an array', async () => {
      const client = new ApiClient({
        fetcher: async () => jsonResponse({ not: 'an-array' }, true, 200),
      });

      await expect(client.searchKnowledge('query')).rejects.toMatchObject({ status: 502 });
    });

    it('returns parsed chunks array on valid response', async () => {
      const mockChunks = [
        {
          source: 'doc1',
          pageId: 'p1',
          chunkIndex: 0,
          content: 'chunk content',
          createdAt: '2026-09-11',
        },
      ];
      const client = new ApiClient({
        fetcher: async () => jsonResponse(mockChunks, true, 200),
      });

      await expect(client.searchKnowledge('query')).resolves.toEqual(mockChunks);
    });
  });

  describe('generateTestPlanCsv', () => {
    it('throws 400 when prompt is empty or whitespace', async () => {
      const client = new ApiClient();
      await expect(client.generateTestPlanCsv('   ')).rejects.toMatchObject({ status: 400 });
    });

    it('sends POST request with prompt and trimmed title', async () => {
      let capturedInit: RequestInit | undefined;
      const client = new ApiClient({
        fetcher: async (input, init) => {
          expect(String(input)).toBe('http://localhost:3000/TestPlan/generate/csv');
          capturedInit = init;
          return textResponse('header1,header2\r\nval1,val2');
        },
      });

      const res = await client.generateTestPlanCsv('My prompt', '  My Title  ');
      expect(res).toBe('header1,header2\r\nval1,val2');
      expect(capturedInit?.method).toBe('POST');
      expect(JSON.parse(String(capturedInit?.body))).toEqual({
        prompt: 'My prompt',
        title: 'My Title',
      });
    });

    it('sends undefined title when title is empty or not provided', async () => {
      let capturedInit: RequestInit | undefined;
      const client = new ApiClient({
        fetcher: async (_input, init) => {
          capturedInit = init;
          return textResponse('csv-content');
        },
      });

      await client.generateTestPlanCsv('My prompt', '   ');
      expect(JSON.parse(String(capturedInit?.body))).toEqual({
        prompt: 'My prompt',
      });
    });

    it('throws error when generate request is not ok', async () => {
      const client = new ApiClient({
        fetcher: async () => textResponse('Bad request', false, 400),
      });

      await expect(client.generateTestPlanCsv('prompt')).rejects.toMatchObject({ status: 400 });
    });

    it('sends optional criteria, areaPath, assignedTo, and format in generateTestPlanCsv', async () => {
      let capturedInit: RequestInit | undefined;
      const client = new ApiClient({
        fetcher: async (_input, init) => {
          capturedInit = init;
          return textResponse('csv-content');
        },
      });

      await client.generateTestPlanCsv('Prompt', 'Title', undefined, {
        criteria: 'Crit',
        userPrompt: 'UP',
        areaPath: 'Area',
        assignedTo: 'Assignee',
        platformProvider: 'azure',
        llmProvider: 'ollama',
        format: 'azure',
        workspaceId: 'ws-123',
        agentId: 'agent-123',
      });

      expect((capturedInit?.headers as Record<string, string>)?.['x-workspace-id']).toBe('ws-123');
      expect(JSON.parse(String(capturedInit?.body))).toEqual({
        prompt: 'Prompt',
        title: 'Title',
        criteria: 'Crit',
        userPrompt: 'UP',
        areaPath: 'Area',
        assignedTo: 'Assignee',
        platformProvider: 'azure',
        llmProvider: 'ollama',
        format: 'azure',
        agentId: 'agent-123',
      });
    });
  });

  describe('generateTestPlan', () => {
    it('throws 400 when prompt is empty or whitespace', async () => {
      const client = new ApiClient();
      await expect(client.generateTestPlan('   ')).rejects.toMatchObject({ status: 400 });
    });

    it('sends POST request with full options and returns parsed response', async () => {
      let capturedInit: RequestInit | undefined;
      const mockResult = {
        plans: [
          {
            title: 'Test Scenario 1',
            description: 'Scenario description',
            steps: [{ order: 1, action: 'Step action', expectedResult: 'Expected result' }],
          },
        ],
        csv: 'ID,Title\r\n1,Test Scenario 1',
      };

      const client = new ApiClient({
        fetcher: async (input, init) => {
          expect(String(input)).toBe('http://localhost:3000/TestPlan/generate');
          capturedInit = init;
          return jsonResponse(mockResult, true, 200);
        },
      });

      const res = await client.generateTestPlan('Test prompt', {
        title: '  Plan Title  ',
        criteria: '  Criteria  ',
        userPrompt: '  User instruction  ',
        areaPath: '  Project/Area  ',
        assignedTo: '  User Assigned  ',
        platformProvider: '  azure  ',
        llmProvider: '  gemini  ',
        format: 'azure',
        workspaceId: '  ws-456  ',
        agentId: '  agent-qa-1  ',
      });

      expect(res).toEqual(mockResult);
      expect(capturedInit?.method).toBe('POST');
      expect((capturedInit?.headers as Record<string, string>)?.['x-workspace-id']).toBe('ws-456');
      expect(JSON.parse(String(capturedInit?.body))).toEqual({
        prompt: 'Test prompt',
        title: 'Plan Title',
        criteria: 'Criteria',
        userPrompt: 'User instruction',
        areaPath: 'Project/Area',
        assignedTo: 'User Assigned',
        platformProvider: 'azure',
        llmProvider: 'gemini',
        format: 'azure',
        agentId: 'agent-qa-1',
      });
    });

    it('throws error when server returns error status', async () => {
      const client = new ApiClient({
        fetcher: async () => jsonResponse({ message: 'Internal error' }, false, 500),
      });

      await expect(client.generateTestPlan('valid prompt')).rejects.toMatchObject({ status: 500 });
    });

    it('throws 502 when response body is invalid or missing plans array or csv', async () => {
      const client1 = new ApiClient({
        fetcher: async () => jsonResponse({ plans: 'not-an-array', csv: 'csv' }, true, 200),
      });
      await expect(client1.generateTestPlan('prompt')).rejects.toMatchObject({ status: 502 });

      const client2 = new ApiClient({
        fetcher: async () => jsonResponse({ plans: [] }, true, 200),
      });
      await expect(client2.generateTestPlan('prompt')).rejects.toMatchObject({ status: 502 });
    });
  });

  describe('token management and auth headers', () => {
    it('sets, gets, and injects bearer token in headers', async () => {
      let capturedInit: RequestInit | undefined;
      const client = new ApiClient({
        token: 'initial-token',
        fetcher: async (_url, init) => {
          capturedInit = init;
          return jsonResponse({ status: 'ok', requestId: 'r1' });
        },
      });

      expect(client.getToken()).toBe('initial-token');
      await client.getHealth();
      expect((capturedInit?.headers as Record<string, string>)?.authorization).toBe(
        'Bearer initial-token',
      );

      client.setToken('updated-token');
      expect(client.getToken()).toBe('updated-token');
      await client.getHealth();
      expect((capturedInit?.headers as Record<string, string>)?.authorization).toBe(
        'Bearer updated-token',
      );

      client.setToken(null);
      expect(client.getToken()).toBeNull();
      await client.getHealth();
      expect((capturedInit?.headers as Record<string, string>)?.authorization).toBeUndefined();
    });
  });

  describe('handleErrorResponse', () => {
    it('extracts custom message or error field from response', async () => {
      const withMessage = new ApiClient({
        fetcher: async () => jsonResponse({ message: 'Custom failure message' }, false, 400),
      });
      await expect(withMessage.getHealth()).rejects.toThrow('Custom failure message');

      const withErrorField = new ApiClient({
        fetcher: async () => jsonResponse({ error: 'Alternative error field' }, false, 422),
      });
      await expect(withErrorField.getHealth()).rejects.toThrow('Alternative error field');

      const withUnparseable = new ApiClient({
        fetcher: async () =>
          ({
            ok: false,
            status: 500,
            json: async () => {
              throw new Error('Not JSON');
            },
          }) as unknown as Response,
      });
      await expect(withUnparseable.getHealth()).rejects.toThrow('Falha de conexão com o servidor.');

      const englishClient = new ApiClient({
        locale: 'en-US',
        fetcher: async () => jsonResponse({}, false, 500),
      });
      await expect(englishClient.getHealth()).rejects.toThrow('Failed to communicate with server.');
    });
  });

  describe('Authentication methods', () => {
    const mockUser = {
      id: 'u-1',
      email: 'user@example.com',
      name: 'User One',
      createdAt: '2026-09-11T12:00:00Z',
    };

    it('login sets token and returns user on success', async () => {
      let capturedBody: unknown;
      const client = new ApiClient({
        fetcher: async (_url, init) => {
          capturedBody = JSON.parse(String(init?.body));
          return jsonResponse({ token: 'login-token', user: mockUser });
        },
      });

      const res = await client.login({ email: 'user@example.com', password: 'password123' });
      expect(res.token).toBe('login-token');
      expect(res.user).toEqual(mockUser);
      expect(client.getToken()).toBe('login-token');
      expect(capturedBody).toEqual({ email: 'user@example.com', password: 'password123' });
    });

    it('login throws ApiClientError on failure', async () => {
      const client = new ApiClient({
        fetcher: async () => jsonResponse({ message: 'Invalid credentials.' }, false, 401),
      });

      await expect(
        client.login({ email: 'user@example.com', password: 'bad' }),
      ).rejects.toMatchObject({ status: 401, message: 'Invalid credentials.' });
    });

    it('register authenticates the client immediately', async () => {
      const client = new ApiClient({
        fetcher: async () => jsonResponse({ token: 'reg-token', user: mockUser }, true, 201),
      });

      const res = await client.register({
        email: 'user@example.com',
        password: 'password123',
        name: 'User One',
      });
      expect(res.token).toBe('reg-token');
      expect(res.user.email).toBe('user@example.com');
      expect(client.getToken()).toBe('reg-token');
    });

    it('register throws ApiClientError on failure', async () => {
      const client = new ApiClient({
        fetcher: async () => jsonResponse({ message: 'Email already exists.' }, false, 409),
      });

      await expect(
        client.register({ email: 'user@example.com', password: 'password123' }),
      ).rejects.toMatchObject({ status: 409, message: 'Email already exists.' });
    });

    it('getMe returns current user on success', async () => {
      const client = new ApiClient({
        fetcher: async () => jsonResponse({ user: mockUser }),
      });

      const user = await client.getMe();
      expect(user).toEqual(mockUser);
    });

    it('getMe throws ApiClientError on failure', async () => {
      const client = new ApiClient({
        fetcher: async () => jsonResponse({ message: 'Unauthorized' }, false, 401),
      });

      await expect(client.getMe()).rejects.toMatchObject({ status: 401 });
    });

    it('logout clears client token and calls backend', async () => {
      const client = new ApiClient({
        token: 'active-token',
        fetcher: async () => jsonResponse({ success: true }),
      });

      await client.logout();
      expect(client.getToken()).toBeNull();
    });

    it('logout clears client token even when backend request fails', async () => {
      const client = new ApiClient({
        token: 'active-token',
        fetcher: async () => {
          throw new Error('Network failure');
        },
      });

      await expect(client.logout()).rejects.toThrow('Network failure');
      expect(client.getToken()).toBeNull();
    });
  });

  describe('Integrations methods', () => {
    const mockIntegration = {
      id: 'i-1',
      category: 'LLM' as const,
      providerId: 'gemini',
      isEnabled: true,
      settings: { model: 'gemini-1.5-flash' },
      hasSecret: true,
      maskedSecret: '••••••••',
      updatedAt: '2026-09-11T12:00:00Z',
    };

    it('getIntegrations returns integration list on success', async () => {
      const client = new ApiClient({
        fetcher: async () => jsonResponse({ integrations: [mockIntegration] }),
      });

      const result = await client.getIntegrations();
      expect(result).toHaveLength(1);
      expect(result[0]?.providerId).toBe('gemini');
    });

    it('getIntegrations throws ApiClientError on failure', async () => {
      const client = new ApiClient({
        fetcher: async () => jsonResponse({}, false, 403),
      });

      await expect(client.getIntegrations()).rejects.toMatchObject({ status: 403 });
    });

    it('saveIntegration sends PUT and returns updated integration', async () => {
      let capturedMethod: string | undefined;
      let capturedBody: unknown;
      const client = new ApiClient({
        fetcher: async (url, init) => {
          expect(String(url)).toBe('http://localhost:3000/integrations/LLM/gemini');
          capturedMethod = init?.method;
          capturedBody = JSON.parse(String(init?.body));
          return jsonResponse({ integration: mockIntegration });
        },
      });

      const result = await client.saveIntegration('LLM', 'gemini', {
        isEnabled: true,
        settings: { model: 'gemini-1.5-flash' },
        secret: 'api-key-123',
      });
      expect(capturedMethod).toBe('PUT');
      expect(capturedBody).toEqual({
        isEnabled: true,
        settings: { model: 'gemini-1.5-flash' },
        secret: 'api-key-123',
      });
      expect(result).toEqual(mockIntegration);
    });

    it('saveIntegration throws ApiClientError on failure', async () => {
      const client = new ApiClient({
        fetcher: async () => jsonResponse({ message: 'Validation failed' }, false, 400),
      });

      await expect(client.saveIntegration('LLM', 'gemini', {})).rejects.toMatchObject({
        status: 400,
        message: 'Validation failed',
      });
    });

    it('deleteIntegration sends DELETE request', async () => {
      let capturedMethod: string | undefined;
      const client = new ApiClient({
        fetcher: async (url, init) => {
          expect(String(url)).toBe('http://localhost:3000/integrations/LLM/gemini');
          capturedMethod = init?.method;
          return jsonResponse({ success: true });
        },
      });

      await client.deleteIntegration('LLM', 'gemini');
      expect(capturedMethod).toBe('DELETE');
    });

    it('deleteIntegration throws ApiClientError on failure', async () => {
      const client = new ApiClient({
        fetcher: async () => jsonResponse({}, false, 404),
      });

      await expect(client.deleteIntegration('LLM', 'gemini')).rejects.toMatchObject({
        status: 404,
      });
    });

    it('testIntegration probes connectivity with and without payload', async () => {
      let capturedBody: unknown;
      const client = new ApiClient({
        fetcher: async (_url, init) => {
          capturedBody = JSON.parse(String(init?.body));
          return jsonResponse({ ok: true, message: 'Connected successfully.' });
        },
      });

      const resWithPayload = await client.testIntegration('LLM', 'gemini', {
        settings: { model: 'test' },
        secret: 'sec',
      });
      expect(resWithPayload.ok).toBe(true);
      expect(capturedBody).toEqual({ settings: { model: 'test' }, secret: 'sec' });

      const resWithoutPayload = await client.testIntegration('LLM', 'gemini');
      expect(resWithoutPayload.ok).toBe(true);
      expect(capturedBody).toEqual({});
    });

    it('testIntegration throws ApiClientError on failure', async () => {
      const client = new ApiClient({
        fetcher: async () => jsonResponse({ message: 'Connection timed out' }, false, 504),
      });

      await expect(client.testIntegration('LLM', 'gemini')).rejects.toMatchObject({
        status: 504,
        message: 'Connection timed out',
      });
    });

    it('uses defaultFetch invoking global fetch when no fetcher is supplied', async () => {
      const fetchSpy = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(jsonResponse({ status: 'ok', requestId: 'req-default' }));
      const client = new ApiClient();
      const res = await client.getHealth();
      expect(res.status).toBe('ok');
      expect(fetchSpy).toHaveBeenCalled();
      fetchSpy.mockRestore();
    });

    it('getIntegrations handles raw array from backend', async () => {
      const client = new ApiClient({
        fetcher: async () => jsonResponse([mockIntegration]),
      });
      const res = await client.getIntegrations();
      expect(res).toHaveLength(1);
      expect(res[0]?.providerId).toBe('gemini');
    });

    it('saveIntegration handles raw object from backend', async () => {
      const client = new ApiClient({
        fetcher: async () => jsonResponse(mockIntegration),
      });
      const res = await client.saveIntegration('LLM', 'gemini', {});
      expect(res.providerId).toBe('gemini');
    });

    it('getAzureDevOpsProjectMembers returns members payload on success', async () => {
      const mockResult = {
        configured: true,
        organization: 'my-org',
        project: 'my-project',
        members: [{ id: 'user-1', displayName: 'John Doe', email: 'john@example.com' }],
      };
      const client = new ApiClient({
        fetcher: async (url) => {
          expect(String(url)).toBe('http://localhost:3000/integrations/azure-devops/members');
          return jsonResponse(mockResult);
        },
      });

      const res = await client.getAzureDevOpsProjectMembers();
      expect(res).toEqual(mockResult);
    });

    it('requests Azure Test Case options when needed', async () => {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
        jsonResponse({
          configured: true,
          organization: 'org',
          project: 'project',
          members: [],
          areaPaths: ['project\\team'],
          states: ['Design'],
        }),
      );
      const client = new ApiClient({ fetcher });

      await client.getAzureDevOpsProjectMembers(undefined, true);

      expect(fetcher).toHaveBeenCalledWith(
        'http://localhost:3000/integrations/azure-devops/members?testOptions=true',
        expect.objectContaining({ signal: undefined }),
      );
    });

    it('getAzureDevOpsProjectMembers throws ApiClientError on failure', async () => {
      const client = new ApiClient({
        fetcher: async () => jsonResponse({ message: 'Falha no Azure' }, false, 502),
      });

      await expect(client.getAzureDevOpsProjectMembers()).rejects.toMatchObject({
        status: 502,
        message: 'Falha no Azure',
      });
    });
  });

  describe('Knowledge sync and stats', () => {
    it('syncKnowledge invokes POST /knowledge/sync and returns result', async () => {
      let capturedMethod: string | undefined;
      const client = new ApiClient({
        fetcher: async (url, init) => {
          expect(String(url)).toBe('http://localhost:3000/knowledge/sync');
          capturedMethod = init?.method;
          return jsonResponse({
            success: true,
            provider: 'azure_devops_wiki',
            chunksCount: 15,
          });
        },
      });

      const res = await client.syncKnowledge();
      expect(capturedMethod).toBe('POST');
      expect(res).toEqual({
        success: true,
        provider: 'azure_devops_wiki',
        chunksCount: 15,
      });
    });

    it('syncKnowledge throws ApiClientError on failure', async () => {
      const client = new ApiClient({
        fetcher: async () => jsonResponse({ message: 'Nenhum provedor ativo.' }, false, 400),
      });

      await expect(client.syncKnowledge()).rejects.toMatchObject({
        status: 400,
        message: 'Nenhum provedor ativo.',
      });
    });

    it('getKnowledgeStats invokes GET /knowledge/stats and returns stats', async () => {
      const client = new ApiClient({
        fetcher: async (url) => {
          expect(String(url)).toBe('http://localhost:3000/knowledge/stats');
          return jsonResponse({ documentsCount: 5, chunksCount: 42 });
        },
      });

      const stats = await client.getKnowledgeStats();
      expect(stats).toEqual({ documentsCount: 5, chunksCount: 42 });
    });

    it('getKnowledgeStats forwards x-owner-id header when supplied', async () => {
      let capturedHeaders: HeadersInit | undefined;
      const client = new ApiClient({
        fetcher: async (_url, init) => {
          capturedHeaders = init?.headers;
          return jsonResponse({ documentsCount: 1, chunksCount: 1 });
        },
      });

      await client.getKnowledgeStats('owner-test-123');
      expect((capturedHeaders as Record<string, string>)['x-owner-id']).toBe('owner-test-123');
    });

    it('getKnowledgeStats throws ApiClientError on failure', async () => {
      const client = new ApiClient({
        fetcher: async () => jsonResponse({}, false, 500),
      });

      await expect(client.getKnowledgeStats()).rejects.toMatchObject({
        status: 500,
      });
    });

    it('getKnowledgeDocuments invokes GET /knowledge/documents and returns documents list', async () => {
      const mockDocs = [
        {
          id: 'doc-1',
          pageId: 'page-1',
          source: 'https://dev.azure.com/org/proj/wiki',
          title: 'Wiki Title',
          chunksCount: 4,
          totalCharacters: 1200,
          updatedAt: '2026-09-11T12:00:00.000Z',
        },
      ];
      let capturedHeaders: HeadersInit | undefined;
      const client = new ApiClient({
        fetcher: async (url, init) => {
          expect(String(url)).toBe('http://localhost:3000/knowledge/documents');
          capturedHeaders = init?.headers;
          return jsonResponse({ documents: mockDocs });
        },
      });

      const docs = await client.getKnowledgeDocuments('owner-docs-456');
      expect(docs).toEqual(mockDocs);
      expect((capturedHeaders as Record<string, string>)['x-owner-id']).toBe('owner-docs-456');
    });

    it('getKnowledgeDocuments throws ApiClientError on failure', async () => {
      const client = new ApiClient({
        fetcher: async () => jsonResponse({}, false, 500),
      });

      await expect(client.getKnowledgeDocuments()).rejects.toMatchObject({
        status: 500,
      });
    });

    it('manages user-defined knowledge correlations', async () => {
      const relation = { sourcePageId: 'doc-1', targetPageId: 'doc-2', createdAt: 'now' };
      const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(jsonResponse({ relations: [relation] }))
        .mockResolvedValueOnce(jsonResponse({ relations: [relation] }, true, 201))
        .mockResolvedValueOnce(new Response(null, { status: 204 }));
      const client = new ApiClient({ fetcher });

      await expect(client.getKnowledgeRelations()).resolves.toEqual([relation]);
      await expect(client.createKnowledgeRelation('doc-1', 'doc-2')).resolves.toEqual([relation]);
      await client.deleteKnowledgeRelation('doc-1', 'doc-2');
      expect(fetcher).toHaveBeenLastCalledWith(
        expect.stringContaining('sourcePageId=doc-1&targetPageId=doc-2'),
        expect.objectContaining({ method: 'DELETE' }),
      );

      const failing = new ApiClient({
        fetcher: async () => jsonResponse({ message: 'relation failed' }, false, 500),
      });
      await expect(failing.getKnowledgeRelations()).rejects.toThrow('relation failed');
      await expect(failing.createKnowledgeRelation('a', 'b')).rejects.toThrow('relation failed');
      await expect(failing.deleteKnowledgeRelation('a', 'b')).rejects.toThrow('relation failed');
    });

    it('createKnowledgeDocument creates document on success and throws on failure', async () => {
      const mockDoc = {
        id: 'app://local:doc-1',
        pageId: 'doc-1',
        source: 'app://local?title=New',
        title: 'New',
        content: '# New',
        chunksCount: 1,
        totalCharacters: 5,
        updatedAt: '2026-09-12T12:00:00Z',
        isCustom: true,
      };

      const client = new ApiClient({
        fetcher: async (url, init) => {
          expect(String(url)).toBe('http://localhost:3000/knowledge/documents');
          expect(init?.method).toBe('POST');
          return jsonResponse({ document: mockDoc });
        },
      });

      const res = await client.createKnowledgeDocument('New', '# New');
      expect(res).toEqual(mockDoc);
      const nestedClient = new ApiClient({
        fetcher: async (_url, init) => {
          expect(JSON.parse(String(init?.body))).toEqual({
            title: 'Child',
            content: '# Child',
            parentPageId: 'doc-parent',
          });
          return jsonResponse({ document: mockDoc });
        },
      });
      await nestedClient.createKnowledgeDocument('Child', '# Child', undefined, 'doc-parent');

      const failingClient = new ApiClient({
        fetcher: async () => jsonResponse({ message: 'Error' }, false, 400),
      });
      await expect(failingClient.createKnowledgeDocument('', '')).rejects.toMatchObject({
        status: 400,
      });
    });

    it('updateKnowledgeDocument updates document on success and throws on failure', async () => {
      const mockDoc = {
        id: 'app://local:doc-1',
        pageId: 'doc-1',
        source: 'app://local?title=Updated',
        title: 'Updated',
        content: '# Updated',
        chunksCount: 1,
        totalCharacters: 9,
        updatedAt: '2026-09-12T12:00:00Z',
        isCustom: true,
      };

      const client = new ApiClient({
        fetcher: async (url, init) => {
          expect(String(url)).toBe('http://localhost:3000/knowledge/documents/doc-1');
          expect(init?.method).toBe('PUT');
          return jsonResponse({ document: mockDoc });
        },
      });

      const res = await client.updateKnowledgeDocument('doc-1', 'Updated', '# Updated');
      expect(res).toEqual(mockDoc);

      const failingClient = new ApiClient({
        fetcher: async () => jsonResponse({ message: 'Error' }, false, 400),
      });
      await expect(failingClient.updateKnowledgeDocument('doc-1', '', '')).rejects.toMatchObject({
        status: 400,
      });
    });

    it('deleteKnowledgeDocument deletes document with optional source query and throws on failure', async () => {
      let capturedUrl = '';
      const client = new ApiClient({
        fetcher: async (url, init) => {
          capturedUrl = String(url);
          expect(init?.method).toBe('DELETE');
          return jsonResponse({ success: true });
        },
      });

      await client.deleteKnowledgeDocument('doc-1', 'app://local');
      expect(capturedUrl).toContain('source=app%3A%2F%2Flocal');

      await client.deleteKnowledgeDocument('doc-2');
      expect(capturedUrl).not.toContain('source=');

      const failingClient = new ApiClient({
        fetcher: async () => jsonResponse({ message: 'Error' }, false, 404),
      });
      await expect(failingClient.deleteKnowledgeDocument('non-existent')).rejects.toMatchObject({
        status: 404,
      });
    });
  });

  describe('workspaces management', () => {
    it('sets, gets, and injects x-workspace-id header in requests', async () => {
      let capturedInit: RequestInit | undefined;
      const client = new ApiClient({
        workspaceId: 'ws-init',
        fetcher: async (_url, init) => {
          capturedInit = init;
          return jsonResponse({ status: 'ok', requestId: 'r1' });
        },
      });

      expect(client.getWorkspaceId()).toBe('ws-init');
      await client.getHealth();
      expect((capturedInit?.headers as Record<string, string>)?.['x-workspace-id']).toBe('ws-init');

      client.setWorkspaceId('ws-2');
      expect(client.getWorkspaceId()).toBe('ws-2');
      await client.getHealth();
      expect((capturedInit?.headers as Record<string, string>)?.['x-workspace-id']).toBe('ws-2');

      client.setWorkspaceId(null);
      expect(client.getWorkspaceId()).toBeNull();
      await client.getHealth();
      expect((capturedInit?.headers as Record<string, string>)?.['x-workspace-id']).toBeUndefined();
    });

    it('getWorkspaces returns list of memberships and throws on error', async () => {
      const mockList = [
        {
          workspace: { id: 'w1', name: 'Work 1', slug: 'w1', ownerId: 'u1', createdAt: '' },
          member: {
            id: 'm1',
            workspaceId: 'w1',
            userId: 'u1',
            role: 'ADMIN',
            permissions: {},
            createdAt: '',
          },
        },
      ];
      const client = new ApiClient({
        fetcher: async (url) => {
          expect(String(url)).toBe('http://localhost:3000/workspaces');
          return jsonResponse(mockList);
        },
      });

      const res = await client.getWorkspaces();
      expect(res).toEqual(mockList);

      const failing = new ApiClient({
        fetcher: async () => jsonResponse({ message: 'Fail' }, false, 500),
      });
      await expect(failing.getWorkspaces()).rejects.toMatchObject({ status: 500 });
    });

    it('createWorkspace posts data and returns created membership or throws', async () => {
      const mockCreated = {
        workspace: { id: 'w2', name: 'New WS', slug: 'new-ws', ownerId: 'u1', createdAt: '' },
        member: {
          id: 'm2',
          workspaceId: 'w2',
          userId: 'u1',
          role: 'ADMIN',
          permissions: {},
          createdAt: '',
        },
      };
      const client = new ApiClient({
        fetcher: async (url, init) => {
          expect(String(url)).toBe('http://localhost:3000/workspaces');
          expect(init?.method).toBe('POST');
          expect(JSON.parse(String(init?.body))).toEqual({ name: 'New WS' });
          return jsonResponse(mockCreated);
        },
      });

      const res = await client.createWorkspace({ name: 'New WS' });
      expect(res).toEqual(mockCreated);

      const failing = new ApiClient({
        fetcher: async () => jsonResponse({ message: 'Invalid' }, false, 400),
      });
      await expect(failing.createWorkspace({ name: '' })).rejects.toMatchObject({ status: 400 });
    });

    it('getWorkspaceMembers returns members or throws on error', async () => {
      const mockMembers = [
        {
          id: 'm1',
          workspaceId: 'w1',
          userId: 'u1',
          role: 'ADMIN',
          permissions: {},
          createdAt: '',
        },
      ];
      const client = new ApiClient({
        fetcher: async (url) => {
          expect(String(url)).toBe('http://localhost:3000/workspaces/w1/members');
          return jsonResponse(mockMembers);
        },
      });

      const res = await client.getWorkspaceMembers('w1');
      expect(res).toEqual(mockMembers);

      const failing = new ApiClient({
        fetcher: async () => jsonResponse({ message: 'Forbidden' }, false, 403),
      });
      await expect(failing.getWorkspaceMembers('w1')).rejects.toMatchObject({ status: 403 });
    });

    it('addWorkspaceMember posts member data and returns created member or throws', async () => {
      const mockMember = {
        id: 'm-new',
        workspaceId: 'w1',
        userId: 'u2',
        role: 'MEMBER' as const,
        permissions: {},
        createdAt: '',
      };
      const client = new ApiClient({
        fetcher: async (url, init) => {
          expect(String(url)).toBe('http://localhost:3000/workspaces/w1/members');
          expect(init?.method).toBe('POST');
          expect(JSON.parse(String(init?.body))).toEqual({
            email: 'user@test.com',
            role: 'MEMBER',
          });
          return jsonResponse(mockMember);
        },
      });

      const res = await client.addWorkspaceMember('w1', { email: 'user@test.com', role: 'MEMBER' });
      expect(res).toEqual(mockMember);

      const failing = new ApiClient({
        fetcher: async () => jsonResponse({ message: 'Conflict' }, false, 409),
      });
      await expect(
        failing.addWorkspaceMember('w1', { email: 'user@test.com', role: 'MEMBER' }),
      ).rejects.toMatchObject({ status: 409 });
    });

    it('updateWorkspaceMember patches member and returns updated member or throws', async () => {
      const updatedMember = {
        id: 'm1',
        workspaceId: 'w1',
        userId: 'u1',
        role: 'INTEGRATOR' as const,
        permissions: {},
        createdAt: '',
      };
      const client = new ApiClient({
        fetcher: async (url, init) => {
          expect(String(url)).toBe('http://localhost:3000/workspaces/w1/members/m1');
          expect(init?.method).toBe('PATCH');
          expect(JSON.parse(String(init?.body))).toEqual({ role: 'INTEGRATOR' });
          return jsonResponse(updatedMember);
        },
      });

      const res = await client.updateWorkspaceMember('w1', 'm1', { role: 'INTEGRATOR' });
      expect(res).toEqual(updatedMember);

      const failing = new ApiClient({
        fetcher: async () => jsonResponse({ message: 'Error' }, false, 400),
      });
      await expect(
        failing.updateWorkspaceMember('w1', 'm1', { role: 'INTEGRATOR' }),
      ).rejects.toMatchObject({ status: 400 });
    });

    it('removeWorkspaceMember sends DELETE and returns success or throws', async () => {
      const client = new ApiClient({
        fetcher: async (url, init) => {
          expect(String(url)).toBe('http://localhost:3000/workspaces/w1/members/m1');
          expect(init?.method).toBe('DELETE');
          return jsonResponse({ success: true });
        },
      });

      const res = await client.removeWorkspaceMember('w1', 'm1');
      expect(res).toEqual({ success: true });

      const failing = new ApiClient({
        fetcher: async () => jsonResponse({ message: 'Cannot remove last admin' }, false, 400),
      });
      await expect(failing.removeWorkspaceMember('w1', 'm1')).rejects.toMatchObject({
        status: 400,
      });
    });

    it('deleteWorkspace sends DELETE to /workspaces/:id and returns success or throws', async () => {
      const client = new ApiClient({
        fetcher: async (url, init) => {
          expect(String(url)).toBe('http://localhost:3000/workspaces/w1');
          expect(init?.method).toBe('DELETE');
          return jsonResponse({ success: true });
        },
      });

      const res = await client.deleteWorkspace('w1');
      expect(res).toEqual({ success: true });

      const failing = new ApiClient({
        fetcher: async () => jsonResponse({ message: 'Forbidden' }, false, 403),
      });
      await expect(failing.deleteWorkspace('w1')).rejects.toMatchObject({
        status: 403,
      });
    });
  });

  describe('Agents API', () => {
    const mockAgent = {
      id: 'agent-1',
      workspaceId: 'w1',
      name: 'QA Specialist',
      slug: 'qa-specialist',
      description: 'Expert QA agent',
      instructions: '# QA instructions',
      role: 'QA' as const,
      model: 'gemini-2.5-flash',
      temperature: 0.2,
      isSystem: false,
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    };

    it('getAgents fetches agent list or throws ApiClientError', async () => {
      const client = new ApiClient({
        fetcher: async (url) => {
          expect(String(url)).toBe('http://localhost:3000/agents');
          return jsonResponse([mockAgent]);
        },
      });

      const res = await client.getAgents();
      expect(res).toEqual([mockAgent]);

      const clientWrapped = new ApiClient({
        fetcher: async () => jsonResponse({ agents: [mockAgent] }),
      });
      const resWrapped = await clientWrapped.getAgents();
      expect(resWrapped).toEqual([mockAgent]);

      const clientEmpty = new ApiClient({
        fetcher: async () => jsonResponse({}),
      });
      const resEmpty = await clientEmpty.getAgents();
      expect(resEmpty).toEqual([]);

      const failing = new ApiClient({
        fetcher: async () => jsonResponse({ message: 'Failed to load' }, false, 500),
      });
      await expect(failing.getAgents()).rejects.toMatchObject({ status: 500 });
    });

    it('getAgent fetches single agent by id or throws ApiClientError', async () => {
      const client = new ApiClient({
        fetcher: async (url) => {
          expect(String(url)).toBe('http://localhost:3000/agents/agent%201');
          return jsonResponse(mockAgent);
        },
      });

      const res = await client.getAgent('agent 1');
      expect(res).toEqual(mockAgent);

      const clientWrapped = new ApiClient({
        fetcher: async () => jsonResponse({ agent: mockAgent }),
      });
      const resWrapped = await clientWrapped.getAgent('agent 1');
      expect(resWrapped).toEqual(mockAgent);

      const failing = new ApiClient({
        fetcher: async () => jsonResponse({ message: 'Not found' }, false, 404),
      });
      await expect(failing.getAgent('agent-missing')).rejects.toMatchObject({ status: 404 });
    });

    it('createAgent sends POST /agents and returns created agent', async () => {
      let capturedBody: unknown;
      const client = new ApiClient({
        fetcher: async (url, init) => {
          expect(String(url)).toBe('http://localhost:3000/agents');
          expect(init?.method).toBe('POST');
          capturedBody = JSON.parse(String(init?.body));
          return jsonResponse(mockAgent);
        },
      });

      const payload = {
        name: 'QA Specialist',
        instructions: '# QA instructions',
        role: 'QA' as const,
      };
      const res = await client.createAgent(payload);
      expect(res).toEqual(mockAgent);
      expect(capturedBody).toEqual(payload);

      const clientWrapped = new ApiClient({
        fetcher: async () => jsonResponse({ agent: mockAgent }),
      });
      const resWrapped = await clientWrapped.createAgent(payload);
      expect(resWrapped).toEqual(mockAgent);

      const failing = new ApiClient({
        fetcher: async () => jsonResponse({ message: 'Validation failed' }, false, 400),
      });
      await expect(failing.createAgent(payload)).rejects.toMatchObject({ status: 400 });
    });

    it('updateAgent sends PUT /agents/:id and returns updated agent', async () => {
      let capturedBody: unknown;
      const client = new ApiClient({
        fetcher: async (url, init) => {
          expect(String(url)).toBe('http://localhost:3000/agents/agent-1');
          expect(init?.method).toBe('PUT');
          capturedBody = JSON.parse(String(init?.body));
          return jsonResponse({ ...mockAgent, name: 'Updated QA' });
        },
      });

      const updateData = { name: 'Updated QA' };
      const res = await client.updateAgent('agent-1', updateData);
      expect(res.name).toBe('Updated QA');
      expect(capturedBody).toEqual(updateData);

      const clientWrapped = new ApiClient({
        fetcher: async () => jsonResponse({ agent: { ...mockAgent, name: 'Updated QA' } }),
      });
      const resWrapped = await clientWrapped.updateAgent('agent-1', updateData);
      expect(resWrapped.name).toBe('Updated QA');

      const failing = new ApiClient({
        fetcher: async () => jsonResponse({ message: 'Error' }, false, 400),
      });
      await expect(failing.updateAgent('agent-1', updateData)).rejects.toMatchObject({
        status: 400,
      });
    });

    it('deleteAgent sends DELETE /agents/:id and returns success', async () => {
      const client = new ApiClient({
        fetcher: async (url, init) => {
          expect(String(url)).toBe('http://localhost:3000/agents/agent-1');
          expect(init?.method).toBe('DELETE');
          return jsonResponse({ success: true });
        },
      });

      const res = await client.deleteAgent('agent-1');
      expect(res).toEqual({ success: true });

      const failing = new ApiClient({
        fetcher: async () => jsonResponse({ message: 'Cannot delete' }, false, 400),
      });
      await expect(failing.deleteAgent('agent-1')).rejects.toMatchObject({ status: 400 });
    });

    it('executeAgent sends POST /agents/:id/execute and returns output', async () => {
      const mockExecutionResponse = {
        content: '# Generated Test Plan\n- Step 1: verify login',
        agent: { id: 'agent-1', name: 'QA Specialist', role: 'QA' as const },
        chunksUsed: 3,
      };

      let capturedBody: unknown;
      const client = new ApiClient({
        fetcher: async (url, init) => {
          expect(String(url)).toBe('http://localhost:3000/agents/agent-1/execute');
          expect(init?.method).toBe('POST');
          capturedBody = JSON.parse(String(init?.body));
          return jsonResponse(mockExecutionResponse);
        },
      });

      const execPayload = { prompt: 'Test login flow', useKnowledge: true };
      const res = await client.executeAgent('agent-1', execPayload);
      expect(res).toEqual(mockExecutionResponse);
      expect(capturedBody).toEqual(execPayload);

      const realContractClient = new ApiClient({
        fetcher: async () =>
          jsonResponse({
            result: '# Resposta real do Agent',
            agent: {
              id: 'agent-1',
              name: 'QA Specialist',
              role: 'QA',
              workspaceId: 'ws-1',
            },
            provider: 'Gemini',
          }),
      });
      await expect(realContractClient.executeAgent('agent-1', execPayload)).resolves.toEqual({
        content: '# Resposta real do Agent',
        agent: { id: 'agent-1', name: 'QA Specialist', role: 'QA' },
        chunksUsed: 0,
        provider: 'Gemini',
      });

      const malformed = new ApiClient({
        fetcher: async () => jsonResponse({ result: null, agent: {} }),
      });
      await expect(malformed.executeAgent('agent-1', execPayload)).rejects.toMatchObject({
        status: 502,
      });

      const malformedBody = new ApiClient({ fetcher: async () => jsonResponse(null) });
      await expect(malformedBody.executeAgent('agent-1', execPayload)).rejects.toMatchObject({
        status: 502,
      });

      const malformedAgent = new ApiClient({
        fetcher: async () => jsonResponse({ content: 'result', agent: { id: 1 } }),
      });
      await expect(malformedAgent.executeAgent('agent-1', execPayload)).rejects.toMatchObject({
        status: 502,
      });

      const failing = new ApiClient({
        fetcher: async () =>
          jsonResponse({ message: 'Prompt injection attempt detected' }, false, 400),
      });
      await expect(failing.executeAgent('agent-1', execPayload)).rejects.toMatchObject({
        status: 400,
      });
    });
  });

  describe('locale management and regional headers', () => {
    it('defaults to pt-BR and allows configuring locale', async () => {
      const client = new ApiClient();
      expect(client.getLocale()).toBe('pt-BR');

      client.setLocale('en-US');
      expect(client.getLocale()).toBe('en-US');

      const customClient = new ApiClient({ locale: 'en-US' });
      expect(customClient.getLocale()).toBe('en-US');
    });

    it('injects x-locale and Accept-Language headers in outgoing requests', async () => {
      let capturedHeaders: Record<string, string> | undefined;
      const client = new ApiClient({
        locale: 'en-US',
        fetcher: async (_url, init) => {
          capturedHeaders = init?.headers as Record<string, string>;
          return jsonResponse({ status: 'ok', requestId: 'req-1' });
        },
      });

      await client.getHealth();
      expect(capturedHeaders).toBeDefined();
      expect(capturedHeaders?.['x-locale']).toBe('en-US');
      expect(capturedHeaders?.['Accept-Language']).toBe('en-US');
    });
  });

  it('lists and updates persisted Test Plans', async () => {
    const saved = {
      id: 'p1',
      workspaceId: 'w1',
      title: 'Plan',
      plans: [],
      createdAt: '2026-01-01',
      updatedAt: '2026-01-01',
    };
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({ items: [saved], page: 1, pageSize: 10, total: 1, totalPages: 1 }),
      )
      .mockResolvedValueOnce(jsonResponse(saved))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const client = new ApiClient({ fetcher, workspaceId: 'w1' });
    await expect(client.getSavedTestPlans()).resolves.toEqual({
      items: [saved],
      page: 1,
      pageSize: 10,
      total: 1,
      totalPages: 1,
    });
    expect(fetcher).toHaveBeenLastCalledWith(
      expect.stringContaining('/TestPlan?page=1&pageSize=10'),
      expect.anything(),
    );
    await expect(client.updateSavedTestPlan('p1', { title: 'Plan', plans: [] })).resolves.toEqual(
      saved,
    );
    expect(fetcher).toHaveBeenLastCalledWith(
      expect.stringContaining('/TestPlan/p1'),
      expect.objectContaining({ method: 'PUT' }),
    );
    await expect(client.deleteSavedTestPlan('p1')).resolves.toBeUndefined();
    expect(fetcher).toHaveBeenLastCalledWith(
      expect.stringContaining('/TestPlan/p1'),
      expect.objectContaining({ method: 'DELETE' }),
    );

    const failing = new ApiClient({
      fetcher: async () => jsonResponse({ message: 'fail' }, false, 500),
    });
    await expect(failing.getSavedTestPlans()).rejects.toThrow('fail');
    await expect(failing.updateSavedTestPlan('p1', { title: 'x', plans: [] })).rejects.toThrow(
      'fail',
    );
    await expect(failing.deleteSavedTestPlan('p1')).rejects.toThrow('fail');
    const invalid = new ApiClient({ fetcher: async () => jsonResponse({}) });
    await expect(invalid.getSavedTestPlans()).rejects.toThrow('inválida');
  });

  it('manages Spec templates, specifications, chat, and markdown export', async () => {
    const responses = [
      jsonResponse([]),
      jsonResponse({ id: 't1' }),
      jsonResponse({ id: 't1' }),
      new Response(null, { status: 204 }),
      jsonResponse([]),
      jsonResponse({ id: 's1' }),
      jsonResponse({ id: 's1' }),
      jsonResponse({ id: 's1', messages: [] }),
      new Response(null, { status: 204 }),
      new Response('# Spec'),
    ];
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => responses.shift()!);
    const client = new ApiClient({ fetcher });
    await client.getSpecTemplates();
    await client.saveSpecTemplate({ name: 'T', sections: [] });
    await client.saveSpecTemplate({ id: 't1', name: 'T', sections: [] });
    await client.deleteSpecTemplate('t1');
    await client.getSpecifications();
    await client.saveSpecification({ title: 'S', sections: [] });
    await client.saveSpecification({ id: 's1', title: 'S', sections: [] });
    await client.chatSpecification('s1', 'a1', 'Oi');
    await client.deleteSpecification('s1');
    await expect(client.exportSpecification('s1')).resolves.toBe('# Spec');

    const failing = new ApiClient({
      fetcher: async () => jsonResponse({ message: 'no' }, false, 500),
    });
    await expect(failing.getSpecTemplates()).rejects.toThrow('no');
    await expect(failing.saveSpecTemplate({ name: 'T', sections: [] })).rejects.toThrow('no');
    await expect(failing.deleteSpecTemplate('t1')).rejects.toThrow('no');
    await expect(failing.exportSpecification('s1')).rejects.toThrow('no');
    await expect(failing.deleteSpecification('s1')).rejects.toThrow('no');
  });
});
