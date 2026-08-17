import { describe, it, beforeEach, afterEach, before, after } from "node:test";
import assert from "node:assert";
import net from "node:net";
import { OpencodeExecutor } from "../../open-sse/executors/opencode.ts";
import type { ProviderCredentials } from "../../open-sse/executors/base.ts";
import { resolveProxyForRequest } from "../../open-sse/utils/proxyFetch.ts";

/**
 * Proxy-stability rotation for "OpenCode Free" accounts.
 *
 * #4954 pinned rotation on HTTP 429 responses, but a per-account proxy that is
 * dead/unreachable makes BaseExecutor's dispatch THROW (PROXY_UNREACHABLE /
 * fetch network error — `skipUpstreamRetry` prevents intra-URL fallback, so the
 * error escapes `super.execute()`). The rotation loop had no try/catch, so one
 * dead proxy failed the WHOLE request instead of rotating to the next account —
 * the unstable-proxy scenario the per-account pool exists to survive.
 *
 * These tests pin the fixed contract:
 *   1. A dispatch error on account A rotates to account B (and its proxy).
 *   2. The errored account enters cooldown — the NEXT request skips it.
 *   3. When EVERY account errors, the last error propagates (fail-closed: no
 *      silent direct-egress fallback that would leak the operator IP and hit
 *      the very per-IP rate limits the proxy pool dodges).
 */

const log = { debug() {}, info() {}, warn() {}, error() {} };

const ACCOUNT_A = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const ACCOUNT_B = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

let serverA: net.Server;
let serverB: net.Server;
let portA = 0;
let portB = 0;

function listen(server: net.Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve((server.address() as net.AddressInfo).port);
    });
  });
}

before(async () => {
  serverA = net.createServer((s) => s.destroy());
  serverB = net.createServer((s) => s.destroy());
  portA = await listen(serverA);
  portB = await listen(serverB);
});

after(() => {
  serverA?.close();
  serverB?.close();
});

function credentialsWithProxies() {
  return {
    apiKey: null,
    accessToken: null,
    connectionId: "noauth",
    providerSpecificData: {
      fingerprints: [ACCOUNT_A, ACCOUNT_B],
      accountProxies: [
        { fingerprint: ACCOUNT_A, proxy: { type: "http", host: "127.0.0.1", port: portA } },
        { fingerprint: ACCOUNT_B, proxy: { type: "http", host: "127.0.0.1", port: portB } },
      ],
    },
  } as unknown as ProviderCredentials;
}

function executeInput() {
  return {
    model: "deepseek-v4-flash-free",
    body: { messages: [{ role: "user", content: "hi" }], stream: false },
    stream: false,
    signal: null,
    credentials: credentialsWithProxies(),
    log,
  };
}

