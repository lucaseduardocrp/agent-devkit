import type { DesignRepositoryProvider } from './design-service.js';

/** Repository the Design module reads and writes its prototypes in. */
export interface DesignSettings {
  readonly provider: DesignRepositoryProvider;
  readonly repositoryId: string;
  /** GitHub "owner/repo" or Azure DevOps "Project/Repo". */
  readonly repositoryName: string;
  readonly branch: string;
}

export interface DesignSettingsStore {
  get(workspaceId: string): Promise<DesignSettings | null>;
  save(workspaceId: string, settings: DesignSettings): Promise<DesignSettings>;
  clear(workspaceId: string): Promise<void>;
}

export class InMemoryDesignSettingsStore implements DesignSettingsStore {
  private readonly settings = new Map<string, DesignSettings>();

  get(workspaceId: string): Promise<DesignSettings | null> {
    return Promise.resolve(this.settings.get(workspaceId) ?? null);
  }

  save(workspaceId: string, settings: DesignSettings): Promise<DesignSettings> {
    this.settings.set(workspaceId, settings);
    return Promise.resolve(settings);
  }

  clear(workspaceId: string): Promise<void> {
    this.settings.delete(workspaceId);
    return Promise.resolve();
  }
}
