const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const { handler } = require("../netlify/functions/stfs-hq-redeem.js");

const CODE = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJ1234567";
const CONSUME = "https://inmodrxuivjmypzvygzi.supabase.co/functions/v1/hq-handoff-consume";
const STFD = "https://qdfwovnhlaaocgawukto.supabase.co";
const USER_ID = "11111111-1111-1111-1111-111111111111";
const ENV_KEYS = [
  "HQ_HANDOFF_SECRET",
  "PJCJ_ANON_KEY",
  "HQ_CONSUME_URL",
  "STFD_SUPABASE_URL",
  "STFD_SUPABASE_ANON_KEY",
  "STFD_SUPABASE_SERVICE_KEY",
  "REORDER_ALLOWED_EMAILS",
];

function setEnv(extra) {
  for (const key of ENV_KEYS) delete process.env[key];
  Object.assign(process.env, {
    HQ_HANDOFF_SECRET: "shared-secret",
    PJCJ_ANON_KEY: "pjcj-anon",
    HQ_CONSUME_URL: "",
    STFD_SUPABASE_URL: STFD + "/",
    STFD_SUPABASE_ANON_KEY: "sb_publishable_test_key",
    STFD_SUPABASE_SERVICE_KEY: "test-service-key",
    REORDER_ALLOWED_EMAILS: "",
    ...extra,
  });
}

function jsonRes(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
  };
}

function post(body, extra = {}) {
  return handler({
    httpMethod: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    ...extra,
  });
}

function authUser(over = {}) {
  return {
    id: over.id === undefined ? USER_ID : over.id,
    email: over.email === undefined ? "taylor@southtexasfad.com" : over.email,
    app_metadata: over.app_metadata === undefined ? { apps: ["reorder"] } : over.app_metadata,
    user_metadata: over.user_metadata,
  };
}

function route(handlers) {
  const calls = [];
  global.fetch = async (url, init) => {
    const call = { url: String(url), init };
    calls.push(call);
    const matched = handlers.find((h) => h.match(call.url));
    if (!matched) throw new Error("unexpected " + call.url);
    return matched.run(call);
  };
  return calls;
}

