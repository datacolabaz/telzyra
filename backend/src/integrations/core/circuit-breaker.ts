/**
 * Per-key circuit breaker (key = provider + connection).
 *  closed     → requests flow; consecutive failures are counted
 *  open       → after `threshold` consecutive failures, requests fail fast for `openMs`
 *  half-open  → after `openMs`, one probe request is allowed; success closes, failure re-opens
 * Only provider-side failures (5xx, timeouts, network) count; 4xx caller errors do not.
 */
interface State {
  failures: number;
  openedAt: number | null;
  probing: boolean;
}

export class CircuitBreaker {
  private readonly states = new Map<string, State>();

  constructor(
    private readonly threshold = 5,
    private readonly openMs = 30_000,
    private readonly now: () => number = Date.now,
  ) {}

  private get(key: string): State {
    let s = this.states.get(key);
    if (!s) {
      s = { failures: 0, openedAt: null, probing: false };
      this.states.set(key, s);
    }
    return s;
  }

  /** Returns false when the circuit is open (caller must fail fast). */
  canRequest(key: string): boolean {
    const s = this.get(key);
    if (s.openedAt === null) return true;
    if (this.now() - s.openedAt < this.openMs) return false;
    if (s.probing) return false;
    s.probing = true; // half-open: allow a single probe
    return true;
  }

  success(key: string) {
    this.states.set(key, { failures: 0, openedAt: null, probing: false });
  }

  failure(key: string) {
    const s = this.get(key);
    s.failures += 1;
    s.probing = false;
    if (s.failures >= this.threshold || s.openedAt !== null) s.openedAt = this.now();
  }

  state(key: string): "closed" | "open" | "half-open" {
    const s = this.get(key);
    if (s.openedAt === null) return "closed";
    return this.now() - s.openedAt < this.openMs ? "open" : "half-open";
  }
}
