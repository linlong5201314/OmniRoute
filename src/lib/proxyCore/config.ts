/**
 * mihomo (Clash.Meta) config generator for the embedded proxy core.
 *
 * OmniRoute's own subscription parser (proxySubscription/parse.ts) deliberately
 * DROPS the connection parameters of SS/VMess/VLESS/Trojan/… nodes (cipher,
 * password, uuid, TLS settings) — it only keeps host/port for display. So we
 * cannot reconstruct a working mihomo `proxies:` section from parsed data.
 *
 * Instead we let mihomo consume each enabled subscription URL NATIVELY through
 * its `proxy-providers` feature: mihomo fetches the Clash/V2Ray subscription
 * itself, keeps every credential, health-checks each node, and a `url-test`
 * group auto-selects the fastest healthy node ("优先代理速度稳定").
 *
 * Pure module — takes subscription descriptors, returns a YAML string — so the
 * generated config is unit-testable without a running core.
 */
import net from "node:net";
import * as yaml from "js-yaml";

/** A subscription that needs the core and has a usable subscription URL. */
export interface CoreSubscription {
  id: string;
  name: string;
  url: string;
}

/** Port the embedded core's mixed (SOCKS5+HTTP) listener binds to. */
export const CORE_MIXED_PORT = 2080;

/** Loopback-only bind: the core endpoint must never be LAN-reachable. */
const BIND_ADDRESS = "127.0.0.1";

/** Connectivity probe used for node health checks + url-test selection. */
const HEALTH_CHECK_URL = "https://www.gstatic.com/generate_204";

/** How often mihomo re-fetches each subscription (seconds). */
const PROVIDER_REFRESH_SECONDS = 3600;

/** How often each node is health-checked (seconds). */
const NODE_HEALTH_INTERVAL_SECONDS = 300;

/** url-test switches away from the current node only if another is this much faster (ms). */
const URL_TEST_TOLERANCE_MS = 50;

/**
 * Public IPv4 UDP resolvers used as fallbacks when the platform resolver list
 * is missing or unusable. AliDNS first: the typical subscription panel is
 * reachable from CN networks where 8.8.8.8/1.1.1.1 may be degraded.
 */
const PUBLIC_NAMESERVERS = ["223.5.5.5", "8.8.8.8", "1.1.1.1"];

/**
 * Explicit DNS config — verified root cause, deploy log 2026-08-17 11:00 UTC
 * (Railway, commit 51cec4547, no `dns:` section):
 *
 *   dns resolve failed: all DNS requests failed, first error:
 *   … dns resolve failed: ip version error
 *
 * With DNS omitted, mihomo fell back to the container resolver chain; the
 * answers it got left NO IPv4 record after mihomo's IPv4-only filter
 * (`component/resolver`: `DisableIPv6` defaults true, and `ErrIPVersion` =
 * "ip version error" fires when the filtered result is empty / wrong-version).
 * Every dial died — including mihomo's own provider fetches — so the PROXY
 * group never received a single node.
 *
 * Meanwhile the OmniRoute Node process resolved fine in the SAME container
 * (it downloaded the mihomo binary from GitHub). Fix: the manager reads
 * /etc/resolv.conf and hands mihomo the SAME resolvers explicitly, ahead of
 * public fallbacks. Every resolution path gets the working list —
 * `default-nameserver` (bootstrap), `proxy-server-nameserver` (node server
 * hostnames), `direct-nameserver` (DIRECT dials, i.e. the provider fetches).
 *
 * Deliberately NO `system` entry (it is the exact path that returned the
 * version-mismatched answers) and NO DoH (a DoH server hostname cannot be
 * resolved by a broken resolver — it produced the nested double
 * "all DNS requests failed" in the same deploy log).
 */
function buildDnsConfig(platformNameservers: string[]): Record<string, unknown> {
  const platform = [
    ...new Set(
      (Array.isArray(platformNameservers) ? platformNameservers : []).filter(
        (ip) => typeof ip === "string" && net.isIP(ip) > 0
      )
    ),
  ].slice(0, 3);
  const nameservers = [...new Set([...platform, ...PUBLIC_NAMESERVERS])];
  return {
    enable: true,
    ipv6: false,
    "default-nameserver": nameservers,
    nameserver: nameservers,
    "proxy-server-nameserver": nameservers,
    "direct-nameserver": nameservers,
  };
}

