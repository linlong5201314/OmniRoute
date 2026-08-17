/**
 * Free-tier effort variants for "OpenCode Free" / opencode-zen.
 *
 * `deepseek-v4-flash-free` is the free-tier DeepSeek Flash model, and clients
 * (the operator's opencode CLI config) also address its reasoning tiers as
 * `deepseek-v4-flash-free-high` / `deepseek-v4-flash-free-max`. Before this
 * change those ids were unregistered (model resolution failure) and — worse —
 * classified as PREMIUM by the keyless gate (they do not end in "-free" and
 * were absent from the free-model set), so a keyless connection got 402
 * premium_model_requires_key instead of a completion.
 *
 * Pinned contract:
 *  1. Registry exposure on BOTH the noauth `opencode` tier and `opencode-zen`.
 *  2. parseEffortLevel resolves the variants to base + effort.
 *  3. transformRequest rewrites the body to the base model + reasoning_effort.
 *  4. The keyless gate classifies the variants as FREE (no 402).
 */

import test from "node:test";
import assert from "node:assert/strict";

const { parseEffortLevel, OpencodeExecutor } =
  (await import("../../open-sse/executors/opencode.ts")) as {
    parseEffortLevel: (model: string) => { baseModel: string; effort: string } | null;
    OpencodeExecutor: {
      isPremiumModel: (model: string, provider: string) => boolean;
      new (provider: string): {
        transformRequest: (
          model: string,
          body: Record<string, unknown>,
          stream: boolean,
          credentials: unknown
        ) => Record<string, unknown>;
      };
    };
  };

const { REGISTRY } = (await import("../../open-sse/config/providerRegistry.ts")) as {
  REGISTRY: Record<string, { models?: Array<{ id: string }> }>;
};

const VARIANTS = ["deepseek-v4-flash-free-high", "deepseek-v4-flash-free-max"] as const;

// ─── Registry exposure ─────────────────────────────────────────────────────
test("opencode (noauth free tier) registry exposes the free-flash effort variants", () => {
  const ids = (REGISTRY["opencode"]?.models ?? []).map((m) => m.id);
  for (const v of VARIANTS) assert.ok(ids.includes(v), `${v} missing from opencode registry`);
});

test("opencode-zen registry exposes the free-flash effort variants", () => {
  const ids = (REGISTRY["opencode-zen"]?.models ?? []).map((m) => m.id);
  for (const v of VARIANTS) assert.ok(ids.includes(v), `${v} missing from opencode-zen registry`);
});

// ─── Effort alias resolution ───────────────────────────────────────────────
test("parseEffortLevel resolves free-flash effort variants to base + effort", () => {
  assert.deepStrictEqual(parseEffortLevel("deepseek-v4-flash-free-high"), {
    baseModel: "deepseek-v4-flash-free",
    effort: "high",
  });
  assert.deepStrictEqual(parseEffortLevel("deepseek-v4-flash-free-max"), {
    baseModel: "deepseek-v4-flash-free",
    effort: "max",
  });
});

test("transformRequest rewrites free-flash variants to the base model + reasoning_effort", () => {
  const exec = new OpencodeExecutor("opencode-zen");
  const body = {
    model: "deepseek-v4-flash-free-max",
    messages: [{ role: "user", content: "hi" }],
  };
  const out = exec.transformRequest("deepseek-v4-flash-free-max", body, false, {
    apiKey: null,
  } as never);
  assert.equal(out.model, "deepseek-v4-flash-free");
  assert.equal(out.reasoning_effort, "max");
});

// ─── Keyless gate ──────────────────────────────────────────────────────────
test("keyless gate treats free-flash effort variants as FREE (no 402 premium gate)", () => {
  assert.equal(OpencodeExecutor.isPremiumModel("deepseek-v4-flash-free-high", "opencode"), false);
  assert.equal(OpencodeExecutor.isPremiumModel("deepseek-v4-flash-free-max", "opencode"), false);
  assert.equal(
    OpencodeExecutor.isPremiumModel("deepseek-v4-flash-free-max", "opencode-zen"),
    false
  );
  // Base free model and paid flash stay classified as before.
  assert.equal(OpencodeExecutor.isPremiumModel("deepseek-v4-flash-free", "opencode"), false);
  assert.equal(OpencodeExecutor.isPremiumModel("deepseek-v4-flash", "opencode-zen"), true);
});
