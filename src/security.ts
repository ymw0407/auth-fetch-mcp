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

/**
 * Expands an IPv6 string into its 8 16-bit hextets, handling "::" zero
 * compression and a trailing dotted-quad (e.g. ::ffff:127.0.0.1). Returns null
 * if the input is not a well-formed IPv6 literal.
 */
function ipv6ToHextets(ip: string): number[] | null {
  let s = ip.toLowerCase();
  const pct = s.indexOf("%");
  if (pct !== -1) s = s.slice(0, pct); // strip zone id

  // Fold a trailing embedded IPv4 (dotted quad) into two hextets.
  const lastColon = s.lastIndexOf(":");
  if (lastColon !== -1 && s.slice(lastColon + 1).includes(".")) {
    const quad = s.slice(lastColon + 1).split(".");
    if (quad.length !== 4) return null;
    const n = quad.map((q) => (/^\d{1,3}$/.test(q) ? Number(q) : NaN));
    if (n.some((x) => Number.isNaN(x) || x > 255)) return null;
    const hi = ((n[0] << 8) | n[1]) & 0xffff;
    const lo = ((n[2] << 8) | n[3]) & 0xffff;
    s = `${s.slice(0, lastColon + 1)}${hi.toString(16)}:${lo.toString(16)}`;
  }

  const halves = s.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 ? (halves[1] ? halves[1].split(":") : []) : null;

  let groups: string[];
  if (tail === null) {
    groups = head; // no "::" — must be fully specified
  } else {
    const fill = 8 - head.length - tail.length;
    if (fill < 1) return null; // "::" must stand for at least one zero group
    groups = [...head, ...Array(fill).fill("0"), ...tail];
  }
  if (groups.length !== 8) return null;
  if (!groups.every((g) => /^[0-9a-f]{1,4}$/.test(g))) return null;
  return groups.map((g) => parseInt(g, 16));
}

function isPrivateV6(ip: string): boolean {
  const lower = ip.toLowerCase();
  if (lower === "::" || lower === "::1") return true;
  if (lower.startsWith("fe80:") || lower.startsWith("fe80::")) return true;
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true;
  if (lower.startsWith("ff")) return true;

  const h = ipv6ToHextets(ip);
  if (!h) return true; // cannot parse -> fail closed

  const embeddedV4 = (a: number, b: number): string =>
    `${(a >> 8) & 0xff}.${a & 0xff}.${(b >> 8) & 0xff}.${b & 0xff}`;

  // IPv6 forms that embed an IPv4 address. If the embedded IPv4 is private/
  // loopback/link-local, the endpoint is too, regardless of the wrapper — so
  // check it. Public embedded IPv4 (e.g. ::ffff:8.8.8.8) stays allowed.
  //   ::a.b.c.d          IPv4-compatible (::/96, deprecated)
  //   ::ffff:a.b.c.d     IPv4-mapped (::ffff:0:0/96)
  //   ::ffff:0:a.b.c.d   IPv4-translated (::ffff:0:0:0/96)
  if (h[0] === 0 && h[1] === 0 && h[2] === 0 && h[3] === 0) {
    const wrapped =
      (h[4] === 0 && h[5] === 0) ||
      (h[4] === 0 && h[5] === 0xffff) ||
      (h[4] === 0xffff && h[5] === 0);
    if (wrapped && isPrivateV4(embeddedV4(h[6], h[7]))) return true;
  }
  // NAT64 well-known prefix 64:ff9b::/96 (RFC 6052).
  if (
    h[0] === 0x64 && h[1] === 0xff9b &&
    h[2] === 0 && h[3] === 0 && h[4] === 0 && h[5] === 0 &&
    isPrivateV4(embeddedV4(h[6], h[7]))
  ) {
    return true;
  }
  // 6to4 2002:V4::/16 (RFC 3056) — embedded IPv4 in bits 16..48.
  if (h[0] === 0x2002 && isPrivateV4(embeddedV4(h[1], h[2]))) return true;

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
