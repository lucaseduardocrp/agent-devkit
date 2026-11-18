import type { EmailSender } from '../../identity/application/email-sender.js';
import type { NotificationChannel, NotificationDelivery } from '../application/channel.js';

const escapeHtml = (value: string): string =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Delivers notifications by e-mail, through the same sender the sign-in e-mails use. */
export class EmailNotificationChannel implements NotificationChannel {
  readonly id = 'email';
  readonly label = 'E-mail';

  /**
   * @param sender the SMTP sender, or null when the server has none configured
   */
  constructor(private readonly sender: EmailSender | null) {}

  isAvailable(): Promise<boolean> {
    return Promise.resolve(this.sender !== null);
  }

  validateAddress(address: string): string | null {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address) ? null : 'Enter a valid e-mail address.';
  }

  async send({ recipient, message }: NotificationDelivery): Promise<void> {
    if (!this.sender) throw new Error('SMTP is not configured.');
    const link = message.url ? `<p><a href="${escapeHtml(message.url)}">Open in ADK</a></p>` : '';
    await this.sender.send({
      // The address an admin set for the person wins over the one of their ADK account.
      to: recipient.addresses?.['email'] ?? recipient.email,
      subject: message.title,
      text: message.url ? `${message.text}\n\n${message.url}` : message.text,
      html: `<p>${escapeHtml(message.text).replace(/\n/g, '<br>')}</p>` + link,
    });
  }
}
