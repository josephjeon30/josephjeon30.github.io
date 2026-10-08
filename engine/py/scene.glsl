// scene.glsl — what's in the world. Edit this to change the scene.
//
// Available from the engine (set by main.py every frame):
//   u_time (seconds), u_resolution (pixels), and any uniform you declare here
//   and set from Python with set_uniform(...) in main.py.

uniform vec3 u_box_pos;  // moved with WASD in main.py

const float MAT_FLOOR = 0.0;
const float MAT_BLOB = 1.0;
const float MAT_RING = 2.0;

// The 3D scene: returns (distance to the nearest surface, its material id).
vec2 map(vec3 p) {
    float ground = sd_floor(p, 0.0);

    // A bobbing sphere that melts into the box when they get close
    float sphere = sd_sphere(p - vec3(0.0, 1.1 + 0.4 * sin(u_time * 1.3), 0.0), 0.7);
    vec3 q = p - u_box_pos;
    q.xz = rot(u_time * 0.6) * q.xz;
    float box = sd_round_box(q, vec3(0.5), 0.1);
    float blob = op_smooth_union(sphere, box, 0.5);

    float ring = sd_torus(p - vec3(-2.4, 0.25, -1.2), vec2(0.7, 0.25));

    vec2 hit = vec2(ground, MAT_FLOOR);
    if (blob < hit.x) hit = vec2(blob, MAT_BLOB);
    if (ring < hit.x) hit = vec2(ring, MAT_RING);
    return hit;
}

// Surface color for a material id at point p.
vec3 material(float id, vec3 p) {
    if (id == MAT_BLOB) return vec3(0.62, 0.17, 0.07);
    if (id == MAT_RING) return vec3(0.07, 0.27, 0.33);
    // floor: checkerboard
    float check = mod(floor(p.x) + floor(p.z), 2.0);
    return mix(vec3(0.33, 0.28, 0.20), vec3(0.68, 0.61, 0.48), check);
}

// The 2D layer, drawn on top. px is the pixel position (origin bottom-left).
// Returns (color, opacity). 2D shapes are SDFs too, just without z.
vec4 overlay(vec2 px) {
    float size = u_resolution.y * 0.06;
    vec2 center = vec2(size * 1.8, u_resolution.y - size * 1.8);
    float d = sd_triangle(rot(u_time) * (px - center), size);

    vec3 color = mix(vec3(0.96, 0.78, 0.45), vec3(0.16, 0.13, 0.10), smoothstep(-3.0, -2.0, d));  // dark outline
    float opacity = 1.0 - smoothstep(-0.75, 0.75, d);  // 1.5 px soft edge = antialiasing
    return vec4(color, opacity);
}
