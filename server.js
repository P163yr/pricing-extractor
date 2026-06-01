"use strict";

/* ============================================================
   Pricing Extractor — CLOUD edition (single-file Node service)

   Runs anywhere (RunPod, any VM, Docker). Serves a small web
   dashboard. You paste your DeepSeek API key + website list in
   the browser, click Start, and it:
     - opens each site in headless Chromium (real JS rendering)
     - finds the pricing page
     - asks DeepSeek for the 4 fields
     - saves results to disk (resume-safe) and lets you download CSV

   The long scraping job runs in the BACKGROUND. HTTP requests
   stay short (start/stop/status/download), so RunPod's 100s
   proxy timeout is never hit.
   ============================================================ */

const http = require("http");
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

const PORT = parseInt(process.env.PORT || "8080", 10);
const ACCESS_CODE = process.env.ACCESS_CODE || ""; // optional shared secret
const DATA_DIR = fs.existsSync("/workspace") ? "/workspace" : __dirname;
const RESULTS_FILE = path.join(DATA_DIR, "pe_results.json");
const JOB_FILE = path.join(DATA_DIR, "pe_job.json");

const SYSTEM_PROMPT = `You are a precise data extractor. You receive the visible text of a company's website (often its pricing page). Respond with ONLY a JSON object, no commentary:

{
  "pricing_model": one of "subscription" | "one_time" | "usage_based" | "freemium" | "custom" | "unknown",
  "price_point": the cheapest PAID entry price as a number in USD (e.g. 9, 29, 99). Use null if none found or quote-only.,
  "has_free_tier": true or false (true only for a real free plan / perpetual free tier; a time-limited trial alone = false),
  "has_annual_plan": true or false (true if annual/yearly billing is offered),
  "notes": short string, max 12 words, for anything unusual
}

Rules:
- "freemium": there is a real free plan AND paid plans.
- "usage_based": billed per transaction / credit / API call / percentage.
- "subscription": recurring flat monthly/yearly plans, no free plan.
- "one_time": single purchase or project-based pricing.
- "custom": pricing is demo/contact-sales only, no public numbers.
- If currency is not USD, still return the numeric entry figure and mention the currency in notes.`;

const SKIP_HOSTS = [
  "apps.apple.com", "play.google.com", "chromewebstore.google.com",
  "chrome.google.com", "x.com", "twitter.com", "t.me", "telegram.me",
  "linkedin.com", "facebook.com", "instagram.com", "youtube.com", "youtu.be",
];

/* ---------------- state ---------------- */
let RESULTS = loadJson(RESULTS_FILE, {});       // url -> result
let JOB = loadJson(JOB_FILE, { urls: [] });     // last submitted list (for resume after reload)
let CFG = null;                                  // in-memory config for the active run (holds API key)
let running = false;
let stopRequested = false;

/* ---------------- small utils ---------------- */
function loadJson(file, dflt) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return dflt; }
}
function saveResults() { try { fs.writeFileSync(RESULTS_FILE, JSON.stringify(RESULTS)); } catch {} }
function saveJob() { try { fs.writeFileSync(JOB_FILE, JSON.stringify(JOB)); } catch {} }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function normalizeUrl(line) {
  let u = String(line || "").trim();
  if (!u || u.startsWith("#")) return null;
  if (!/^https?:\/\//i.test(u)) u = "https://" + u;
  return u;
}
function dedupe(urls) {
  const seen = new Set(), out = [];
  for (const raw of urls) { const u = normalizeUrl(raw); if (u && !seen.has(u)) { seen.add(u); out.push(u); } }
  return out;
}
function hostOf(url) { try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return ""; } }
function sameHost(a, b) { const x = hostOf(a); return x && x === hostOf(b); }
function isSkippable(url) { const h = hostOf(url); return SKIP_HOSTS.some((s) => h === s || h.endsWith("." + s)); }

