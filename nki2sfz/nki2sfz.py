#!/usr/bin/env python3
"""Convert Kontakt 5+ instruments (.nki) and their samples to SFZ.

Usage:
    python3 nki2sfz.py INSTRUMENT.nki [MORE.nki ...] -o OUTPUT_DIR
    python3 nki2sfz.py LIBRARY_FOLDER -o OUTPUT_DIR        (converts every .nki inside)

For each instrument an .sfz file is written to OUTPUT_DIR. Samples are written
to OUTPUT_DIR/samples, keeping the library's folder layout; NCW samples are
decoded to WAV because SFZ players cannot read NCW.

Supports non-encrypted Kontakt 5-7 instruments that reference external
samples. It does not handle encrypted (Kontakt Player / NKX) content,
monolith instruments, or KSP script behaviour.

The file formats follow the open-source ConvertWithMoss project
(https://github.com/git-moss/ConvertWithMoss).
"""

import argparse
import io
import math
import os
import shutil
import struct
import sys
import wave

import numpy as np


# ---------------------------------------------------------------------------
# Binary helpers


class Reader:
    def __init__(self, data):
        self.data = data
        self.pos = 0

    def available(self):
        return len(self.data) - self.pos

    def read(self, n):
        if self.pos + n > len(self.data):
            raise EOFError(f"wanted {n} bytes at {self.pos}, only {self.available()} left")
        b = self.data[self.pos:self.pos + n]
        self.pos += n
        return b

    def skip(self, n):
        self.read(n)

    def u8(self):
        return self.read(1)[0]

    def u16(self):
        return struct.unpack("<H", self.read(2))[0]

    def s16(self):
        return struct.unpack("<h", self.read(2))[0]

    def u32(self):
        return struct.unpack("<I", self.read(4))[0]

    def s32(self):
        return struct.unpack("<i", self.read(4))[0]

    def u64(self):
        return struct.unpack("<Q", self.read(8))[0]

    def f32(self):
        return struct.unpack("<f", self.read(4))[0]

    def f64(self):
        return struct.unpack("<d", self.read(8))[0]

    def ascii(self, n):
        return self.read(n).decode("latin-1")

    def utf16(self):
        n = self.u32()
        return self.read(n * 2).decode("utf-16-le", errors="replace")

    def block64(self):
        size = self.u64()
        return self.read(size - 8)


# ---------------------------------------------------------------------------
# FastLZ (used for compressed sub trees in the NI container)


def fastlz_decompress(src, out_size):
    level = (src[0] >> 5) + 1
    out = bytearray()
    ip = 0
    ctrl = src[ip] & 31
    ip += 1
    n = len(src)
    while True:
        if ctrl >= 32:
            length = (ctrl >> 5) - 1
            ofs = (ctrl & 31) << 8
            ref = len(out) - ofs - 1
            if length == 7 - 1:
                if level == 1:
                    length += src[ip]
                    ip += 1
                else:
                    while True:
                        code = src[ip]
                        ip += 1
                        length += code
                        if code != 255:
                            break
            if level == 1:
                ref -= src[ip]
                ip += 1
            else:
                code = src[ip]
                ip += 1
                ref -= code
                if code == 255 and ofs == (31 << 8):
                    ofs = (src[ip] << 8) + src[ip + 1]
                    ip += 2
                    ref = len(out) - ofs - 8191 - 1
            length += 3
            if ref < 0:
                raise ValueError("FastLZ: bad back reference")
            for _ in range(length):
                out.append(out[ref])
                ref += 1
        else:
            ctrl += 1
            out += src[ip:ip + ctrl]
            ip += ctrl
        if ip >= n:
            break
        ctrl = src[ip]
        ip += 1
    if len(out) != out_size:
        raise ValueError("FastLZ: size mismatch")
    return bytes(out)


# ---------------------------------------------------------------------------
# NI container (the outer structure of Kontakt 5+ .nki files)

CHUNK_TERMINATOR = 1
CHUNK_AUTHORING_APP = 101
CHUNK_AUTHORIZATION = 106
CHUNK_PRESET = 109
CHUNK_SUB_TREE = 115


class ContainerItem:
    """An 'hsin' item: a stack of data chunks plus child items."""

    def __init__(self, r):
        rb = Reader(r.block64())
        if rb.u32() != 1 or rb.ascii(4) != "hsin":
            raise ValueError("not an NI container item")
        rb.skip(8 + 16)  # two ints + UUID
        self.chunks = []
        read_chunk_stack(rb, self.chunks)
        rb.u32()  # version
        self.children = []
        for _ in range(rb.u32()):
            rb.u32()  # child index
            rb.ascii(4)  # domain
            rb.u32()  # type
            self.children.append(ContainerItem(rb))

    def find_all(self, chunk_type):
        for ctype, data in self.chunks:
            if ctype == chunk_type:
                yield data
            if ctype == CHUNK_SUB_TREE and data is not None:
                yield from data.find_all(chunk_type)
        for child in self.children:
            yield from child.find_all(chunk_type)


