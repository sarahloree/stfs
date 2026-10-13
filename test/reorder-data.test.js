const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const { handler } = require("../netlify/functions/reorder-data.js");

const TOK = "eyJhbGci.eyJzdWIi.signature";
const KEYS = [
  "STFD_SUPABASE_URL",
  "STFD_SUPABASE_ANON_KEY",
  "REORDER_ALLOWED_EMAILS",
  "STFS_SUPABASE_URL",
  "STFS_SUPABASE_SERVICE_KEY",
];
const VIEWS = [
  "/rest/v1/v_reorder_run_latest?select=*",
  "/rest/v1/v_reorder_priority?select=*&order=priority.asc,extended_cost.desc",
  "/rest/v1/v_reorder_exceptions_latest?select=*&order=on_hand.asc",
  "/rest/v1/v_reorder_by_supplier?select=*",
  "/rest/v1/v_dead_stock?select=*&limit=500",
];

function setEnv(extra) {
  for (const key of KEYS) delete process.env[key];
  Object.assign(process.env, extra);
}

function configured(extra = {}) {
  setEnv({
    STFD_SUPABASE_URL: "https://qdfwovnhlaaocgawukto.supabase.co/",
    STFD_SUPABASE_ANON_KEY: "sb_publishable_test_key\n",
    REORDER_ALLOWED_EMAILS: "",
    STFS_SUPABASE_URL: "https://stfs-example.supabase.co\n",
    STFS_SUPABASE_SERVICE_KEY: "test-service-key",
    ...extra,
  });
}

function user(over = {}) {
  return {
    id: Object.prototype.hasOwnProperty.call(over, "id") ? over.id : "11111111-1111-1111-1111-111111111111",
    email: over.email === undefined ? "person@example.com" : over.email,
    app_metadata: over.app_metadata === undefined ? { apps: ["reorder"] } : over.app_metadata,
    user_metadata: over.user_metadata,
  };
}

function jsonRes(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
  };
}

function get(headers, extra = {}) {
  return handler({
    httpMethod: "GET",
    headers: headers || {},
    ...extra,
  });
}

function payload(over = {}) {
  return {
    runs: [{ run_at: "2026-07-24T12:00:00Z", mode: "flag_only", products_evaluated: 3 }],
    recs: [{ sku: "13604", name: "Post", priority: 1, extended_cost: 12.5, flags: ["stale_demand"] }],
    exceptions: [{ sku: "9", exception_type: "negative_stock", on_hand: -1, detail: { note: "recount" } }],
    suppliers: [{ supplier: "Binford", products: 2 }],
    dead: [{ sku: "1", value_at_cost: 4 }],
    ...over,
  };
}

