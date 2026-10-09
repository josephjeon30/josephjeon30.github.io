"""main.py — SDF raymarching starter. Replace or extend this with your engine.

How the work is split:
  * GLSL (the .glsl files) runs on the GPU once per pixel: the distance functions
    (sdf.glsl), the scene (scene.glsl) and the raymarcher (raymarch.glsl).
  * Python (this file) runs once per frame: it handles input, moves the camera
    and objects, and passes those values to the shader as uniforms.

No meshes: the only geometry is one triangle covering the screen, so the
fragment shader runs for every pixel.

List any new .py or .glsl file in manifest.json so the page loads it.
"""

from math import cos, sin, tan, radians

import numpy as np

import host
from host import gl

# Raymarching cost scales with pixel count, so don't render at full Retina resolution.
host.max_pixel_ratio = 1.0

# ---------- shader ----------

VERTEX_SHADER = """#version 300 es
// One oversized triangle that covers the whole screen; no vertex data needed.
void main() {
    vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
    gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}
"""

# Uniforms the engine sets every frame, available to all the .glsl files.
FRAGMENT_HEADER = """#version 300 es
precision highp float;
uniform vec2 u_resolution;   // canvas size in pixels
uniform float u_time;        // seconds since start
uniform float u_frame;       // frame counter (wraps around at 4096)
uniform vec3 u_cam_pos;
uniform vec3 u_cam_right;
uniform vec3 u_cam_up;
uniform vec3 u_cam_forward;
uniform float u_cam_focal;   // 1 / tan(fov / 2)
uniform float u_edges;       // 1 = edge shading mode, 0 = normal lighting
uniform float u_tone;        // 1 = edge mode also fills shadows with one flat tone
uniform float u_scribble;    // 1 = that tone is drawn as animated pencil strokes
uniform float u_layer;       // which pass: 0 = single, 1 = low-res, 2 = adaptive full-res
uniform float u_edge_scale;  // resolution multiplier of this pass (keeps line/stroke sizes constant)
uniform sampler2D u_low;     // the low-res pass's output, read by the adaptive pass
uniform float u_show_refined;  // 1 = tint the pixels that got their own ray in the adaptive pass
"""


def read(name):
    with open(name) as f:
        return f.read()


def compile_shader(kind, source):
    shader = gl.createShader(kind)
    gl.shaderSource(shader, source)
    gl.compileShader(shader)
    if not gl.getShaderParameter(shader, gl.COMPILE_STATUS):
        log = gl.getShaderInfoLog(shader)
        numbered = "\n".join(f"{i + 1:4d}  {line}" for i, line in enumerate(source.split("\n")))
        raise RuntimeError(f"Shader compile error:\n{log}\n{numbered}")
    return shader


def make_program(vertex_src, fragment_src):
    program = gl.createProgram()
    gl.attachShader(program, compile_shader(gl.VERTEX_SHADER, vertex_src))
    gl.attachShader(program, compile_shader(gl.FRAGMENT_SHADER, fragment_src))
    gl.linkProgram(program)
    if not gl.getProgramParameter(program, gl.LINK_STATUS):
        raise RuntimeError("Program link error:\n" + gl.getProgramInfoLog(program))
    return program


# The fragment shader is the three files joined in order (later files use earlier ones).
fragment_source = "\n".join([FRAGMENT_HEADER, read("sdf.glsl"), read("scene.glsl"), read("raymarch.glsl")])
program = make_program(VERTEX_SHADER, fragment_source)
gl.useProgram(program)
gl.bindVertexArray(gl.createVertexArray())  # WebGL2 needs one bound, even though it's empty

_locations = {}


def set_uniform(name, *values):
    """Set a float / vec2 / vec3 / vec4 uniform: set_uniform("u_box_pos", x, y, z)."""
    if name not in _locations:
        _locations[name] = gl.getUniformLocation(program, name)
    setter = (gl.uniform1f, gl.uniform2f, gl.uniform3f, gl.uniform4f)[len(values) - 1]
    setter(_locations[name], *(float(v) for v in values))


# ---------- scene state (Python side) ----------

camera = {"yaw": radians(35), "pitch": radians(20), "distance": 7.0, "fov": radians(50)}
target = np.array([0.0, 0.8, 0.0])
box_pos = np.array([1.6, 0.5, 0.6])


# On/off settings, each controlled by a toggle button on the page.
settings = {"edges": False, "tone": True, "scribble": True, "hires": True, "show_refined": False}


def bind_toggle(button_id, key):
    """Make a page button flip settings[key]; the button shows the current state."""
    def show(button):
        button.setAttribute("aria-pressed", "true" if settings[key] else "false")

    def clicked(button, event):
        settings[key] = not settings[key]
        show(button)

    show(host.on(button_id, "click", clicked))


bind_toggle("edge-toggle", "edges")
bind_toggle("tone-toggle", "tone")
bind_toggle("scribble-toggle", "scribble")
bind_toggle("hires-toggle", "hires")
bind_toggle("refined-toggle", "show_refined")


