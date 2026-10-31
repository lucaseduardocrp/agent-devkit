import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/adapters/http/app.js';
import { ApiTestService } from '../src/modules/apitests/application/api-test-service.js';
import { InMemoryApiTestStore } from '../src/modules/apitests/application/api-test-store.js';
import {
  collectionInputSchema,
  type CollectionInput,
} from '../src/modules/apitests/domain/api-test.js';
import {
  buildCiBundle,
  manifestFiles,
  pipelinePathOf,
  secretName,
  type CiTarget,
} from '../src/modules/apitests/formats/ci.js';
import { exportInsomnia } from '../src/modules/apitests/formats/insomnia.js';
import { exportPostmanEnvironment } from '../src/modules/apitests/formats/postman.js';
import { InMemoryAuthRepository } from '../src/modules/identity/adapters/in-memory-auth-repository.js';
import { AuthService } from '../src/modules/identity/application/auth-service.js';
import { InMemoryWorkspaceRepository } from '../src/modules/workspaces/adapters/in-memory-workspace-repository.js';
import { WorkspaceService } from '../src/modules/workspaces/application/workspace-service.js';
import { FakeScriptRepository } from './helpers/fake-script-repository.js';

const collection = collectionInputSchema.parse({
  name: 'Orders API',
  variables: [
    { key: 'baseUrl', value: 'https://api.example.test' },
    { key: 'password', value: 'pass-9876', secret: true },
    { key: 'off', value: 'x', secret: true, enabled: false },
  ],
  items: [
    {
      id: 'login',
      type: 'request',
      name: 'Login',
      method: 'POST',
      url: '{{baseUrl}}/login',
      assertions: [{ id: 'a1', source: 'status', operator: 'eq', expected: '200' }],
      captures: [{ variable: 'token', source: 'json', path: 'token' }],
    },
  ],
});
const environment = {
  name: 'QA env',
  variables: [
    { key: 'baseUrl', value: 'https://qa.example.test' },
    { key: 'password', value: 'qa-secret', secret: true },
    { key: 'api.key', value: 'k', secret: true },
  ],
};
const target = (patch: Partial<CiTarget> = {}): CiTarget => ({
  provider: 'github',
  branch: 'main',
  path: 'api/orders',
  tool: 'bruno',
  ...patch,
});
const contentOf = (bundle: ReturnType<typeof buildCiBundle>, path: string) =>
  bundle.files.find((file) => file.path === path)?.content ?? '';

