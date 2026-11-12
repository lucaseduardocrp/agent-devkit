import type { McpModule } from '../core/registry.js';
import { accountModule } from './account/tools.js';
import { agentsModule } from './agents/tools.js';
import { integrationTestsModule, loadTestsModule } from './apitests/tools.js';
import { auditModule } from './audit/tools.js';
import { brainModule } from './brain/tools.js';
import { designModule } from './design/tools.js';
import { e2eModule } from './e2e/tools.js';
import {
  fieldMappingsModule,
  pbiFieldsModule,
  testPlanFieldsModule,
} from './field-mappings/tools.js';
import { integrationsModule } from './integrations/tools.js';
import { issuesModule } from './issues/tools.js';
import { notificationsModule } from './notifications/tools.js';
import { pbiModule } from './pbi/tools.js';
import { releaseNotesModule } from './release-notes/tools.js';
import { developmentModule } from './development/tools.js';
import { specModule } from './spec/tools.js';
import { testPlansModule } from './testplans/tools.js';
import { workspacesModule } from './workspaces/tools.js';

/**
 * Every feature module of ADK. Adding a capability = adding a tool to its module (or a new module
 * here); the parity test fails until each backend route is covered or explicitly excluded.
 */
export const modules: readonly McpModule[] = [
  accountModule,
  workspacesModule,
  integrationsModule,
  fieldMappingsModule,
  brainModule,
  agentsModule,
  issuesModule,
  pbiModule,
  pbiFieldsModule,
  specModule,
  testPlansModule,
  testPlanFieldsModule,
  designModule,
  e2eModule,
  integrationTestsModule,
  loadTestsModule,
  releaseNotesModule,
  developmentModule,
  auditModule,
  notificationsModule,
];

