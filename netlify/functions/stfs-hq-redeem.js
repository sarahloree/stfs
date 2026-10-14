// =====================================================================
// STFS HQ handoff redeem.
// Browser: POST /.netlify/functions/stfs-hq-redeem
//          { code }     the one-time fragment value; nothing else is trusted
//
// Mirrors the STFD stfd-hq-redeem function:
//   1. Post the code to PJCJ hq-handoff-consume with x-handoff-secret
//      and { code, business: "STFS" }.
//   2. Find the existing STFD Auth user (project qdfwovnhlaaocgawukto).
//      Never create a user, never send email, never return a PJCJ token.
//   3. Require the same allow list / app_metadata.apps check as
//      reorder-data. user_metadata is ignored.
//   4. Mint a magic-link session and return it for the browser to set.
//
// Every refusal is the same 401 so a caller cannot tell a bad code from
// an unknown email or a user who is not on the list.
//
// Set before HQ sign-in will succeed. Password sign-in does not use these:
//   HQ_STFS_HANDOFF_SECRET     shared with PJCJ, sent as x-handoff-secret
//   PJCJ_ANON_KEY              PJCJ publishable key, sent as apikey
//   STFD_SUPABASE_SERVICE_KEY  STFD service_role or sb_secret_ key
//   STFD_SUPABASE_URL          https://qdfwovnhlaaocgawukto.supabase.co
//   STFD_SUPABASE_ANON_KEY     STFD publishable key, used only to verify
//   REORDER_ALLOWED_EMAILS     optional, same list as reorder-data
//   HQ_CONSUME_URL             optional override of the consume function
// =====================================================================

const { hasReorderApp, emailAllowed } = require("./reorder-data.js");

const INVALID = "Invalid or expired.";
const DEFAULT_CONSUME_URL =
  "https://inmodrxuivjmypzvygzi.supabase.co/functions/v1/hq-handoff-consume";
const STFD_HOST = "qdfwovnhlaaocgawukto.supabase.co";
const CODE_RE = /^[A-Za-z0-9_-]{43}$/;
const APP_KEY_RE = /^[a-z][a-z0-9_]{0,63}$/;
const BUSINESS = "STFS";

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

function invalid() {
  return json(401, { error: INVALID });
}

function httpsOrigin(raw) {
  const base = String(raw || "").trim();
  if (!base) return "";
  let url;
  try { url = new URL(base); }
  catch { return ""; }
  if (url.protocol !== "https:" || url.username || url.password) return "";
  if (url.hostname !== STFD_HOST) return "";
  return url.origin;
}

function resolveConsumeUrl(raw) {
  const value = String(raw == null ? "" : raw).trim() || DEFAULT_CONSUME_URL;
  let url;
  try { url = new URL(value); }
  catch { return ""; }
  if (url.protocol !== "https:" || url.username || url.password) return "";
  return url.toString();
}

function normalizeEmail(email) {
  return String(email == null ? "" : email).trim().toLowerCase();
}

function isHandoffCode(code) {
  return typeof code === "string" && CODE_RE.test(code);
}

function readJsonBody(event) {
  if (!event || event.body == null || event.body === "") return null;
  let raw = event.body;
  if (event.isBase64Encoded) {
    try { raw = Buffer.from(String(raw), "base64").toString("utf8"); }
    catch { return null; }
  }
  if (typeof raw !== "string" || raw.length > 4096) return null;
  try {
    const body = JSON.parse(raw);
    if (!body || typeof body !== "object" || Array.isArray(body)) return null;
    return body;
  } catch {
    return null;
  }
}

function usableKey(raw, rejectPublishable) {
  const key = String(raw || "").trim();
  if (!key || key.length > 4096) return "";
  if (rejectPublishable && key.startsWith("sb_publishable_")) return "";
  if (!rejectPublishable && key.startsWith("sb_secret_")) return "";
  return key;
}

function readConfig() {
  const secret = String(process.env.HQ_STFS_HANDOFF_SECRET || "").trim();
  const pjcjAnon = usableKey(process.env.PJCJ_ANON_KEY, false);
  const consumeUrl = resolveConsumeUrl(process.env.HQ_CONSUME_URL);
  const stfdOrigin = httpsOrigin(process.env.STFD_SUPABASE_URL);
  const anonKey = usableKey(process.env.STFD_SUPABASE_ANON_KEY, false);
  const serviceKey = usableKey(process.env.STFD_SUPABASE_SERVICE_KEY, true);
  if (!secret || !pjcjAnon || !consumeUrl || !stfdOrigin || !anonKey || !serviceKey) {
    console.error("stfs-hq-redeem: handoff env missing or unusable");
    return null;
  }
  return { secret, pjcjAnon, consumeUrl, stfdOrigin, anonKey, serviceKey };
}

function authHeaders(key) {
  return {
    apikey: key,
    Authorization: `Bearer ${key}`,
    Accept: "application/json",
    "User-Agent": "stfs-hq-redeem",
  };
}

async function readJson(res) {
  try { return await res.json(); }
  catch { return null; }
}

async function consumeCode(cfg, code) {
  let res;
  try {
    res = await fetch(cfg.consumeUrl, {
      method: "POST",
      redirect: "manual",
      headers: {
        apikey: cfg.pjcjAnon,
        "x-handoff-secret": cfg.secret,
        "Content-Type": "application/json",
        Accept: "application/json",
        "User-Agent": "stfs-hq-redeem",
      },
      body: JSON.stringify({ code: code, business: BUSINESS }),
      signal: AbortSignal.timeout(8000),
    });
  } catch (e) {
    console.error("stfs-hq-redeem: consume failed", e && (e.name || "error"));
    return null;
  }
  if (!res.ok) {
    console.error("stfs-hq-redeem: consume status", res.status);
    return null;
  }
  const body = await readJson(res);
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const email = normalizeEmail(body.email);
  const appKey = String(body.app_key == null ? "" : body.app_key).trim();
  if (!email || email.indexOf("@") < 1 || email.length > 320) return null;
  if (!APP_KEY_RE.test(appKey)) return null;
  return { email, appKey };
}

