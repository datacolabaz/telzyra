import { logger } from "../../lib/logger.js";
import { CircuitBreaker, type Breaker } from "./circuit-breaker.js";
import { codeForStatus, ConnectorError, type ConnectorErrorCode } from "./errors.js";

/**
 * Resilient HTTP client shared by all connectors.
 *  - per-attempt timeout (AbortSignal)
 *  - retries with exponential backoff + full jitter on network errors, timeouts, 429 and 5xx
 *  - honours Retry-After (seconds or HTTP date), capped by maxDelayMs
 *  - non-idempotent requests (POST/PATCH) are only retried when an idempotency key is set
 *    or the request explicitly opts in (e.g. provider APIs that are safe to repeat)
 *  - per-key circuit breaker
 *  - structured logs and metrics without URLs' query strings, headers or bodies
 */
export interface HttpRequest {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  url: string;
  /** Arrays become repeated parameters (?h=a&h=b), as Google APIs expect. */
  query?: Record<string, string | number | boolean | Array<string | number> | undefined>;
  headers?: Record<string, string>;
  json?: unknown;
  form?: Record<string, string | number | boolean | undefined>;
  body?: string | Uint8Array;
  timeoutMs?: number;
  /** Sent as Idempotency-Key header (Stripe) and enables retries for non-idempotent methods. */
  idempotencyKey?: string;
  retryNonIdempotent?: boolean;
  maxRetries?: number;
  /** "manual" returns 3xx responses instead of following them (SSRF-guarded destinations). */
  redirect?: "follow" | "manual";
}

export interface HttpResponse<T = unknown> {
  status: number;
  headers: Headers;
  data: T;
}

export interface RequestMetric {
  provider: string;
  method: string;
  host: string;
  status: number | "network_error" | "timeout" | "circuit_open" | "blocked";
  attempt: number;
  durationMs: number;
}

export interface HttpClientOptions {
  provider: string;
  /** Circuit-breaker key, usually `${provider}:${connectionId}`. */
  breakerKey: string;
  /** Turns a non-2xx response into a ConnectorError (provider-specific mapping). */
  mapError?: (res: HttpResponse) => ConnectorError | undefined;
  /** Some APIs (Slack, Telegram) report errors with HTTP 200 + ok:false. */
  isErrorBody?: (data: unknown) => boolean;
  sleep?: (ms: number) => Promise<void>;
  onMetric?: (m: RequestMetric) => void;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** Transport. User-supplied destinations use ssrfSafeFetch (validated connect-time DNS, no proxy). */
  fetchImpl?: typeof fetch;
}

/** Default breaker; server.ts replaces it with the Postgres-backed shared breaker (setDefaultBreaker). */
export const sharedBreaker = new CircuitBreaker();
let defaultBreaker: Breaker = sharedBreaker;
export function setDefaultBreaker(b: Breaker) {
  defaultBreaker = b;
}
export const metrics: RequestMetric[] = [];
const MAX_METRICS = 1000;
function recordMetric(m: RequestMetric) {
  metrics.push(m);
  if (metrics.length > MAX_METRICS) metrics.shift();
}

const IDEMPOTENT = new Set(["GET", "PUT", "DELETE"]);

export function parseRetryAfter(value: string | null, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}

