// =====================================================================
// STFS Reorder Engine — Netlify function
// Path: netlify/functions/reorder-data.js
// Browser: GET /.netlify/functions/reorder-data
//          Authorization: Bearer <STFD access token>
//
// Sign-in is the STFD Auth project (qdfwovnhlaaocgawukto). Set BEFORE
// this deploys, or every request returns 503:
//   STFD_SUPABASE_URL        https://qdfwovnhlaaocgawukto.supabase.co
//   STFD_SUPABASE_ANON_KEY   STFD publishable key (sb_publishable_…)
//   REORDER_ALLOWED_EMAILS   optional comma-separated rollout list
//   STFS_SUPABASE_URL        STFS project URL
//   STFS_SUPABASE_SERVICE_KEY  STFS secret key (sb_secret_…) or legacy
//                              service_role JWT. Never a publishable key.
//
// Access is allowed when app_metadata.apps contains "asklightspeed" or
// "reorder" (exact entry), or the email is in REORDER_ALLOWED_EMAILS.
// user_metadata is ignored — the user can edit that.
// The user JWT is checked with STFD Auth (GET /auth/v1/user). It is
// never decoded here and never sent to the STFS data API.
// =====================================================================

const MSG = {
  signIn: "Please sign in.",
  forbidden: "Your account doesn't have access to the Reorder Engine yet. Ask Sarah to add you.",
  authDown: "Sign-in check is unavailable right now. Try again shortly.",
  dataDown: "Could not load the reorder data. Try again shortly.",
};

// Same queries the page used to send from the browser, including the
// dead-stock cap. PostgREST still applies its own row cap.
const VIEWS = [
  ["runs", "v_reorder_run_latest", "select=*"],
  ["recs", "v_reorder_priority", "select=*&order=priority.asc,extended_cost.desc"],
  ["exceptions", "v_reorder_exceptions_latest", "select=*&order=on_hand.asc"],
  ["suppliers", "v_reorder_by_supplier", "select=*"],
  ["dead", "v_dead_stock", "select=*&limit=500"],
];

const APP_NAMES = new Set(["asklightspeed", "reorder"]);

function json(statusCode, body) {
  return {
    statusCode,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
    body: JSON.stringify(body),
  };
}

function httpsOrigin(raw) {
  const base = String(raw || "").trim();
  if (!base) return "";
  let url;
  try { url = new URL(base); }
  catch { return ""; }
  if (url.protocol !== "https:" || url.username || url.password) return "";
  // Only the project's own Supabase host. A typo must not receive the key.
  if (!/^[a-z0-9-]+\.supabase\.co$/i.test(url.hostname)) return "";
  return url.origin;
}

function readConfig() {
  const stfdOrigin = httpsOrigin(process.env.STFD_SUPABASE_URL);
  const stfdKey = String(process.env.STFD_SUPABASE_ANON_KEY || "").trim();
  const stfsOrigin = httpsOrigin(process.env.STFS_SUPABASE_URL);
  const stfsKey = String(process.env.STFS_SUPABASE_SERVICE_KEY || "").trim();
  if (!stfdOrigin || !stfdKey) {
    console.error("reorder-data: STFD auth env vars missing or unusable");
    return { problem: "auth" };
  }
  if (!stfsOrigin || !stfsKey || stfsKey.startsWith("sb_publishable_")) {
    console.error("reorder-data: STFS data env vars missing or unusable");
    return { problem: "data" };
  }
  return { stfdOrigin, stfdKey, stfsOrigin, stfsKey };
}

function authorizationHeader(event) {
  const bags = [event && event.headers, event && event.multiValueHeaders];
  for (const bag of bags) {
    if (!bag || typeof bag !== "object") continue;
    for (const key of Object.keys(bag)) {
      if (key.toLowerCase() !== "authorization") continue;
      const value = Array.isArray(bag[key]) ? bag[key][0] : bag[key];
      if (value) return String(value).trim();
    }
  }
  return "";
}

function bearerToken(header) {
  const m = /^Bearer\s+(\S+)$/i.exec(header || "");
  if (!m) return "";
  const token = m[1];
  if (token.length > 8192) return "";
  // Base64url JWT only, so a crafted header cannot inject extra fields.
  if (!/^[A-Za-z0-9_-]+=*\.[A-Za-z0-9_-]+=*\.[A-Za-z0-9_-]+=*$/.test(token)) return "";
  return token;
}

function hasReorderApp(apps) {
  const hit = (v) => APP_NAMES.has(String(v).trim().toLowerCase());
  if (Array.isArray(apps)) return apps.some(hit);
  if (typeof apps === "string") return apps.split(",").some(hit);
  return false;
}

