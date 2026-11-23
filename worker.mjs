// Chrono-Rex cloud publisher: runs on GitHub Actions (every 30 min), publishes the jobs in jobs.json at their time.
// Jobs and media are prepared on the PC (video/viking-saga/tools/publish.mjs "cloud ..."): media files are assets
// of the release "media" of this repo, so Instagram / Threads can fetch them by URL.
//   node worker.mjs            publish what is due in the next AHEAD minutes (waits for the exact time)
//   node worker.mjs probe <asset>   creates an Instagram story container from the asset (never published) to test fetching
// Secrets (env): META_TOKEN (Facebook Page token, never expires), THREADS_TOKEN (long-lived, refreshed by the PC).
import { readFileSync, writeFileSync, appendFileSync, existsSync } from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import http from "node:http";
import { randomBytes } from "node:crypto";

const GRAPH = "https://graph.facebook.com/v23.0";
const THREADS = "https://graph.threads.net/v1.0";
const REPO = process.env.GITHUB_REPOSITORY;
const AHEAD = 40 * 60e3;           // a run handles jobs due within the next 40 min (runs start every 30 min, often late)
const STORY_LATE = 120 * 60e3;     // a story part more than 2 h late is skipped (it would pile up with the next ones)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const paris = (d = new Date()) => d.toLocaleString("fr-FR", { timeZone: "Europe/Paris" });
const log = (...a) => { const line = [paris(), ...a].join(" "); console.log(line); appendFileSync("log.txt", line + "\n"); };
const readJSON = (f, d) => (existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : d);
const git = (...a) => execFileSync("git", a, { stdio: "inherit" });
const assetUrl = (name) => `https://github.com/${REPO}/releases/download/media/${encodeURIComponent(name)}`;

async function graph(method, path, token, params = {}, base = GRAPH) {
  const u = new URL(base + path); const opt = { method };
  if (method === "GET") for (const [k, v] of Object.entries({ ...params, access_token: token })) u.searchParams.set(k, v);
  else opt.body = new URLSearchParams({ ...params, access_token: token });
  const j = await (await fetch(u, opt)).json();
  if (j.error) throw new Error(`${path}: ${j.error.message}`);
  return j;
}
async function waitContainer(path, token, base, field) {
  for (let i = 0; i < 60; i++) {
    const j = await graph("GET", path, token, { fields: field + (base === THREADS ? ",error_message" : "") }, base);
    if (j[field] === "FINISHED") return;
    if (j[field] === "ERROR" || j[field] === "EXPIRED") throw new Error(`${path}: ${j[field]} ${j.error_message || ""}`);
    await sleep(10000);
  }
  throw new Error(path + ": still processing after 10 min");
}
async function download(name) {
  const r = await fetch(assetUrl(name)); if (!r.ok) throw new Error(`asset ${name}: HTTP ${r.status}`);
  const f = "/tmp/" + name; writeFileSync(f, Buffer.from(await r.arrayBuffer())); return f;
}
// fallback when Meta refuses the release URL: serve the file through a cloudflared quick tunnel
async function withTunnel(file, fn) {
  const name = "/" + randomBytes(16).toString("hex") + ".mp4"; const buf = readFileSync(file);
  const srv = http.createServer((req, res) => {
    if (req.url !== name) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { "content-type": "video/mp4", "content-length": buf.length }); res.end(req.method === "HEAD" ? undefined : buf);
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const cf = spawn("cloudflared", ["tunnel", "--no-autoupdate", "--url", "http://127.0.0.1:" + srv.address().port], { stdio: ["ignore", "pipe", "pipe"] });
  try {
    const base = await new Promise((ok, bad) => {
      let out = ""; const t = setTimeout(() => bad(new Error("cloudflared: no URL after 60 s")), 60000);
      const on = (d) => { out += d; const m = out.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/); if (m) { clearTimeout(t); ok(m[0]); } };
      cf.stdout.on("data", on); cf.stderr.on("data", on);
    });
    for (let i = 0; ; i++) { try { if ((await fetch(base + name, { method: "HEAD" })).ok) break; } catch {} if (i > 30) throw new Error("tunnel not reachable"); await sleep(3000); }
    return await fn(base + name);
  } finally { cf.kill(); srv.close(); }
}
// try the release URL, then the tunnel
async function viaUrl(job, fn) {
  try { return await fn(assetUrl(job.asset)); }
  catch (err) { log(`  ${job.id}: release URL failed (${err.message}), retrying through a tunnel`); return withTunnel(await download(job.asset), fn); }
}

