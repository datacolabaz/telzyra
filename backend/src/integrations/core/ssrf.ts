import { lookup as dnsLookup } from "node:dns";
import { isIP, type LookupFunction } from "node:net";
import { Agent, fetch as undiciFetch } from "undici";
import { ConnectorError } from "./errors.js";

/**
 * SSRF guard for user-configurable outbound URLs (HTTP Request step).
 *
 *  1. assertPublicUrl(): scheme http/https, ports 80/443, no URL credentials, no internal names,
 *     every resolved address public.
 *  2. ssrfSafeFetch(): the request goes through a dedicated undici Agent whose DNS `lookup` re-checks
 *     the addresses it actually connects to. This closes DNS rebinding (first answer public, second
 *     answer private): the socket can only be opened to an address that passed the check.
 *  3. No proxy: the agent never uses HTTP(S)_PROXY, so name resolution cannot move to a proxy.
 *  4. Redirects are never followed (redirect: "manual"), so a 30x cannot point to an internal host.
 */

const BLOCKED_V4: Array<[number, number]> = [
  [0x00000000, 8], // 0.0.0.0/8 "this network"
  [0x0a000000, 8], // 10.0.0.0/8
  [0x64400000, 10], // 100.64.0.0/10 CGNAT
  [0x7f000000, 8], // 127.0.0.0/8 loopback
  [0xa9fe0000, 16], // 169.254.0.0/16 link-local, cloud metadata
  [0xac100000, 12], // 172.16.0.0/12
  [0xc0000000, 24], // 192.0.0.0/24 IETF protocol assignments
  [0xc0000200, 24], // 192.0.2.0/24 TEST-NET-1
  [0xc0586300, 24], // 192.88.99.0/24 6to4 relay anycast
  [0xc0a80000, 16], // 192.168.0.0/16
  [0xc6120000, 15], // 198.18.0.0/15 benchmarking
  [0xc6336400, 24], // 198.51.100.0/24 TEST-NET-2
  [0xcb007100, 24], // 203.0.113.0/24 TEST-NET-3
  [0xe0000000, 4], // 224.0.0.0/4 multicast
  [0xf0000000, 4], // 240.0.0.0/4 reserved + broadcast
];

function v4ToInt(ip: string): number {
  return ip.split(".").reduce((acc, o) => ((acc << 8) + Number(o)) >>> 0, 0) >>> 0;
}

function isBlockedV4Int(n: number): boolean {
  // `>>> 0` keeps the masked value unsigned (bitwise & yields a signed 32-bit int).
  return BLOCKED_V4.some(([net, bits]) => ((n & (~0 << (32 - bits))) >>> 0) === net);
}

/** Expands an IPv6 address (any notation, incl. embedded IPv4) to 8 16-bit groups. */
export function parseIPv6(ip: string): number[] | null {
  let s = ip.toLowerCase().replace(/^\[|\]$/g, "").split("%")[0]!; // drop zone id
  const v4 = s.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (v4) {
    if (isIP(v4[1]!) !== 4) return null;
    const n = v4ToInt(v4[1]!);
    s = s.slice(0, -v4[1]!.length) + `${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`;
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  if (fill < 0 || (halves.length === 1 && head.length !== 8)) return null;
  const groups = [...head, ...Array(fill).fill("0"), ...tail].map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : NaN));
  return groups.length === 8 && groups.every((g) => !Number.isNaN(g)) ? groups : null;
}

