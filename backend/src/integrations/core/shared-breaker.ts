import type { Db } from "../../db/client.js";
import { logger } from "../../lib/logger.js";
import type { Breaker } from "./circuit-breaker.js";

interface Row {
  failures: number;
  open_ms: number | null; // ms since openedAt, null when closed
}
interface Cached {
  failures: number;
  openedAtMs: number | null; // local clock estimate of openedAt
  fetchedAt: number;
}

/**
 * Circuit breaker shared by every instance through Postgres (table circuit_breakers).
 *
 * Why Postgres: it is the only shared infrastructure Telzyra runs (no Redis); pg-boss already uses it.
 * Cost control: reads are cached per instance for `cacheMs`; successes only write when the key had
 * failures; failures are one atomic upsert. Half-open: exactly one instance wins the probe
 * (conditional UPDATE … RETURNING). Times are compared with the database clock only.
 * If the database is unreachable the breaker fails open (requests continue) and logs once.
 */
export class PgCircuitBreaker implements Breaker {
  private readonly cache = new Map<string, Cached>();
  private warned = false;

  constructor(
    private readonly db: Db,
    private readonly threshold = 5,
    private readonly openMs = 30_000,
    private readonly cacheMs = 2_000,
    private readonly now: () => number = Date.now,
  ) {}

  private remember(key: string, row: Row | undefined) {
    const c: Cached = { failures: row?.failures ?? 0, openedAtMs: row?.open_ms == null ? null : this.now() - row.open_ms, fetchedAt: this.now() };
    this.cache.set(key, c);
    return c;
  }

  private dbFailed(err: unknown) {
    if (!this.warned) logger.error({ err: err instanceof Error ? err.message : "unknown" }, "shared circuit breaker unavailable; failing open");
    this.warned = true;
  }

  private async read(key: string): Promise<Cached> {
    const c = this.cache.get(key);
    if (c && this.now() - c.fetchedAt < this.cacheMs) return c;
    const rows = await this.db.$queryRaw<Row[]>`
      SELECT failures, (EXTRACT(EPOCH FROM (now() - "openedAt")) * 1000)::float8 AS open_ms
      FROM circuit_breakers WHERE key = ${key}`;
    return this.remember(key, rows[0]);
  }

  async canRequest(key: string): Promise<boolean> {
    try {
      const c = await this.read(key);
      if (c.openedAtMs === null) return true;
      if (this.now() - c.openedAtMs < this.openMs) return false;
      // Half-open: one probe across all instances per open window.
      const won = await this.db.$queryRaw<Array<{ key: string }>>`
        UPDATE circuit_breakers SET "probeAt" = now(), "updatedAt" = now()
        WHERE key = ${key} AND "openedAt" IS NOT NULL
          AND "openedAt" <= now() - (${this.openMs} * interval '1 millisecond')
          AND ("probeAt" IS NULL OR "probeAt" <= now() - (${this.openMs} * interval '1 millisecond'))
        RETURNING key`;
      if (won.length === 0) this.cache.delete(key); // someone else probes or it closed: re-read next time
      return won.length > 0;
    } catch (err) {
      this.dbFailed(err);
      return true;
    }
  }

  async success(key: string): Promise<void> {
    const c = this.cache.get(key);
    if (c && c.failures === 0 && c.openedAtMs === null) return; // nothing to reset: no write on the hot path
    try {
      await this.db.$executeRaw`
        UPDATE circuit_breakers SET failures = 0, "openedAt" = NULL, "probeAt" = NULL, "updatedAt" = now()
        WHERE key = ${key} AND (failures > 0 OR "openedAt" IS NOT NULL)`;
      this.cache.set(key, { failures: 0, openedAtMs: null, fetchedAt: this.now() });
    } catch (err) {
      this.dbFailed(err);
    }
  }

  async failure(key: string): Promise<void> {
    try {
      const rows = await this.db.$queryRaw<Row[]>`
        INSERT INTO circuit_breakers (key, failures, "openedAt", "updatedAt")
        VALUES (${key}, 1, CASE WHEN 1 >= ${this.threshold} THEN now() END, now())
        ON CONFLICT (key) DO UPDATE SET
          failures = circuit_breakers.failures + 1,
          -- a failed probe (already open) re-opens; otherwise open when the threshold is reached
          "openedAt" = CASE
            WHEN circuit_breakers."openedAt" IS NOT NULL THEN now()
            WHEN circuit_breakers.failures + 1 >= ${this.threshold} THEN now()
            ELSE NULL END,
          "probeAt" = NULL,
          "updatedAt" = now()
        RETURNING failures, (EXTRACT(EPOCH FROM (now() - "openedAt")) * 1000)::float8 AS open_ms`;
      this.remember(key, rows[0]);
    } catch (err) {
      this.dbFailed(err);
    }
  }

  /** Removes rows of keys that have been healthy for a day (maintenance). */
  async prune(): Promise<number> {
    return this.db.$executeRaw`DELETE FROM circuit_breakers WHERE "openedAt" IS NULL AND "updatedAt" < now() - interval '1 day'`;
  }
}
