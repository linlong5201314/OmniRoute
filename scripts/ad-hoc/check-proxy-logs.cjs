// Quick check: recent proxy_logs egress entries.
const path = require("path");
const Database = require("better-sqlite3");
const db = new Database(path.join(process.env.USERPROFILE, ".omniroute", "storage.sqlite"), {
  readonly: true,
});
const rows = db
  .prepare(
    "SELECT timestamp, status, level, proxy_host, proxy_port, latency_ms, provider, target_url FROM proxy_logs ORDER BY timestamp DESC LIMIT 8"
  )
  .all();
console.log(JSON.stringify(rows, null, 2));
db.close();
