import nodemailer, { type Transporter } from 'nodemailer';
import type { EmailMessage, EmailSender } from '../application/email-sender.js';

const SMTP_CONNECTION_TIMEOUT_MS = 10_000;
const SMTP_GREETING_TIMEOUT_MS = 10_000;
const SMTP_SOCKET_TIMEOUT_MS = 15_000;
const SMTP_DELIVERY_TIMEOUT_MS = 10_000;

export interface SmtpEmailSenderOptions {
  readonly host: string;
  readonly port: number;
  readonly secure: boolean;
  readonly user?: string;
  readonly password?: string;
  readonly from: string;
  readonly url?: string;
  readonly deliveryTimeoutMs?: number;
}

export class SmtpEmailSender implements EmailSender {
  private readonly transporter: Transporter;

  public constructor(private readonly options: SmtpEmailSenderOptions) {
    this.transporter = nodemailer.createTransport({
      connectionTimeout: SMTP_CONNECTION_TIMEOUT_MS,
      greetingTimeout: SMTP_GREETING_TIMEOUT_MS,
      socketTimeout: SMTP_SOCKET_TIMEOUT_MS,
      ...(options.url
        ? { url: options.url }
        : {
            host: options.host,
            port: options.port,
            secure: options.secure,
            ...(options.user && options.password
              ? { auth: { user: options.user, pass: options.password } }
              : {}),
          }),
    });
  }

  public async send(message: EmailMessage): Promise<void> {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        this.transporter.sendMail({
          from: this.options.from,
          to: message.to,
          subject: message.subject,
          text: message.text,
          html: message.html,
        }),
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => {
            this.transporter.close();
            reject(new Error('SMTP delivery timed out.'));
          }, this.options.deliveryTimeoutMs ?? SMTP_DELIVERY_TIMEOUT_MS);
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }
}
