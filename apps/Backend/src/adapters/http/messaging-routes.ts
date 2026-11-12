import { timingSafeEqual } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { parseBridgeChatId } from '../../modules/messaging/application/cli-bridge.js';
import type { MessagingChatStore } from '../../modules/messaging/application/messaging-chat-store.js';
import type { TelegramGateway } from '../../modules/messaging/telegram/telegram-gateway.js';
import type { TelegramPairingCodes } from '../../modules/messaging/telegram/telegram-pairing.js';
import { TELEGRAM_PROVIDER_ID } from '../../modules/messaging/telegram/telegram-settings.js';
import { requireOwnerId } from '../../modules/knowledge/application/ownership.js';
import { ApplicationError } from '../../shared/errors.js';
import type { RequestContextResolver } from './compatibility-routes.js';
import { requireModuleAccess } from './module-policy.js';
import { parseBody, parseParams } from './validation.js';

export interface MessagingRouterOptions {
  readonly gateway: TelegramGateway;
  readonly chats: MessagingChatStore;
  readonly pairing: TelegramPairingCodes;
  /** BRIDGE_SHARED_TOKEN: enables the routes the CLI Bridge answers chats through. */
  readonly bridgeToken?: string;
  /** Shown to the user when the chat is paired. */
  readonly workspaceName: (workspaceId: string, actorId: string) => Promise<string>;
}

const chatParams = z.object({ id: z.string().trim().min(1).max(100) });
const workspaceParams = z.object({ workspaceId: z.string().trim().min(1).max(100) });
const chatPatch = z
  .object({
    notifications: z.boolean().optional(),
    agentId: z.string().trim().min(1).max(100).nullable().optional(),
  })
  .strict();

/**
 * The Telegram bot of a workspace: pairing codes, the paired chats (its allowlist) and the
 * webhook Telegram posts to. Saving the token and settings uses the generic integration routes.
 */
export function createMessagingRouter(
  options: MessagingRouterOptions,
  resolveRequestContext: RequestContextResolver,
): Router {
  const router = Router();
  const { gateway, chats, pairing } = options;

  router.get('/integrations/MESSAGING/telegram/chats', async (request, response, next) => {
    try {
      const context = await resolveRequestContext(request, response);
      const workspaceId = requireOwnerId(context);
      response.status(200).json({
        status: gateway.status(workspaceId),
        chats: await chats.list(workspaceId, TELEGRAM_PROVIDER_ID),
      });
    } catch (error) {
      next(error);
    }
  });

  router.post('/integrations/MESSAGING/telegram/pairing-code', async (request, response, next) => {
    try {
      const context = await resolveRequestContext(request, response);
      const workspaceId = requireOwnerId(context);
      requireModuleAccess(context, [{ module: 'integrations', operation: 'edit' }]);
      const actorId = context.actorId;
      if (!actorId) throw new ApplicationError('UNAUTHORIZED', 'Sign in first.', 401);
      const status = gateway.status(workspaceId);
      if (!status.running || !status.botUsername)
        throw new ApplicationError(
          'TELEGRAM_BOT_OFFLINE',
          'Save a valid bot token before pairing a chat.',
          409,
        );
      const { code, expiresAt } = await pairing.create({
        workspaceId,
        workspaceName: await options.workspaceName(workspaceId, actorId),
        actorId,
      });
      response.status(201).json({
        code,
        expiresAt: expiresAt.toISOString(),
        botUsername: status.botUsername,
        deepLink: `https://t.me/${status.botUsername}?start=${code}`,
      });
    } catch (error) {
      next(error);
    }
  });

  router.patch('/integrations/MESSAGING/telegram/chats/:id', async (request, response, next) => {
    try {
      const context = await resolveRequestContext(request, response);
      const workspaceId = requireOwnerId(context);
      requireModuleAccess(context, [{ module: 'integrations', operation: 'edit' }]);
      const { id } = parseParams(chatParams, request);
      const chat = await chats.update(workspaceId, id, parseBody(chatPatch, request));
      if (!chat)
        throw new ApplicationError('MESSAGING_CHAT_NOT_FOUND', `Chat '${id}' not found.`, 404);
      response.status(200).json({ chat });
    } catch (error) {
      next(error);
    }
  });

  router.delete('/integrations/MESSAGING/telegram/chats/:id', async (request, response, next) => {
    try {
      const context = await resolveRequestContext(request, response);
      const workspaceId = requireOwnerId(context);
      requireModuleAccess(context, [{ module: 'integrations', operation: 'delete' }]);
      const { id } = parseParams(chatParams, request);
      if (!(await chats.remove(workspaceId, id)))
        throw new ApplicationError('MESSAGING_CHAT_NOT_FOUND', `Chat '${id}' not found.`, 404);
      response.status(200).json({ deleted: true });
    } catch (error) {
      next(error);
    }
  });

  // Called by Telegram, not by ADK users: the secret header authenticates it.
  router.post('/messaging/telegram/webhook/:workspaceId', async (request, response, next) => {
    try {
      const { workspaceId } = parseParams(workspaceParams, request);
      const accepted = await gateway.receive(
        workspaceId,
        request.header('x-telegram-bot-api-secret-token'),
        request.body,
      );
      if (!accepted)
        throw new ApplicationError('TELEGRAM_WEBHOOK_FORBIDDEN', 'Invalid webhook secret.', 401);
      response.status(200).json({ ok: true });
    } catch (error) {
      next(error);
    }
  });

  // The CLI Bridge (apps/Bridge) answers chats through these. Not for users: the shared token
  // authenticates the Bridge, and the routes do not exist without one.
  if (options.bridgeToken) {
    const authorize = (header: string | undefined): void => {
      const expected = Buffer.from(`Bearer ${options.bridgeToken}`);
      const given = Buffer.from(header ?? '');
      if (given.length !== expected.length || !timingSafeEqual(given, expected))
        throw new ApplicationError('BRIDGE_FORBIDDEN', 'Invalid bridge token.', 401);
    };
    const bridgeMessage = z.object({
      chatId: z.string().trim().min(1).max(300),
      text: z.string().min(1).max(20_000),
    });
    const bridgeTyping = bridgeMessage.pick({ chatId: true });

    router.post('/messaging/bridge/send', async (request, response, next) => {
      try {
        authorize(request.header('authorization'));
        const body = parseBody(bridgeMessage, request);
        const target = parseBridgeChatId(body.chatId);
        if (!target) throw new ApplicationError('BRIDGE_BAD_CHAT', 'Invalid chat id.', 400);
        const delivered = await gateway.sendToChat(target.workspaceId, target.chatId, body.text);
        response.status(delivered ? 200 : 409).json({ delivered });
      } catch (error) {
        next(error);
      }
    });

    router.post('/messaging/bridge/typing', async (request, response, next) => {
      try {
        authorize(request.header('authorization'));
        const target = parseBridgeChatId(parseBody(bridgeTyping, request).chatId);
        if (!target) throw new ApplicationError('BRIDGE_BAD_CHAT', 'Invalid chat id.', 400);
        await gateway.typingInChat(target.workspaceId, target.chatId);
        response.status(200).json({ ok: true });
      } catch (error) {
        next(error);
      }
    });
  }

  return router;
}
