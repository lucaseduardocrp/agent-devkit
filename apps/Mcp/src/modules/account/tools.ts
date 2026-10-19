import { z } from 'zod';
import { AdkApiError, buildUrl, segment } from '../../api/http-client.js';
import type { McpModule } from '../../core/registry.js';
import type { ToolContext } from '../../core/tool.js';
import { defineTool, json } from '../../core/tool.js';

interface AuthResponse {
  readonly user: { id: string; email: string; name: string; createdAt?: string };
  readonly token: string;
  readonly expiresAt: string;
}

const email = z.string().trim().email().describe('Account e-mail.');
const CREDENTIAL_NOTICE =
  'Prefer running `devkit login` in a terminal: credentials typed in chat are sent to the model provider.';

/** Stores the session and returns only non-secret data: the token never reaches the model. */
async function remember(context: ToolContext, auth: AuthResponse) {
  await context.session.update({ token: auth.token, expiresAt: auth.expiresAt, user: auth.user });
  return json({ authenticated: true, user: auth.user, expiresAt: auth.expiresAt });
}

export const accountModule: McpModule = {
  toolset: 'account',
  tools: [
    defineTool({
      name: 'auth_get_options',
      title: 'Login options',
      description: 'Lists the OAuth login providers enabled on this ADK deployment.',
      toolset: 'account',
      access: 'read',
      routes: ['GET /auth/options'],
      input: {},
      run: async (_input, { api }) =>
        json(await api.request({ method: 'GET', path: '/auth/options', withoutWorkspace: true })),
    }),
    defineTool({
      name: 'auth_register',
      title: 'Create account',
      description: `Creates an ADK account and signs this MCP session in. ${CREDENTIAL_NOTICE}`,
      toolset: 'account',
      access: 'write',
      routes: ['POST /auth/register'],
      input: {
        name: z.string().trim().min(1).describe('Display name.'),
        email,
        password: z.string().min(8).describe('Password with at least 8 characters.'),
      },
      run: async (input, context) =>
        remember(
          context,
          await context.api.request<AuthResponse>({
            method: 'POST',
            path: '/auth/register',
            body: input,
            withoutWorkspace: true,
          }),
        ),
    }),
    defineTool({
      name: 'auth_login',
      title: 'Sign in',
      description: `Signs this MCP session in with e-mail and password. ${CREDENTIAL_NOTICE}`,
      toolset: 'account',
      access: 'write',
      routes: ['POST /auth/login'],
      input: { email, password: z.string().min(1).describe('Account password.') },
      run: async (input, context) =>
        remember(
          context,
          await context.api.request<AuthResponse>({
            method: 'POST',
            path: '/auth/login',
            body: input,
            withoutWorkspace: true,
          }),
        ),
    }),
    defineTool({
      name: 'auth_request_password_reset',
      title: 'Request password reset',
      description: 'Sends a 6-digit recovery code to the account e-mail.',
      toolset: 'account',
      access: 'write',
      routes: ['POST /auth/password/forgot'],
      input: { email },
      run: async (input, { api }) =>
        json(
          await api.request({
            method: 'POST',
            path: '/auth/password/forgot',
            body: input,
            withoutWorkspace: true,
          }),
        ),
    }),
    defineTool({
      name: 'auth_reset_password',
      title: 'Reset password',
      description: `Sets a new password with the e-mailed code and signs this session in. ${CREDENTIAL_NOTICE}`,
      toolset: 'account',
      access: 'write',
      routes: ['POST /auth/password/reset'],
      input: {
        email,
        code: z
          .string()
          .regex(/^\d{6}$/)
          .describe('6-digit code received by e-mail.'),
        password: z.string().min(8).describe('New password with at least 8 characters.'),
      },
      run: async (input, context) =>
        remember(
          context,
          await context.api.request<AuthResponse>({
            method: 'POST',
            path: '/auth/password/reset',
            body: input,
            withoutWorkspace: true,
          }),
        ),
    }),
    defineTool({
      name: 'auth_get_oauth_url',
      title: 'OAuth login URL',
      description:
        'Returns the browser URL for Google or GitHub login. After logging in on the web app, the user connects this server with `devkit login --token <token>` in a terminal.',
      toolset: 'account',
      access: 'read',
      routes: ['GET /auth/oauth/:provider/start'],
      input: { provider: z.enum(['google', 'github']).describe('OAuth provider.') },
      run: (input, { apiUrl }) =>
        Promise.resolve(
          json({
            url: buildUrl(apiUrl, `/auth/oauth/${segment(input.provider)}/start`),
            next: 'Open the URL in a browser, then run `devkit login --token <token>` in a terminal.',
          }),
        ),
    }),
    defineTool({
      name: 'auth_whoami',
      title: 'Current user',
      description: 'Shows the signed-in user and the active workspace of this MCP session.',
      toolset: 'account',
      access: 'read',
      routes: ['GET /auth/me'],
      input: {},
      run: async (_input, { api, session }) => {
        const state = await session.state();
        // The credential may come from the stored session or from the HTTP request, so ask ADK.
        let me: { user: unknown };
        try {
          me = await api.request<{ user: unknown }>({
            method: 'GET',
            path: '/auth/me',
            withoutWorkspace: true,
          });
        } catch (error) {
          if (!(error instanceof AdkApiError) || error.status !== 401) throw error;
          return json({
            authenticated: false,
            next: 'Run `devkit login` in a terminal, set ADK_TOKEN, or call auth_login.',
          });
        }
        return json({
          authenticated: true,
          user: me.user,
          expiresAt: state.expiresAt,
          activeWorkspaceId: state.workspaceId ?? null,
        });
      },
    }),
    defineTool({
      name: 'auth_logout',
      title: 'Sign out',
      description: 'Revokes the session token and forgets it locally.',
      toolset: 'account',
      access: 'write',
      routes: ['POST /auth/logout'],
      input: {},
      run: async (_input, { api, session }) => {
        await api.request({ method: 'POST', path: '/auth/logout', withoutWorkspace: true });
        await session.clear();
        return json({ success: true });
      },
    }),
    defineTool({
      name: 'auth_list_tokens',
      title: 'List access tokens',
      description:
        'Lists the personal access tokens of the signed-in user (names, scopes, expiry, last use; never the secrets). New tokens are created in the web app (Settings → Access tokens) or with `devkit login`.',
      toolset: 'account',
      access: 'read',
      routes: ['GET /auth/tokens'],
      input: {},
      run: async (_input, { api }) =>
        json(await api.request({ method: 'GET', path: '/auth/tokens', withoutWorkspace: true })),
    }),
    defineTool({
      name: 'auth_revoke_token',
      title: 'Revoke access token',
      description:
        'Revokes a personal access token immediately. Revoking the token this session uses signs it out.',
      toolset: 'account',
      access: 'destructive',
      routes: ['DELETE /auth/tokens/:id'],
      input: { tokenId: z.string().trim().min(1).describe('Token id from auth_list_tokens.') },
      run: async (input, { api }) =>
        json(
          await api.request({
            method: 'DELETE',
            path: `/auth/tokens/${segment(input.tokenId)}`,
            withoutWorkspace: true,
          }),
        ),
    }),
    defineTool({
      name: 'system_health',
      title: 'API health',
      description: 'Checks whether the ADK API is up and ready (database and dependencies).',
      toolset: 'account',
      access: 'read',
      routes: ['GET /health', 'GET /health/live', 'GET /health/ready'],
      input: {
        probe: z
          .enum(['status', 'live', 'ready'])
          .default('ready')
          .describe('status = basic info, live = process alive, ready = dependencies ready.'),
      },
      run: async (input, { api }) => {
        const path = input.probe === 'status' ? '/health' : `/health/${input.probe}`;
        try {
          return json(await api.request({ method: 'GET', path, withoutWorkspace: true }));
        } catch (error) {
          // A 503 from /health/ready is a meaningful answer, not a tool failure.
          if (input.probe === 'ready') return json({ status: 'not-ready', error: String(error) });
          throw error;
        }
      },
    }),
  ],
};
