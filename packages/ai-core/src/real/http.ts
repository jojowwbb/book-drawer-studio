export class ProviderHttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
    readonly url: string,
  ) {
    super(`HTTP ${status} from ${url}: ${body.slice(0, 300)}`);
  }
}

export interface FetchJsonOptions {
  timeoutMs?: number;
  retries?: number;
  backoffMs?: number;
  fetchImpl?: typeof fetch;
  headers?: Record<string, string>;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function isRetryable(err: unknown): boolean {
  if (err instanceof ProviderHttpError) {
    return err.status === 429 || err.status >= 500;
  }
  return true; // 网络错误 / 超时
}

async function fetchWithRetry(
  url: string,
  init: RequestInit,
  opts: FetchJsonOptions,
): Promise<Response> {
  const doFetch = opts.fetchImpl ?? globalThis.fetch;
  const retries = opts.retries ?? 2;
  const backoff = opts.backoffMs ?? 500;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 60_000);
    try {
      const res = await doFetch(url, { ...init, signal: controller.signal });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new ProviderHttpError(res.status, body, url);
      }
      return res;
    } catch (err) {
      lastErr = err;
      if (attempt < retries && isRetryable(err)) {
        await sleep(backoff * 2 ** attempt);
        continue;
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr;
}

export async function fetchJson<T>(url: string, body: unknown, opts: FetchJsonOptions = {}): Promise<T> {
  const res = await fetchWithRetry(
    url,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...opts.headers },
      body: JSON.stringify(body),
    },
    opts,
  );
  return (await res.json()) as T;
}

export async function fetchJsonGet<T>(url: string, opts: FetchJsonOptions = {}): Promise<T> {
  const res = await fetchWithRetry(url, { method: 'GET', headers: opts.headers }, opts);
  return (await res.json()) as T;
}

export async function fetchRaw(url: string, opts: FetchJsonOptions = {}): Promise<Uint8Array> {
  const res = await fetchWithRetry(url, { method: 'GET', headers: opts.headers }, opts);
  return new Uint8Array(await res.arrayBuffer());
}
