/**
 * Normalized connector errors. Every provider maps its own error format to one of these codes,
 * so workflows, the UI and retry logic behave the same for every integration.
 */
export type ConnectorErrorCode =
  | "AUTH_EXPIRED" // token expired and could not be refreshed → user must reauthorize
  | "AUTH_REVOKED" // access revoked at the provider
  | "PERMISSION_DENIED" // missing scope / not allowed for this resource
  | "NOT_FOUND"
  | "VALIDATION" // bad input for the provider
  | "RATE_LIMITED"
  | "PROVIDER_UNAVAILABLE" // 5xx / network failure
  | "TIMEOUT"
  | "CIRCUIT_OPEN" // too many recent failures; requests are paused briefly
  | "NOT_SUPPORTED"
  | "NOT_CONFIGURED" // provider app credentials missing on this server
  | "BLOCKED_DESTINATION" // SSRF guard rejected the URL
  | "UNKNOWN";

const RETRYABLE = new Set<ConnectorErrorCode>(["RATE_LIMITED", "PROVIDER_UNAVAILABLE", "TIMEOUT"]);

export class ConnectorError extends Error {
  readonly retryable: boolean;
  constructor(
    public readonly code: ConnectorErrorCode,
    message: string,
    public readonly details: {
      provider?: string;
      status?: number;
      providerCode?: string;
      retryAfterMs?: number;
    } = {},
  ) {
    super(message);
    this.name = "ConnectorError";
    this.retryable = RETRYABLE.has(code);
  }

  toJSON() {
    return { code: this.code, message: this.message, ...this.details };
  }
}

/** Default HTTP status → code mapping; providers refine it with their own error bodies. */
export function codeForStatus(status: number): ConnectorErrorCode {
  if (status === 401) return "AUTH_EXPIRED";
  if (status === 403) return "PERMISSION_DENIED";
  if (status === 404) return "NOT_FOUND";
  if (status === 400 || status === 409 || status === 422) return "VALIDATION";
  if (status === 429) return "RATE_LIMITED";
  if (status === 408) return "TIMEOUT";
  if (status >= 500) return "PROVIDER_UNAVAILABLE";
  return "UNKNOWN";
}
