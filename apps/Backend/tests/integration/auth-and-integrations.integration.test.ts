import { randomBytes, randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/adapters/http/app.js';
import { PostgresDatabase } from '../../src/adapters/persistence/postgres-database.js';
import {
  PrismaAuthRepository,
  type PrismaAuthClient,
} from '../../src/modules/identity/adapters/prisma-auth-repository.js';
import {
  PrismaUserIntegrationStore,
  type PrismaIntegrationsClient,
} from '../../src/modules/integrations/adapters/prisma-integrations-store.js';
import { AuthService } from '../../src/modules/identity/application/auth-service.js';
import { IntegrationsService } from '../../src/modules/integrations/application/integrations-service.js';
import { decryptSecret } from '../../src/shared/encryption.js';

function requireTestDatabaseUrl(): string {
  const value = process.env.TEST_DATABASE_URL;
  if (!value) {
    throw new Error('TEST_DATABASE_URL is required by the integration test configuration.');
  }
  return value;
}

const testDatabaseUrl = requireTestDatabaseUrl();
const runPrefix = `int-auth-${randomUUID().slice(0, 8)}`;
const testEncryptionKey = randomBytes(32).toString('hex');
process.env.INTEGRATION_ENCRYPTION_KEY = testEncryptionKey;

describe('PostgreSQL Authentication & Multi-Tenant Integrations E2E', () => {
  const database = new PostgresDatabase(testDatabaseUrl);
  const authRepo = new PrismaAuthRepository(database.client as unknown as PrismaAuthClient);
  const integrationsStore = new PrismaUserIntegrationStore(
    database.client as unknown as PrismaIntegrationsClient,
  );
  const authService = new AuthService(authRepo);
  const integrationsService = new IntegrationsService(integrationsStore);

  const app = createApp({
    authService,
    integrationsService,
  });

  const userAEmail = `${runPrefix}-alice@example.com`;
  const userBEmail = `${runPrefix}-bob@example.com`;

  let userAToken: string;
  let userAId: string;
  let userBToken: string;
  let userBId: string;

  afterAll(async () => {
    try {
      if (userAId || userBId) {
        const ids = [userAId, userBId].filter(Boolean);
        await database.client.sessionRecord.deleteMany({
          where: { userId: { in: ids } },
        });
        await database.client.integrationRecord.deleteMany({
          where: { ownerId: { in: ids } },
        });
        await database.client.userRecord.deleteMany({
          where: { id: { in: ids } },
        });
      }
    } finally {
      await database.close();
    }
  });

  it('registers distinct users and establishes independent sessions in PostgreSQL', async () => {
    // Register Alice
    const resA = await request(app)
      .post('/auth/register')
      .send({ email: userAEmail, password: 'AlicePassword123!', name: 'Alice Smith' })
      .expect(201);

    expect(resA.body.token).toBeDefined();
    expect(resA.body.user.email).toBe(userAEmail);
    expect(resA.body.user.name).toBe('Alice Smith');
    userAToken = resA.body.token;
    userAId = resA.body.user.id;

    // Register Bob
    const resB = await request(app)
      .post('/auth/register')
      .send({ email: userBEmail, password: 'BobPassword123!', name: 'Bob Jones' })
      .expect(201);

    expect(resB.body.token).toBeDefined();
    expect(resB.body.user.email).toBe(userBEmail);
    expect(resB.body.user.name).toBe('Bob Jones');
    userBToken = resB.body.token;
    userBId = resB.body.user.id;

    expect(userAId).not.toBe(userBId);

    // Verify /auth/me for both
    const meA = await request(app)
      .get('/auth/me')
      .set('authorization', `Bearer ${userAToken}`)
      .expect(200);
    expect(meA.body.user.id).toBe(userAId);

    const meB = await request(app)
      .get('/auth/me')
      .set('authorization', `Bearer ${userBToken}`)
      .expect(200);
    expect(meB.body.user.id).toBe(userBId);
  });

  it('stores AES-256-GCM encrypted integrations and isolates them strictly between users', async () => {
    // Integrations belong to a workspace; without the workspace module each user's id is the owner,
    // so each user gets a workspace with that id (deleted with the user).
    await database.client.workspaceRecord.createMany({
      data: [userAId, userBId].map((id) => ({
        id,
        name: 'Integration test',
        slug: id,
        ownerId: id,
      })),
    });

    // User A configures Azure DevOps Wiki
    const saveA = await request(app)
      .put('/integrations/KNOWLEDGE/azure_devops_wiki')
      .set('authorization', `Bearer ${userAToken}`)
      .send({
        isEnabled: true,
        settings: { organization: 'alice-org', project: 'alice-proj' },
        secret: 'alice-super-secret-pat-12345',
      })
      .expect(200);

    expect(saveA.body.hasSecret).toBe(true);
    expect(saveA.body.maskedSecret).toBe('••••••••');
    expect(saveA.body.settings.organization).toBe('alice-org');

    // User B configures GitHub Projects
    const saveB = await request(app)
      .put('/integrations/PROJECT_MANAGEMENT/github_projects')
      .set('authorization', `Bearer ${userBToken}`)
      .send({
        isEnabled: true,
        settings: { owner: 'bob-github-org', repo: 'bob-repo' },
        secret: 'bob-super-secret-gh-token-67890',
      })
      .expect(200);

    expect(saveB.body.hasSecret).toBe(true);
    expect(saveB.body.maskedSecret).toBe('••••••••');
    expect(saveB.body.settings.owner).toBe('bob-github-org');

    // User A lists integrations -> only Alice's Azure DevOps Wiki
    const listA = await request(app)
      .get('/integrations')
      .set('authorization', `Bearer ${userAToken}`)
      .expect(200);

    expect(listA.body).toHaveLength(1);
    expect(listA.body[0].providerId).toBe('azure_devops_wiki');
    expect(listA.body[0].hasSecret).toBe(true);
    expect(listA.body[0].maskedSecret).toBe('••••••••');

    // User B lists integrations -> only Bob's GitHub Projects
    const listB = await request(app)
      .get('/integrations')
      .set('authorization', `Bearer ${userBToken}`)
      .expect(200);

    expect(listB.body).toHaveLength(1);
    expect(listB.body[0].providerId).toBe('github_projects');
    expect(listB.body[0].hasSecret).toBe(true);

    // Cross-user deletion attempt: Alice tries to delete Bob's GitHub Projects
    const deleteRes = await request(app)
      .delete('/integrations/PROJECT_MANAGEMENT/github_projects')
      .set('authorization', `Bearer ${userAToken}`)
      .expect(200);
    expect(deleteRes.body.deleted).toBe(false);

    // Verify Bob's GitHub Projects integration was NOT deleted
    const verifyB = await request(app)
      .get('/integrations')
      .set('authorization', `Bearer ${userBToken}`)
      .expect(200);
    expect(verifyB.body).toHaveLength(1);
    expect(verifyB.body[0].providerId).toBe('github_projects');
  });

  it('proves secrets in PostgreSQL are encrypted and cannot be deciphered in plaintext', async () => {
    // Inspect database row directly using Prisma Client
    const recordA = await database.client.integrationRecord.findFirst({
      where: { ownerId: userAId, providerId: 'azure_devops_wiki' },
    });

    expect(recordA).not.toBeNull();
    expect(recordA?.encryptedSecrets).not.toBeNull();
    // Plaintext PAT must NOT exist in the database column
    expect(recordA?.encryptedSecrets).not.toContain('alice-super-secret-pat-12345');
    expect(recordA?.encryptedSecrets).toMatch(/^[0-9a-f]{24}:[0-9a-f]{32}:[0-9a-f]+$/i);

    // Decryption with the valid key produces the original secret
    const decrypted = decryptSecret(recordA!.encryptedSecrets!, testEncryptionKey);
    expect(decrypted).toBe('alice-super-secret-pat-12345');

    // Tampered ciphertext fails authentication
    const tampered = `${recordA!.encryptedSecrets!}ff`;
    expect(() => decryptSecret(tampered, testEncryptionKey)).toThrow();
  });
});
