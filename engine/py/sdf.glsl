// sdf.glsl — signed distance functions: the engine's building blocks.
// Each returns the distance from point p to a shape centered at the origin
// (negative inside). Move a shape by subtracting its position from p first.

// ---------- 3D primitives ----------

float sd_sphere(vec3 p, float radius) {
    return length(p) - radius;
}

float sd_box(vec3 p, vec3 half_size) {
    vec3 q = abs(p) - half_size;
    return length(max(q, 0.0)) + min(max(q.x, max(q.y, q.z)), 0.0);
}

float sd_round_box(vec3 p, vec3 half_size, float radius) {
    return sd_box(p, half_size - radius) - radius;
}

// Ring lying flat in the xz plane. size = (ring radius, tube radius)
float sd_torus(vec3 p, vec2 size) {
    vec2 q = vec2(length(p.xz) - size.x, p.y);
    return length(q) - size.y;
}

// Infinite floor at y = height
float sd_floor(vec3 p, float height) {
    return p.y - height;
}

// ---------- 2D primitives (the same idea with z dropped) ----------

float sd_circle(vec2 p, float radius) {
    return length(p) - radius;
}

float sd_box2(vec2 p, vec2 half_size) {
    vec2 q = abs(p) - half_size;
    return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0);
}

// Equilateral triangle, pointing up
float sd_triangle(vec2 p, float radius) {
    const float k = 1.7320508;  // sqrt(3)
    p.x = abs(p.x) - radius;
    p.y = p.y + radius / k;
    if (p.x + k * p.y > 0.0) p = vec2(p.x - k * p.y, -k * p.x - p.y) / 2.0;
    p.x -= clamp(p.x, -2.0 * radius, 0.0);
    return -length(p) * sign(p.y);
}

// ---------- combining shapes ----------

float op_union(float a, float b)     { return min(a, b); }
float op_intersect(float a, float b) { return max(a, b); }
float op_subtract(float a, float b)  { return max(a, -b); }  // a with b carved out

// Union that melts the shapes together; k is the blend width
float op_smooth_union(float a, float b, float k) {
    float h = clamp(0.5 + 0.5 * (b - a) / k, 0.0, 1.0);
    return mix(b, a, h) - k * h * (1.0 - h);
}

// ---------- transforms ----------

// 2D rotation; use on two components of p, e.g. p.xz = rot(angle) * p.xz
mat2 rot(float angle) {
    float c = cos(angle), s = sin(angle);
    return mat2(c, -s, s, c);
}