/** Backend routes that are intentionally not exposed as tools, with the reason. */
export const excludedRoutes: Readonly<Record<string, string>> = {
  'GET /auth/oauth/:provider/callback':
    'Browser redirect target of the OAuth provider; auth_get_oauth_url starts the flow instead.',
  'POST /auth/tokens':
    'Creating a token returns its secret; it must not transit through the model. Use the web app or `devkit login`, which stores it locally.',
  'POST /costs/usage':
    'Internal usage accounting: the MCP server itself reports the estimated host-model tokens of every tool call; it is not an action for the model.',
  'GET /e2e/tests/:id/video':
    'Binary MP4 stream for the web player; e2e_get_video_url returns a shareable link instead of sending video bytes through the model.',
  'GET /e2e/tests/:id/steps/:position/screenshot':
    'Binary PNG evidence for the web app; step results report hasScreenshot and e2e_publish_run uploads the screenshots to the test management platform, so no image bytes go through the model.',
  'POST /api-tests/runner/claim':
    'Protocol of `devkit runner`: it long-polls for its user’s local API test runs; the model starts them with integration_run or load_run (target local).',
  'POST /api-tests/runner/runs/:id/heartbeat':
    'Protocol of `devkit runner`: progress of a local API test run.',
  'POST /api-tests/runner/runs/:id/complete':
    'Protocol of `devkit runner`: result of a local API test run.',
  'POST /e2e/runner/claim':
    'Protocol of `devkit runner`: the local runner long-polls for its user’s browser work; the model starts local runs with e2e_run instead.',
  'POST /e2e/runner/tasks/:id/heartbeat':
    'Protocol of `devkit runner`: keeps a claimed browser task alive while it runs on the user’s computer.',
  'PUT /e2e/runner/tasks/:id/artifacts/:name':
    'Protocol of `devkit runner`: binary video and screenshot upload from the user’s computer; no evidence bytes go through the model.',
  'POST /e2e/runner/tasks/:id/complete':
    'Protocol of `devkit runner`: reports the outcome of a browser task; e2e_get and e2e_get_test show the results.',
  'POST /wake':
    'Internal call from the ADK API to the E2E worker service (worker token, not a user route); e2e_create and e2e_run enqueue work and wake it.',
  'POST /WikiWebhook/azure-devops':
    'Inbound Azure DevOps service hook, called by Azure and not by users; brain_sync covers manual sync.',
  'GET /runs/stream':
    'Server-sent events for the web app (Agent map, run flow); a model asks issues_runs or issues_run_get when it needs a run.',
  'GET /attachments/files/:id':
    'Binary download of a stored attachment for the web app; no file bytes go through the model.',
  'GET /attachments/images/:scope/:id':
    'Binary image stream of attachments saved before generic attachments, kept for the web app.',
  'GET /attachments/proxy':
    'Binary stream of provider-hosted files for the web app, sent with the workspace integration credentials.',
  'GET /knowledge/documents/:pageId/attachments':
    'Attachment panel of a Brain document in the web app; its files are uploaded through the browser.',
  'PUT /knowledge/documents/:pageId/attachments':
    'Saves the attachment panel of a Brain document after the browser uploads its files.',
  'POST /runs/:id/continue':
    'Human review gate of a paused server run (approve, answer or request changes); the agent being reviewed must not approve its own work.',
  'POST /messaging/bridge/send':
    'Server-to-server call of the messaging Bridge, authenticated with the bridge token; not a user action.',
  'POST /messaging/bridge/typing':
    'Server-to-server call of the messaging Bridge, authenticated with the bridge token; not a user action.',
  'GET /capabilities':
    'Feature detection of the web app (host access of a local install); not workspace data.',
  'PUT /integration-tests/collections/:id/runtime':
    'Hand-editing runtime variables and cookies happens in the web request editor; runs set them, and integration_clear_runtime resets them.',
  'GET /integration-tests/dynamic-values':
    'Mock value catalog for the completion menu of the web request editor; the generated values are documented in the integration tool descriptions.',
  'POST /messaging/telegram/webhook/:workspaceId':
    'Inbound Telegram webhook, called by Telegram with its secret header and not by users.',
  'POST /integrations/MESSAGING/telegram/pairing-code':
    'Pairing codes let whoever sends them talk to the workspace agents; they are shown to a person in Connect and must not transit through the model.',
  'GET /integrations/MESSAGING/telegram/chats':
    'Telegram allowlist managed in Connect; the bot itself is the channel to the agents.',
  'PATCH /integrations/MESSAGING/telegram/chats/:id':
    'Telegram allowlist managed in Connect; the bot itself is the channel to the agents.',
  'DELETE /integrations/MESSAGING/telegram/chats/:id':
    'Removing a paired Telegram chat is an access-control change made by a person in Connect.',
  'GET /design/settings':
    'Repository and branch of the Design module, chosen by a person in the Design settings of the web app; the design tools work in whatever it points to.',
  'PUT /design/settings':
    'Repository and branch of the Design module, chosen by a person in the Design settings of the web app; the design tools work in whatever it points to.',
  'DELETE /design/settings':
    'Disconnects the repository of the Design module, chosen by a person in the Design settings of the web app, same as the two routes above.',
  'GET /design/repositories':
    'Repository picker of the Design settings in the web app; e2e_list_repositories lists the same repositories.',
  'GET /design/repositories/branches':
    'Branch picker of the Design settings in the web app; e2e_list_branches lists the same branches.',
  'PUT /e2e/tests/:id/hook-instructions':
    "Guidance for ADK's own author of Before Run and After Run scripts, edited in the web app; an MCP host writes those scripts itself with e2e_update_script.",
  'GET /development/stream':
    'Server-sent events for the web app (pipeline and session board); a model asks development_pipeline or development_get_session when it needs the current state.',
  'GET /e2e/creations/:id/exploration/images/:page':
    'Binary JPEG of an explored page for the web app; e2e_get_exploration reports the pages found, so no image bytes go through the model.',
  'GET /e2e/source/images/:page':
    'Binary JPEG of a discovered page of the Source for the web app; e2e_get_source reports the same pages as data.',
  'GET /e2e/tests/:id/trail/:kind/:index':
    'Binary JPEG of a trail page or element for the web app; e2e_get_action_map reports the same pages and elements as data.',
  'GET /e2e/tests/:id/live':
    'Live JPEG frame of a running test for the web player; e2e_get shows its status and steps.',
};
