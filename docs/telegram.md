# Telegram

Each workspace can connect its own Telegram bot. Once a chat is paired with it, the people in that
chat can:

- **talk to the workspace's agents** from their phone, with the same agents, skills and Brain as
  the Playground;
- **receive notifications** when E2E, integration and load test runs finish.

The bot answers only in private chats, and only to chats paired in **Connect**. Other people who
find the bot get pairing instructions and nothing else.

## Set it up

1. In Telegram, open a chat with [@BotFather](https://t.me/BotFather), send `/newbot` and follow
   the steps. BotFather replies with a token like `123456789:AAF…`.
2. In ADK, open **Connect → Messaging → Telegram**, paste the token and click **Save**. **Test
   connection** checks the token first.
3. Open Telegram again and click **Generate pairing code**. Open the link on your phone, or send
   `/start CODE` to the bot. A code lasts 10 minutes and works once.

The chat then appears under **Paired chats**, where you can turn its notifications off or remove
it. Each person pairs their own chat with a new code.

## Settings

| Setting                        | Default            | Meaning                                                                         |
| ------------------------------ | ------------------ | ------------------------------------------------------------------------------- |
| How messages arrive            | Automatic          | A webhook when `API_PUBLIC_URL` is `https://`, long polling otherwise           |
| Answering agent                | The default agent  | The agent of chats that did not choose one with `/agent`                        |
| Ground answers on the Brain    | On                 | Searches the workspace's Brain for each question                                |
| Notifications of finished runs | E2E, Integration and Overload Tests | Which runs are reported. **Failures only** skips passing runs |

Agent runs from a chat act as the ADK member who generated its pairing code, and use the
workspace's LLM integration like any other run.

## Commands

| Command          | What it does                                                         |
| ---------------- | -------------------------------------------------------------------- |
| *any text*       | Asks the chat's agent. The last turns of the conversation are kept   |
| `/agents`        | Lists the workspace's agents                                         |
| `/agent <slug>`  | Chooses this chat's agent. `/agent default` goes back to the default |
| `/new`           | Starts a new conversation                                            |
| `/notify on/off` | Turns this chat's run notifications on or off                        |
| `/unlink`        | Disconnects the chat from ADK                                        |
| `/help`          | Shows the commands                                                   |

Long answers are split into several messages, because Telegram allows 4,096 characters per message.
The bot answers in Portuguese or English, following the language of the Telegram app.

## Polling and webhooks

- **Local install (Docker on your computer):** the API long-polls Telegram, so no public address,
  tunnel or open port is needed. The bot answers while ADK is running.
- **Railway or a server behind HTTPS:** with `API_PUBLIC_URL` set to an `https://` address, the
  API registers a webhook at `/messaging/telegram/webhook/<workspace id>`. Telegram signs each call
  with a secret derived from `INTEGRATION_ENCRYPTION_KEY`, and the API rejects calls without it.
  On Railway, a sleeping API wakes up when a message arrives.

A bot token can only be used by one ADK at a time. If you poll the same bot from two installs (or
from several API replicas), Telegram refuses the second one with a conflict and the API log says
so. Use a separate bot for each install, or the webhook mode.

Messages sent while ADK was offline for more than five minutes are dropped instead of being
answered late. Conversation history is kept in the API's memory and starts over when it restarts.

## Troubleshooting

| Problem                                    | What to do                                                                     |
| ------------------------------------------ | ------------------------------------------------------------------------------ |
| "Bot offline" in Connect                   | Check the token with **Test connection** and that the integration is enabled.  |
| "Webhook mode needs API_PUBLIC_URL…"       | Choose **Long polling**, or set `API_PUBLIC_URL` to the API's HTTPS address.   |
| "Invalid or expired code"                  | Generate a new code; each one works once, for 10 minutes.                      |
| The bot answers "I could not answer"       | The workspace has no working LLM integration, or the agent failed. See Connect. |
| Notifications do not arrive                | Check the switches in Connect and `/notify on` in the chat.                    |
