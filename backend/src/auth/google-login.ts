import { createHash, timingSafeEqual } from "node:crypto";
import { env } from "../config/env.js";
import type { Db } from "../db/client.js";
import { HttpClient } from "../integrations/core/http.js";
import type { CredentialCipher } from "../security/crypto.js";
import { randomToken } from "../security/crypto.js";
import { AuthService, LOCALES, type Locale } from "./auth.service.js";

/**
 * "Continue with Google" sign-in (OpenID Connect, authorization code + PKCE, confidential client).
 * https://developers.google.com/identity/openid-connect/openid-connect
 *
 * Flow:
 *   GET /v1/auth/google/start?locale=az  → sets an encrypted, short-lived state cookie, 302 to Google
 *   GET /v1/auth/google/callback         → checks state against the cookie, exchanges the code
 *                                          server-side, reads the verified profile, signs in.
 *
 * Account matching:
 *   1. A linked identity (provider "google", subject = Google `sub`) → that user.
 *   2. Otherwise an existing user with the same, Google-verified email → link the identity.
 *      If that account's email was never verified, its password is removed and its sessions are
 *      revoked first: someone who pre-registered the address cannot keep access (pre-hijacking).
 *   3. Otherwise a new account + workspace is created (no password, email verified).
 *
 * The Google tokens are only used to read the profile once and are never stored.
 */

export const GOOGLE_LOGIN_COOKIE = "tz_google_login";
const STATE_TTL_MS = 10 * 60 * 1000;
const PROVIDER = "google";

export class GoogleLoginError extends Error {
  constructor(
    readonly code: "unavailable" | "invalid_state" | "denied" | "exchange_failed" | "email_unverified" | "no_workspace",
    /** The language the user started in, when known, so the error page is shown in it. */
    readonly locale?: Locale,
  ) {
    super(code);
  }
}

interface StateCookie {
  state: string;
  verifier: string;
  locale: Locale;
  exp: number;
}

export interface GoogleProfile {
  sub: string;
  email: string;
  emailVerified: boolean;
  name: string;
}

export const googleLoginEnabled = () => !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);
export const googleLoginRedirectUri = () => `${env.PUBLIC_API_URL.replace(/\/+$/, "")}/v1/auth/google/callback`;

export const toLocale = (v: unknown): Locale => (LOCALES as readonly string[]).includes(String(v)) ? (v as Locale) : "en";

function safeEqual(a: string, b: string) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export class GoogleLoginService {
  private readonly auth: AuthService;
  constructor(
    private readonly db: Db,
    private readonly cipher: CredentialCipher,
    private readonly http = new HttpClient({ provider: "google-login", breakerKey: "google-oauth" }),
  ) {
    this.auth = new AuthService(db);
  }

  /** Returns the Google authorization URL and the encrypted cookie value that binds the flow to this browser. */
  start(locale: unknown): { url: string; cookie: string } {
    if (!googleLoginEnabled()) throw new GoogleLoginError("unavailable");
    const state = randomToken(32);
    const verifier = randomToken(48);
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const payload: StateCookie = { state, verifier, locale: toLocale(locale), exp: Date.now() + STATE_TTL_MS };
    const u = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    u.search = new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID!,
      redirect_uri: googleLoginRedirectUri(),
      response_type: "code",
      scope: "openid email profile",
      state,
      code_challenge: challenge,
      code_challenge_method: "S256",
      prompt: "select_account",
    }).toString();
    return { url: u.toString(), cookie: this.cipher.encryptJson(payload, "google-login-state") };
  }

  /** Validates the callback and returns the profile Google verified. */
  async verifyCallback(query: Record<string, string>, cookie: string | undefined): Promise<{ profile: GoogleProfile; locale: Locale }> {
    if (!googleLoginEnabled()) throw new GoogleLoginError("unavailable");
    let saved: StateCookie;
    try {
      saved = this.cipher.decryptJson<StateCookie>(cookie ?? "", "google-login-state");
    } catch {
      throw new GoogleLoginError("invalid_state");
    }
    const locale = toLocale(saved.locale);
    if (!query.state || !safeEqual(query.state, saved.state) || saved.exp < Date.now()) throw new GoogleLoginError("invalid_state", locale);
    if (query.error) throw new GoogleLoginError("denied", locale);
    if (!query.code) throw new GoogleLoginError("invalid_state", locale);

    let accessToken: string;
    try {
      const res = await this.http.request<{ access_token: string }>({
        method: "POST",
        url: "https://oauth2.googleapis.com/token",
        form: {
          code: query.code,
          client_id: env.GOOGLE_CLIENT_ID!,
          client_secret: env.GOOGLE_CLIENT_SECRET!,
          redirect_uri: googleLoginRedirectUri(),
          grant_type: "authorization_code",
          code_verifier: saved.verifier,
        },
      });
      accessToken = res.data.access_token;
      const info = await this.http.request<{ sub?: string; email?: string; email_verified?: boolean | string; name?: string; given_name?: string }>({
        url: "https://openidconnect.googleapis.com/v1/userinfo",
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      const d = info.data;
      if (!d.sub || !d.email) throw new GoogleLoginError("exchange_failed", locale);
      const profile: GoogleProfile = {
        sub: d.sub,
        email: d.email.trim().toLowerCase(),
        emailVerified: d.email_verified === true || d.email_verified === "true",
        name: (d.name || d.given_name || d.email.split("@")[0] || "Telzyra user").slice(0, 120),
      };
      if (!profile.emailVerified) throw new GoogleLoginError("email_unverified", locale);
      return { profile, locale };
    } catch (err) {
      if (err instanceof GoogleLoginError) throw err;
      throw new GoogleLoginError("exchange_failed", locale);
    }
  }

  /** Finds, links or creates the account for a verified Google profile. */
  async resolveAccount(profile: GoogleProfile, locale: Locale) {
    const linked = await this.db.userIdentity.findUnique({ where: { provider_subject: { provider: PROVIDER, subject: profile.sub } }, include: { user: true } });
    if (linked) {
      const workspace = await this.auth.defaultWorkspace(linked.userId);
      if (!workspace) throw new GoogleLoginError("no_workspace");
      return { user: linked.user, workspace, created: false, linked: false };
    }

    const existing = await this.db.user.findUnique({ where: { email: profile.email } });
    if (existing) {
      const user = await this.db.$transaction(async (tx) => {
        if (!existing.emailVerifiedAt) {
          // Ownership of the address is only now proven: drop anything set up by whoever registered it.
          await tx.session.updateMany({ where: { userId: existing.id, revokedAt: null }, data: { revokedAt: new Date() } });
        }
        await tx.userIdentity.create({ data: { userId: existing.id, provider: PROVIDER, subject: profile.sub, email: profile.email } });
        return tx.user.update({
          where: { id: existing.id },
          data: existing.emailVerifiedAt ? {} : { emailVerifiedAt: new Date(), passwordHash: null },
        });
      });
      const workspace = await this.auth.defaultWorkspace(user.id);
      if (!workspace) throw new GoogleLoginError("no_workspace");
      return { user, workspace, created: false, linked: true };
    }

    const { user, workspace } = await this.auth.createAccount({
      email: profile.email,
      name: profile.name,
      locale,
      passwordHash: null,
      emailVerifiedAt: new Date(),
      identity: { provider: PROVIDER, subject: profile.sub },
    });
    return { user, workspace, created: true, linked: false };
  }
}
