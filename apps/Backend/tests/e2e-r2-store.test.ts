import { AwsClient } from 'aws4fetch';
import { describe, expect, it, vi } from 'vitest';
import { R2ArtifactStore, parseR2Url } from '../src/modules/e2e/adapters/r2-artifact-store.js';
import { createE2eArtifactStore } from '../src/modules/e2e/adapters/artifact-store-factory.js';
import { PrismaE2eArtifactStore } from '../src/modules/e2e/adapters/prisma-e2e-artifact-store.js';
import { FileSystemE2eArtifactStore } from '../src/modules/e2e/application/artifact-store.js';
import type { PrismaClient } from '../src/generated/prisma/client.js';

const ENDPOINT = 'https://example-account.r2.cloudflarestorage.com';
const BUCKET_URL = `${ENDPOINT}/adk-test-videos`;

function setup(responses: ((request: Request) => Response | undefined)[] = []) {
  const requests: Request[] = [];
  const fetcher = vi.fn((input: RequestInfo | URL) => {
    const request = input as Request;
    requests.push(request);
    for (const respond of responses) {
      const response = respond(request);
      if (response) return Promise.resolve(response);
    }
    return Promise.resolve(new Response('', { status: 200 }));
  });
  const store = new R2ArtifactStore({
    endpoint: ENDPOINT,
    bucket: 'adk-test-videos',
    accessKeyId: 'AKIDTEST',
    secretAccessKey: 'secret',
    fetcher: fetcher as unknown as typeof fetch,
  });
  return { store, requests };
}

const listXml = (keys: string[], next?: string) =>
  `<?xml version="1.0"?><ListBucketResult>${keys.map((key) => `<Contents><Key>${key}</Key></Contents>`).join('')}<IsTruncated>${next ? 'true' : 'false'}</IsTruncated>${next ? `<NextContinuationToken>${next}</NextContinuationToken>` : ''}</ListBucketResult>`;

describe('R2ArtifactStore', () => {
  it('uploads and downloads videos with SigV4-signed, path-style requests', async () => {
    const { store, requests } = setup([
      (request) =>
        request.method === 'GET' && request.url.endsWith('.mp4')
          ? new Response(new Uint8Array([1, 2, 3]))
          : undefined,
    ]);
    await store.put('ws/c1/t 1.mp4', Buffer.from('video'));
    const put = requests[0]!;
    expect(put.method).toBe('PUT');
    expect(put.url).toBe(`${BUCKET_URL}/e2e/ws/c1/t%201.mp4`);
    expect(put.headers.get('content-type')).toBe('video/mp4');
    expect(put.headers.get('authorization')).toMatch(
      /^AWS4-HMAC-SHA256 Credential=AKIDTEST\/\d{8}\/auto\/s3\/aws4_request, SignedHeaders=.+, Signature=[0-9a-f]{64}$/,
    );
    expect(Buffer.from(await put.arrayBuffer()).toString()).toBe('video');

    expect(await store.get('ws/c1/t1.mp4')).toEqual(Buffer.from([1, 2, 3]));
    await store.put('ws/c1/legacy.webm', Buffer.from('w'));
    await store.put('ws/c1/other.bin', Buffer.from('b'));
    expect(requests.at(-2)?.headers.get('content-type')).toBe('video/webm');
    expect(requests.at(-1)?.headers.get('content-type')).toBe('application/octet-stream');
  });

  it('returns null for missing objects and explains R2 errors', async () => {
    const { store } = setup([
      (request) =>
        request.url.includes('missing') ? new Response('', { status: 404 }) : undefined,
      (request) =>
        request.method === 'PUT'
          ? new Response('<Error><Code>InvalidAccessKeyId</Code></Error>', { status: 403 })
          : undefined,
      (request) =>
        request.url.includes('broken') ? new Response('oops', { status: 500 }) : undefined,
    ]);
    expect(await store.get('ws/missing.mp4')).toBeNull();
    await expect(store.put('ws/a.mp4', Buffer.from('x'))).rejects.toThrow(
      'R2 answered HTTP 403 (InvalidAccessKeyId) while storing ws/a.mp4.',
    );
    await expect(store.get('ws/broken.mp4')).rejects.toThrow(
      'R2 answered HTTP 500 while reading ws/broken.mp4.',
    );
  });

  it('removes every object under a run, following list pagination', async () => {
    const { store, requests } = setup([
      (request) => {
        const url = new URL(request.url);
        if (url.searchParams.get('list-type') !== '2') return undefined;
        return url.searchParams.get('continuation-token') === 'page&2'
          ? new Response(listXml(['e2e/ws/c1/t2.mp4', 'e2e/ws/c10/other.mp4']))
          : new Response(listXml(['e2e/ws/c1/t1.mp4', 'e2e/ws/c1/a&amp;b.mp4'], 'page&amp;2'));
      },
      (request) =>
        request.method === 'DELETE' && request.url.endsWith('t2.mp4')
          ? new Response('', { status: 404 })
          : undefined,
    ]);
    await store.removePrefix('ws/c1');
    const list = new URL(requests[0]!.url);
    expect(list.origin + list.pathname).toBe(BUCKET_URL);
    expect(list.searchParams.get('prefix')).toBe('e2e/ws/c1');
    const deleted = requests.filter((request) => request.method === 'DELETE').map((r) => r.url);
    expect(deleted).toEqual([
      `${BUCKET_URL}/e2e/ws/c1/t1.mp4`,
      `${BUCKET_URL}/e2e/ws/c1/a%26b.mp4`,
      `${BUCKET_URL}/e2e/ws/c1/t2.mp4`,
    ]);

    const failing = setup([
      (request) =>
        request.method === 'DELETE'
          ? new Response('', { status: 403 })
          : new Response(listXml(['e2e/ws/c1'])),
    ]);
    await expect(failing.store.removePrefix('ws/c1')).rejects.toThrow('while deleting e2e/ws/c1');
    // A malformed "truncated" page without a token must not loop forever.
    const malformed = setup([
      (request) =>
        request.method === 'GET'
          ? new Response('<ListBucketResult><IsTruncated>true</IsTruncated></ListBucketResult>')
          : undefined,
    ]);
    await malformed.store.removePrefix('ws/c1');
    expect(malformed.requests).toHaveLength(1);
    const unlisted = setup([() => new Response('', { status: 500 })]);
    await expect(unlisted.store.removePrefix('ws/c1')).rejects.toThrow('while listing e2e/ws/c1');
  });

  it('creates short-lived signed URLs the browser can stream', async () => {
    const { store } = setup();
    const signed = new URL(await store.signedUrl('ws/c1/t1.mp4', 3600));
    expect(signed.origin + signed.pathname).toBe(`${BUCKET_URL}/e2e/ws/c1/t1.mp4`);
    expect(signed.searchParams.get('X-Amz-Algorithm')).toBe('AWS4-HMAC-SHA256');
    expect(signed.searchParams.get('X-Amz-Expires')).toBe('3600');
    expect(signed.searchParams.get('X-Amz-Credential')).toMatch(
      /^AKIDTEST\/\d{8}\/auto\/s3\/aws4_request$/,
    );
    expect(signed.searchParams.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/);

    const unprefixed = new R2ArtifactStore({
      endpoint: `${ENDPOINT}/`,
      bucket: 'adk-test-videos',
      accessKeyId: 'a',
      secretAccessKey: 'b',
      prefix: '',
    });
    expect(new URL(await unprefixed.signedUrl('x.mp4', 60)).pathname).toBe(
      '/adk-test-videos/x.mp4',
    );
  });

  it('signs query strings exactly like the AWS SigV4 reference example', async () => {
    // "Example: Presigned URL" from the Amazon S3 SigV4 documentation.
    const client = new AwsClient({
      accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
      secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
      service: 's3',
      region: 'us-east-1',
    });
    const signed = await client.sign(
      'https://examplebucket.s3.amazonaws.com/test.txt?X-Amz-Expires=86400',
      { method: 'GET', aws: { signQuery: true, datetime: '20130524T000000Z' } },
    );
    expect(new URL(signed.url).searchParams.get('X-Amz-Signature')).toBe(
      'aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404',
    );
  });
});

