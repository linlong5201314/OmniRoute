/**
 * Embedded proxy core manager (mihomo).
 *
 * Problem: proxy subscriptions whose nodes are SS/VMess/VLESS/Trojan/… cannot
 * be used by OmniRoute's dispatcher directly — they need a proxy core doing the
 * protocol translation. The subscription feature binds the operator-supplied
 * `localCoreEndpoint` (loopback-only, SSRF gate) as the egress, but on cloud
 * deployments (Railway/VPS containers) nothing listens on that loopback port,
 * so every request fails "[Proxy Fast-Fail] Proxy unreachable".
 *
 * This module closes that gap: it downloads a pinned, SHA-256-verified mihomo
 * binary (cached under DATA_DIR so the persistent volume reuses it across
 * deploys), generates a config that consumes the operator's subscription URLs
 * natively via mihomo `proxy-providers` (full credentials, per-node health
 * checks, url-test auto-selection of the fastest healthy node), and supervises
 * the process (crash-restart with backoff). The mixed listener binds to the
 * loopback port the operator configured in `localCoreEndpoint` (default 2080),
 * so the existing subscription wiring starts working with zero config changes.
 *
 * Lifecycle:
 *   - boot: `startProxyCore()` from instrumentation-node (non-fatal)
 *   - subscription sync: `refreshProxyCore()` regenerates the config and
 *     restarts the core when it changed
 *   - shutdown: `stopProxyCore()` from gracefulShutdown
 *
 * Env:
 *   - PROXY_CORE_ENABLED=true|false|auto (default auto: start only when an
 *     enabled subscription actually needs the core)
 *   - PROXY_CORE_PORT=<port> override the listener port (default: the port of
 *     the subscriptions' localCoreEndpoint, else 2080)
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { DATA_DIR } from "@/lib/db/core";
import {
  listSubscriptions,
  type ProxySubscriptionRecord,
} from "@/lib/proxySubscription/subscriptionService";
import { buildMihomoConfig, CORE_MIXED_PORT, type CoreSubscription } from "./config";
import { resolveMihomoAsset, mihomoAssetUrl, MIHOMO_VERSION } from "./assets";

const LOG_TAG = "[ProxyCore]";

/** Protocols that require a core (mirror of parse.ts NEEDS_CORE_PROTOCOLS). */
const NEEDS_CORE_PROTOCOLS = new Set([
  "ss",
  "ssr",
  "vmess",
  "vless",
  "trojan",
  "tuic",
  "hysteria",
  "hysteria2",
  "wireguard",
  "snell",
]);

const DOWNLOAD_TIMEOUT_MS = 180_000;
const STOP_GRACE_MS = 3_000;
const MAX_CONSECUTIVE_FAST_CRASHES = 5;
/** A run longer than this counts as "stable" and resets the crash counter. */
const STABLE_UPTIME_MS = 60_000;
const BACKOFF_BASE_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;

interface CoreRuntime {
  child: ChildProcess;
  startedAt: number;
  stopping: boolean;
  /** True once the mixed port completed a SOCKS5 handshake (real readiness). */
  ready: boolean;
}

let runtime: CoreRuntime | null = null;
let restartTimer: ReturnType<typeof setTimeout> | null = null;
let consecutiveCrashes = 0;
let gaveUp = false;
let currentConfigYaml: string | null = null;
let currentPort = CORE_MIXED_PORT;
let startInFlight: Promise<void> | null = null;
/** Ring buffer of the last mihomo provider errors (for status/diagnostics). */
const providerErrors: Array<{ at: string; message: string }> = [];

function coreDir(): string {
  return path.join(DATA_DIR, "proxy-core");
}

function binaryPath(): string {
  return path.join(coreDir(), `mihomo-${MIHOMO_VERSION}`);
}

function configPath(): string {
  return path.join(coreDir(), "config.yaml");
}