# ---------- adaptive high resolution ----------
# With "hires" on, each frame is drawn in two passes so that doubling the resolution
# doesn't mean four times the rays:
#   1. the whole scene at normal resolution, into a texture;
#   2. the canvas at SCALE times that resolution, where the shader reuses pass 1 wherever
#      the picture is smooth and marches new rays only near edges (see raymarch.glsl).

SCALE = 2  # the shader's 2x2 block logic assumes exactly 2

low_target = {"size": None, "texture": gl.createTexture(), "framebuffer": gl.createFramebuffer()}


def low_target_resize(w, h):
    """(Re)allocate the low-res texture when the canvas size changes."""
    if low_target["size"] == (w, h):
        return
    low_target["size"] = (w, h)
    gl.bindTexture(gl.TEXTURE_2D, low_target["texture"])
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, None)
    for name, value in ((gl.TEXTURE_MIN_FILTER, gl.LINEAR), (gl.TEXTURE_MAG_FILTER, gl.LINEAR),
                        (gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE), (gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)):
        gl.texParameteri(gl.TEXTURE_2D, name, value)
    gl.bindFramebuffer(gl.FRAMEBUFFER, low_target["framebuffer"])
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, low_target["texture"], 0)
    gl.bindFramebuffer(gl.FRAMEBUFFER, None)


def draw_pass(layer, width, height, scale=1.0):
    gl.viewport(0, 0, width, height)
    set_uniform("u_resolution", width, height)
    set_uniform("u_layer", layer)
    set_uniform("u_edge_scale", scale)
    gl.drawArrays(gl.TRIANGLES, 0, 3)


def draw():
    hires = settings["hires"]
    host.pixel_ratio = float(SCALE) if hires else None  # takes effect on the next frame

    if not hires or host.width < 2 * SCALE or host.height < 2 * SCALE:
        draw_pass(0, host.width, host.height)  # one ray per pixel, one pass
        return

    # Pass 1: normal resolution, into the texture
    w, h = host.width // SCALE, host.height // SCALE
    low_target_resize(w, h)
    gl.bindTexture(gl.TEXTURE_2D, None)  # a texture can't be read while it's being drawn into
    gl.bindFramebuffer(gl.FRAMEBUFFER, low_target["framebuffer"])
    draw_pass(1, w, h)
    gl.bindFramebuffer(gl.FRAMEBUFFER, None)

    # Pass 2: full canvas resolution, reusing the texture away from edges
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, low_target["texture"])
    gl.uniform1i(gl.getUniformLocation(program, "u_low"), 0)
    draw_pass(2, host.width, host.height, SCALE)


frame = {"count": 0}


def normalize(v):
    return v / np.linalg.norm(v)


def update(dt, t):
    # --- input ---
    if host.mouse.down:
        camera["yaw"] -= host.mouse.dx * 0.005
        camera["pitch"] = min(radians(85), max(radians(3), camera["pitch"] + host.mouse.dy * 0.005))
    camera["distance"] = min(20.0, max(2.5, camera["distance"] * (1 + host.mouse.wheel * 0.001)))

    # --- camera: orbit around the target, then build its three axes ---
    d, yaw, pitch = camera["distance"], camera["yaw"], camera["pitch"]
    eye = target + d * np.array([cos(pitch) * sin(yaw), sin(pitch), cos(pitch) * cos(yaw)])
    forward = normalize(target - eye)
    right = normalize(np.cross(forward, [0.0, 1.0, 0.0]))
    up = np.cross(right, forward)

    # --- WASD moves the box along the ground, relative to the camera ---
    ground_forward = normalize(forward * [1.0, 0.0, 1.0])
    move = (("KeyW" in host.keys) - ("KeyS" in host.keys)) * ground_forward \
         + (("KeyD" in host.keys) - ("KeyA" in host.keys)) * right
    box_pos[:] = np.clip(box_pos + move * 3.0 * dt, [-6.0, 0.5, -6.0], [6.0, 0.5, 6.0])

    # --- hand everything to the shader and draw ---
    set_uniform("u_time", t)
    frame["count"] = (frame["count"] + 1) % 4096  # kept small so shader noise stays precise
    set_uniform("u_frame", frame["count"])
    set_uniform("u_cam_pos", *eye)
    set_uniform("u_cam_right", *right)
    set_uniform("u_cam_up", *up)
    set_uniform("u_cam_forward", *forward)
    set_uniform("u_cam_focal", 1.0 / tan(camera["fov"] / 2))
    set_uniform("u_edges", 1.0 if settings["edges"] else 0.0)
    set_uniform("u_show_refined", 1.0 if settings["show_refined"] else 0.0)
    set_uniform("u_tone", 1.0 if settings["tone"] else 0.0)
    set_uniform("u_scribble", 1.0 if settings["scribble"] else 0.0)
    set_uniform("u_box_pos", *box_pos)

    draw()


host.run(update)
