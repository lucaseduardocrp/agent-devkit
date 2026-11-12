import crypto from 'node:crypto';
import { ApplicationError } from '../../../shared/errors.js';
import { decryptSecret, encryptSecret } from '../../../shared/encryption.js';
import { normalizeTargetUrl } from '../domain/e2e.js';
import {
  MAX_ENVIRONMENT_VARIABLES,
  normalizeVariables,
  type E2eEnvironment,
} from '../domain/e2e-insight.js';

export type NewE2eEnvironment = Omit<E2eEnvironment, 'id' | 'createdAt' | 'updatedAt'>;
export type E2eEnvironmentChanges = Partial<Omit<NewE2eEnvironment, 'workspaceId'>>;

export interface E2eEnvironmentStore {
  /** Oldest first: the first environment is the workspace's default. */
  list(workspaceId: string): Promise<E2eEnvironment[]>;
  get(workspaceId: string, id: string): Promise<E2eEnvironment | null>;
  create(input: NewE2eEnvironment): Promise<E2eEnvironment>;
  update(
    workspaceId: string,
    id: string,
    changes: E2eEnvironmentChanges,
  ): Promise<E2eEnvironment | null>;
  delete(workspaceId: string, id: string): Promise<boolean>;
}

export class InMemoryE2eEnvironmentStore implements E2eEnvironmentStore {
  private readonly items = new Map<string, E2eEnvironment>();

  list(workspaceId: string): Promise<E2eEnvironment[]> {
    return Promise.resolve(
      [...this.items.values()].filter((item) => item.workspaceId === workspaceId),
    );
  }

  get(workspaceId: string, id: string): Promise<E2eEnvironment | null> {
    const item = this.items.get(id);
    return Promise.resolve(item?.workspaceId === workspaceId ? item : null);
  }

  create(input: NewE2eEnvironment): Promise<E2eEnvironment> {
    const now = new Date();
    const item = { ...input, id: crypto.randomUUID(), createdAt: now, updatedAt: now };
    this.items.set(item.id, item);
    return Promise.resolve(item);
  }

  async update(
    workspaceId: string,
    id: string,
    changes: E2eEnvironmentChanges,
  ): Promise<E2eEnvironment | null> {
    const item = await this.get(workspaceId, id);
    if (!item) return null;
    const next = { ...item, ...changes, updatedAt: new Date() };
    this.items.set(id, next);
    return next;
  }

  async delete(workspaceId: string, id: string): Promise<boolean> {
    return Boolean(await this.get(workspaceId, id)) && this.items.delete(id);
  }
}

export interface E2eEnvironmentInput {
  readonly name: string;
  readonly baseUrl: string;
  readonly username?: string;
  /** Omitted when editing: the saved password is kept while the username stays. */
  readonly password?: string;
  /**
   * The custom variables after the change. A variable sent without a value keeps the saved
   * one, so the form never has to receive secrets back.
   */
  readonly variables?: readonly { readonly key: string; readonly value?: string }[];
}

/** An environment as the API returns it: no password and no variable values. */
export type E2eEnvironmentView = Omit<E2eEnvironment, 'passwordSecret' | 'variablesSecret'> & {
  readonly hasPassword: boolean;
  readonly isDefault: boolean;
};

/** The saved environments of a workspace: where its applications run and how to sign in. */
export class E2eEnvironmentService {
  constructor(private readonly store: E2eEnvironmentStore) {}

  async list(workspaceId: string): Promise<E2eEnvironmentView[]> {
    return (await this.store.list(workspaceId)).map((item, index) => toView(item, index === 0));
  }

  async create(workspaceId: string, input: E2eEnvironmentInput): Promise<E2eEnvironmentView> {
    const variables = resolveVariables(input.variables ?? [], {});
    const created = await this.store.create({
      workspaceId,
      name: input.name.trim(),
      baseUrl: environmentUrl(input.baseUrl),
      username: input.username?.trim() || null,
      passwordSecret: input.password ? encryptSecret(input.password) : null,
      ...variableColumns(variables),
    });
    return this.view(workspaceId, created);
  }

  async update(
    workspaceId: string,
    id: string,
    input: E2eEnvironmentInput,
  ): Promise<E2eEnvironmentView> {
    const current = await this.find(workspaceId, id);
    const username = input.username?.trim() || null;
    const variables = resolveVariables(input.variables ?? [], variablesOf(current));
    const updated = (await this.store.update(workspaceId, id, {
      name: input.name.trim(),
      baseUrl: environmentUrl(input.baseUrl),
      username,
      // Without an account there is nothing to sign in with: the password goes with it.
      passwordSecret: input.password
        ? encryptSecret(input.password)
        : username
          ? current.passwordSecret
          : null,
      ...variableColumns(variables),
    })) as E2eEnvironment;
    return this.view(workspaceId, updated);
  }

  async delete(workspaceId: string, id: string): Promise<void> {
    await this.find(workspaceId, id);
    await this.store.delete(workspaceId, id);
  }

  /** The environment with its secrets, for the run that is configured from it. */
  async find(workspaceId: string, id: string): Promise<E2eEnvironment> {
    const item = await this.store.get(workspaceId, id);
    if (!item)
      throw new ApplicationError('E2E_ENVIRONMENT_NOT_FOUND', 'Environment not found.', 404, [
        { field: 'environmentId' },
      ]);
    return item;
  }

  /** Custom variables of a run's environment; empty when it has none or was deleted. */
  async variables(
    workspaceId: string,
    id: string | null | undefined,
  ): Promise<Record<string, string>> {
    const item = id ? await this.store.get(workspaceId, id) : null;
    return item ? variablesOf(item) : {};
  }

  private async view(workspaceId: string, item: E2eEnvironment): Promise<E2eEnvironmentView> {
    const first = (await this.store.list(workspaceId))[0];
    return toView(item, first?.id === item.id);
  }
}

function toView(item: E2eEnvironment, isDefault: boolean): E2eEnvironmentView {
  const { passwordSecret, variablesSecret: _variables, ...rest } = item;
  return { ...rest, hasPassword: Boolean(passwordSecret), isDefault };
}

/** The address of the application, without a path: runs choose where they start. */
function environmentUrl(value: string): string {
  return normalizeTargetUrl(value).baseUrl;
}

export function variablesOf(item: Pick<E2eEnvironment, 'variablesSecret'>): Record<string, string> {
  if (!item.variablesSecret) return {};
  try {
    return JSON.parse(decryptSecret(item.variablesSecret)) as Record<string, string>;
  } catch {
    // Unreadable after an encryption key change: the variables have to be entered again.
    return {};
  }
}

function resolveVariables(
  input: NonNullable<E2eEnvironmentInput['variables']>,
  saved: Record<string, string>,
): Record<string, string> {
  if (input.length > MAX_ENVIRONMENT_VARIABLES)
    throw new ApplicationError('E2E_INVALID_VARIABLE', 'Too many variables.', 400, [
      { field: 'variables', max: MAX_ENVIRONMENT_VARIABLES },
    ]);
  return normalizeVariables(
    input.map((item) => ({
      key: item.key,
      value: item.value ?? saved[item.key.trim().toUpperCase()] ?? '',
    })),
  );
}

function variableColumns(variables: Record<string, string>) {
  const names = Object.keys(variables);
  return {
    variableNames: names,
    variablesSecret: names.length ? encryptSecret(JSON.stringify(variables)) : null,
  };
}