/* ---------------- browser extraction ---------------- */
function pageExtract() {
  const text = (document.body ? document.body.innerText : "").slice(0, 12000);
  let pricingHref = null;
  const links = Array.from(document.querySelectorAll("a"));
  const hit = links.find((el) => {
    const t = (el.textContent || "").toLowerCase();
    const h = (el.getAttribute("href") || "").toLowerCase();
    return /pricing|\bplans?\b|\bprice\b/.test(t) || /pricing|plans/.test(h);
  });
  if (hit) pricingHref = hit.href;
  return { text, pricingHref };
}

async function collectText(browser, url, timeoutMs) {
  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
  });
  const page = await context.newPage();
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: timeoutMs });
    await page.waitForTimeout(1200);
    const home = await page.evaluate(pageExtract);
    let combined = "[HOME]\n" + home.text;

    if (home.pricingHref && /^https?:/i.test(home.pricingHref) && sameHost(home.pricingHref, url)) {
      try {
        await page.goto(home.pricingHref, { waitUntil: "domcontentloaded", timeout: timeoutMs });
        await page.waitForTimeout(900);
        const pr = await page.evaluate(pageExtract);
        if (pr.text && pr.text.length > 40) combined += "\n\n[PRICING " + home.pricingHref + "]\n" + pr.text;
      } catch { /* pricing page failed; keep home text */ }
    }
    return combined.slice(0, 14000);
  } finally {
    await context.close().catch(() => {});
  }
}

/* ---------------- DeepSeek ---------------- */
async function askDeepSeek(text, url) {
  const res = await fetch(CFG.endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + CFG.apiKey },
    body: JSON.stringify({
      model: CFG.model,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: "Website: " + url + "\n\nPage content:\n" + text },
      ],
      temperature: 0,
      response_format: { type: "json_object" },
    }),
  });
  if (!res.ok) throw new Error("DeepSeek " + res.status + ": " + (await res.text()).slice(0, 120));
  const data = await res.json();
  let content = data.choices && data.choices[0] && data.choices[0].message
    ? data.choices[0].message.content : "{}";
  content = String(content).replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  return JSON.parse(content);
}

function makeResult(url, model, price, free, annual, notes, status) {
  return {
    url, pricing_model: model, price_point: price,
    has_free_tier: free, has_annual_plan: annual,
    notes: notes || "", status: status || model,
  };
}

async function processUrl(browser, url) {
  if (CFG.skipSocial && isSkippable(url)) {
    return makeResult(url, "skipped", "", "", "", "app store / social link", "skipped");
  }
  try {
    const text = await collectText(browser, url, CFG.timeoutMs);
    if (!text || text.replace(/\s/g, "").length < 50) {
      return makeResult(url, "unknown", "", "", "", "no readable content / unreachable", "unknown");
    }
    const r = await askDeepSeek(text, url);
    const model = r.pricing_model || "unknown";
    return makeResult(
      url, model,
      r.price_point == null ? "" : r.price_point,
      typeof r.has_free_tier === "boolean" ? r.has_free_tier : "",
      typeof r.has_annual_plan === "boolean" ? r.has_annual_plan : "",
      r.notes || "", model
    );
  } catch (e) {
    return makeResult(url, "error", "", "", "", String(e && e.message ? e.message : e).slice(0, 90), "error");
  }
}

/* ---------------- job runner ---------------- */
async function runJob(urls) {
  running = true;
  stopRequested = false;
  let browser = null;
  try {
    browser = await chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
    });
    let i = 0;
    const worker = async () => {
      while (i < urls.length && !stopRequested) {
        const url = urls[i++];
        const result = await processUrl(browser, url);
        RESULTS[url] = result;
        saveResults();
      }
    };
    const n = Math.max(1, Math.min(8, parseInt(CFG.concurrency, 10) || 3));
    await Promise.all(Array.from({ length: n }, worker));
  } catch (e) {
    console.error("Job error:", e);
  } finally {
    if (browser) await browser.close().catch(() => {});
    running = false;
    console.log("Job finished. Processed:", Object.keys(RESULTS).length);
  }
}