function versionMarkerPath(): string {
  return path.join(coreDir(), "version.txt");
}

function log(msg: string): void {
  console.log(`${LOG_TAG} ${msg}`);
}

function warn(msg: string): void {
  console.warn(`${LOG_TAG} ${msg}`);
}

function isEnabledByEnv(): boolean {
  const v = (process.env.PROXY_CORE_ENABLED ?? "auto").trim().toLowerCase();
  if (v === "true" || v === "1" || v === "on") return true;
  if (v === "false" || v === "0" || v === "off") return false;
  // "auto": never download/spawn the binary under the test runner — a unit
  // test syncing a needs-core subscription must not hit the network.
  if (process.env.NODE_ENV === "test") return false;
  return true; // caller decides based on subscriptions
}

/** Whether a subscription's stored node summary contains core-requiring nodes. */
function subscriptionNeedsCore(sub: ProxySubscriptionRecord): boolean {
  const nodes = sub.lastNodes;
  if (!Array.isArray(nodes)) {
    // Never synced yet — trust the operator's intent: a configured loopback
    // core endpoint means they expect the core to run.
    return Boolean(sub.localCoreEndpoint);
  }
  return nodes.some((n) => {
    const proto = (n as { rawProtocol?: unknown })?.rawProtocol;
    return typeof proto === "string" && NEEDS_CORE_PROTOCOLS.has(proto);
  });
}

/** The loopback port the operator wants the core to listen on. */
function resolveCorePort(subs: ProxySubscriptionRecord[]): number {
  const envPort = Number(process.env.PROXY_CORE_PORT);
  if (Number.isInteger(envPort) && envPort > 0 && envPort <= 65535) return envPort;
  for (const sub of subs) {
    if (!sub.localCoreEndpoint) continue;
    try {
      const port = Number(new URL(sub.localCoreEndpoint).port);
      if (Number.isInteger(port) && port > 0) return port;
    } catch {
      // keep looking
    }
  }
  return CORE_MIXED_PORT;
}

/** Enabled subscriptions that should feed the core (as mihomo proxy-providers). */
async function collectCoreSubscriptions(): Promise<CoreSubscription[]> {
  const subs = await listSubscriptions();
  return subs
    .filter((s) => s.enabled && subscriptionNeedsCore(s))
    .map((s) => ({ id: s.id, name: s.name, url: s.url }));
}

/**
 * The container's own nameservers, read from /etc/resolv.conf — the exact
 * resolvers the Node process resolves through successfully (deploy log
 * 2026-08-17: Node fetched the mihomo binary from GitHub while mihomo's own
 * DNS died with "ip version error"). Injecting them first into every mihomo
 * DNS list makes the core resolve exactly like the app around it. Cached for
 * the process lifetime; returns [] where no resolv.conf exists (Windows dev).
 */
let platformNameserversCache: string[] | null = null;

function readPlatformNameservers(): string[] {
  if (platformNameserversCache) return platformNameserversCache;
  const found: string[] = [];
  try {
    const text = fs.readFileSync("/etc/resolv.conf", "utf8");
    for (const line of text.split("\n")) {
      const match = /^\s*nameserver\s+(\S+)/.exec(line);
      if (match && net.isIP(match[1]) > 0) found.push(match[1]);
      if (found.length >= 3) break;
    }
  } catch {
    // no resolv.conf (Windows) — the config falls back to public resolvers
  }
  platformNameserversCache = found;
  if (found.length > 0) log(`platform nameservers from /etc/resolv.conf: ${found.join(", ")}`);
  return found;
}

// ─────────────────────────── Binary management ───────────────────────────

async function sha256OfFile(file: string): Promise<string> {
  const buf = await fsp.readFile(file);
  return createHash("sha256").update(buf).digest("hex");
}

/**
 * Ensure the pinned mihomo binary exists under DATA_DIR (persistent volume →
 * no re-download across deploys). Downloads + gunzips + verifies the official
 * SHA-256 digest; a digest mismatch aborts (supply-chain guard).
 */
