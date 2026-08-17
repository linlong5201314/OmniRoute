// Ad-hoc inspection of OmniRoute runtime DB: proxy registry + opencode connections.
const path = require("path");
const Database = require("better-sqlite3");

const dbPath = path.join(process.env.USERPROFILE, ".omniroute", "storage.sqlite");
const db = new Database(dbPath, { readonly: true });

const tables = db
  .prepare("SELECT name FROM sqlite_master WHERE type='table'")
  .all()
  .map((t) => t.name);
console.log("== tables (proxy/provider related) ==");
console.log(tables.filter((n) => /proxy|provider|connection/i.test(n)).join("\n"));

function safeAll(sql) {
  try {
    return db.prepare(sql).all();
  } catch (err) {
    return [{ error: err.message }];
  }
}

console.log("\n== proxy_registry ==");
console.log(JSON.stringify(safeAll("SELECT * FROM proxy_registry"), null, 2));

console.log("\n== provider_connections schema ==");
console.log(
  JSON.stringify(safeAll("PRAGMA table_info(provider_connections)").map((c) => c.name))
);

console.log("\n== api keys (scopes only) ==");
try {
  const cols = db.prepare("PRAGMA table_info(api_keys)").all().map((c) => c.name);
  console.log("cols:", cols.join(","));
  const rows = db
    .prepare(
      "SELECT " +
        (cols.includes("name") ? "name," : "") +
        (cols.includes("scopes") ? "scopes," : "") +
        (cols.includes("is_active") ?? true ? "is_active," : "") +
        (cols.includes("status") ? "status," : "") +
        " key_prefix FROM api_keys LIMIT 20"
    )
    .all();
  console.log(JSON.stringify(rows, null, 2));
} catch (err) {
  console.log("api_keys error:", err.message);
}

console.log("\n== provider connections (opencode) ==");
console.log(
  JSON.stringify(
    safeAll(
      "SELECT * FROM provider_connections WHERE provider LIKE '%opencode%' OR id LIKE '%opencode%'"
    ),
    null,
    2
  )
);

console.log("\n== upstream_proxy_config ==");
console.log(JSON.stringify(safeAll("SELECT * FROM upstream_proxy_config"), null, 2));

console.log("\n== proxy_assignments ==");
console.log(JSON.stringify(safeAll("SELECT * FROM proxy_assignments"), null, 2));

console.log("\n== connection_runtime_state (opencode) ==");
console.log(
  JSON.stringify(
    safeAll(
      "SELECT * FROM connection_runtime_state WHERE provider LIKE '%opencode%' OR connection_id LIKE '%opencode%'"
    ),
    null,
    2
  )
);

console.log("\n== proxy scope bindings ==");
for (const t of ["proxy_scope_proxies", "proxy_scopes", "proxy_scope_rotation", "proxy_logs"]) {
  if (tables.includes(t)) {
    console.log(`-- ${t} --`);
    console.log(JSON.stringify(safeAll(`SELECT COUNT(*) AS n FROM ${t}`)));
    console.log(JSON.stringify(safeAll(`SELECT * FROM ${t} LIMIT 10`), null, 2));
  }
}

db.close();
