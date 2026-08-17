/**
 * Configure OmniRoute's "OpenCode Free" (opencode) provider to egress through
 * the local mihomo per-account listeners managed by the deepseek-v4flash panel
 * (C:\Users\林龙\Desktop\deepseek\deepseek-v4flash).
 *
 * Mirrors the panel's proven architecture inside OmniRoute:
 *   - every mihomo listener port (7922+) becomes a proxy_registry entry
 *   - the `opencode` provider connection gets one fingerprint account per port
 *     with accountProxies referencing the pool (by proxyId)
 *   - accounts are ordered by MEASURED latency (fastest first) — "优先代理速度
 *     稳定的": rotation starts on the fastest node and the executor's cooldown
 *     (429 + network errors) skips unstable ones.
 *
 * Idempotent: proxies matched by host+port, connection matched by provider.
 * Usage: node scripts/ad-hoc/configure-opencode-mihomo.cjs [--dry-run]
 */
const fs = require("fs");
const path = require("path");
const net = require("net");
const crypto = require("crypto");
const Database = require("better-sqlite3");

const PANEL_DIR = "C:\\Users\\林龙\\Desktop\\deepseek\\deepseek-v4flash";
const ACCOUNTS_JSON = path.join(PANEL_DIR, "config", "accounts.json");
const DB_PATH = path.join(process.env.USERPROFILE || "", ".omniroute", "storage.sqlite");
const LATENCY_TEST_URL = "https://www.gstatic.com/generate_204"; // same target the panel's mihomo groups use
const LATENCY_TIMEOUT_MS = 6000;
const PROXY_HOST = "127.0.0.1";
const DRY_RUN = process.argv.includes("--dry-run");

function log(msg) {
  console.log(`[opencode-setup] ${msg}`);
}

// ── 1. Load panel accounts (source of truth for port↔node mapping) ─────────
const accountsRaw = JSON.parse(fs.readFileSync(ACCOUNTS_JSON, "utf8"));
const accounts = (accountsRaw.accounts || []).filter((a) => a.enabled !== false);
log(`panel accounts loaded: ${accounts.length}`);

// ── 2. TCP reachability check per port ──────────────────────────────────────
function checkPort(port) {
  return new Promise((resolve) => {
    const s = net.connect({ host: PROXY_HOST, port, timeout: 1200 });
    s.once("connect", () => {
      s.destroy();
      resolve(true);
    });
    s.once("error", () => resolve(false));
    s.once("timeout", () => {
      s.destroy();
      resolve(false);
    });
  });
}

// ── 3. Latency through each live port (real HTTP via proxy) ─────────────────
async function measureLatency(port) {
  const { ProxyAgent, request } = require("undici");
  const dispatcher = new ProxyAgent({
    uri: `http://${PROXY_HOST}:${port}`,
    connectTimeout: LATENCY_TIMEOUT_MS,
    headersTimeout: LATENCY_TIMEOUT_MS,
    bodyTimeout: LATENCY_TIMEOUT_MS,
  });
  const started = Date.now();
  try {
    const res = await request(LATENCY_TEST_URL, { dispatcher, method: "HEAD" });
    await res.body.text().catch(() => {});
    if (res.statusCode >= 500) return { ok: false, ms: Infinity, error: `HTTP ${res.statusCode}` };
    return { ok: true, ms: Date.now() - started, error: null };
  } catch (err) {
    return { ok: false, ms: Infinity, error: (err && (err.code || err.message)) || "error" };
  } finally {
    dispatcher.close().catch?.(() => {});
  }
}

