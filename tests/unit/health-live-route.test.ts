import test from "node:test";
import assert from "node:assert/strict";

const routeModule = await import("../../src/app/api/health/live/route.ts");

test("GET /api/health/live returns 200 without requiring the database", async () => {
  const res = await routeModule.GET();
  assert.equal(res.status, 200, "expected HTTP 200");

  const body = await res.json();
  assert.equal(body.status, "ok");
  assert.ok(typeof body.timestamp === "string", "timestamp must be a string");
  assert.ok(!Number.isNaN(Date.parse(body.timestamp)), "timestamp must be ISO parseable");
});

test("GET /api/health/live sets no-store cache headers", async () => {
  const res = await routeModule.GET();
  const cacheControl = res.headers.get("Cache-Control");
  assert.ok(cacheControl, "Cache-Control header must be set");
  assert.match(cacheControl, /no-store/i);
});
