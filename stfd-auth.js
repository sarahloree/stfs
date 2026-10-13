/* STFD sign-in shared by the STFS hub and the Reorder Engine.
   The publishable key only identifies the project; it is safe in the browser.
   The Netlify function verifies the access token server-side. */
(function () {
  const STFD_URL = "https://qdfwovnhlaaocgawukto.supabase.co";
  const STFD_KEY = "sb_publishable_PPhYAvIRNnzv7E86s8yw-g_ltVx0Gvk";
  let onSignedIn = null;
  let onSignedOut = null;
  let auth = null;

  try {
    if (window.supabase && window.supabase.createClient) {
      auth = window.supabase.createClient(STFD_URL, STFD_KEY, {
        auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
      });
    }
  } catch (e) {
    auth = null;
  }

  if (!document.getElementById("stfd-auth-style")) {
    const style = document.createElement("style");
    style.id = "stfd-auth-style";
    style.textContent = [
      "#signin{position:fixed;inset:0;z-index:10000;background:#022b6b;display:flex;align-items:center;justify-content:center;font-family:Archivo,system-ui,sans-serif}",
      "#signin form{background:#fff;color:#141a1d;padding:24px;border-radius:2px;width:min(360px,92vw);display:flex;flex-direction:column;gap:10px}",
      "#signin h2{margin:0;font-size:18px;font-weight:600}",
      "#signin .signin-note{margin:0;font-size:13px;color:#3c4850}",
      "#signin label{font-size:12px;font-weight:600;color:#3c4850}",
      "#signin input{padding:10px;border:1px solid #aab5bc;border-radius:2px;font-size:15px;font-family:inherit}",
      "#signin button{padding:10px;border:0;border-radius:2px;background:#033e98;color:#fff;font-size:15px;cursor:pointer;font-family:inherit}",
      "#signin button:disabled{opacity:.6;cursor:default}",
      "#signin button:focus-visible,#signin input:focus-visible{outline:2px solid #033e98;outline-offset:1px}",
      "#signin .signin-msg{color:#a32020;font-size:13px;min-height:1em}",
      "#whoami{position:fixed;right:12px;bottom:12px;z-index:40;background:#022b6b;color:#fff;font:12px Archivo,system-ui,sans-serif;padding:6px 10px;border-radius:2px;max-width:min(70vw,360px)}",
      "#whoami button{margin-left:8px;background:#033e98;color:#fff;border:0;border-radius:2px;padding:3px 8px;cursor:pointer;font-family:inherit}",
      "#whoami button:focus-visible{outline:2px solid #fff;outline-offset:1px}",
    ].join("");
    document.head.appendChild(style);
  }

  async function accessToken() {
    if (!auth) return "";
    let data;
    try { ({ data } = await auth.auth.getSession()); }
    catch { return ""; }
    let s = data && data.session;
    if (s && (s.expires_at || 0) * 1000 < Date.now() + 60000) {
      try {
        const r = await auth.auth.refreshSession();
        if (r.data && r.data.session) s = r.data.session;
      } catch { /* the server rejects an expired token */ }
    }
    return s && s.access_token ? s.access_token : "";
  }

  function showSignIn(msg) {
    const who = document.getElementById("whoami");
    if (who) who.remove();
    let el = document.getElementById("signin");
    if (!el) {
      el = document.createElement("div");
      el.id = "signin";
      el.innerHTML = '<form>' +
        '<h2>Sign in</h2>' +
        '<p class="signin-note">Same account as the other South Texas Fence tools.</p>' +
        '<label for="si-email">Email</label>' +
        '<input type="email" id="si-email" placeholder="Email" autocomplete="username" required>' +
        '<label for="si-pass">Password</label>' +
        '<input type="password" id="si-pass" placeholder="Password" autocomplete="current-password" required>' +
        '<button type="submit">Sign in</button>' +
        '<div class="signin-msg"></div></form>';
      document.body.appendChild(el);
      el.querySelector("form").onsubmit = async (e) => {
        e.preventDefault();
        const note = el.querySelector(".signin-msg");
        const button = el.querySelector("button");
        if (!auth) {
          note.textContent = "Sign-in is unavailable right now.";
          return;
        }
        button.disabled = true;
        try {
          const { error } = await auth.auth.signInWithPassword({
            email: document.getElementById("si-email").value.trim(),
            password: document.getElementById("si-pass").value,
          });
          if (error) {
            note.textContent = "Sign-in failed. Check your email and password.";
            return;
          }
          el.remove();
          await showWho();
          if (onSignedIn) onSignedIn();
        } catch {
          note.textContent = "Sign-in failed. Check your connection and try again.";
        } finally {
          if (button.isConnected) button.disabled = false;
        }
      };
    }
    el.querySelector(".signin-msg").textContent = msg || "";
    if (!el.contains(document.activeElement)) {
      const email = el.querySelector("#si-email");
      if (email) email.focus();
    }
  }

  async function signOut() {
    if (auth) {
      try { await auth.auth.signOut(); }
      catch { /* still leave the signed-in chrome */ }
    }
    const w = document.getElementById("whoami");
    if (w) w.remove();
    if (onSignedOut) onSignedOut();
  }

  async function showWho() {
    if (!auth) return showSignIn("Sign-in is unavailable right now.");
    let email = "";
    try {
      const { data } = await auth.auth.getSession();
      email = (data && data.session && data.session.user && data.session.user.email) || "";
    } catch {
      return showSignIn("Sign-in is unavailable right now.");
    }
    if (!email) return showSignIn();
    const gate = document.getElementById("signin");
    if (gate) gate.remove();
    let w = document.getElementById("whoami");
    if (!w) {
      w = document.createElement("div");
      w.id = "whoami";
      document.body.appendChild(w);
    }
    w.replaceChildren();
    w.appendChild(document.createTextNode(email));
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = "Sign out";
    b.onclick = async () => {
      await signOut();
      showSignIn();
    };
    w.appendChild(b);
  }

  window.STFD = {
    available: !!auth,
    accessToken,
    showSignIn,
    showWho,
    signOut,
    setOnSignedIn(fn) { onSignedIn = fn; },
    setOnSignedOut(fn) { onSignedOut = fn; },
  };
})();
