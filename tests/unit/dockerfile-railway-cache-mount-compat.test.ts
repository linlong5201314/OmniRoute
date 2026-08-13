/**
 * Railway's Metal builder requires every explicit BuildKit cache mount ID to
 * contain a hard-coded Railway service ID. This repository's root Dockerfile
 * is shared by every deployment, so it cannot safely embed one service ID.
 * Keep the generic image build portable by avoiding cache mounts in this file.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const dockerfile = fs.readFileSync(path.join(repoRoot, "Dockerfile"), "utf-8");
const railwayConfig = JSON.parse(fs.readFileSync(path.join(repoRoot, "railway.json"), "utf-8")) as {
  deploy?: { healthcheckPath?: string };
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
