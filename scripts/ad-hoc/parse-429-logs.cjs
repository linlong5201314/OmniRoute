// Parse Railway deploy logs JSON: count 429s, account rotation, proxy failures.
const fs = require("fs");
const raw = fs.readFileSync("C:\\Users\\林龙\\Downloads\\logs.1786973662288.json", "utf8");
let data;
try {
  data = JSON.parse(raw);
} catch (e) {
  console.log("not valid JSON:", e.message);
  process.exit(1);
}

function entries(obj) {
  if (Array.isArray(obj)) return obj;
  if (obj && Array.isArray(obj.logs)) return obj.logs;
  if (obj && Array.isArray(obj.entries)) return obj.entries;
  if (obj && Array.isArray(obj.data)) return obj.data;
  return [obj];
}

const list = entries(data);
console.log("total entries:", list.length);
console.log("keys of first:", list[0] ? Object.keys(list[0]).join(",") : "none");
console.log("sample first entry:", JSON.stringify(list[0]).slice(0, 400));
console.log("---");

function text(e) {
  if (typeof e === "string") return e;
  if (e && typeof e.message === "string") return e.message;
  if (e && typeof e.text === "string") return e.text;
  if (e && typeof e.body === "string") return e.body;
  return JSON.stringify(e);
}

const patterns = {
  "429/rate": /429|rate.?limit|Rate limited/i,
  "OPENCODE": /OPENCODE/i,
  "rotate/rotating": /rotat/i,
  "proxy": /proxy|socks5|2080|mihomo/i,
  "circuit/breaker": /circuit|breaker|OPEN|HALF_OPEN/i,
  "account": /account|账号/i,
  "quota": /quota|配额/i,
  "cooling/cooldown": /cool|backoff/i,
};

const counts = {};
for (const e of list) {
  const s = text(e);
  for (const [k, re] of Object.entries(patterns)) {
    if (re.test(s)) counts[k] = (counts[k] || 0) + 1;
  }
}
console.log("pattern counts:", JSON.stringify(counts, null, 2));
console.log("=== matched lines (first 80) ===");
let shown = 0;
const combined = new RegExp(Object.values(patterns).map(r => r.source).join("|"), "i");
for (const e of list) {
  const s = text(e);
  if (combined.test(s)) {
    console.log(s.length > 400 ? s.slice(0, 400) + "…" : s);
    shown++;
    if (shown > 80) break;
  }
}
console.log("matched:", shown);
