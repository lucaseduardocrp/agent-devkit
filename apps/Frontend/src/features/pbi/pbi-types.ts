export type PbiKind = 'pbi' | 'card';
export type PbiProviderId = 'azure_devops' | 'trello' | 'github_projects' | 'jira';
export interface PbiLink {
  id: string;
  providerId: PbiProviderId;
  externalId: string;
  externalUrl: string | null;
  boardId: string | null;
  syncedAt: string;
}
export interface PbiComment {
  id: string;
  body: string;
  author: string;
  createdAt: string;
}
export interface PbiItem {
  id: string;
  workspaceId: string;
  parentId: string | null;
  kind: PbiKind;
  title: string;
  description: string;
  attachments?: readonly ImageAttachment[];
  status: string;
  position: number;
  sourceData: Record<string, unknown>;
  links: PbiLink[];
  createdAt: string;
  updatedAt: string;
  /**
   * Loaded from the list: `description` is a plain-text excerpt, and attachments and detailed
   * provider data (custom fields, external links) are left out. Read the full item to edit it.
   */
  partial?: boolean;
}
export interface PbiFields {
  kind: PbiKind;
  title: string;
  description?: string;
  status?: string;
  parentId?: string | null;
  position?: number;
  sourceData?: Record<string, unknown>;
  attachments?: readonly ImageAttachment[];
}
export interface PbiProvider {
  providerId: PbiProviderId;
  settings: Record<string, unknown>;
}
export interface PbiPullResult {
  results: { providerId: string; imported: number; error?: string }[];
  items: PbiItem[];
}
export interface PbiPushFieldOption {
  value: string;
  label: string;
  detail?: string;
}
/** A field of a provider push contract; `unresolved` means ADK could not map its value. */
export interface PbiPushField {
  key: string;
  label: string;
  required: boolean;
  options: PbiPushFieldOption[];
  value: string;
  status: 'resolved' | 'unresolved' | 'empty';
  source?: string;
  reloadOnChange?: boolean;
  allowCustom?: boolean;
  readOnly?: boolean;
}
export interface PbiPushContract {
  providerId: PbiProviderId;
  update: boolean;
  fields: PbiPushField[];
}
export const pbiLinkTypes = [
  'parent',
  'child',
  'related',
  'predecessor',
  'successor',
  'duplicate',
  'duplicate_of',
  'tests',
  'tested_by',
] as const;
export type PbiLinkType = (typeof pbiLinkTypes)[number];
export interface PbiRelation {
  type: PbiLinkType;
  /** `adk` or the provider the link was read from. */
  origin: string;
  item: {
    id: string;
    title: string;
    kind: PbiKind;
    status: string;
    type: string;
    links: { providerId: PbiProviderId; externalId: string; externalUrl: string | null }[];
  } | null;
  externalId?: string;
}
import type { ImageAttachment } from '../shared/image-attachment-types.js';
