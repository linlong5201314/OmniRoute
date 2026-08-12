import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..");

test("Dockerfile's --ignore-scripts npm ci is compensated for tls-client-node's native binary, same as it is for wreq-js and better-sqlite3 (#7802)", () => {
  const dockerfile = readFileSync(join(ROOT, "Dockerfile"), "utf8");
  const postinstall = readFileSync(join(ROOT, "scripts/build/postinstall.mjs"), "utf8");

  assert.match(
    dockerfile,
    // Flag-order tolerant on purpose: the assertion is about the --ignore-scripts
    // PRECONDITION, not the exact flag list. #9185 inserted --include=optional
    // (LLMLingua optional deps) and broke the literal pin without touching intent.
    /npm ci(?: --[\w-]+(?:=[\w-]+)?)* --ignore-scripts/,
    "expected the builder stage to install with --ignore-scripts (precondition of #7802)"
  );

  assert.match(
    dockerfile,
    /better-sqlite3[\s\S]*node-gyp\.js rebuild/,
    "expected an explicit better-sqlite3 rebuild step after --ignore-scripts"
  );

  assert.match(
    postinstall,
    /fixWreqJsBinary/,
    "expected postinstall.mjs to repair wreq-js's native binary"
  );

  assert.match(
    dockerfile,
    /installTlsClientNative\.mjs/,
    "Docker builds must use the repo-owned deterministic installer instead of " +
      "tls-client-node's one-shot GitHub API postinstall"
  );

  assert.match(
    dockerfile,
    /COPY scripts\/build\/installTlsClientNative\.mjs \.\/scripts\/build\/installTlsClientNative\.mjs/,
    "the deterministic installer must be available before npm ci runs"
  );

  assert.match(
    dockerfile,
    /COPY --from=builder \/app\/native\/tls-client \.\/native\/tls-client/,
    "the verified native library must be copied from the builder into the runtime image"
  );

  assert.match(
    dockerfile,
    /require\('koffi'\)\.load\('\/app\/native\/tls-client\/libtls-client\.so'\)\.func\('request'/,
    "the Docker build must load the verified shared library and resolve a required symbol"
  );

  assert.doesNotMatch(
    dockerfile,
    /node node_modules\/tls-client-node\/scripts\/postinstall\.js/,
    "the upstream postinstall fetches GitHub API metadata and fails on Railway's shared egress"
  );

  assert.match(
    dockerfile,
    /ENV OMNIROUTE_TLS_CLIENT_NATIVE_LIBRARY_PATH=\/app\/native\/tls-client\//,
    "the runtime must use a native library baked outside /app/data because Railway mounts " +
      "the persistent volume over /app/data only when the container starts"
  );

  assert.match(
    dockerfile,
    /chown -R root:root \/app\/native\/tls-client[\s\\]*&& chmod 0555 \/app\/native\/tls-client[\s\\]*&& chmod 0555 \/app\/native\/tls-client\/libtls-client\.so/,
    "the verified native library must remain root-owned and read-only at runtime"
  );

  assert.match(
    postinstall,
    /fixTlsClientNodeBinary/,
    "npm packaging must continue copying the native binary into standalone artifacts"
  );
});
