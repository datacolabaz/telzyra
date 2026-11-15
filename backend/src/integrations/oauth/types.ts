/** OAuth provider adapter contract. The central OAuthService never contains provider-specific code. */
export interface TokenSet {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: Date | null;
  scopes: string[];
  /** Non-secret provider data needed later (Slack team, Shopify shop, Notion workspace…). */
  extra?: Record<string, unknown>;
}

export interface Identity {
  externalAccountId: string;
  displayName: string;
}

export interface AuthorizeParams {
  clientId: string;
  redirectUri: string;
  state: string;
  scopes: string[];
  codeChallenge?: string;
  extra: Record<string, string>;
}

export interface OAuthProvider {
  id: string;
  /** Use PKCE (S256) for this provider. */
  pkce: boolean;
  /** Provider only accepts https redirect URIs (no http://localhost), e.g. Slack and Shopify. */
  httpsRedirectOnly?: boolean;
  requiredEnv: string[];
  clientId(): string;
  clientSecret(): string;
  /** Validate and normalize provider-specific start parameters (e.g. Shopify shop domain). */
  startParams?(input: Record<string, unknown>): Record<string, string>;
  authorizeUrl(p: AuthorizeParams): string;
  /** Extra callback verification (e.g. Shopify HMAC over the query string). */
  verifyCallback?(query: Record<string, string>, extra: Record<string, string>): void;
  exchange(p: { code: string; redirectUri: string; codeVerifier?: string; extra: Record<string, string> }): Promise<TokenSet>;
  refresh?(refreshToken: string, extra: Record<string, unknown>): Promise<TokenSet>;
  revoke?(tokens: { accessToken?: string; refreshToken?: string }, extra: Record<string, unknown>): Promise<void>;
  identify(tokens: TokenSet): Promise<Identity>;
}

export class OAuthError extends Error {
  constructor(
    public readonly code:
      | "oauth.denied"
      | "oauth.invalid_state"
      | "oauth.state_expired"
      | "oauth.session_mismatch"
      | "oauth.exchange_failed"
      | "oauth.scopes_missing"
      | "oauth.account_mismatch"
      | "oauth.invalid_grant"
      | "oauth.invalid_request",
    message?: string,
  ) {
    super(message ?? code);
    this.name = "OAuthError";
  }
}