describe("OpencodeExecutor proxy-error rotation (stability)", () => {
  let originalFetch: typeof globalThis.fetch;
  let observed: string[];

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    observed = [];
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  /**
   * Fetch stub whose behavior is decided per-call by `behavior(callIdx)` —
   * either "throw" (network error), "unreachable" (PROXY_UNREACHABLE), or an
   * HTTP status. Records the proxy port each dispatch resolved to so tests can
   * assert the egress path.
   */
  function installFetchStub(behavior: (callIdx: number) => "throw" | "unreachable" | number) {
    let call = 0;
    globalThis.fetch = (async (input: unknown) => {
      const url =
        typeof input === "string" ? input : ((input as { url?: string })?.url ?? String(input));
      const resolved = resolveProxyForRequest(url);
      let port: string | null = null;
      try {
        if (resolved.proxyUrl) port = new URL(resolved.proxyUrl).port;
      } catch {
        port = null;
      }
      observed.push(`${port ?? "direct"}`);
      const action = behavior(call);
      call++;
      if (action === "throw") {
        throw Object.assign(new Error("connect ECONNREFUSED 127.0.0.1"), {
          code: "ECONNREFUSED",
        });
      }
      if (action === "unreachable") {
        throw Object.assign(new Error("[Proxy Fast-Fail] Proxy unreachable"), {
          code: "PROXY_UNREACHABLE",
        });
      }
      return new Response(JSON.stringify({ ok: action === 200 }), {
        status: action,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof globalThis.fetch;
  }

  it("rotates to the next account when the current account's proxy dispatch throws", async () => {
    const exec = new OpencodeExecutor("opencode-zen");
    // account A dispatch → network error; account B dispatch → 200
    installFetchStub((i) => (i === 0 ? "throw" : 200));

    const result = await exec.execute(executeInput());

    assert.strictEqual(
      (result as { response: Response }).response.status,
      200,
      "should succeed via account B"
    );
    assert.ok(observed.length >= 2, `expected a rotation, dispatches=${JSON.stringify(observed)}`);
    assert.notStrictEqual(
      observed[0],
      observed[1],
      `rotation must switch proxy port, dispatches=${JSON.stringify(observed)}`
    );
  });

  it("puts the errored account on cooldown so the next request skips it", async () => {
    const exec = new OpencodeExecutor("opencode-zen");
    // Only the FIRST dispatch ever throws; everything after returns 200.
    installFetchStub((i) => (i === 0 ? "throw" : 200));

    await exec.execute(executeInput()); // A errors → B succeeds; A now cooling

    observed = [];
    await exec.execute(executeInput()); // A still in cooldown → must start on B

    assert.strictEqual(
      observed.length,
      1,
      `cooldown must skip account A, dispatches=${JSON.stringify(observed)}`
    );
    assert.strictEqual(observed[0], String(portB), "second request must dispatch via B's proxy");
  });

  it("propagates the last error when every account's proxy fails (no silent direct fallback)", async () => {
    const exec = new OpencodeExecutor("opencode-zen");
    installFetchStub(() => "throw");

    await assert.rejects(
      () => exec.execute(executeInput()),
      (err: unknown) => {
        const e = err as { code?: string; message?: string };
        return e?.code === "ECONNREFUSED" || /ECONNREFUSED/.test(String(e?.message));
      },
      "the network error must surface instead of a direct-egress fallback"
    );
  });

  it("fail-fasts on PROXY_UNREACHABLE when every account shares the same dead proxy", async () => {
    // Railway 2026-08-17: all 20 accounts egress through one global
    // socks5://127.0.0.1:2080 subscription proxy; when it is dead, the rotation
    // burned the entire pool (~5ms per account) and polluted every cooldown.
    const shared = {
      apiKey: null,
      accessToken: null,
      connectionId: "noauth",
      providerSpecificData: {
        fingerprints: [ACCOUNT_A, ACCOUNT_B],
        accountProxies: [
          { fingerprint: ACCOUNT_A, proxy: { type: "http", host: "127.0.0.1", port: portA } },
          { fingerprint: ACCOUNT_B, proxy: { type: "http", host: "127.0.0.1", port: portA } },
        ],
      },
    } as unknown as ProviderCredentials;

    const exec = new OpencodeExecutor("opencode-zen");
    installFetchStub(() => "unreachable");

    await assert.rejects(
      () => exec.execute({ ...executeInput(), credentials: shared }),
      (err: unknown) => {
        const e = err as { code?: string };
        return e?.code === "PROXY_UNREACHABLE";
      },
      "the proxy-level error must surface"
    );

    assert.equal(
      observed.length,
      1,
      `accounts sharing the dead proxy must be skipped after one dispatch, dispatches=${JSON.stringify(observed)}`
    );
  });

  it("still rotates on PROXY_UNREACHABLE when the next account has a different proxy", async () => {
    const exec = new OpencodeExecutor("opencode-zen");
    // A's proxy unreachable → B's proxy (different endpoint) answers 200.
    installFetchStub((i) => (i === 0 ? "unreachable" : 200));

    const result = await exec.execute(executeInput());

    assert.strictEqual((result as { response: Response }).response.status, 200);
    assert.equal(
      observed.length,
      2,
      `must dispatch exactly once per distinct proxy, dispatches=${JSON.stringify(observed)}`
    );
    assert.notStrictEqual(observed[0], observed[1], "the rotation must switch to B's proxy");
  });
});
