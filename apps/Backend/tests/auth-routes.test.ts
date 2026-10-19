import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/adapters/http/app.js';
import { InMemoryAuthRepository } from '../src/modules/identity/adapters/in-memory-auth-repository.js';
import { AuthService } from '../src/modules/identity/application/auth-service.js';
import { InMemoryKnowledgeSearch } from '../src/modules/knowledge/application/knowledge-search.js';

describe('Auth HTTP Routes & Context Resolution', () => {
  it('registers a user via POST /auth/register', async () => {
    const app = createApp();

    const response = await request(app).post('/auth/register').send({
      email: 'httpuser@example.com',
      password: 'StrongPassword123!',
      name: 'HTTP User',
    });

    expect(response.status).toBe(201);
    expect(response.body.user.email).toBe('httpuser@example.com');
    expect(response.body.user.name).toBe('HTTP User');
    expect(response.body.token).toBeDefined();
    expect(response.body.expiresAt).toBeDefined();
  });

  it('rejects invalid registration payloads', async () => {
    const app = createApp();

    const emptyResponse = await request(app).post('/auth/register').send({});
    expect(emptyResponse.status).toBe(400);
    expect(emptyResponse.body.code).toBe('VALIDATION_ERROR');

    const shortPassword = await request(app).post('/auth/register').send({
      email: 'user@example.com',
      password: '123',
      name: 'Name',
    });
    expect(shortPassword.status).toBe(400);
    expect(shortPassword.body.code).toBe('VALIDATION_ERROR');
  });

  it('logs in a user via POST /auth/login and rejects invalid credentials', async () => {
    const authService = new AuthService(new InMemoryAuthRepository());
    const app = createApp({ authService });

    await request(app).post('/auth/register').send({
      email: 'login@example.com',
      password: 'Password123!',
      name: 'Login User',
    });

    const successResponse = await request(app).post('/auth/login').send({
      email: 'login@example.com',
      password: 'Password123!',
    });
    expect(successResponse.status).toBe(200);
    expect(successResponse.body.token).toBeDefined();

    const wrongPassword = await request(app).post('/auth/login').send({
      email: 'login@example.com',
      password: 'wrong',
    });
    expect(wrongPassword.status).toBe(401);
    expect(wrongPassword.body.code).toBe('INVALID_CREDENTIALS');
  });

  it('retrieves profile via GET /auth/me and logs out via POST /auth/logout', async () => {
    const authService = new AuthService(new InMemoryAuthRepository());
    const app = createApp({ authService });

    const registerRes = await request(app).post('/auth/register').send({
      email: 'profile@example.com',
      password: 'Password123!',
      name: 'Profile User',
    });
    const token = registerRes.body.token;

    // Missing token
    const missingTokenRes = await request(app).get('/auth/me');
    expect(missingTokenRes.status).toBe(401);

    // Valid token
    const meRes = await request(app).get('/auth/me').set('Authorization', `Bearer ${token}`);
    expect(meRes.status).toBe(200);
    expect(meRes.body.user.email).toBe('profile@example.com');

    // Logout
    const logoutRes = await request(app)
      .post('/auth/logout')
      .set('Authorization', `Bearer ${token}`);
    expect(logoutRes.status).toBe(200);
    expect(logoutRes.body.success).toBe(true);

    // Logout with no token still returns success
    const noTokenLogout = await request(app).post('/auth/logout');
    expect(noTokenLogout.status).toBe(200);

    // Subsequent /auth/me fails
    const postLogoutMe = await request(app).get('/auth/me').set('Authorization', `Bearer ${token}`);
    expect(postLogoutMe.status).toBe(401);

    // Logout failure propagates error
    const spy = vi.spyOn(authService, 'logout').mockRejectedValueOnce(new Error('Logout failed'));
    const failedLogout = await request(app)
      .post('/auth/logout')
      .set('Authorization', `Bearer ${token}`);
    expect(failedLogout.status).toBe(500);
    spy.mockRestore();
  });

  it('injects authenticated user into context for protected operations', async () => {
    const authRepo = new InMemoryAuthRepository();
    const authService = new AuthService(authRepo);
    const knowledgeSearch = new InMemoryKnowledgeSearch([]);

    const app = createApp({
      authService,
      knowledgeSearch,
    });

    // Register user
    const reg = await request(app).post('/auth/register').send({
      email: 'authed@example.com',
      password: 'Password123!',
      name: 'Authed User',
    });
    const { token, user } = reg.body;

    // Put a chunk in search owned by this user
    await knowledgeSearch.search('anything', { requestId: 'req', ownerId: user.id });

    // Call /TestPlan/search with Bearer token
    const searchResponse = await request(app)
      .get('/TestPlan/search')
      .set('Authorization', `Bearer ${token}`)
      .query({ prompt: 'test' });

    // Status 204 means owner context was resolved properly! (empty results returns 204 instead of 403 OWNER_CONTEXT_REQUIRED)
    expect(searchResponse.status).toBe(204);
  });
});
