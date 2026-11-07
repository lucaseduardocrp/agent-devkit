/** Made-up values for the names a text may use, so a rule can be read as people will read it. */
export const SAMPLE_NOTIFICATION_DATA: Readonly<Record<string, string>> = {
  'issue.number': '42',
  'issue.title': 'Fix the login page',
  'issue.status': 'In progress',
  'issue.priority': 'High',
  'actor.name': 'Ana',
  'recipient.name': 'Ben',
  'workspace.name': 'Acme',
};

/** Fills `{{name}}` with the sample values; a name without one is kept, so it stays visible. */
export function previewTemplate(template: string): string {
  return template.replace(
    /\{\{\s*([\w.]+)\s*\}\}/g,
    (match, name: string) => SAMPLE_NOTIFICATION_DATA[name] ?? match,
  );
}
