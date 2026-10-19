import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { consoleLogger, createRequestLogger, type LogRecord } from '../src/shared/observability.js';

describe('HTTP observability', () => {
  it('writes a structured, correlation-aware record without request payloads', async () => {
    const records: LogRecord[] = [];
    const app = express();
    app.use(createRequestLogger({ info: (record) => records.push(record) }, () => 10));
    app.get('/probe', (_request, response) => response.status(204).send());

    await request(app).get('/probe').set('authorization', 'secret');

    expect(records).toEqual([
      {
        level: 'info',
        event: 'http.request.completed',
        requestId: 'unknown',
        method: 'GET',
        path: '/probe',
        statusCode: 204,
        durationMs: 0,
      },
    ]);
    expect(JSON.stringify(records)).not.toContain('secret');
  });

  it('serializes console records as JSON', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const record: LogRecord = {
      level: 'info',
      event: 'http.request.completed',
      requestId: 'request-1',
      method: 'GET',
      path: '/health',
      statusCode: 200,
      durationMs: 1,
    };

    consoleLogger.info(record);

    expect(spy).toHaveBeenCalledWith(JSON.stringify(record));
    spy.mockRestore();
  });
});
