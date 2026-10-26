import { beforeEach, describe, expect, it, vi } from 'vitest';

const { close, createTransport, sendMail } = vi.hoisted(() => ({
  close: vi.fn(),
  createTransport: vi.fn(),
  sendMail: vi.fn(),
}));

vi.mock('nodemailer', () => ({
  default: { createTransport },
}));

import { SmtpEmailSender } from '../src/modules/identity/adapters/smtp-email-sender.js';

describe('SmtpEmailSender', () => {
  beforeEach(() => {
    createTransport.mockReset();
    close.mockReset();
    sendMail.mockReset().mockResolvedValue(undefined);
    createTransport.mockReturnValue({ close, sendMail });
  });

  it('uses bounded timeouts with an SMTP URL and sends the complete message', async () => {
    const sender = new SmtpEmailSender({
      host: '',
      port: 587,
      secure: false,
      from: 'adk <no-reply@example.com>',
      url: 'smtps://user:password@smtp.example.com',
    });

    expect(createTransport).toHaveBeenCalledWith({
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 15_000,
      url: 'smtps://user:password@smtp.example.com',
    });

    await sender.send({
      to: 'user@example.com',
      subject: 'Recover account',
      text: 'Recovery text',
      html: '<p>Recovery text</p>',
    });

    expect(sendMail).toHaveBeenCalledWith({
      from: 'adk <no-reply@example.com>',
      to: 'user@example.com',
      subject: 'Recover account',
      text: 'Recovery text',
      html: '<p>Recovery text</p>',
    });
  });

  it('configures host-based SMTP with optional authentication', () => {
    new SmtpEmailSender({
      host: 'smtp.example.com',
      port: 587,
      secure: false,
      user: 'user@example.com',
      password: 'password',
      from: 'adk <no-reply@example.com>',
    });

    expect(createTransport).toHaveBeenCalledWith({
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 15_000,
      host: 'smtp.example.com',
      port: 587,
      secure: false,
      auth: { user: 'user@example.com', pass: 'password' },
    });
  });

  it('closes a stalled transport and rejects within the delivery deadline', async () => {
    sendMail.mockReturnValue(new Promise(() => undefined));
    const sender = new SmtpEmailSender({
      host: 'smtp.example.com',
      port: 465,
      secure: true,
      from: 'adk <no-reply@example.com>',
      deliveryTimeoutMs: 1,
    });

    await expect(
      sender.send({
        to: 'user@example.com',
        subject: 'Recover account',
        text: 'Recovery text',
        html: '<p>Recovery text</p>',
      }),
    ).rejects.toThrow('SMTP delivery timed out.');
    expect(close).toHaveBeenCalledOnce();
  });

  it('reports a transport that fails before sending', async () => {
    sendMail.mockImplementation(() => {
      throw new Error('transport closed');
    });
    const sender = new SmtpEmailSender({
      host: 'smtp.example.com',
      port: 587,
      secure: false,
      from: 'no-reply@example.com',
    });
    await expect(
      sender.send({ to: 'user@example.com', subject: 'Hi', text: 'Hi', html: '<p>Hi</p>' }),
    ).rejects.toThrow('transport closed');
  });
});
