// raymarch.glsl — the renderer. For each pixel: shoot a ray from the camera,
// step along it by the scene's distance (sphere tracing), then light the hit point.
// Uses map(), material() and overlay() from scene.glsl.

out vec4 out_color;

const int MAX_STEPS = 96;
const float MAX_DISTANCE = 40.0;
const vec3 LIGHT_DIR = normalize(vec3(0.6, 0.8, 0.4));

// Edge shading mode (u_edges = 1)
const float EDGE_PIXELS = 2.5;  // line thickness in pixels
const vec3 PAPER = vec3(0.97, 0.95, 0.90);
const vec3 INK = vec3(0.16, 0.13, 0.10);

// Returns (distance travelled, material id). Material is -1 when nothing was hit.
vec2 march(vec3 origin, vec3 dir) {
    float t = 0.0;
    for (int i = 0; i < MAX_STEPS; i++) {
        vec2 hit = map(origin + dir * t);
        if (hit.x < max(0.0005, 0.001 * t)) return vec2(t, hit.y);  // close enough (looser far away)
        t += hit.x;
        if (t > MAX_DISTANCE) break;
    }
    return vec2(t, -1.0);
}

// Surface normal = direction in which the distance grows fastest.
vec3 normal_at(vec3 p) {
    vec2 e = vec2(1.0, -1.0) * 0.0005;
    return normalize(e.xyy * map(p + e.xyy).x + e.yyx * map(p + e.yyx).x +
                     e.yxy * map(p + e.yxy).x + e.xxx * map(p + e.xxx).x);
}

// March toward the light; near misses darken the result, giving soft edges.
float soft_shadow(vec3 origin, vec3 dir, float sharpness) {
    float light = 1.0;
    float t = 0.02;
    for (int i = 0; i < 32; i++) {
        float d = map(origin + dir * t).x;
        if (d < 0.001) return 0.0;
        light = min(light, sharpness * d / t);
        t += clamp(d, 0.02, 0.5);
        if (t > 12.0) break;
    }
    return light;
}

vec3 sky(vec3 dir) {
    return mix(vec3(0.93, 0.88, 0.78), vec3(0.47, 0.62, 0.74), clamp(dir.y * 1.3 + 0.1, 0.0, 1.0));
}

// The color of the scene along the ray through one point on the screen
// (frag_coord is in pixels and may fall between pixel centers).
vec3 render(vec2 frag_coord) {
    // Screen point -> ray. uv is centered, with y from -1 to 1.
    vec2 uv = (frag_coord * 2.0 - u_resolution) / u_resolution.y;
    vec3 dir = normalize(u_cam_forward * u_cam_focal + u_cam_right * uv.x + u_cam_up * uv.y);

    vec3 color;
    vec2 hit = march(u_cam_pos, dir);

    if (u_edges > 0.5) {
        // Edge mode: no lighting. A surface is inked only where it turns away from the
        // camera, i.e. where dot(view direction, normal) is close to 0.
        // "Close" is measured in screen pixels: fwidth() says how much `facing` changes
        // from one pixel to the next, so facing / fwidth(facing) is roughly the number of
        // pixels to the nearest edge. That keeps lines the same width on every shape.
        float facing = 1.0;  // 1 = facing the camera, 0 = edge-on
        if (hit.y >= 0.0) facing = abs(dot(normal_at(u_cam_pos + dir * hit.x), dir));
        float pixels_from_edge = facing / max(fwidth(facing), 0.00001);
        float edge = 1.0 - smoothstep(EDGE_PIXELS - 0.5, EDGE_PIXELS + 0.5, pixels_from_edge);
        float fog = 1.0 - exp(-0.002 * hit.x * hit.x);
        color = mix(PAPER, INK, hit.y >= 0.0 ? edge * (1.0 - fog) : 0.0);
    } else {
        color = sky(dir);
        if (hit.y >= 0.0) {
            vec3 p = u_cam_pos + dir * hit.x;
            vec3 n = normal_at(p);
            vec3 base = material(hit.y, p);

            float sun = max(dot(n, LIGHT_DIR), 0.0) * soft_shadow(p + n * 0.01, LIGHT_DIR, 12.0);
            float ambient = 0.25 + 0.15 * n.y;
            vec3 lit = base * (sun * vec3(1.0, 0.95, 0.85) + ambient * vec3(0.75, 0.85, 1.0));

            float fog = 1.0 - exp(-0.002 * hit.x * hit.x);
            color = mix(lit, sky(dir), fog);
        }
        color = pow(color, vec3(0.4545));  // gamma correction
    }

    return color;
}

void main() {
    vec3 color;
    if (u_antialias > 0.5) {
        // Supersampling: average a 2x2 grid of rays inside the pixel. Smooths edges
        // at 4x the cost.
        color = vec3(0.0);
        for (int i = 0; i < 2; i++) {
            for (int j = 0; j < 2; j++) {
                vec2 offset = (vec2(float(i), float(j)) + 0.5) / 2.0 - 0.5;  // ±0.25 px
                color += render(gl_FragCoord.xy + offset);
            }
        }
        color /= 4.0;
    } else {
        color = render(gl_FragCoord.xy);
    }

    // The 2D layer antialiases itself (see overlay), so it's drawn once on top.
    vec4 layer = overlay(gl_FragCoord.xy);
    color = mix(color, layer.rgb, layer.a);

    out_color = vec4(color, 1.0);
}
