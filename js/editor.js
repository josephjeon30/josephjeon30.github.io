// editor.js — the post editor at /write/. Lock screen and GitHub helpers live in admin.js.
// Open /write/?edit=<slug> to load an existing post.

(function () {
  var DRAFT_KEY = "blog-editor-draft";

  var posts = []; // contents of blog/posts.json
  var projects = []; // contents of projects/projects.json
  var newProjects = []; // projects created here, saved with the next publish
  var NEW_PROJECT = "__new__";
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
    previewTimer = setTimeout(renderPreview, 500);
  }

  // Images uploaded this session aren't on the live site for ~1 minute,
  // so the preview shows them from memory instead.
  var localImages = {}; // site path -> object URL

  function renderPreview() {
    Blog.renderPost($("preview"), $("body").value);
    $("preview").querySelectorAll("img").forEach(function (img) {
      var src = img.getAttribute("src");
      if (localImages[src]) img.src = localImages[src];
    });
  }

  function saveDraft() {
    if (editing) return; // drafts are only for new posts
    store(DRAFT_KEY, JSON.stringify({ title: $("title").value, summary: $("summary").value, body: $("body").value, project: $("project").value }));
    $("draft-msg").textContent = "Draft saved in this browser";
  }

  function fillProjectSelect() {
    var sel = $("project");
    var current = sel.value;
    sel.length = 1;
    projects.concat(newProjects).forEach(function (p) {
      var o = document.createElement("option");
      o.value = p.slug;
      o.textContent = p.title + (newProjects.indexOf(p) !== -1 ? " (new)" : "");
      sel.appendChild(o);
    });
    var add = document.createElement("option");
    add.value = NEW_PROJECT;
    add.textContent = "+ New project…";
    sel.appendChild(add);
    sel.value = current;
    if (sel.value !== current) sel.value = "";
  }

  function setProject(slug) {
    $("project").value = slug || "";
    if ($("project").value !== (slug || "")) $("project").value = ""; // project no longer exists
  }

  function setForm(title, summary, body, project) {
    $("title").value = title;
    $("summary").value = summary;
    $("body").value = body;
    setProject(project);
    updateSlugLine();
    renderPreview();
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
    if (d) { setForm(d.title, d.summary, d.body, d.project); $("draft-msg").textContent = "Restored your draft"; }
    else {
      setForm("", "", "Write your post here.\n\n```python\nprint(\"Hello from Python!\")\n```\n", "");
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
      setForm(post.title, post.summary || "", body, post.project);
      msg("publish-msg", "");
    }).catch(function (err) { msg("publish-msg", err.message, true); });
  }

  function openEditor() {
    var wanted = new URLSearchParams(location.search).get("edit");
    Admin.readProjects()
      .catch(function () { return []; }) // no projects file yet
      .then(function (list) {
        projects = list;
        fillProjectSelect();
        if (!wanted) newPost(); // after projects load, so a draft's project can be restored
        return loadPosts();
      })
      .then(function () { if (wanted) return editPost(wanted); })
      .catch(function (err) { msg("publish-msg", "Couldn't load existing posts: " + err.message, true); });
  }

  $("existing").addEventListener("change", function () {
    if (this.value) editPost(this.value); else newPost();
  });

  $("project").addEventListener("change", function () {
    if (this.value === NEW_PROJECT) {
      var title = (prompt("Name of the new project:") || "").trim();
      var slug = title ? slugify(title) : "";
      var all = projects.concat(newProjects);
      if (!title) this.value = "";
      else if (all.some(function (p) { return p.slug === slug; })) this.value = slug; // already exists
      else {
        newProjects.push({ slug: slug, title: title, summary: "" });
        fillProjectSelect();
        this.value = slug;
      }
    }
    saveDraft();
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

  // ---------- images ----------
  var MAX_WIDTH = 1600; // larger photos are scaled down before upload
  var MAX_BYTES = 10 * 1024 * 1024;

  function fileToBase64(blob) {
    return new Promise(function (resolve, reject) {
      var r = new FileReader();
      r.onload = function () { resolve(String(r.result).split(",")[1]); };
      r.onerror = function () { reject(new Error("Couldn't read the file")); };
      r.readAsDataURL(blob);
    });
  }

  // Scale down big JPEG/PNG/WebP images. GIFs (may be animated) and SVGs pass through.
  function shrinkImage(file) {
    if (!/^image\/(jpeg|png|webp)$/.test(file.type)) return Promise.resolve(file);
    return createImageBitmap(file).then(function (bmp) {
      if (bmp.width <= MAX_WIDTH) return file;
      var canvas = document.createElement("canvas");
      canvas.width = MAX_WIDTH;
      canvas.height = Math.round(bmp.height * MAX_WIDTH / bmp.width);
      canvas.getContext("2d").drawImage(bmp, 0, 0, canvas.width, canvas.height);
      return new Promise(function (resolve) {
        canvas.toBlob(function (b) { resolve(b && b.size < file.size ? b : file); }, file.type, 0.85);
      });
    }).catch(function () { return file; });
  }

  function imageName(file) {
    var ext = { "image/jpeg": "jpg", "image/png": "png", "image/gif": "gif", "image/webp": "webp", "image/svg+xml": "svg" }[file.type] || "png";
    var base = (file.name || "image").replace(/\.[^.]+$/, "");
    if (/^image$/i.test(base)) base = "pasted";
    var rand = Math.random().toString(36).slice(2, 6);
    return today() + "-" + slugify(base).slice(0, 40) + "-" + rand + "." + ext;
  }

  function replaceInBody(from, to) {
    var ta = $("body");
    var i = ta.value.indexOf(from);
    if (i === -1) return;
    ta.setRangeText(to, i, i + from.length, "preserve");
    ta.dispatchEvent(new Event("input"));
  }

  function insertImages(files) {
    files = Array.prototype.filter.call(files, function (f) { return /^image\//.test(f.type); });
    files.forEach(function (file) {
      var name = imageName(file);
      var path = "/blog/images/" + name;
      var alt = (file.name || "image").replace(/\.[^.]+$/, "").replace(/[\[\]]/g, "");
      var placeholder = "![Uploading " + name + "…]()";

      var ta = $("body");
      ta.focus();
      ta.setRangeText("\n" + placeholder + "\n", ta.selectionStart, ta.selectionEnd, "end");
      ta.dispatchEvent(new Event("input"));

      shrinkImage(file)
        .then(function (blob) {
          if (blob.size > MAX_BYTES) throw new Error("image is over 10 MB");
          localImages[path] = URL.createObjectURL(blob);
          return fileToBase64(blob);
        })
        .then(function (b64) { return Admin.uploadFile(path.slice(1), b64, "Add image " + name); })
        .then(function () {
          replaceInBody(placeholder, "![" + alt + "](" + path + ")");
          msg("publish-msg", "✓ Uploaded " + name);
        })
        .catch(function (err) {
          replaceInBody(placeholder, "");
          msg("publish-msg", "Image upload failed (" + (file.name || "pasted image") + "): " + err.message, true);
        });
    });
  }

  $("insert-image").addEventListener("click", function () { $("image-input").click(); });
  $("image-input").addEventListener("change", function () {
    insertImages(this.files);
    this.value = "";
  });

  $("body").addEventListener("paste", function (e) {
    var files = e.clipboardData && e.clipboardData.files;
    if (files && files.length && Array.prototype.some.call(files, function (f) { return /^image\//.test(f.type); })) {
      e.preventDefault();
      insertImages(files);
    }
  });

  $("body").addEventListener("dragover", function (e) {
    if (e.dataTransfer && Array.prototype.indexOf.call(e.dataTransfer.types, "Files") !== -1) {
      e.preventDefault();
      this.classList.add("dragging");
    }
  });
  $("body").addEventListener("dragleave", function () { this.classList.remove("dragging"); });
  $("body").addEventListener("drop", function (e) {
    this.classList.remove("dragging");
    if (e.dataTransfer && e.dataTransfer.files.length) {
      e.preventDefault();
      insertImages(e.dataTransfer.files);
    }
  });

  $("publish").addEventListener("click", function () {
    var title = $("title").value.trim();
    var body = $("body").value;
    if (!title) return msg("publish-msg", "Add a title first.", true);
    if (!body.trim()) return msg("publish-msg", "The post is empty.", true);
    if (body.indexOf("![Uploading ") !== -1) return msg("publish-msg", "Wait for images to finish uploading.", true);

    var slug = currentSlug();
    var btn = this;
    btn.disabled = true;
    msg("publish-msg", "Publishing…");

    // Re-read posts.json right before committing so we don't overwrite other changes.
    var projectSlug = $("project").value;
    var createdProject = newProjects.find(function (p) { return p.slug === projectSlug; });

    Promise.all([Admin.readPosts(), createdProject ? Admin.readProjects().catch(function () { return []; }) : null])
      .then(function (res) {
        var list = res[0];
        var projectList = res[1];
        var existingIdx = list.findIndex(function (p) { return p.slug === slug; });
        if (!editing && existingIdx !== -1) throw new Error("A post with this URL already exists. Change the title.");
        var entry = {
          slug: slug,
          title: title,
          date: editing ? editing.date : today(),
          summary: $("summary").value.trim(),
        };
        if (projectSlug) entry.project = projectSlug;
        if (existingIdx !== -1) list[existingIdx] = entry; else list.unshift(entry);
        list.sort(function (a, b) { return a.date < b.date ? 1 : a.date > b.date ? -1 : 0; });
        var changes = [
          { path: "blog/posts/" + slug + ".md", content: body.replace(/\s*$/, "\n") },
          { path: "blog/posts.json", content: Admin.postsJson(list) },
        ];
        if (createdProject && !projectList.some(function (p) { return p.slug === createdProject.slug; })) {
          projectList.push(createdProject);
          changes.push({ path: "projects/projects.json", content: Admin.postsJson(projectList) });
        }
        return Admin.commitFiles(changes, (editing ? "Update post: " : "New post: ") + title).then(function () { return entry; });
      })
      .then(function (entry) {
        if (!editing) remove(DRAFT_KEY);
        if (createdProject) { // it's a real project now
          newProjects.splice(newProjects.indexOf(createdProject), 1);
          projects.push(createdProject);
          fillProjectSelect();
        }
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
