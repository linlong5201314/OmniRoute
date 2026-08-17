import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as yaml from "js-yaml";

import {
  MIHOMO_VERSION,
  MIHOMO_RELEASE_BASE,
  resolveMihomoAsset,
  mihomoAssetUrl,
  MIHOMO_ASSETS,
} from "../../src/lib/proxyCore/assets.ts";
import { buildMihomoConfig, CORE_MIXED_PORT } from "../../src/lib/proxyCore/config.ts";

describe("proxyCore assets", () => {
  it("resolves linux-x64 to the compatible amd64 build", () => {
    const asset = resolveMihomoAsset("linux", "x64");
    assert.ok(asset);
    assert.equal(asset.fileName, `mihomo-linux-amd64-compatible-${MIHOMO_VERSION}.gz`);
    assert.match(asset.sha256, /^[0-9a-f]{64}$/);
    assert.equal(asset.archive, "gz");
  });

  it("resolves linux-arm64 and darwin variants", () => {
    assert.ok(resolveMihomoAsset("linux", "arm64"));
    assert.ok(resolveMihomoAsset("darwin", "x64"));
    assert.ok(resolveMihomoAsset("darwin", "arm64"));
  });

  it("returns null for unsupported platforms (no embedded core, not an error)", () => {
    assert.equal(resolveMihomoAsset("win32", "x64"), null);
    assert.equal(resolveMihomoAsset("linux", "ia32"), null);
    assert.equal(resolveMihomoAsset("freebsd", "x64"), null);
  });

  it("every pinned asset carries a full sha256 digest and a versioned URL", () => {
    for (const asset of Object.values(MIHOMO_ASSETS)) {
      assert.match(asset.sha256, /^[0-9a-f]{64}$/, `${asset.fileName} digest malformed`);
      assert.ok(asset.fileName.includes(MIHOMO_VERSION), `${asset.fileName} not version-pinned`);
      assert.ok(
        mihomoAssetUrl(asset).startsWith(MIHOMO_RELEASE_BASE),
        `${asset.fileName} URL outside the pinned release`
      );
    }
  });
});

