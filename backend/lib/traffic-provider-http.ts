import { requireProviderEndpoint } from './provider-endpoint';
import { readBoundedResponseText } from './http-bounds';

const MAX_PROVIDER_RESPONSE_BYTES = 64 * 1024;
const PROVIDER_TIMEOUT_MS = 12_000;

export function safeTrafficProviderActionUrl(value: string | undefined) {
  if (!value) return undefined;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('TRAFFIC_PROVIDER_RESPONSE_INVALID');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('TRAFFIC_PROVIDER_RESPONSE_INVALID');
  if (process.env.NODE_ENV === 'production' && url.protocol !== 'https:') throw new Error('TRAFFIC_PROVIDER_RESPONSE_INVALID');
  return url.toString();
}

export class TrafficProviderHttpClient {
  constructor(
    private readonly endpoint: string,
    private readonly secret: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async post(action: string, payload: Record<string, unknown>, idempotencyKey: string): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetchImpl(this.endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.secret}`,
          'Idempotency-Key': idempotencyKey,
        },
        body: JSON.stringify({ ...payload, action, idempotencyKey }),
        cache: 'no-store',
        redirect: 'error',
        signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
      });
    } catch {
      throw new Error('TRAFFIC_PROVIDER_UNAVAILABLE');
    }

    if (!response.ok) throw new Error('TRAFFIC_PROVIDER_UNAVAILABLE');
    const body = await readBoundedResponseText(response, MAX_PROVIDER_RESPONSE_BYTES, 'TRAFFIC_PROVIDER_RESPONSE_INVALID');
    if (!body) throw new Error('TRAFFIC_PROVIDER_RESPONSE_INVALID');
    try {
      return JSON.parse(body) as unknown;
    } catch {
      throw new Error('TRAFFIC_PROVIDER_RESPONSE_INVALID');
    }
  }
}

export function getTrafficProviderHttpClient() {
  const endpoint = requireProviderEndpoint(process.env.TRAFFIC_PROVIDER_URL, 'TRAFFIC_PROVIDER');
  const secret = process.env.TRAFFIC_PROVIDER_SECRET?.trim();
  if (!secret) throw new Error('NOT_CONFIGURED:TRAFFIC_PROVIDER_REQUIRED');
  return new TrafficProviderHttpClient(endpoint, secret);
}