function isBlockedV6(g: number[]): boolean {
  const zeroUntil = (i: number) => g.slice(0, i).every((x) => x === 0);
  const embeddedV4 = (hi: number, lo: number) => ((hi << 16) | lo) >>> 0;
  if (zeroUntil(8)) return true; // :: unspecified
  if (zeroUntil(7) && g[7] === 1) return true; // ::1 loopback
  if (zeroUntil(5) && g[5] === 0xffff) return isBlockedV4Int(embeddedV4(g[6]!, g[7]!)); // ::ffff:a.b.c.d mapped
  if (zeroUntil(4) && g[4] === 0xffff && g[5] === 0) return isBlockedV4Int(embeddedV4(g[6]!, g[7]!)); // ::ffff:0:a.b.c.d translated
  if (zeroUntil(6)) return isBlockedV4Int(embeddedV4(g[6]!, g[7]!)); // ::a.b.c.d IPv4-compatible (deprecated)
  if (g[0] === 0x64 && g[1] === 0xff9b) return g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0 ? isBlockedV4Int(embeddedV4(g[6]!, g[7]!)) : true; // NAT64 64:ff9b::/96 (and local-use /48)
  if (g[0] === 0x2002) return isBlockedV4Int(embeddedV4(g[1]!, g[2]!)); // 6to4 2002:a.b.c.d::/48
  if (g[0] === 0x2001 && g[1] === 0) return true; // Teredo 2001::/32 (embeds a client address)
  if (g[0] === 0x2001 && g[1] === 0xdb8) return true; // documentation
  if (g[0] === 0x0100 && zeroUntil(0) && g[1] === 0 && g[2] === 0 && g[3] === 0) return true; // 100::/64 discard
  const first = g[0]!;
  if ((first & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((first & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((first & 0xffc0) === 0xfec0) return true; // fec0::/10 site-local (deprecated)
  if ((first & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  return false;
}

export function isBlockedAddress(ip: string): boolean {
  const kind = isIP(ip.replace(/^\[|\]$/g, "").split("%")[0]!);
  if (kind === 4) return isBlockedV4Int(v4ToInt(ip));
  if (kind === 6) {
    const g = parseIPv6(ip);
    return g ? isBlockedV6(g) : true;
  }
  return true; // not an IP: never treat as safe
}

const blockError = (why: string) => new ConnectorError("BLOCKED_DESTINATION", `Destination not allowed: ${why}`);

export async function assertPublicUrl(
  raw: string,
  resolve: (host: string) => Promise<string[]> = defaultResolve,
): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw); // WHATWG parsing normalizes 2130706433, 0x7f.1, 017700000001 → 127.0.0.1
  } catch {
    throw new ConnectorError("VALIDATION", "Invalid URL");
  }
  if (!["http:", "https:"].includes(url.protocol)) throw blockError("protocol");
  if (url.username || url.password) throw blockError("credentials in URL");
  if (url.port && !["80", "443"].includes(url.port)) throw blockError("port");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal") || host.endsWith(".local")) throw blockError("internal host");
  const addresses = isIP(host) ? [host] : await resolve(host).catch(() => [] as string[]);
  if (addresses.length === 0) throw blockError("unresolvable host");
  if (addresses.some(isBlockedAddress)) throw blockError("private address");
  return url;
}

function defaultResolve(host: string): Promise<string[]> {
  return new Promise((ok, fail) => dnsLookup(host, { all: true, verbatim: true }, (err, list) => (err ? fail(err) : ok(list.map((a) => a.address)))));
}

type Resolver = (host: string) => Promise<Array<{ address: string; family: number }>>;
const systemResolver: Resolver = (host) =>
  new Promise((ok, fail) => dnsLookup(host, { all: true, verbatim: true }, (err, list) => (err ? fail(err) : ok(list))));

/**
 * DNS lookup used at connect time. Rejects the connection if ANY resolved address is non-public,
 * and returns only validated addresses, so the socket connects to exactly what was checked.
 */
export function createSafeLookup(resolver: Resolver = systemResolver): LookupFunction {
  return ((hostname: string, options: { all?: boolean; family?: number } | number, callback: (...args: unknown[]) => void) => {
    const opts = typeof options === "object" ? options : {};
    resolver(hostname)
      .then((list) => {
        const wanted = opts.family === 4 || opts.family === 6 ? list.filter((a) => a.family === opts.family) : list;
        if (wanted.length === 0) return callback(Object.assign(new Error(`ENOTFOUND ${hostname}`), { code: "ENOTFOUND" }));
        const bad = wanted.find((a) => isBlockedAddress(a.address));
        if (bad) return callback(Object.assign(new Error("Destination not allowed: private address"), { code: "EBLOCKED" }));
        if (opts.all) callback(null, wanted);
        else callback(null, wanted[0]!.address, wanted[0]!.family);
      })
      .catch((err) => callback(err));
  }) as unknown as LookupFunction;
}

/** Agent for user-supplied destinations: guarded lookup, no proxy, conservative limits. */
export function createSsrfSafeAgent(resolver?: Resolver) {
  return new Agent({ connect: { lookup: createSafeLookup(resolver), timeout: 10_000 }, maxRedirections: 0, connections: 20 });
}

let sharedAgent: Agent | undefined;
/** fetch for user-supplied destinations. Same signature as fetch; redirects are never followed. */
export const ssrfSafeFetch: typeof fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  sharedAgent ??= createSsrfSafeAgent();
  try {
    return (await undiciFetch(input as never, { ...(init as object), redirect: "manual", dispatcher: sharedAgent } as never)) as unknown as Response;
  } catch (err) {
    const cause = (err as { cause?: { code?: string } }).cause;
    if (cause?.code === "EBLOCKED") throw blockError("private address (resolved at connect time)");
    throw err;
  }
}) as typeof fetch;
