// raymarch.glsl — the renderer. For each pixel: shoot a ray from the camera,
// step along it by the scene's distance (sphere tracing), then light the hit point.
// Uses map(), material() and overlay() from scene.glsl.

out vec4 out_color;

const int MAX_STEPS = 96;
const float MAX_DISTANCE = 40.0;
const vec3 LIGHT_DIR = normalize(vec3(0.6, 0.8, 0.4));

// Edge shading mode (u_edges = 1)
const float EDGE_PIXELS = 1.0;    // width of the fully inked core of each line, in pixels
const float EDGE_SOFTNESS = 5.0;  // extra pixels over which the ink fades out (0 = crisp)
const vec3 PAPER = vec3(0.97, 0.95, 0.90);
const vec3 INK = vec3(0.16, 0.13, 0.10);
const vec3 TONE = vec3(0.78, 0.72, 0.62);  // the single shadow tone (u_tone = 1)
const float TONE_THRESHOLD = 0.25;         // light level below which a point is shaded

// Scribble shading (u_scribble = 1): the tone is drawn as pencil strokes
const float SCRIBBLE_INTERVAL = 0.5;  // seconds between redraws
const float SCRIBBLE_SPACING = 7.0;   // pixels between strokes
const float SCRIBBLE_WIDTH = 0.30;    // stroke thickness as a fraction of the spacing
const float SCRIBBLE_SMEAR = 0.7;     // 0 = clean strokes, 1 = heavily smudged
const vec3 PENCIL = vec3(0.47, 0.42, 0.36);

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

// ---------- scribble texture ----------

float hash(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}

// Smooth random values: 0..1, changing gradually across p
float noise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x),
               mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
}

// How much pencil is on the paper at screen pixel px (0 = none, 1 = full stroke).
// `seed` picks the drawing: a different seed gives a completely different scribble.
float scribble(vec2 px, float seed) {
    vec2 shift = vec2(seed * 37.0, seed * 91.0);
    float angle = 0.75 + 0.6 * (hash(vec2(seed, 1.0)) - 0.5);  // stroke direction varies per drawing
    vec2 q = rot(angle) * px;  // q.x runs along the strokes, q.y across them

    // Parallel lines, pushed sideways by noise so they wobble like a hand-drawn stroke
    float wobble = (noise(q * vec2(0.012, 0.04) + shift) - 0.5) * 14.0
                 + (noise(q * 0.08 + shift) - 0.5) * 3.0;
    float across = abs(fract((q.y + wobble) / SCRIBBLE_SPACING) - 0.5) * 2.0;  // 0 on a stroke's center

    // Smearing widens each stroke's soft edge until neighbouring strokes bleed together
    float soft = 0.2 + 0.9 * SCRIBBLE_SMEAR;
    float stroke = 1.0 - smoothstep(SCRIBBLE_WIDTH * (1.0 - 0.7 * SCRIBBLE_SMEAR), SCRIBBLE_WIDTH + soft, across);

    // Uneven pressure: strokes fade in and out along their length
    float pressure = smoothstep(0.2, 0.6, noise(q * vec2(0.02, 0.15) + shift * 1.7));
    stroke *= mix(0.4, 1.0, pressure);

    // Smudge: a patchy graphite haze dragged along the stroke direction (long in q.x,
    // short in q.y), with fine streaks in it like pencil rubbed by a finger
    float patches = smoothstep(0.15, 0.85, noise(q * vec2(0.006, 0.03) + shift * 0.5));
    float streaks = 0.65 + 0.35 * noise(q * vec2(0.03, 0.7) + shift * 2.3);
    float smudge = SCRIBBLE_SMEAR * 0.75 * patches * streaks;

    return 1.0 - (1.0 - stroke) * (1.0 - smudge);  // layer the strokes over the smudge
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
        // Edge mode: no smooth lighting. A surface is inked only where it turns away from the
        // camera, i.e. where dot(view direction, normal) is close to 0.
        // "Close" is measured in screen pixels: fwidth() says how much `facing` changes
        // from one pixel to the next, so facing / fwidth(facing) is roughly the number of
        // pixels to the nearest edge. That keeps lines the same width on every shape.
        //
        // u_layer picks which part to draw, so the two parts can run at different
        // resolutions (see draw() in main.py):
        //   0 = shade + ink together
        //   1 = shade only: how strongly each point is shaded, rendered into a texture
        //   2 = ink only, drawn over that texture
        bool draw_shade = u_layer < 1.5;
        bool draw_ink = u_layer < 0.5 || u_layer > 1.5;

        float facing = 1.0;  // 1 = facing the camera, 0 = edge-on
        float shade = 0.0;   // 1 = in the shadow tone, 0 = lit (left as paper)
        if (hit.y >= 0.0) {
            vec3 p = u_cam_pos + dir * hit.x;
            vec3 n = normal_at(p);
            facing = abs(dot(n, dir));
            if (draw_shade && u_tone > 0.5) {
                // One-tone shading: light is either on or off. A point takes the tone
                // if it faces away from the light or something blocks the light.
                float light = max(dot(n, LIGHT_DIR), 0.0) * soft_shadow(p + n * 0.01, LIGHT_DIR, 12.0);
                shade = 1.0 - smoothstep(TONE_THRESHOLD - 0.02, TONE_THRESHOLD + 0.02, light);
            }
        }
        float visible = hit.y >= 0.0 ? exp(-0.002 * hit.x * hit.x) : 0.0;  // fades with distance

        // How strongly this point is shaded: computed here, or read from the shade pass
        float shaded = draw_shade ? shade * visible : texture(u_shade, frag_coord / u_resolution).r;
        if (u_layer > 0.5 && u_layer < 1.5) return vec3(shaded);  // the shade pass stores just that

        if (u_scribble > 0.5) {
            // Pencil strokes instead of a flat tone, redrawn every SCRIBBLE_INTERVAL seconds.
            // Dividing by u_edge_scale keeps strokes the same on-screen size at higher resolution.
            float drawing = floor(u_time / SCRIBBLE_INTERVAL);
            color = mix(PAPER, PENCIL, shaded * scribble(frag_coord / u_edge_scale, drawing));
        } else {
            color = mix(PAPER, TONE, shaded);
        }

        if (draw_ink) {
            // u_edge_scale keeps lines the same on-screen width when rendering at higher resolution
            float pixels_from_edge = facing / max(fwidth(facing), 0.00001) / u_edge_scale;
            float edge = 1.0 - smoothstep(EDGE_PIXELS, EDGE_PIXELS + max(EDGE_SOFTNESS, 1.0), pixels_from_edge);
            color = mix(color, INK, edge * visible);
        }
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
    if (u_antialias > 0.5 && u_layer < 1.5) {
        // Supersampling: average a 2x2 grid of rays inside the pixel. Smooths edges
        // at 4x the cost. (The high-resolution ink pass is already supersampled.)
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

    // The 2D layer antialiases itself (see overlay), so it's drawn once on top
    // (not into the intermediate shade texture).
    if (u_layer < 0.5 || u_layer > 1.5) {
        vec4 layer = overlay(gl_FragCoord.xy);
        color = mix(color, layer.rgb, layer.a);
    }

    out_color = vec4(color, 1.0);
}
