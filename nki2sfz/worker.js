// Runs Pyodide + nki2sfz.py off the main thread. The page drives it with
// small RPC calls: mount -> prepare -> decode (per sample) -> finish.
// It's a module worker: importScripts() of the CDN script is blocked in some
// browsers, while importing pyodide.mjs works everywhere modules do.
import { loadPyodide } from "https://cdn.jsdelivr.net/pyodide/v314.0.7/full/pyodide.mjs";
var PYODIDE_URL = "https://cdn.jsdelivr.net/pyodide/v314.0.7/full/";

var py = null;
var files = {}; // library-relative path -> File

var ready = (async function () {
  py = await loadPyodide({ indexURL: PYODIDE_URL });
  await py.loadPackage("numpy");
  for (var name of ["nki2sfz.py", "driver.py"]) {
    var res = await fetch(name, { cache: "no-cache" });
    if (!res.ok) throw new Error("could not load " + name);
    py.FS.writeFile("/home/pyodide/" + name, await res.text());
  }
  py.runPython("import sys; sys.path.insert(0, '/home/pyodide'); import driver");
})();

function readFile(file) {
  return new Uint8Array(new FileReaderSync().readAsArrayBuffer(file));
}

function writeTree(path, data) {
  py.FS.mkdirTree(path.slice(0, path.lastIndexOf("/")));
  py.FS.writeFile(path, data);
}

var handlers = {
  ready: function () { return true; },

  // entries: [{rel, file}] for every file in the chosen folder
  mount: function (entries) {
    py.runPython("import shutil; shutil.rmtree('/nki_lib', True); shutil.rmtree('/nki_out', True); driver.reset()");
    files = {};
    for (var e of entries) {
      files[e.rel] = e.file;
      // Instruments are small, so load them; samples get empty placeholders
      // and are read one at a time when decoded.
      var isNki = e.rel.toLowerCase().endsWith(".nki");
      writeTree("/nki_lib/" + e.rel, isNki ? readFile(e.file) : new Uint8Array(0));
    }
    return true;
  },

  prepare: function (nkiRel) {
    return JSON.parse(py.globals.get("driver").prepare(nkiRel));
  },

  decode: function (src, dst) {
    var srcPath = "/nki_lib/" + src;
    py.FS.writeFile(srcPath, readFile(files[src]));
    var out, written;
    try {
      written = py.globals.get("driver").decode(src, dst);
      out = py.FS.readFile("/nki_out/" + written);
      py.FS.unlink("/nki_out/" + written);
    } finally {
      py.FS.writeFile(srcPath, new Uint8Array(0)); // free the memory again
    }
    return { result: { path: written, data: out }, transfer: [out.buffer] };
  },

  finish: function () {
    return JSON.parse(py.globals.get("driver").finish());
  },
};

self.onmessage = async function (ev) {
  var msg = ev.data;
  try {
    await ready;
    var r = handlers[msg.cmd].apply(null, msg.args || []);
    if (r && r.transfer) self.postMessage({ id: msg.id, result: r.result }, r.transfer);
    else self.postMessage({ id: msg.id, result: r });
  } catch (err) {
    // Python exceptions carry the traceback; the last line is the useful bit.
    var text = String(err && err.message || err).trim().split("\n").pop();
    self.postMessage({ id: msg.id, error: text });
  }
};
