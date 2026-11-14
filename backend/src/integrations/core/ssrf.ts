import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { ConnectorError } from "./errors.js";

/**
 * SSRF guard for user-configurable outbound URLs (HTTP Request action, custom webhooks).
 * Only http(s) on standard ports to public addresses is allowed; every resolved address is
 * checked, so a hostname that points to an internal IP is rejected as well.
 */
const BLOCKED_V4: Array<[number, number]> = [
  [0x00000000, 8], // 0.0.0.0/8
  [0x0a000000, 8], // 10.0.0.0/8
  [0x64400000, 10], // 100.64.0.0/10 (CGNAT)
  [0x7f000000, 8], // 127.0.0.0/8
  [0xa9fe0000, 16], // 169.254.0.0/16 (link-local, cloud metadata)
  [0xac100000, 12], // 172.16.0.0/12
  [0xc0000000, 24], // 192.0.0.0/24
  [0xc0a80000, 16], // 192.168.0.0/16
  [0xc6120000, 15], // 198.18.0.0/15
  [0xe0000000, 4], // 224.0.0.0/4 multicast
  [0xf0000000, 4], // 240.0.0.0/4 reserved
];

function v4ToInt(ip: string): number {
  return ip.split(".").reduce((acc, o) => (acc << 8) + Number(o), 0) >>> 0;
}

export function isBlockedAddress(ip: string): boolean {
  if (isIP(ip) === 4) {
    const n = v4ToInt(ip);
    return BLOCKED_V4.some(([net, bits]) => (n & (~0 << (32 - bits)) >>> 0) === net);
  }
  const v6 = ip.toLowerCase();
  if (v6 === "::" || v6 === "::1") return true;
  const mapped = v6.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isBlockedAddress(mapped[1]!);
  return /^(fc|fd|fe8|fe9|fea|feb|ff)/.test(v6); // ULA, link-local, multicast
}

export async function assertPublicUrl(
  raw: string,
  resolve: (host: string) => Promise<string[]> = async (h) => (await lookup(h, { all: true })).map((a) => a.address),
): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ConnectorError("VALIDATION", "Invalid URL");
  }
  const block = (why: string) => new ConnectorError("BLOCKED_DESTINATION", `Destination not allowed: ${why}`);
  if (!["http:", "https:"].includes(url.protocol)) throw block("protocol");
  if (url.username || url.password) throw block("credentials in URL");
  if (url.port && !["80", "443"].includes(url.port)) throw block("port");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal")) throw block("internal host");
  const addresses = isIP(host) ? [host] : await resolve(host).catch(() => [] as string[]);
  if (addresses.length === 0) throw block("unresolvable host");
  if (addresses.some(isBlockedAddress)) throw block("private address");
  return url;
}
