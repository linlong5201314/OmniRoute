import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  installTlsClientAsset,
  resolveTlsClientAsset,
} from "../../scripts/build/installTlsClientNative.mjs";

const VERSION = "1.15.1";

function sha256(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

test("pins official tls-client v1.15.1 assets and digests for supported Docker arches", () => {
  assert.deepEqual(resolveTlsClientAsset("x64"), {
    version: VERSION,
    fileName: `tls-client-linux-ubuntu-amd64-${VERSION}.so`,
    url:
      `https://github.com/bogdanfinn/tls-client/releases/download/v${VERSION}/` +
      `tls-client-linux-ubuntu-amd64-${VERSION}.so`,
    sha256: "e393e866060e238bc36509f853293cebf5af8286aede59814462693efb603b1e",
  });

  assert.deepEqual(resolveTlsClientAsset("arm64"), {
    version: VERSION,
    fileName: `tls-client-linux-arm64-${VERSION}.so`,
    url:
      `https://github.com/bogdanfinn/tls-client/releases/download/v${VERSION}/` +
      `tls-client-linux-arm64-${VERSION}.so`,
    sha256: "048b75c4fb0898a306228198d545eece39a7d5348200487f0395fbdc4168fe39",
  });
});

test("rejects unsupported Docker architectures before making a request", () => {
  assert.throws(() => resolveTlsClientAsset("ia32"), /Unsupported tls-client architecture: ia32/);
});

test("downloads the direct release asset, verifies it, and writes the immutable library", async () => {
  const outputDir = mkdtempSync(join(tmpdir(), "omniroute-tls-client-install-"));
  const payload = Buffer.from("verified-native-library");
  const requestedUrls: string[] = [];
  const asset = {
    version: "test",
    fileName: "tls-client-linux-test.so",
    url: "https://github.com/example/releases/download/vtest/tls-client-linux-test.so",
    sha256: sha256(payload),
  };

  try {
    const installedPath = await installTlsClientAsset({
      asset,
      outputDir,
      fetchImpl: async (url) => {
        requestedUrls.push(String(url));
        return new Response(payload);
      },
      retryDelaysMs: [],
      log: () => undefined,
    });

    assert.deepEqual(requestedUrls, [asset.url]);
    assert.ok(requestedUrls.every((url) => !url.includes("api.github.com")));
    assert.equal(installedPath, join(outputDir, "libtls-client.so"));
    assert.deepEqual(readFileSync(installedPath), payload);
  } finally {
    rmSync(outputDir, { recursive: true, force: true });
  }
});

test("retries transient direct-download failures", async () => {
  const outputDir = mkdtempSync(join(tmpdir(), "omniroute-tls-client-retry-"));
  const payload = Buffer.from("retry-success");
  let attempts = 0;

  try {
    await installTlsClientAsset({
      asset: {
        version: "test",
        fileName: "tls-client-linux-test.so",
        url: "https://github.com/example/releases/download/vtest/tls-client-linux-test.so",
        sha256: sha256(payload),
      },
      outputDir,
      fetchImpl: async () => {
        attempts += 1;
        return attempts === 1
          ? new Response("unavailable", { status: 503 })
          : new Response(payload);
      },
      retryDelaysMs: [0],
      log: () => undefined,
    });

    assert.equal(attempts, 2);
  } finally {
    rmSync(outputDir, { recursive: true, force: true });
  }
});

test("does not publish a library when the official digest does not match", async () => {
  const outputDir = mkdtempSync(join(tmpdir(), "omniroute-tls-client-digest-"));

  try {
    await assert.rejects(
      installTlsClientAsset({
        asset: {
          version: "test",
          fileName: "tls-client-linux-test.so",
          url: "https://github.com/example/releases/download/vtest/tls-client-linux-test.so",
          sha256: "0".repeat(64),
        },
        outputDir,
        fetchImpl: async () => new Response("tampered"),
        retryDelaysMs: [],
        log: () => undefined,
      }),
      /SHA-256 mismatch/
    );

    assert.equal(existsSync(join(outputDir, "libtls-client.so")), false);
  } finally {
    rmSync(outputDir, { recursive: true, force: true });
  }
});
