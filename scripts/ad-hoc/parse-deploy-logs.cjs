// Parse deploy logs JSON and extract proxy/2080/core related entries.
const fs = require("fs");
const raw = fs.readFileSync("C:\\Users\\林龙\\Downloads\\logs.1786955130943.json", "utf8");
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

const re = /2080|unreachable|Fast-Fail|socks5|localCore|core|mihomo|clash|sing-box|subscription|订阅|内核/i;
let shown = 0;
for (const e of list) {
  const s = typeof e === "string" ? e : JSON.stringify(e);
  if (re.test(s)) {
    console.log(s.length > 500 ? s.slice(0, 500) + "…" : s);
    shown++;
    if (shown > 60) break;
  }
}
console.log("matched:", shown);
