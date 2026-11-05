import type { CiTool, CollectionInput } from '../domain/api-test.js';
import type { Variable } from '../engine/types.js';
import { exportBruno } from './bruno.js';
import { exportInsomnia } from './insomnia.js';
import { exportPostman, exportPostmanEnvironment } from './postman.js';

// The collection as files of the team's repository, run by a pipeline at every push and pull
// request to the chosen branch: Bruno with `bru run`, Postman with Newman, Insomnia with
// `inso run collection`. Secret values never leave ADK: the pipeline passes them from the CI
// provider's secrets with `--env-var`, one secret per secret variable.

export type CiProvider = 'github' | 'azure_devops';

export interface CiTarget {
  readonly provider: CiProvider;
  readonly branch: string;
  /** Folder of the collection inside the repository, without leading or trailing slashes. */
  readonly path: string;
  readonly tool: CiTool;
}

export interface CiFile {
  readonly path: string;
  readonly content: string;
}

export interface CiSecret {
  /** Variable of the collection or environment. */
  readonly variable: string;
  /** Secret the pipeline reads it from (GitHub secret or Azure DevOps secret variable). */
  readonly name: string;
}

export interface CiBundle {
  /** Repository paths, the pipeline and the manifest included. */
  readonly files: readonly CiFile[];
  readonly pipelinePath: string;
  readonly secrets: readonly CiSecret[];
}

interface NamedVariables {
  readonly name: string;
  readonly variables: readonly Variable[];
}

/** Lists what ADK wrote in the folder, so the next generation removes what is gone. */
export const CI_MANIFEST = '.adk-ci.json';
const RESULTS = 'results.xml';

const TOOLS: Record<
  CiTool,
  { readonly label: string; readonly npm: string; readonly junit: boolean }
> = {
  bruno: { label: 'Bruno CLI', npm: '@usebruno/cli', junit: true },
  postman: { label: 'Newman', npm: 'newman', junit: true },
  // inso has no JUnit reporter: its results stay in the job log.
  insomnia: { label: 'Inso CLI', npm: 'insomnia-inso', junit: false },
};

/** Shell word: bare when safe, single-quoted otherwise. */
const word = (value: string) =>
  /^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
