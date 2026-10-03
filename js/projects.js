// projects.js — projects and their blog posts, for the public pages.
//
// Projects live in /projects/projects.json; each post in /blog/posts.json may
// name one in its `project` field. On page load this script fills:
//   <div data-project-cards></div>            → a card per project (homepage)
//   <section data-project-posts="slug">       → that project's posts, newest first
// A project's page is its `url` if it has a hand-made one, else /projects/?p=slug.

(function () {
  var cache = null;

  function load() {
    if (!cache) {
      cache = Promise.all([
        fetch("/projects/projects.json", { cache: "no-cache" }).then(function (r) { return r.json(); }),
        fetch("/blog/posts.json", { cache: "no-cache" }).then(function (r) { return r.json(); }),
      ]).then(function (res) { return { projects: res[0], posts: res[1] }; });
    }
    return cache;
  }

  function projectUrl(project) {
    return project.url ? "/" + project.url.replace(/^\//, "") : "/projects/?p=" + encodeURIComponent(project.slug);
  }

  function postUrl(post) {
    return "/blog/post.html?p=" + encodeURIComponent(post.slug);
  }

  function formatDate(iso) {
    return new Date(iso + "T00:00:00").toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
  }

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  // A clickable list of posts. With `projects`, each entry shows its project as a tag.
  function renderPostList(container, posts, projects) {
    var list = el("ul", "post-list");
    posts.forEach(function (p) {
      var li = el("li");
      var a = el("a", null, p.title);
      a.href = postUrl(p);
      li.appendChild(a);

      var meta = el("div", "post-meta", formatDate(p.date));
      var project = projects && projects.find(function (x) { return x.slug === p.project; });
      if (project) {
        meta.appendChild(document.createTextNode(" · "));
        var tag = el("a", "project-tag", project.title);
        tag.href = projectUrl(project);
        meta.appendChild(tag);
      }
      li.appendChild(meta);

      if (p.summary) li.appendChild(el("p", null, p.summary));
      list.appendChild(li);
    });
    container.appendChild(list);
  }

  function fillProjectPosts(section, data) {
    var slug = section.getAttribute("data-project-posts");
    var posts = data.posts.filter(function (p) { return p.project === slug; });
    section.innerHTML = "";
    section.appendChild(el("h2", null, "Posts"));
    if (posts.length) renderPostList(section, posts);
    else section.appendChild(el("p", "muted", "No posts for this project yet."));
  }

  function fillProjectCards(container, data) {
    container.innerHTML = "";
    container.classList.add("cards");
    if (!data.projects.length) {
      container.appendChild(el("p", "muted", "No projects yet."));
      return;
    }
    data.projects.forEach(function (project) {
      var card = el("a", "card");
      card.href = projectUrl(project);
      card.appendChild(el("h3", null, project.title));
      if (project.summary) card.appendChild(el("p", null, project.summary));
      var n = data.posts.filter(function (p) { return p.project === project.slug; }).length;
      if (n) card.appendChild(el("div", "card-meta", n + (n === 1 ? " post" : " posts")));
      container.appendChild(card);
    });
  }

  function init() {
    var cards = document.querySelectorAll("[data-project-cards]");
    var lists = document.querySelectorAll("[data-project-posts]");
    if (!cards.length && !lists.length) return;
    load().then(function (data) {
      cards.forEach(function (c) { fillProjectCards(c, data); });
      lists.forEach(function (s) { fillProjectPosts(s, data); });
    }).catch(function () {
      cards.forEach(function (c) { c.textContent = "Couldn't load projects."; });
      lists.forEach(function (s) { s.textContent = "Couldn't load posts."; });
    });
  }

  window.Projects = {
    load: load,
    projectUrl: projectUrl,
    renderPostList: renderPostList,
    fillProjectPosts: fillProjectPosts,
    fillProjectCards: fillProjectCards,
    formatDate: formatDate,
  };

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