export class HttpClient {
  private readonly sleep: (ms: number) => Promise<void>;
  constructor(
    private readonly opts: HttpClientOptions,
    private readonly breaker: Breaker = defaultBreaker,
  ) {
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  async request<T = unknown>(req: HttpRequest): Promise<HttpResponse<T>> {
    const method = req.method ?? "GET";
    const url = new URL(req.url);
    for (const [k, v] of Object.entries(req.query ?? {})) {
      if (v === undefined) continue;
      if (Array.isArray(v)) for (const item of v) url.searchParams.append(k, String(item));
      else url.searchParams.set(k, String(v));
    }

    const headers: Record<string, string> = { Accept: "application/json", ...req.headers };
    let body: string | Uint8Array | undefined = req.body;
    if (req.json !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(req.json);
    } else if (req.form) {
      headers["Content-Type"] = "application/x-www-form-urlencoded";
      const p = new URLSearchParams();
      for (const [k, v] of Object.entries(req.form)) if (v !== undefined) p.append(k, String(v));
      body = p.toString();
    }
    if (req.idempotencyKey) headers["Idempotency-Key"] = req.idempotencyKey;

    const canRetry = IDEMPOTENT.has(method) || !!req.idempotencyKey || !!req.retryNonIdempotent;
    const maxRetries = req.maxRetries ?? 3;
    const base = this.opts.baseDelayMs ?? 500;
    const cap = this.opts.maxDelayMs ?? 30_000;

    for (let attempt = 1; ; attempt++) {
      if (!(await this.breaker.canRequest(this.opts.breakerKey))) {
        this.metric(method, url, "circuit_open", attempt, 0);
        throw new ConnectorError("CIRCUIT_OPEN", "Provider temporarily paused after repeated failures", { provider: this.opts.provider });
      }
      const started = Date.now();
      let error: ConnectorError;
      try {
        const res = await (this.opts.fetchImpl ?? fetch)(url, { method, headers, body: body as BodyInit | undefined, redirect: req.redirect ?? "follow", signal: AbortSignal.timeout(req.timeoutMs ?? 20_000) });
        const text = await res.text();
        const data = (text ? safeJson(text) : null) as T;
        const response: HttpResponse<T> = { status: res.status, headers: res.headers, data };
        this.metric(method, url, res.status, attempt, Date.now() - started);

        const bodyError = res.ok && this.opts.isErrorBody?.(data);
        if (res.ok && !bodyError) {
          await this.breaker.success(this.opts.breakerKey);
          return response;
        }
        error =
          this.opts.mapError?.(response as HttpResponse) ??
          new ConnectorError(codeForStatus(res.status), `HTTP ${res.status}`, { provider: this.opts.provider, status: res.status });
        if (error.code === "RATE_LIMITED" && error.details.retryAfterMs === undefined) {
          const ra = parseRetryAfter(res.headers.get("retry-after"));
          if (ra !== undefined) error.details.retryAfterMs = ra;
        }
        if (res.status >= 500) await this.breaker.failure(this.opts.breakerKey);
        else await this.breaker.success(this.opts.breakerKey);
      } catch (err) {
        if (err instanceof ConnectorError) {
          // Raised by the transport itself (e.g. SSRF guard at connect time): never retried, not a provider failure.
          this.metric(method, url, "blocked", attempt, Date.now() - started);
          throw err;
        }
        const timeout = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
        this.metric(method, url, timeout ? "timeout" : "network_error", attempt, Date.now() - started);
        await this.breaker.failure(this.opts.breakerKey);
        const code: ConnectorErrorCode = timeout ? "TIMEOUT" : "PROVIDER_UNAVAILABLE";
        error = new ConnectorError(code, timeout ? "Request timed out" : "Network error", { provider: this.opts.provider });
      }

      // A 429 means the provider rejected the request without processing it, so retrying is
      // safe even for non-idempotent methods. Other failures are only retried when safe.
      const retryAllowed = error.retryable && (canRetry || error.code === "RATE_LIMITED");
      if (!retryAllowed || attempt > maxRetries) throw error;
      const backoff = Math.min(cap, base * 2 ** (attempt - 1));
      const jittered = Math.random() * backoff; // full jitter
      const wait = Math.min(cap, Math.max(error.details.retryAfterMs ?? 0, jittered));
      logger.warn({ provider: this.opts.provider, code: error.code, attempt, waitMs: Math.round(wait) }, "retrying provider request");
      await this.sleep(wait);
    }
  }

  private metric(method: string, url: URL, status: RequestMetric["status"], attempt: number, durationMs: number) {
    const m = { provider: this.opts.provider, method, host: url.host, status, attempt, durationMs };
    recordMetric(m);
    this.opts.onMetric?.(m);
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
