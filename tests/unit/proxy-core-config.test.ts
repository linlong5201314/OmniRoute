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

  it("routes everything through a url-test group (speed/stability auto-select)", () => {
    const doc = yaml.load(buildMihomoConfig(subs)!) as Record<string, unknown>;
    const groups = doc["proxy-groups"] as Array<Record<string, unknown>>;
    assert.equal(groups.length, 1);
    assert.equal(groups[0].type, "url-test");
    assert.ok(Array.isArray(groups[0].use) && (groups[0].use as string[]).length === 2);
    assert.ok(Number(groups[0].tolerance) > 0);
    const rules = doc.rules as string[];
    assert.deepEqual(rules, ["MATCH,PROXY"]);
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
