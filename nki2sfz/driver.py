"""Glue between the web page and nki2sfz.py, run inside Pyodide.

The page mounts the chosen library under /nki_lib with empty placeholder files,
so path lookups work without loading 1 GB+ of samples into memory. Real
sample bytes are written one at a time just before they are decoded.
"""

import json
import os

import nki2sfz as n

LIB = "/nki_lib"
OUT = "/nki_out"

_indexes = {}
_used_names = set()
_current = None


def reset():
    global _current
    _indexes.clear()
    _used_names.clear()
    _current = None


def prepare(nki_rel):
    """Parse one instrument; return the samples it needs as JSON."""
    global _current
    nki_path = os.path.join(LIB, nki_rel)
    root = n.find_library_root(nki_path)
    if root not in _indexes:
        _indexes[root] = n.build_sample_index(root)
    programs, files = n.read_nki(nki_path)
    nki_dir = os.path.dirname(nki_path)

    used = sorted({files[z.file_id] for p in programs for z in p.zones
                   if 0 <= z.file_id < len(files)})
    warnings, samples, sample_map = [], [], {}
    for ref in used:
        src = n.resolve_sample(ref, nki_dir, root, _indexes[root])
        if src is None:
            warnings.append(f"sample not found: {ref}")
            continue
        dst = n.sample_destination(src, root, os.path.join(OUT, "samples"), "wav")
        sample_map[ref] = dst
        samples.append({"src": os.path.relpath(src, LIB), "dst": os.path.relpath(dst, OUT)})
    _current = (nki_path, root, programs, files, sample_map, warnings)
    return json.dumps({"samples": samples, "warnings": warnings})


def decode(src_rel, dst_rel):
    """Decode one sample from /nki_lib to /nki_out; returns the written path under /nki_out."""
    written = n.decode_sample(os.path.join(LIB, src_rel), os.path.join(OUT, dst_rel))
    return os.path.relpath(written, OUT)


def finish():
    """Build the .sfz text for the prepared instrument."""
    nki_path, root, programs, files, sample_map, warnings = _current
    results = []
    for i, prog in enumerate(programs):
        text, regions = n.sfz_for_program(prog, files, nki_path, OUT, sample_map, warnings)
        name = n.sfz_file_name(nki_path, prog, i, len(programs), root, _used_names)
        results.append({"name": name + ".sfz", "text": text, "regions": regions})
    return json.dumps({"files": results, "warnings": warnings})
