// manage.js — manage posts and projects at /write/manage/.
// Lock screen and GitHub helpers live in admin.js; editing a post happens in /write/?edit=<slug>.

(function () {
  var posts = [];
  var projects = [];
  var editingProject = null; // project being edited in the form, or null when adding

  function $(id) { return document.getElementById(id); }
  var msg = Admin.msg;

  function formatDate(iso) {
    return new Date(iso + "T00:00:00").toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  }

  function slugify(title) {
    return title.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "project";
  }

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function link(cls, text, href, newTab) {
    var a = el("a", cls, text);
    a.href = href;
    if (newTab) { a.target = "_blank"; a.rel = "noopener"; }
    return a;
  }

  function button(cls, text, onClick) {
    var b = el("button", cls, text);
    b.type = "button";
    b.addEventListener("click", function () { onClick(b); });
    return b;
  }

  function projectOf(post) {
    return projects.find(function (p) { return p.slug === post.project; });
  }

  function projectUrl(project) {
    return project.url ? "../../" + project.url.replace(/^\//, "") : "../../projects/?p=" + encodeURIComponent(project.slug);
  }

  // ---------- posts ----------
  function renderFilter() {
    var sel = $("project-filter");
    var current = sel.value;
    sel.innerHTML = "";
    [["", "All projects"]].concat(projects.map(function (p) { return [p.slug, p.title]; }), [["__none__", "No project"]])
      .forEach(function (o) {
        var opt = el("option", null, o[1]);
        opt.value = o[0];
        sel.appendChild(opt);
      });
    sel.value = current;
    if (sel.value !== current) sel.value = "";
  }

  function renderPosts() {
    var q = $("search").value.trim().toLowerCase();
    var filter = $("project-filter").value;
    var shown = posts.filter(function (p) {
      var project = projectOf(p);
      if (filter === "__none__" ? project : filter && (!project || project.slug !== filter)) return false;
      return !q || (p.title + " " + (p.summary || "") + " " + p.slug).toLowerCase().indexOf(q) !== -1;
    });
    $("count").textContent = "(" + posts.length + ")";

    var list = $("list");
    list.innerHTML = "";
    if (!shown.length) {
      list.appendChild(el("li", "muted", posts.length ? "No posts match." : "No posts yet."));
      return;
    }

    shown.forEach(function (p) {
      var li = el("li", "manage-item");
      var project = projectOf(p);

      var info = el("div", "manage-info");
      info.appendChild(el("div", "manage-title", p.title));
      var meta = el("div", "post-meta", formatDate(p.date) + " · " + p.slug);
      if (project) {
        meta.appendChild(document.createTextNode(" · "));
        meta.appendChild(el("span", "project-tag", project.title));
      }
      info.appendChild(meta);
      if (p.summary) info.appendChild(el("div", "manage-summary", p.summary));
      li.appendChild(info);

      var actions = el("div", "manage-actions");
      actions.appendChild(link("py-run as-link", "View", "../../blog/post.html?p=" + encodeURIComponent(p.slug), true));
      actions.appendChild(link("py-run as-link", "Edit", "../?edit=" + encodeURIComponent(p.slug)));
      actions.appendChild(button("py-run danger", "Delete", function (btn) { deletePost(p, btn); }));
      li.appendChild(actions);

      list.appendChild(li);
    });
  }

  function deletePost(post, btn) {
    if (!confirm("Delete “" + post.title + "”?\n\nIt will be removed from the site. (It stays in your repo's git history, so it can be recovered.)")) return;
    btn.disabled = true;
    msg("manage-msg", "Deleting “" + post.title + "”…");

    // Re-read posts.json right before committing so we don't overwrite other changes.
    Admin.readPosts()
      .then(function (list) {
        var remaining = list.filter(function (p) { return p.slug !== post.slug; });
        return Admin.commitFiles([
          { path: "blog/posts/" + post.slug + ".md", delete: true },
          { path: "blog/posts.json", content: Admin.postsJson(remaining) },
        ], "Delete post: " + post.title).then(function () { return remaining; });
      })
      .then(function (remaining) {
        posts = remaining;
        render();
        msg("manage-msg", "✓ Deleted “" + post.title + "”. The site updates in about a minute.");
      })
      .catch(function (err) {
        btn.disabled = false;
        msg("manage-msg", "Delete failed: " + err.message, true);
      });
  }

  // ---------- projects ----------
  function renderProjects() {
    $("project-count").textContent = "(" + projects.length + ")";
    var list = $("project-list");
    list.innerHTML = "";
    if (!projects.length) {
      list.appendChild(el("li", "muted", "No projects yet."));
      return;
    }

    projects.forEach(function (project) {
      var li = el("li", "manage-item");
      var n = posts.filter(function (p) { return p.project === project.slug; }).length;

      var info = el("div", "manage-info");
      info.appendChild(el("div", "manage-title", project.title));
      info.appendChild(el("div", "post-meta", n + (n === 1 ? " post" : " posts") + " · " + (project.url || "projects/?p=" + project.slug)));
      if (project.summary) info.appendChild(el("div", "manage-summary", project.summary));
      li.appendChild(info);

      var actions = el("div", "manage-actions");
      actions.appendChild(link("py-run as-link", "View", projectUrl(project), true));
      actions.appendChild(button("py-run", "Edit", function () { startEditProject(project); }));
      actions.appendChild(button("py-run danger", "Delete", function (btn) { deleteProject(project, btn); }));
      li.appendChild(actions);

      list.appendChild(li);
    });
  }

  function resetProjectForm() {
    editingProject = null;
    $("project-form").reset();
    $("project-save").textContent = "Add project";
    $("project-cancel").hidden = true;
  }

  function startEditProject(project) {
    editingProject = project;
    $("project-title").value = project.title;
    $("project-summary").value = project.summary || "";
    $("project-save").textContent = "Save changes";
    $("project-cancel").hidden = false;
    $("project-title").focus();
  }

  function saveProject(e) {
    e.preventDefault();
    var title = $("project-title").value.trim();
    var summary = $("project-summary").value.trim();
    if (!title) return;
    var target = editingProject;
    var slug = target ? target.slug : slugify(title);
    var btn = $("project-save");
    btn.disabled = true;
    msg("manage-msg", "Saving project…");

    Admin.readProjects().catch(function () { return []; })
      .then(function (list) {
        var idx = list.findIndex(function (p) { return p.slug === slug; });
        if (!target && idx !== -1) throw new Error("A project with that name already exists.");
        if (target && idx === -1) throw new Error("That project no longer exists.");
        if (target) { list[idx].title = title; list[idx].summary = summary; } // keeps slug and any custom url
        else list.push({ slug: slug, title: title, summary: summary });
        return Admin.commitFiles(
          [{ path: "projects/projects.json", content: Admin.postsJson(list) }],
          (target ? "Update project: " : "New project: ") + title
        ).then(function () { return list; });
      })
      .then(function (list) {
        projects = list;
        resetProjectForm();
        render();
        msg("manage-msg", "✓ Saved project “" + title + "”. The site updates in about a minute.");
      })
      .catch(function (err) { msg("manage-msg", "Couldn't save project: " + err.message, true); })
      .then(function () { btn.disabled = false; });
  }

  function deleteProject(project, btn) {
    var n = posts.filter(function (p) { return p.project === project.slug; }).length;
    var note = n ? "\n\nIts " + n + (n === 1 ? " post is" : " posts are") + " kept, but will no longer belong to a project." : "";
    if (!confirm("Delete the project “" + project.title + "”?" + note)) return;
    btn.disabled = true;
    msg("manage-msg", "Deleting project “" + project.title + "”…");

    Promise.all([Admin.readProjects(), Admin.readPosts()])
      .then(function (res) {
        var remaining = res[0].filter(function (p) { return p.slug !== project.slug; });
        var changes = [{ path: "projects/projects.json", content: Admin.postsJson(remaining) }];
        var postList = res[1];
        var touched = false;
        postList.forEach(function (p) { if (p.project === project.slug) { delete p.project; touched = true; } });
        if (touched) changes.push({ path: "blog/posts.json", content: Admin.postsJson(postList) });
        return Admin.commitFiles(changes, "Delete project: " + project.title)
          .then(function () { return { projects: remaining, posts: postList }; });
      })
      .then(function (res) {
        projects = res.projects;
        posts = res.posts;
        if (editingProject && editingProject.slug === project.slug) resetProjectForm();
        render();
        msg("manage-msg", "✓ Deleted project “" + project.title + "”. The site updates in about a minute.");
      })
      .catch(function (err) {
        btn.disabled = false;
        msg("manage-msg", "Delete failed: " + err.message, true);
      });
  }

  // ---------- page ----------
  function render() {
    renderFilter();
    renderPosts();
    renderProjects();
  }

  function loadAll() {
    msg("manage-msg", "Loading…");
    return Promise.all([Admin.readPosts(), Admin.readProjects().catch(function () { return []; })])
      .then(function (res) {
        posts = res[0];
        projects = res[1];
        msg("manage-msg", "");
        render();
      })
      .catch(function (err) { msg("manage-msg", "Couldn't load posts: " + err.message, true); });
  }

  $("search").addEventListener("input", renderPosts);
  $("project-filter").addEventListener("change", renderPosts);
  $("project-form").addEventListener("submit", saveProject);
  $("project-cancel").addEventListener("click", resetProjectForm);

  Admin.requireAuth(loadAll);
})();
