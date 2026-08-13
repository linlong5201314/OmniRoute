/**
 * Railway's Metal builder requires every explicit BuildKit cache mount ID to
 * contain a hard-coded Railway service ID. This repository's root Dockerfile
 * is shared by every deployment, so it cannot safely embed one service ID.
 * Keep the generic image build portable by avoiding cache mounts in this file.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import test from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const dockerfile = fs.readFileSync(path.join(repoRoot, "Dockerfile"), "utf-8");
const railwayConfig = JSON.parse(fs.readFileSync(path.join(repoRoot, "railway.json"), "utf-8")) as {
  deploy?: { healthcheckPath?: string; startCommand?: string };
};
const railwayGuide = fs.readFileSync(
  path.join(repoRoot, "docs", "ops", "RAILWAY_DEPLOYMENT_GUIDE.md"),
  "utf-8"
);

test("root Dockerfile avoids service-specific cache mounts for Railway Metal", () => {
  const cacheMounts = [...dockerfile.matchAll(/--mount=type=cache(?:,|\s)/g)];

  assert.deepEqual(
    cacheMounts,
    [],
    "the shared Dockerfile must not use cache mounts because Railway requires a hard-coded " +
      "service ID in each cache mount; keep cache mounts in service-specific Dockerfiles only"
  );
});

test("Railway deployment guide has the MDX frontmatter required by the docs build", () => {
  assert.match(
    railwayGuide,
    /^---\r?\ntitle:\s*"[^"]+"\r?\nversion:\s*\S+\r?\nlastUpdated:\s*\d{4}-\d{2}-\d{2}\r?\n---\r?\n/,
    "docs imported by the dashboard must define title, version, and lastUpdated frontmatter"
  );
});

test("Railway deployment guide uses Shiki-supported dotenv fences for env examples", () => {
  const envFenceLines = railwayGuide
    .split(/\r?\n/)
    .map((line, index) => ({ line, lineNumber: index + 1 }))
    .filter(({ line }) => /^```env\s*$/.test(line));

  assert.deepEqual(
    envFenceLines,
    [],
    "Shiki does not support the `env` language; use `dotenv` for environment examples"
  );
});

test("Railway healthcheck uses process liveness instead of SQLite readiness", () => {
  assert.equal(
    railwayConfig.deploy?.healthcheckPath,
    "/api/health/live",
    "Railway should only require the HTTP process to be live; DB readiness remains on /api/health/ping"
  );
  assert.match(railwayGuide, /\/api\/health\/live/);
  assert.match(railwayGuide, /\/api\/health\/ping/);
});

test("Railway starts the standalone bundle from its shipped dev directory", () => {
  const expectedCommand = "/app/check-permissions.sh node /app/dev/run-standalone.mjs";

  assert.equal(
    railwayConfig.deploy?.startCommand,
    expectedCommand,
    "Railway must preserve the image entrypoint checks and avoid the stale root launcher path"
  );
  assert.match(
    dockerfile,
    /CMD \["node", "\/app\/dev\/run-standalone\.mjs"\]/,
    "the image CMD should use the same absolute standalone entrypoint"
  );
});

test("Docker preserves a working legacy root standalone compatibility entrypoint", () => {
  const compatibilitySource = path.join(repoRoot, "scripts", "build", "railwayStartCompat.mjs");

  assert.ok(
    fs.existsSync(compatibilitySource),
    "the image needs a root compatibility entrypoint while Railway retains an old start override"
  );
  assert.match(
    dockerfile,
    /COPY --from=builder \/app\/scripts\/build\/railwayStartCompat\.mjs \.\/run-standalone\.mjs/,
    "the compatibility entrypoint must be present at /app/run-standalone.mjs"
  );

  const compatibilityModule = fs.readFileSync(compatibilitySource, "utf-8");
  assert.match(
    compatibilityModule,
    /import\("\.\/dev\/run-standalone\.mjs"\)/,
    "the legacy root entrypoint must delegate to the shipped standalone launcher"
  );

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "railway-start-compat-"));
  try {
    fs.mkdirSync(path.join(tempRoot, "dev"), { recursive: true });
    fs.copyFileSync(compatibilitySource, path.join(tempRoot, "run-standalone.mjs"));
    fs.writeFileSync(
      path.join(tempRoot, "dev", "run-standalone.mjs"),
      'process.stdout.write("compat-entrypoint-ok");\n',
      "utf-8"
    );

    const smoke = spawnSync(process.execPath, [path.join(tempRoot, "run-standalone.mjs")], {
      encoding: "utf-8",
    });
    assert.equal(smoke.status, 0, smoke.stderr);
    assert.equal(smoke.stdout, "compat-entrypoint-ok");
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
