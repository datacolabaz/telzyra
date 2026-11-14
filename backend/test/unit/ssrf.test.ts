import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fetch as undiciFetch } from "undici";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertPublicUrl, createSafeLookup, createSsrfSafeAgent, isBlockedAddress, parseIPv6 } from "../../src/integrations/core/ssrf.js";

describe("address classification", () => {
  it.each([
    "127.0.0.1", "10.0.0.1", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "198.18.0.1", "224.0.0.1", "255.255.255.255", "192.0.2.1",
    "::", "::1", "fd00::1", "fe80::1%eth0", "ff02::1", "fec0::1",
    "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:169.254.169.254", "::ffff:0:10.0.0.1", "::127.0.0.1",
    "64:ff9b::a9fe:a9fe", "64:ff9b:1::1", "2002:7f00:1::", "2002:c0a8:101::1", "2001::1", "2001:db8::1",
    "not-an-ip",
  ])("blocks %s", (ip) => expect(isBlockedAddress(ip)).toBe(true));

  it.each(["8.8.8.8", "1.1.1.1", "93.184.216.34", "172.32.0.1", "100.128.0.1", "2606:4700:4700::1111", "2a00:1450:4001::200e", "::ffff:8.8.8.8", "64:ff9b::808:808", "2002:808:808::1"])("allows %s", (ip) => expect(isBlockedAddress(ip)).toBe(false));

  it("parses IPv6 notations", () => {
    expect(parseIPv6("::1")).toEqual([0, 0, 0, 0, 0, 0, 0, 1]);
    expect(parseIPv6("::ffff:1.2.3.4")).toEqual([0, 0, 0, 0, 0, 0xffff, 0x102, 0x304]);
    expect(parseIPv6("1:2:3:4:5:6:7:8")).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(parseIPv6("1::2::3")).toBeNull();
  });
});

describe("URL checks", () => {
  const pub = async () => ["93.184.216.34"];
  it.each([
    ["http://2130706433/", "decimal IPv4"],
    ["http://0x7f.0.0.1/", "hex IPv4"],
    ["http://017700000001/", "octal IPv4"],
    ["http://[::ffff:127.0.0.1]/", "mapped IPv6 literal"],
    ["http://[::1]/", "IPv6 loopback"],
    ["http://169.254.169.254/latest/meta-data", "metadata"],
    ["http://metadata.google.internal/", "internal name"],
    ["http://printer.local/", "mDNS name"],
    ["gopher://example.com/", "scheme"],
    ["http://example.com:8080/", "port"],
  ])("blocks %s (%s)", async (url) => {
    await expect(assertPublicUrl(url, pub)).rejects.toMatchObject({ code: "BLOCKED_DESTINATION" });
  });
  it("blocks when any resolved address is private (mixed answers)", async () => {
    await expect(assertPublicUrl("https://mixed.example/", async () => ["93.184.216.34", "10.0.0.7"])).rejects.toMatchObject({ code: "BLOCKED_DESTINATION" });
  });
});

describe("connect-time DNS check (DNS rebinding)", () => {
  let server: Server;
  let port: number;
  let hits = 0;
  beforeAll(async () => {
    server = createServer((_req, res) => {
      hits++;
      res.end("internal secret");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it("lookup refuses private answers and returns only validated ones", async () => {
    const lookup = createSafeLookup(async () => [{ address: "127.0.0.1", family: 4 }]);
    const err = await new Promise((r) => (lookup as unknown as (h: string, o: object, cb: (e: unknown) => void) => void)("evil.test", {}, r));
    expect(err).toMatchObject({ code: "EBLOCKED" });
    const ok = createSafeLookup(async () => [{ address: "93.184.216.34", family: 4 }, { address: "2606:4700::1", family: 6 }]);
    const res = await new Promise((r) => (ok as unknown as (h: string, o: object, cb: (...a: unknown[]) => void) => void)("good.test", { family: 6 }, (...a) => r(a)));
    expect(res).toEqual([null, "2606:4700::1", 6]);
  });

  it("a host that passed the pre-check but resolves to 127.0.0.1 at connect time is never reached", async () => {
    // First answer (pre-check) public, second answer (connect) loopback: the classic rebinding attack.
    await expect(assertPublicUrl(`http://rebind.test/`, async () => ["93.184.216.34"])).resolves.toBeInstanceOf(URL);
    const agent = createSsrfSafeAgent(async () => [{ address: "127.0.0.1", family: 4 }]);
    const before = hits;
    // Port is the local test server's; host name forces a DNS lookup through the guarded agent.
    await expect(undiciFetch(`http://rebind.test:${port}/`, { dispatcher: agent })).rejects.toMatchObject({ cause: { code: "EBLOCKED" } });
    expect(hits).toBe(before);
    await agent.close();
  });

  it("control: the same request without the guard does reach the internal server", async () => {
    const { Agent } = await import("undici");
    const open = new Agent({ connect: { lookup: ((_h: string, o: { all?: boolean }, cb: (...a: unknown[]) => void) => (o.all ? cb(null, [{ address: "127.0.0.1", family: 4 }]) : cb(null, "127.0.0.1", 4))) as never } });
    const res = await undiciFetch(`http://rebind.test:${port}/`, { dispatcher: open });
    expect(await res.text()).toBe("internal secret");
    await open.close();
  });
});