describe("proxyCore config generator", () => {
  const subs = [
    { id: "sub-one-1234", name: "机场 A", url: "https://example.com/sub?token=aaa" },
    { id: "sub-two-5678", name: "Airport B", url: "https://example.org/clash.yaml" },
  ];

  it("returns null when there are no subscriptions", () => {
    assert.equal(buildMihomoConfig([]), null);
    assert.equal(buildMihomoConfig(null as never), null);
  });

  it("returns null when no subscription has a usable URL", () => {
    assert.equal(buildMihomoConfig([{ id: "x", name: "n", url: "" }]), null);
  });

  it("emits a loopback-only mixed listener on the core port", () => {
    const doc = yaml.load(buildMihomoConfig(subs)!) as Record<string, unknown>;
    assert.equal(doc["mixed-port"], CORE_MIXED_PORT);
    assert.equal(doc["bind-address"], "127.0.0.1");
    assert.equal(doc["allow-lan"], false);
  });

  it("honors a custom mixed port (operator's localCoreEndpoint port)", () => {
    const doc = yaml.load(buildMihomoConfig(subs, 7890)!) as Record<string, unknown>;
    assert.equal(doc["mixed-port"], 7890);
    // Out-of-range values fall back to the default port instead of emitting a
    // config nobody can connect to.
    const fallback = yaml.load(buildMihomoConfig(subs, 0)!) as Record<string, unknown>;
    assert.equal(fallback["mixed-port"], CORE_MIXED_PORT);
  });

  it("creates one proxy-provider per subscription with health checks", () => {
    const doc = yaml.load(buildMihomoConfig(subs)!) as Record<string, unknown>;
    const providers = doc["proxy-providers"] as Record<string, Record<string, unknown>>;
    const keys = Object.keys(providers);
    assert.equal(keys.length, 2);
    for (const key of keys) {
      const p = providers[key];
      assert.equal(p.type, "http");
      assert.ok(String(p.url).startsWith("https://"));
      const hc = p["health-check"] as Record<string, unknown>;
      assert.equal(hc.enable, true);
      assert.ok(Number(hc.interval) > 0);
    }
    const urls = keys.map((k) => providers[k].url);
    assert.ok(urls.includes("https://example.com/sub?token=aaa"));
    assert.ok(urls.includes("https://example.org/clash.yaml"));
  });

  it("keeps a url-test group for health probing (speed/stability auto-select)", () => {
    const doc = yaml.load(buildMihomoConfig(subs)!) as Record<string, unknown>;
    const groups = doc["proxy-groups"] as Array<Record<string, unknown>>;
    const urlTest = groups.find((g) => g.type === "url-test");
    assert.ok(urlTest, "url-test group must remain for health probing");
    assert.ok(Array.isArray(urlTest.use) && (urlTest.use as string[]).length === 2);
    assert.ok(Number(urlTest.tolerance) > 0);
  });

  it("routes MATCH through a round-robin load-balance group (per-account IP spread)", () => {
    // Railway deploy log 2026-08-17 12:58 UTC: 20 opencode accounts all egressed
    // through the single url-test node (out=217.217.222.228) — the upstream
    // rate-limited that ONE IP and every account 429'd. round-robin spreads
    // connections across subscription nodes so the account pool gets distinct
    // exit IPs instead of sharing one.
    const doc = yaml.load(buildMihomoConfig(subs)!) as Record<string, unknown>;
    const groups = doc["proxy-groups"] as Array<Record<string, unknown>>;
    const pool = groups.find((g) => g.type === "load-balance");
    assert.ok(pool, "load-balance group must exist");
    assert.equal(pool.strategy, "round-robin");
    assert.ok(Array.isArray(pool.use) && (pool.use as string[]).length === 2);
    assert.ok(Number(pool.interval) > 0, "load-balance group needs health checks");
    const rules = doc.rules as string[];
    assert.deepEqual(rules, [
      "DOMAIN,example.com,DIRECT",
      "DOMAIN,example.org,DIRECT",
      "MATCH,PROXY-POOL",
    ]);
  });

  it("de-duplicates identical provider hosts in the DIRECT rules", () => {
    const sameHost = [
      { id: "aaaa1111", name: "A", url: "https://panel.example/sub?token=1" },
      { id: "bbbb2222", name: "B", url: "https://panel.example/sub?token=2" },
    ];
    const doc = yaml.load(buildMihomoConfig(sameHost)!) as Record<string, unknown>;
    const rules = doc.rules as string[];
    assert.deepEqual(rules, ["DOMAIN,panel.example,DIRECT", "MATCH,PROXY-POOL"]);
  });

  it("emits an explicit dns section (container 'ip version error' fix)", () => {
    const doc = yaml.load(buildMihomoConfig(subs)!) as Record<string, unknown>;
    const dns = doc.dns as Record<string, unknown>;
    assert.ok(dns, "dns section must be present");
    assert.equal(dns.enable, true);
    assert.equal(dns.ipv6, false);
    const nameservers = dns.nameserver as string[];
    assert.ok(nameservers.length >= 3, "resolver list must have fallbacks");
    assert.ok(nameservers.includes("223.5.5.5"));
    assert.ok(nameservers.includes("8.8.8.8"));
    // "system" is the exact resolver path that produced version-mismatched
    // answers on Railway (deploy log 2026-08-17) — it must not be first-class.
    assert.ok(!nameservers.includes("system"), "must not rely on the system resolver");
    // DoH cannot bootstrap its own hostname through a broken container
    // resolver (nested "all DNS requests failed" in the same deploy log).
    assert.ok(
      !nameservers.some((n) => n.startsWith("https://")),
      "no DoH entries — they cannot bootstrap in a DNS-broken container"
    );
    // Every resolution path gets an explicit list.
    for (const key of ["default-nameserver", "proxy-server-nameserver", "direct-nameserver"]) {
      const list = dns[key] as string[];
      assert.ok(Array.isArray(list) && list.length > 0, `${key} must be set`);
    }
  });

  it("injects platform resolvers first and dedupes (resolv.conf path)", () => {
    const doc = yaml.load(
      buildMihomoConfig(subs, 2080, [
        "10.0.0.1",
        "127.0.0.11",
        "10.0.0.1",
        "not-an-ip",
        "",
        "8.8.8.8",
      ])
    )! as Record<string, unknown>;
    const dns = doc.dns as Record<string, unknown>;
    const nameservers = dns.nameserver as string[];
    // Only valid IPs survive, duplicates collapse, platform first, public kept.
    assert.deepEqual(nameservers.slice(0, 2), ["10.0.0.1", "127.0.0.11"]);
    assert.ok(nameservers.includes("223.5.5.5"));
    assert.equal(new Set(nameservers).size, nameservers.length, "nameservers must be deduped");
    // The same list feeds every resolution path.
    assert.deepEqual(dns["proxy-server-nameserver"], nameservers);
    assert.deepEqual(dns["direct-nameserver"], nameservers);
    assert.deepEqual(dns["default-nameserver"], nameservers);
  });

  it("de-duplicates colliding provider keys", () => {
    const dup = [
      { id: "aaaa1111", name: "Same Name", url: "https://a.example/1" },
      { id: "bbbb2222", name: "Same Name", url: "https://b.example/2" },
    ];
    const doc = yaml.load(buildMihomoConfig(dup)!) as Record<string, unknown>;
    const providers = doc["proxy-providers"] as Record<string, unknown>;
    assert.equal(Object.keys(providers).length, 2, "collision must not collapse providers");
  });

  it("exposes no external-controller (no API surface to protect)", () => {
    const doc = yaml.load(buildMihomoConfig(subs)!) as Record<string, unknown>;
    assert.equal(doc["external-controller"], undefined);
    assert.equal(doc.secret, undefined);
  });
});
