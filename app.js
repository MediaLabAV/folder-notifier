import { getStore } from "@netlify/blobs";
import crypto from "node:crypto";

// ============================================================================
//  Dropbox Folder Notifier — everything in one file.
//  Routes:  /  /status  /test-slack  /connect  /callback  /dropbox-webhook
// ============================================================================

export const config = {
  path: ["/", "/status", "/test-slack", "/connect", "/callback", "/dropbox-webhook"],
};

// ---- Environment -----------------------------------------------------------
const APP_KEY = process.env.DROPBOX_APP_KEY;
const APP_SECRET = process.env.DROPBOX_APP_SECRET;
const REFRESH_TOKEN = process.env.DROPBOX_REFRESH_TOKEN;
const TARGET_FOLDER = process.env.DROPBOX_TARGET_FOLDER ?? "";
const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL;
const SETUP_SECRET = process.env.SETUP_SECRET;
const DASHBOARD_KEY = process.env.DASHBOARD_KEY;

// ---- Blobs storage ---------------------------------------------------------
const store = () => getStore("dropbox-notifier");
const EMPTY = {
  events: [],
  counts: { folders: 0, webhooks: 0 },
  lastFolder: null,
  lastWebhookTs: null,
  lastError: null,
  initializedAt: null,
};
const getState = async () => {
  const raw = await store().get("dashboard");
  return raw ? JSON.parse(raw) : structuredClone(EMPTY);
};
const setState = (s) => store().set("dashboard", JSON.stringify(s));
const getCursor = async () => (await store().get("cursor")) || null;
const setCursor = (c) => store().set("cursor", c);
const getSeen = async () => {
  const raw = await store().get("seen");
  return new Set(raw ? JSON.parse(raw) : []);
};
const setSeen = (set) => store().set("seen", JSON.stringify([...set].slice(-500)));

function pushEvent(state, type, message, ok = true) {
  const ev = { ts: Date.now(), type, message, ok };
  state.events.unshift(ev);
  state.events = state.events.slice(0, 40);
  if (!ok) state.lastError = { message, ts: ev.ts };
  return ev;
}

// ---- Dropbox API -----------------------------------------------------------
async function getAccessToken() {
  const res = await fetch("https://api.dropboxapi.com/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: REFRESH_TOKEN,
      client_id: APP_KEY,
      client_secret: APP_SECRET,
    }),
  });
  if (!res.ok) throw new Error("Token refresh failed: " + (await res.text()));
  return (await res.json()).access_token;
}

async function getLatestCursor(token) {
  const res = await fetch("https://api.dropboxapi.com/2/files/list_folder/get_latest_cursor", {
    method: "POST",
    headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
    body: JSON.stringify({
      path: TARGET_FOLDER,
      recursive: false,
      include_deleted: false,
      include_mounted_folders: true,
    }),
  });
  if (!res.ok) throw new Error("get_latest_cursor failed: " + (await res.text()));
  return (await res.json()).cursor;
}

async function listContinue(token, cursor) {
  const entries = [];
  let cur = cursor;
  let hasMore = true;
  while (hasMore) {
    const res = await fetch("https://api.dropboxapi.com/2/files/list_folder/continue", {
      method: "POST",
      headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
      body: JSON.stringify({ cursor: cur }),
    });
    if (!res.ok) {
      const txt = await res.text();
      const err = new Error("list_folder/continue failed: " + txt);
      err.isReset = txt.includes('"reset"') || txt.includes("reset/");
      throw err;
    }
    const data = await res.json();
    entries.push(...data.entries);
    hasMore = data.has_more;
    cur = data.cursor;
  }
  return { entries, cursor: cur };
}

async function createSharedLink(token, path) {
  const res = await fetch("https://api.dropboxapi.com/2/sharing/create_shared_link_with_settings", {
    method: "POST",
    headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
    body: JSON.stringify({ path }),
  });
  if (res.ok) return (await res.json()).url;
  const err = await res.json().catch(() => ({}));
  if (err?.error?.[".tag"] === "shared_link_already_exists") {
    const res2 = await fetch("https://api.dropboxapi.com/2/sharing/list_shared_links", {
      method: "POST",
      headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
      body: JSON.stringify({ path, direct_only: true }),
    });
    const d2 = await res2.json();
    if (d2.links?.length) return d2.links[0].url;
  }
  throw new Error("create_shared_link failed: " + JSON.stringify(err));
}

// ---- Slack -----------------------------------------------------------------
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