test("reorder data gate", async () => {
  const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  const origFetch = global.fetch;
  const origError = console.error;
  console.error = () => {};
  try {
    const root = path.join(__dirname, "..");
    const reorder = fs.readFileSync(path.join(root, "reorderengine/index.html"), "utf8");
    const hub = fs.readFileSync(path.join(root, "index.html"), "utf8");
    const authJs = fs.readFileSync(path.join(root, "stfd-auth.js"), "utf8");
    const source = fs.readFileSync(path.join(root, "netlify/functions/reorder-data.js"), "utf8");
    const toml = fs.readFileSync(path.join(root, "netlify.toml"), "utf8");

    assert.match(authJs, /sb_publishable_PPhYAvIRNnzv7E86s8yw-g_ltVx0Gvk/);
    assert.match(authJs, /class="signin-msg"/);
    assert.match(authJs, /signInWithPassword/);
    assert.match(reorder, /\/stfd-auth\.js/);
    assert.match(hub, /\/stfd-auth\.js/);
    assert.match(reorder, /\/\.netlify\/functions\/reorder-data/);
    assert.match(hub, /href="\/reorderengine\/"/);
    assert.match(hub, /href="https:\/\/asklightspeed\.netlify\.app\/"/);
    assert.match(reorder, /Download Excel \(all tabs\)/);
    for (const label of ["Reorder list", "Blocked", "By supplier", "Dead stock"]) {
      assert.ok(reorder.includes(label), label);
    }
    assert.match(reorder, /xlsx/);
    assert.doesNotMatch(reorder, /\/rest\/v1\//);
    const hosts = (hub + reorder + authJs).match(/[a-z0-9-]+\.supabase\.co/g) || [];
    assert.deepEqual([...new Set(hosts)], ["qdfwovnhlaaocgawukto.supabase.co"]);
    assert.doesNotMatch(hub + reorder + authJs + source, /sb_secret_[A-Za-z0-9_-]+/);
    assert.match(toml, /publish\s*=\s*"\."/);
    assert.match(toml, /functions\s*=\s*"netlify\/functions"/);
    assert.match(toml, /SECRETS_SCAN_OMIT_KEYS\s*=\s*"[^"]*STFD_SUPABASE_ANON_KEY/);
    assert.match(toml, /SECRETS_SCAN_OMIT_PATHS\s*=\s*"test\/\*\*"/);
    assert.doesNotMatch(toml, /from\s*=\s*"\/reorderengine"/);
    assert.doesNotMatch(toml, /to\s*=\s*"\/reorderengine\/"/);
    assert.doesNotMatch(reorder + "\n" + hub + "\n" + authJs, /location\.(href|replace|assign)/);
    assert.doesNotMatch(toml, /asklightspeed\.netlify\.app\/:splat/);
    assert.doesNotMatch(toml, /to\s*=\s*"https:\/\/asklightspeed/);

    setEnv({});
    let calls = [];
    global.fetch = async () => { calls.push("fetch"); return jsonRes(500, {}); };
    let res = await get({});
    assert.equal(res.statusCode, 503);
    assert.equal(calls.length, 0);
    assert.match(JSON.parse(res.body).error, /unavailable/i);
    assert.equal(res.headers["cache-control"], "no-store");
    res = await get({ authorization: `Bearer ${TOK}` });
    assert.equal(res.statusCode, 503);
    assert.equal(calls.length, 0);

    configured({ STFD_SUPABASE_URL: "http://qdfwovnhlaaocgawukto.supabase.co" });
    res = await get({ authorization: `Bearer ${TOK}` });
    assert.equal(res.statusCode, 503);
    assert.equal(calls.length, 0);

    configured({ STFD_SUPABASE_URL: "https://user:pass@qdfwovnhlaaocgawukto.supabase.co" });
    res = await get({ authorization: `Bearer ${TOK}` });
    assert.equal(res.statusCode, 503);

    configured({ STFD_SUPABASE_URL: "not a url" });
    res = await get({ authorization: `Bearer ${TOK}` });
    assert.equal(res.statusCode, 503);

    configured({ STFD_SUPABASE_URL: "https://evil.example/qdfwovnhlaaocgawukto.supabase.co" });
    res = await get({ authorization: `Bearer ${TOK}` });
    assert.equal(res.statusCode, 503);
    assert.equal(calls.length, 0);

    configured({ STFS_SUPABASE_URL: "" });
    res = await get({ authorization: `Bearer ${TOK}` });
    assert.equal(res.statusCode, 503);
    assert.match(JSON.parse(res.body).error, /reorder data/i);
    assert.equal(calls.length, 0);

    configured({ STFS_SUPABASE_SERVICE_KEY: "sb_publishable_not_a_service_key" });
    res = await get({});
    assert.equal(res.statusCode, 503);
    assert.equal(calls.length, 0);

    configured();
    calls = [];
    res = await get({});
    assert.equal(res.statusCode, 401);
    assert.equal(JSON.parse(res.body).error, "Please sign in.");
    assert.equal(calls.length, 0);

    res = await get({ authorization: "Bearer not-a-jwt" });
    assert.equal(res.statusCode, 401);
    res = await get({ authorization: `Bearer ${TOK}\r\nX-Evil: 1` });
    assert.equal(res.statusCode, 401);
    assert.equal(calls.length, 0);

    global.fetch = async (url, init) => {
      calls.push({ url: String(url), init });
      return jsonRes(401, { message: `bad ${TOK}` });
    };
    res = await get({ Authorization: `bearer ${TOK}` });
    assert.equal(res.statusCode, 401);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://qdfwovnhlaaocgawukto.supabase.co/auth/v1/user");
    assert.equal(calls[0].init.redirect, "manual");
    assert.equal(calls[0].init.headers.apikey, "sb_publishable_test_key");
    assert.equal(calls[0].init.headers.Authorization, `Bearer ${TOK}`);
    assert.doesNotMatch(JSON.stringify(calls[0].init), /test-service-key/);
    assert.doesNotMatch(res.body, new RegExp(TOK));

    for (const status of [302, 500, 503]) {
      calls = [];
      global.fetch = async () => jsonRes(status, { message: "down" });
      res = await get({ authorization: `Bearer ${TOK}` });
      assert.equal(res.statusCode, 503, `auth status ${status}`);
      assert.match(JSON.parse(res.body).error, /Sign-in check/);
    }
    global.fetch = async () => { throw Object.assign(new Error("socket hang up"), { name: "TypeError" }); };
    res = await get({ authorization: `Bearer ${TOK}` });
    assert.equal(res.statusCode, 503);
    global.fetch = async () => ({ ok: true, status: 200, json: async () => { throw new Error("nope"); }, text: async () => "<html>" });
    res = await get({ authorization: `Bearer ${TOK}` });
    assert.equal(res.statusCode, 503);

    calls = [];
    global.fetch = async (url, init) => {
      calls.push({ url: String(url), init });
      return jsonRes(200, user({ id: "multi-user", app_metadata: {}, email: "person@example.com" }));
    };
    res = await get({}, { headers: {}, multiValueHeaders: { Authorization: [`Bearer ${TOK}`] } });
    assert.equal(res.statusCode, 403);
    assert.equal(calls.length, 1);
    assert.doesNotMatch(res.body, /person@example.com/);
    assert.equal(JSON.parse(res.body).error, "Your account doesn't have access to the Reorder Engine yet. Ask Sarah to add you.");

    async function asUser(u) {
      calls = [];
      global.fetch = async (url, init) => {
        calls.push({ url: String(url), init });
        if (String(url).includes("/auth/v1/user")) return jsonRes(200, u);
        throw new Error("data should not be called");
      };
      return get({ authorization: `Bearer ${TOK}` });
    }

    configured();
    res = await asUser(user({ app_metadata: { apps: ["other", " reorder "] } }));
    assert.equal(res.statusCode, 503);
    assert.equal(calls.filter((c) => String(c.url).includes("/rest/v1/")).length, 5);

    res = await asUser(user({ app_metadata: { apps: "AskLightspeed" } }));
    assert.equal(res.statusCode, 503);

    res = await asUser(user({ app_metadata: { apps: "stfd, asklightspeed" } }));
    assert.equal(res.statusCode, 503);

    res = await asUser(user({ app_metadata: { apps: ["asklightspeed-admin"] }, email: "nope@example.com" }));
    assert.equal(res.statusCode, 403);

    res = await asUser(user({ app_metadata: { apps: ["reorder-extra"] } }));
    assert.equal(res.statusCode, 403);

    res = await asUser(user({
      app_metadata: {},
      user_metadata: { apps: ["reorder", "asklightspeed"] },
    }));
    assert.equal(res.statusCode, 403);
    assert.equal(calls.length, 1);

    res = await asUser(user({ id: "", app_metadata: { apps: ["reorder"] } }));
    assert.equal(res.statusCode, 401);

    res = await asUser(user({ id: "   ", app_metadata: { apps: ["asklightspeed"] } }));
    assert.equal(res.statusCode, 401);

    configured({ REORDER_ALLOWED_EMAILS: " Taylor@SouthTexasFAD.com \n phillip@southtexasfad.com; yvonne@southtexasfad.com " });
    res = await asUser(user({ email: "taylor@southtexasfad.com", app_metadata: {} }));
    assert.equal(res.statusCode, 503);
    res = await asUser(user({ email: "PHILLIP@southtexasfad.com", app_metadata: { apps: [] } }));
    assert.equal(res.statusCode, 503);
    res = await asUser(user({ email: "aylor@southtexasfad.com", app_metadata: {} }));
    assert.equal(res.statusCode, 403);
    res = await asUser(user({ email: "", app_metadata: {} }));
    assert.equal(res.statusCode, 403);

    configured({ REORDER_ALLOWED_EMAILS: "*" });
    res = await asUser(user({ email: "a@b.com", app_metadata: {} }));
    assert.equal(res.statusCode, 403);

    configured();
    const data = payload();
    calls = [];
    global.fetch = async (url, init) => {
      calls.push({ url: String(url), init });
      const u = String(url);
      if (u.includes("/auth/v1/user")) return jsonRes(200, user({ app_metadata: { apps: ["asklightspeed"] } }));
      if (u.includes("v_reorder_run_latest")) return jsonRes(200, data.runs);
      if (u.includes("v_reorder_priority")) return jsonRes(200, data.recs);
      if (u.includes("v_reorder_exceptions_latest")) return jsonRes(200, data.exceptions);
      if (u.includes("v_reorder_by_supplier")) return jsonRes(200, data.suppliers);
      if (u.includes("v_dead_stock")) return jsonRes(200, data.dead);
      throw new Error("unexpected " + u);
    };
    res = await get({ authorization: `Bearer ${TOK}` });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(JSON.parse(res.body), data);
    const urls = calls.map((c) => c.url);
    for (const view of VIEWS) assert.ok(urls.some((u) => u.endsWith(view)), view);
    const authCall = calls.find((c) => c.url.includes("/auth/v1/user"));
    const dataCalls = calls.filter((c) => c.url.includes("/rest/v1/"));
    assert.equal(dataCalls.length, 5);
    assert.equal(authCall.init.headers.Authorization, `Bearer ${TOK}`);
    for (const call of dataCalls) {
      assert.equal(call.init.headers.apikey, "test-service-key");
      assert.equal(call.init.headers["User-Agent"], "stfs-reorder-data");
      assert.equal(call.init.headers.Authorization, undefined);
      assert.equal(call.init.redirect, "manual");
      assert.doesNotMatch(JSON.stringify(call.init.headers), new RegExp(TOK));
    }

    configured({ STFS_SUPABASE_SERVICE_KEY: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload.sig" });
    calls = [];
    global.fetch = async (url, init) => {
      calls.push({ url: String(url), init });
      const u = String(url);
      if (u.includes("/auth/v1/user")) return jsonRes(200, user());
      return jsonRes(200, []);
    };
    res = await get({ authorization: `Bearer ${TOK}` });
    assert.equal(res.statusCode, 200);
    const legacy = calls.find((c) => c.url.includes("/rest/v1/"));
    assert.equal(legacy.init.headers.Authorization, "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload.sig");
    assert.doesNotMatch(legacy.init.headers.Authorization, new RegExp(TOK));

    configured();
    global.fetch = async (url) => {
      if (String(url).includes("/auth/v1/user")) return jsonRes(200, user());
      if (String(url).includes("v_reorder_priority")) {
        return jsonRes(500, { message: "relation missing", key: "test-service-key", marker: "SECRET_ROW_MARKER" });
      }
      return jsonRes(200, [{ marker: "SECRET_ROW_MARKER" }]);
    };
    res = await get({ authorization: `Bearer ${TOK}` });
    assert.equal(res.statusCode, 503);
    assert.equal(JSON.parse(res.body).error, "Could not load the reorder data. Try again shortly.");
    assert.doesNotMatch(res.body, /SECRET_ROW_MARKER/);
    assert.doesNotMatch(res.body, /test-service-key/);
    assert.doesNotMatch(res.body, /relation missing/);
    assert.doesNotMatch(res.body, /sign in/i);

    global.fetch = async (url) => {
      if (String(url).includes("/auth/v1/user")) return jsonRes(200, user());
      return jsonRes(401, { message: "Invalid API key" });
    };
    res = await get({ authorization: `Bearer ${TOK}` });
    assert.equal(res.statusCode, 503);
    assert.match(JSON.parse(res.body).error, /reorder data/i);

    global.fetch = async (url) => {
      if (String(url).includes("/auth/v1/user")) return jsonRes(200, user());
      return jsonRes(302, "");
    };
    res = await get({ authorization: `Bearer ${TOK}` });
    assert.equal(res.statusCode, 503);

    global.fetch = async (url) => {
      if (String(url).includes("/auth/v1/user")) return jsonRes(200, user());
      return jsonRes(200, { not: "a list" });
    };
    res = await get({ authorization: `Bearer ${TOK}` });
    assert.equal(res.statusCode, 503);

    global.fetch = async (url) => {
      if (String(url).includes("/auth/v1/user")) return jsonRes(200, user());
      throw Object.assign(new Error("reset"), { name: "AbortError" });
    };
    res = await get({ authorization: `Bearer ${TOK}` });
    assert.equal(res.statusCode, 503);

    res = await handler({ httpMethod: "POST", headers: { authorization: `Bearer ${TOK}` }, body: "{}" });
    assert.equal(res.statusCode, 405);
    res = await handler({ httpMethod: "GET" });
    assert.equal(res.statusCode, 401);
  } finally {
    console.error = origError;
    global.fetch = origFetch;
    for (const key of KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
});
