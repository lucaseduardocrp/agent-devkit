import { getMessages } from '../../lib/i18n/index.js';

/** Made-up values for the names a text may use, so a rule can be read as people will read it. */
export function sampleNotificationData(): Readonly<Record<string, string>> {
  const messages = getMessages().notifications;
  return {
    'issue.number': '42',
    'issue.title': messages.sampleIssueTitle,
    'issue.status': messages.sampleIssueStatus,
    'issue.priority': messages.sampleIssuePriority,
    'actor.name': 'Ana',
    'recipient.name': 'Ben',
    'workspace.name': 'Acme',
  };
}

/** Fills `{{name}}` with the sample values; a name without one is kept, so it stays visible. */
export function previewTemplate(template: string): string {
  const sample = sampleNotificationData();
  return template.replace(
    /\{\{\s*([\w.]+)\s*\}\}/g,
    (match, name: string) => sample[name] ?? match,
  );
}