async function ensureBinary(): Promise<string> {
  const asset = resolveMihomoAsset(process.platform, process.arch);
  if (!asset) {
    throw new Error(
      `no pinned mihomo asset for ${process.platform}-${process.arch} (embedded core supports linux/darwin x64/arm64)`
    );
  }

  const bin = binaryPath();
  // Cache hit: binary + version marker both present.
  if (fs.existsSync(bin) && fs.existsSync(versionMarkerPath())) {
    const marker = await fsp.readFile(versionMarkerPath(), "utf8").catch(() => "");
    if (marker.trim() === MIHOMO_VERSION && (await fsp.stat(bin)).size > 1_000_000) {
      return bin;
    }
  }

  await fsp.mkdir(coreDir(), { recursive: true });
  const url = mihomoAssetUrl(asset);
  log(`downloading mihomo ${MIHOMO_VERSION} (${asset.fileName})…`);

  const res = await fetch(url, {
    redirect: "follow",
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`mihomo download failed: HTTP ${res.status}`);
  const compressed = Buffer.from(await res.arrayBuffer());

  const digest = createHash("sha256").update(compressed).digest("hex");
  if (digest !== asset.sha256) {
    throw new Error(
      `mihomo download SHA-256 mismatch (expected ${asset.sha256}, got ${digest}) — refusing to use it`
    );
  }

  const binary = gunzipSync(compressed);
  const tmp = `${bin}.tmp`;
  await fsp.writeFile(tmp, binary);
  await fsp.chmod(tmp, 0o755);
  await fsp.rename(tmp, bin);
  await fsp.writeFile(versionMarkerPath(), MIHOMO_VERSION, "utf8");
  log(`mihomo ${MIHOMO_VERSION} installed at ${bin} (${binary.length} bytes, sha256 verified)`);
  return bin;
}

// ─────────────────────────── Process supervision ───────────────────────────

function isPortListening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port, timeout: 1500 });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
    socket.once("timeout", () => {
      socket.destroy();
      resolve(false);
    });
  });
}

/**
 * True SOCKS5 readiness check: complete the no-auth method negotiation
 * (\x05\x01\x00 → \x05\x00). A bare TCP connect (fast-fail probe) succeeds the
 * instant mihomo binds the port — while providers may still be loading and the
 * PROXY group is empty. The handshake proves the SOCKS endpoint actually
 * answers, and the poll loop gives providers time to load before we declare
 * the core "starting".
 */
function socks5Handshake(port: number, timeoutMs = 2000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port, timeout: timeoutMs });
    let done = false;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve(ok);
    };
    socket.once("connect", () => {
      socket.write(Buffer.from([0x05, 0x01, 0x00]));
    });
    socket.once("data", (chunk: Buffer) => {
      finish(chunk.length >= 2 && chunk[0] === 0x05);
    });
    socket.once("error", () => finish(false));
    socket.once("timeout", () => finish(false));
  });
}