def read_chunk_stack(r, out):
    """Each chunk holds the next chunk before its own payload."""
    rb = Reader(r.block64())
    rb.ascii(4)  # domain, e.g. 'DSIN'
    ctype = rb.u32()
    rb.u32()  # version
    if ctype != CHUNK_TERMINATOR:
        read_chunk_stack(rb, out)
    payload = rb.read(rb.available())
    if ctype == CHUNK_SUB_TREE:
        out.insert(0, (ctype, parse_sub_tree(payload)))
    else:
        out.insert(0, (ctype, payload))


def parse_sub_tree(payload):
    r = Reader(payload)
    r.u32()  # version
    if r.u8():
        size_raw = r.u32()
        size_comp = r.u32()
        try:
            data = fastlz_decompress(r.read(size_comp), size_raw)
        except (ValueError, IndexError):
            return None  # encrypted
        return ContainerItem(Reader(data))
    return ContainerItem(r)


def preset_data_from_chunk(payload):
    r = Reader(payload)
    r.u32()  # version
    r.u32()  # dictionary type
    if r.u32() != 1:
        raise ValueError("preset chunk has more than one item")
    size = r.u32()
    r.u32()
    return r.read(size)


# ---------------------------------------------------------------------------
# Kontakt preset chunks (inside the container's preset chunk)

ID_PAR_MOD_BASE = 0x00
ID_BANK = 0x03
ID_GROUP = 0x04
ID_PAR_SCRIPT = 0x06
ID_PAR_INTERNAL_MOD = 0x0D
ID_PAR_FX_SEND_LEVELS = 0x17
ID_PROGRAM = 0x28
ID_PROGRAM_CONTAINER = 0x29
ID_VOICE_GROUPS = 0x32
ID_GROUP_LIST = 0x33
ID_ZONE_LIST = 0x34
ID_LOOP_ARRAY = 0x39
ID_PARAMETER_ARRAY_8 = 0x3A
ID_PARAMETER_ARRAY_16 = 0x3B
ID_PARAMETER_ARRAY_32 = 0x3C
ID_FILENAME_LIST = 0x3D
ID_INSERT_BUS = 0x45
ID_SAVE_SETTINGS = 0x47
ID_FILENAME_LIST_EX = 0x4B
ID_QUICK_BROWSE_DATA = 0x4E

STRUCTURED_IDS = {ID_BANK, ID_PROGRAM_CONTAINER, ID_PROGRAM, ID_PAR_SCRIPT,
                  ID_PAR_FX_SEND_LEVELS, ID_VOICE_GROUPS, ID_PARAMETER_ARRAY_8,
                  ID_INSERT_BUS, ID_SAVE_SETTINGS, ID_QUICK_BROWSE_DATA}


class PresetChunk:
    def __init__(self, cid=-1):
        self.id = cid
        self.version = -1
        self.public = b""
        self.private = b""
        self.children = []

    @classmethod
    def read(cls, r):
        c = cls(r.u16())
        size = r.u32()
        rb = Reader(r.read(size))
        if c.id == ID_GROUP_LIST:
            c._read_array(rb, False)
            for child in c.children:
                child.id = ID_GROUP
        elif c.id == ID_ZONE_LIST:
            c._read_array(rb, True)
        elif c.id in STRUCTURED_IDS:
            c._read_structure(rb, size)
        elif c.id == ID_PARAMETER_ARRAY_16:
            c._read_fixed_array(rb, 16)
        elif c.id == ID_PARAMETER_ARRAY_32:
            c._read_fixed_array(rb, 32)
        else:
            c.public = rb.read(size)
        return c

    def _read_array(self, r, has_reference):
        for _ in range(r.u32()):
            child = PresetChunk(r.u32() if has_reference else -1)
            child._read_structure(r, None)
            self.children.append(child)

    def _read_fixed_array(self, r, size):
        r.u8()
        self.version = r.u16()
        for _ in range(size):
            if r.u8():
                child = PresetChunk(r.u16())
                child.public = r.read(r.u32())
                self.children.append(child)

    def _read_structure(self, r, size):
        if not r.u8():
            if size:
                self.public = r.read(size - 1)
            return
        self.version = r.u16()
        self.private = r.read(r.u32())
        self.public = r.read(r.u32())
        rc = Reader(r.read(r.u32()))
        while rc.available():
            self.children.append(PresetChunk.read(rc))


