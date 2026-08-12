import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..");

const TLS_CLIENT_MODULES = [
  "open-sse/services/chatgptTlsClient.ts",
  "open-sse/services/claudeTlsClient.ts",
  "open-sse/services/grokTlsClient.ts",
  "open-sse/services/perplexityTlsClient.ts",
  "open-sse/services/lmarenaTlsClient.ts",
  "open-sse/services/notionTlsClient.ts",
] as const;

const originalDataDir = process.env.DATA_DIR;
const originalNativeLibraryPath = process.env.OMNIROUTE_TLS_CLIENT_NATIVE_LIBRARY_PATH;

afterEach(() => {
  if (originalDataDir === undefined) {
    delete process.env.DATA_DIR;
  } else {
    process.env.DATA_DIR = originalDataDir;
  }

  if (originalNativeLibraryPath === undefined) {
    delete process.env.OMNIROUTE_TLS_CLIENT_NATIVE_LIBRARY_PATH;
  } else {
    process.env.OMNIROUTE_TLS_CLIENT_NATIVE_LIBRARY_PATH = originalNativeLibraryPath;
  }
});

test("resolveTlsClientDownloadDir caches native binary under DATA_DIR/tls-client/bin (#8579)", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "omniroute-tls-client-8579-"));
  process.env.DATA_DIR = dataDir;

  const { resolveTlsClientDownloadDir } =
    await import("../../open-sse/services/tlsClientDownloadDir.ts");

  assert.equal(resolveTlsClientDownloadDir(), join(dataDir, "tls-client", "bin"));
});

test("buildNativeTlsClientOptions passes downloadDir to tls-client-node (#8579)", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "omniroute-tls-client-opts-8579-"));
  process.env.DATA_DIR = dataDir;

  const { buildNativeTlsClientOptions } =
    await import("../../open-sse/services/tlsClientDownloadDir.ts");

  const options = buildNativeTlsClientOptions();

  assert.equal(options.runtimeMode, "native");
  assert.equal(options.downloadDir, join(dataDir, "tls-client", "bin"));
});

test("buildNativeTlsClientOptions prefers the immutable Docker library over DATA_DIR", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "omniroute-tls-client-volume-"));
  const nativeLibraryPath = "/app/native/tls-client/libtls-client.so";
  process.env.DATA_DIR = dataDir;
  process.env.OMNIROUTE_TLS_CLIENT_NATIVE_LIBRARY_PATH = nativeLibraryPath;

  const { buildNativeTlsClientOptions } =
    await import("../../open-sse/services/tlsClientDownloadDir.ts");

  assert.deepEqual(buildNativeTlsClientOptions(), {
    runtimeMode: "native",
    nativeLibraryPath,
  });
});

test("buildNativeTlsClientOptions rejects a relative native library override", async () => {
  process.env.OMNIROUTE_TLS_CLIENT_NATIVE_LIBRARY_PATH = "native/tls-client/libtls-client.so";

  const { buildNativeTlsClientOptions } =
    await import("../../open-sse/services/tlsClientDownloadDir.ts");

  assert.throws(
    () => buildNativeTlsClientOptions(),
    /OMNIROUTE_TLS_CLIENT_NATIVE_LIBRARY_PATH must be an absolute path/
  );
});

test("all web-provider tls clients wire downloadDir through buildNativeTlsClientOptions (#8579)", () => {
  for (const relPath of TLS_CLIENT_MODULES) {
    const source = readFileSync(join(ROOT, relPath), "utf8");
    assert.match(
      source,
      /buildNativeTlsClientOptions\(\)/,
      `${relPath} must pass buildNativeTlsClientOptions() to TLSClient`
    );
    assert.doesNotMatch(
      source,
      /new TLSClient\(\{\s*runtimeMode:\s*"native"\s*\}\)/,
      `${relPath} must not construct TLSClient without downloadDir`
    );
  }
});