describe('artifact store selection', () => {
  it('parses the R2 bucket URL', () => {
    expect(parseR2Url(`${BUCKET_URL}/`)).toEqual({
      endpoint: ENDPOINT,
      bucket: 'adk-test-videos',
    });
    for (const bad of [ENDPOINT, `${BUCKET_URL}/nested`, BUCKET_URL.replace('https', 'http')])
      expect(() => parseR2Url(bad)).toThrow('E2E_R2_URL must look like');
  });

  it('prefers R2, then Postgres, then local disk', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(''));
    const r2 = createE2eArtifactStore(
      {
        E2E_R2_URL: BUCKET_URL,
        E2E_R2_ACCESS_KEY_ID: 'id',
        E2E_R2_SECRET_ACCESS_KEY: 'secret',
        E2E_R2_PREFIX: 'videos',
      },
      {} as PrismaClient,
      fetcher as unknown as typeof fetch,
    );
    expect(r2.kind).toBe('r2');
    await r2.store.put('ws/a.mp4', Buffer.from('x'));
    expect((fetcher.mock.calls[0]![0] as Request).url).toBe(`${BUCKET_URL}/videos/ws/a.mp4`);

    const defaultPrefix = createE2eArtifactStore({
      E2E_R2_URL: BUCKET_URL,
      E2E_R2_ACCESS_KEY_ID: 'id',
      E2E_R2_SECRET_ACCESS_KEY: 'secret',
    });
    expect(new URL(await defaultPrefix.store.signedUrl!('a.mp4', 60)).pathname).toBe(
      '/adk-test-videos/e2e/a.mp4',
    );

    expect(() => createE2eArtifactStore({ E2E_R2_URL: BUCKET_URL })).toThrow(
      'E2E_R2_URL requires E2E_R2_ACCESS_KEY_ID and E2E_R2_SECRET_ACCESS_KEY',
    );
    const postgres = createE2eArtifactStore({}, {} as PrismaClient);
    expect(postgres).toMatchObject({ kind: 'postgres' });
    expect(postgres.store).toBeInstanceOf(PrismaE2eArtifactStore);
    const disk = createE2eArtifactStore({ E2E_ARTIFACTS_DIR: 'videos-dir' });
    expect(disk).toMatchObject({ kind: 'filesystem' });
    expect(disk.store).toBeInstanceOf(FileSystemE2eArtifactStore);
    expect(createE2eArtifactStore({}).kind).toBe('filesystem');
  });
});
