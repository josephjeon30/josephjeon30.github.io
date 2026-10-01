// blog.js — shared helpers for rendering blog posts (used by the blog and the editor).
// Posts are Markdown. A ```python fenced block becomes a runnable cell;
// use ```python-static (or any other language) for code that shouldn't run.

(function () {
  function escapeHtml(s) {
    return s.replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  var renderer = {
    code: function (token) {
      var lang = (token.lang || "").trim().toLowerCase();
      if (lang === "python" || lang === "py") {
        return '<pre data-executable="true" data-language="python">' + escapeHtml(token.text) + "</pre>\n";
      }
      return "<pre><code>" + escapeHtml(token.text) + "</code></pre>\n";
    },
  };
  marked.use({ renderer: renderer });

  // Render Markdown into `container` and activate any Python cells.
  function renderPost(container, markdown) {
    container.innerHTML = marked.parse(markdown);
    if (window.PyCells) PyCells.init(container);
  }

  function formatDate(iso) {
    var d = new Date(iso + "T00:00:00");
    return d.toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
  }

  window.Blog = { renderPost: renderPost, formatDate: formatDate, escapeHtml: escapeHtml };
})();
