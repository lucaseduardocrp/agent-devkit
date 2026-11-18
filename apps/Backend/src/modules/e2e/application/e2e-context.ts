import type { RequestContext } from '../../../shared/context.js';
import type { E2eCreation } from '../domain/e2e.js';
import {
  explorationContextKey,
  type E2eExplorationContextDocument,
  type E2eExplorationContextKind,
  type E2eExplorationContextRef,
} from '../domain/e2e-insight.js';
import type { E2eArtifactStore } from './artifact-store.js';

/** What the user chose to give the agent as context: only the kind and the id travel in a request. */
export interface E2eContextRequest {
  readonly kind: E2eExplorationContextKind;
  readonly id: string;
}

/** Most characters of one context document kept for the agent. */
export const MAX_CONTEXT_DOCUMENT = 6_000;

/**
 * Reads the PBIs, issues and Brain documents the user chose as context of an exploration.
 * What cannot be found (deleted since it was listed) is left out.
 */
export interface E2eContextReader {
  read(
    context: RequestContext,
    requests: readonly E2eContextRequest[],
  ): Promise<E2eExplorationContextDocument[]>;
}

type Creation = Pick<E2eCreation, 'workspaceId' | 'id'>;

/** The documents an exploration was started with; empty when it had none. */
export async function readExplorationContext(
  artifacts: E2eArtifactStore,
  creation: Creation,
): Promise<E2eExplorationContextDocument[]> {
  const content = await artifacts.get(explorationContextKey(creation));
  if (!content) return [];
  try {
    const parsed = JSON.parse(content.toString('utf8')) as unknown;
    return Array.isArray(parsed) ? (parsed as E2eExplorationContextDocument[]) : [];
  } catch {
    return [];
  }
}

/** Keeps the documents for the worker that runs the exploration; no documents clears them. */
export async function saveExplorationContext(
  artifacts: E2eArtifactStore,
  creation: Creation,
  documents: readonly E2eExplorationContextDocument[],
): Promise<void> {
  if (!documents.length) return artifacts.removePrefix(explorationContextKey(creation));
  await artifacts.put(
    explorationContextKey(creation),
    Buffer.from(JSON.stringify(documents), 'utf8'),
  );
}

/** What the exploration shows of its context: the documents without their text. */
export const contextRefs = (
  documents: readonly E2eExplorationContextDocument[],
): E2eExplorationContextRef[] =>
  documents.flatMap(({ kind, id, title }) => (kind === 'spec' ? [] : [{ kind, id, title }]));