// listUsers is not an exact lookup. Compare the lowered email ourselves.
async function findUserByEmail(cfg, email) {
  const perPage = 200;
  for (let page = 1; page <= 25; page++) {
    let res;
    try {
      res = await fetch(
        `${cfg.stfdOrigin}/auth/v1/admin/users?page=${page}&per_page=${perPage}`,
        {
          method: "GET",
          redirect: "manual",
          headers: authHeaders(cfg.serviceKey),
          signal: AbortSignal.timeout(8000),
        }
      );
    } catch (e) {
      console.error("stfs-hq-redeem: user lookup failed", e && (e.name || "error"));
      return null;
    }
    if (!res.ok) {
      console.error("stfs-hq-redeem: user lookup status", res.status);
      return null;
    }
    const data = await readJson(res);
    const users = data && Array.isArray(data.users) ? data.users : null;
    if (!users) return null;
    for (const user of users) {
      if (!user || typeof user !== "object") continue;
      if (normalizeEmail(user.email) === email && typeof user.id === "string" && user.id.trim()) {
        return user;
      }
    }
    if (users.length < perPage) return null;
  }
  return null;
}

function allowedUser(user, email) {
  if (!user || normalizeEmail(user.email) !== email) return false;
  if (typeof user.id !== "string" || !user.id.trim()) return false;
  const apps = user.app_metadata && user.app_metadata.apps;
  return hasReorderApp(apps) || emailAllowed(email);
}

// generate_link does not send mail. It is only called for an email that
// already belongs to an allowed STFD user.
async function generateMagicLink(cfg, email) {
  let res;
  try {
    res = await fetch(`${cfg.stfdOrigin}/auth/v1/admin/generate_link`, {
      method: "POST",
      redirect: "manual",
      headers: Object.assign({ "Content-Type": "application/json" }, authHeaders(cfg.serviceKey)),
      body: JSON.stringify({ type: "magiclink", email: email }),
      signal: AbortSignal.timeout(8000),
    });
  } catch (e) {
    console.error("stfs-hq-redeem: link failed", e && (e.name || "error"));
    return "";
  }
  if (!res.ok) {
    console.error("stfs-hq-redeem: link status", res.status);
    return "";
  }
  const data = await readJson(res);
  const hashed = data && data.properties && data.properties.hashed_token;
  if (typeof hashed !== "string" || !hashed) return "";
  return hashed;
}

async function verifyOtp(cfg, tokenHash) {
  let res;
  try {
    res = await fetch(`${cfg.stfdOrigin}/auth/v1/verify`, {
      method: "POST",
      redirect: "manual",
      headers: Object.assign({ "Content-Type": "application/json" }, authHeaders(cfg.anonKey)),
      body: JSON.stringify({ type: "magiclink", token_hash: tokenHash }),
      signal: AbortSignal.timeout(8000),
    });
  } catch (e) {
    console.error("stfs-hq-redeem: verify failed", e && (e.name || "error"));
    return null;
  }
  if (!res.ok) {
    console.error("stfs-hq-redeem: verify status", res.status);
    return null;
  }
  const data = await readJson(res);
  if (!data || typeof data.access_token !== "string" || typeof data.refresh_token !== "string") return null;
  if (!data.access_token || !data.refresh_token || !data.user) return null;
  return data;
}

function publicSession(session) {
  const user = session.user || {};
  return {
    access_token: session.access_token,
    refresh_token: session.refresh_token,
    expires_at: typeof session.expires_at === "number" ? session.expires_at : null,
    user: {
      id: String(user.id).trim(),
      email: user.email,
      app_metadata: user.app_metadata && typeof user.app_metadata === "object" && !Array.isArray(user.app_metadata)
        ? user.app_metadata
        : {},
    },
  };
}

exports.handler = async (event) => {
  if (!event || event.httpMethod !== "POST") return json(405, { error: "POST only" });

  const body = readJsonBody(event);
  const code = body && body.code;
  if (!isHandoffCode(code)) return invalid();

  const cfg = readConfig();
  if (!cfg) return invalid();

  let consumed;
  try { consumed = await consumeCode(cfg, code); }
  catch (err) {
    console.error("stfs-hq-redeem: consume failed", err && err.name ? err.name : "error");
    return invalid();
  }
  if (!consumed) return invalid();

  let user;
  try { user = await findUserByEmail(cfg, consumed.email); }
  catch (err) {
    console.error("stfs-hq-redeem: user lookup failed", err && err.name ? err.name : "error");
    return invalid();
  }
  if (!allowedUser(user, consumed.email)) return invalid();

  let hashed;
  try { hashed = await generateMagicLink(cfg, user.email); }
  catch (err) {
    console.error("stfs-hq-redeem: link failed", err && err.name ? err.name : "error");
    return invalid();
  }
  if (!hashed) return invalid();

  let session;
  try { session = await verifyOtp(cfg, hashed); }
  catch (err) {
    console.error("stfs-hq-redeem: verify failed", err && err.name ? err.name : "error");
    return invalid();
  }
  if (!session) return invalid();
  if (String(session.user.id).trim() !== String(user.id).trim()) return invalid();
  if (normalizeEmail(session.user.email) !== consumed.email) return invalid();

  return json(200, publicSession(session));
};
