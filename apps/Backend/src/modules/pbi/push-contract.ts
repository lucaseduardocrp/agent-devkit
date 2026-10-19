/**
 * Push contracts describe, per board provider, the fields a person must confirm before an ADK
 * item is published: the destination (project, board, iteration...) and the values ADK maps from
 * the item (assignee, state). A field whose ADK value could not be mapped is `unresolved`, so the
 * UI highlights it and the push is rejected until someone picks a value.
 */
export interface PushFieldOption {
  value: string;
  label: string;
  /** Extra text shown next to the label, e.g. an email or iteration dates. */
  detail?: string;
}
export type PushFieldStatus = 'resolved' | 'unresolved' | 'empty';
export interface PushField {
  key: string;
  label: string;
  required: boolean;
  options: PushFieldOption[];
  value: string;
  status: PushFieldStatus;
  /** The ADK value ADK tried to map, shown when it could not be found on the provider. */
  source?: string;
  /** Changing this field changes the options of other fields, so the contract is reloaded. */
  reloadOnChange?: boolean;
  /** Free text is accepted besides the listed options (e.g. a repository path). */
  allowCustom?: boolean;
  readOnly?: boolean;
}
export interface PushContract {
  providerId: string;
  /** The item is already linked to this provider, so the push updates it. */
  update: boolean;
  fields: PushField[];
}
export interface PushAssignee {
  name: string;
  email: string;
}
export interface PushContext {
  item: {
    kind: 'pbi' | 'card';
    title: string;
    status: string;
    sourceData: Record<string, unknown>;
  };
  values: Record<string, string>;
  assignee: PushAssignee | null;
  externalId?: string;
  parentExternalId?: string;
}

export function normalize(value: string): string {
  return value
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[_\s]+/g, ' ')
    .trim()
    .toLocaleLowerCase();
}

export type StateCategory = 'proposed' | 'inProgress' | 'done' | 'removed';
const categoryWords: Record<StateCategory, string[]> = {
  proposed: ['backlog', 'new', 'todo', 'to do', 'proposed', 'open', 'a fazer', 'novo'],
  inProgress: [
    'active',
    'in progress',
    'doing',
    'committed',
    'in review',
    'em andamento',
    'fazendo',
    'ativo',
  ],
  done: ['done', 'closed', 'completed', 'resolved', 'concluido', 'feito', 'fechado'],
  removed: ['removed', 'cancelled', 'canceled', 'removido', 'cancelado'],
};
export function stateCategory(status: string): StateCategory | null {
  const value = normalize(status);
  for (const [category, words] of Object.entries(categoryWords))
    if (words.includes(value)) return category as StateCategory;
  return null;
}

/**
 * Maps an ADK status to a provider state: an exact (accent and case insensitive) name first, then
 * the first state of the same category (Azure/Jira expose categories; otherwise the name decides).
 */
export function matchState(
  status: string,
  states: readonly { name: string; category?: StateCategory | null }[],
): string | null {
  const wanted = normalize(status);
  const exact = states.find((state) => normalize(state.name) === wanted);
  if (exact) return exact.name;
  const category = stateCategory(status);
  if (!category) return null;
  return (
    states.find((state) => (state.category ?? stateCategory(state.name)) === category)?.name ?? null
  );
}

export interface ProviderUser {
  value: string;
  label: string;
  email?: string;
  login?: string;
}
/** Finds the provider account of the ADK assignee by email, then display name, then login. */
export function matchUser(
  assignee: PushAssignee | null,
  users: readonly ProviderUser[],
): string | null {
  if (!assignee) return null;
  const email = assignee.email.trim().toLocaleLowerCase();
  const name = normalize(assignee.name);
  // `split` always returns at least one element.
  const [local] = email.split('@') as [string];
  return (
    (email && users.find((user) => user.email?.trim().toLocaleLowerCase() === email)?.value) ||
    (name && users.find((user) => normalize(user.label) === name)?.value) ||
    (local &&
      users.find(
        (user) =>
          user.login?.toLocaleLowerCase() === local ||
          user.email?.trim().toLocaleLowerCase().split('@')[0] === local,
      )?.value) ||
    null
  );
}

/** Builds a select field, keeping a chosen value when it is still one of the options. */
export function selectField(field: {
  key: string;
  label: string;
  required: boolean;
  options: PushFieldOption[];
  chosen?: string;
  suggested: string | null;
  source?: string;
  reloadOnChange?: boolean;
  allowCustom?: boolean;
  readOnly?: boolean;
}): PushField {
  const valid = (value: string | undefined): value is string =>
    value !== undefined &&
    (field.allowCustom ? true : value === '' || field.options.some((o) => o.value === value));
  const kept = valid(field.chosen);
  const value = kept ? field.chosen! : (field.suggested ?? '');
  // An ADK value that could not be mapped stays flagged until someone picks a value.
  const status: PushFieldStatus = value
    ? 'resolved'
    : field.source && !kept
      ? 'unresolved'
      : 'empty';
  return {
    key: field.key,
    label: field.label,
    required: field.required,
    options: field.options,
    value,
    status,
    ...(field.source ? { source: field.source } : {}),
    ...(field.reloadOnChange ? { reloadOnChange: true } : {}),
    ...(field.allowCustom ? { allowCustom: true } : {}),
    ...(field.readOnly ? { readOnly: true } : {}),
  };
}

/** Returns the keys of required fields without an acceptable value. */
export function missingFields(fields: readonly PushField[]): string[] {
  return fields
    .filter(
      (field) =>
        field.required &&
        (!field.value.trim() ||
          (!field.allowCustom && !field.options.some((option) => option.value === field.value))),
    )
    .map((field) => field.key);
}

export function fieldValues(fields: readonly PushField[]): Record<string, string> {
  return Object.fromEntries(fields.map((field) => [field.key, field.value]));
}
