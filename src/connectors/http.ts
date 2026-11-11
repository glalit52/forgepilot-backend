/** Shared HTTP plumbing for connectors: timeouts, bounded retries and a typed error. */
export type FetchLike = typeof fetch;

export class ConnectorError extends Error {
  constructor(
    public provider: string,
    public status: number,
    message: string,
    public body?: string,
  ) {
    super(message);
    this.name = "ConnectorError";
  }
  /** Worth retrying later (rate limit, upstream outage, network). */
  get transient(): boolean {
    return this.status === 0 || this.status === 429 || this.status >= 500;
  }
}

export interface RequestOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
  /** Raw body (already encoded); wins over `body`. */
  rawBody?: string;
  timeoutMs?: number;
  /** Extra attempts for transient failures on idempotent calls. */
  retries?: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function requestJson<T = unknown>(
  fetchImpl: FetchLike,
  provider: string,
  url: string,
  opts: RequestOptions = {},
): Promise<T> {
  const method = opts.method ?? "GET";
  const retries = opts.retries ?? (method === "GET" ? 2 : 0);
  let lastError: ConnectorError | undefined;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt) await sleep(Math.min(4_000, 250 * 4 ** (attempt - 1)));
    let res: Response;
    try {
      res = await fetchImpl(url, {
        method,
        headers: {
          Accept: "application/json",
          ...(opts.body !== undefined && !opts.rawBody
            ? { "Content-Type": "application/json" }
            : {}),
          ...opts.headers,
        },
        body: opts.rawBody ?? (opts.body !== undefined ? JSON.stringify(opts.body) : undefined),
        signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000),
      });
    } catch (err) {
      lastError = new ConnectorError(
        provider,
        0,
        `${provider} request failed: ${(err as Error).message}`,
      );
      continue;
    }
    const text = await res.text();
    if (res.ok) {
      if (!text) return undefined as T;
      try {
        return JSON.parse(text) as T;
      } catch {
        throw new ConnectorError(
          provider,
          res.status,
          `${provider} returned a non-JSON response`,
          text.slice(0, 500),
        );
      }
    }
    lastError = new ConnectorError(
      provider,
      res.status,
      `${provider} responded ${res.status} for ${method} ${new URL(url).pathname}`,
      text.slice(0, 1000),
    );
    if (!lastError.transient) break;
  }
  throw lastError!;
}

/** Runs `fn` over `items` with at most `limit` in flight; preserves order. */
export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      for (;;) {
        const i = next++;
        if (i >= items.length) return;
        out[i] = await fn(items[i], i);
      }
    }),
  );
  return out;
}