describe('CI bundle', () => {
  it('writes a Bruno collection and a GitHub workflow that passes the secrets', () => {
    const bundle = buildCiBundle(collection, environment, target());
    expect(bundle.pipelinePath).toBe('.github/workflows/api-tests-api-orders.yml');
    expect(bundle.files.map((file) => file.path)).toEqual([
      'api/orders/bruno.json',
      'api/orders/collection.bru',
      'api/orders/environments/QA env.bru',
      'api/orders/Login.bru',
      '.github/workflows/api-tests-api-orders.yml',
      'api/orders/.adk-ci.json',
    ]);
    // One secret per secret variable, the disabled one left out.
    expect(bundle.secrets).toEqual([
      { variable: 'password', name: 'PASSWORD' },
      { variable: 'api.key', name: 'API_KEY' },
    ]);
    expect(JSON.stringify(bundle.files)).not.toContain('qa-secret');
    expect(JSON.stringify(bundle.files)).not.toContain('pass-9876');
    const workflow = contentOf(bundle, bundle.pipelinePath);
    expect(workflow).toContain('name: "API tests: Orders API"');
    expect(workflow).toContain('    branches: ["main"]');
    expect(workflow).toContain('npm install --global @usebruno/cli');
    expect(workflow).toContain('working-directory: "api/orders"');
    expect(workflow).toContain('ADK_SECRET_PASSWORD: ${{ secrets.PASSWORD }}');
    expect(workflow).toContain(
      `bru run --env 'QA env' --reporter-junit results.xml --env-var "password=$ADK_SECRET_PASSWORD" --env-var "api.key=$ADK_SECRET_API_KEY"`,
    );
    expect(workflow).toContain('path: "api/orders/results.xml"');
    expect(JSON.parse(contentOf(bundle, 'api/orders/.adk-ci.json'))).toEqual({
      generator: 'adk',
      tool: 'bruno',
      files: [
        '.github/workflows/api-tests-api-orders.yml',
        'api/orders/Login.bru',
        'api/orders/bruno.json',
        'api/orders/collection.bru',
        'api/orders/environments/QA env.bru',
      ],
    });
  });

  it('runs Bruno without an environment and Postman with Newman on Azure Pipelines', () => {
    const plain = { ...collection, variables: [{ key: 'baseUrl', value: 'x' }] };
    const bruno = buildCiBundle(plain, null, target({ path: 'api' }));
    expect(contentOf(bruno, bruno.pipelinePath)).toContain(
      '          bru run --reporter-junit results.xml\n',
    );
    const staging = buildCiBundle(plain, { name: 'staging', variables: [] }, target());
    expect(contentOf(staging, staging.pipelinePath)).toContain('bru run --env staging --reporter');

    const azure = buildCiBundle(plain, null, target({ provider: 'azure_devops', tool: 'postman' }));
    expect(azure.pipelinePath).toBe('api/orders/azure-pipelines.yml');
    expect(azure.secrets).toEqual([]);
    expect(azure.files.map((file) => file.path)).toEqual([
      'api/orders/collection.postman_collection.json',
      'api/orders/azure-pipelines.yml',
      'api/orders/.adk-ci.json',
    ]);
    const pipeline = contentOf(azure, azure.pipelinePath);
    expect(pipeline).toContain(
      'newman run collection.postman_collection.json --reporters cli,junit --reporter-junit-export results.xml',
    );
    expect(pipeline).toContain('  - task: PublishTestResults@2');
    expect(pipeline).toContain('testRunTitle: "Orders API"');
    expect(pipeline).not.toContain('    env:');
  });

  it('maps Azure DevOps secret variables and writes the Postman environment', () => {
    const bundle = buildCiBundle(
      collection,
      environment,
      target({ provider: 'azure_devops', tool: 'postman' }),
    );
    const pipeline = contentOf(bundle, bundle.pipelinePath);
    expect(pipeline).toContain('-e environment.postman_environment.json');
    expect(pipeline).toContain('      ADK_SECRET_API_KEY: $(API_KEY)');
    expect(
      JSON.parse(contentOf(bundle, 'api/orders/environment.postman_environment.json')),
    ).toMatchObject({
      name: 'QA env',
      values: [
        { key: 'baseUrl', value: 'https://qa.example.test', type: 'default', enabled: true },
        { key: 'password', value: '', type: 'secret', enabled: true },
        { key: 'api.key', value: '', type: 'secret', enabled: true },
      ],
      _postman_variable_scope: 'environment',
    });
  });

  it('runs Insomnia exports with inso and executable checks', () => {
    const withEnvironment = buildCiBundle(
      collection,
      environment,
      target({ provider: 'azure_devops', tool: 'insomnia' }),
    );
    const exported = JSON.parse(contentOf(withEnvironment, 'api/orders/insomnia.json')) as {
      resources: { _id: string; _type: string; name: string; afterResponseScript?: string }[];
    };
    const [workspace, base, qa, login] = exported.resources;
    expect(qa).toMatchObject({ _type: 'environment', name: 'QA env' });
    expect(login?.afterResponseScript).toContain('insomnia.response.to.have.status(200);');
    expect(login?.afterResponseScript).toContain('insomnia.collectionVariables.set("token"');
    const pipeline = contentOf(withEnvironment, withEnvironment.pipelinePath);
    expect(pipeline).toContain(
      `inso run collection ${workspace?._id} --workingDir insomnia.json --env ${qa?._id} --ci`,
    );
    expect(pipeline).toContain('npm install --global insomnia-inso');
    expect(pipeline).not.toContain('PublishTestResults');
    expect(base?._type).toBe('environment');

    const github = buildCiBundle(collection, null, target({ tool: 'insomnia' }));
    const resources = (
      JSON.parse(contentOf(github, 'api/orders/insomnia.json')) as {
        resources: { _id: string }[];
      }
    ).resources;
    const workflow = contentOf(github, github.pipelinePath);
    expect(workflow).toContain(`--env ${resources[1]?._id} --ci`);
    expect(workflow).not.toContain('upload-artifact');
  });

  it('names secrets and pipelines the providers accept', () => {
    expect(secretName('api.key')).toBe('API_KEY');
    expect(secretName('1token')).toBe('API_1TOKEN');
    expect(secretName('github_token')).toBe('API_GITHUB_TOKEN');
    expect(secretName('')).toBe('SECRET');
    expect(pipelinePathOf({ provider: 'github', path: '_' })).toBe(
      '.github/workflows/api-tests-collection.yml',
    );
    const odd = buildCiBundle(
      {
        ...collection,
        name: 'Multi\nline',
        variables: [{ key: 'we"ird$', value: '', secret: true }],
      },
      null,
      target(),
    );
    const workflow = contentOf(odd, odd.pipelinePath);
    expect(workflow).toContain('--env-var "we\\"ird\\$=$ADK_SECRET_WE_IRD_"');
    expect(workflow).toContain('# Generated by ADK from the collection "Multi line".');
  });

  it('reads earlier manifests defensively', () => {
    expect(manifestFiles(null, 'api')).toEqual([]);
    expect(manifestFiles('not json', 'api')).toEqual([]);
    expect(manifestFiles('{}', 'api')).toEqual([]);
    expect(
      manifestFiles(JSON.stringify({ files: ['api/a.bru', 'other/b.bru', 7, 'apix/c'] }), 'api'),
    ).toEqual(['api/a.bru']);
  });

  it('keeps the plain Insomnia and Postman exports as they were', () => {
    const plain = exportInsomnia(collection) as { resources: Record<string, unknown>[] };
    expect(plain.resources.filter((resource) => resource['_type'] === 'environment')).toHaveLength(
      1,
    );
    expect(plain.resources[2]?.['afterResponseScript']).toBeUndefined();
    expect(
      exportPostmanEnvironment({
        name: 'E',
        variables: [{ key: 'a', value: 'b', enabled: false }],
      }),
    ).toMatchObject({ values: [{ key: 'a', value: 'b', type: 'default', enabled: false }] });
  });
});

