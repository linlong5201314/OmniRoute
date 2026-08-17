// Extract full chronological sequence of opencode request lifecycle entries.
const fs = require("fs");
const raw = fs.readFileSync("C:\\Users\\林龙\\Downloads\\logs.1786973662288.json", "utf8");
const data = JSON.parse(raw);
const list = Array.isArray(data) ? data : data.logs || data.entries || data.data;

const re = /dispatch via|Rate limited|lockout|Account .* unavailable|fallback|noauth|ProxyEgress|breaker|circuit|global|Using opencode|oc\/deepseek|429/i;
let shown = 0;
for (const e of list) {
  const s = typeof e === "string" ? e : (e.message || JSON.stringify(e));
  if (re.test(s)) {
    const ts = e && e.timestamp ? new Date(e.timestamp).toISOString().slice(11, 19) + " " : "";
    console.log(ts + (s.length > 300 ? s.slice(0, 300) + "…" : s));
    shown++;
    if (shown > 120) break;
  }
}
console.log("total matched:", shown);
