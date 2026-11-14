/**
 * Browser-side calls to the Platform API. The session cookie travels with `credentials: "include"`;
 * state-changing requests carry the CSRF token in the x-csrf-token header.
 */
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    public readonly body: Record<string, unknown>,
  ) {
    super(code);
  }
}

export interface Api {
  get<T>(path: string): Promise<T>;
  send<T>(method: "POST" | "PATCH" | "DELETE", path: string, body?: unknown): Promise<T>;
}

export function createApi(apiUrl: string, csrfToken: string): Api {
  async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${apiUrl}/v1${path}`, {
      method,
      credentials: "include",
      headers: {
        Accept: "application/json",
        ...(method === "GET" ? {} : { "x-csrf-token": csrfToken }),
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.status === 204) return undefined as T;
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) throw new ApiError(res.status, String(data.code ?? "unknown"), data);
    return data as T;
  }
  return {
    get: (path) => call("GET", path),
    send: (method, path, body) => call(method, path, body),
  };
}

// ── Shapes returned by the API ───────────────────────────────────────────────
export interface JsonSchema {
  type?: string | string[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  enum?: unknown[];
  anyOf?: JsonSchema[];
  items?: JsonSchema;
  default?: unknown;
  description?: string;
}

export interface ConnectorInfo {
  id: string;
  name: string;
  description: string;
  category: string;
  auth: { type: "oauth2" | "bot_token" | "api_key" | "none"; label?: string; hint?: string; scopes?: string[] };
  configured: boolean;
  rateLimit: { note: string };
  actions: Array<{ key: string; name: string; description: string; inputSchema: JsonSchema }>;
  triggers: Array<{ key: string; name: string; description: string; mode: "webhook" | "polling"; pollIntervalMinutes: number | null; configSchema: JsonSchema; sample?: unknown }>;
}

export interface ConnectionInfo {
  id: string;
  provider: string;
  authType: string;
  displayName: string;
  accountId: string | null;
  status: "ACTIVE" | "EXPIRED" | "REVOKED" | "ERROR";
  scopes: string[];
  health: { ok: boolean; latencyMs?: number; checkedAt?: string; error?: string } | null;
  lastCheckedAt: string | null;
  lastError: string | null;
  createdAt: string;
  usedBy?: Array<{ id: string; name: string; status: string }>;
}
