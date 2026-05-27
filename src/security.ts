import dns from "node:dns/promises";
import net from "node:net";
import path from "node:path";
import fs from "node:fs";

const PRIVATE_V4_RANGES: ReadonlyArray<[number, number]> = (() => {
  const cidr = (n: string, bits: number): [number, number] => {
    const [a, b, c, d] = n.split(".").map(Number);
    const base = ((a << 24) | (b << 16) | (c << 8) | d) >>> 0;
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return [base & mask, mask];
  };
  return [
    cidr("0.0.0.0", 8),
    cidr("10.0.0.0", 8),
    cidr("100.64.0.0", 10),
    cidr("127.0.0.0", 8),
    cidr("169.254.0.0", 16),
    cidr("172.16.0.0", 12),
    cidr("192.0.0.0", 24),
    cidr("192.168.0.0", 16),
    cidr("198.18.0.0", 15),
    cidr("224.0.0.0", 4),
    cidr("240.0.0.0", 4),
  ];
})();

function ipv4ToInt(ip: string): number {
  const parts = ip.split(".").map(Number);
  return (
    ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0
  );
}

function isPrivateV4(ip: string): boolean {
  const n = ipv4ToInt(ip);
  return PRIVATE_V4_RANGES.some(([base, mask]) => (n & mask) === base);
}

function isPrivateV6(ip: string): boolean {
  const lower = ip.toLowerCase();
  if (lower === "::" || lower === "::1") return true;
  if (lower.startsWith("fe80:") || lower.startsWith("fe80::")) return true;
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true;
  if (lower.startsWith("ff")) return true;
  if (lower.startsWith("::ffff:")) {
    const v4 = lower.slice(7);
    if (net.isIPv4(v4)) return isPrivateV4(v4);
    // WHATWG URL parser hex-normalizes IPv4-mapped IPv6 addresses, e.g.
    // ::ffff:127.0.0.1 -> ::ffff:7f00:1. Reconstruct the IPv4 from the two
    // trailing hex groups so the private-range check still applies.
    const groups = v4.split(":");
    if (
      groups.length === 2 &&
      groups.every((g) => /^[0-9a-f]{1,4}$/.test(g))
    ) {
      const hi = parseInt(groups[0], 16);
      const lo = parseInt(groups[1], 16);
      const mapped = `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
      return isPrivateV4(mapped);
    }
  }
  return false;
}

function isPrivateOrLinkLocal(ip: string): boolean {
  if (net.isIPv4(ip)) return isPrivateV4(ip);
  if (net.isIPv6(ip)) return isPrivateV6(ip);
  return true;
}

function allowAllPrivate(): boolean {
  const v = (process.env.AUTH_FETCH_ALLOW_PRIVATE ?? "").toLowerCase().trim();
  return v === "1" || v === "true" || v === "yes";
}

function getAllowedHosts(): Set<string> {
  const raw = process.env.AUTH_FETCH_ALLOW_HOSTS ?? "";
  return new Set(
    raw
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean)
  );
}

export async function assertSafeUrl(rawUrl: string): Promise<URL> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(`Invalid URL: ${rawUrl}`);
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error(`Unsupported URL scheme: ${parsed.protocol}`);
  }
  const host = parsed.hostname.replace(/^\[|\]$/g, "");
  if (!host) throw new Error("URL is missing a hostname");

  if (allowAllPrivate()) return parsed;

  const allowedHosts = getAllowedHosts();
  if (allowedHosts.has(host.toLowerCase())) return parsed;

  const addresses = net.isIP(host)
    ? [host]
    : (await dns.lookup(host, { all: true, verbatim: true })).map(
        (a) => a.address
      );

  if (addresses.some((a) => allowedHosts.has(a.toLowerCase()))) return parsed;

  for (const addr of addresses) {
    if (isPrivateOrLinkLocal(addr)) {
      throw new Error(
        `Refusing to fetch ${parsed.hostname} (resolves to private/loopback/link-local address ${addr}). ` +
          `To allow, set AUTH_FETCH_ALLOW_PRIVATE=1 or AUTH_FETCH_ALLOW_HOSTS=${parsed.hostname}`
      );
    }
  }
  return parsed;
}

function defaultDownloadRoot(): string {
  const home = process.env.HOME || process.env.USERPROFILE || ".";
  return path.resolve(home, ".auth-fetch-mcp", "downloads");
}

export function resolveSafeOutputDir(outputDir: string | undefined): string {
  const root = defaultDownloadRoot();
  fs.mkdirSync(root, { recursive: true });

  if (!outputDir) {
    const timestamp = new Date()
      .toISOString()
      .replace(/[:.]/g, "-")
      .slice(0, 19);
    const dir = path.join(root, timestamp);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  const resolved = path.resolve(root, outputDir);
  const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep;
  if (resolved !== root && !resolved.startsWith(rootWithSep)) {
    throw new Error(
      `output_dir must resolve inside ${root}; got ${resolved}`
    );
  }
  fs.mkdirSync(resolved, { recursive: true });
  return resolved;
}
