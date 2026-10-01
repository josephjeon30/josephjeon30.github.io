// manage.js — list, search and delete posts at /write/manage/.
// Lock screen and GitHub helpers live in admin.js; editing happens in /write/?edit=<slug>.

(function () {
  var posts = [];

  function $(id) { return document.getElementById(id); }
  var msg = Admin.msg;

  function formatDate(iso) {
    return new Date(iso + "T00:00:00").toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  }

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function render() {
    var q = $("search").value.trim().toLowerCase();
    var shown = posts.filter(function (p) {
      return !q || (p.title + " " + (p.summary || "") + " " + p.slug).toLowerCase().indexOf(q) !== -1;
    });
    $("count").textContent = "(" + posts.length + ")";

    var list = $("list");
    list.innerHTML = "";
    if (!shown.length) {
      list.appendChild(el("li", "muted", posts.length ? "No posts match “" + q + "”." : "No posts yet."));
      return;
    }

    shown.forEach(function (p) {
      var li = el("li", "manage-item");

      var info = el("div", "manage-info");
      info.appendChild(el("div", "manage-title", p.title));
      info.appendChild(el("div", "post-meta", formatDate(p.date) + " · " + p.slug));
      if (p.summary) info.appendChild(el("div", "manage-summary", p.summary));
      li.appendChild(info);

      var actions = el("div", "manage-actions");
      var view = el("a", "py-run as-link", "View");
      view.href = "../../blog/post.html?p=" + encodeURIComponent(p.slug);
      view.target = "_blank";
      view.rel = "noopener";
      var edit = el("a", "py-run as-link", "Edit");
      edit.href = "../?edit=" + encodeURIComponent(p.slug);
      var del = el("button", "py-run danger", "Delete");
      del.type = "button";
      del.addEventListener("click", function () { deletePost(p, del); });
      actions.appendChild(view);
      actions.appendChild(edit);
      actions.appendChild(del);
      li.appendChild(actions);

      list.appendChild(li);
    });
  }

  function loadPosts() {
    msg("manage-msg", "Loading posts…");
    return Admin.readPosts().then(function (list) {
      posts = list;
      msg("manage-msg", "");
      render();
    }).catch(function (err) { msg("manage-msg", "Couldn't load posts: " + err.message, true); });
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

  $("search").addEventListener("input", render);

  Admin.requireAuth(loadPosts);
})();
