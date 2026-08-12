import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizeCatalogCacheArgs,
  startCatalogBackgroundRefresh,
  type CatalogCachePolicy,
} from "../../src/app/api/v1/models/catalogCachePolicy.ts";

function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

test("normalizes old catalog settings and new settings-plus-policy argument orders", () => {
  const policy: CatalogCachePolicy = {
    getStaleWhileRevalidateMs: () => 123,
  };

  assert.deepEqual(normalizeCatalogCacheArgs({ hideAutoCombos: true }), {
    catalogSettings: { hideAutoCombos: true },
    policy: {},
  });
  assert.deepEqual(normalizeCatalogCacheArgs({ hideNoThinkVariants: true }, policy), {
    catalogSettings: { hideNoThinkVariants: true },
    policy,
  });
  assert.deepEqual(normalizeCatalogCacheArgs(policy, { hideAutoCombos: true }), {
    catalogSettings: { hideAutoCombos: true },
    policy,
  });
});

test("synchronous refresh scheduler completes a registered in-flight promise", async () => {
  const inFlight = new Map<string, { generation: number; promise: Promise<string> }>();
  let refreshes = 0;

  const promise = startCatalogBackgroundRefresh({
    cacheKey: "catalog",
    generation: 1,
    inFlight,
    isCurrentGeneration: (generation) => generation === 1,
    runRefresh: async () => {
      refreshes++;
      return "fresh";
    },
    policy: {
      scheduleBackgroundRefresh: (task) => {
        void task();
      },
    },
    defaultScheduler: (task) => {
      void task();
    },
  });

  assert.equal(await promise, "fresh");
  await tick();
  assert.equal(refreshes, 1);
  assert.equal(inFlight.size, 0);
});

test("throwing scheduler rejects and cleans in-flight without throwing to stale caller", async () => {
  const inFlight = new Map<string, { generation: number; promise: Promise<string> }>();
  const schedulerError = new Error("scheduler failed");

  const promise = startCatalogBackgroundRefresh({
    cacheKey: "catalog",
    generation: 1,
    inFlight,
    isCurrentGeneration: (generation) => generation === 1,
    runRefresh: async () => "unused",
    policy: {
      scheduleBackgroundRefresh: () => {
        throw schedulerError;
      },
    },
    defaultScheduler: (task) => {
      void task();
    },
  });

  await assert.rejects(promise, schedulerError);
  await tick();
  assert.equal(inFlight.size, 0);
});

test("cleanup after scheduler failure permits the next refresh for the same key", async () => {
  const inFlight = new Map<string, { generation: number; promise: Promise<string> }>();

  await assert.rejects(
    startCatalogBackgroundRefresh({
      cacheKey: "catalog",
      generation: 1,
      inFlight,
      isCurrentGeneration: (generation) => generation === 1,
      runRefresh: async () => "unused",
      policy: {
        scheduleBackgroundRefresh: () => {
          throw new Error("scheduler failed");
        },
      },
      defaultScheduler: (task) => {
        void task();
      },
    })
  );
  await tick();

  const second = startCatalogBackgroundRefresh({
    cacheKey: "catalog",
    generation: 1,
    inFlight,
    isCurrentGeneration: (generation) => generation === 1,
    runRefresh: async () => "fresh",
    policy: {
      scheduleBackgroundRefresh: (task) => {
        void task();
      },
    },
    defaultScheduler: (task) => {
      void task();
    },
  });

  assert.equal(await second, "fresh");
  await tick();
  assert.equal(inFlight.size, 0);
});