/** Poll the mixed port until the SOCKS5 handshake succeeds (or timeout). */
async function waitForCoreReady(child: ChildProcess, port: number): Promise<void> {
  const deadline = Date.now() + 60_000;
  log(`waiting for the mixed listener to accept SOCKS5 on 127.0.0.1:${port}…`);
  while (Date.now() < deadline) {
    if (runtime?.child !== child) return; // restarted/stopped under us
    if (await socks5Handshake(port)) {
      if (runtime?.child === child) runtime.ready = true;
      log(`ready — SOCKS5 handshake OK on 127.0.0.1:${port}`);
      return;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  warn(
    `core did not complete a SOCKS5 handshake within 60s on port ${port} — requests may fail while it is still starting`
  );
}

function spawnCore(bin: string, port: number): void {
  let child: ChildProcess;
  try {
    child = spawn(bin, ["-d", coreDir()], {
      cwd: coreDir(),
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, HOME: process.env.HOME || coreDir() },
    });
  } catch (err) {
    // Windows can throw synchronously on spawn of a non-executable file.
    handleCrash(err instanceof Error ? err : new Error(String(err)), Date.now());
    return;
  }

  runtime = { child, startedAt: Date.now(), stopping: false, ready: false };

  const pipeLines = (stream: NodeJS.ReadableStream, level: "out" | "err") => {
    let buffer = "";
    stream.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        console.log(`${LOG_TAG} [mihomo:${level}] ${trimmed.slice(0, 500)}`);
        // Provider fetch failures decide whether the PROXY group ever gets
        // nodes; dial-level DNS failures ("ip version error") were the root
        // cause of the 2026-08-17 Railway outage — keep the last few of both
        // for the status endpoint/diagnostics.
        if (
          /provider .*(error|failed)/i.test(trimmed) ||
          /initial proxy provider .* error/i.test(trimmed) ||
          /dns resolve failed/i.test(trimmed)
        ) {
          providerErrors.push({
            at: new Date().toISOString(),
            message: trimmed.slice(0, 300),
          });
          if (providerErrors.length > 10) providerErrors.shift();
        }
      }
    });
  };
  if (child.stdout) pipeLines(child.stdout, "out");
  if (child.stderr) pipeLines(child.stderr, "err");

  child.once("error", (err) => {
    if (runtime?.child === child) handleCrash(err, runtime.startedAt);
  });

  child.once("exit", (code, signal) => {
    if (runtime?.child !== child) return;
    const wasStopping = runtime.stopping;
    const startedAt = runtime.startedAt;
    runtime = null;
    if (wasStopping) return;
    handleCrash(
      new Error(`mihomo exited unexpectedly (code=${code ?? "null"}, signal=${signal ?? "null"})`),
      startedAt
    );
  });

  log(`mihomo started (pid ${child.pid ?? "?"}, mixed listener 127.0.0.1:${port})`);
  void waitForCoreReady(child, port);
}

function handleCrash(err: Error, startedAt: number): void {
  runtime = null;
  if (gaveUp) return;

  const uptime = Date.now() - startedAt;
  // A long-lived run means the crash is not part of a fast-crash loop.
  if (uptime >= STABLE_UPTIME_MS) consecutiveCrashes = 0;
  consecutiveCrashes += 1;

  if (consecutiveCrashes > MAX_CONSECUTIVE_FAST_CRASHES) {
    gaveUp = true;
    warn(
      `mihomo crashed ${consecutiveCrashes} times in a row — giving up until next config refresh/restart. Last error: ${err.message}`
    );
    return;
  }

  const backoff = Math.min(BACKOFF_BASE_MS * 2 ** (consecutiveCrashes - 1), BACKOFF_MAX_MS);
  warn(
    `mihomo crashed (${err.message}); restarting in ${backoff}ms (attempt ${consecutiveCrashes})`
  );
  if (restartTimer) clearTimeout(restartTimer);
  restartTimer = setTimeout(() => {
    restartTimer = null;
    void launchWithConfig(currentConfigYaml, currentPort);
  }, backoff);
  restartTimer.unref?.();
}