async function main() {
  // reachability + latency (concurrency 10)
  const results = [];
  const queue = [...accounts];
  async function worker() {
    while (queue.length) {
      const acct = queue.shift();
      const alive = await checkPort(acct.port);
      if (!alive) {
        results.push({ ...acct, alive: false, ms: Infinity, error: "port not listening" });
        continue;
      }
      const m = await measureLatency(acct.port);
      results.push({ ...acct, alive: m.ok, ms: m.ms, error: m.error });
    }
  }
  await Promise.all(Array.from({ length: 10 }, worker));

  const live = results.filter((r) => r.alive).sort((a, b) => a.ms - b.ms);
  const dead = results.filter((r) => !r.alive);
  log(`live=${live.length} dead=${dead.length}`);
  for (const r of live.slice(0, 5)) log(`  fastest: ${r.port} ${r.node} ${r.ms}ms`);
  if (live.length === 0) {
    console.error("[opencode-setup] no live mihomo ports — is the panel running?");
    process.exit(1);
  }

  if (DRY_RUN) {
    console.log(JSON.stringify(live.map((r) => ({ port: r.port, node: r.node, ms: r.ms })), null, 2));
    return;
  }

  // ── 4. Upsert proxy_registry rows (match host+port, like upsertProxy) ─────
  const db = new Database(DB_PATH, { timeout: 8000 });
  const now = new Date().toISOString();
  const upsert = db.transaction(() => {
    const proxyIdByPort = new Map();
    for (const r of live) {
      const existing = db
        .prepare("SELECT id FROM proxy_registry WHERE host = ? AND port = ? LIMIT 1")
        .get(PROXY_HOST, r.port);
      const name = `mihomo ${r.node} (:${r.port})`;
      const notes = `panel account ${r.id} (${r.name}) → node ${r.node}`;
      if (existing) {
        db.prepare(
          "UPDATE proxy_registry SET name = ?, type = 'http', notes = ?, status = 'active', source = 'manual', updated_at = ? WHERE id = ?"
        ).run(name, notes, now, existing.id);
        proxyIdByPort.set(r.port, existing.id);
      } else {
        const id = crypto.randomUUID();
        db.prepare(
          `INSERT INTO proxy_registry
             (id, name, type, host, port, username, password, region, notes, status, source, family, subscription_id, created_at, updated_at)
           VALUES (?, ?, 'http', ?, ?, '', '', NULL, ?, 'active', 'manual', 'auto', NULL, ?, ?)`
        ).run(id, name, PROXY_HOST, r.port, notes, now, now);
        proxyIdByPort.set(r.port, id);
      }
    }
    // mark dead ports inactive (they may exist from a previous run)
    for (const r of dead) {
      db.prepare("UPDATE proxy_registry SET status = 'inactive', updated_at = ? WHERE host = ? AND port = ?").run(
        now,
        PROXY_HOST,
        r.port
      );
    }
    return proxyIdByPort;
  });
  const proxyIdByPort = upsert();
  log(`proxy_registry upserted: ${proxyIdByPort.size} live entries`);

  // ── 5. Upsert the `opencode` provider connection (fingerprints + proxies) ─
  // Order = ascending latency: rotation starts on the fastest, most stable node.
  const fingerprints = live.map((r) => r.id);
  const accountProxies = live.map((r) => ({
    fingerprint: r.id,
    proxyId: proxyIdByPort.get(r.port),
  }));
  const psd = { fingerprints, accountProxies };

  const existingConn = db
    .prepare("SELECT id, provider_specific_data FROM provider_connections WHERE provider = 'opencode' LIMIT 1")
    .get();
  if (existingConn) {
    // preserve other PSD keys (extraApiKeys etc.), replace only ours
    let prev = {};
    try {
      prev = JSON.parse(existingConn.provider_specific_data || "{}");
    } catch {}
    db.prepare(
      "UPDATE provider_connections SET provider_specific_data = ?, is_active = 1, updated_at = ? WHERE id = ?"
    ).run(JSON.stringify({ ...prev, ...psd }), now, existingConn.id);
    log(`provider_connections updated: ${existingConn.id}`);
  } else {
    const connId = crypto.randomUUID();
    db.prepare(
      `INSERT INTO provider_connections
         (id, provider, auth_type, name, is_active, provider_specific_data, created_at, updated_at)
       VALUES (?, 'opencode', 'apikey', 'OpenCode Free (mihomo 账号池)', 1, ?, ?, ?)`
    ).run(connId, JSON.stringify(psd), now, now);
    log(`provider_connections created: ${connId}`);
  }

  const count = db.prepare("SELECT COUNT(*) n FROM proxy_registry WHERE status='active'").get();
  log(`done. active proxies in registry: ${count.n}; opencode accounts: ${fingerprints.length} (latency-ordered)`);
  db.close();
}

main().catch((err) => {
  console.error("[opencode-setup] failed:", err);
  process.exit(1);
});
