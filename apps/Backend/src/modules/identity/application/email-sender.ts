export interface EmailMessage {
  readonly to: string;
  readonly subject: string;
  readonly text: string;
  readonly html: string;
}

export interface EmailSender {
  send(message: EmailMessage): Promise<void>;
}

export class UnavailableEmailSender implements EmailSender {
  public send(): Promise<void> {
    return Promise.reject(new Error('SMTP is not configured.'));
  }
}
