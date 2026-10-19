export interface ReleaseNote {
  id: string;
  workspaceId: string;
  title: string;
  version: string;
  content: string;
  agentId: string | null;
  itemIds: string[];
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}
export interface ReleaseNoteFields {
  title: string;
  version?: string;
  content?: string;
  itemIds?: string[];
}
export interface GenerateReleaseNoteFields {
  title: string;
  version?: string;
  agentId: string;
  itemIds: string[];
  instructions?: string;
}
export type ReleaseNoteExportFormat = 'markdown' | 'pdf' | 'docx';