/** Inside double quotes, so `$ADK_SECRET_...` still expands. */
const quoted = (value: string) => value.replace(/[\\"$`]/g, '\\$&');
const yamlString = (value: string) => JSON.stringify(value);
const oneLine = (value: string) => value.replace(/\s+/g, ' ').trim();

/** `api.key` → `API_KEY`; names GitHub refuses (leading digit, `GITHUB_`) get an `API_` prefix. */
export function secretName(variable: string): string {
  const name = variable.replace(/[^A-Za-z0-9_]+/g, '_').toUpperCase() || 'SECRET';
  return /^(\d|GITHUB_)/.test(name) ? `API_${name}` : name;
}

function secretsOf(sources: readonly NamedVariables[]): CiSecret[] {
  const seen = new Map<string, CiSecret>();
  for (const variable of sources.flatMap((source) => source.variables)) {
    if (variable.secret && variable.enabled !== false && !seen.has(variable.key))
      seen.set(variable.key, { variable: variable.key, name: secretName(variable.key) });
  }
  return [...seen.values()];
}

const envVarOf = (secret: CiSecret) => `ADK_SECRET_${secret.name}`;

/** The collection files of the tool and the command that runs them from the folder. */
function toolFiles(
  collection: CollectionInput,
  environment: NamedVariables | null,
  tool: CiTool,
): { files: CiFile[]; command: string[] } {
  switch (tool) {
    case 'bruno': {
      const exported = exportBruno(collection, environment ? [environment] : []);
      const files = exported.map((file) => ({
        path: file.path.slice(file.path.indexOf('/') + 1),
        content: file.content,
      }));
      const envFile = files.find((file) => file.path.startsWith('environments/'));
      const envName = envFile?.path.slice('environments/'.length, -'.bru'.length);
      return {
        files,
        command: [
          'bru run',
          ...(envName ? [`--env ${word(envName)}`] : []),
          `--reporter-junit ${RESULTS}`,
        ],
      };
    }
    case 'postman': {
      const files: CiFile[] = [
        {
          path: 'collection.postman_collection.json',
          content: `${JSON.stringify(exportPostman(collection), null, 2)}\n`,
        },
      ];
      if (environment)
        files.push({
          path: 'environment.postman_environment.json',
          content: `${JSON.stringify(exportPostmanEnvironment(environment), null, 2)}\n`,
        });
      return {
        files,
        command: [
          'newman run collection.postman_collection.json',
          ...(environment ? ['-e environment.postman_environment.json'] : []),
          '--reporters cli,junit',
          `--reporter-junit-export ${RESULTS}`,
        ],
      };
    }
    case 'insomnia': {
      const exported = exportInsomnia(collection, {
        environments: environment ? [environment] : [],
        executableChecks: true,
      });
      // The workspace comes first, then the base environment and the sub-environment.
      const ids = (exported['resources'] as { _id: string; _type: string }[])
        .filter((resource) => resource._type === 'workspace' || resource._type === 'environment')
        .map((resource) => resource._id);
      return {
        files: [{ path: 'insomnia.json', content: `${JSON.stringify(exported, null, 2)}\n` }],
        command: [
          `inso run collection ${ids[0] as string}`,
          '--workingDir insomnia.json',
          `--env ${ids[ids.length - 1] as string}`,
          '--ci',
        ],
      };
    }
  }
}

function githubWorkflow(input: {
  readonly name: string;
  readonly target: CiTarget;
  readonly command: string;
  readonly secrets: readonly CiSecret[];
}): string {
  const { target } = input;
  const tool = TOOLS[target.tool];
  const lines = [
    `# Generated by ADK from the collection "${oneLine(input.name)}".`,
    '# Edit the collection in ADK and generate the pipeline again instead of editing this file.',
    `name: ${yamlString(`API tests: ${oneLine(input.name)}`)}`,
    '',
    'on:',
    '  push:',
    `    branches: [${yamlString(target.branch)}]`,
    '  pull_request:',
    `    branches: [${yamlString(target.branch)}]`,
    '  workflow_dispatch:',
    '',
    'jobs:',
    '  api-tests:',
    '    runs-on: ubuntu-latest',
    '    steps:',
    '      - uses: actions/checkout@v4',
    '      - uses: actions/setup-node@v4',
    '        with:',
    '          node-version: 20',
    `      - name: Install ${tool.label}`,
    `        run: npm install --global ${tool.npm}`,
    '      - name: Run the collection',
    `        working-directory: ${yamlString(target.path)}`,
    ...(input.secrets.length
      ? [
          '        env:',
          ...input.secrets.map(
            (secret) => `          ${envVarOf(secret)}: \${{ secrets.${secret.name} }}`,
          ),
        ]
      : []),
    '        run: |',
    `          ${input.command}`,
  ];
  if (tool.junit)
    lines.push(
      '      - name: Upload the results',
      '        if: always()',
      '        uses: actions/upload-artifact@v4',
      '        with:',
      '          name: api-test-results',
      `          path: ${yamlString(`${target.path}/${RESULTS}`)}`,
    );
  return `${lines.join('\n')}\n`;
}

function azurePipeline(input: {
  readonly name: string;
  readonly target: CiTarget;
  readonly command: string;
  readonly secrets: readonly CiSecret[];
}): string {
  const { target } = input;
  const tool = TOOLS[target.tool];
  const lines = [
    `# Generated by ADK from the collection "${oneLine(input.name)}".`,
    '# Edit the collection in ADK and generate the pipeline again instead of editing this file.',
    'trigger:',
    '  branches:',
    '    include:',
    `      - ${yamlString(target.branch)}`,
    '',
    'pr:',
    '  branches:',
    '    include:',
    `      - ${yamlString(target.branch)}`,
    '',
    'pool:',
    '  vmImage: ubuntu-latest',
    '',
    'steps:',
    '  - task: NodeTool@0',
    '    displayName: Use Node.js 20',
    '    inputs:',
    '      versionSpec: 20.x',
    `  - script: npm install --global ${tool.npm}`,
    `    displayName: Install ${tool.label}`,
    '  - script: |',
    `      ${input.command}`,
    '    displayName: Run the collection',
    `    workingDirectory: ${yamlString(target.path)}`,
    ...(input.secrets.length
      ? [
          '    env:',
          // Azure DevOps hands secret variables to scripts only through an explicit mapping.
          ...input.secrets.map((secret) => `      ${envVarOf(secret)}: $(${secret.name})`),
        ]
      : []),
  ];
  if (tool.junit)
    lines.push(
      '  - task: PublishTestResults@2',
      '    displayName: Publish the results',
      '    condition: succeededOrFailed()',
      '    inputs:',
      '      testResultsFormat: JUnit',
      `      testResultsFiles: ${yamlString(`${target.path}/${RESULTS}`)}`,
      `      testRunTitle: ${yamlString(oneLine(input.name))}`,
    );
  return `${lines.join('\n')}\n`;
}

/** GitHub only runs workflows from `.github/workflows`; Azure DevOps reads any path. */
export function pipelinePathOf(target: Pick<CiTarget, 'provider' | 'path'>): string {
  if (target.provider === 'azure_devops') return `${target.path}/azure-pipelines.yml`;
  const slug = target.path
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `.github/workflows/api-tests-${slug || 'collection'}.yml`;
}

/**
 * The files to commit: the collection (and the environment) in the tool's format under the
 * folder, the pipeline, and the manifest of what ADK wrote. Secrets are exported empty.
 */
export function buildCiBundle(
  collection: CollectionInput,
  environment: NamedVariables | null,
  target: CiTarget,
): CiBundle {
  const { files, command } = toolFiles(collection, environment, target.tool);
  const secrets = secretsOf(environment ? [collection, environment] : [collection]);
  const fullCommand = [
    ...command,
    ...secrets.map((secret) => `--env-var "${quoted(secret.variable)}=$${envVarOf(secret)}"`),
  ].join(' ');
  const pipelinePath = pipelinePathOf(target);
  const pipeline = { name: collection.name, target, command: fullCommand, secrets };
  const written: CiFile[] = [
    ...files.map((file) => ({ path: `${target.path}/${file.path}`, content: file.content })),
    {
      path: pipelinePath,
      content: target.provider === 'github' ? githubWorkflow(pipeline) : azurePipeline(pipeline),
    },
  ];
  const manifest = {
    generator: 'adk',
    tool: target.tool,
    files: written.map((file) => file.path).sort(),
  };
  written.push({
    path: `${target.path}/${CI_MANIFEST}`,
    content: `${JSON.stringify(manifest, null, 2)}\n`,
  });
  return { files: written, pipelinePath, secrets };
}

/** Paths a previous manifest lists, limited to the folder ADK writes in. */
export function manifestFiles(content: string | null, folder: string): string[] {
  if (!content) return [];
  try {
    const parsed = JSON.parse(content) as { files?: unknown };
    return Array.isArray(parsed.files)
      ? parsed.files.filter(
          (path): path is string => typeof path === 'string' && path.startsWith(`${folder}/`),
        )
      : [];
  } catch {
    return [];
  }
}