async function launchWithConfig(configYaml: string | null, port: number): Promise<void> {
  if (!configYaml) return;
  if (runtime) return; // already running

  let bin: string;
  try {
    bin = await ensureBinary();
  } catch (err) {
    warn(`cannot prepare mihomo binary: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  await fsp.mkdir(path.join(coreDir(), "providers"), { recursive: true });
  await fsp.writeFile(configPath(), configYaml, "utf8");
  currentConfigYaml = configYaml;
  currentPort = port;
  spawnCore(bin, port);
}

// ─────────────────────────── Public API ───────────────────────────

/**
 * Start the embedded core if any enabled subscription needs it. Idempotent and
 * serialized — concurrent callers (boot + sync) never double-spawn.
 */
export async function startProxyCore(): Promise<void> {
  if (!isEnabledByEnv()) {
    return;
  }
  if (startInFlight) return startInFlight;
  startInFlight = (async () => {
    try {
      const subs = await collectCoreSubscriptions();
      if (subs.length === 0) {
        return; // nothing needs the core — stay out of the way
      }
      const port = resolveCorePort(await listSubscriptions());
      const configYaml = buildMihomoConfig(subs, port, readPlatformNameservers());
      if (!configYaml) return;

      if (runtime) {
        // Already running — apply config refresh instead.
        await applyConfig(configYaml, port);
        return;
      }

      if (await isPortListening(port)) {
        // Something already serves the core port (operator's own core, e.g. a
        // desktop install) — adopt it instead of fighting over the port.
        log(
          `port ${port} already has a listener — assuming an external core, not starting the embedded one`
        );
        return;
      }

      gaveUp = false;
      consecutiveCrashes = 0;
      await launchWithConfig(configYaml, port);
    } finally {
      startInFlight = null;
    }
  })();
  return startInFlight;
}

/**
 * Regenerate the core config from current subscriptions; start, restart, or
 * stop the core as needed. Called after every subscription sync.
 */
export async function refreshProxyCore(): Promise<void> {
  if (!isEnabledByEnv()) return;
  try {
    const subs = await collectCoreSubscriptions();
    const port = resolveCorePort(await listSubscriptions());
    const configYaml = buildMihomoConfig(subs, port, readPlatformNameservers());

    if (!configYaml) {
      // No subscription needs the core anymore — stop it.
      if (runtime) await stopProxyCore();
      currentConfigYaml = null;
      return;
    }

    if (!runtime) {
      gaveUp = false;
      consecutiveCrashes = 0;
      if (await isPortListening(port)) {
        log(
          `port ${port} already has a listener — assuming an external core, skipping embedded start`
        );
        return;
      }
      await launchWithConfig(configYaml, port);
      return;
    }

    await applyConfig(configYaml, port);
  } catch (err) {
    warn(`refresh failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Restart the core when the config or port changed; no-op otherwise. */
async function applyConfig(configYaml: string, port: number): Promise<void> {
  if (configYaml === currentConfigYaml && port === currentPort && runtime) return;
  log("subscription set changed — restarting mihomo with the new config");
  await stopProxyCore();
  gaveUp = false;
  consecutiveCrashes = 0;
  await launchWithConfig(configYaml, port);
}

/** Stop the core gracefully (SIGTERM → SIGKILL after a short grace period). */
export async function stopProxyCore(): Promise<void> {
  if (restartTimer) {
    clearTimeout(restartTimer);
    restartTimer = null;
  }
  const rt = runtime;
  if (!rt) return;
  runtime = null;
  rt.stopping = true;

  await new Promise<void>((resolve) => {
    const child = rt.child;
    if (!child.pid) {
      resolve();
      return;
    }
    const killTimer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // already gone
      }
    }, STOP_GRACE_MS);
    killTimer.unref?.();
    child.once("exit", () => {
      clearTimeout(killTimer);
      resolve();
    });
    try {
      child.kill("SIGTERM");
    } catch {
      clearTimeout(killTimer);
      resolve();
    }
  });
  log("mihomo stopped");
}

/** Status snapshot (for diagnostics/tests and the dashboard status card). */
export function getProxyCoreStatus(): {
  running: boolean;
  ready: boolean;
  pid: number | null;
  port: number;
  version: string;
  gaveUp: boolean;
  providerErrors: Array<{ at: string; message: string }>;
} {
  return {
    running: runtime !== null,
    ready: runtime?.ready ?? false,
    pid: runtime?.child.pid ?? null,
    port: currentPort,
    version: MIHOMO_VERSION,
    gaveUp,
    providerErrors: [...providerErrors],
  };
}