/** Sanitize a subscription id/name into a safe YAML key / file stem. */
function slug(input: string): string {
  const s = String(input || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return s || "sub";
}

/**
 * Build the mihomo config YAML for the given subscriptions. Returns null when
 * there is nothing to route (no subscriptions) — the caller should not start
 * the core in that case. `mixedPort` must match the port the subscriptions'
 * `localCoreEndpoint` points at, otherwise the dispatcher connects to a port
 * nobody listens on. `platformNameservers` are the container's own resolvers
 * (from /etc/resolv.conf) — they go first in every DNS list because the Node
 * process itself resolves through them successfully.
 */
export function buildMihomoConfig(
  subs: CoreSubscription[],
  mixedPort: number = CORE_MIXED_PORT,
  platformNameservers: string[] = []
): string | null {
  if (!Array.isArray(subs) || subs.length === 0) return null;
  const port =
    Number.isInteger(mixedPort) && mixedPort > 0 && mixedPort <= 65535
      ? mixedPort
      : CORE_MIXED_PORT;

  // De-duplicate provider keys (slug collisions across subscriptions).
  const seen = new Set<string>();
  const providers: Record<string, unknown> = {};
  const providerNames: string[] = [];
  const providerHosts = new Set<string>();
  for (const sub of subs) {
    if (!sub.url) continue;
    let key = slug(`${sub.name || "sub"}-${sub.id.slice(0, 8)}`);
    let n = 2;
    while (seen.has(key)) key = `${key}-${n++}`;
    seen.add(key);
    providerNames.push(key);
    try {
      providerHosts.add(new URL(sub.url).hostname);
    } catch {
      // unparseable URL — mihomo will report the provider error itself
    }
    providers[key] = {
      type: "http",
      url: sub.url,
      interval: PROVIDER_REFRESH_SECONDS,
      path: `./providers/${key}.yaml`,
      "health-check": {
        enable: true,
        url: HEALTH_CHECK_URL,
        interval: NODE_HEALTH_INTERVAL_SECONDS,
      },
    };
  }
  if (providerNames.length === 0) return null;

  const config = {
    // Inbound: one mixed (SOCKS5+HTTP) listener on loopback. OmniRoute points
    // its localCoreEndpoint (socks5://127.0.0.1:<port>) at exactly this.
    "mixed-port": port,
    "bind-address": BIND_ADDRESS,
    "allow-lan": false,
    ipv6: false,
    mode: "rule",
    "log-level": "warning",
    // No external-controller: config changes are applied by restarting the core,
    // which keeps the attack surface at zero (no API port to protect).

    // Explicit DNS — see buildDnsConfig above. Omitting the section proved
    // fatal in containers ("ip version error" with the bare system resolver).

    dns: buildDnsConfig(platformNameservers),

    "proxy-providers": providers,

    "proxy-groups": [
      {
        // url-test = auto-select the lowest-latency healthy node and switch
        // away when it degrades — the "优先代理速度稳定" behavior.
        name: "PROXY",
        type: "url-test",
        use: providerNames,
        url: HEALTH_CHECK_URL,
        interval: NODE_HEALTH_INTERVAL_SECONDS,
        tolerance: URL_TEST_TOLERANCE_MS,
      },
    ],

    rules: [
      // Provider bootstrap escape hatch. mihomo routes its OWN subscription
      // fetches through the rule engine, and `MATCH,PROXY` sent them into the
      // PROXY group — which is empty until the fetch succeeds: a deadlock that
      // kept every provider at 0 nodes (deploy log 2026-08-17 11:00:
      // `dial PROXY (match Match/) mihomo --> update.glados-config.com:443`).
      // Fetching the subscription panels DIRECT breaks the cycle; node traffic
      // still goes through the group via MATCH.
      ...[...providerHosts].map((host) => `DOMAIN,${host},DIRECT`),
      "MATCH,PROXY",
    ],
  };

  return yaml.dump(config, { lineWidth: 10000, noRefs: true });
}
