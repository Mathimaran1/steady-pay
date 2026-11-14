// WebGL particle scene for the home page story (three.js).
// ~14k glowing particles morph between eight shapes as you scroll:
// vault → split → locked tax ring → calm pot → payday pulses → quiet months → the logo.
import {
  WebGLRenderer, Scene, PerspectiveCamera, BufferGeometry, BufferAttribute,
  Points, ShaderMaterial, AdditiveBlending, Color,
} from "three";

const DEFAULT_PARTICLES = 14000;
const TAX_SHARE = 0.3;
const CREAM = new Color("#ede7db");
const AMBER = new Color("#ffb35c");

const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
const ease = (t) => t * t * (3 - 2 * t);
const ramp = (c, a, b) => ease(clamp((c - a) / (b - a)));
const TAU = Math.PI * 2;

// deterministic randoms per particle
function rng(seed) { // mulberry32
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function gauss(r) {
  return Math.sqrt(-2 * Math.log(r() + 1e-9)) * Math.cos(TAU * r());
}

const vert = /* glsl */ `
  attribute vec3 color;
  attribute float alpha;
  attribute float size;
  varying vec3 vColor;
  varying float vAlpha;
  uniform float uPixel;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mv;
    gl_PointSize = size * uPixel / -mv.z;
    vColor = color;
    vAlpha = alpha;
  }
`;
const frag = /* glsl */ `
  varying vec3 vColor;
  varying float vAlpha;
  void main() {
    vec2 p = gl_PointCoord - 0.5;
    float d = length(p);
    float core = smoothstep(0.5, 0.0, d);
    float a = pow(core, 2.2) * vAlpha;
    if (a < 0.003) discard;
    gl_FragColor = vec4(vColor * a, a);
  }
`;

/** `particles`: fewer for the background on app pages, where the scene is decoration, not the story. */
export function createScene(canvas, { particles = DEFAULT_PARTICLES } = {}) {
  const N = particles;
  let renderer;
  try {
    renderer = new WebGLRenderer({ canvas, antialias: false, alpha: true, powerPreference: "high-performance" });
  } catch {
    return null; // no WebGL: the text story still works
  }
  renderer.setClearColor(0x000000, 0);
  const scene = new Scene();
  const camera = new PerspectiveCamera(45, 1, 0.1, 100);
  camera.position.set(0, 0, 9);

  const pos = new Float32Array(N * 3);
  const col = new Float32Array(N * 3);
  const alp = new Float32Array(N);
  const siz = new Float32Array(N);
  const geo = new BufferGeometry();
  geo.setAttribute("position", new BufferAttribute(pos, 3));
  geo.setAttribute("color", new BufferAttribute(col, 3));
  geo.setAttribute("alpha", new BufferAttribute(alp, 1));
  geo.setAttribute("size", new BufferAttribute(siz, 1));
  const mat = new ShaderMaterial({
    vertexShader: vert, fragmentShader: frag, transparent: true, depthWrite: false, blending: AdditiveBlending,
    uniforms: { uPixel: { value: 300 } },
  });
  const points = new Points(geo, mat);
  points.frustumCulled = false;
  scene.add(points);

  // faint background dust so the dark areas read as depth, not blank space
  const DUST = 1800;
  const dPos = new Float32Array(DUST * 3), dCol = new Float32Array(DUST * 3), dAlp = new Float32Array(DUST), dSiz = new Float32Array(DUST);
  {
    const r = rng(424242);
    for (let i = 0; i < DUST; i++) {
      dPos[i * 3] = (r() - 0.5) * 26; dPos[i * 3 + 1] = (r() - 0.5) * 15; dPos[i * 3 + 2] = -8 + r() * 10;
      const c = r() < 0.18 ? AMBER : CREAM;
      dCol[i * 3] = c.r; dCol[i * 3 + 1] = c.g; dCol[i * 3 + 2] = c.b;
      dAlp[i] = 0.12 + r() * r() * 0.55;
      dSiz[i] = 1.4 + r() * r() * 3.2;
    }
  }
  const dGeo = new BufferGeometry();
  dGeo.setAttribute("position", new BufferAttribute(dPos, 3));
  dGeo.setAttribute("color", new BufferAttribute(dCol, 3));
  dGeo.setAttribute("alpha", new BufferAttribute(dAlp, 1));
  dGeo.setAttribute("size", new BufferAttribute(dSiz, 1));
  const dust = new Points(dGeo, mat);
  dust.frustumCulled = false;
  scene.add(dust);

  // embers: warm gold sparks rising slowly from the bottom, like coins catching the light
  const EMBERS = 420;
  const eP = new Float32Array(EMBERS * 3), eC = new Float32Array(EMBERS * 3), eA = new Float32Array(EMBERS), eS = new Float32Array(EMBERS);
  const eK = [];
  {
    const r = rng(777);
    const gold = new Color("#ffd9a8");
    for (let i = 0; i < EMBERS; i++) {
      const c = r() < 0.6 ? AMBER : gold;
      eC[i * 3] = c.r; eC[i * 3 + 1] = c.g; eC[i * 3 + 2] = c.b;
      const z = -6 + r() * 6;
      eK.push({ x: (r() - 0.5) * 22, z, speed: 0.25 + r() * 0.5, phase: r(), sway: 0.2 + r() * 0.6, tw: r() * TAU, a: 0.55 + r() * 1.05 });
      eS[i] = 2.2 + r() * r() * 6;
    }
  }
  const eGeo = new BufferGeometry();
  eGeo.setAttribute("position", new BufferAttribute(eP, 3));
  eGeo.setAttribute("color", new BufferAttribute(eC, 3));
  eGeo.setAttribute("alpha", new BufferAttribute(eA, 1));
  eGeo.setAttribute("size", new BufferAttribute(eS, 1));
  const embers = new Points(eGeo, mat);
  embers.frustumCulled = false;
  scene.add(embers);

  function updateEmbers(t) {
    const span = 16; // world units from below the screen to above it
    for (let i = 0; i < EMBERS; i++) {
      const k = eK[i];
      const q = (((k.phase + t * k.speed / span) % 1) + 1) % 1; // 0 at the bottom, 1 at the top
      eP[i * 3] = k.x + Math.sin(t * 0.5 + k.tw) * k.sway;
      eP[i * 3 + 1] = -8 + q * span;
      eP[i * 3 + 2] = k.z;
      const fade = Math.sin(Math.PI * q); // fade in at the bottom, out at the top
      eA[i] = k.a * fade * (0.65 + 0.35 * Math.sin(t * 2.3 + k.tw * 3));
    }
    eGeo.attributes.position.needsUpdate = true;
    eGeo.attributes.alpha.needsUpdate = true;
  }



  // ---- per-particle constants ----
  const P = [];
  const NT = Math.floor(N * TAX_SHARE);
  for (let i = 0; i < N; i++) {
    const r = rng(i * 7919 + 13);
    // fibonacci sphere direction, spread over the particle's own group (tax / pot) so each forms a full sphere
    const tax = i < NT, n = tax ? NT : N - NT, j = tax ? i : i - NT;
    const k = j + 0.5, phi = Math.acos(1 - (2 * k) / n), th = Math.PI * (1 + Math.sqrt(5)) * k;
    P.push({
      tax,
      r1: r(), r2: r(), r3: r(), g1: gauss(r), g2: gauss(r), g3: gauss(r),
      sx: Math.sin(phi) * Math.cos(th), sy: Math.cos(phi), sz: Math.sin(phi) * Math.sin(th),
      base: 0.6 + r() * 1.4,
    });
  }

  // ---- shapes: each writes [x,y,z] for particle p at time t ----
  const out = [0, 0, 0], A = [0, 0, 0], B = [0, 0, 0];
  const set = (o, x, y, z) => { o[0] = x; o[1] = y; o[2] = z; };

  function sphere(o, p, t, R, wobble = 0.06) {
    const n = 1 + wobble * Math.sin(t * 1.3 + p.r1 * 12) + 0.04 * p.g1;
    const a = t * 0.15;
    const x = p.sx * R * n, z = p.sz * R * n;
    set(o, x * Math.cos(a) - z * Math.sin(a), p.sy * R * n, x * Math.sin(a) + z * Math.cos(a));
  }
  function taxRing(o, p, t, R) {
    const a = p.r1 * TAU + t * 0.25;
    const rr = R + p.g1 * 0.07, h = p.g2 * 0.05;
    const x = Math.cos(a) * rr, z = Math.sin(a) * rr;
    // tilt the ring
    const tilt = 1.15;
    set(o, x, h * Math.cos(tilt) - z * Math.sin(tilt) * 0.35, h * Math.sin(tilt) + z * Math.cos(tilt));
  }
  function logo(o, p, t) {
    // spirit level: capsule outline, two ticks, amber bubble
    const W = 3.6, H = 1.5, R = H / 2;
    if (p.tax) {
      if (p.r3 < 0.55) { // bubble
        const a = p.r1 * TAU, rr = Math.sqrt(p.r2) * 0.42;
        set(o, Math.cos(a) * rr + 0.015 * Math.sin(t * 2 + p.r1 * 9), Math.sin(a) * rr, p.g3 * 0.05);
        return;
      }
      // the rest of the gold makes a faint halo around the bubble
      const a = p.r1 * TAU, rr = 0.55 + Math.abs(p.g1) * 0.25;
      set(o, Math.cos(a) * rr, Math.sin(a) * rr, p.g2 * 0.1);
      return;
    }
    const q = p.r1;
    if (q < 0.84) { // capsule outline
      const straight = 2 * (W - 2 * R), arc = TAU * R, L = straight + arc;
      let s = (p.r2 * L);
      let x, y;
      if (s < W - 2 * R) { x = -W / 2 + R + s; y = R; }
      else if ((s -= W - 2 * R) < Math.PI * R) { const a = Math.PI / 2 - s / R; x = W / 2 - R + Math.cos(a) * R; y = Math.sin(a) * R; }
      else if ((s -= Math.PI * R) < W - 2 * R) { x = W / 2 - R - s; y = -R; }
      else { s -= W - 2 * R; const a = -Math.PI / 2 - s / R; x = -W / 2 + R + Math.cos(a) * R; y = Math.sin(a) * R; }
      set(o, x + p.g1 * 0.018, y + p.g2 * 0.018, p.g3 * 0.03);
    } else { // two tick marks
      const x = p.r2 < 0.5 ? -0.85 : 0.85;
      set(o, x + p.g1 * 0.015, (p.r3 - 0.5) * 0.85, p.g3 * 0.03);
    }
  }

  // chapter index -> shape
  function shape(o, k, p, t) {
    switch (k) {
      case 0: case 1: sphere(o, p, t, 1.55, 0.09); return; // the vault
      case 2: // split: tax drifts up and right as a smaller cloud
        if (p.tax) { sphere(o, p, t, 0.75, 0.12); o[0] += 1.9; o[1] += 1.25; o[2] -= 0.3; return; }
        sphere(o, p, t, 1.4); o[0] -= 0.35; o[1] -= 0.2; return;
      case 3: case 4:
        if (p.tax) { taxRing(o, p, t, k === 3 ? 2.35 : 2.6); return; }
        sphere(o, p, t, k === 3 ? 1.3 : 1.25, k === 3 ? 0.05 : 0.025); return;
      case 5: case 6: {
        if (p.tax) { taxRing(o, p, t, 2.6); return; }
        const R = k === 5 ? 1.2 : 0.95;
        if (p.r3 < 0.32) { // payday shockwave shells, one every ~2.2 s
          const phase = ((t / 2.2 + p.r2 * 0.12) % 1 + 1) % 1;
          const rr = R + ease(phase) * 3.4;
          set(o, p.sx * rr, p.sy * rr * 0.35, p.sz * rr);
          return;
        }
        sphere(o, p, t, R, 0.02); return;
      }
      default: logo(o, p, t);
    }
  }
  function shapeAlpha(k, p, t) {
    if ((k === 5 || k === 6) && !p.tax && p.r3 < 0.32) {
      const phase = ((t / 2.2 + p.r2 * 0.12) % 1 + 1) % 1;
      return 1 - phase;
    }
    if (k === 7 && p.tax && p.r3 >= 0.55) return 0.25;
    return 1;
  }

  let w = 1, h = 1, mx = 0, my = 0, cmx = 0, cmy = 0, wide = true, storyC = 0;
  // the design sits opposite the text: right for chapters 1, 3, 5, 7; left for 2, 4, 6
  let fixedX = null, fixedScale = null, fixedY = null; // set by place() on the app pages
  const sideX = (c) => (fixedX !== null ? (wide ? fixedX : 0) : wide ? 1.45 * Math.cos(Math.PI * c) : 0);
  function place(x, scale, y = null) { fixedX = x; fixedScale = scale; fixedY = y; }
  function resize(width, height) {
    w = width; h = height;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    renderer.setPixelRatio(dpr);
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    // keep the composition inside narrow (phone) screens
    wide = w >= 900;
    camera.position.z = w / h < 0.8 ? 14 : 9;
    // on wide screens: bigger, and to the right of the big title
    points.scale.setScalar(fixedScale !== null ? (wide ? fixedScale : 0.8) : wide ? 1.3 : 1);
    // phones: lift the scene into the top half so it sits above the chapter text
    points.position.set(sideX(storyC), wide ? (fixedY ?? 0.25) : (w / h < 0.8 ? 1.5 : 0.35), 0);
    camera.updateProjectionMatrix();
    mat.uniforms.uPixel.value = h * dpr * 0.045;
  }
  function pointer(x, y) { mx = x; my = y; }

  function render(c, time, reduce) {
    storyC = c;
    points.position.x = sideX(c);
    c += 1; // the story opens on the vault (shape 1); shape 0 is not used
    const t = reduce ? 0 : time / 1000;
    const k0 = Math.floor(clamp(c, 0, 7)), k1 = Math.min(7, k0 + 1);
    const f = ease(clamp(c - k0));
    const split = ramp(c, 1.5, 2.2);
    const intro = ease(clamp(time / 1800));
    const logoGlow = ramp(c, 6.6, 7);

    for (let i = 0; i < N; i++) {
      const p = P[i];
      shape(A, k0, p, t);
      if (f > 0.001 && k1 !== k0) {
        shape(B, k1, p, t);
        // stagger the morph a little per particle so shapes "pour" into each other
        const ff = ease(clamp(f * 1.6 - p.r1 * 0.6));
        out[0] = A[0] + (B[0] - A[0]) * ff; out[1] = A[1] + (B[1] - A[1]) * ff; out[2] = A[2] + (B[2] - A[2]) * ff;
      } else { out[0] = A[0]; out[1] = A[1]; out[2] = A[2]; }
      // intro: particles fall in from a wide scatter
      const sc = 1 + (1 - intro) * (2 + p.r2 * 4);
      pos[i * 3] = out[0] * sc; pos[i * 3 + 1] = out[1] * sc; pos[i * 3 + 2] = out[2] * sc;

      const a0 = shapeAlpha(k0, p, t), a1 = shapeAlpha(k1, p, t);
      alp[i] = (a0 + (a1 - a0) * f) * intro * 0.55;
      const amber = p.tax ? split : 0;
      const cc = amber ? AMBER : CREAM;
      const mix = p.tax ? amber : 0;
      col[i * 3] = CREAM.r + (cc.r - CREAM.r) * mix;
      col[i * 3 + 1] = CREAM.g + (cc.g - CREAM.g) * mix;
      col[i * 3 + 2] = CREAM.b + (cc.b - CREAM.b) * mix;
      siz[i] = p.base * (1 + (p.tax && logoGlow ? 0.6 * logoGlow : 0));
    }
    geo.attributes.position.needsUpdate = true;
    geo.attributes.color.needsUpdate = true;
    geo.attributes.alpha.needsUpdate = true;
    geo.attributes.size.needsUpdate = true;

    // gentle camera drift + pointer parallax; straighten up for the logo
    cmx += (mx - cmx) * 0.04; cmy += (my - cmy) * 0.04;
    const settle = 1 - logoGlow;
    points.rotation.y = (cmx * 0.35 + Math.sin(t * 0.1) * 0.15) * settle;
    points.rotation.x = (cmy * 0.25 + 0.18 * ramp(c, 2.5, 3.2)) * settle;
    updateEmbers(reduce ? 0 : Math.max(0, time) / 1000);
    embers.position.x = cmx * 0.6;
    dust.rotation.y = t * 0.008 + cmx * 0.08;
    dust.rotation.x = cmy * 0.05;
    renderer.render(scene, camera);
  }

  function dispose() {
    geo.dispose(); dGeo.dispose(); eGeo.dispose(); mat.dispose(); renderer.dispose(); renderer.forceContextLoss();
  }
  return { resize, render, pointer, place, dispose };
}
