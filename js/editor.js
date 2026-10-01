// editor.js — the post editor at /write/. Lock screen and GitHub helpers live in admin.js.
// Open /write/?edit=<slug> to load an existing post.

(function () {
  var DRAFT_KEY = "blog-editor-draft";

  var posts = []; // contents of blog/posts.json
  var editing = null; // existing post being edited, or null for a new post

  function $(id) { return document.getElementById(id); }
  var msg = Admin.msg;

  function store(key, value) { try { localStorage.setItem(key, value); } catch (e) {} }
  function load(key) { try { return localStorage.getItem(key); } catch (e) { return null; } }
  function remove(key) { try { localStorage.removeItem(key); } catch (e) {} }

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

  function setUrlParam(slug) {
    var url = new URL(location.href);
    if (slug) url.searchParams.set("edit", slug); else url.searchParams.delete("edit");
    history.replaceState(null, "", url);
  }

  function loadPosts() {
    return Admin.readPosts().then(function (list) {
      posts = list;
      var sel = $("existing");
      sel.length = 1;
      posts.forEach(function (p) {
        var o = document.createElement("option");
        o.value = p.slug;
        o.textContent = "Edit: " + p.title;
        sel.appendChild(o);
      });
      if (editing) sel.value = editing.slug;
    });
  }

  function newPost() {
    editing = null;
    $("existing").value = "";
    $("publish").textContent = "Publish";
    setUrlParam(null);
    var d = null;
    try { d = JSON.parse(load(DRAFT_KEY) || "null"); } catch (e) {}
    if (d) { setForm(d.title, d.summary, d.body); $("draft-msg").textContent = "Restored your draft"; }
    else {
      setForm("", "", "Write your post here.\n\n```python\nprint(\"Hello from Python!\")\n```\n");
      $("draft-msg").textContent = "";
    }
  }

  function editPost(slug) {
    var post = posts.find(function (p) { return p.slug === slug; });
    if (!post) { msg("publish-msg", "Post not found: " + slug, true); return newPost(); }
    msg("publish-msg", "Loading post…");
    return Admin.readFile("blog/posts/" + slug + ".md").then(function (body) {
      editing = post;
      $("existing").value = slug;
      $("publish").textContent = "Update post";
      $("draft-msg").textContent = "";
      setUrlParam(slug);
      setForm(post.title, post.summary || "", body);
      msg("publish-msg", "");
    }).catch(function (err) { msg("publish-msg", err.message, true); });
  }

  function openEditor() {
    var wanted = new URLSearchParams(location.search).get("edit");
    if (!wanted) newPost();
    loadPosts()
      .then(function () { if (wanted) return editPost(wanted); })
      .catch(function (err) { msg("publish-msg", "Couldn't load existing posts: " + err.message, true); });
  }

  $("existing").addEventListener("change", function () {
    if (this.value) editPost(this.value); else newPost();
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
    Admin.readPosts()
      .then(function (list) {
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
        return Admin.commitFiles([
          { path: "blog/posts/" + slug + ".md", content: body.replace(/\s*$/, "\n") },
          { path: "blog/posts.json", content: Admin.postsJson(list) },
        ], (editing ? "Update post: " : "New post: ") + title).then(function () { return entry; });
      })
      .then(function (entry) {
        if (!editing) remove(DRAFT_KEY);
        editing = entry;
        $("publish").textContent = "Update post";
        $("draft-msg").textContent = "";
        setUrlParam(entry.slug);
        $("publish-msg").innerHTML = "";
        msg("publish-msg", "✓ Published. It'll be live in about a minute: ");
        var a = document.createElement("a");
        a.href = "../blog/post.html?p=" + encodeURIComponent(entry.slug);
        a.target = "_blank";
        a.textContent = "view post";
        $("publish-msg").appendChild(a);
        return loadPosts();
      })
      .catch(function (err) { msg("publish-msg", "Publish failed: " + err.message, true); })
      .then(function () { btn.disabled = false; });
  });

  Admin.requireAuth(openEditor);
})();
