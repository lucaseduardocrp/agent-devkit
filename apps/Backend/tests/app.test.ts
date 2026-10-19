import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { createApp, errorMiddleware } from '../src/adapters/http/app.js';
import { ApplicationError } from '../src/shared/errors.js';

describe('HTTP application', () => {
  it('returns health status and a request id', async () => {
    const records: unknown[] = [];
    const response = await request(
      createApp({ logger: { info: (record) => records.push(record) } }),
    )
      .get('/health')
      .set('x-request-id', 'request-1');

    expect(response.status).toBe(200);
    expect(response.headers['x-request-id']).toBe('request-1');
    expect(response.body).toEqual({ status: 'ok', requestId: 'request-1' });
    expect(records).toEqual([
      expect.objectContaining({ requestId: 'request-1', path: '/health', statusCode: 200 }),
    ]);
  });

  it('reports separate liveness and successful readiness', async () => {
    const app = createApp({
      readinessProbes: [{ name: 'database', check: async () => undefined }],
    });

    const [live, ready] = await Promise.all([
      request(app).get('/health/live'),
      request(app).get('/health/ready'),
    ]);

    expect(live.body).toEqual({ status: 'alive' });
    expect(ready.status).toBe(200);
    expect(ready.body).toEqual({
      status: 'ready',
      checks: [{ name: 'database', status: 'ready' }],
    });
  });

  it('fails readiness without exposing dependency errors', async () => {
    const app = createApp({
      readinessProbes: [
        {
          name: 'database',
          check: async () => {
            throw new Error('password=secret');
          },
        },
      ],
    });

    const response = await request(app).get('/health/ready');

    expect(response.status).toBe(503);
    expect(response.body).toEqual({
      status: 'not-ready',
      checks: [{ name: 'database', status: 'not-ready' }],
    });
    expect(response.text).not.toContain('secret');
  });

  it('is ready when no mandatory dependencies are configured', async () => {
    const response = await request(createApp()).get('/health/ready');
    expect(response.body).toEqual({ status: 'ready', checks: [] });
  });

  it('generates a request id when one is not supplied', async () => {
    const response = await request(createApp()).get('/health');

    expect(response.status).toBe(200);
    expect(response.headers['x-request-id']).toEqual(expect.any(String));
  });

  it('returns a standard not found response for unknown routes', async () => {
    const response = await request(createApp()).get('/unknown');

    expect(response.status).toBe(404);
    expect(response.body).toEqual({});
  });

  it('returns an internal error for malformed JSON', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const response = await request(createApp())
        .post('/health')
        .set('content-type', 'application/json')
        .set('x-request-id', 'malformed-request')
        .send('{');

      expect(response.status).toBe(500);
      expect(response.headers['x-request-id']).toBe('malformed-request');
      expect(response.body.code).toBe('INTERNAL_ERROR');
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('[UnhandledError malformed-request]:'),
        expect.anything(),
      );
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('serializes application errors from the HTTP boundary', async () => {
    const app = express();
    app.get('/', () => {
      throw new ApplicationError('TEST_ERROR', 'Expected failure.', 422);
    });
    app.use(errorMiddleware);

    const response = await request(app).get('/');

    expect(response.status).toBe(422);
    expect(response.body.code).toBe('TEST_ERROR');
  });

  it('handles CORS preflight and includes CORS headers on requests', async () => {
    const app = createApp();

    const preflight = await request(app).options('/health');
    expect(preflight.status).toBe(204);
    expect(preflight.headers['access-control-allow-origin']).toBe('*');
    expect(preflight.headers['access-control-allow-methods']).toContain('OPTIONS');
    expect(preflight.headers['access-control-allow-headers']).toContain('x-locale');
    expect(preflight.headers['access-control-allow-headers']).toContain('Accept-Language');

    const getRes = await request(app).get('/health');
    expect(getRes.headers['access-control-allow-origin']).toBe('*');
    expect(getRes.headers['x-locale']).toBe('pt-BR');
  });

  it('sets x-locale response header based on accept-language or x-locale request header', async () => {
    const app = createApp();

    const resPt = await request(app).get('/health').set('Accept-Language', 'pt-BR');
    expect(resPt.headers['x-locale']).toBe('pt-BR');

    const resEn = await request(app).get('/health').set('x-locale', 'en-US');
    expect(resEn.headers['x-locale']).toBe('en-US');

    const precedence = await request(app)
      .get('/health')
      .set('x-locale', 'en-US')
      .set('Accept-Language', 'pt-BR');
    expect(precedence.headers['x-locale']).toBe('en-US');

    const invalid = await request(app).get('/health').set('x-locale', 'fr-FR');
    expect(invalid.headers['x-locale']).toBe('pt-BR');
  });

  it('localizes application errors based on requested locale', async () => {
    const app = createApp();

    const resPt = await request(app).get('/workspaces/any-id').set('Accept-Language', 'pt-BR');
    expect(resPt.status).toBe(401);
    expect(resPt.body.message).toBe('Credenciais inválidas ou ausentes.');

    const resEn = await request(app).get('/workspaces/any-id').set('Accept-Language', 'en-US');
    expect(resEn.status).toBe(401);
    expect(resEn.body.message).toBe('Invalid or missing credentials.');
  });
});