function emailAllowed(email) {
  if (!email) return false;
  const allow = String(process.env.REORDER_ALLOWED_EMAILS || "")
    .toLowerCase()
    .split(/[,;\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  return allow.includes(email);
}

async function verifyUser(event, cfg) {
  const token = bearerToken(authorizationHeader(event));
  if (!token) return { status: 401 };
  let r;
  try {
    r = await fetch(`${cfg.stfdOrigin}/auth/v1/user`, {
      method: "GET",
      redirect: "manual",
      headers: {
        apikey: cfg.stfdKey,
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(8000),
    });
  } catch (e) {
    console.error("reorder-data: auth lookup failed", e && (e.name || "error"));
    return { status: 503, kind: "auth" };
  }
  // 401/403 from Auth means the token itself is bad. Anything else
  // (5xx, redirect, HTML) means the check is down, not that the user
  // should sign in again.
  if (r.status === 401 || r.status === 403) return { status: 401 };
  if (!r.ok) {
    console.error("reorder-data: auth lookup status", r.status);
    return { status: 503, kind: "auth" };
  }
  let user;
  try { user = await r.json(); }
  catch {
    console.error("reorder-data: auth response was not JSON");
    return { status: 503, kind: "auth" };
  }
  if (!user || typeof user !== "object" || Array.isArray(user)) return { status: 401 };
  if (typeof user.id !== "string" || !user.id.trim()) return { status: 401 };
  const email = String(user.email || "").trim().toLowerCase();
  const apps = user.app_metadata && user.app_metadata.apps;
  if (!hasReorderApp(apps) && !emailAllowed(email)) return { status: 403 };
  return { status: 200, user: { id: user.id.trim(), email } };
}

function stfsDataHeaders(key) {
  const headers = {
    apikey: key,
    Accept: "application/json",
    // Secret keys are rejected when the User-Agent looks like a browser.
    "User-Agent": "stfs-reorder-data",
  };
  // New sb_secret_ keys are not JWTs. Sending them on Authorization
  // makes the data API reject the call. Legacy service_role keys are
  // JWTs and still go on both headers.
  if (key.startsWith("eyJ")) headers.Authorization = `Bearer ${key}`;
  return headers;
}

async function readView(cfg, name, qs) {
  let r;
  try {
    r = await fetch(`${cfg.stfsOrigin}/rest/v1/${name}?${qs}`, {
      method: "GET",
      redirect: "manual",
      headers: stfsDataHeaders(cfg.stfsKey),
      signal: AbortSignal.timeout(15000),
    });
  } catch (e) {
    console.error("reorder-data: view fetch failed", name, e && (e.name || "error"));
    return null;
  }
  if (!r.ok) {
    console.error("reorder-data: view status", name, r.status);
    return null;
  }
  let body;
  try { body = await r.json(); }
  catch {
    console.error("reorder-data: view was not JSON", name);
    return null;
  }
  if (!Array.isArray(body)) {
    console.error("reorder-data: view was not a list", name);
    return null;
  }
  return body;
}

async function readViews(cfg) {
  const rows = await Promise.all(VIEWS.map(([, name, qs]) => readView(cfg, name, qs)));
  const out = {};
  for (let i = 0; i < VIEWS.length; i++) {
    if (!rows[i]) return null;
    out[VIEWS[i][0]] = rows[i];
  }
  return out;
}

exports.handler = async (event) => {
  if (!event || event.httpMethod !== "GET") return json(405, { error: "GET only" });

  const cfg = readConfig();
  if (cfg.problem === "auth") return json(503, { error: MSG.authDown });
  if (cfg.problem === "data") return json(503, { error: MSG.dataDown });

  let who;
  try { who = await verifyUser(event, cfg); }
  catch (err) {
    console.error("reorder-data: sign-in check failed", err && err.name ? err.name : "error");
    return json(503, { error: MSG.authDown });
  }
  if (who.status === 401) return json(401, { error: MSG.signIn });
  if (who.status === 403) return json(403, { error: MSG.forbidden });
  if (who.status !== 200 || !who.user || !who.user.id) return json(503, { error: MSG.authDown });

  let data;
  try { data = await readViews(cfg); }
  catch (err) {
    console.error("reorder-data: data read failed", err && err.name ? err.name : "error");
    return json(503, { error: MSG.dataDown });
  }
  if (!data) return json(503, { error: MSG.dataDown });
  return json(200, data);
};
