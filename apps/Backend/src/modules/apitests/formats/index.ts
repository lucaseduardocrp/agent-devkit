import { parse as parseYaml } from 'yaml';
import { ApplicationError } from '../../../shared/errors.js';
import {
  collectionInputSchema,
  environmentInputSchema,
  type CollectionInput,
  type CollectionSourceKind,
  type EnvironmentInput,
} from '../domain/api-test.js';
import type { Variable } from '../engine/types.js';
import { exportBruno, importBruno, type BrunoFile } from './bruno.js';
import { exportInsomnia, importInsomnia, isInsomniaExport } from './insomnia.js';
import { importOpenApi, isOpenApi } from './openapi.js';
import { exportPostman, importPostman, isPostmanCollection } from './postman.js';

export { exportBruno, exportInsomnia, exportPostman, importBruno };
export type { BrunoFile };

/**
 * ADK's own file format: the collection as ADK stores it, with environments. It is the format
 * the agents produce, and the one to keep in a repository when nothing else needs to read it.
 */
export const ADK_FORMAT = 'adk-api-collection';
export const ADK_FORMAT_VERSION = 1;

export const IMPORT_FORMATS = ['adk', 'postman', 'insomnia', 'openapi', 'bruno'] as const;
export type ImportFormat = (typeof IMPORT_FORMATS)[number];
export const EXPORT_FORMATS = ['adk', 'postman', 'insomnia', 'bruno'] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

export interface ImportedCollection {
  readonly format: ImportFormat;
  readonly collection: CollectionInput;
  readonly environments: readonly EnvironmentInput[];
}

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function parseDocument(content: string): unknown {
  const text = content.replace(/^\uFEFF/, '').trim();
  if (!text) throw invalid('The file is empty.');
  try {
    return JSON.parse(text) as unknown;
  } catch {
    try {
      return parseYaml(text, { maxAliasCount: 100 }) as unknown;
    } catch {
      throw invalid('The file is neither JSON nor YAML.');
    }
  }
}

function invalid(message: string, details: Record<string, unknown>[] = []) {
  return new ApplicationError('API_TEST_IMPORT_INVALID', message, 400, details, {
    detail: message,
  });
}

/**
 * Bruno collections are folders of files: they arrive as `{ files: [{ path, content }] }` (the
 * shape of the Bruno export `as=files`), or as a single .bru request file.
 */
function brunoFiles(document: unknown): BrunoFile[] | null {
  if (!isObject(document) || !Array.isArray(document['files'])) return null;
  const files = document['files'].filter(
    (file): file is BrunoFile =>
      isObject(file) && typeof file['path'] === 'string' && typeof file['content'] === 'string',
  );
  return files.some((file) => /\.bru$|(^|\/)bruno\.json$/.test(file.path)) ? files : null;
}

/** A .bru file starts with a block such as `meta {` (JSON starts with `{` or `[`). */
const isBruText = (text: string) => /^\s*[\w:-]+\s*\{\s*\r?\n/.test(text);

export function detectFormat(document: unknown): ImportFormat | null {
  if (isObject(document) && document['format'] === ADK_FORMAT) return 'adk';
  if (brunoFiles(document)) return 'bruno';
  if (isPostmanCollection(document)) return 'postman';
  if (isInsomniaExport(document)) return 'insomnia';
  if (isOpenApi(document)) return 'openapi';
  return null;
}

/** Reads a collection file (JSON or YAML); `format` is detected when not given. */
export function importCollection(content: string, format?: ImportFormat): ImportedCollection {
  const text = content.replace(/^\uFEFF/, '');
  const document: unknown =
    (format === undefined || format === 'bruno') && isBruText(text)
      ? { files: [{ path: 'request.bru', content: text }] }
      : parseDocument(content);
  const detected = format ?? detectFormat(document);
  if (!detected || !isObject(document)) {
    throw invalid(
      'Unrecognised file. Import an ADK collection, a Postman v2.1 collection, an Insomnia export, an OpenAPI 3 / Swagger 2 document or Bruno files.',
    );
  }
  let collection: unknown;
  let environments: unknown[] = [];
  switch (detected) {
    case 'adk':
      collection = document['collection'];
      environments = Array.isArray(document['environments']) ? document['environments'] : [];
      break;
    case 'postman':
      collection = importPostman(document);
      break;
    case 'insomnia':
      collection = importInsomnia(document);
      break;
    case 'openapi':
      collection = importOpenApi(document);
      break;
    case 'bruno': {
      const imported = importBruno(brunoFiles(document) ?? []);
      collection = imported.collection;
      environments = imported.environments;
      break;
    }
  }
  const parsed = collectionInputSchema.safeParse(collection);
  if (!parsed.success) {
    throw invalid(
      `The ${detected} file does not describe a valid collection.`,
      parsed.error.issues
        .slice(0, 10)
        .map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
    );
  }
  const parsedEnvironments = environments.map((environment) =>
    environmentInputSchema.safeParse(environment),
  );
  return {
    format: detected,
    collection: parsed.data,
    environments: parsedEnvironments.flatMap((result) => (result.success ? [result.data] : [])),
  };
}

// CollectionSourceKind has no `bruno` yet: Bruno imports are recorded as manual collections.
export const sourceKindOf = (format: ImportFormat): CollectionSourceKind =>
  format === 'bruno' ? 'manual' : format;

/** The ADK file of a collection; secret values are left empty. */
export function exportAdk(
  collection: CollectionInput,
  environments: readonly { readonly name: string; readonly variables: readonly Variable[] }[] = [],
) {
  const strip = <T extends { variables: readonly { secret?: boolean; value: string }[] }>(
    value: T,
  ): T => ({
    ...value,
    variables: value.variables.map((variable) =>
      variable.secret ? { ...variable, value: '' } : variable,
    ),
  });
  return {
    format: ADK_FORMAT,
    version: ADK_FORMAT_VERSION,
    collection: strip(collection),
    environments: environments.map(strip),
  };
}
