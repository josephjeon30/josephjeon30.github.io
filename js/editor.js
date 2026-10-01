// editor.js — password-locked post editor that publishes via the GitHub API.
//
// Security model: the site is static, so the real gate is the GitHub token.
// The token is encrypted (PBKDF2 → AES-GCM) with the user's password and kept
// only in this browser's localStorage; it's decrypted into memory on unlock.

(function () {
  var OWNER = "josephjeon30";
  var REPO = "josephjeon30.github.io";
  var BRANCH = "main";
  var API = "https://api.github.com/repos/" + OWNER + "/" + REPO;
  var TOKEN_KEY = "blog-editor-token";
  var DRAFT_KEY = "blog-editor-draft";

  var token = null; // decrypted token, memory only
  var posts = []; // contents of blog/posts.json
  var editing = null; // existing post being edited, or null for a new post

  function $(id) { return document.getElementById(id); }
  function show(id) { ["setup", "unlock", "editor"].forEach(function (s) { $(s).hidden = s !== id; }); }
  function msg(id, text, isError) {
    $(id).textContent = text;
    $(id).classList.toggle("error", !!isError);
  }

  // ---------- storage helpers (localStorage can throw in private modes) ----------
  function store(key, value) { try { localStorage.setItem(key, value); } catch (e) {} }
  function load(key) { try { return localStorage.getItem(key); } catch (e) { return null; } }
  function remove(key) { try { localStorage.removeItem(key); } catch (e) {} }

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
          var e = new Error(j.message || "GitHub API error " + r.status);
          e.status = r.status;
          throw e;
        });
      }
      return r.status === 204 ? null : r.json();
    });
  }

  function decodeContent(b64content) {
    return dec.decode(unb64(b64content.replace(/\n/g, "")));
  }

  function readFile(path) {
    return gh("/contents/" + path + "?ref=" + BRANCH).then(function (f) { return decodeContent(f.content); });
  }

  // Confirm the token can push to the repo.
  function verifyToken() {
    return gh("").then(function (repo) {
      if (!repo.permissions || !repo.permissions.push) {
        throw new Error("This token can't write to the repo. Give it Contents: Read and write.");
      }
    });
  }

  // Commit several files in a single commit.
  function commitFiles(files, message) {
    var parent;
    return gh("/git/ref/heads/" + BRANCH)
      .then(function (ref) { parent = ref.object.sha; return gh("/git/commits/" + parent); })
      .then(function (commit) {
        return gh("/git/trees", {
          method: "POST",
          body: {
            base_tree: commit.tree.sha,
            tree: files.map(function (f) { return { path: f.path, mode: "100644", type: "blob", content: f.content }; }),
          },
        });
      })
      .then(function (tree) {
        return gh("/git/commits", { method: "POST", body: { message: message, tree: tree.sha, parents: [parent] } });
      })
      .then(function (commit) {
        return gh("/git/refs/heads/" + BRANCH, { method: "PATCH", body: { sha: commit.sha } });
      });
  }

  // ---------- lock / unlock ----------
  function start() {
    if (load(TOKEN_KEY)) { show("unlock"); $("unlock-pw").focus(); }
    else show("setup");
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
      .then(function (blob) {
        store(TOKEN_KEY, blob);
        $("setup-form").reset();
        openEditor();
      })
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
      .then(function () { $("unlock-form").reset(); openEditor(); })
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
    start();
  });

  $("lock").addEventListener("click", function () {
    token = null;
    $("lock").hidden = true;
    start();
  });

  // ---------- editor ----------
  function slugify(title) {
    return title.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "post";
  }
  function today() {
    var d = new Date();
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  }
  function currentSlug() {
    return editing ? editing.slug : today() + "-" + slugify($("title").value);
  }
  function updateSlugLine() {
    $("slug-line").textContent = "URL: /blog/post.html?p=" + currentSlug();
  }

  var previewTimer = null;
  function schedulePreview() {
    clearTimeout(previewTimer);
    previewTimer = setTimeout(function () { Blog.renderPost($("preview"), $("body").value); }, 500);
  }

  function saveDraft() {
    if (editing) return; // drafts are only for new posts
    store(DRAFT_KEY, JSON.stringify({ title: $("title").value, summary: $("summary").value, body: $("body").value }));
    $("draft-msg").textContent = "Draft saved in this browser";
  }

  function setForm(title, summary, body) {
    $("title").value = title;
    $("summary").value = summary;
    $("body").value = body;
    updateSlugLine();
    Blog.renderPost($("preview"), body);
  }

  function loadPosts() {
    return readFile("blog/posts.json").then(function (text) {
      posts = JSON.parse(text);
      var sel = $("existing");
      sel.length = 1;
      posts.forEach(function (p) {
        var o = document.createElement("option");
        o.value = p.slug;
        o.textContent = "Edit: " + p.title;
        sel.appendChild(o);
      });
    });
  }

  function newPost() {
    editing = null;
    $("existing").value = "";
    $("publish").textContent = "Publish";
    var d = null;
    try { d = JSON.parse(load(DRAFT_KEY) || "null"); } catch (e) {}
    if (d) { setForm(d.title, d.summary, d.body); $("draft-msg").textContent = "Restored your draft"; }
    else {
      setForm("", "", "Write your post here.\n\n```python\nprint(\"Hello from Python!\")\n```\n");
      $("draft-msg").textContent = "";
    }
  }

  function openEditor() {
    show("editor");
    $("lock").hidden = false;
    newPost();
    loadPosts().catch(function (err) { msg("publish-msg", "Couldn't load existing posts: " + err.message, true); });
  }

  $("existing").addEventListener("change", function () {
    var slug = this.value;
    if (!slug) return newPost();
    var post = posts.find(function (p) { return p.slug === slug; });
    msg("publish-msg", "Loading post…");
    readFile("blog/posts/" + slug + ".md").then(function (body) {
      editing = post;
      $("publish").textContent = "Update post";
      $("draft-msg").textContent = "";
      setForm(post.title, post.summary || "", body);
      msg("publish-msg", "");
    }).catch(function (err) { msg("publish-msg", err.message, true); });
  });

  ["title", "summary", "body"].forEach(function (id) {
    $(id).addEventListener("input", function () {
      if (id === "title") updateSlugLine();
      if (id === "body") schedulePreview();
      saveDraft();
    });
  });

  $("body").addEventListener("keydown", function (e) {
    if (e.key === "Tab") { // indent instead of leaving the textarea
      e.preventDefault();
      document.execCommand("insertText", false, "    ");
    }
  });

  $("insert-cell").addEventListener("click", function () {
    var ta = $("body");
    var snippet = "\n```python\n# your code here\n```\n";
    ta.focus();
    ta.setRangeText(snippet, ta.selectionStart, ta.selectionEnd, "end");
    ta.selectionStart = ta.selectionEnd - 5;
    ta.selectionEnd = ta.selectionStart;
    ta.dispatchEvent(new Event("input"));
  });

  $("publish").addEventListener("click", function () {
    var title = $("title").value.trim();
    var body = $("body").value;
    if (!title) return msg("publish-msg", "Add a title first.", true);
    if (!body.trim()) return msg("publish-msg", "The post is empty.", true);

    var slug = currentSlug();
    var btn = this;
    btn.disabled = true;
    msg("publish-msg", "Publishing…");

    // Re-read posts.json right before committing so we don't overwrite other changes.
    readFile("blog/posts.json")
      .then(function (text) {
        var list = JSON.parse(text);
        var existingIdx = list.findIndex(function (p) { return p.slug === slug; });
        if (!editing && existingIdx !== -1) throw new Error("A post with this URL already exists. Change the title.");
        var entry = {
          slug: slug,
          title: title,
          date: editing ? editing.date : today(),
          summary: $("summary").value.trim(),
        };
        if (existingIdx !== -1) list[existingIdx] = entry; else list.unshift(entry);
        list.sort(function (a, b) { return a.date < b.date ? 1 : a.date > b.date ? -1 : 0; });
        return commitFiles([
          { path: "blog/posts/" + slug + ".md", content: body.replace(/\s*$/, "\n") },
          { path: "blog/posts.json", content: JSON.stringify(list, null, 2) + "\n" },
        ], (editing ? "Update post: " : "New post: ") + title).then(function () { return entry; });
      })
      .then(function (entry) {
        if (!editing) remove(DRAFT_KEY);
        var url = "../blog/post.html?p=" + encodeURIComponent(entry.slug);
        $("publish-msg").innerHTML = "";
        msg("publish-msg", "✓ Published. It'll be live in about a minute: ");
        var a = document.createElement("a");
        a.href = url;
        a.target = "_blank";
        a.textContent = "view post";
        $("publish-msg").appendChild(a);
        return loadPosts().then(function () {
          editing = posts.find(function (p) { return p.slug === entry.slug; }) || entry;
          $("existing").value = entry.slug;
          $("publish").textContent = "Update post";
          $("draft-msg").textContent = "";
        });
      })
      .catch(function (err) { msg("publish-msg", "Publish failed: " + err.message, true); })
      .then(function () { btn.disabled = false; });
  });

  start();
})();