def find_chunks(chunks, cid):
    for c in chunks:
        if c.id == cid:
            yield c
        else:
            yield from find_chunks(c.children, cid)


# ---------------------------------------------------------------------------
# Instrument model


class Zone:
    pass


class Loop:
    pass


class Group:
    pass


class Program:
    pass


def parse_program_data(data):
    r = Reader(data)
    p = Program()
    p.name = r.utf16()
    r.f64()  # size of all samples
    t = r.u8()
    p.transpose = t - 256 if t > 128 else t
    p.volume = r.f32()
    p.pan = r.f32()
    p.tune = r.f32()
    p.lovel, p.hivel, p.lokey, p.hikey = r.u8(), r.u8(), r.u8(), r.u8()
    r.u16()  # default key switch
    r.u32()  # DFD preload size
    r.u32()  # library id
    r.u32()  # fingerprint
    r.u32()  # loading flags
    p.group_solo = r.u8() > 0
    r.u32()  # icon
    p.credits = r.utf16()
    p.author = r.utf16()
    p.url = r.utf16()
    return p


def parse_group(chunk):
    if chunk.version > 0x9C:
        raise ValueError(f"unsupported group version {chunk.version:#x}")
    r = Reader(chunk.public)
    g = Group()
    g.name = r.utf16()
    g.volume = r.f32()
    g.pan = r.f32()
    g.tune = r.f32()
    g.key_tracking = r.u8() > 0
    g.reverse = r.u8() > 0
    g.release_trigger = r.u8() > 0
    r.u8()  # release trigger note monophonic
    r.s32()  # release trigger counter
    r.s16()  # midi channel
    g.voice_group = r.s32()
    r.s32()  # fx index / amp split point
    g.muted = r.u8() > 0
    g.soloed = r.u8() > 0
    g.envelope = None
    for child in chunk.children:
        if child.id == ID_PARAMETER_ARRAY_16:
            for mod in child.children:
                if mod.id in (ID_PAR_INTERNAL_MOD, ID_PAR_MOD_BASE):
                    env = parse_volume_envelope(mod)
                    if env and g.envelope is None:
                        g.envelope = env
    return g


def parse_volume_envelope(chunk):
    """Return (attack, hold, decay, sustain, release) in seconds for an AHDSR
    that modulates volume, or None. Times are stored in milliseconds."""
    try:
        r = Reader(chunk.public)
        if chunk.id == ID_PAR_MOD_BASE:
            r.u32()
        v = r.u8()
        if v == 0:
            v = r.u8()
        if v != 1:
            return None
        if r.u16() not in (0x80, 0x81):
            return None
        block1 = r.read(r.u32())
        if r.u32() != 0:
            return None
        block2 = r.read(r.u32())
    except EOFError:
        return None
    if b"volume" not in block1 or b"ENV_AHDSR" not in block1 or len(block2) < 59:
        return None
    r2 = Reader(block2)
    r2.skip(34)
    r2.f32()  # attack curve
    attack, decay, hold, release, sustain = (r2.f32() for _ in range(5))
    ahd_only = r2.u8() > 0
    if ahd_only:
        sustain, release = 0.0, decay
    vals = (attack, hold, decay, sustain, release)
    if not all(math.isfinite(x) and x >= 0 for x in vals):
        return None
    return (attack / 1000, hold / 1000, decay / 1000, min(sustain, 1.0), release / 1000)


def parse_zone(chunk):
    version = chunk.version
    if version > 0x9C:
        raise ValueError(f"unsupported zone version {version:#x}")
    r = Reader(chunk.public)
    z = Zone()
    z.group_index = chunk.id
    z.sample_start = r.u32()
    z.sample_end = r.u32()
    r.u32()
    z.lovel, z.hivel, z.lokey, z.hikey = r.u16(), r.u16(), r.u16(), r.u16()
    z.fade_lovel, z.fade_hivel, z.fade_lokey, z.fade_hikey = r.u16(), r.u16(), r.u16(), r.u16()
    z.root = r.u16()
    z.volume = r.f32()
    z.pan = r.f32()
    z.tune = r.f32()
    z.file_id = -1
    z.num_frames = 0
    z.rate = 44100
    z.loops = []
    if version >= 0x9A:
        r.u8()
        r.u8()
        r.u32()
        if not r.available():
            return z
    z.file_id = r.s32()
    r.u32()  # resolution
    z.rate = r.u32() or 44100
    r.u8()  # channels
    z.num_frames = r.u32()
    z.loops = []
    for child in chunk.children:
        if child.id == ID_LOOP_ARRAY:
            z.loops = parse_loops(child.public)
    return z


