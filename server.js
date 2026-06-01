"use strict";

/* ============================================================
   Pricing Extractor — CLOUD edition (AGENT mode)

   Each site is handled by a real browse loop:
     observe page -> DeepSeek decides next action -> act -> repeat
   Actions: click an element, go to a URL, scroll, or finish.
   The agent hunts for the pricing section, clicks through to it,
   and reports pricing_model / price_point / has_free_tier /
   has_annual_plan, plus a short trail of what it did.

   The long job runs in the BACKGROUND; HTTP stays short, so
   RunPod's 100s proxy timeout is never hit.
   ============================================================ */

const http = require("http");
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

const PORT = parseInt(process.env.PORT || "8080", 10);
const ACCESS_CODE = process.env.ACCESS_CODE || "";
const DATA_DIR = fs.existsSync("/workspace") ? "/workspace" : __dirname;
const RESULTS_FILE = path.join(DATA_DIR, "pe_results.json");
const JOB_FILE = path.join(DATA_DIR, "pe_job.json");

const AGENT_SYSTEM = `You are a web-browsing agent. Goal: find a company's PRICING and report it.
You operate step by step. Each step you are shown the current URL, page title, the visible page text, and a numbered list of clickable elements (links/buttons). You choose ONE action and reply with ONLY a JSON object.

Actions:
- Click an element:        {"thought":"why","action":"click","index":N}
- Go to a same-site URL:   {"thought":"why","action":"goto","url":"https://..."}
- Scroll down for more:    {"thought":"why","action":"scroll"}
- Finish with the answer:  {"thought":"why","action":"done","result":{
      "pricing_model":"subscription|one_time|usage_based|freemium|custom|unknown",
      "price_point": cheapest PAID entry price as a USD number, or null,
      "has_free_tier": true/false (real free plan; a time-limited trial alone = false),
      "has_annual_plan": true/false,
      "notes":"<=12 words; mention currency if not USD"}}

Strategy:
- Click links/buttons labelled Pricing, Plans, Price, Buy, Get started, Upgrade.
- Prefer clicking a real Pricing/Plans link over guessing a URL.
- If the current page already shows full pricing, answer immediately with "done".
- Stay on the company's own website. Do not wander to ads or third-party sites.
- Be efficient — finish in as few steps as possible.

Definitions: freemium = real free plan AND paid plans; usage_based = billed per transaction/credit/API call/percentage; subscription = recurring flat plan, no free plan; one_time = single purchase/project; custom = contact-sales only, no public numbers.`;

const SKIP_HOSTS = [
  "apps.apple.com", "play.google.com", "chromewebstore.google.com",
  "chrome.google.com", "x.com", "twitter.com", "t.me", "telegram.me",
  "linkedin.com", "facebook.com", "instagram.com", "youtube.com", "youtu.be",
];

/* ---------------- state ---------------- */
let RESULTS = loadJson(RESULTS_FILE, {});
let JOB = loadJson(JOB_FILE, { urls: [] });
let CFG = null;
let running = false;
let stopRequested = false;

/* ---------------- utils ---------------- */
function loadJson(file, dflt) { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return dflt; } }
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
function regBase(h) { const p = String(h).split("."); return p.slice(-2).join("."); }
function sameSite(u, startHost) { const h = hostOf(u); return !!h && regBase(h) === regBase(startHost); }
function isSkippable(url) { const h = hostOf(url); return SKIP_HOSTS.some((s) => h === s || h.endsWith("." + s)); }

/* ---------------- browser observe ---------------- */
async function capture(page) {
  const url = page.url();
  let title = "";
  try { title = await page.title(); } catch {}
  let items = [];
  try {
    items = await page.evaluate((MAX) => {
      const out = []; let n = 0;
      const els = document.querySelectorAll('a, button, [role="button"], [class*="pric" i] a, [class*="plan" i] a');
      for (const el of els) {
        const r = el.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) continue;
        const text = (el.innerText || el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 70);
        if (!text) continue;
        el.setAttribute("data-agent-idx", String(n));
        out.push({ idx: n, text, href: el.tagName === "A" ? el.href : null });
        n++; if (n >= MAX) break;
      }
      return out;
    }, 40);
  } catch {}
  let text = "";
  try { text = await page.evaluate(() => (document.body ? document.body.innerText : "").slice(0, 5000)); } catch {}
  return { url, title, items, text };
}

