import type { Db } from "../../db/client.js";
import type { CredentialCipher } from "../../security/crypto.js";
import { logger } from "../../lib/logger.js";
import { getConnector } from "../core/registry.js";
import { ConnectorError } from "../core/errors.js";
import type { Credentials } from "../core/types.js";
import { getOAuthProvider } from "../oauth/providers.js";
import { OAuthError, type TokenSet } from "../oauth/types.js";

/** Refresh this long before expiry so in-flight requests never use an expired token. */
export const REFRESH_SKEW_MS = 5 * 60 * 1000;

export const credentialAad = (workspaceId: string, connectionId: string) => `credential:${workspaceId}:${connectionId}`;

type Tx = Parameters<Parameters<Db["$transaction"]>[0]>[0];

export class CredentialService {
  constructor(
    private readonly db: Db,
    private readonly cipher: CredentialCipher,
  ) {}

  /** Encrypts and stores (or replaces) the credentials of a connection. */
  async save(
    tx: Tx | Db,
    conn: { id: string; workspaceId: string },
    creds: Credentials,
    accessTokenExpiresAt: Date | null = null,
  ): Promise<void> {
    const secret = this.cipher.encryptJson(creds, credentialAad(conn.workspaceId, conn.id));
    await tx.credential.upsert({
      where: { connectionId: conn.id },
      create: { connectionId: conn.id, secret, keyVersion: this.cipher.currentVersion, accessTokenExpiresAt },
      update: { secret, keyVersion: this.cipher.currentVersion, accessTokenExpiresAt, refreshedAt: new Date() },
    });
  }

  static fromTokens(t: TokenSet): Credentials {
    return { accessToken: t.accessToken, refreshToken: t.refreshToken, ...(t.extra ?? {}) };
  }

  /**
   * Returns usable credentials, refreshing OAuth tokens when they are about to expire.
   * Refresh runs inside a transaction holding a row lock on the credential, so concurrent
   * workers wait for one refresh and then reuse its result instead of refreshing twice
   * (which some providers punish by revoking the token family).
   */
  async getValid(conn: { id: string; workspaceId: string; provider: string }, opts: { force?: boolean } = {}): Promise<Credentials> {
    const aad = credentialAad(conn.workspaceId, conn.id);
    const row = await this.db.credential.findUnique({ where: { connectionId: conn.id } });
    if (!row) throw new ConnectorError("AUTH_REVOKED", "Connection has no stored credentials");
    const current = this.cipher.decryptJson<Credentials>(row.secret, aad);
    if (!opts.force && !this.needsRefresh(row.accessTokenExpiresAt)) {
      if (this.cipher.needsRotation(row.secret)) await this.save(this.db, conn, current, row.accessTokenExpiresAt);
      return current;
    }
    if (!current.refreshToken) {
      if (row.accessTokenExpiresAt && row.accessTokenExpiresAt <= new Date()) await this.markExpired(conn.id, "Access token expired and no refresh token is available");
      return current;
    }

    return this.db.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM credentials WHERE "connectionId" = ${conn.id}::uuid FOR UPDATE`;
        const locked = await tx.credential.findUniqueOrThrow({ where: { connectionId: conn.id } });
        const latest = this.cipher.decryptJson<Credentials>(locked.secret, aad);
        // Another worker refreshed while we waited for the lock.
        if (!opts.force && !this.needsRefresh(locked.accessTokenExpiresAt)) return latest;
        if (opts.force && locked.refreshedAt && Date.now() - locked.refreshedAt.getTime() < 10_000) return latest;

        const provider = this.oauthProviderFor(conn.provider);
        if (!provider?.refresh) return latest;
        try {
          const tokens = await provider.refresh(String(latest.refreshToken), latest);
          const next: Credentials = { ...latest, ...CredentialService.fromTokens(tokens), refreshToken: tokens.refreshToken ?? latest.refreshToken };
          await this.save(tx, conn, next, tokens.expiresAt ?? null);
          logger.info({ connectionId: conn.id, provider: conn.provider }, "oauth token refreshed");
          return next;
        } catch (err) {
          if (err instanceof OAuthError && err.code === "oauth.invalid_grant") {
            await this.markExpired(conn.id, "Authorization expired or was revoked; reconnect required", tx);
            throw new ConnectorError("AUTH_EXPIRED", "Reauthorization required", { provider: conn.provider });
          }
          throw err;
        }
      },
      { timeout: 30_000, maxWait: 30_000 },
    );
  }

  private needsRefresh(expiresAt: Date | null): boolean {
    return !!expiresAt && expiresAt.getTime() - Date.now() < REFRESH_SKEW_MS;
  }

  private oauthProviderFor(connectorId: string) {
    const def = getConnector(connectorId);
    return def?.auth.type === "oauth2" ? getOAuthProvider(def.auth.provider) : undefined;
  }

  async markExpired(connectionId: string, reason: string, tx: Tx | Db = this.db) {
    await tx.connection.update({ where: { id: connectionId }, data: { status: "EXPIRED", lastError: reason } });
  }

  async delete(connectionId: string) {
    await this.db.credential.deleteMany({ where: { connectionId } });
  }
}
