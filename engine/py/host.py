"""host.py — the bridge between Python and the browser.

Gives the engine a WebGL2 context, an animation loop and input state, so the
rest of the code can stay plain Python + numpy:

    import host
    from host import gl          # the WebGL2 context: gl.drawArrays(...), etc.

    def update(dt, t):           # called once per frame
        ...
    host.run(update)

    host.width, host.height      # canvas size in pixels (kept up to date)
    host.max_pixel_ratio = 1.0   # optional: render fewer pixels on Retina screens
    host.pixel_ratio = 2.0       # optional: force an exact resolution (None = automatic)
    host.keys                    # set of held keys, e.g. "KeyW", "ArrowLeft", "Space"
    host.mouse.x, .y             # pointer position in canvas pixels
    host.mouse.dx, .dy, .wheel   # movement / scroll since the last frame
    host.mouse.down              # True while a button is held
    host.on(id, "click", fn)     # react to a button or other control on the page
"""

import traceback

import numpy as np
import js
from js import document, window
from pyodide.ffi import create_proxy, to_js


def _js_object(d):
    return to_js(d, dict_converter=js.Object.fromEntries)


canvas = document.getElementById("screen")
gl = canvas.getContext("webgl2", _js_object({"antialias": True}))
if gl is None:
    raise RuntimeError("This browser doesn't support WebGL2.")

width = 0
height = 0

# Upper limit on canvas pixels per CSS pixel. Retina screens report 2 or 3, which
# means 4-9x the pixels; per-pixel work like raymarching may want 1.0 or lower.
max_pixel_ratio = 2.0

# Set to a number to force an exact canvas resolution (canvas pixels per CSS pixel),
# e.g. 2.0 to supersample. None = follow the screen, up to max_pixel_ratio.
pixel_ratio = None
keys = set()


class _Mouse:
    x = 0.0
    y = 0.0
    dx = 0.0
    dy = 0.0
    wheel = 0.0
    down = False


mouse = _Mouse()


# ---------- numpy -> WebGL helpers ----------

def f32(a):
    """A numpy array as a flat Float32Array (for vertex data)."""
    return to_js(np.ascontiguousarray(a, dtype=np.float32).ravel())


def u16(a):
    """A numpy array as a flat Uint16Array (for index data)."""
    return to_js(np.ascontiguousarray(a, dtype=np.uint16).ravel())


def mat4(m):
    """A 4x4 numpy matrix as WebGL expects it (column-major Float32Array)."""
    return to_js(np.ascontiguousarray(np.asarray(m).T, dtype=np.float32).ravel())


# ---------- canvas size ----------

def _resize():
    global width, height
    dpr = pixel_ratio if pixel_ratio is not None else min(window.devicePixelRatio or 1, max_pixel_ratio)
    w = max(1, int(canvas.clientWidth * dpr))
    h = max(1, int(canvas.clientHeight * dpr))
    if (w, h) != (width, height):
        canvas.width, canvas.height = w, h
        width, height = w, h
        gl.viewport(0, 0, w, h)


# ---------- input ----------

def _scale():
    return canvas.width / max(1, canvas.clientWidth)


def _on_key_down(e):
    keys.add(e.code)
    e.preventDefault()  # keep arrows/space from scrolling the page while the canvas has focus


def _on_key_up(e):
    keys.discard(e.code)


def _on_blur(e):
    keys.clear()


def _on_pointer_down(e):
    mouse.down = True
    canvas.setPointerCapture(e.pointerId)
    canvas.focus()


def _on_pointer_up(e):
    mouse.down = False


def _on_pointer_move(e):
    s = _scale()
    mouse.x = e.offsetX * s
    mouse.y = e.offsetY * s
    mouse.dx += e.movementX * s
    mouse.dy += e.movementY * s


def _on_wheel(e):
    mouse.wheel += e.deltaY
    e.preventDefault()


# Proxies must stay referenced for as long as the listeners exist.
_listeners = []


def _listen(target, name, fn, options=None):
    proxy = create_proxy(fn)
    _listeners.append(proxy)
    if options is None:
        target.addEventListener(name, proxy)
    else:
        target.addEventListener(name, proxy, _js_object(options))


_listen(canvas, "keydown", _on_key_down)
_listen(canvas, "keyup", _on_key_up)
_listen(canvas, "blur", _on_blur)
_listen(canvas, "pointerdown", _on_pointer_down)
_listen(canvas, "pointerup", _on_pointer_up)
_listen(canvas, "pointercancel", _on_pointer_up)
_listen(canvas, "pointermove", _on_pointer_move)
_listen(canvas, "wheel", _on_wheel, {"passive": False})


def on(element_id, event, fn):
    """Call fn(element, event) when a page element fires an event: host.on("my-button", "click", fn)."""
    element = document.getElementById(element_id)
    _listen(element, event, lambda e: fn(element, e))
    return element


# ---------- main loop ----------

def run(update):
    """Call update(dt, t) every frame: dt = seconds since last frame, t = seconds since start."""
    fps_el = document.getElementById("fps")
    performance = window.performance
    state = {"last": None, "start": None, "frames": 0, "since": 0.0, "work": 0.0}

    def frame(ms):
        now = ms / 1000.0
        if state["start"] is None:
            state["start"] = state["last"] = now
            window.engineReady()
        elapsed = now - state["last"]
        state["last"] = now
        dt = min(elapsed, 0.1)  # clamp so a background tab doesn't cause a huge jump

        _resize()
        began = performance.now()
        try:
            update(dt, now - state["start"])
        except Exception:
            window.engineError(traceback.format_exc())
            return  # stop the loop
        state["work"] += performance.now() - began

        mouse.dx = mouse.dy = mouse.wheel = 0.0

        # Frame rate, and how long update() takes (the part your code controls).
        state["frames"] += 1
        state["since"] += elapsed
        if state["since"] >= 0.5:
            fps = state["frames"] / state["since"]
            ms_per_frame = state["work"] / state["frames"]
            fps_el.textContent = f"{fps:.0f} fps · {ms_per_frame:.1f} ms per frame"
            state["frames"], state["since"], state["work"] = 0, 0.0, 0.0

        window.requestAnimationFrame(frame_proxy)

    frame_proxy = create_proxy(frame)
    _listeners.append(frame_proxy)
    _resize()
    window.requestAnimationFrame(frame_proxy)
