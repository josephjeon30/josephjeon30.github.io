(function () {
  var $ = function (id) { return document.getElementById(id); };

  // --- worker RPC -----------------------------------------------------------
  var worker = new Worker("worker.js", { type: "module" });
  var nextId = 1, pending = {};
  worker.onmessage = function (ev) {
    var p = pending[ev.data.id];
    delete pending[ev.data.id];
    if (ev.data.error) p.reject(new Error(ev.data.error));
    else p.resolve(ev.data.result);
  };
  worker.onerror = function (ev) {
    setStatus("Could not start the converter: " + (ev.message || "worker error"), true);
  };
  function call(cmd) {
    var args = Array.prototype.slice.call(arguments, 1);
    return new Promise(function (resolve, reject) {
      var id = nextId++;
      pending[id] = { resolve: resolve, reject: reject };
      worker.postMessage({ id: id, cmd: cmd, args: args });
    });
  }

  setStatus("Loading Python (first visit takes a few seconds)…");
  var pythonReady = call("ready").then(function () {
    setStatus("Ready. Choose a library folder.");
  }, function (err) {
    setStatus("Failed to load Python: " + err.message, true);
  });

  // --- UI state ---------------------------------------------------------------
  var entries = [];   // [{rel, file}]
  var nkis = [];      // library-relative .nki paths
  var libraryName = "";
  var chosenSet = new Set(); // ticked instruments, kept across filtering

  function setStatus(text, isError) {
    var s = $("status");
    s.textContent = text;
    s.className = "form-msg" + (isError ? " error" : "");
  }

  function log(line) {
    var el = $("log");
    el.hidden = false;
    el.textContent += line + "\n";
    el.scrollTop = el.scrollHeight;
  }

  var canSaveToFolder = typeof window.showDirectoryPicker === "function";
  $("zip-choice").hidden = !canSaveToFolder;
  $("dest-hint").textContent = canSaveToFolder
    ? "You'll be asked where to save. Files are written straight into that folder."
    : "Your browser will download a .zip. For big libraries, Chrome or Edge can save straight into a folder instead.";

  $("folder").addEventListener("change", function () {
    var list = Array.prototype.slice.call(this.files);
    entries = list
      .filter(function (f) { return !/(^|\/)\.DS_Store$/.test(f.webkitRelativePath); })
      .map(function (f) { return { rel: f.webkitRelativePath, file: f }; });
    nkis = entries.map(function (e) { return e.rel; })
      .filter(function (r) { return r.toLowerCase().endsWith(".nki"); })
      .sort();
    libraryName = entries.length ? entries[0].rel.split("/")[0] : "";
    // Tick the library's own instruments by default, not helper .nki files
    // that sometimes sit among the samples.
    chosenSet = new Set(nkis.filter(function (r) { return /^[^/]+\/Instruments\//i.test(r); }));
    $("filter").value = "";
    $("name").value = libraryName ? libraryName + " SFZ" : "";
    var ncw = entries.filter(function (e) { return /\.ncw$/i.test(e.rel); }).length;
    $("picked").textContent = entries.length
      ? libraryName + ": " + nkis.length + " instruments, " + ncw + " NCW samples"
      : "";
    renderList();
    $("step2").hidden = !nkis.length;
    if (entries.length && !nkis.length) setStatus("No .nki files in that folder.", true);
  });

  $("filter").addEventListener("input", renderList);
  $("all").addEventListener("click", function () { setVisibleChecked(true); });
  $("none").addEventListener("click", function () { setVisibleChecked(false); });

  function renderList() {
    var q = $("filter").value.trim().toLowerCase();
    var box = $("instruments");
    box.innerHTML = "";
    nkis.forEach(function (rel) {
      var short = rel.split("/").slice(1).join("/");
      var row = document.createElement("label");
      row.className = "inst" + (q && short.toLowerCase().indexOf(q) < 0 ? " hide" : "");
      var cb = document.createElement("input");
      cb.type = "checkbox";
      cb.value = rel;
      cb.checked = chosenSet.has(rel);
      cb.addEventListener("change", function () {
        if (cb.checked) chosenSet.add(rel); else chosenSet.delete(rel);
        updateCount();
      });
      row.appendChild(cb);
      row.appendChild(document.createTextNode(" " + short));
      box.appendChild(row);
    });
    updateCount();
  }

  function selected() {
    return nkis.filter(function (r) { return chosenSet.has(r); });
  }

  function setVisibleChecked(on) {
    $("instruments").querySelectorAll("label:not(.hide) input").forEach(function (cb) {
      cb.checked = on;
      if (on) chosenSet.add(cb.value); else chosenSet.delete(cb.value);
    });
    updateCount();
  }

  function updateCount() {
    $("count").textContent = selected().length + " of " + nkis.length + " selected";
  }

  // --- output sinks -----------------------------------------------------------
  function safeName(s) {
    return s.replace(/[\/\\:*?"<>|]+/g, "_").trim() || "SFZ";
  }

  async function folderSink(name) {
    var root = await window.showDirectoryPicker({ mode: "readwrite" });
    var base = await root.getDirectoryHandle(safeName(name), { create: true });
    return {
      where: "the “" + safeName(name) + "” folder you chose",
      write: async function (path, data) {
        var parts = path.split("/"), dir = base;
        for (var i = 0; i < parts.length - 1; i++) dir = await dir.getDirectoryHandle(parts[i], { create: true });
        var fh = await dir.getFileHandle(parts[parts.length - 1], { create: true });
        var w = await fh.createWritable();
        await w.write(data);
        await w.close();
      },
      close: async function () {},
    };
  }

  // Minimal store-only ZIP writer (audio barely compresses anyway).
  var CRC_TABLE = (function () {
    var t = new Uint32Array(256);
    for (var n = 0; n < 256; n++) {
      var c = n;
      for (var k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();
  function crc32(bytes) {
    var c = 0xFFFFFFFF;
    for (var i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  function zipSink(name) {
    var parts = [], central = [], offset = 0, count = 0;
    var enc = new TextEncoder();
    var LIMIT = 4000 * 1024 * 1024;
    return {
      where: "the downloaded " + safeName(name) + ".zip",
      write: async function (path, data) {
        if (typeof data === "string") data = enc.encode(data);
        var fname = enc.encode(safeName(name) + "/" + path);
        if (offset + data.length + 200 > LIMIT)
          throw new Error("the zip would pass 4 GB; select fewer instruments, or use Chrome/Edge to save into a folder");
        var crc = crc32(data);
        var h = new DataView(new ArrayBuffer(30));
        h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, 0x0800, true);
        h.setUint32(14, crc, true); h.setUint32(18, data.length, true); h.setUint32(22, data.length, true);
        h.setUint16(26, fname.length, true);
        parts.push(h.buffer, fname, data);
        var c = new DataView(new ArrayBuffer(46));
        c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true);
        c.setUint16(8, 0x0800, true); c.setUint32(16, crc, true);
        c.setUint32(20, data.length, true); c.setUint32(24, data.length, true);
        c.setUint16(28, fname.length, true); c.setUint32(42, offset, true);
        central.push(c.buffer, fname);
        offset += 30 + fname.length + data.length;
        count++;
      },
      close: async function () {
        var size = central.reduce(function (s, b) { return s + b.byteLength; }, 0);
        var e = new DataView(new ArrayBuffer(22));
        e.setUint32(0, 0x06054b50, true); e.setUint16(8, count, true); e.setUint16(10, count, true);
        e.setUint32(12, size, true); e.setUint32(16, offset, true);
        var blob = new Blob(parts.concat(central, [e.buffer]), { type: "application/zip" });
        var a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = safeName(name) + ".zip";
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(function () { URL.revokeObjectURL(a.href); }, 60000);
      },
    };
  }

  // --- conversion ---------------------------------------------------------------
  $("convert").addEventListener("click", async function () {
    var chosen = selected();
    var name = $("name").value.trim() || (libraryName + " SFZ");
    if (!chosen.length) { setStatus("Tick at least one instrument.", true); return; }

    var sink;
    try {
      sink = canSaveToFolder && !$("as-zip").checked ? await folderSink(name) : zipSink(name);
    } catch (err) {
      if (err.name !== "AbortError") setStatus(err.message, true);
      return;
    }

    var btn = this;
    btn.disabled = true;
    $("folder").disabled = true;
    $("log").textContent = "";
    var bar = $("progress");
    bar.hidden = false; bar.value = 0;
    var problems = 0;

    try {
      await pythonReady;
      setStatus("Reading the library…");
      await call("mount", entries);

      var done = {};
      for (var i = 0; i < chosen.length; i++) {
        var rel = chosen[i];
        var label = "[" + (i + 1) + "/" + chosen.length + "] " + rel.split("/").pop();
        try {
          var plan = await call("prepare", rel);
          var todo = plan.samples.filter(function (s) { return !done[s.dst]; });
          for (var j = 0; j < todo.length; j++) {
            setStatus(label + " — decoding sample " + (j + 1) + " of " + todo.length);
            bar.value = (i + j / Math.max(todo.length, 1)) / chosen.length;
            var out = await call("decode", todo[j].src, todo[j].dst);
            await sink.write(out.path, out.data);
            done[todo[j].dst] = true;
          }
          var res = await call("finish");
          for (var f of res.files) {
            await sink.write(f.name, f.text);
            log(label + " → " + f.name + " (" + f.regions + " regions)");
          }
          res.warnings.slice(0, 5).forEach(function (w) { log("   warning: " + w); });
        } catch (err) {
          problems++;
          log(label + " FAILED: " + err.message);
          if (/4 GB/.test(err.message)) break;
        }
      }
      bar.value = 1;
      setStatus("Saving…");
      await sink.close();
      setStatus(problems
        ? "Finished with " + problems + " problem(s) — see the log. Output is in " + sink.where + "."
        : "Done. Your SFZ files are in " + sink.where + ".", problems > 0);
    } catch (err) {
      setStatus("Stopped: " + err.message, true);
    } finally {
      btn.disabled = false;
      $("folder").disabled = false;
    }
  });
})();