async function doClick(context, page, index, timeoutMs) {
  const before = context.pages().length;
  let msg = "clicked #" + index;
  try {
    const sel = '[data-agent-idx="' + index + '"]';
    await page.click(sel, { timeout: 7000 }).catch(async () => {
      await page.click(sel, { force: true, timeout: 4000 });
    });
  } catch { return { page, msg: "click #" + index + " failed" }; }
  await page.waitForLoadState("domcontentloaded", { timeout: timeoutMs }).catch(() => {});
  const pages = context.pages();
  if (pages.length > before) {
    page = pages[pages.length - 1];
    await page.waitForLoadState("domcontentloaded", { timeout: timeoutMs }).catch(() => {});
    msg += " (new tab)";
  }
  await page.waitForTimeout(700);
  return { page, msg };
}

/* ---------------- DeepSeek ---------------- */
async function deepseekChat(messages) {
  const res = await fetch(CFG.endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + CFG.apiKey },
    body: JSON.stringify({ model: CFG.model, messages, temperature: 0, response_format: { type: "json_object" } }),
  });
  if (!res.ok) throw new Error("DeepSeek " + res.status + ": " + (await res.text()).slice(0, 120));
  const data = await res.json();
  const c = data.choices && data.choices[0] && data.choices[0].message ? data.choices[0].message.content : "{}";
  return String(c);
}
function safeParseAction(raw) {
  let c = String(raw).replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  try { const o = JSON.parse(c); if (o && o.action) return o; } catch {}
  const m = c.match(/\{[\s\S]*\}/);
  if (m) { try { const o = JSON.parse(m[0]); if (o && o.action) return o; } catch {} }
  return { action: "done", thought: "parse failed",
    result: { pricing_model: "unknown", price_point: null, has_free_tier: false, has_annual_plan: false, notes: "agent parse error" } };
}

async function agentDecide(siteUrl, st, history, step, force) {
  const elems = st.items.length
    ? st.items.map((e) => "[" + e.idx + "] (" + (e.href ? "link" : "btn") + ") " + e.text).join("\n")
    : "(none)";
  let user =
    "STEP " + step + "/" + CFG.maxSteps + ". Site: " + siteUrl + "\n" +
    "Prior actions: " + (history.length ? history.slice(-6).join(" | ") : "none") + "\n" +
    "CURRENT URL: " + st.url + "\nTITLE: " + st.title + "\nCLICKABLE:\n" + elems +
    "\n\nPAGE TEXT:\n" + st.text;
  if (force) user += '\n\nYou are out of steps. Reply ONLY with the "done" action and your best result from what you have already seen.';
  const raw = await deepseekChat([{ role: "system", content: AGENT_SYSTEM }, { role: "user", content: user }]);
  return safeParseAction(raw);
}

/* ---------------- result helpers ---------------- */
function makeResult(url, model, price, free, annual, notes, status) {
  return { url, pricing_model: model, price_point: price, has_free_tier: free,
    has_annual_plan: annual, notes: notes || "", status: status || model, steps: 0, trace: [] };
}
function finalize(url, r, trace, steps) {
  const model = r.pricing_model || "unknown";
  const res = makeResult(
    url, model,
    r.price_point == null ? "" : r.price_point,
    typeof r.has_free_tier === "boolean" ? r.has_free_tier : "",
    typeof r.has_annual_plan === "boolean" ? r.has_annual_plan : "",
    r.notes || "", model
  );
  res.steps = steps; res.trace = trace;
  return res;
}