describe('CI settings of a collection', () => {
  const repository = { provider: 'github', id: '42', name: 'acme/demo-app', branch: 'main' };
  const parse = (path: string) =>
    collectionInputSchema.safeParse({
      name: 'C',
      ci: { repository: { ...repository, path }, tool: 'postman' },
    });

  it('normalises the folder and refuses relative segments', () => {
    const parsed = parse(' \\api\\orders//tests/ ');
    expect(parsed.success && parsed.data.ci?.repository.path).toBe('api/orders/tests');
    expect(parse('api/../secrets').success).toBe(false);
    expect(parse('./api').success).toBe(false);
    expect(parse('/').success).toBe(false);
  });
});

async function setup(options: { repositories?: boolean } = {}) {
  const authRepo = new InMemoryAuthRepository();
  const scripts = new FakeScriptRepository();
  const store = new InMemoryApiTestStore();
  const app = createApp({
    authService: new AuthService(authRepo),
    workspaceService: new WorkspaceService(new InMemoryWorkspaceRepository(), authRepo),
    apiTestStore: store,
    apiTestDispatcher: { wake: () => Promise.resolve() },
    e2eScripts: scripts,
  });
  const registered = await request(app)
    .post('/auth/register')
    .send({ email: 'ci@example.com', password: 'StrongPassword123!', name: 'CI' });
  const token = registered.body.token as string;
  const workspace = await request(app)
    .post('/workspaces')
    .set('authorization', `Bearer ${token}`)
    .send({ name: 'CI WS', slug: 'ci-ws' });
  const workspaceId = workspace.body.workspace.id as string;
  const call = (method: 'get' | 'post' | 'put', path: string) =>
    request(app)
      [method](path)
      .set('authorization', `Bearer ${token}`)
      .set('x-workspace-id', workspaceId);
  const service = new ApiTestService({
    store,
    ...(options.repositories === false ? {} : { repositories: scripts }),
  });
  return { call, scripts, service, workspaceId };
}

const ciBody = (input: Partial<CollectionInput> = {}) => ({
  ...collection,
  ...input,
});

