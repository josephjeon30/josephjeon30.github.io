// admin.js — shared lock screen + GitHub API helpers for the admin pages
// (/write/ and /write/manage/).
//
// Security model: the site is static, so the real gate is the GitHub token.
// The token is encrypted (PBKDF2 → AES-GCM) with the user's password and kept
// in this browser's localStorage. Once unlocked, the decrypted token is held in
// sessionStorage so moving between admin pages in the same tab doesn't re-prompt;
// it's cleared when the tab closes or on Lock.

(function () {
  var OWNER = "josephjeon30";
  var REPO = "josephjeon30.github.io";
  var BRANCH = "main";
  var API = "https://api.github.com/repos/" + OWNER + "/" + REPO;
  var TOKEN_KEY = "blog-editor-token";
  var SESSION_KEY = "blog-editor-session";

  var token = null;

  function $(id) { return document.getElementById(id); }
  function msg(id, text, isError) {
    $(id).textContent = text;
    $(id).classList.toggle("error", !!isError);
  }

  // ---------- storage helpers (storage can throw in private modes) ----------
  function store(key, value, session) { try { (session ? sessionStorage : localStorage).setItem(key, value); } catch (e) {} }
  function load(key, session) { try { return (session ? sessionStorage : localStorage).getItem(key); } catch (e) { return null; } }
  function remove(key, session) { try { (session ? sessionStorage : localStorage).removeItem(key); } catch (e) {} }

  // ---------- crypto ----------
  var enc = new TextEncoder();
  var dec = new TextDecoder();
  function b64(bytes) { return btoa(String.fromCharCode.apply(null, new Uint8Array(bytes))); }
  function unb64(s) { return Uint8Array.from(atob(s), function (c) { return c.charCodeAt(0); }); }

  function deriveKey(password, salt) {
    return crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveKey"])
      .then(function (base) {
        return crypto.subtle.deriveKey(
          { name: "PBKDF2", salt: salt, iterations: 310000, hash: "SHA-256" },
          base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
      });
  }

  function encryptToken(tok, password) {
    var salt = crypto.getRandomValues(new Uint8Array(16));
    var iv = crypto.getRandomValues(new Uint8Array(12));
    return deriveKey(password, salt).then(function (key) {
      return crypto.subtle.encrypt({ name: "AES-GCM", iv: iv }, key, enc.encode(tok));
    }).then(function (ct) {
      return JSON.stringify({ salt: b64(salt), iv: b64(iv), ct: b64(ct) });
    });
  }

  function decryptToken(blob, password) {
    var d = JSON.parse(blob);
    return deriveKey(password, unb64(d.salt)).then(function (key) {
      return crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(d.iv) }, key, unb64(d.ct));
    }).then(function (pt) { return dec.decode(pt); });
  }

  // ---------- GitHub API ----------
  function gh(path, opts) {
    opts = opts || {};
    return fetch(API + path, {
      method: opts.method || "GET",
      headers: {
        Authorization: "Bearer " + token,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      cache: "no-store",
    }).then(function (r) {
      if (!r.ok) {
        return r.json().catch(function () { return {}; }).then(function (j) {
          var text = j.message || "GitHub API error " + r.status;
          if (r.status === 403 && /not accessible by (personal access|integration)/i.test(text)) text = NO_WRITE_MSG;
          if (r.status === 404 && path === "") text = "GitHub couldn't find the repo with this token. Make sure the token has access to " + REPO + ".";
          var e = new Error(text);
          e.status = r.status;
          throw e;
        });
      }
      return r.status === 204 ? null : r.json();
    });
  }

  function readFile(path) {
    return gh("/contents/" + path + "?ref=" + BRANCH).then(function (f) {
      return dec.decode(unb64(f.content.replace(/\n/g, "")));
    });
  }

  function readPosts() {
    return readFile("blog/posts.json").then(JSON.parse);
  }

  var NO_WRITE_MSG = "Your token can read but not write to the repo. On GitHub, edit the token: " +
    "Repository access → Only select repositories → " + REPO + ", and Repository permissions → " +
    "Contents → Read and write. Then try again (the token itself doesn't change).";

  // Confirm the token itself can write. The repo's `permissions` field reflects the
  // account, not the token, so instead create an empty blob: it needs Contents write
  // access and changes nothing (unreferenced blobs are never part of a commit).
  function verifyToken() {
    return gh("").then(function () {
      return gh("/git/blobs", { method: "POST", body: { content: "", encoding: "utf-8" } });
    });
  }

  // Commit several changes in a single commit.
  // Each change is {path, content} to write, or {path, delete: true} to remove.
  // Retries if another commit (e.g. an image upload) lands on the branch mid-way.
  function commitFiles(changes, message, attempt) {
    attempt = attempt || 1;
    var parent;
    return gh("/git/ref/heads/" + BRANCH)
      .then(function (ref) { parent = ref.object.sha; return gh("/git/commits/" + parent); })
      .then(function (commit) {
        return gh("/git/trees", {
          method: "POST",
          body: {
            base_tree: commit.tree.sha,
            tree: changes.map(function (c) {
              return c.delete
                ? { path: c.path, mode: "100644", type: "blob", sha: null }
                : { path: c.path, mode: "100644", type: "blob", content: c.content };
            }),
          },
        });
      })
      .then(function (tree) {
        return gh("/git/commits", { method: "POST", body: { message: message, tree: tree.sha, parents: [parent] } });
      })
      .then(function (commit) {
        return gh("/git/refs/heads/" + BRANCH, { method: "PATCH", body: { sha: commit.sha } });
      })
      .catch(function (err) {
        if (err.status === 422 && attempt < 3) return commitFiles(changes, message, attempt + 1);
        throw err;
      });
  }

  // Upload a binary file (base64-encoded, no data: prefix) in its own commit.
  function uploadFile(path, base64Content, message) {
    return gh("/contents/" + path, {
      method: "PUT",
      body: { message: message, content: base64Content, branch: BRANCH },
    });
  }

  function readProjects() {
    return readFile("projects/projects.json").then(JSON.parse);
  }

  function postsJson(list) {
    return JSON.stringify(list, null, 2) + "\n";
  }

  // ---------- lock screen ----------
  var AUTH_HTML =
    '<section class="panel" id="setup" hidden>' +
    "  <h1>Set up the editor</h1>" +
    '  <p class="muted">Publishing commits to your repo through the GitHub API, so these pages need a' +
    "    <strong>fine-grained personal access token</strong> limited to this one repo." +
    "    It's encrypted with your password and stored only in this browser.</p>" +
    '  <ol class="muted small">' +
    '    <li>Open <a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noopener">GitHub → New fine-grained token</a>.</li>' +
    "    <li>Repository access: <strong>Only select repositories</strong> → <code>" + REPO + "</code>.</li>" +
    "    <li>Permissions → Repository permissions → <strong>Contents: Read and write</strong>.</li>" +
    "    <li>Generate, copy the token, and paste it below.</li>" +
    "  </ol>" +
    '  <form id="setup-form" class="form">' +
    '    <label>GitHub token <input type="password" id="setup-token" autocomplete="off" required></label>' +
    '    <label>Choose a password <input type="password" id="setup-pw" autocomplete="new-password" minlength="8" required></label>' +
    '    <label>Confirm password <input type="password" id="setup-pw2" autocomplete="new-password" minlength="8" required></label>' +
    '    <button class="run-btn" type="submit">Save &amp; unlock</button>' +
    '    <p class="form-msg" id="setup-msg"></p>' +
    "  </form>" +
    "</section>" +
    '<section class="panel" id="unlock" hidden>' +
    "  <h1>Locked</h1>" +
    '  <form id="unlock-form" class="form">' +
    '    <label>Password <input type="password" id="unlock-pw" autocomplete="current-password" required></label>' +
    '    <button class="run-btn" type="submit">Unlock</button>' +
    '    <p class="form-msg" id="unlock-msg"></p>' +
    "  </form>" +
    '  <p class="small muted">Forgot the password or need a new token?' +
    '    <button class="link-btn" id="reset">Forget saved token</button></p>' +
    "</section>";

  // Show the lock screen in #auth until unlocked, then hide it and call onReady().
  // The page's own content (#app) stays hidden until then.
  function requireAuth(onReady) {
    var auth = $("auth");
    auth.innerHTML = AUTH_HTML;

    function showPanel(id) {
      $("setup").hidden = id !== "setup";
      $("unlock").hidden = id !== "unlock";
      auth.hidden = !id;
      $("app").hidden = !!id;
      if ($("lock")) $("lock").hidden = !!id;
    }

    function ready() {
      store(SESSION_KEY, token, true);
      showPanel(null);
      onReady();
    }

    function startLocked() {
      if (load(TOKEN_KEY)) { showPanel("unlock"); $("unlock-pw").focus(); }
      else showPanel("setup");
    }

    $("setup-form").addEventListener("submit", function (e) {
      e.preventDefault();
      var tok = $("setup-token").value.trim();
      var pw = $("setup-pw").value;
      if (pw !== $("setup-pw2").value) return msg("setup-msg", "Passwords don't match.", true);
      msg("setup-msg", "Checking token…");
      token = tok;
      verifyToken()
        .then(function () { return encryptToken(tok, pw); })
        .then(function (blob) { store(TOKEN_KEY, blob); $("setup-form").reset(); ready(); })
        .catch(function (err) {
          token = null;
          msg("setup-msg", err.status === 401 ? "GitHub rejected that token." : err.message, true);
        });
    });

    $("unlock-form").addEventListener("submit", function (e) {
      e.preventDefault();
      msg("unlock-msg", "Unlocking…");
      decryptToken(load(TOKEN_KEY), $("unlock-pw").value)
        .then(function (tok) { token = tok; return verifyToken(); })
        .then(function () { $("unlock-form").reset(); ready(); })
        .catch(function (err) {
          token = null;
          if (err.status === 401) msg("unlock-msg", "Password OK, but the token has expired or been revoked. Use “Forget saved token” and set up a new one.", true);
          else if (err.name === "OperationError") msg("unlock-msg", "Wrong password.", true);
          else msg("unlock-msg", err.message, true);
        });
    });

    $("reset").addEventListener("click", function () {
      if (!confirm("Forget the saved token on this browser? You'll need to paste a token again.")) return;
      remove(TOKEN_KEY);
      remove(SESSION_KEY, true);
      startLocked();
    });

    if ($("lock")) {
      $("lock").addEventListener("click", function () {
        token = null;
        remove(SESSION_KEY, true);
        location.reload();
      });
    }

    // Already unlocked in this tab?
    var sessionToken = load(SESSION_KEY, true);
    if (sessionToken && load(TOKEN_KEY)) {
      token = sessionToken;
      showPanel(null);
      verifyToken().then(onReady).catch(function () {
        token = null;
        remove(SESSION_KEY, true);
        startLocked();
      });
    } else {
      startLocked();
    }
  }

  window.Admin = {
    requireAuth: requireAuth,
    readFile: readFile,
    readPosts: readPosts,
    readProjects: readProjects,
    commitFiles: commitFiles,
    uploadFile: uploadFile,
    postsJson: postsJson,
    msg: msg,
  };
})();