def parse_loops(data):
    loops = []
    if len(data) < 2:
        return loops
    r = Reader(data)
    enabled = r.u16()
    for i in range(8):
        if enabled & (1 << i):
            if r.u16() != 0x60:
                break
            lp = Loop()
            lp.mode = r.s32()
            lp.start = r.u32()
            lp.length = r.u32()
            lp.count = r.u32()
            lp.alternating = r.u8() > 0
            lp.tuning = r.f32()
            lp.xfade = r.u32()
            if r.available():
                r.skip(1)
            loops.append(lp)
    return loops


LOOP_UNTIL_END = 1
LOOP_UNTIL_RELEASE = 2
LOOP_ONESHOT = 3


def parse_file_list(chunk):
    r = Reader(chunk.public)
    if chunk.id == ID_FILENAME_LIST_EX:
        version = r.u16()
        if version == 3:
            files = []
            size = r.s32()
            r.skip(8)
            for _ in range(size - 1):
                files.append(read_path(r))
                if r.available():
                    r.skip(4 + 4 + 20)
            return files
        if version != 2:
            raise ValueError(f"unsupported file list version {version}")
    read_path_list(r)  # special files
    return read_path_list(r)


def read_path_list(r):
    if not r.available():
        return []
    return [read_path(r) for _ in range(r.s32())]


def read_path(r):
    parts = []
    for _ in range(r.u32()):
        kind = r.u8()
        if kind == 0:
            drive = r.ascii(2).strip()
            parts.append(drive + ":/" if drive else "/")
        elif kind == 1:
            drive = r.utf16()
            parts.append(drive + ":/" if drive else "/")
        elif kind == 2:
            parts.append(r.utf16() + "/")
        elif kind == 3:
            parts.append("../")
        elif kind in (4, 8, 9):
            parts.append(r.utf16())
        elif kind == 6:
            pass
        else:
            raise ValueError(f"unknown path segment type {kind}")
    return "".join(parts)


def read_nki(path):
    with open(path, "rb") as f:
        data = f.read()
    try:
        root = ContainerItem(Reader(data))
    except (ValueError, EOFError) as e:
        raise ValueError("not a Kontakt 5+ instrument (older formats are not supported)") from e
    presets = list(root.find_all(CHUNK_PRESET))
    if not presets:
        if any(True for _ in root.find_all(CHUNK_SUB_TREE)):
            raise ValueError("instrument is encrypted (Kontakt Player library); cannot convert")
        raise ValueError("no Kontakt preset data found")
    r = Reader(preset_data_from_chunk(presets[0]))
    top = []
    while r.available():
        top.append(PresetChunk.read(r))

    files = []
    for c in top:
        if c.id in (ID_FILENAME_LIST, ID_FILENAME_LIST_EX):
            files = parse_file_list(c)
            break

    programs = []
    for pc in find_chunks(top, ID_PROGRAM):
        prog = parse_program_data(pc.public)
        prog.groups = []
        prog.zones = []
        prog.has_script = False
        for child in pc.children:
            if child.id == ID_GROUP_LIST:
                prog.groups = [parse_group(g) for g in child.children]
            elif child.id == ID_ZONE_LIST:
                prog.zones = [parse_zone(z) for z in child.children]
            elif child.id == ID_PAR_SCRIPT:
                prog.has_script = True
        programs.append(prog)
    return programs, files


# ---------------------------------------------------------------------------
# NCW decoding

NCW_MAGIC = 0xD69EA801
NCW_BLOCK_MAGIC = 0x3E9A0C16
NCW_BLOCK = 512


def _unpack_rows(rows, bits, signed=True):
    """Unpack little-endian bit-packed integers, one block per row of a
    uint8 array shaped (blocks, 64 * bits), into (blocks, 512) int64."""
    b = np.unpackbits(rows, axis=1, bitorder="little")
    b = b.reshape(len(rows), NCW_BLOCK, bits)
    vals = b @ (np.int64(1) << np.arange(bits, dtype=np.int64))
    if signed and bits < 64:
        sign = np.int64(1) << (bits - 1)
        vals = np.where(vals & sign, vals - (sign << 1), vals)
    return vals