/* ---------------- HTTP server ---------------- */
function authOK(req) {
  if (!ACCESS_CODE) return true;
  return (req.headers["x-access-code"] || "") === ACCESS_CODE;
}
function send(res, code, type, body) {
  res.writeHead(code, { "Content-Type": type, "Cache-Control": "no-store" });
  res.end(body);
}
function sendJson(res, code, obj) { send(res, code, "application/json", JSON.stringify(obj)); }

function readBody(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => { try { resolve(JSON.parse(data || "{}")); } catch { resolve({}); } });
  });
}

function counts() {
  const vals = Object.values(RESULTS);
  return {
    processed: vals.length,
    done: vals.filter((r) => !["error", "skipped"].includes(r.status)).length,
    errors: vals.filter((r) => r.status === "error").length,
    skipped: vals.filter((r) => r.status === "skipped").length,
  };
}

function csvCell(v) {
  if (v === null || v === undefined) return "";
  const s = String(v).replace(/"/g, '""');
  return /[",\n]/.test(s) ? '"' + s + '"' : s;
}
function buildCsv() {
  const rows = [["url", "pricing_model", "price_point", "has_free_tier", "has_annual_plan", "notes"]];
  for (const r of Object.values(RESULTS)) {
    rows.push([r.url, r.pricing_model, r.price_point, r.has_free_tier, r.has_annual_plan, r.notes]);
  }
  return rows.map((row) => row.map(csvCell).join(",")).join("\n");
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  const p = url.pathname;

  if (p === "/" || p === "/index.html") {
    return send(res, 200, "text/html; charset=utf-8", PAGE_HTML);
  }

  // everything below requires auth (if an access code is set)
  if (p.startsWith("/api/")) {
    if (!authOK(req)) return sendJson(res, 401, { error: "bad access code" });
  }

  if (p === "/api/status" && req.method === "GET") {
    const all = Object.values(RESULTS);
    const recent = all.slice(-150).reverse();
    return sendJson(res, 200, {
      running, total: JOB.urls.length, ...counts(),
      recent, needCode: !!ACCESS_CODE, savedUrls: JOB.urls.join("\n"),
    });
  }

  if (p === "/api/start" && req.method === "POST") {
    if (running) return sendJson(res, 409, { error: "already running" });
    const b = await readBody(req);
    if (!b.apiKey) return sendJson(res, 400, { error: "missing apiKey" });
    let urls = dedupe(Array.isArray(b.urls) ? b.urls : String(b.urls || "").split(/\r?\n/));
    if (!urls.length) return sendJson(res, 400, { error: "no urls" });

    CFG = {
      apiKey: b.apiKey,
      model: b.model || "deepseek-v4-flash",
      endpoint: b.endpoint || "https://api.deepseek.com/chat/completions",
      concurrency: b.concurrency || 3,
      timeoutMs: (parseInt(b.timeout, 10) || 25) * 1000,
      skipSocial: b.skipSocial !== false,
    };
    JOB = { urls }; saveJob();

    let todo = urls;
    if (b.resume !== false) todo = urls.filter((u) => !(RESULTS[u] && RESULTS[u].status !== "error"));
    if (!todo.length) return sendJson(res, 200, { ok: true, note: "nothing to do (all done)" });

    runJob(todo); // fire and forget
    return sendJson(res, 200, { ok: true, queued: todo.length });
  }

  if (p === "/api/stop" && req.method === "POST") {
    stopRequested = true;
    return sendJson(res, 200, { ok: true });
  }

  if (p === "/api/clear" && req.method === "POST") {
    if (running) return sendJson(res, 409, { error: "stop the job first" });
    RESULTS = {}; saveResults();
    return sendJson(res, 200, { ok: true });
  }

  if (p === "/api/download" && req.method === "GET") {
    if (ACCESS_CODE && url.searchParams.get("code") !== ACCESS_CODE)
      return sendJson(res, 401, { error: "bad access code" });
    res.writeHead(200, {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": 'attachment; filename="pricing_results.csv"',
    });
    return res.end(buildCsv());
  }

  send(res, 404, "text/plain", "not found");
});

server.listen(PORT, "0.0.0.0", () => {
  console.log("============================================");
  console.log(" Pricing Extractor ready on port " + PORT);
  console.log(" Data dir: " + DATA_DIR);
  console.log(" Access code: " + (ACCESS_CODE ? "ON" : "off (open)"));
  console.log("============================================");
});

/* ---------------- embedded web page ---------------- */
const PAGE_HTML = `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>Pricing Extractor · Cloud</title>
<style>
:root{--bg:#14130f;--panel:#1c1b16;--panel2:#232118;--line:#3a3729;--ink:#ece6d4;--muted:#9a937e;--amber:#e8a33d;--amberd:#b67e2a;--green:#7bbf6a;--red:#d9695a;--blue:#6aa0c4;--gray:#6b6657;--mono:ui-monospace,"SF Mono",Menlo,Consolas,monospace}
*{box-sizing:border-box}body{margin:0;background:radial-gradient(1200px 600px at 80% -10%,rgba(232,163,61,.07),transparent 60%),var(--bg);color:var(--ink);font-family:var(--mono);font-size:13px;line-height:1.45}
.wrap{max-width:1180px;margin:0 auto;padding:22px 26px 80px}
header{display:flex;align-items:center;gap:14px;border-bottom:1px solid var(--line);padding-bottom:14px;margin-bottom:22px}
.dot{width:9px;height:9px;border-radius:50%;background:var(--amber);box-shadow:0 0 12px var(--amber)}
h1{font-size:15px;letter-spacing:2px;text-transform:uppercase;margin:0;font-weight:700}
.sub{color:var(--muted);font-size:11px;letter-spacing:1px}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:18px}@media(max-width:820px){.grid{grid-template-columns:1fr}}
.panel{background:var(--panel);border:1px solid var(--line);padding:16px}
.panel h2{font-size:11px;letter-spacing:2px;text-transform:uppercase;color:var(--amber);margin:0 0 14px;font-weight:700}
label{display:block;color:var(--muted);font-size:11px;letter-spacing:1px;margin:12px 0 5px;text-transform:uppercase}label:first-of-type{margin-top:0}
input,select,textarea{width:100%;background:var(--panel2);color:var(--ink);border:1px solid var(--line);padding:9px 10px;font-family:var(--mono);font-size:13px;outline:none}
input:focus,select:focus,textarea:focus{border-color:var(--amberd)}
textarea{resize:vertical;min-height:230px;white-space:pre;overflow-x:auto}
.row2{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.checks{display:flex;flex-direction:column;gap:8px;margin-top:12px}
.checks label{display:flex;align-items:center;gap:8px;text-transform:none;letter-spacing:0;color:var(--ink);margin:0;font-size:12px}.checks input{width:auto}
.actions{display:flex;gap:10px;margin-top:18px;flex-wrap:wrap}
button{font-family:var(--mono);font-size:12px;letter-spacing:1px;text-transform:uppercase;padding:10px 16px;border:1px solid var(--line);background:var(--panel2);color:var(--ink);cursor:pointer}
button:hover:not(:disabled){border-color:var(--amberd);color:#fff}button:disabled{opacity:.4;cursor:not-allowed}
button.primary{background:var(--amber);color:#1a1710;border-color:var(--amber);font-weight:700}button.primary:hover:not(:disabled){background:#f4b14a}
button.danger{color:var(--red);border-color:#5a3530}button.ghost{background:transparent}
.status{display:flex;align-items:center;gap:18px;margin:22px 0 12px;border:1px solid var(--line);background:var(--panel);padding:12px 16px;flex-wrap:wrap}
.stat{display:flex;flex-direction:column}.stat .n{font-size:18px;font-weight:700}.stat .l{font-size:10px;letter-spacing:1px;text-transform:uppercase;color:var(--muted)}
.n.done{color:var(--green)}.n.err{color:var(--red)}.n.skip{color:var(--gray)}.n.run{color:var(--amber)}
.barwrap{flex:1;min-width:160px;height:8px;background:var(--panel2);border:1px solid var(--line);overflow:hidden}.barfill{height:100%;width:0;background:linear-gradient(90deg,var(--amberd),var(--amber));transition:width .3s}
table{width:100%;border-collapse:collapse;margin-top:8px;font-size:12px}
thead th{position:sticky;top:0;background:var(--panel2);color:var(--amber);text-align:left;padding:8px 10px;border-bottom:1px solid var(--line);font-size:10px;letter-spacing:1px;text-transform:uppercase}
tbody td{padding:7px 10px;border-bottom:1px solid #25231a;vertical-align:top}tbody tr:hover{background:#1a1812}
td.url{color:var(--blue);max-width:280px;word-break:break-all}td.notes{color:var(--muted);max-width:240px}
.tag{display:inline-block;padding:1px 7px;border:1px solid var(--line);font-size:11px}
.tag.subscription{color:var(--amber)}.tag.freemium{color:var(--green)}.tag.usage_based{color:var(--blue)}.tag.one_time{color:#d0b3e0}.tag.custom{color:var(--muted)}.tag.unknown{color:var(--gray)}.tag.error{color:var(--red);border-color:#5a3530}.tag.skipped{color:var(--gray)}
.bt{color:var(--green)}.bf{color:var(--gray)}
.tablewrap{max-height:55vh;overflow:auto;border:1px solid var(--line);margin-top:8px}
.hint{color:var(--muted);font-size:11px;margin-top:6px}.empty{color:var(--muted);padding:26px;text-align:center}
</style></head><body><div class="wrap">
<header><span class="dot"></span><h1>Pricing Extractor</h1><span class="sub">// cloud · DeepSeek-powered</span></header>
<div class="grid">
 <div class="panel"><h2>Configuration</h2>
  <label>DeepSeek API Key</label><input type="password" id="apiKey" placeholder="sk-..." autocomplete="off"/>
  <div id="codeWrap" style="display:none"><label>Access Code</label><input type="password" id="code" placeholder="the secret you set on the pod"/></div>
  <div class="row2"><div><label>Model</label><select id="model"><option value="deepseek-v4-flash">deepseek-v4-flash (cheap, fast)</option><option value="deepseek-v4-pro">deepseek-v4-pro (accurate)</option></select></div>
  <div><label>Endpoint</label><input type="text" id="endpoint" value="https://api.deepseek.com/chat/completions"/></div></div>
  <div class="row2"><div><label>Tabs at once</label><input type="text" id="concurrency" value="3"/></div><div><label>Page timeout (sec)</label><input type="text" id="timeout" value="25"/></div></div>
  <div class="checks"><label><input type="checkbox" id="resume" checked/> Resume — skip URLs already done</label>
  <label><input type="checkbox" id="skipSocial" checked/> Auto-skip app stores &amp; social links</label></div>
  <p class="hint">Your key is sent only to the endpoint above and is not saved to disk.</p>
 </div>
 <div class="panel"><h2>Websites — one per line</h2><label>Paste your list</label>
  <textarea id="urls" placeholder="https://gumroad.com&#10;https://rezi.ai&#10;https://postiz.com"></textarea>
  <p class="hint"><span id="urlCount">0</span> URLs detected.</p>
 </div>
</div>
<div class="actions"><button class="primary" id="startBtn">▶ Start</button><button class="danger" id="stopBtn" disabled>■ Stop</button><button class="ghost" id="dlBtn">⬇ Download CSV</button><button class="ghost" id="clearBtn">✕ Clear results</button></div>
<div class="status">
 <div class="stat"><span class="n" id="sTotal">0</span><span class="l">Total</span></div>
 <div class="stat"><span class="n done" id="sDone">0</span><span class="l">Done</span></div>
 <div class="stat"><span class="n run" id="sRun">0</span><span class="l">State</span></div>
 <div class="stat"><span class="n err" id="sErr">0</span><span class="l">Errors</span></div>
 <div class="stat"><span class="n skip" id="sSkip">0</span><span class="l">Skipped</span></div>
 <div class="barwrap"><div class="barfill" id="bar"></div></div>
 <div class="stat"><span class="n" id="sPct">0%</span><span class="l">Progress</span></div>
</div>
<div class="tablewrap"><table><thead><tr><th>Website</th><th>Model</th><th>Price $</th><th>Free</th><th>Annual</th><th>Notes</th></tr></thead>
<tbody id="tbody"><tr><td colspan="6" class="empty">No results yet. Add your key, paste your list, hit Start.</td></tr></tbody></table></div>
</div>
<script>
const $=(id)=>document.getElementById(id);
function code(){return $("code")?$("code").value.trim():""}
function headers(){const h={"Content-Type":"application/json"};const c=code();if(c)h["x-access-code"]=c;return h}
function esc(s){return String(s).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]))}
function bool(v){return v===true?'<span class="bt">true</span>':v===false?'<span class="bf">false</span>':'<span class="bf">—</span>'}
function countUrls(){const n=$("urls").value.split(/\\r?\\n/).map(s=>s.trim()).filter(Boolean).length;$("urlCount").textContent=n}
$("urls").addEventListener("input",countUrls);

async function start(){
 if(!$("apiKey").value.trim()){alert("Enter your DeepSeek API key.");return}
 const body={apiKey:$("apiKey").value.trim(),model:$("model").value,endpoint:$("endpoint").value.trim(),
  concurrency:$("concurrency").value,timeout:$("timeout").value,resume:$("resume").checked,skipSocial:$("skipSocial").checked,
  urls:$("urls").value.split(/\\r?\\n/)};
 const r=await fetch("/api/start",{method:"POST",headers:headers(),body:JSON.stringify(body)});
 const j=await r.json();
 if(!r.ok){alert("Could not start: "+(j.error||r.status));return}
 if(j.note)alert(j.note);
}
async function stop(){await fetch("/api/stop",{method:"POST",headers:headers()})}
async function clearAll(){if(!confirm("Clear all results?"))return;const r=await fetch("/api/clear",{method:"POST",headers:headers()});if(!r.ok){const j=await r.json();alert(j.error||"failed")}}
function download(){const c=code();window.location="/api/download"+(c?"?code="+encodeURIComponent(c):"")}
$("startBtn").onclick=start;$("stopBtn").onclick=stop;$("clearBtn").onclick=clearAll;$("dlBtn").onclick=download;

let firstLoad=true;
async function poll(){
 try{
  const r=await fetch("/api/status",{headers:headers()});
  if(r.status===401){$("codeWrap").style.display="block";return}
  const s=await r.json();
  if(s.needCode)$("codeWrap").style.display="block";
  if(firstLoad&&s.savedUrls&&!$("urls").value.trim()){$("urls").value=s.savedUrls;countUrls()}
  firstLoad=false;
  $("sTotal").textContent=s.total;$("sDone").textContent=s.done;$("sErr").textContent=s.errors;$("sSkip").textContent=s.skipped;
  $("sRun").textContent=s.running?"RUN":"idle";$("sRun").className="n "+(s.running?"run":"");
  const pct=s.total?Math.round(s.processed/s.total*100):0;$("sPct").textContent=pct+"%";$("bar").style.width=pct+"%";
  $("startBtn").disabled=s.running;$("stopBtn").disabled=!s.running;
  const tb=$("tbody");
  if(!s.recent||!s.recent.length){if(!tb.querySelector(".empty"))tb.innerHTML='<tr><td colspan="6" class="empty">No results yet. Add your key, paste your list, hit Start.</td></tr>';}
  else{tb.innerHTML=s.recent.map(x=>'<tr><td class="url">'+esc(x.url)+'</td><td><span class="tag '+esc(x.status||x.pricing_model)+'">'+esc(x.pricing_model)+'</span></td><td>'+(x.price_point===""||x.price_point==null?"—":esc(String(x.price_point)))+'</td><td>'+bool(x.has_free_tier)+'</td><td>'+bool(x.has_annual_plan)+'</td><td class="notes">'+esc(x.notes||"")+'</td></tr>').join("")}
 }catch(e){}
}
setInterval(poll,1800);poll();
</script></body></html>`;
