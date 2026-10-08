"""main.py — starter scene. Replace this with your engine.

Everything here is ordinary WebGL2, called from Python through host.gl:
  * 3D: a cube on a checkerboard floor, seen through a perspective camera.
  * 2D: a triangle in the corner, drawn with the same shader and mesh code
        but an orthographic (flat) camera — 2D is just 3D with z = 0.

Add more .py files next to this one and list them in manifest.json.
"""

from math import cos, sin, tan, radians

import numpy as np

import host
from host import gl

# ---------- shaders ----------

VERTEX_SHADER = """#version 300 es
in vec3 a_pos;
in vec3 a_color;
uniform mat4 u_mvp;
out vec3 v_color;
void main() {
    v_color = a_color;
    gl_Position = u_mvp * vec4(a_pos, 1.0);
}
"""

FRAGMENT_SHADER = """#version 300 es
precision mediump float;
in vec3 v_color;
out vec4 out_color;
void main() {
    out_color = vec4(v_color, 1.0);
}
"""


def compile_shader(kind, source):
    shader = gl.createShader(kind)
    gl.shaderSource(shader, source)
    gl.compileShader(shader)
    if not gl.getShaderParameter(shader, gl.COMPILE_STATUS):
        raise RuntimeError("Shader compile error:\n" + gl.getShaderInfoLog(shader))
    return shader


def make_program(vertex_src, fragment_src):
    program = gl.createProgram()
    gl.attachShader(program, compile_shader(gl.VERTEX_SHADER, vertex_src))
    gl.attachShader(program, compile_shader(gl.FRAGMENT_SHADER, fragment_src))
    gl.linkProgram(program)
    if not gl.getProgramParameter(program, gl.LINK_STATUS):
        raise RuntimeError("Program link error:\n" + gl.getProgramInfoLog(program))
    return program


# ---------- meshes ----------

class Mesh:
    """Vertices are rows of [x, y, z, r, g, b]; indices are triangles."""

    def __init__(self, program, vertices, indices):
        vertices = np.asarray(vertices, dtype=np.float32)
        indices = np.asarray(indices, dtype=np.uint16)
        self.count = indices.size

        self.vao = gl.createVertexArray()
        gl.bindVertexArray(self.vao)

        gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer())
        gl.bufferData(gl.ARRAY_BUFFER, host.f32(vertices), gl.STATIC_DRAW)
        stride = 6 * 4  # 6 floats per vertex, 4 bytes each
        for name, size, offset in (("a_pos", 3, 0), ("a_color", 3, 3 * 4)):
            loc = gl.getAttribLocation(program, name)
            gl.enableVertexAttribArray(loc)
            gl.vertexAttribPointer(loc, size, gl.FLOAT, False, stride, offset)

        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, gl.createBuffer())
        gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, host.u16(indices), gl.STATIC_DRAW)
        gl.bindVertexArray(None)

    def draw(self):
        gl.bindVertexArray(self.vao)
        gl.drawElements(gl.TRIANGLES, self.count, gl.UNSIGNED_SHORT, 0)


def cube_mesh(program):
    faces = [  # (normal axis, sign, color)
        (0, 1, (0.89, 0.42, 0.25)), (0, -1, (0.64, 0.33, 0.17)),
        (1, 1, (0.96, 0.78, 0.45)), (1, -1, (0.55, 0.42, 0.30)),
        (2, 1, (0.36, 0.60, 0.62)), (2, -1, (0.24, 0.42, 0.45)),
    ]
    vertices, indices = [], []
    for axis, sign, color in faces:
        u, v = (axis + 1) % 3, (axis + 2) % 3
        base = len(vertices)
        for du, dv in ((-1, -1), (1, -1), (1, 1), (-1, 1)):
            p = [0.0, 0.0, 0.0]
            p[axis], p[u], p[v] = 0.5 * sign, 0.5 * du * sign, 0.5 * dv
            vertices.append([*p, *color])
        indices += [base, base + 1, base + 2, base, base + 2, base + 3]
    return Mesh(program, vertices, indices)


def floor_mesh(program, tiles=10, size=1.0):
    vertices, indices = [], []
    half = tiles * size / 2
    for i in range(tiles):
        for j in range(tiles):
            color = (0.93, 0.89, 0.80) if (i + j) % 2 else (0.80, 0.74, 0.62)
            x0, z0 = i * size - half, j * size - half
            base = len(vertices)
            for x, z in ((x0, z0), (x0, z0 + size), (x0 + size, z0 + size), (x0 + size, z0)):
                vertices.append([x, 0.0, z, *color])
            indices += [base, base + 1, base + 2, base, base + 2, base + 3]
    return Mesh(program, vertices, indices)


def triangle_mesh(program):
    return Mesh(program, [
        [0.0, 1.0, 0.0, 0.89, 0.42, 0.25],
        [-0.87, -0.5, 0.0, 0.96, 0.78, 0.45],
        [0.87, -0.5, 0.0, 0.36, 0.60, 0.62],
    ], [0, 1, 2])


