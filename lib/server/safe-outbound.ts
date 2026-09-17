import { promises as dns } from "node:dns";
import { BlockList, isIP } from "node:net";
import https from "node:https";

const blocked = new BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const)
  blocked.addSubnet(address, prefix, "ipv4");
const ipv6Global = new BlockList();
ipv6Global.addSubnet("2000::", 3, "ipv6");
const ipv6Special = new BlockList();
ipv6Special.addSubnet("2001::", 23, "ipv6");
ipv6Special.addSubnet("2001:db8::", 32, "ipv6");
ipv6Special.addSubnet("2002::", 16, "ipv6");
ipv6Special.addSubnet("3fff::", 20, "ipv6");

export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  return family === 4
    ? !blocked.check(address, "ipv4")
    : family === 6 &&
        ipv6Global.check(address, "ipv6") &&
        !ipv6Special.check(address, "ipv6");
}
export async function resolvePublicUrl(value: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("INVALID_WEBHOOK_URL");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    (url.port && url.port !== "443")
  )
    throw new Error("INVALID_WEBHOOK_URL");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = isIP(host)
    ? [{ address: host, family: isIP(host) }]
    : await dns.lookup(host, { all: true }).catch(() => []);
  if (!addresses.length || addresses.some((a) => !isPublicAddress(a.address)))
    throw new Error("INVALID_WEBHOOK_URL");
  return { url, address: addresses[0] };
}

/** TLS still validates the original hostname; the socket uses only the validated IP. */
export async function postPublicWebhook(
  value: string,
  headers: Record<string, string>,
  body: string,
): Promise<number> {
  const { url, address } = await resolvePublicUrl(value);
  return new Promise((resolve, reject) => {
    const request = https.request(
      url,
      {
        method: "POST",
        headers,
        agent: false,
        lookup: (_hostname, options, callback) =>
          options.all
            ? callback(null, [address])
            : callback(null, address.address, address.family),
        signal: AbortSignal.timeout(10_000),
      },
      (response) => {
        response.destroy(); // Never buffer an untrusted response or follow redirects.
        resolve(response.statusCode || 500);
      },
    );
    request.on("error", reject);
    request.end(body);
  });
}