/* ---------------- the agent loop (one site) ---------------- */
async function agentExtract(browser, url) {
  if (CFG.skipSocial && isSkippable(url)) {
    const r = makeResult(url, "skipped", "", "", "", "app store / social link", "skipped");
    r.trace = ["skipped (no pricing page)"]; return r;
  }
  const context = await browser.newContext({
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
  });
  let page = await context.newPage();
  const startHost = hostOf(url);
  const trace = [];
  const history = [];
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: CFG.timeoutMs });
    await page.waitForTimeout(1000);

    for (let step = 1; step <= CFG.maxSteps; step++) {
      if (stopRequested) break;
      const st = await capture(page);
      const a = await agentDecide(url, st, history, step, false);
      const th = String(a.thought || "").slice(0, 70);

      if (a.action === "done") {
        trace.push("step " + step + ": " + th + " -> done");
        return finalize(url, a.result || {}, trace, step);
      } else if (a.action === "click" && Number.isInteger(a.index)) {
        const valid = st.items.some((e) => e.idx === a.index);
        if (!valid) { history.push("invalid index " + a.index); trace.push("step " + step + ": invalid click " + a.index); continue; }
        const label = (st.items.find((e) => e.idx === a.index) || {}).text || ("#" + a.index);
        const cr = await doClick(context, page, a.index, CFG.timeoutMs);
        page = cr.page;
        history.push("clicked '" + label + "'");
        trace.push("step " + step + ": " + th + " -> click '" + label + "'");
      } else if (a.action === "goto" && a.url) {
        if (sameSite(a.url, startHost)) {
          try { await page.goto(a.url, { waitUntil: "domcontentloaded", timeout: CFG.timeoutMs }); await page.waitForTimeout(700); history.push("went to " + a.url); }
          catch { history.push("goto failed"); }
          trace.push("step " + step + ": " + th + " -> goto " + a.url);
        } else { history.push("blocked offsite"); trace.push("step " + step + ": blocked offsite goto"); }
      } else if (a.action === "scroll") {
        try { await page.evaluate(() => window.scrollBy(0, 2200)); } catch {}
        await page.waitForTimeout(600);
        history.push("scrolled"); trace.push("step " + step + ": " + th + " -> scroll");
      } else {
        history.push("no-op"); trace.push("step " + step + ": unrecognized action");
      }
    }
    // ran out of steps -> force a final answer from what was seen
    const st = await capture(page);
    const a = await agentDecide(url, st, history, CFG.maxSteps, true);
    trace.push("forced finish after " + CFG.maxSteps + " steps");
    return finalize(url, a.result || {}, trace, CFG.maxSteps);
  } catch (e) {
    const r = makeResult(url, "error", "", "", "", String(e && e.message ? e.message : e).slice(0, 90), "error");
    r.trace = trace.length ? trace : ["error before first step"]; return r;
  } finally {
    await context.close().catch(() => {});
  }
}