async function sendSlack(folderName, link) {
  const res = await fetch(SLACK_WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      text: "New folder ready to share: " + folderName + " — " + link,
      blocks: [
        { type: "section", text: { type: "mrkdwn", text: "*:file_folder: New folder ready to share*" } },
        { type: "section", text: { type: "mrkdwn", text: "*" + esc(folderName) + "*\n" + link } },
        {
          type: "actions",
          elements: [
            { type: "button", text: { type: "plain_text", text: "Open in Dropbox" }, url: link, style: "primary" },
          ],
        },
      ],
    }),
  });
  if (!res.ok) throw new Error("Slack send failed: " + (await res.text()));
}

async function sendSlackTest() {
  const res = await fetch(SLACK_WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: "Test from Folder Notifier — Slack is connected and working." }),
  });
  if (!res.ok) throw new Error("Slack send failed: " + (await res.text()));
}

// ---- Misc helpers ----------------------------------------------------------
function verifySignature(rawBody, signature) {
  if (!signature) return false;
  const digest = crypto.createHmac("sha256", APP_SECRET).update(rawBody).digest("hex");
  const a = Buffer.from(digest);
  const b = Buffer.from(signature);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
const html = (body, status = 200) =>
  new Response(body, { status, headers: { "Content-Type": "text/html; charset=utf-8" } });

// ============================================================================
//  Router
// ============================================================================
export default async (req) => {
  const url = new URL(req.url);
  const p = url.pathname;

  // ---- Dashboard ----
  if (p === "/" && req.method === "GET") return html(DASHBOARD_HTML);

  // ---- Status JSON ----
  if (p === "/status" && req.method === "GET") {
    if (DASHBOARD_KEY && url.searchParams.get("key") !== DASHBOARD_KEY)
      return Response.json({ error: "unauthorized" }, { status: 401 });
    const state = await getState();
    const cursor = await getCursor();
    const cfg = {
      dropbox: Boolean(APP_KEY && APP_SECRET && REFRESH_TOKEN),
      slack: Boolean(SLACK_WEBHOOK_URL),
      targetFolder: TARGET_FOLDER,
      initialized: Boolean(cursor),
    };
    let health;
    const newest = state.events[0];
    if (!cfg.dropbox || !cfg.slack || !cfg.initialized) health = "setup";
    else if (newest && newest.ok === false) health = "problem";
    else {
      const recent = state.lastWebhookTs && Date.now() - state.lastWebhookTs < 7 * 864e5;
      health = recent || state.counts.folders > 0 ? "live" : "waiting";
    }
    return Response.json({
      health,
      config: cfg,
      counts: state.counts,
      lastFolder: state.lastFolder,
      lastWebhookTs: state.lastWebhookTs,
      lastError: state.lastError,
      events: state.events,
      now: Date.now(),
    });
  }

  // ---- Send test to Slack ----
  if (p === "/test-slack" && req.method === "POST") {
    if (DASHBOARD_KEY && url.searchParams.get("key") !== DASHBOARD_KEY)
      return Response.json({ error: "unauthorized" }, { status: 401 });
    const state = await getState();
    try {
      await sendSlackTest();
      pushEvent(state, "slack", "Test message sent to Slack", true);
      await setState(state);
      return Response.json({ ok: true });
    } catch (e) {
      pushEvent(state, "error", "Test failed: " + e.message, false);
      await setState(state);
      return Response.json({ ok: false, error: e.message }, { status: 500 });
    }
  }

  // ---- Dropbox OAuth: start ----
  if (p === "/connect" && req.method === "GET") {
    const redirectUri = url.origin + "/callback";
    const auth =
      "https://www.dropbox.com/oauth2/authorize?" +
      new URLSearchParams({
        client_id: APP_KEY || "",
        response_type: "code",
        token_access_type: "offline",
        redirect_uri: redirectUri,
      });
    return new Response(null, { status: 302, headers: { Location: auth } });
  }

  // ---- Dropbox OAuth: finish (shows the refresh token) ----
  if (p === "/callback" && req.method === "GET") {
    const code = url.searchParams.get("code");
    if (!code) return html(page("Missing code", "<p>No authorization code came back. Try /connect again.</p>"), 400);
    const res = await fetch("https://api.dropboxapi.com/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        grant_type: "authorization_code",
        client_id: APP_KEY,
        client_secret: APP_SECRET,
        redirect_uri: url.origin + "/callback",
      }),
    });
    const data = await res.json();
    if (!data.refresh_token)
      return html(page("Something went wrong", "<pre>" + esc(JSON.stringify(data, null, 2)) + "</pre>"), 400);
    return html(
      page(
        "Copy your refresh token",
        '<p>Set this as the <code>DROPBOX_REFRESH_TOKEN</code> environment variable in Netlify, then redeploy.</p>' +
          '<textarea readonly onclick="this.select()">' + esc(data.refresh_token) + "</textarea>" +
          '<p class="dim">Click the box to select it. This is the last manual step.</p>'
      )
    );
  }

  // ---- Dropbox webhook ----
  if (p === "/dropbox-webhook") {
    // verification challenge
    if (req.method === "GET" && url.searchParams.has("challenge")) {
      const state = await getState();
      pushEvent(state, "verify", "Webhook verified by Dropbox", true);
      await setState(state);
      return new Response(url.searchParams.get("challenge"), {
        status: 200,
        headers: { "Content-Type": "text/plain", "X-Content-Type-Options": "nosniff" },
      });
    }
    // one-time baseline
    if (req.method === "GET" && SETUP_SECRET && url.searchParams.get("setup") === SETUP_SECRET) {
      try {
        const token = await getAccessToken();
        await setCursor(await getLatestCursor(token));
        const state = await getState();
        state.initializedAt = Date.now();
        pushEvent(state, "setup", "Now watching " + (TARGET_FOLDER || "(your whole Dropbox)"), true);
        await setState(state);
        return new Response("Initialized. Watching: " + (TARGET_FOLDER || "(root)"), { status: 200 });
      } catch (e) {
        return new Response("Setup failed: " + e.message, { status: 500 });
      }
    }
    // notification
    if (req.method === "POST") {
      const rawBody = await req.text();
      if (!verifySignature(rawBody, req.headers.get("x-dropbox-signature")))
        return new Response("Invalid signature", { status: 403 });

      const state = await getState();
      state.counts.webhooks += 1;
      state.lastWebhookTs = Date.now();
      try {
        const token = await getAccessToken();
        let cursor = await getCursor();
        if (!cursor) {
          await setCursor(await getLatestCursor(token));
          state.initializedAt = state.initializedAt || Date.now();
          pushEvent(state, "setup", "Baseline set on first event", true);
          await setState(state);
          return new Response("OK (initialized)", { status: 200 });
        }
        let result;
        try {
          result = await listContinue(token, cursor);
        } catch (e) {
          if (e.isReset) {
            await setCursor(await getLatestCursor(token));
            pushEvent(state, "info", "Dropbox reset the cursor; re-synced", true);
            await setState(state);
            return new Response("OK (cursor reset)", { status: 200 });
          }
          throw e;
        }
        const seen = await getSeen();
        const newFolders = result.entries.filter((e) => e[".tag"] === "folder" && !seen.has(e.path_lower));
        for (const folder of newFolders) {
          try {
            const link = await createSharedLink(token, folder.path_lower);
            await sendSlack(folder.name, link);
            seen.add(folder.path_lower);
            state.counts.folders += 1;
            state.lastFolder = { name: folder.name, link, ts: Date.now() };
            pushEvent(state, "folder", 'Shared "' + folder.name + '" to Slack', true);
          } catch (err) {
            pushEvent(state, "error", '"' + folder.name + '": ' + err.message, false);
          }
        }
        await setCursor(result.cursor);
        await setSeen(seen);
        await setState(state);
        return new Response("OK", { status: 200 });
      } catch (e) {
        pushEvent(state, "error", e.message, false);
        await setState(state);
        return new Response("Error", { status: 500 });
      }
    }
  }

  return new Response("Not found", { status: 404 });
};