describe('CI routes', () => {
  it('lists repositories and branches of the connected providers', async () => {
    const { call } = await setup();
    const repositories = await call('get', '/integration-tests/repositories');
    expect(repositories.status).toBe(200);
    expect(repositories.body.repositories).toHaveLength(2);
    const branches = await call(
      'get',
      '/integration-tests/repositories/branches?provider=github&repositoryId=42',
    );
    expect(branches.body.branches[0]).toEqual({ name: 'main', isDefault: true });
    const invalid = await call('get', '/integration-tests/repositories/branches?provider=gitlab');
    expect(invalid.status).toBe(400);
  });

  it('previews and commits the pipeline, removing what an earlier generation left', async () => {
    const { call, scripts } = await setup();
    const ref = { provider: 'github' as const, id: '42', name: 'acme/demo-app', branch: 'main' };
    const created = await call('post', '/integration-tests/collections').send(ciBody());
    const id = created.body.collection.id as string;

    const unconfigured = await call('get', `/integration-tests/collections/${id}/ci`);
    expect(unconfigured.status).toBe(400);

    const savedEnvironment = await call('post', '/integration-tests/environments').send(
      environment,
    );
    const saved = await call('put', `/integration-tests/collections/${id}`).send({
      ...created.body.collection,
      ci: {
        repository: { ...ref, path: 'api/orders' },
        tool: 'bruno',
        environmentId: savedEnvironment.body.environment.id,
      },
    });
    expect(saved.body.collection.ci.repository.path).toBe('api/orders');

    const preview = await call('get', `/integration-tests/collections/${id}/ci`);
    expect(preview.status).toBe(200);
    expect(preview.body.pipelinePath).toBe('.github/workflows/api-tests-api-orders.yml');
    expect(preview.body.ci).toBeUndefined();
    expect(preview.body.files.map((file: { path: string }) => file.path)).toContain(
      'api/orders/environments/QA env.bru',
    );

    // A file of an earlier generation, one it listed but that is gone, and one ADK never wrote.
    const location = { ...ref, path: 'api/orders' };
    scripts.seed(location, 'api/orders/Removed.bru', 'old');
    scripts.seed(location, 'api/orders/notes.md', 'mine');
    scripts.seed(
      location,
      'api/orders/.adk-ci.json',
      JSON.stringify({ files: ['api/orders/Removed.bru', 'api/orders/Gone.bru'] }),
    );
    const published = await call('post', `/integration-tests/collections/${id}/ci`);
    expect(published.status).toBe(200);
    expect(published.body).toMatchObject({
      commitUrl: expect.stringContaining('https://example.test/acme/demo-app/commit/'),
      pipelinePath: '.github/workflows/api-tests-api-orders.yml',
      removed: ['api/orders/Removed.bru'],
      secrets: [
        { variable: 'password', name: 'PASSWORD' },
        { variable: 'api.key', name: 'API_KEY' },
      ],
    });
    const files = await scripts.listFiles('ws', { ...location, path: '' });
    expect(files).toContain('api/orders/Login.bru');
    expect(files).toContain('api/orders/notes.md');
    expect(files).not.toContain('api/orders/Removed.bru');
    expect(new Set(scripts.commits.map((commit) => commit.message))).toEqual(
      new Set(['Update the API tests of "Orders API" (generated by ADK)']),
    );

    // The next generation finds nothing left to remove.
    const again = await call('post', `/integration-tests/collections/${id}/ci`);
    expect(again.body.removed).toEqual([]);
  });

  it('refuses pipelines when the server has no repository access', async () => {
    const { service, workspaceId } = await setup({ repositories: false });
    expect(() => service.ciRepositories(workspaceId)).toThrowError(
      /Repository access is not available/,
    );
    const saved = await service.saveCollection(workspaceId, 'u1', {
      ...collection,
      ci: {
        repository: { provider: 'github', id: '42', name: 'a/b', branch: 'main', path: 'x' },
        tool: 'postman',
      },
    });
    await expect(service.publishCi(workspaceId, saved.id)).rejects.toMatchObject({
      code: 'API_TEST_CI_UNAVAILABLE',
    });
    expect((await service.previewCi(workspaceId, saved.id)).pipelinePath).toBe(
      '.github/workflows/api-tests-x.yml',
    );
  });

  it('lists branches and addresses repositories by the name their provider gives', async () => {
    const { service, workspaceId, scripts } = await setup();
    expect(await service.ciBranches(workspaceId, 'azure_devops', 'guid-1')).toContainEqual({
      name: 'develop',
      isDefault: true,
    });
    const ci = (id: string) => ({
      ...collection,
      ci: {
        repository: {
          provider: 'github' as const,
          id,
          name: '../../user',
          branch: 'main',
          path: 'x',
        },
        tool: 'postman' as const,
      },
    });
    const known = await service.saveCollection(workspaceId, 'u1', ci('42'));
    expect((await service.publishCi(workspaceId, known.id)).commitUrl).toContain(
      'https://example.test/acme/demo-app/commit/',
    );
    expect(scripts.commits[0]?.path).toBe('x/collection.postman_collection.json');
    const unknown = await service.saveCollection(workspaceId, 'u1', ci('99'));
    await expect(service.publishCi(workspaceId, unknown.id)).rejects.toMatchObject({
      code: 'API_TEST_CI_REPOSITORY_NOT_FOUND',
    });
  });
});