# ---------- matrices (4x4 numpy arrays, applied to column vectors) ----------

def translate(x, y, z):
    m = np.eye(4, dtype=np.float32)
    m[:3, 3] = (x, y, z)
    return m


def scale(s):
    m = np.eye(4, dtype=np.float32)
    m[0, 0] = m[1, 1] = m[2, 2] = s
    return m


def rotate_y(a):
    m = np.eye(4, dtype=np.float32)
    m[0, 0], m[0, 2], m[2, 0], m[2, 2] = cos(a), sin(a), -sin(a), cos(a)
    return m


def rotate_z(a):
    m = np.eye(4, dtype=np.float32)
    m[0, 0], m[0, 1], m[1, 0], m[1, 1] = cos(a), -sin(a), sin(a), cos(a)
    return m


def perspective(fov_y, aspect, near, far):
    f = 1.0 / tan(fov_y / 2)
    m = np.zeros((4, 4), dtype=np.float32)
    m[0, 0], m[1, 1] = f / aspect, f
    m[2, 2], m[2, 3] = (far + near) / (near - far), 2 * far * near / (near - far)
    m[3, 2] = -1.0
    return m


def orthographic(left, right, bottom, top, near=-1.0, far=1.0):
    m = np.eye(4, dtype=np.float32)
    m[0, 0], m[1, 1], m[2, 2] = 2 / (right - left), 2 / (top - bottom), -2 / (far - near)
    m[0, 3] = -(right + left) / (right - left)
    m[1, 3] = -(top + bottom) / (top - bottom)
    m[2, 3] = -(far + near) / (far - near)
    return m


def look_at(eye, target, up=(0.0, 1.0, 0.0)):
    eye, target, up = (np.asarray(v, dtype=np.float32) for v in (eye, target, up))
    f = target - eye
    f /= np.linalg.norm(f)
    r = np.cross(f, up)
    r /= np.linalg.norm(r)
    u = np.cross(r, f)
    m = np.eye(4, dtype=np.float32)
    m[0, :3], m[1, :3], m[2, :3] = r, u, -f
    m[:3, 3] = -(m[:3, :3] @ eye)
    return m


# ---------- scene ----------

program = make_program(VERTEX_SHADER, FRAGMENT_SHADER)
u_mvp = gl.getUniformLocation(program, "u_mvp")

cube = cube_mesh(program)
floor = floor_mesh(program)
triangle = triangle_mesh(program)

camera = {"yaw": radians(35), "pitch": radians(25), "distance": 6.0}
cube_pos = np.array([0.0, 0.5, 0.0], dtype=np.float32)


def draw(mesh, mvp):
    gl.uniformMatrix4fv(u_mvp, False, host.mat4(mvp))
    mesh.draw()


def update(dt, t):
    # --- input ---
    if host.mouse.down:
        camera["yaw"] -= host.mouse.dx * 0.005
        camera["pitch"] = min(radians(85), max(radians(5), camera["pitch"] + host.mouse.dy * 0.005))
    camera["distance"] = min(20.0, max(2.5, camera["distance"] * (1 + host.mouse.wheel * 0.001)))

    # WASD moves the cube relative to where the camera is facing
    forward = np.array([-sin(camera["yaw"]), 0.0, -cos(camera["yaw"])], dtype=np.float32)
    right = np.array([cos(camera["yaw"]), 0.0, -sin(camera["yaw"])], dtype=np.float32)
    move = (("KeyW" in host.keys) - ("KeyS" in host.keys)) * forward \
         + (("KeyD" in host.keys) - ("KeyA" in host.keys)) * right
    cube_pos[:] = np.clip(cube_pos + move * 3.0 * dt, [-4.5, 0.5, -4.5], [4.5, 0.5, 4.5])

    # --- 3D pass: perspective camera orbiting the origin ---
    gl.clearColor(0.08, 0.07, 0.05, 1.0)
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT)
    gl.useProgram(program)
    gl.enable(gl.DEPTH_TEST)

    aspect = host.width / host.height
    d, yaw, pitch = camera["distance"], camera["yaw"], camera["pitch"]
    eye = (d * cos(pitch) * sin(yaw), d * sin(pitch), d * cos(pitch) * cos(yaw))
    view_proj = perspective(radians(50), aspect, 0.1, 100.0) @ look_at(eye, (0.0, 0.5, 0.0))

    draw(floor, view_proj)
    draw(cube, view_proj @ translate(*cube_pos) @ rotate_y(t))

    # --- 2D pass: same meshes and shader, flat camera measured in pixels ---
    gl.disable(gl.DEPTH_TEST)
    pixels = orthographic(0, host.width, 0, host.height)
    size = host.height * 0.07
    draw(triangle, pixels @ translate(size * 1.6, host.height - size * 1.6, 0) @ rotate_z(-t) @ scale(size))


host.run(update)