/* ---------------- job runner ---------------- */
async function runJob(urls) {
  running = true; stopRequested = false;
  let browser = null;
  try {
    browser = await chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"] });
    let i = 0;
    const worker = async () => {
      while (i < urls.length && !stopRequested) {
        const url = urls[i++];
        const result = await agentExtract(browser, url);
        RESULTS[url] = result; saveResults();
      }
    };
    const n = Math.max(1, Math.min(6, parseInt(CFG.concurrency, 10) || 3));
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
function authOK(req) { if (!ACCESS_CODE) return true; return (req.headers["x-access-code"] || "") === ACCESS_CODE; }
function send(res, code, type, body) { res.writeHead(code, { "Content-Type": type, "Cache-Control": "no-store" }); res.end(body); }
function sendJson(res, code, obj) { send(res, code, "application/json", JSON.stringify(obj)); }
function readBody(req) {
  return new Promise((resolve) => { let d = ""; req.on("data", (c) => (d += c)); req.on("end", () => { try { resolve(JSON.parse(d || "{}")); } catch { resolve({}); } }); });
}
function counts() {
  const v = Object.values(RESULTS);
  return {
    processed: v.length,
    done: v.filter((r) => !["error", "skipped"].includes(r.status)).length,
    errors: v.filter((r) => r.status === "error").length,
    skipped: v.filter((r) => r.status === "skipped").length,
  };
}
function csvCell(v) { if (v === null || v === undefined) return ""; const s = String(v).replace(/"/g, '""'); return /[",\n]/.test(s) ? '"' + s + '"' : s; }
function buildCsv() {
  const rows = [["url", "pricing_model", "price_point", "has_free_tier", "has_annual_plan", "notes", "steps"]];
  for (const r of Object.values(RESULTS)) rows.push([r.url, r.pricing_model, r.price_point, r.has_free_tier, r.has_annual_plan, r.notes, r.steps || ""]);
  return rows.map((row) => row.map(csvCell).join(",")).join("\n");
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  const p = url.pathname;

  if (p === "/" || p === "/index.html") return send(res, 200, "text/html; charset=utf-8", PAGE_HTML);

  if (p.startsWith("/api/") && !authOK(req)) return sendJson(res, 401, { error: "bad access code" });

  if (p === "/api/status" && req.method === "GET") {
    const recent = Object.values(RESULTS).slice(-150).reverse();
    return sendJson(res, 200, { running, total: JOB.urls.length, ...counts(), recent, needCode: !!ACCESS_CODE, savedUrls: JOB.urls.join("\n") });
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
      maxSteps: Math.max(2, Math.min(10, parseInt(b.maxSteps, 10) || 6)),
      skipSocial: b.skipSocial !== false,
    };
    JOB = { urls }; saveJob();
    let todo = urls;
    if (b.resume !== false) todo = urls.filter((u) => !(RESULTS[u] && RESULTS[u].status !== "error"));
    if (!todo.length) return sendJson(res, 200, { ok: true, note: "nothing to do (all done)" });
    runJob(todo);
    return sendJson(res, 200, { ok: true, queued: todo.length });
  }
  if (p === "/api/stop" && req.method === "POST") { stopRequested = true; return sendJson(res, 200, { ok: true }); }
  if (p === "/api/clear" && req.method === "POST") {
    if (running) return sendJson(res, 409, { error: "stop the job first" });
    RESULTS = {}; saveResults(); return sendJson(res, 200, { ok: true });
  }
  if (p === "/api/download" && req.method === "GET") {
    if (ACCESS_CODE && url.searchParams.get("code") !== ACCESS_CODE) return sendJson(res, 401, { error: "bad access code" });
    res.writeHead(200, { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": 'attachment; filename="pricing_results.csv"' });
    return res.end(buildCsv());
  }
  send(res, 404, "text/plain", "not found");
});

server.listen(PORT, "0.0.0.0", () => {
  console.log("============================================");
  console.log(" Pricing Extractor (AGENT) ready on port " + PORT);
  console.log(" Data dir: " + DATA_DIR);
  console.log(" Access code: " + (ACCESS_CODE ? "ON" : "off (open)"));
  console.log("============================================");
});

/* ---------------- embedded web page ---------------- */
const PAGE_HTML = `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>Pricing Extractor · Agent</title>
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
textarea{resize:vertical;min-height:200px;white-space:pre;overflow-x:auto}
.row2{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.row3{display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px}
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
td.url{color:var(--blue);max-width:260px;word-break:break-all}td.notes{color:var(--muted);max-width:230px}
.tag{display:inline-block;padding:1px 7px;border:1px solid var(--line);font-size:11px}
.tag.subscription{color:var(--amber)}.tag.freemium{color:var(--green)}.tag.usage_based{color:var(--blue)}.tag.one_time{color:#d0b3e0}.tag.custom{color:var(--muted)}.tag.unknown{color:var(--gray)}.tag.error{color:var(--red);border-color:#5a3530}.tag.skipped{color:var(--gray)}
.bt{color:var(--green)}.bf{color:var(--gray)}
.tablewrap{max-height:55vh;overflow:auto;border:1px solid var(--line);margin-top:8px}
.hint{color:var(--muted);font-size:11px;margin-top:6px}.empty{color:var(--muted);padding:26px;text-align:center}
td.steps{color:var(--amber);text-align:center}
</style></head><body><div class="wrap">
<header><span class="dot"></span><h1>Pricing Extractor</h1><span class="sub">// agent mode · it browses each site like a person</span></header>
<div class="grid">
 <div class="panel"><h2>Configuration</h2>
  <label>DeepSeek API Key</label><input type="password" id="apiKey" placeholder="sk-..." autocomplete="off"/>
  <div id="codeWrap" style="display:none"><label>Access Code</label><input type="password" id="code" placeholder="the secret you set on the pod"/></div>
  <div class="row2"><div><label>Model</label><select id="model"><option value="deepseek-v4-flash">deepseek-v4-flash (cheap, fast)</option><option value="deepseek-v4-pro">deepseek-v4-pro (smarter browsing)</option></select></div>
  <div><label>Endpoint</label><input type="text" id="endpoint" value="https://api.deepseek.com/chat/completions"/></div></div>
  <div class="row3"><div><label>Sites at once</label><input type="text" id="concurrency" value="3"/></div><div><label>Page timeout (s)</label><input type="text" id="timeout" value="25"/></div><div><label>Max steps/site</label><input type="text" id="maxSteps" value="6"/></div></div>
  <div class="checks"><label><input type="checkbox" id="resume" checked/> Resume — skip URLs already done</label>
  <label><input type="checkbox" id="skipSocial" checked/> Auto-skip app stores &amp; social links</label></div>
  <p class="hint">The agent clicks toward "Pricing/Plans", reasons about the page, then answers. Hover a row to see the steps it took. More steps = smarter but more API calls.</p>
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
 <div class="stat"><span class="n run" id="sRun">idle</span><span class="l">State</span></div>
 <div class="stat"><span class="n err" id="sErr">0</span><span class="l">Errors</span></div>
 <div class="stat"><span class="n skip" id="sSkip">0</span><span class="l">Skipped</span></div>
 <div class="barwrap"><div class="barfill" id="bar"></div></div>
 <div class="stat"><span class="n" id="sPct">0%</span><span class="l">Progress</span></div>
</div>
<div class="tablewrap"><table><thead><tr><th>Website</th><th>Model</th><th>Price $</th><th>Free</th><th>Annual</th><th>Steps</th><th>Notes</th></tr></thead>
<tbody id="tbody"><tr><td colspan="7" class="empty">No results yet. Add your key, paste your list, hit Start.</td></tr></tbody></table></div>
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
  concurrency:$("concurrency").value,timeout:$("timeout").value,maxSteps:$("maxSteps").value,
  resume:$("resume").checked,skipSocial:$("skipSocial").checked,urls:$("urls").value.split(/\\r?\\n/)};
 const r=await fetch("/api/start",{method:"POST",headers:headers(),body:JSON.stringify(body)});
 const j=await r.json(); if(!r.ok){alert("Could not start: "+(j.error||r.status));return} if(j.note)alert(j.note);
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
  if(!s.recent||!s.recent.length){if(!tb.querySelector(".empty"))tb.innerHTML='<tr><td colspan="7" class="empty">No results yet. Add your key, paste your list, hit Start.</td></tr>';}
  else{tb.innerHTML=s.recent.map(x=>{const trail=(x.trace||[]).join("\\n");return '<tr title="'+esc(trail)+'"><td class="url">'+esc(x.url)+'</td><td><span class="tag '+esc(x.status||x.pricing_model)+'">'+esc(x.pricing_model)+'</span></td><td>'+(x.price_point===""||x.price_point==null?"—":esc(String(x.price_point)))+'</td><td>'+bool(x.has_free_tier)+'</td><td>'+bool(x.has_annual_plan)+'</td><td class="steps">'+(x.steps||"")+'</td><td class="notes">'+esc(x.notes||"")+'</td></tr>'}).join("")}
 }catch(e){}
}
setInterval(poll,1800);poll();
</script></body></html>`;
