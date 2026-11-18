import {
  createAttachmentStore,
  createE2eArtifactStore,
} from '../modules/e2e/adapters/artifact-store-factory.js';
import { migrateAttachments } from '../modules/shared/attachment-migration.js';

/**
 * Moves attachments and images out of the E2E folder of the bucket.
 *   npm run migrate:attachments                    shows what would be copied (changes nothing)
 *   npm run migrate:attachments -- --apply         copies and verifies every file
 *   npm run migrate:attachments -- --apply --delete-legacy
 *                                                  also removes the originals that were verified
 */
const args = new Set(process.argv.slice(2));
const apply = args.has('--apply');
const deleteLegacy = args.has('--delete-legacy');
if (deleteLegacy && !apply) throw new Error('--delete-legacy only works together with --apply.');

const e2e = createE2eArtifactStore(process.env);
const { split } = createAttachmentStore(process.env, e2e);
if (!split) {
  console.log(
    'Nothing to migrate: attachments already use their own location, or share the E2E storage on purpose.',
  );
  process.exit(0);
}

console.log(apply ? 'Copying attachments and images…' : 'Dry run: nothing will be changed.');
const report = await migrateAttachments({ ...split, apply, deleteLegacy, log: console.log });
console.log(
  `Found ${report.found} | ${apply ? 'copied' : 'to copy'} ${report.copied} | already there ${report.alreadyThere} | failed ${report.failed.length} | deleted ${report.deleted} | ${(report.bytes / 1024 / 1024).toFixed(2)} MB`,
);
if (!apply) console.log('Run again with --apply to copy them.');
process.exit(report.failed.length > 0 ? 1 : 0);