const T = () => process.env.META_TOKEN;
let ids;
async function metaIds() {
  if (!ids) { const me = await graph("GET", "/me", T(), { fields: "id,instagram_business_account{id}" }); ids = { page: me.id, ig: me.instagram_business_account?.id }; }
  return ids;
}
async function igPublish(job, params) {
  const { ig } = await metaIds();
  return viaUrl(job, async (video_url) => {
    const c = await graph("POST", `/${ig}/media`, T(), { ...params, video_url });
    await waitContainer("/" + c.id, T(), GRAPH, "status_code");
    const p = await graph("POST", `/${ig}/media_publish`, T(), { creation_id: c.id });
    const m = await graph("GET", "/" + p.id, T(), { fields: "permalink" });
    return { id: p.id, url: m.permalink };
  });
}
const RUN = {
  "ig-reel": (j) => igPublish(j, { media_type: "REELS", caption: j.caption, share_to_feed: "true" }),
  "ig-story": (j) => igPublish(j, { media_type: "STORIES" }),
  async "fb-story"(j) {
    const { page } = await metaIds(); const buf = readFileSync(await download(j.asset));
    const st = await graph("POST", `/${page}/video_stories`, T(), { upload_phase: "start" });
    const r = await fetch(st.upload_url, { method: "POST", headers: { authorization: "OAuth " + T(), offset: "0", file_size: String(buf.length) }, body: buf });
    const u = await r.json().catch(() => ({})); if (!r.ok || u.success === false || u.error) throw new Error("upload: " + JSON.stringify(u));
    const f = await graph("POST", `/${page}/video_stories`, T(), { upload_phase: "finish", video_id: st.video_id });
    return { id: f.post_id || st.video_id };
  },
  async threads(j) {
    const t = process.env.THREADS_TOKEN;
    const p = await viaUrl(j, async (video_url) => {
      const ct = await graph("POST", "/me/threads", t, { media_type: "VIDEO", video_url, text: j.text, ...(j.topic ? { topic_tag: j.topic } : {}) }, THREADS);
      await waitContainer("/" + ct.id, t, THREADS, "status");
      return graph("POST", "/me/threads_publish", t, { creation_id: ct.id }, THREADS);
    });
    const pm = await graph("GET", "/" + p.id, t, { fields: "permalink" }, THREADS);
    return { id: p.id, url: pm.permalink };
  },
};

function save(state, msg) {
  writeFileSync("state.json", JSON.stringify(state, null, 1) + "\n");
  if (!process.env.GITHUB_ACTIONS) return;
  git("add", "state.json", "log.txt");
  try { git("commit", "-q", "-m", msg); } catch { return; }
  for (let i = 0; i < 5; i++) { try { git("pull", "-q", "--rebase"); git("push", "-q"); return; } catch { execFileSync("sleep", ["5"]); } }
}

async function main() {
  if (process.argv[2] === "probe") {
    const job = { id: "probe", asset: process.argv[3] }; const { ig } = await metaIds();
    const c = await viaUrl(job, async (video_url) => { const c = await graph("POST", `/${ig}/media`, T(), { media_type: "STORIES", video_url }); await waitContainer("/" + c.id, T(), GRAPH, "status_code"); return c; });
    return log(`probe ${job.asset}: container ${c.id} FINISHED (not published)`);
  }
  if (process.env.GITHUB_ACTIONS) git("pull", "-q", "--rebase"); // a queued run may have started from an older commit
  const jobs = readJSON("jobs.json", []), state = readJSON("state.json", {});
  const now = Date.now();
  for (const j of jobs) {
    const at = Date.parse(j.at);
    if (!state[j.id] && /story/.test(j.kind) && at < now - STORY_LATE) { state[j.id] = { status: "missed", at: new Date().toISOString() }; log(`${j.id}: missed (more than 2 h late), skipped`); save(state, `missed ${j.id}`); }
  }
  const due = jobs.filter((j) => !state[j.id] && Date.parse(j.at) <= now + AHEAD).sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  if (!due.length) return console.log("nothing due");
  for (const j of due) {
    const wait = Date.parse(j.at) - Date.now();
    if (wait > 0) { console.log(`${j.id}: waiting ${Math.round(wait / 1000)} s`); await sleep(wait); }
    try {
      const r = await RUN[j.kind](j);
      state[j.id] = { status: "done", at: new Date().toISOString(), ...r };
      log(`${j.id}: published ${r.url || r.id}${Date.now() - Date.parse(j.at) > 5 * 60e3 ? ` (${Math.round((Date.now() - Date.parse(j.at)) / 60e3)} min late)` : ""}`);
    } catch (err) {
      const tries = (state["_tries_" + j.id] || 0) + 1; // failed jobs stay due for the next run, max 3 tries
      state["_tries_" + j.id] = tries;
      if (tries >= 3) state[j.id] = { status: "failed", at: new Date().toISOString(), error: err.message };
      log(`${j.id}: ERROR ${err.message}${tries >= 3 ? " (gave up)" : ""}`);
    }
    save(state, `${j.id}: ${state[j.id]?.status || "retry"}`);
  }
}
main().catch((err) => { log("ERROR " + err.message); process.exitCode = 1; });