test("hq redeem mints a session only for an allowed existing user", async () => {
  const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  const origFetch = global.fetch;
  const origError = console.error;
  console.error = () => {};
  try {
    assert.equal(CODE.length, 43);

    const root = path.join(__dirname, "..");
    const authJs = fs.readFileSync(path.join(root, "stfd-auth.js"), "utf8");
    const source = fs.readFileSync(path.join(root, "netlify/functions/stfs-hq-redeem.js"), "utf8");
    const reorder = fs.readFileSync(path.join(root, "netlify/functions/reorder-data.js"), "utf8");
    const toml = fs.readFileSync(path.join(root, "netlify.toml"), "utf8");

    assert.ok(authJs.indexOf('params.delete("handoff")') < authJs.indexOf("window.supabase.createClient"));
    assert.match(authJs, /detectSessionInUrl:\s*true/);
    assert.match(authJs, /signInWithPassword/);
    assert.match(authJs, /\/\.netlify\/functions\/stfs-hq-redeem/);
    assert.match(authJs, /setSession/);
    assert.doesNotMatch(authJs, /inmodrxuivjmypzvygzi/);
    assert.doesNotMatch(authJs, /HQ_HANDOFF_SECRET|STFD_SUPABASE_SERVICE_KEY|x-handoff-secret/);
    assert.doesNotMatch(authJs, /location\.(href|replace|assign)/);
    assert.match(authJs, /params\.has\("handoff"\)/);
    assert.doesNotMatch(authJs, /[?&]code=/);
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    assert.doesNotMatch(code, /createUser|inviteUserByEmail|\.signUp\(|signInWithOtp/);
    assert.match(source, /generate_link/);
    assert.match(source, /type:\s*"magiclink"/);
    assert.match(source, /\/auth\/v1\/admin\/users/);
    assert.match(source, /hasReorderApp/);
    assert.match(source, /emailAllowed/);
    assert.match(source, /business:\s*BUSINESS/);
    assert.match(reorder, /exports\.hasReorderApp\s*=\s*hasReorderApp/);
    assert.match(reorder, /exports\.emailAllowed\s*=\s*emailAllowed/);
    assert.match(toml, /HQ_HANDOFF_SECRET/);
    assert.match(toml, /PJCJ_ANON_KEY/);
    assert.match(toml, /STFD_SUPABASE_SERVICE_KEY/);
    assert.match(toml, /HQ_CONSUME_URL/);

    setEnv({});
    let calls = [];
    global.fetch = async () => { calls.push("fetch"); return jsonRes(500, {}); };
    let res = await post({ code: "short" });
    assert.equal(res.statusCode, 401);
    assert.equal(JSON.parse(res.body).error, "Invalid or expired.");
    assert.equal(calls.length, 0);
    assert.equal(res.headers["cache-control"], "no-store");

    res = await post({ code: "a".repeat(42) });
    assert.equal(res.statusCode, 401);
    assert.equal(calls.length, 0);
    res = await post({ code: "a".repeat(42) + "+" });
    assert.equal(res.statusCode, 401);

    setEnv({ HQ_HANDOFF_SECRET: "" });
    res = await post({ code: CODE });
    assert.equal(res.statusCode, 401);
    assert.equal(calls.length, 0);

    setEnv({ STFD_SUPABASE_SERVICE_KEY: "sb_publishable_not_a_service_key" });
    res = await post({ code: CODE });
    assert.equal(res.statusCode, 401);
    assert.equal(calls.length, 0);

    setEnv({ STFD_SUPABASE_URL: "https://zhgfzpztvmazueuxkipm.supabase.co" });
    res = await post({ code: CODE });
    assert.equal(res.statusCode, 401);
    assert.equal(calls.length, 0);

    setEnv({ STFD_SUPABASE_URL: "http://qdfwovnhlaaocgawukto.supabase.co" });
    res = await post({ code: CODE });
    assert.equal(res.statusCode, 401);
    assert.equal(calls.length, 0);

    setEnv({ HQ_CONSUME_URL: "http://consume.test/hq-handoff-consume" });
    res = await post({ code: CODE });
    assert.equal(res.statusCode, 401);
    assert.equal(calls.length, 0);

    setEnv({ PJCJ_ANON_KEY: "sb_secret_not_for_the_browser" });
    res = await post({ code: CODE });
    assert.equal(res.statusCode, 401);
    assert.equal(calls.length, 0);

    setEnv();
    calls = route([
      {
        match: (url) => url === CONSUME,
        run: () => jsonRes(200, { email: "Taylor@SouthTexasFAD.com", app_key: "stfs_reorder" }),
      },
      {
        match: (url) => url.includes("/auth/v1/admin/users"),
        run: () => jsonRes(200, { users: [authUser()] }),
      },
      {
        match: (url) => url.includes("/admin/generate_link"),
        run: () => jsonRes(200, { properties: { hashed_token: "hashed-otp" } }),
      },
      {
        match: (url) => url.endsWith("/auth/v1/verify"),
        run: () => jsonRes(200, {
          access_token: "access",
          refresh_token: "refresh",
          expires_at: 1893456000,
          user: {
            id: USER_ID,
            email: "taylor@southtexasfad.com",
            app_metadata: { apps: ["reorder"] },
            user_metadata: { must_not_leak: true },
          },
        }),
      },
    ]);
    res = await post({ code: CODE, business: "STFD", email: "evil@example.com" });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(JSON.parse(res.body), {
      access_token: "access",
      refresh_token: "refresh",
      expires_at: 1893456000,
      user: {
        id: USER_ID,
        email: "taylor@southtexasfad.com",
        app_metadata: { apps: ["reorder"] },
      },
    });
    assert.equal(Object.hasOwn(JSON.parse(res.body).user, "user_metadata"), false);
    assert.doesNotMatch(res.body, /must_not_leak|hashed-otp|shared-secret|test-service-key/);
    assert.equal(calls.length, 4);
    assert.equal(calls[0].url, CONSUME);
    assert.equal(calls[0].init.method, "POST");
    assert.equal(calls[0].init.redirect, "manual");
    assert.equal(calls[0].init.headers.apikey, "pjcj-anon");
    assert.equal(calls[0].init.headers["x-handoff-secret"], "shared-secret");
    assert.equal(calls[0].init.headers["Content-Type"], "application/json");
    assert.deepEqual(JSON.parse(calls[0].init.body), { code: CODE, business: "STFS" });
    assert.doesNotMatch(JSON.stringify(calls[0].init.headers), /test-service-key/);
    assert.equal(calls[1].url, STFD + "/auth/v1/admin/users?page=1&per_page=200");
    assert.equal(calls[1].init.headers.Authorization, "Bearer test-service-key");
    assert.equal(calls[1].init.redirect, "manual");
    assert.equal(JSON.parse(calls[2].init.body).type, "magiclink");
    assert.equal(JSON.parse(calls[2].init.body).email, "taylor@southtexasfad.com");
    assert.equal(calls[2].init.headers.Authorization, "Bearer test-service-key");
    assert.deepEqual(JSON.parse(calls[3].init.body), { type: "magiclink", token_hash: "hashed-otp" });
    assert.equal(calls[3].init.headers.apikey, "sb_publishable_test_key");
    assert.equal(calls[3].init.headers.Authorization, "Bearer sb_publishable_test_key");
    assert.doesNotMatch(calls[3].init.headers.Authorization, /test-service-key/);

    setEnv({ HQ_CONSUME_URL: "https://consume.test/hq-handoff-consume" });
    calls = route([
      { match: (url) => url.startsWith("https://consume.test/"), run: () => jsonRes(401, { error: "no" }) },
    ]);
    res = await post({ code: CODE });
    assert.equal(res.statusCode, 401);
    assert.equal(calls[0].url, "https://consume.test/hq-handoff-consume");
    assert.equal(calls.length, 1);

    async function expectNoMint(consumeBody, userBody, env) {
      setEnv(env);
      const seen = route([
        {
          match: (url) => url.includes("hq-handoff-consume"),
          run: () => jsonRes(200, consumeBody),
        },
        {
          match: (url) => url.includes("/admin/users"),
          run: () => jsonRes(200, { users: userBody }),
        },
        {
          match: (url) => url.includes("generate_link") || url.endsWith("/verify"),
          run: () => { throw new Error("minted"); },
        },
      ]);
      const denied = await post({ code: CODE });
      assert.equal(denied.statusCode, 401);
      assert.deepEqual(JSON.parse(denied.body), { error: "Invalid or expired." });
      assert.doesNotMatch(denied.body, new RegExp(CODE));
      assert.equal(seen.some((c) => c.url.includes("generate_link")), false);
      return seen;
    }

    let seen = await expectNoMint(
      { email: "nobody@example.com", app_key: "stfs_reorder" },
      [authUser()]
    );
    assert.equal(seen.some((c) => c.url.includes("/admin/users")), true);

    seen = await expectNoMint(
      { email: "taylor@southtexasfad.com.extra", app_key: "stfs_reorder" },
      [authUser()]
    );
    assert.equal(seen.filter((c) => c.url.includes("generate_link")).length, 0);

    seen = await expectNoMint(
      { email: "taylor@southtexasfad.com", app_key: "stfs_reorder" },
      [authUser({ app_metadata: {}, user_metadata: { apps: ["reorder", "asklightspeed"] } })]
    );
    assert.equal(seen.some((c) => c.url.includes("/admin/users")), true);

    await expectNoMint(
      { email: "taylor@southtexasfad.com", app_key: "stfs_reorder" },
      [authUser({ app_metadata: { apps: ["asklightspeed-admin"] } })]
    );
    await expectNoMint(
      { email: "taylor@southtexasfad.com", app_key: "Not A Key" },
      [authUser()]
    );
    seen = await expectNoMint(
      { email: "taylor@southtexasfad.com", app_key: "Not A Key" },
      [authUser()]
    );
    assert.equal(seen.some((c) => c.url.includes("/admin/users")), false);

    setEnv({ REORDER_ALLOWED_EMAILS: " Taylor@SouthTexasFAD.com \n phillip@southtexasfad.com " });
    calls = route([
      {
        match: (url) => url.includes("hq-handoff-consume"),
        run: () => jsonRes(200, { email: "taylor@southtexasfad.com", app_key: "reorder" }),
      },
      {
        match: (url) => url.includes("/admin/users"),
        run: () => jsonRes(200, { users: [authUser({ app_metadata: {} })] }),
      },
      {
        match: (url) => url.includes("generate_link"),
        run: () => jsonRes(200, { properties: { hashed_token: "hashed-otp" } }),
      },
      {
        match: (url) => url.endsWith("/auth/v1/verify"),
        run: () => jsonRes(200, {
          access_token: "access",
          refresh_token: "refresh",
          expires_at: 1,
          user: authUser({ app_metadata: {} }),
        }),
      },
    ]);
    res = await post({ code: CODE });
    assert.equal(res.statusCode, 200);
    assert.equal(calls.some((c) => c.url.includes("generate_link")), true);

    setEnv();
    calls = route([
      {
        match: (url) => url.includes("hq-handoff-consume"),
        run: () => jsonRes(200, { email: "taylor@southtexasfad.com", app_key: "asklightspeed" }),
      },
      {
        match: (url) => url.includes("/admin/users?page=1"),
        run: () => jsonRes(200, { users: Array.from({ length: 200 }, (_, i) => authUser({
          id: "other-" + i,
          email: "other" + i + "@example.com",
        })) }),
      },
      {
        match: (url) => url.includes("/admin/users?page=2"),
        run: () => jsonRes(200, { users: [authUser({ email: "Taylor@SouthTexasFAD.com", app_metadata: { apps: "AskLightspeed" } })] }),
      },
      {
        match: (url) => url.includes("generate_link"),
        run: (call) => {
          assert.equal(JSON.parse(call.init.body).email, "Taylor@SouthTexasFAD.com");
          return jsonRes(200, { properties: { hashed_token: "hashed-otp" } });
        },
      },
      {
        match: (url) => url.endsWith("/auth/v1/verify"),
        run: () => jsonRes(200, {
          access_token: "access",
          refresh_token: "refresh",
          user: {
            id: USER_ID,
            email: "Taylor@SouthTexasFAD.com",
            app_metadata: { apps: ["asklightspeed"] },
          },
        }),
      },
    ]);
    res = await post({ code: CODE });
    assert.equal(res.statusCode, 200);
    assert.equal(calls.filter((c) => c.url.includes("/admin/users")).length, 2);

    setEnv();
    calls = route([
      {
        match: (url) => url.includes("hq-handoff-consume"),
        run: () => jsonRes(200, { email: "taylor@southtexasfad.com", app_key: "reorder" }),
      },
      {
        match: (url) => url.includes("/admin/users"),
        run: () => jsonRes(200, { users: [authUser()] }),
      },
      {
        match: (url) => url.includes("generate_link"),
        run: () => jsonRes(200, { properties: { hashed_token: "hashed-otp" } }),
      },
      {
        match: (url) => url.endsWith("/auth/v1/verify"),
        run: () => jsonRes(200, {
          access_token: "access",
          refresh_token: "refresh",
          expires_at: 1,
          user: { id: "someone-else", email: "taylor@southtexasfad.com", app_metadata: { apps: ["reorder"] } },
        }),
      },
    ]);
    res = await post({ code: CODE });
    assert.equal(res.statusCode, 401);
    assert.doesNotMatch(res.body, /access/);

    setEnv();
    calls = route([
      {
        match: (url) => url.includes("hq-handoff-consume"),
        run: (_call) => new Promise((_resolve, reject) => {
          reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
        }),
      },
    ]);
    res = await post({ code: CODE });
    assert.equal(res.statusCode, 401);
    assert.equal(calls.length, 1);

    setEnv();
    calls = [];
    global.fetch = async () => { calls.push("fetch"); return jsonRes(200, {}); };
    res = await handler({ httpMethod: "GET", body: JSON.stringify({ code: CODE }) });
    assert.equal(res.statusCode, 405);
    assert.equal(calls.length, 0);
    res = await post("not json");
    assert.equal(res.statusCode, 401);
    assert.equal(calls.length, 0);

    const huge = "x".repeat(5000);
    res = await handler({ httpMethod: "POST", body: huge });
    assert.equal(res.statusCode, 401);
    assert.equal(calls.length, 0);

    res = await handler({
      httpMethod: "POST",
      isBase64Encoded: true,
      body: Buffer.from(JSON.stringify({ code: CODE }), "utf8").toString("base64"),
    });
    assert.equal(res.statusCode, 401);
    assert.equal(calls.length, 1);
  } finally {
    console.error = origError;
    global.fetch = origFetch;
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
});