def decode_ncw(path):
    """Return (channels, bits, rate, frames, data) with data as int64 or
    float32 array shaped (frames, channels)."""
    with open(path, "rb") as f:
        buf = f.read()
    r = Reader(buf)
    if r.u32() != NCW_MAGIC:
        raise ValueError(f"{path}: not an NCW file")
    version = r.u32()
    if version not in (0x130, 0x131):
        raise ValueError(f"{path}: unknown NCW version {version:#x}")
    channels = r.u16()
    bits = r.u16()
    rate = r.u32()
    frames = r.u32()
    off_addr = r.u32()
    off_data = r.u32()
    n_offsets = (off_data - off_addr) // 4
    offsets = struct.unpack_from(f"<{n_offsets}I", buf, off_addr)
    n_blocks = n_offsets - 1

    # Read every block header first, then decode all blocks of the same
    # width together: far fewer numpy calls than block-by-block decoding.
    raw = np.frombuffer(buf, dtype=np.uint8)
    hdr_type = np.dtype([("magic", "<u4"), ("base", "<i4"), ("bits", "<i2"), ("flags", "<u2"), ("pad", "<u4")])
    base = np.zeros((n_blocks, channels), dtype=np.int64)
    width = np.zeros((n_blocks, channels), dtype=np.int64)
    data_pos = np.zeros((n_blocks, channels), dtype=np.int64)
    flags = np.zeros(n_blocks, dtype=np.int64)
    pos = np.asarray(offsets[:-1], dtype=np.int64) + off_data
    for ch in range(channels):  # channel headers follow each other in a block
        hdr = raw[pos[:, None] + np.arange(16)].copy().view(hdr_type)[:, 0]
        if (hdr["magic"] != NCW_BLOCK_MAGIC).any():
            raise ValueError(f"{path}: corrupt block {int(np.argmax(hdr['magic'] != NCW_BLOCK_MAGIC))}")
        base[:, ch] = hdr["base"]
        width[:, ch] = hdr["bits"]
        data_pos[:, ch] = pos + 16
        flags |= hdr["flags"]
        pos = pos + 16 + NCW_BLOCK * np.abs(width[:, ch]) // 8

    out = np.zeros((channels, n_blocks, NCW_BLOCK), dtype=np.int64)
    bytes_per = bits // 8
    batch = 256  # blocks per numpy call, keeps temporary arrays small
    for w in np.unique(width):
        w = int(w)
        blk, ch = np.nonzero(width == w)
        nbytes = NCW_BLOCK * (abs(w) if w else bytes_per * 8) // 8
        for i in range(0, len(blk), batch):
            b_i, c_i = blk[i:i + batch], ch[i:i + batch]
            rows = raw[data_pos[b_i, c_i][:, None] + np.arange(nbytes)]
            if w > 0:  # deltas from the block's base value
                d = _unpack_rows(rows, w)
                vals = np.empty_like(d)
                vals[:, 0] = 0
                np.cumsum(d[:, :-1], axis=1, out=vals[:, 1:])
                vals += base[b_i, c_i][:, None]
            elif w < 0:  # plain values with reduced bit depth
                vals = _unpack_rows(rows, -w, signed=(-w != 32))
            else:  # uncompressed
                vals = _unpack_rows(rows, bits)
            out[c_i, b_i] = vals

    if channels == 2:
        ms = (flags & 1).astype(bool) & ~(flags & 2).astype(bool)
        if ms.any():  # mid/side -> left/right
            m = out[0, ms].copy()
            sd = out[1, ms]
            out[0, ms] = m + sd
            out[1, ms] = m - sd
    is_float = bool((flags & 2).any())
    out = out.reshape(channels, n_blocks * NCW_BLOCK)
    out = out[:, :frames].T
    if is_float:
        out = (out & 0xFFFFFFFF).astype(np.uint32).view(np.float32)
    return channels, bits, rate, frames, out


def write_flac(path, bits, rate, data):
    import soundfile  # optional dependency, only needed for --format flac
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".part"
    subtype = {8: "PCM_S8", 16: "PCM_16", 24: "PCM_24"}[bits]
    # soundfile scales int32 input to the target width, so shift up to 32 bits.
    pcm = (np.clip(data, -(1 << (bits - 1)), (1 << (bits - 1)) - 1) << (32 - bits)).astype(np.int32)
    soundfile.write(tmp, pcm, rate, subtype=subtype, format="FLAC")
    os.replace(tmp, path)


