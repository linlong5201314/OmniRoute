#!/usr/bin/env node

import { createHash } from "node:crypto";
import { chmod, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { arch as currentArch } from "node:process";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const TLS_CLIENT_VERSION = "1.15.1";
const RELEASE_BASE_URL = `https://github.com/bogdanfinn/tls-client/releases/download/v${TLS_CLIENT_VERSION}`;
const DEFAULT_RETRY_DELAYS_MS = [1_000, 3_000, 8_000];
const OUTPUT_FILE_NAME = "libtls-client.so";

const LINUX_ASSETS = {
  x64: {
    fileName: `tls-client-linux-ubuntu-amd64-${TLS_CLIENT_VERSION}.so`,
    sha256: "e393e866060e238bc36509f853293cebf5af8286aede59814462693efb603b1e",
  },
  arm64: {
    fileName: `tls-client-linux-arm64-${TLS_CLIENT_VERSION}.so`,
    sha256: "048b75c4fb0898a306228198d545eece39a7d5348200487f0395fbdc4168fe39",
  },
};

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

export function resolveTlsClientAsset(architecture = currentArch) {
  const asset = LINUX_ASSETS[architecture];
  if (!asset) {
    throw new Error(`Unsupported tls-client architecture: ${architecture}`);
  }

  return {
    version: TLS_CLIENT_VERSION,
    fileName: asset.fileName,
    url: `${RELEASE_BASE_URL}/${asset.fileName}`,
    sha256: asset.sha256,
  };
}

async function fetchAsset(url, fetchImpl, timeoutMs) {
  const response = await fetchImpl(url, {
    headers: { "User-Agent": "OmniRoute-Docker-Build" },
    redirect: "follow",
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!response.ok) {
    throw new Error(`download failed: ${response.status} ${response.statusText}`);
  }

  return Buffer.from(await response.arrayBuffer());
}

async function downloadWithRetry({ asset, fetchImpl, retryDelaysMs, timeoutMs, log }) {
  let lastError;

  for (let attempt = 0; attempt <= retryDelaysMs.length; attempt += 1) {
    try {
      return await fetchAsset(asset.url, fetchImpl, timeoutMs);
    } catch (error) {
      lastError = error;
      if (attempt === retryDelaysMs.length) break;

      const delayMs = retryDelaysMs[attempt];
      log(
        `tls-client download attempt ${attempt + 1} failed; retrying in ${delayMs}ms: ` +
          `${error instanceof Error ? error.message : String(error)}`
      );
      await sleep(delayMs);
    }
  }

  throw lastError;
}

export async function installTlsClientAsset({
  asset = resolveTlsClientAsset(),
  outputDir,
  fetchImpl = globalThis.fetch,
  retryDelaysMs = DEFAULT_RETRY_DELAYS_MS,
  timeoutMs = 60_000,
  log = console.log,
} = {}) {
  if (!outputDir) {
    throw new Error("outputDir is required");
  }

  const payload = await downloadWithRetry({
    asset,
    fetchImpl,
    retryDelaysMs,
    timeoutMs,
    log,
  });
  const actualSha256 = createHash("sha256").update(payload).digest("hex");
  if (actualSha256 !== asset.sha256) {
    throw new Error(
      `SHA-256 mismatch for ${asset.fileName}: expected ${asset.sha256}, got ${actualSha256}`
    );
  }

  await mkdir(outputDir, { recursive: true });
  const outputPath = join(outputDir, OUTPUT_FILE_NAME);
  const temporaryPath = `${outputPath}.tmp-${process.pid}`;

  try {
    await writeFile(temporaryPath, payload, { mode: 0o755 });
    await chmod(temporaryPath, 0o755);
    await rename(temporaryPath, outputPath);
  } finally {
    await rm(temporaryPath, { force: true });
  }

  log(`Installed verified tls-client ${asset.version} native library at ${outputPath}`);
  return outputPath;
}

async function main() {
  const outputDir = resolve(process.argv[2] || "native/tls-client");
  await installTlsClientAsset({ outputDir });
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (invokedPath === import.meta.url) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
