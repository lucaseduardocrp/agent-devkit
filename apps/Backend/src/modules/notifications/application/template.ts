import type { NotificationData } from '../domain/notification.js';

/** Fills `{{name}}` with the value of the event; a name the event does not have becomes empty. */
export function renderTemplate(template: string, data: NotificationData): string {
  return template.replace(
    /\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g,
    (_match, name: string) => data[name] ?? '',
  );
}