def write_wav(path, channels, bits, rate, data):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".part"
    if data.dtype == np.float32:
        write_float_wav(tmp, channels, rate, data)
    else:
        lim = (1 << (bits - 1))
        d = np.clip(data, -lim, lim - 1)
        if bits == 16:
            raw = d.astype("<i2").tobytes()
        elif bits == 24:
            raw = d.astype("<i4").view(np.uint8).reshape(-1, 4)[:, :3].tobytes()
        elif bits == 32:
            raw = d.astype("<i4").tobytes()
        elif bits == 8:
            raw = (d + 128).astype(np.uint8).tobytes()
        else:
            raise ValueError(f"unsupported bit depth {bits}")
        with wave.open(tmp, "wb") as w:
            w.setnchannels(channels)
            w.setsampwidth(bits // 8)
            w.setframerate(rate)
            w.writeframes(raw)
    os.replace(tmp, path)


def write_float_wav(path, channels, rate, data):
    raw = data.astype("<f4").tobytes()
    fmt = struct.pack("<HHIIHH", 3, channels, rate, rate * channels * 4, channels * 4, 32)
    with open(path, "wb") as f:
        f.write(b"RIFF" + struct.pack("<I", 4 + 8 + len(fmt) + 8 + len(raw)) + b"WAVE")
        f.write(b"fmt " + struct.pack("<I", len(fmt)) + fmt)
        f.write(b"data" + struct.pack("<I", len(raw)) + raw)


# ---------------------------------------------------------------------------
# Sample lookup


def build_sample_index(root):
    index = {}
    for dirpath, _, names in os.walk(root):
        for n in names:
            index.setdefault(n.lower(), []).append(os.path.join(dirpath, n))
    return index


def find_library_root(nki_path):
    """The library root is the nearest folder above the .nki that has a
    'Samples' folder; otherwise the .nki's own folder."""
    d = os.path.dirname(os.path.abspath(nki_path))
    cur = d
    while True:
        if os.path.isdir(os.path.join(cur, "Samples")) or os.path.isdir(os.path.join(cur, "samples")):
            return cur
        parent = os.path.dirname(cur)
        if parent == cur:
            return d
        cur = parent


def resolve_sample(ref, nki_dir, library_root, index):
    """Find the sample file a zone refers to. Kontakt stores paths relative to
    the .nki (often '../Samples/...') or as absolute paths from the
    original author's machine, so fall back to matching by file name."""
    ref = ref.replace("\\", "/")
    cand = os.path.normpath(os.path.join(nki_dir, ref))
    if os.path.isfile(cand):
        return cand
    name = os.path.basename(ref)
    hits = index.get(name.lower(), [])
    if len(hits) == 1:
        return hits[0]
    if hits:
        # Prefer the candidate that shares the longest path tail with ref.
        ref_parts = [p.lower() for p in ref.split("/") if p not in ("", "..", ".")]

        def score(h):
            hp = os.path.relpath(h, library_root).lower().replace("\\", "/").split("/")
            n = 0
            while n < min(len(hp), len(ref_parts)) and hp[-1 - n] == ref_parts[-1 - n]:
                n += 1
            # Tie-break: prefer samples closest to the instrument.
            near = len(os.path.commonpath([os.path.abspath(h), nki_dir]))
            return (n, near)
        return max(hits, key=score)
    return None


# ---------------------------------------------------------------------------
# SFZ output


def ratio_to_semitones(ratio):
    if ratio <= 0:
        return 0.0
    return 12.0 * math.log2(ratio)


def lin_to_db(v):
    if v <= 1e-8:
        return -144.0
    return 20.0 * math.log10(v)


def fmt(v):
    s = f"{v:.4f}".rstrip("0").rstrip(".")
    return "0" if s in ("-0", "") else s


def sfz_for_program(prog, files, nki_path, out_dir, sample_map, warnings):
    lines = [f"// Converted from {os.path.basename(nki_path)} by nki2sfz.py",
             f"// Kontakt instrument: {prog.name}"]
    if prog.author:
        lines.append(f"// Author: {prog.author}")
    if prog.has_script:
        lines.append("// Note: this instrument uses KSP scripts, which SFZ cannot reproduce.")
    lines.append("")

    control = []
    if prog.transpose:
        control.append(f"note_offset={prog.transpose}")
    if control:
        lines.append("<control> " + " ".join(control))
        lines.append("")

    lines.append("<global> amp_veltrack=100")
    lines.append("")

    any_soloed = prog.group_solo and any(g.soloed for g in prog.groups)
    by_group = {}
    for z in prog.zones:
        if z.file_id < 0:
            continue
        by_group.setdefault(z.group_index, []).append(z)

    regions = 0
    for gi, group in enumerate(prog.groups):
        zones = by_group.get(gi)
        if not zones:
            continue
        if (not group.soloed) if any_soloed else group.muted:
            continue

        gop = []
        if group.release_trigger:
            gop.append("trigger=release")
        elif prog.has_script and "release" in group.name.lower():
            # Release samples are often played by the KSP script rather than
            # by Kontakt's release trigger, so guess from the group name.
            lines.append("// Release group triggered by script in Kontakt; guessed from its name.")
            gop.append("trigger=release")
        if not group.key_tracking:
            gop.append("pitch_keytrack=0")
        if group.reverse:
            gop.append("direction=reverse")
        if group.voice_group >= 0:
            gop.append(f"group={group.voice_group + 1} off_by={group.voice_group + 1}")
        if group.envelope:
            a, h, d, s, rel = group.envelope
            gop.append(f"ampeg_attack={fmt(a)} ampeg_hold={fmt(h)} ampeg_decay={fmt(d)} "
                       f"ampeg_sustain={fmt(s * 100)} ampeg_release={fmt(rel)}")
        lines.append(f"// Group {gi + 1}: {group.name}")
        lines.append("<group>" + (" " + " ".join(gop) if gop else ""))

        for z in sorted(zones, key=lambda z: (z.lokey, z.lovel)):
            if z.file_id >= len(files):
                warnings.append(f"zone refers to missing file #{z.file_id}")
                continue
            sample = sample_map.get(files[z.file_id])
            if sample is None:
                continue
            rel = os.path.relpath(sample, out_dir).replace(os.sep, "/")
            op = [f"sample={rel}",
                  f"lokey={z.lokey} hikey={z.hikey} pitch_keycenter={z.root}",
                  f"lovel={max(z.lovel, 1)} hivel={z.hivel}"]

            if z.sample_start:
                op.append(f"offset={z.sample_start}")
            if z.sample_end and z.num_frames:
                op.append(f"end={max(z.num_frames - z.sample_end - 1, 0)}")

            vol = prog.volume * group.volume * z.volume
            if abs(vol - 1.0) > 1e-6:
                op.append(f"volume={fmt(lin_to_db(vol))}")
            pan = max(-1.0, min(1.0, prog.pan + group.pan + z.pan))
            if pan:
                op.append(f"pan={fmt(pan * 100)}")
            semis = ratio_to_semitones(z.tune * group.tune * prog.tune)
            if abs(semis) > 1e-4:
                whole = int(round(semis)) if abs(semis - round(semis)) < 1e-4 else int(semis)
                cents = round((semis - whole) * 100, 2)
                if whole:
                    op.append(f"transpose={whole}")
                if cents:
                    op.append(f"tune={fmt(cents)}")

            if z.fade_lokey:
                op.append(f"xfin_lokey={z.lokey} xfin_hikey={min(127, z.lokey + z.fade_lokey)}")
            if z.fade_hikey:
                op.append(f"xfout_lokey={max(0, z.hikey - z.fade_hikey)} xfout_hikey={z.hikey}")
            if z.fade_lovel:
                op.append(f"xfin_lovel={z.lovel} xfin_hivel={min(127, z.lovel + z.fade_lovel)}")
            if z.fade_hivel:
                op.append(f"xfout_lovel={max(0, z.hivel - z.fade_hivel)} xfout_hivel={z.hivel}")

            for lp in z.loops:
                if lp.mode == LOOP_ONESHOT:
                    op.append("loop_mode=one_shot")
                    break
                if lp.mode in (LOOP_UNTIL_END, LOOP_UNTIL_RELEASE) and lp.length > 0:
                    mode = "loop_continuous" if lp.mode == LOOP_UNTIL_END else "loop_sustain"
                    op.append(f"loop_mode={mode} loop_start={lp.start} "
                              f"loop_end={lp.start + lp.length - 1}")
                    if lp.alternating:
                        op.append("loop_type=alternate")
                    if lp.xfade:
                        op.append(f"loop_crossfade={fmt(lp.xfade / z.rate)}")
                    break  # SFZ has one loop per region

            lines.append("<region> " + " ".join(op))
            regions += 1
        lines.append("")
    return "\n".join(lines), regions


# ---------------------------------------------------------------------------
# Driver


def safe_name(name):
    keep = "".join(c if c.isalnum() or c in " -_.()#" else "_" for c in name).strip()
    return keep or "instrument"


def sample_destination(src, library_root, samples_dir, audio_format):
    """Where a library sample goes in the output, keeping its folder layout.
    NCW samples get the decoded format's extension."""
    rel = os.path.relpath(src, library_root)
    if rel.startswith(".."):
        rel = os.path.basename(src)
    if src.lower().endswith(".ncw"):
        rel = os.path.splitext(rel)[0] + "." + audio_format
    return os.path.join(samples_dir, rel)


def decode_sample(src, dst):
    """Decode an NCW (or copy any other sample) to dst; returns the path
    written, which is .wav if FLAC can't hold the sample format."""
    if not src.lower().endswith(".ncw"):
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        shutil.copy2(src, dst)
        return dst
    ch, bits, rate, _, data = decode_ncw(src)
    if dst.lower().endswith(".flac"):
        if data.dtype != np.float32 and bits <= 24:
            write_flac(dst, bits, rate, data)
            return dst
        dst = os.path.splitext(dst)[0] + ".wav"  # FLAC can't hold float/32-bit
    write_wav(dst, ch, bits, rate, data)
    return dst


def sfz_file_name(nki_path, prog, index, n_programs, library_root, used_names):
    """A unique output name for one program; records it in used_names."""
    base = safe_name(os.path.splitext(os.path.basename(nki_path))[0])
    name = base if n_programs == 1 else f"{base} - {safe_name(prog.name) or index + 1}"
    if name.lower() in used_names:
        # Same file name elsewhere in the library: prefix the folder path.
        rel_dir = os.path.relpath(os.path.dirname(os.path.abspath(nki_path)), library_root)
        name = safe_name(" - ".join(p for p in rel_dir.split(os.sep) if p not in (".", "")) + " - " + name)
    n, unique = 2, name
    while unique.lower() in used_names:
        unique = f"{name} ({n})"
        n += 1
    used_names.add(unique.lower())
    return unique


def convert(nki_path, out_dir, library_root, index, decoded, used_names,
            decode_samples=True, audio_format="wav"):
    programs, files = read_nki(nki_path)
    nki_dir = os.path.dirname(os.path.abspath(nki_path))
    samples_dir = os.path.join(out_dir, "samples")
    warnings = []

    used = set()
    for prog in programs:
        for z in prog.zones:
            if 0 <= z.file_id < len(files):
                used.add(files[z.file_id])

    sample_map = {}
    missing = 0
    for ref in sorted(used):
        src = resolve_sample(ref, nki_dir, library_root, index)
        if src is None:
            missing += 1
            warnings.append(f"sample not found: {ref}")
            continue
        dst = sample_destination(src, library_root, samples_dir, audio_format)
        if dst not in decoded and not os.path.exists(dst) and decode_samples:
            dst = decode_sample(src, dst)
        decoded.add(dst)
        sample_map[ref] = dst

    written = []
    for i, prog in enumerate(programs):
        text, regions = sfz_for_program(prog, files, nki_path, out_dir, sample_map, warnings)
        name = sfz_file_name(nki_path, prog, i, len(programs), library_root, used_names)
        out = os.path.join(out_dir, name + ".sfz")
        with open(out, "w", encoding="utf-8") as f:
            f.write(text)
        written.append((out, regions))
    return written, warnings, missing


def main(argv=None):
    ap = argparse.ArgumentParser(description="Convert Kontakt .nki instruments to SFZ.")
    ap.add_argument("inputs", nargs="+", help=".nki files or folders containing them")
    ap.add_argument("-o", "--output", required=True, help="output folder")
    ap.add_argument("--library-root", help="folder to search for samples (default: auto)")
    ap.add_argument("--no-samples", action="store_true",
                    help="only write .sfz files; do not decode/copy samples")
    ap.add_argument("--format", choices=("wav", "flac"), default="wav",
                    help="audio format for decoded NCW samples (flac is lossless and about "
                         "a third the size of wav; needs the 'soundfile' package)")
    args = ap.parse_args(argv)

    nkis = []
    for inp in args.inputs:
        if os.path.isdir(inp):
            for dirpath, _, names in os.walk(inp):
                nkis += [os.path.join(dirpath, n) for n in sorted(names) if n.lower().endswith(".nki")]
        else:
            nkis.append(inp)
    if not nkis:
        ap.error("no .nki files found")

    out_dir = os.path.abspath(args.output)
    os.makedirs(out_dir, exist_ok=True)

    if args.format == "flac":
        try:
            import soundfile  # noqa: F401
        except ImportError:
            ap.error("--format flac needs the soundfile package: pip3 install soundfile")

    indexes = {}
    decoded = set()
    used_names = set()
    failed = 0
    for nki in nkis:
        root = os.path.abspath(args.library_root) if args.library_root else find_library_root(nki)
        if root not in indexes:
            indexes[root] = build_sample_index(root)
        try:
            written, warnings, missing = convert(nki, out_dir, root, indexes[root], decoded,
                                                 used_names, not args.no_samples, args.format)
        except OSError as e:
            if e.errno == 28:  # ENOSPC: stop rather than fail every remaining instrument
                print(f"FAILED {nki}: disk full; stopping. Free space or pick another --output.",
                      file=sys.stderr)
                return 1
            failed += 1
            print(f"FAILED {nki}: {e}", file=sys.stderr)
            continue
        except Exception as e:  # keep going with the other instruments
            failed += 1
            print(f"FAILED {nki}: {e}", file=sys.stderr)
            continue
        for path, regions in written:
            print(f"[{nkis.index(nki) + 1}/{len(nkis)}] wrote {os.path.basename(path)} "
                  f"({regions} regions)", flush=True)
        for w in warnings[:5]:
            print(f"  warning: {w}", file=sys.stderr)
        if len(warnings) > 5:
            print(f"  ... {len(warnings) - 5} more warnings", file=sys.stderr)
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
