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

test("root Dockerfile avoids service-specific cache mounts for Railway Metal", () => {
  const cacheMounts = [...dockerfile.matchAll(/--mount=type=cache(?:,|\s)/g)];

  assert.deepEqual(
    cacheMounts,
    [],
    "the shared Dockerfile must not use cache mounts because Railway requires a hard-coded " +
      "service ID in each cache mount; keep cache mounts in service-specific Dockerfiles only"
  );
});
