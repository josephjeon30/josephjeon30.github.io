// pycells.js — turn <pre data-executable> blocks into runnable Python cells.
// Python runs in the visitor's browser via Pyodide (no server needed).
// All cells on a page share one namespace, like a Jupyter notebook.

(function () {
  var PYODIDE_URL = "https://cdn.jsdelivr.net/pyodide/v314.0.7/full/";

  var pyodideReady = null; // Promise, created on first run
  var queue = Promise.resolve(); // runs execute one at a time
  var currentOutput = null; // output element receiving stdout/stderr

  function setStatus(text) {
    var el = document.getElementById("py-status");
    if (el) el.textContent = text;
  }

  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      var s = document.createElement("script");
      s.src = src;
      s.onload = resolve;
      s.onerror = function () { reject(new Error("Failed to load " + src)); };
      document.head.appendChild(s);
    });
  }

  function appendText(out, text, isError) {
    var pre = document.createElement("pre");
    pre.className = isError ? "py-stderr" : "py-stdout";
    pre.textContent = text;
    out.appendChild(pre);
  }

  // Drop Pyodide's internal frames so tracebacks start at the user's code.
  function cleanTraceback(text) {
    var lines = text.trim().split("\n");
    var first = lines.findIndex(function (l) { return /^\s*File "<exec>"/.test(l); });
    if (lines[0].indexOf("Traceback") === 0 && first > 0) {
      return [lines[0]].concat(lines.slice(first)).join("\n");
    }
    return lines.join("\n");
  }

  function getPyodide() {
    if (pyodideReady) return pyodideReady;
    setStatus("Loading Python…");
    pyodideReady = loadScript(PYODIDE_URL + "pyodide.js")
      .then(function () { return loadPyodide({ indexURL: PYODIDE_URL }); })
      .then(function (py) {
        py.setStdout({ batched: function (s) { if (currentOutput) appendText(currentOutput, s); } });
        py.setStderr({ batched: function (s) { if (currentOutput) appendText(currentOutput, s, true); } });
        // Helper that returns any open matplotlib figures as base64 PNGs.
        py.runPython([
          "import os, sys, warnings",
          "os.environ['MPLBACKEND'] = 'AGG'",
          "# plt.show() is fine here: figures are rendered after each run",
          "warnings.filterwarnings('ignore', message='.*non-interactive.*')",
          "def _pycells_figures():",
          "    if 'matplotlib.pyplot' not in sys.modules:",
          "        return []",
          "    import io, base64",
          "    import matplotlib.pyplot as plt",
          "    imgs = []",
          "    for n in plt.get_fignums():",
          "        buf = io.BytesIO()",
          "        with warnings.catch_warnings():",
          "            warnings.simplefilter('ignore')",
          "            plt.figure(n).savefig(buf, format='png', bbox_inches='tight', dpi=110)",
          "        imgs.append(base64.b64encode(buf.getvalue()).decode())",
          "    plt.close('all')",
          "    return imgs",
        ].join("\n"));
        setStatus("✓ Python ready");
        return py;
      })
      .catch(function (err) {
        pyodideReady = null; // allow retry
        setStatus("Failed to load Python: " + err.message);
        throw err;
      });
    return pyodideReady;
  }

  function runCell(cell) {
    queue = queue.then(function () {
      var out = cell.output;
      out.innerHTML = "";
      cell.root.classList.add("py-running");
      cell.button.disabled = true;
      return getPyodide()
        .then(function (py) {
          var code = cell.getCode();
          currentOutput = out;
          return py.loadPackagesFromImports(code, {
              messageCallback: function (msg) { if (/^Loading /.test(msg)) setStatus("Installing packages…"); },
            })
            .then(function () {
              setStatus("✓ Python ready");
              return py.runPythonAsync(code);
            })
            .then(function (result) {
              // Show the value of a trailing expression, like a notebook.
              if (result !== undefined && result !== null) {
                var repr = py.globals.get("repr")(result);
                appendText(out, repr);
                if (result.destroy) result.destroy();
              }
              var figs = py.globals.get("_pycells_figures")().toJs();
              figs.forEach(function (b64) {
                var img = document.createElement("img");
                img.src = "data:image/png;base64," + b64;
                img.alt = "Plot output";
                out.appendChild(img);
              });
            })
            .catch(function (err) {
              appendText(out, cleanTraceback(String(err.message || err)), true);
            });
        })
        .catch(function () { /* load failure already reported in status */ })
        .then(function () {
          currentOutput = null;
          cell.root.classList.remove("py-running");
          cell.button.disabled = false;
        });
    });
    return queue;
  }

  function makeCell(pre) {
    var source = pre.textContent.replace(/^\n+|\s+$/g, "");
    var root = document.createElement("div");
    root.className = "py-cell";

    var textarea = document.createElement("textarea");
    textarea.value = source;
    textarea.spellcheck = false;
    root.appendChild(textarea);

    var bar = document.createElement("div");
    bar.className = "py-bar";
    var button = document.createElement("button");
    button.className = "py-run";
    button.textContent = "▶ Run";
    button.title = "Run (Shift+Enter)";
    bar.appendChild(button);
    root.appendChild(bar);

    var output = document.createElement("div");
    output.className = "py-output";
    root.appendChild(output);

    pre.replaceWith(root);

    var cell = { root: root, button: button, output: output };
    var run = function () { runCell(cell); };

    if (window.CodeMirror) {
      var cm = CodeMirror.fromTextArea(textarea, {
        mode: "python",
        lineNumbers: true,
        indentUnit: 4,
        matchBrackets: true,
        viewportMargin: Infinity,
        extraKeys: {
          "Shift-Enter": run,
          Tab: function (c) { c.replaceSelection("    "); },
        },
      });
      cell.getCode = function () { return cm.getValue(); };
    } else {
      // Fallback: plain textarea if CodeMirror didn't load.
      textarea.rows = source.split("\n").length + 1;
      textarea.addEventListener("keydown", function (e) {
        if (e.key === "Enter" && e.shiftKey) { e.preventDefault(); run(); }
      });
      cell.getCode = function () { return textarea.value; };
    }

    button.addEventListener("click", run);
    return cell;
  }

  function init() {
    var pres = document.querySelectorAll('pre[data-executable="true"]');
    var cells = Array.prototype.map.call(pres, makeCell);

    var runAll = document.getElementById("py-run-all");
    if (runAll) runAll.addEventListener("click", function () { cells.forEach(runCell); });

    // Start downloading Python in the background so the first Run is quick.
    if (cells.length) {
      var warm = function () { getPyodide().catch(function () {}); };
      if ("requestIdleCallback" in window) requestIdleCallback(warm); else setTimeout(warm, 1000);
    }
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
