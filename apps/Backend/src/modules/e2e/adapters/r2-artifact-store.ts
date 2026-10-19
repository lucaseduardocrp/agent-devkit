import { AwsClient } from 'aws4fetch';
import type { E2eArtifactStore } from '../application/artifact-store.js';

export interface R2ArtifactStoreOptions {
  /** Account endpoint, e.g. https://<account-id>.r2.cloudflarestorage.com */
  readonly endpoint: string;
  readonly bucket: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  /** Folder inside the bucket for E2E artifacts. */
  readonly prefix?: string;
  readonly fetcher?: typeof fetch;
}

const encodeKey = (key: string): string => key.split('/').map(encodeURIComponent).join('/');
const decodeXml = (value: string): string =>
  value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');

/**
 * Cloudflare R2 (S3 API, SigV4) storage for test videos: shared by the API and every worker,
 * survives deploys, and lets browsers stream videos through short-lived signed URLs.
 */
export class R2ArtifactStore implements E2eArtifactStore {
  private readonly client: AwsClient;
  private readonly bucketUrl: string;
  private readonly prefix: string;
  private readonly fetcher: typeof fetch;

  constructor(options: R2ArtifactStoreOptions) {
    // R2 signs with the "auto" region; "s3" is the service name for its S3 API.
    this.client = new AwsClient({
      accessKeyId: options.accessKeyId,
      secretAccessKey: options.secretAccessKey,
      service: 's3',
      region: 'auto',
    });
    this.bucketUrl = `${options.endpoint.replace(/\/+$/, '')}/${encodeURIComponent(options.bucket)}`;
    this.prefix = (options.prefix ?? 'e2e').replace(/^\/+|\/+$/g, '');
    this.fetcher = options.fetcher ?? fetch;
  }

  async put(key: string, content: Uint8Array): Promise<void> {
    const response = await this.send(this.objectUrl(key), {
      method: 'PUT',
      body: new Uint8Array(content),
      headers: { 'content-type': contentType(key) },
    });
    await ensureOk(response, `storing ${key}`);
  }

  async get(key: string): Promise<Buffer | null> {
    const response = await this.send(this.objectUrl(key), { method: 'GET' });
    if (response.status === 404) return null;
    await ensureOk(response, `reading ${key}`);
    return Buffer.from(await response.arrayBuffer());
  }

  async removePrefix(prefix: string): Promise<void> {
    for (const key of await this.list(this.fullKey(prefix)))
      if (key === this.fullKey(prefix) || key.startsWith(`${this.fullKey(prefix)}/`)) {
        const response = await this.send(`${this.bucketUrl}/${encodeKey(key)}`, {
          method: 'DELETE',
        });
        if (response.status !== 404) await ensureOk(response, `deleting ${key}`);
      }
  }

  async signedUrl(key: string, expiresInSeconds: number): Promise<string> {
    const url = new URL(this.objectUrl(key));
    url.searchParams.set('X-Amz-Expires', String(expiresInSeconds));
    const signed = await this.client.sign(url.toString(), {
      method: 'GET',
      aws: { signQuery: true },
    });
    return signed.url;
  }

  private async list(prefix: string): Promise<string[]> {
    const keys: string[] = [];
    let token: string | undefined;
    do {
      const url = new URL(this.bucketUrl);
      url.searchParams.set('list-type', '2');
      url.searchParams.set('prefix', prefix);
      if (token) url.searchParams.set('continuation-token', token);
      const response = await this.send(url.toString(), { method: 'GET' });
      await ensureOk(response, `listing ${prefix}`);
      const xml = await response.text();
      keys.push(...[...xml.matchAll(/<Key>([^<]*)<\/Key>/g)].map((match) => decodeXml(match[1]!)));
      token = /<IsTruncated>true<\/IsTruncated>/.test(xml)
        ? decodeXml(/<NextContinuationToken>([^<]*)</.exec(xml)?.[1] ?? '')
        : undefined;
    } while (token);
    return keys;
  }

  private fullKey(key: string): string {
    return this.prefix ? `${this.prefix}/${key}` : key;
  }

  private objectUrl(key: string): string {
    return `${this.bucketUrl}/${encodeKey(this.fullKey(key))}`;
  }

  private async send(url: string, init: RequestInit): Promise<Response> {
    return this.fetcher(await this.client.sign(url, init));
  }
}

function contentType(key: string): string {
  if (key.endsWith('.mp4')) return 'video/mp4';
  if (key.endsWith('.webm')) return 'video/webm';
  return 'application/octet-stream';
}

async function ensureOk(response: Response, action: string): Promise<void> {
  if (response.ok) return;
  const body = (await response.text()).slice(0, 300);
  const code = /<Code>([^<]*)<\/Code>/.exec(body)?.[1];
  throw new Error(
    `R2 answered HTTP ${response.status}${code ? ` (${code})` : ''} while ${action}.`,
  );
}

/**
 * Parses an R2 bucket URL such as https://<account>.r2.cloudflarestorage.com/<bucket>
 * into the account endpoint and the bucket name.
 */
export function parseR2Url(value: string): { endpoint: string; bucket: string } {
  const url = new URL(value);
  const [bucket, ...rest] = url.pathname.split('/').filter(Boolean);
  if (!bucket || rest.length || url.protocol !== 'https:')
    throw new Error(
      'E2E_R2_URL must look like https://<account-id>.r2.cloudflarestorage.com/<bucket>.',
    );
  return { endpoint: url.origin, bucket: decodeURIComponent(bucket) };
}