// ============================================================================
//  Small styled page wrapper (used by the OAuth screens)
// ============================================================================
function page(title, body) {
  return (
    '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    "<title>" + title + "</title><style>" +
    "body{background:#000;color:#fff;font-family:system-ui,sans-serif;max-width:620px;margin:0 auto;padding:56px 24px}" +
    "h1{font-weight:700;font-size:30px}code{color:#00e5ff}a{color:#0096ff}.dim{color:#7c828e;font-size:14px}" +
    "textarea{width:100%;height:90px;margin:14px 0;background:#0a0a0b;color:#00e5ff;border:1px solid #0096ff;" +
    "border-radius:6px;padding:12px;font-family:ui-monospace,monospace;font-size:13px}pre{background:#0a0a0b;padding:16px;overflow:auto;border-radius:6px}" +
    "</style><h1>" + title + "</h1>" + body
  );
}

// ============================================================================
//  Dashboard (served at /). No backticks / ${} inside so it embeds cleanly.
// ============================================================================
const DASHBOARD_HTML = [
  '<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">',
  '<meta name="viewport" content="width=device-width, initial-scale=1.0">',
  "<title>Folder Notifier · Media Lab</title>",
  '<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>',
  '<link href="https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@500;600;700&family=Barlow:wght@400;500;600&family=DM+Mono:wght@400;500&display=swap" rel="stylesheet">',
  "<style>",
  ":root{--bg:#000;--text:#fff;--accent:#0096ff;--glow:#00e5ff;--muted:#7c828e;--line:rgba(255,255,255,.09);--panel:rgba(255,255,255,.025);--err:#ff4d5e;--display:'Barlow Condensed',sans-serif;--body:'Barlow',sans-serif;--mono:'DM Mono',monospace}",
  "*{box-sizing:border-box}html,body{margin:0;background:var(--bg)}",
  "body{color:var(--text);font-family:var(--body);-webkit-font-smoothing:antialiased;min-height:100vh;padding:clamp(20px,5vw,56px) clamp(16px,5vw,48px) 64px}",
  ".wrap{max-width:960px;margin:0 auto}",
  ".eyebrow{font-family:var(--mono);font-size:11px;letter-spacing:.22em;text-transform:uppercase;color:var(--muted);margin:0 0 28px}.eyebrow b{color:var(--accent);font-weight:500}",
  ".hero{display:flex;align-items:center;gap:clamp(18px,4vw,34px);margin-bottom:44px}",
  ".beacon{position:relative;width:74px;height:74px;flex:0 0 auto;display:grid;place-items:center}",
  ".beacon .core{width:15px;height:15px;border-radius:50%;background:var(--st,var(--muted));box-shadow:0 0 16px 2px var(--st,transparent);z-index:2}",
  ".beacon .ring{position:absolute;inset:0;border-radius:50%;border:1.5px solid var(--st,var(--muted));opacity:0}",
  '[data-live="true"] .beacon .ring{animation:pulse 2.4s ease-out infinite}[data-live="true"] .beacon .ring:nth-child(2){animation-delay:.8s}[data-live="true"] .beacon .ring:nth-child(3){animation-delay:1.6s}',
  "@keyframes pulse{0%{transform:scale(.3);opacity:.8}100%{transform:scale(1);opacity:0}}",
  ".status-word{font-family:var(--display);font-weight:700;font-size:clamp(40px,9vw,68px);line-height:.9;letter-spacing:-.01em;color:var(--st,var(--text));margin:0}",
  ".status-sub{font-family:var(--mono);font-size:13px;color:var(--muted);margin-top:8px}.status-sub code{color:var(--text)}",
  ".readouts{display:grid;grid-template-columns:repeat(3,1fr);gap:1px;background:var(--line);border:1px solid var(--line);margin-bottom:40px}",
  ".tile{background:var(--bg);padding:22px 20px}.tile .num{font-family:var(--display);font-weight:600;font-size:40px;line-height:1;color:var(--text)}.tile .num.accent{color:var(--glow)}.tile .num.small{font-size:22px;line-height:1.3}",
  ".tile .lbl{font-family:var(--mono);font-size:10.5px;letter-spacing:.16em;text-transform:uppercase;color:var(--muted);margin-top:10px}",
  ".row{display:grid;grid-template-columns:1fr 1fr;gap:20px;margin-bottom:20px}",
  ".panel{border:1px solid var(--line);background:var(--panel);padding:22px}.panel h2{font-family:var(--mono);font-size:11px;letter-spacing:.18em;text-transform:uppercase;color:var(--muted);font-weight:500;margin:0 0 16px}",
  ".check{display:flex;align-items:center;gap:12px;padding:9px 0}.check+.check{border-top:1px solid var(--line)}",
  ".check .dot{width:8px;height:8px;border-radius:50%;flex:0 0 auto}.check .dot.on{background:var(--glow);box-shadow:0 0 8px var(--glow)}.check .dot.off{background:transparent;border:1.5px solid var(--err)}",
  ".check .txt{font-size:15px}.check .state{margin-left:auto;font-family:var(--mono);font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:var(--muted)}",
  ".lastfolder .name{font-family:var(--display);font-weight:600;font-size:26px;line-height:1.1;margin-bottom:6px}.lastfolder .time{font-family:var(--mono);font-size:12px;color:var(--muted);margin-bottom:16px}.lastfolder .empty{color:var(--muted);font-size:15px}",
  ".open-link{display:inline-flex;align-items:center;gap:8px;font-family:var(--mono);font-size:12px;letter-spacing:.05em;color:var(--accent);text-decoration:none;border:1px solid var(--accent);padding:9px 14px;transition:background .15s,color .15s}.open-link:hover{background:var(--accent);color:#001018}",
  ".log .head{display:flex;align-items:center;justify-content:space-between;margin-bottom:16px}.log h2{margin:0}",
  ".btn{font-family:var(--mono);font-size:11.5px;letter-spacing:.06em;color:var(--text);background:transparent;border:1px solid var(--line);padding:9px 14px;cursor:pointer;transition:border-color .15s,color .15s}.btn:hover{border-color:var(--glow);color:var(--glow)}.btn:disabled{opacity:.5;cursor:default}",
  ".feed{list-style:none;margin:0;padding:0}.feed li{display:grid;grid-template-columns:12px 1fr auto;align-items:baseline;gap:12px;padding:11px 0;border-top:1px solid var(--line);animation:fade .3s ease both}.feed li:first-child{border-top:none}",
  "@keyframes fade{from{opacity:0;transform:translateY(-3px)}to{opacity:1}}",
  ".feed .d{width:7px;height:7px;border-radius:50%;margin-top:6px}.feed .d.ok{background:var(--glow)}.feed .d.no{background:var(--err)}.feed .d.info{background:var(--accent)}",
  ".feed .msg{font-size:14.5px}.feed .type{font-family:var(--mono);font-size:10px;letter-spacing:.1em;text-transform:uppercase;color:var(--muted);margin-right:8px}.feed .when{font-family:var(--mono);font-size:11.5px;color:var(--muted);white-space:nowrap}.feed .none{color:var(--muted);font-size:14px;padding:8px 0}",
  "footer{margin-top:32px;font-family:var(--mono);font-size:11px;letter-spacing:.08em;color:var(--muted);display:flex;align-items:center;gap:8px}footer .ld{width:6px;height:6px;border-radius:50%;background:var(--glow);animation:blink 2s infinite}@keyframes blink{50%{opacity:.25}}",
  "@media(max-width:640px){.readouts{grid-template-columns:1fr}.row{grid-template-columns:1fr}}@media(prefers-reduced-motion:reduce){*{animation:none!important}}",
  "</style></head><body>",
  '<div class="wrap" id="app" data-live="false">',
  '<p class="eyebrow"><b>Media Lab</b> · Folder Notifier</p>',
  '<div class="hero"><div class="beacon" style="--st:var(--muted)"><span class="ring"></span><span class="ring"></span><span class="ring"></span><span class="core"></span></div>',
  '<div><h1 class="status-word" id="statusWord">CONNECTING</h1><div class="status-sub" id="statusSub">Checking the notifier…</div></div></div>',
  '<div class="readouts"><div class="tile"><div class="num accent" id="cFolders">—</div><div class="lbl">Folders shared</div></div>',
  '<div class="tile"><div class="num" id="cEvents">—</div><div class="lbl">Dropbox events</div></div>',
  '<div class="tile"><div class="num small" id="cLast">—</div><div class="lbl">Last activity</div></div></div>',
  '<div class="row"><div class="panel"><h2>Connections</h2>',
  '<div class="check"><span class="dot" id="dbDot"></span><span class="txt">Dropbox</span><span class="state" id="dbState">—</span></div>',
  '<div class="check"><span class="dot" id="slDot"></span><span class="txt">Slack</span><span class="state" id="slState">—</span></div>',
  '<div class="check"><span class="dot" id="mDot"></span><span class="txt">Monitoring</span><span class="state" id="mState">—</span></div></div>',
  '<div class="panel lastfolder"><h2>Last folder</h2><div id="lastBody"><div class="empty">No folders shared yet.</div></div></div></div>',
  '<div class="panel log"><div class="head"><h2>Activity</h2><button class="btn" id="testBtn">Send test to Slack</button></div>',
  '<ul class="feed" id="feed"><li class="none">Waiting for activity…</li></ul></div>',
  '<footer><span class="ld"></span><span id="footText">Updates every 5 seconds</span></footer></div>',
  "<script>",
  "var KEY=new URLSearchParams(location.search).get('key');var q=KEY?'?key='+encodeURIComponent(KEY):'';",
  "var app=document.getElementById('app');",
  "var STATES={live:{word:'LIVE',color:'var(--glow)',sub:function(f){return 'Watching '+f+' · running normally'}},",
  "waiting:{word:'READY',color:'var(--accent)',sub:function(f){return 'Watching '+f+' · waiting for the first folder'}},",
  "problem:{word:'ATTENTION',color:'var(--err)',sub:function(){return 'Something failed — check the activity log below'}},",
  "setup:{word:'SETUP NEEDED',color:'var(--muted)',sub:function(){return 'Finish the connections below to go live'}},",
  "error:{word:'OFFLINE',color:'var(--err)',sub:function(){return \"Can't reach the notifier\"}}};",
  "function ago(ts,now){if(!ts)return '—';var s=Math.max(0,Math.floor((now-ts)/1000));if(s<60)return s+'s ago';var m=Math.floor(s/60);if(m<60)return m+'m ago';var h=Math.floor(m/60);if(h<24)return h+'h ago';return Math.floor(h/24)+'d ago'}",
  "function esc(s){return String(s).replace(/[&<>\"]/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;'}[c]})}",
  "function fmtPath(p){return p?'<code>'+esc(p)+'</code>':'<code>your Dropbox</code>'}",
  "function setCheck(id,on,label){var d=document.getElementById(id+'Dot');d.className='dot '+(on?'on':'off');document.getElementById(id+'State').textContent=label}",
  "function render(d){var now=d.now||Date.now();var st=STATES[d.health]||STATES.setup;app.dataset.live=String(d.health==='live');",
  "document.querySelector('.beacon').style.setProperty('--st',st.color);var w=document.getElementById('statusWord');w.style.setProperty('--st',st.color);w.textContent=st.word;",
  "document.getElementById('statusSub').innerHTML=st.sub(fmtPath(d.config&&d.config.targetFolder));",
  "document.getElementById('cFolders').textContent=(d.counts&&d.counts.folders)||0;document.getElementById('cEvents').textContent=(d.counts&&d.counts.webhooks)||0;document.getElementById('cLast').textContent=ago(d.lastWebhookTs,now);",
  "setCheck('db',d.config&&d.config.dropbox,(d.config&&d.config.dropbox)?'connected':'missing');setCheck('sl',d.config&&d.config.slack,(d.config&&d.config.slack)?'connected':'missing');setCheck('m',d.config&&d.config.initialized,(d.config&&d.config.initialized)?'active':'off');",
  "var lb=document.getElementById('lastBody');if(d.lastFolder){lb.innerHTML='<div class=\"name\">'+esc(d.lastFolder.name)+'</div><div class=\"time\">'+ago(d.lastFolder.ts,now)+'</div><a class=\"open-link\" href=\"'+d.lastFolder.link+'\" target=\"_blank\" rel=\"noopener\">Open in Dropbox ↗</a>'}else{lb.innerHTML='<div class=\"empty\">No folders shared yet.</div>'}",
  "var feed=document.getElementById('feed');if(!d.events||!d.events.length){feed.innerHTML='<li class=\"none\">No activity yet. Create a folder to test it.</li>'}else{feed.innerHTML=d.events.map(function(e){var cls=e.ok===false?'no':((e.type==='folder'||e.type==='slack')?'ok':'info');return '<li><span class=\"d '+cls+'\"></span><span class=\"msg\"><span class=\"type\">'+esc(e.type)+'</span>'+esc(e.message)+'</span><span class=\"when\">'+ago(e.ts,now)+'</span></li>'}).join('')}",
  "document.getElementById('footText').textContent='Updated '+new Date(now).toLocaleTimeString()}",
  "function tick(){fetch('/status'+q,{cache:'no-store'}).then(function(r){if(!r.ok)throw 0;return r.json()}).then(render).catch(function(){var st=STATES.error;document.querySelector('.beacon').style.setProperty('--st',st.color);var w=document.getElementById('statusWord');w.style.setProperty('--st',st.color);w.textContent=st.word;document.getElementById('statusSub').textContent=st.sub()})}",
  "var btn=document.getElementById('testBtn');btn.addEventListener('click',function(){btn.disabled=true;btn.textContent='Sending…';fetch('/test-slack'+q,{method:'POST'}).then(function(r){return r.json()}).then(function(j){btn.textContent=j.ok?'Sent ✓':'Failed ✕'}).catch(function(){btn.textContent='Failed ✕'}).then(function(){tick();setTimeout(function(){btn.disabled=false;btn.textContent='Send test to Slack'},2500)})});",
  "tick();setInterval(tick,5000);",
  "</script></body></html>",
].join("");
