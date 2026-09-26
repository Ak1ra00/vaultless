/* The Oracle sheets, drawn live.
 *
 * Everything on this page that is not a form is a diagram of the maths the
 * form runs on, after the backgrounds in Ak1ra00/oracle — and, like those,
 * nothing here is a picture. The chord on sheet 01 is computed from the two
 * points you drag. The 196 dots on sheet 02 are every solution of
 * y² ≡ x³ − 3x + 5 (mod 211), found when the page loads. The torus on sheet 05
 * is E(ℂ), and the line wound round it is k·z mod Λ — which is what scalar
 * multiplication IS, once the curve is seen as ℂ/Λ. The ring behind the whole
 * page is the group E(𝔽₂₁₁) laid out in scalar order.
 *
 * Isolation matters more than any of the drawing:
 *
 *   - This module imports nothing and is loaded by its own <script> tag, so it
 *     is a separate module graph. If it throws, app.js — and every password —
 *     is untouched.
 *   - The only application state it reads is two classes on <body>:
 *     `handshaking` (a derivation is in progress) and `hs-open` (the handshake
 *     pop-up is covering the page). No phrase, point, key or password is
 *     reachable from here. The curve maths below is a toy over ℝ and 𝔽₂₁₁ and
 *     shares nothing with the ristretto255 group derivation actually uses.
 *   - Reduced motion means REDUCED, not removed. A slideshow of still frames
 *     read as broken. So the diagrams keep drifting, at a third of the speed,
 *     with no scroll or pointer parallax; and the one full-screen layer — the
 *     backdrop, where large-field motion is what actually troubles people — does
 *     not turn at all, it only twinkles in place. Dragging still works.
 *   - Nothing animates off-screen, in a hidden tab, or under the pop-up.
 */

const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
/* How fast the diagrams move on their own: full speed, or calm. */
const PACE = reduceMotion ? 0.3 : 1;
/* The pop-up covers the whole page while it is open; nothing under it needs
 * drawing, and on a phone drawing it anyway is what made the pop-up stutter. */
const covered = () => document.body.classList.contains('hs-open');
const $ = (id) => document.getElementById(id);
const TAU = Math.PI * 2;

/* Not every phone can draw all of this at full rate. Once the page has settled,
 * the backdrop's loop keeps the spacing of the last couple of seconds' frames;
 * if most of them come slower than about 40 a second, everything drops to a
 * lighter setting — fewer pixels, fewer frames — for the rest of the visit. It
 * never switches back, so the page never flickers between the two. */
const load = { lite: false, gaps: [], span: 0, from: performance.now() + 2000 };
function frameGap(t, gap) {
  if (load.lite || t < load.from || gap <= 0 || gap > 250) return;   // a hidden tab, a pop-up, a stall
  load.gaps.push(gap);
  load.span += gap;
  if (load.span < 1500 || load.gaps.length < 20) return;
  const g = load.gaps.sort((a, b) => a - b);
  if (g[g.length >> 1] > 25) load.lite = true;
  load.gaps = []; load.span = 0;
}

/* colors.toml, as "r,g,b" so alpha can vary per stroke */
const C = {
  cyan: '43,217,201', hot: '127,242,230', violet: '185,138,255',
  amber: '224,166,64', ink: '126,155,159', ink1: '207,231,230', blue: '79,150,190',
};
const rgba = (c, a) => `rgba(${c},${a})`;
const MONO = "'JetBrains Mono', 'IBM Plex Mono', ui-monospace, monospace";
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const fract = (v) => v - Math.floor(v);
const BG = '#0a1014';

/* ================================================================ maths */

/* E(𝔽₂₁₁): y² = x³ − 3x + 5. 196 affine points plus 𝒪 makes 197, which is
 * prime — so the group is cyclic and every point other than 𝒪 generates all
 * of it. That is the fact sheet 02 is really about. */
const FP = 211, FA = -3, FB = 5;
const md = (n) => ((n % FP) + FP) % FP;
function finv(n) {
  let r = 1, b = md(n), e = FP - 2;
  while (e) { if (e & 1) r = r * b % FP; b = b * b % FP; e >>= 1; }
  return r;
}
function fadd(P, Q) {
  if (!P) return Q;
  if (!Q) return P;
  const [x1, y1] = P, [x2, y2] = Q;
  if (x1 === x2 && md(y1 + y2) === 0) return null;           // P + (−P) = 𝒪
  const l = (x1 === x2 && y1 === y2)
    ? md((3 * x1 * x1 + FA) * finv(2 * y1))                   // tangent
    : md((y2 - y1) * finv(x2 - x1));                          // chord
  const x3 = md(l * l - x1 - x2);
  return [x3, md(l * (x1 - x3) - y1)];
}
const FIELD = (() => {
  const roots = new Map();
  for (let y = 0; y < FP; y++) {
    const s = y * y % FP;
    if (!roots.has(s)) roots.set(s, []);
    roots.get(s).push(y);
  }
  const out = [];
  for (let x = 0; x < FP; x++) {
    for (const y of roots.get(md(x * x * x + FA * x + FB)) || []) out.push([x, y]);
  }
  return out;
})();
function walkFrom(P, n) {
  const out = [];
  let Q = P;
  for (let i = 0; i < n && Q; i++) { out.push(Q); Q = fadd(Q, P); }
  return out;
}

/* The same curve over ℝ, for the group law. x³ − 3x + 5 has one real root, so
 * the real curve is one piece: everything right of it. */
const rf = (x) => x * x * x - 3 * x + 5;
const ROOT = (() => { let x = -2.3; for (let i = 0; i < 40; i++) x -= rf(x) / (3 * x * x - 3); return x; })();

/* ===================================================== 3D, the plain way */

/* Yaw about the vertical, then pitch about the horizontal. Positive pitch lifts
 * the far side of the scene towards the top of the screen — looking down on it. */
function view(v, yaw, pitch) {
  const cy = Math.cos(yaw), sy = Math.sin(yaw), cp = Math.cos(pitch), sp = Math.sin(pitch);
  const x = v[0] * cy + v[2] * sy;
  const z0 = -v[0] * sy + v[2] * cy;
  return [x, v[1] * cp + z0 * sp, -v[1] * sp + z0 * cp];
}
function proj(p, cam) {
  const z = p[2] + cam.dist;
  const k = cam.f / z;
  return [cam.cx + p[0] * k, cam.cy - p[1] * k, k, z];
}
/* How squarely a surface faces the camera: 1 head-on, 0 edge-on, <0 behind. */
function facing(p, n, dist) {
  const vx = p[0], vy = p[1], vz = p[2] + dist;
  return -(n[0] * vx + n[1] * vy + n[2] * vz) / Math.hypot(vx, vy, vz);
}

/* Size the backing store to the element, crisp but never past a pixel budget —
 * three windows and a full-screen backdrop share one phone's worth of fill.
 * The element's size comes from a ResizeObserver, never from reading layout in
 * a frame: with a readout just written, that read would lay the whole page out
 * again, once per canvas, every frame. */
const SIZE = new WeakMap();
const sizes = new ResizeObserver((es) => {
  for (const e of es) SIZE.set(e.target, [e.contentRect.width, e.contentRect.height]);
});
function fit(c, maxDpr, budget = 7e5) {
  let s = SIZE.get(c);
  if (!s) { s = [c.clientWidth, c.clientHeight]; SIZE.set(c, s); sizes.observe(c); }
  const area = Math.max(1, s[0] * s[1]);
  const dpr = Math.min(window.devicePixelRatio || 1, maxDpr, Math.sqrt(budget / area));
  const w = Math.max(1, Math.round(s[0] * dpr));
  const h = Math.max(1, Math.round(s[1] * dpr));
  if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
  return dpr;
}

/* A node the way the sheets draw one: a soft halo, a ring, a dark centre. */
function node(ctx, x, y, col, r, alpha = 1, fillDark = true) {
  ctx.fillStyle = rgba(col, 0.16 * alpha);
  ctx.beginPath(); ctx.arc(x, y, r * 2.9, 0, TAU); ctx.fill();
  ctx.fillStyle = rgba(col, 0.28 * alpha);
  ctx.beginPath(); ctx.arc(x, y, r * 1.7, 0, TAU); ctx.fill();
  ctx.fillStyle = fillDark ? BG : rgba(col, alpha);
  ctx.strokeStyle = rgba(col, alpha);
  ctx.lineWidth = Math.max(1, r * 0.34);
  ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); ctx.fill(); ctx.stroke();
}
/* Text is the slowest thing a canvas draws, and almost none of it here ever
 * changes. So each string is set once, per colour, size and weight, and
 * stamped from then on. */
const TEXT = new Map();
function textSprite(text, col, px, weight) {
  const key = `${weight}|${px}|${col}|${text}`;
  let sp = TEXT.get(key);
  if (sp) return sp;
  if (TEXT.size > 800) TEXT.clear();             // a few resizes' worth; never grows without end
  const c = document.createElement('canvas'), g = c.getContext('2d');
  const font = `${weight} ${px}px ${MONO}`, pad = Math.ceil(px * 0.25);
  g.font = font;
  const w = g.measureText(text).width;
  c.width = Math.max(1, Math.ceil(w) + 2 * pad);
  c.height = Math.max(1, Math.ceil(px * 1.5));
  g.font = font;                                   // resizing the canvas reset it
  g.textBaseline = 'middle';
  g.fillStyle = rgba(col, 1);
  g.fillText(text, pad, c.height / 2);
  sp = { c, w, pad };
  TEXT.set(key, sp);
  return sp;
}
// The mono face is a web font and can land after the first frames were drawn
// in a fallback; set everything again when it does.
if (document.fonts && document.fonts.addEventListener) {
  document.fonts.addEventListener('loadingdone', () => TEXT.clear());
}
function label(ctx, text, x, y, col, px, alpha = 1, align = 'left', weight = 600) {
  const sp = textSprite(text, col, px, weight);
  const left = align === 'center' ? x - sp.w / 2 : align === 'right' ? x - sp.w : x;
  const ga = ctx.globalAlpha;
  ctx.globalAlpha = ga * alpha;
  ctx.drawImage(sp.c, Math.round(left - sp.pad), Math.round(y - sp.c.height / 2));
  ctx.globalAlpha = ga;
}
const fmt = (v, d = 2) => (v < 0 ? '−' : '') + Math.abs(v).toFixed(d);

/* ========================================================= the backdrop */

/* A deep scene in layers, back to front — every layer is the same maths the
 * page is about, and none of it is a picture:
 *
 *   - far away, E(ℂ): the curve over the complex numbers, a torus, as a vast
 *     faint wireframe turning slowly in the dark;
 *   - a blueprint floor, receding to a horizon;
 *   - the group E(𝔽₂₁₁) as a ring in scalar order — the i-th point round the
 *     ring is (i+1)·G, placed by its own coordinates, so neighbours k·G and
 *     (k+1)·G land nowhere near each other and the line joining them in order
 *     zig-zags with no pattern at all. That scatter is the discrete-log
 *     problem, and it is why the oracle can hand back k·B without anyone
 *     recovering k;
 *   - comets running that walk, one group operation per step, faster while a
 *     password is being made;
 *   - the formulas, drifting in depth, and a pointer that lights the points
 *     near it and reaches out to them;
 *   - out-of-focus light in the foreground, for depth.
 *
 * Reduced motion: nothing turns, drifts, travels or follows the scroll. The
 * scene holds still and lives by light alone — points twinkle, the torus
 * breathes — which is the one register of motion that setting leaves room for.
 * The pointer can still light points up; that motion is the user's own. */
function initField() {
  const c = $('field');
  if (!c || !c.getContext) return;
  const ctx = c.getContext('2d');
  const far = $('fieldFar');
  const fctx = far && far.getContext ? far.getContext('2d') : null;

  const G = [17, 15];
  const group = walkFrom(G, FP);                   // all 196 affine points
  const ring = group.map((P, i) => {
    const th = TAU * i / group.length;
    const rho = 1 + 0.46 * (P[0] / (FP - 1) - 0.5);
    const h = 0.62 * (P[1] / (FP - 1) - 0.5);
    return [rho * Math.cos(th), h, rho * Math.sin(th)];
  });
  const LABELS = [
    'y² ≡ x³ − 3x + 5  (mod 211)', 'B = r·P', 'B′ = k·B', 'S = r⁻¹·B′ = k·P',
    'Y = k·G', 'π : log_G(Y) = log_B(B′)', '#E(𝔽₂₁₁) = 197', 'Λ = ℤω₁ + ℤω₂',
    'HKDF-SHA256', 'ristretto255', 'E(ℂ) ≅ ℂ/Λ', 'k·P = P + P + ⋯ + P',
  ].map((text, i) => {
    const th = TAU * (i + 0.5) / 12;
    const rho = 1.5 + 0.22 * Math.sin(i * 2.3);
    return { text, p: [rho * Math.cos(th), 0.5 * Math.sin(i * 1.7), rho * Math.sin(th)] };
  });

  // E(ℂ): a torus, as a grid of meridians and parallels
  const TU = 40, TV = 16, TR = 1, Tr = 0.4;
  const TORUS = [];
  for (let a = 0; a < TU; a++) {
    const row = [];
    for (let b = 0; b < TV; b++) {
      const th = TAU * a / TU, ph = TAU * b / TV, q = TR + Tr * Math.cos(ph);
      row.push([q * Math.cos(th), Tr * Math.sin(ph), q * Math.sin(th)]);
    }
    TORUS.push(row);
  }

  // soft light, rendered once per colour and stamped — never a gradient per point
  const SPR = new Map();
  function sprite(col) {
    let sp = SPR.get(col);
    if (sp) return sp;
    sp = document.createElement('canvas');
    sp.width = sp.height = 64;
    const g = sp.getContext('2d'), gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    gr.addColorStop(0, rgba(col, 1)); gr.addColorStop(0.4, rgba(col, 0.32)); gr.addColorStop(1, rgba(col, 0));
    g.fillStyle = gr; g.fillRect(0, 0, 64, 64);
    SPR.set(col, sp);
    return sp;
  }
  function glowAt(x, y, r, col, a) {
    if (a <= 0.004 || r <= 0) return;
    ctx.globalAlpha = Math.min(1, a);
    ctx.drawImage(sprite(col), x - r, y - r, 2 * r, 2 * r);
  }

  // out-of-focus light in front of everything
  const seeded = (k) => fract(Math.sin(k * 127.1 + 311.7) * 43758.5453);
  const BOKEH = Array.from({ length: 11 }, (_, i) => ({
    x: seeded(i), y: seeded(i + 40), r: 0.06 + 0.13 * seeded(i + 80),
    col: [C.cyan, C.violet, C.hot][i % 3], depth: 0.3 + 0.7 * seeded(i + 120),
    ph: TAU * seeded(i + 160), a: 0.06 + 0.07 * seeded(i + 200),
  }));
  // comets running the scalar walk
  const COMETS = [
    { at: 0, v: 7, col: C.hot, len: 18 },
    { at: 70, v: 5.2, col: C.violet, len: 14 },
    { at: 140, v: 4.1, col: C.amber, len: 11 },
  ];

  let yaw = 0.6, tyaw = 0.2, mx = 0, my = 0, tmx = 0, tmy = 0, surge = 0;
  let raf = 0, lastT = 0, lastDraw = 0, lastMove = 0, lastFar = -1e9, farLift = -1;
  let ptrX = 0, ptrY = 0, ptrOn = false;

  function floor(ctx, W, H, lw, t, lift) {
    const hz = H * (0.64 + lift * 0.08), vp = W / 2;
    // light pooling along the horizon, where the floor meets the dark
    const g = ctx.createLinearGradient(0, hz - H * 0.06, 0, hz + H * 0.1);
    g.addColorStop(0, rgba(C.cyan, 0)); g.addColorStop(0.45, rgba(C.cyan, 0.045)); g.addColorStop(1, rgba(C.cyan, 0));
    ctx.globalAlpha = 1;
    ctx.fillStyle = g; ctx.fillRect(0, hz - H * 0.06, W, H * 0.16);
    ctx.lineWidth = lw;
    ctx.strokeStyle = rgba(C.cyan, 0.05);
    ctx.beginPath();
    for (let i = -16; i <= 16; i++) { ctx.moveTo(vp + i * W * 0.01, hz); ctx.lineTo(vp + i * W * 0.13, H); }
    ctx.stroke();
    const off = reduceMotion ? 0.4 : fract(t * 0.05);
    for (let k = 0; k < 11; k++) {
      const z = (k + off) / 11, y = hz + (H - hz) * z * z;
      ctx.strokeStyle = rgba(C.cyan, 0.09 * z);
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
    }
  }

  function farTorus(ctx, W, H, lw, t, lift) {
    const breathe = reduceMotion ? 0.8 + 0.2 * Math.sin(t * 0.5) : 1;
    const cam = { dist: 3.1, f: Math.max(W, H) * 0.62, cx: W * 0.5, cy: H * (0.42 - lift * 0.12) };
    const P = TORUS.map((row) => row.map((v) => proj(view(v, tyaw, 1.02 + my * 0.03), cam)));
    const near = (z) => clamp((cam.dist + 1.4 - z) / 2.8, 0, 1);
    const paths = [[], [], []];
    const seg = (a, b) => {
      const n = near((a[3] + b[3]) / 2);
      paths[n > 0.62 ? 2 : n > 0.34 ? 1 : 0].push(a, b);
    };
    for (let a = 0; a < TU; a++) {
      for (let b = 0; b < TV; b++) {
        seg(P[a][b], P[a][(b + 1) % TV]);               // round the tube
        seg(P[a][b], P[(a + 1) % TU][b]);               // round the ring
      }
    }
    ctx.lineWidth = lw;
    ctx.globalAlpha = 1;
    [0.04, 0.07, 0.115].forEach((al, i) => {
      ctx.strokeStyle = rgba(i === 2 ? C.cyan : C.blue, al * breathe * (1 + surge * 0.8));
      ctx.beginPath();
      const s = paths[i];
      for (let j = 0; j < s.length; j += 2) { ctx.moveTo(s[j][0], s[j][1]); ctx.lineTo(s[j + 1][0], s[j + 1][1]); }
      ctx.stroke();
    });
  }

  function draw(now, dt) {
    const dpr = load.lite ? fit(c, 1, 6e5) : fit(c, 1.5, 1.3e6);
    const W = c.width, H = c.height;
    const t = now / 1000;
    ctx.globalAlpha = 1;
    ctx.clearRect(0, 0, W, H);

    const want = document.body.classList.contains('handshaking') ? 1 : 0;
    surge += (want - surge) * Math.min(1, dt * 3);
    if (!reduceMotion) {                  // under reduced motion nothing turns or travels
      yaw += dt * (0.035 + surge * 0.3);
      tyaw += dt * (0.016 + surge * 0.08);
      mx += (tmx - mx) * Math.min(1, dt * 2.5);
      my += (tmy - my) * Math.min(1, dt * 2.5);
      for (const k of COMETS) k.at += dt * k.v * (1 + surge * 5);
    }
    const scroll = reduceMotion ? 0 : scrollAt;
    const lift = reduceMotion ? 0 : clamp(scroll / Math.max(1, docH - viewH), 0, 1);

    // The far layers barely move, so they live on a canvas of their own behind
    // this one: low resolution (far away is soft anyway), redrawn a few times a
    // second or at once when the scroll moves the horizon, and composited by the
    // browser for nothing in between.
    if (fctx) {
      if (now - lastFar > (reduceMotion ? 160 : load.lite ? 132 : 66) || Math.abs(lift - farLift) > 1e-4) {
        const fd = load.lite ? fit(far, 0.5, 3e5) : fit(far, 0.75, 6e5);
        fctx.clearRect(0, 0, far.width, far.height);
        floor(fctx, far.width, far.height, Math.max(1, fd), t, lift);
        farTorus(fctx, far.width, far.height, Math.max(1, fd), t, lift);
        lastFar = now; farLift = lift;
      }
    } else {
      floor(ctx, W, H, dpr, t, lift);
      farTorus(ctx, W, H, dpr, t, lift);
    }

    const y0 = yaw + scroll * 0.0006 + mx * 0.22;
    const p0 = 0.3 + my * 0.07 + (reduceMotion ? 0 : Math.min(0.12, scroll * 0.00008));
    const dist = 3.4;
    const cam = { dist, f: Math.max(W, H * 0.62) * 1.26, cx: W * 0.5, cy: H * 0.52 };
    const P = ring.map((v) => proj(view(v, y0, p0), cam));
    const near = (z) => clamp((dist + 1.3 - z) / 2.6, 0, 1);
    const N = P.length;

    // the walk, in scalar order — the zig-zag nothing can shortcut
    const bucket = [[], [], []];
    for (let i = 0; i < N; i++) {
      const a = P[i], b = P[(i + 1) % N];
      const n = near((a[3] + b[3]) / 2);
      bucket[n > 0.66 ? 2 : n > 0.33 ? 1 : 0].push(a, b);
    }
    ctx.lineWidth = dpr;
    [0.035, 0.07, 0.12].forEach((al, i) => {
      ctx.beginPath();
      for (let j = 0; j < bucket[i].length; j += 2) {
        ctx.moveTo(bucket[i][j][0], bucket[i][j][1]);
        ctx.lineTo(bucket[i][j + 1][0], bucket[i][j + 1][1]);
      }
      ctx.strokeStyle = rgba(C.violet, al * (1 + surge));
      ctx.stroke();
    });

    // comets: each step of the walk they cross lights up behind them
    if (!reduceMotion) {
      ctx.lineCap = 'round';
      const TAIL = 5;                                  // the tail fades in steps, one stroke per step
      for (const k of COMETS) {
        const head = ((Math.floor(k.at) % N) + N) % N, f = fract(k.at);
        const lit = near(P[head][3]), steps = Array.from({ length: TAIL }, () => []);
        for (let s = k.len; s >= 0; s--) {
          const i = ((head - s) % N + N) % N, a = P[i], b = P[(i + 1) % N];
          const fade = 1 - (s - f) / (k.len + 1);
          if (fade <= 0) continue;
          const e = s === 0 ? f : 1;                   // the head's segment grows as it goes
          steps[Math.min(TAIL - 1, Math.floor(fade * TAIL))].push(a[0], a[1],
            a[0] + (b[0] - a[0]) * e, a[1] + (b[1] - a[1]) * e);
        }
        for (let q = 0; q < TAIL; q++) {
          const seg = steps[q];
          if (!seg.length) continue;
          const fade = (q + 0.5) / TAIL;
          ctx.strokeStyle = rgba(k.col, 0.5 * fade * fade * (0.45 + 0.55 * lit));
          ctx.lineWidth = dpr * (1 + 1.4 * fade);
          ctx.beginPath();
          for (let j = 0; j < seg.length; j += 4) { ctx.moveTo(seg[j], seg[j + 1]); ctx.lineTo(seg[j + 2], seg[j + 3]); }
          ctx.stroke();
        }
        const a = P[head], b = P[(head + 1) % N];
        const hx = a[0] + (b[0] - a[0]) * f, hy = a[1] + (b[1] - a[1]) * f;
        glowAt(hx, hy, 16 * dpr * (0.6 + near(a[3])), k.col, 0.55);
        ctx.globalAlpha = 1;
        ctx.fillStyle = rgba(C.hot, 0.9);
        ctx.beginPath(); ctx.arc(hx, hy, 1.6 * dpr, 0, TAU); ctx.fill();
      }
      ctx.lineCap = 'butt';
    }

    // the points: nearer ones bloom; everything batched by brightness
    const LV = 6, halo = Array.from({ length: LV }, () => []), core = Array.from({ length: LV }, () => []);
    const lensR = 150 * dpr, lens = [];
    for (let i = 0; i < N; i++) {
      const [x, y, , z] = P[i];
      let n = near(z);
      n = Math.min(1, n + 0.3 * Math.max(0, Math.sin(t * (reduceMotion ? 0.9 : 1.6) + i * 2.399)) ** 3);
      if (ptrOn) {
        const d = Math.hypot(x - ptrX, y - ptrY);
        if (d < lensR) { const w = 1 - d / lensR; n = Math.min(1, n + 0.7 * w); lens.push([x, y, w]); }
      }
      const q = Math.min(LV - 1, Math.floor(n * LV));
      if (n > 0.55) halo[q].push(x, y, (6 + 16 * n) * dpr);
      core[q].push(x, y, (0.9 + 1.6 * n) * dpr);
    }
    for (let q = 0; q < LV; q++) {
      const n = (q + 0.5) / LV;
      for (let j = 0; j < halo[q].length; j += 3) glowAt(halo[q][j], halo[q][j + 1], halo[q][j + 2], C.cyan, 0.16 + 0.22 * n);
    }
    ctx.globalAlpha = 1;
    for (let q = 0; q < LV; q++) {
      const n = (q + 0.5) / LV, pts = core[q];
      if (!pts.length) continue;
      ctx.beginPath();
      for (let j = 0; j < pts.length; j += 3) { ctx.moveTo(pts[j] + pts[j + 2], pts[j + 1]); ctx.arc(pts[j], pts[j + 1], pts[j + 2], 0, TAU); }
      ctx.fillStyle = rgba(n > 0.7 ? C.hot : C.cyan, 0.22 + 0.62 * n);
      ctx.fill();
    }
    // the pointer reaches for the points it is near
    if (lens.length) {
      lens.sort((a, b) => b[2] - a[2]);
      ctx.lineWidth = dpr;
      for (const [x, y, w] of lens.slice(0, 7)) {
        ctx.strokeStyle = rgba(C.hot, 0.28 * w * w);
        ctx.beginPath(); ctx.moveTo(ptrX, ptrY); ctx.lineTo(x, y); ctx.stroke();
      }
      glowAt(ptrX, ptrY, 26 * dpr, C.violet, 0.22);
      ctx.globalAlpha = 1;
    }

    // the formulas, drifting in depth
    for (const L of LABELS) {
      const [x, y, , z] = proj(view(L.p, y0 * 0.8, p0), cam);
      const n = near(z);
      // set once at the largest size it is shown, scaled down as it recedes
      const sp = textSprite(L.text, n > 0.5 ? C.ink1 : C.ink, 12.5 * dpr, 500).c, s = (8.5 + 4 * n) / 12.5;
      ctx.globalAlpha = Math.min(1, 0.06 + 0.16 * n + surge * 0.08);
      ctx.drawImage(sp, x - sp.width * s / 2, y - sp.height * s / 2, sp.width * s, sp.height * s);
    }
    ctx.globalAlpha = 1;

    // out-of-focus light, nearest of all: it moves most with the pointer and the scroll
    const m = Math.min(W, H);
    for (const b of BOKEH) {
      const drift = reduceMotion ? 0 : 1;
      const x = b.x * W + drift * (mx * 60 * b.depth * dpr + Math.sin(t * 0.07 + b.ph) * 40 * dpr);
      const y = fract(b.y - lift * 0.35 * b.depth) * H + drift * (my * 40 * b.depth * dpr + Math.cos(t * 0.05 + b.ph) * 30 * dpr);
      const a = b.a * (reduceMotion ? 0.75 + 0.25 * Math.sin(t * 0.4 + b.ph) : 1);
      glowAt(x, y, b.r * m, b.col, a);
    }
    ctx.globalAlpha = 1;
    lastDraw = now;
  }

  function loop(t) {
    raf = 0;
    if (document.hidden || covered()) return;     // resumes on the next kick
    const dt = clamp((t - lastT) / 1000 || 0, 0, 0.1);   // a frame can be stamped before the kick
    frameGap(t, t - lastT);
    lastT = t;
    // ~30fps at rest, full rate while the oracle works or the pointer moves;
    // a gentle ~12fps under reduced motion, where only light changes
    const busy = surge > 0.05 || document.body.classList.contains('handshaking') || t - lastMove < 1500;
    const rest = reduceMotion ? (t - lastMove < 1500 ? 33 : 80) : load.lite ? 64 : 32;
    if ((!reduceMotion && busy && !load.lite) || t - lastDraw > rest) draw(t, dt);
    raf = requestAnimationFrame(loop);
  }
  function kick() {
    if (raf || document.hidden || covered()) return;
    lastT = performance.now();
    raf = requestAnimationFrame(loop);
  }
  addEventListener('pointermove', (e) => {
    if (e.pointerType === 'touch') return;
    tmx = (e.clientX / innerWidth - 0.5) * 2;
    tmy = (e.clientY / innerHeight - 0.5) * 2;
    ptrX = e.clientX * (c.width / Math.max(1, innerWidth));        // the canvas is the viewport
    ptrY = e.clientY * (c.height / Math.max(1, innerHeight));
    ptrOn = true;
    lastMove = performance.now();
  }, { passive: true });
  document.addEventListener('pointerout', (e) => { if (!e.relatedTarget) ptrOn = false; });
  // how far down the page we are, kept from events — reading it in a frame
  // would lay the page out again first
  let scrollAt = window.scrollY, docH = 1, viewH = innerHeight;
  addEventListener('scroll', () => { scrollAt = window.scrollY; }, { passive: true });
  addEventListener('resize', () => { viewH = innerHeight; }, { passive: true });
  new ResizeObserver(([e]) => { docH = e.target.scrollHeight; }).observe(document.documentElement);
  document.addEventListener('visibilitychange', kick);
  // the pop-up closing (or the page otherwise changing state) restarts the loop
  new MutationObserver(kick).observe(document.body, { attributes: true, attributeFilter: ['class'] });
  kick();
}

/* ====================================================== sheet 01 — ℝ */

function groupLaw() {
  const st = { xP: -2.24, sP: 1, xQ: 1.46, sQ: 1, grab: null, lastUser: -1e9, hover: null };
  let m = null, path = null, pathKey = '';

  const yOf = (x, s) => s * Math.sqrt(Math.max(0, rf(x)));
  function compute() {
    const P = [st.xP, yOf(st.xP, st.sP)], Q = [st.xQ, yOf(st.xQ, st.sQ)];
    const sameX = Math.abs(P[0] - Q[0]) < 1e-9;
    if (sameX && (st.sP !== st.sQ || Math.abs(P[1]) < 1e-9)) return { P, Q, inf: true };
    const l = sameX ? (3 * P[0] * P[0] - 3) / (2 * P[1]) : (Q[1] - P[1]) / (Q[0] - P[0]);
    const xR = l * l - P[0] - Q[0];
    const yR = l * (P[0] - xR) - P[1];
    return { P, Q, l, R: [xR, yR], nR: [xR, -yR], tangent: sameX };
  }

  function setup(W, H, dpr) {
    const narrow = W / H < 1.15;
    // keep the drawing between the title and tabs above and the badge below
    const top = 64 * dpr, bottom = (narrow ? 50 : 40) * dpr;
    const x0 = narrow ? -3.0 : -5.4, x1 = narrow ? 3.2 : 4.0, ySpan = 3.1;
    const s = Math.min(W / (x1 - x0), (H - top - bottom) / (2 * ySpan));
    m = { s, ox: W / 2 - s * (x0 + x1) / 2, oy: top + (H - top - bottom) / 2, W, H, dpr };
    m.xl = -m.ox / s; m.xr = (W - m.ox) / s; m.yt = m.oy / s;
    const key = `${W}x${H}`;
    if (key !== pathKey) {
      pathKey = key;
      path = new Path2D();
      const xs = [];
      for (let i = 0; i <= 220; i++) xs.push(ROOT + (m.xr + 0.5 - ROOT) * (i / 220) ** 2);
      const up = xs.map((x) => [sx(x), sy(Math.sqrt(Math.max(0, rf(x))))]);
      path.moveTo(up[up.length - 1][0], up[up.length - 1][1]);
      for (let i = up.length - 2; i >= 0; i--) path.lineTo(up[i][0], up[i][1]);
      for (let i = 1; i < up.length; i++) path.lineTo(up[i][0], 2 * m.oy - up[i][1]);
    }
  }
  const sx = (x) => m.ox + x * m.s, sy = (y) => m.oy - y * m.s;
  const wx = (px) => (px - m.ox) / m.s, wy = (py) => (m.oy - py) / m.s;

  function draw(ctx, W, H, dpr, t) {
    setup(W, H, dpr);
    if (!st.grab && t - st.lastUser > 3.5) {
      st.xQ = 1.26 + 0.69 * Math.sin(t * 0.42 * PACE);   // Q.x in [0.57, 1.95]
      st.sQ = 1;
    }
    // the unit grid and axes, as on the sheet
    ctx.lineWidth = dpr;
    ctx.beginPath();
    for (let x = Math.ceil(m.xl); x <= m.xr; x++) { ctx.moveTo(sx(x), 0); ctx.lineTo(sx(x), H); }
    for (let y = Math.ceil(-m.yt); y <= m.yt; y++) { ctx.moveTo(0, sy(y)); ctx.lineTo(W, sy(y)); }
    ctx.strokeStyle = rgba(C.cyan, 0.05); ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(sx(0), 0); ctx.lineTo(sx(0), H); ctx.moveTo(0, sy(0)); ctx.lineTo(W, sy(0));
    ctx.strokeStyle = rgba(C.cyan, 0.16); ctx.stroke();
    for (let x = Math.ceil(m.xl); x <= m.xr; x++) {
      if (x) label(ctx, String(x).replace('-', '−'), sx(x), sy(0) + 10 * dpr, C.ink, 8.5 * dpr, 0.55, 'center', 400);
    }
    for (let y = Math.ceil(-m.yt + 0.3); y <= m.yt - 0.3; y++) {
      if (y) label(ctx, String(y).replace('-', '−'), sx(0) - 6 * dpr, sy(y), C.ink, 8.5 * dpr, 0.55, 'right', 400);
    }

    // the curve, with the bloom the sheet has
    ctx.lineJoin = ctx.lineCap = 'round';
    for (const [w, a, col] of [[16, 0.05, C.cyan], [8, 0.12, C.cyan], [4, 0.28, C.cyan], [2.1, 0.95, C.hot]]) {
      ctx.lineWidth = w * dpr; ctx.strokeStyle = rgba(col, a); ctx.stroke(path);
    }

    const g = compute();
    const [P, Q] = [g.P, g.Q];
    if (g.inf) {
      ctx.beginPath(); ctx.moveTo(sx(P[0]), 0); ctx.lineTo(sx(P[0]), H);
      ctx.strokeStyle = rgba(C.violet, 0.85); ctx.lineWidth = 1.5 * dpr; ctx.stroke();
      label(ctx, 'P + Q = 𝒪', sx(P[0]) + 10 * dpr, 22 * dpr, C.amber, 12 * dpr);
      label(ctx, 'the point at infinity', sx(P[0]) + 10 * dpr, 38 * dpr, C.ink, 9.5 * dpr, 0.8, 'left', 400);
    } else {
      // the chord (or tangent), run edge to edge
      const yAt = (x) => P[1] + g.l * (x - P[0]);
      ctx.beginPath(); ctx.moveTo(sx(m.xl), sy(yAt(m.xl))); ctx.lineTo(sx(m.xr), sy(yAt(m.xr)));
      ctx.strokeStyle = rgba(C.violet, 0.18); ctx.lineWidth = 5 * dpr; ctx.stroke();
      ctx.strokeStyle = rgba(C.violet, 0.9); ctx.lineWidth = 1.4 * dpr; ctx.stroke();
      // reflect: −R down (or up) to R
      const [rx, ry] = g.R, [nx, ny] = g.nR;
      ctx.setLineDash([5 * dpr, 5 * dpr]);
      ctx.beginPath(); ctx.moveTo(sx(nx), sy(ny)); ctx.lineTo(sx(rx), sy(ry));
      ctx.strokeStyle = rgba(C.amber, 0.8); ctx.lineWidth = 1.2 * dpr; ctx.stroke();
      ctx.setLineDash([]);
      node(ctx, sx(nx), sy(ny), C.violet, 5 * dpr);
      label(ctx, '−R', sx(nx) + 11 * dpr, sy(ny) - 12 * dpr, C.violet, 12 * dpr);
      const off = sy(ry) < 0 || sy(ry) > H || sx(rx) > W;
      if (off) {
        const ex = clamp(sx(rx), 20 * dpr, W - 90 * dpr), ey = clamp(sy(ry), 22 * dpr, H - 22 * dpr);
        label(ctx, ry < 0 ? 'R ↓ off the sheet' : 'R ↑ off the sheet', ex + 8 * dpr, ey, C.amber, 10.5 * dpr);
      } else {
        node(ctx, sx(rx), sy(ry), C.amber, 5 * dpr);
        label(ctx, g.tangent ? 'R = 2P' : 'R = P + Q', sx(rx) + 11 * dpr, sy(ry) + (ry < 0 ? 16 : -16) * dpr, C.amber, 12 * dpr);
      }
    }
    const hot = (k) => st.grab === k || st.hover === k;
    node(ctx, sx(P[0]), sy(P[1]), C.cyan, (hot('P') ? 6.5 : 5) * dpr);
    label(ctx, 'P', sx(P[0]) - 16 * dpr, sy(P[1]) - 13 * dpr, C.hot, 12.5 * dpr);
    if (!(g.tangent && !g.inf)) {
      node(ctx, sx(Q[0]), sy(Q[1]), C.cyan, (hot('Q') ? 6.5 : 5) * dpr);
      label(ctx, 'Q', sx(Q[0]) + 10 * dpr, sy(Q[1]) - 13 * dpr, C.hot, 12.5 * dpr);
    }
  }

  function readout() {
    const g = compute();
    const pt = (v) => `(${fmt(v[0])}, ${fmt(v[1])})`;
    return `P ${pt(g.P)}   Q ${pt(g.Q)}   ` + (g.inf ? 'R = 𝒪' : `R ${pt(g.R)}`);
  }
  function nearest(x, y) {
    const g = compute();
    const d = (v) => Math.hypot(sx(v[0]) - x, sy(v[1]) - y);
    return d(g.P) <= d(g.Q) ? ['P', d(g.P)] : ['Q', d(g.Q)];
  }
  function moveTo(which, px, py) {
    let x = clamp(wx(px), ROOT + 1e-4, m.xr - 0.05);
    const s = wy(py) >= 0 ? 1 : -1;
    // snap onto the other point (doubling) or its mirror (𝒪)
    const other = which === 'P' ? st.xQ : st.xP;
    if (Math.abs(sx(x) - sx(other)) < 7 * m.dpr) x = other;
    if (which === 'P') { st.xP = x; st.sP = s; } else { st.xQ = x; st.sQ = s; }
  }
  return {
    // pan-y, not none: stacked on a phone, a window that swallowed every touch
    // would trap the page's scroll. P and Q only move sideways anyway.
    id: 'group', touchAction: 'pan-y',
    title: 'E : y² = x³ − 3x + 5', sub: 'over ℝ',
    noteHead: 'group law',
    noteBody: 'the chord through P and Q meets E again at −R; reflect it to get P + Q = R. k·P is this, repeated — the oracle’s whole job.',
    badge: 'VAULTLESS · E/ℝ · SHEET 01', hint: 'drag P or Q along the curve',
    draw, readout,
    busy: () => true,
    down(x, y) {
      if (!m) return;                    // nothing drawn yet, so nothing to grab
      const [k] = nearest(x, y); st.grab = k; st.lastUser = performance.now() / 1000; moveTo(k, x, y);
    },
    move(x, y) {
      if (!m) return '';
      if (st.grab) { moveTo(st.grab, x, y); st.lastUser = performance.now() / 1000; return 'grabbing'; }
      const [k, d] = nearest(x, y);
      st.hover = d < 22 * m.dpr ? k : null;
      return st.hover ? 'grab' : '';
    },
    up() { st.grab = null; },
    leave() { st.hover = null; },
    key(e) {
      const which = e.shiftKey ? 'P' : 'Q';
      const xk = which === 'P' ? 'xP' : 'xQ', sk = which === 'P' ? 'sP' : 'sQ';
      if (e.key === 'ArrowLeft') st[xk] = Math.max(ROOT + 1e-4, st[xk] - 0.05);
      else if (e.key === 'ArrowRight') st[xk] = Math.min(m ? m.xr - 0.05 : 4, st[xk] + 0.05);
      else if (e.key === 'ArrowUp') st[sk] = 1;
      else if (e.key === 'ArrowDown') st[sk] = -1;
      else return false;
      st.lastUser = performance.now() / 1000;
      return true;
    },
  };
}

/* ================================================== sheet 02 — 𝔽₂₁₁ */

function finiteField() {
  const STEPS = 9;
  const st = {
    P: [17, 15], walk: walkFrom([17, 15], STEPS), grow: 0,
    hold: 0, fade: 1, yaw: -0.42, pitch: 0.92, vyaw: 0, drag: null, lastUser: -1e9, hover: -1,
  };
  let cam = null, shown = [];
  const to3 = (x, y, h = 0) => [(x / (FP - 1)) * 2 - 1, h, (y / (FP - 1)) * 2 - 1];

  function restart(P) { st.P = P; st.walk = walkFrom(P, STEPS); st.grow = 0; st.hold = 0; st.fade = 1; }

  function draw(ctx, W, H, dpr, t, dt) {
    {
      if (!st.drag) {
        st.yaw += st.vyaw * dt;
        st.vyaw *= Math.pow(0.04, dt);
        if (t - st.lastUser > 2.5) st.yaw += dt * 0.1 * PACE;
      }
      if (st.grow < STEPS - 1) st.grow = Math.min(STEPS - 1, st.grow + dt * 1.5 * (reduceMotion ? 0.6 : 1));
      else if ((st.hold += dt) > 3.2) {
        st.fade -= dt * 1.6;
        if (st.fade <= 0) restart(FIELD[(Math.random() * FIELD.length) | 0]);
      }
    }
    const wide = W / H > 1.15;
    cam = { dist: 3.5, f: Math.min(W * (wide ? 0.6 : 0.78), H * 0.98) * 1.0, cx: W * (wide ? 0.54 : 0.5), cy: H * 0.55 };
    const pr = (v) => proj(view(v, st.yaw, st.pitch), cam);

    // the frame and the residue grid
    ctx.lineWidth = dpr;
    ctx.beginPath();
    for (let g = 0; g <= 200; g += 25) {
      const a = pr(to3(g, 0)), b = pr(to3(g, 210)), c = pr(to3(0, g)), d = pr(to3(210, g));
      ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.moveTo(c[0], c[1]); ctx.lineTo(d[0], d[1]);
    }
    ctx.strokeStyle = rgba(C.cyan, 0.05); ctx.stroke();
    const corners = [[0, 0], [210, 0], [210, 210], [0, 210]].map(([x, y]) => pr(to3(x, y)));
    ctx.beginPath(); corners.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1]))); ctx.closePath();
    ctx.strokeStyle = rgba(C.cyan, 0.34); ctx.stroke();
    for (let g = 0; g <= 200; g += 50) {
      const a = pr(to3(g, -12)), b = pr(to3(-14, g));
      label(ctx, String(g), a[0], a[1], C.ink, 8.5 * dpr, 0.6, 'center', 400);
      label(ctx, String(g), b[0], b[1], C.ink, 8.5 * dpr, 0.6, 'center', 400);
    }
    // the mirror y ↦ −y: over 𝔽₂₁₁, −y is 211 − y, so the fold is at 105.5
    const m0 = pr(to3(0, 105.5)), m1 = pr(to3(210, 105.5));
    ctx.setLineDash([5 * dpr, 5 * dpr]);
    ctx.beginPath(); ctx.moveTo(m0[0], m0[1]); ctx.lineTo(m1[0], m1[1]);
    ctx.strokeStyle = rgba(C.amber, 0.55); ctx.stroke(); ctx.setLineDash([]);
    label(ctx, 'y ↦ −y', m1[0] + 8 * dpr, m1[1], C.amber, 9.5 * dpr, 0.8, 'left', 500);

    // every point of E(𝔽₂₁₁)
    shown = FIELD.map(([x, y]) => pr(to3(x, y)));
    const rOf = (i) => Math.max(1.1, shown[i][2] / cam.f * 5.6) * dpr * (i === st.hover ? 2 : 1);
    ctx.beginPath();                                 // all the halos, then all the cores: two fills, not 392
    for (let i = 0; i < shown.length; i++) {
      const [x, y] = shown[i], R = rOf(i) * 3.2;
      ctx.moveTo(x + R, y); ctx.arc(x, y, R, 0, TAU);
    }
    ctx.fillStyle = rgba(C.cyan, 0.13); ctx.fill();
    ctx.beginPath();
    for (let i = 0; i < shown.length; i++) {
      if (i === st.hover) continue;
      const [x, y] = shown[i], r = rOf(i);
      ctx.moveTo(x + r, y); ctx.arc(x, y, r, 0, TAU);
    }
    ctx.fillStyle = rgba(C.cyan, 0.9); ctx.fill();
    if (st.hover >= 0 && shown[st.hover]) {
      const [x, y] = shown[st.hover];
      ctx.fillStyle = rgba(C.hot, 0.9); ctx.beginPath(); ctx.arc(x, y, rOf(st.hover), 0, TAU); ctx.fill();
    }

    // the walk P, 2P, …, 9P — each step an arc lifted off the lattice
    const f = st.fade, n = Math.floor(st.grow), frac = st.grow - n;
    const arc = (A, B, upto) => {
      const a = to3(A[0], A[1]), b = to3(B[0], B[1]);
      const h = 0.08 + 0.2 * Math.hypot(a[0] - b[0], a[2] - b[2]);
      const pts = [];
      for (let s = 0; s <= upto + 1e-9; s += 1 / 36) {
        const q = Math.min(s, upto);
        pts.push(pr([a[0] + (b[0] - a[0]) * q, h * Math.sin(Math.PI * q), a[2] + (b[2] - a[2]) * q]));
      }
      return pts;
    };
    for (let i = 0; i < Math.min(n + 1, STEPS - 1); i++) {
      const pts = arc(st.walk[i], st.walk[i + 1], i < n ? 1 : frac);
      if (pts.length < 2) continue;
      ctx.beginPath(); pts.forEach((p, j) => (j ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])));
      ctx.strokeStyle = rgba(C.violet, 0.16 * f); ctx.lineWidth = 5 * dpr; ctx.stroke();
      ctx.strokeStyle = rgba(C.violet, 0.8 * f); ctx.lineWidth = 1.3 * dpr; ctx.stroke();
    }
    for (let i = 0; i <= Math.min(n, STEPS - 1); i++) {
      const [x, y] = pr(to3(st.walk[i][0], st.walk[i][1]));
      const end = i === 0 || i === STEPS - 1;
      node(ctx, x, y, end ? C.amber : C.violet, (end ? 5 : 4) * dpr, f);
      const name = i === 0 ? 'P' : i === STEPS - 1 ? '9·P' : `${i + 1}P`;
      label(ctx, name, x + 9 * dpr, y - 11 * dpr, end ? C.amber : C.violet, (end ? 12 : 10) * dpr, f);
    }
  }

  function readout() {
    if (st.hover >= 0) {
      const [x, y] = FIELD[st.hover];
      return `(${x}, ${y})   ${y}² ≡ ${(y * y) % FP} ≡ ${x}³ − 3·${x} + 5  (mod 211)`;
    }
    const last = st.walk[st.walk.length - 1];
    return `P = (${st.P[0]}, ${st.P[1]})   9·P = (${last[0]}, ${last[1]})   ${FIELD.length} points + 𝒪 = ${FIELD.length + 1}, prime`;
  }
  function pick(x, y, within) {
    let best = -1, bd = within;
    shown.forEach((p, i) => { const d = Math.hypot(p[0] - x, p[1] - y); if (d < bd) { bd = d; best = i; } });
    return best;
  }
  return {
    id: 'field', touchAction: 'pan-y',
    title: 'E(𝔽₂₁₁)', sub: 'y² ≡ x³ − 3x + 5  (mod 211)',
    noteHead: 'finite field',
    noteBody: `#E(𝔽₂₁₁) = ${FIELD.length + 1} with the point at infinity — prime, so every point walks the whole group. No curve to see: only y ↦ −y and the walk k·P.`,
    badge: 'VAULTLESS · E/𝔽₂₁₁ · SHEET 02', hint: 'drag to turn · click any point to walk from it',
    draw, readout, data: { points: FIELD.length },
    busy: () => true,
    down(x, y) { st.drag = { x, y, yaw: st.yaw, pitch: st.pitch, moved: 0, t: performance.now() }; st.lastUser = performance.now() / 1000; },
    move(x, y, dpr) {
      if (st.drag) {
        const dx = (x - st.drag.x) / dpr, dy = (y - st.drag.y) / dpr;
        st.drag.moved = Math.max(st.drag.moved, Math.hypot(dx, dy));
        const prev = st.yaw;
        st.yaw = st.drag.yaw + dx * 0.008;
        st.pitch = clamp(st.drag.pitch + dy * 0.006, 0.3, 1.4);
        st.vyaw = (st.yaw - prev) * 60;
        st.lastUser = performance.now() / 1000;
        return 'grabbing';
      }
      st.hover = pick(x, y, 14 * dpr);
      return st.hover >= 0 ? 'pointer' : 'grab';
    },
    up(x, y, dpr) {
      const d = st.drag; st.drag = null;
      if (d && d.moved < 6) {
        const i = pick(x, y, 18 * dpr);
        if (i >= 0) { restart(FIELD[i]); st.vyaw = 0; }
      }
    },
    leave() { st.hover = -1; },
    key(e) {
      if (e.key === 'ArrowLeft') st.yaw -= 0.08;
      else if (e.key === 'ArrowRight') st.yaw += 0.08;
      else if (e.key === 'ArrowUp') st.pitch = clamp(st.pitch + 0.06, 0.3, 1.4);
      else if (e.key === 'ArrowDown') st.pitch = clamp(st.pitch - 0.06, 0.3, 1.4);
      else if (e.key === 'Enter' || e.key === ' ') restart(FIELD[(Math.random() * FIELD.length) | 0]);
      else return false;
      st.lastUser = performance.now() / 1000;
      return true;
    },
  };
}

/* ==================================================== sheet 05 — ℂ */

/* Uniformisation: E(ℂ) ≅ ℂ/Λ. A point of the curve is a point z of the plane
 * taken mod the lattice Λ = ℤω₁ + ℤω₂, and adding points on the curve is just
 * adding in ℂ. So k·P is k·z mod Λ — a straight line in the lattice cell that
 * wraps at its edges, and, with opposite edges glued, a line winding round the
 * torus. Both halves of this sheet draw that one line. */
function torus() {
  const R = 1, r = 0.42, STEPS = 9;
  const Z = [0.381966, 0.145898];      // z = αω₁ + βω₂, in lattice coordinates
  const st = {
    yaw: -0.5, pitch: 0.6, vyaw: 0, drag: null, lastUser: -1e9,
    tp: 0, hold: 0, fade: 1, hover: -1,
  };
  let cam = null, lat = null, nodesT = [], nodesL = [];
  const pos = (u, v) => { const th = TAU * u, ph = TAU * v, q = R + r * Math.cos(ph); return [q * Math.cos(th), r * Math.sin(ph), q * Math.sin(th)]; };
  const nrm = (u, v) => { const th = TAU * u, ph = TAU * v; return [Math.cos(ph) * Math.cos(th), Math.sin(ph), Math.cos(ph) * Math.sin(th)]; };
  const at = (t) => [fract(t * Z[0]), fract(t * Z[1])];

  function draw(ctx, W, H, dpr, t, dt) {
    {
      if (!st.drag) {
        st.yaw += st.vyaw * dt;
        st.vyaw *= Math.pow(0.04, dt);
        if (t - st.lastUser > 2.5) st.yaw += dt * 0.16 * PACE;
      }
      if (st.tp < STEPS) st.tp = Math.min(STEPS, st.tp + dt * 1.25 * (reduceMotion ? 0.6 : 1));
      else if ((st.hold += dt) > 2.8) {
        st.fade -= dt * 1.5;
        if (st.fade <= 0) { st.tp = 0; st.hold = 0; st.fade = 1; }
      }
    }
    const wide = W / dpr >= 470 && W / H > 1.05;
    const span = wide ? W * 0.5 : Math.min(W * 0.84, H * 1.25);
    cam = { dist: 4.4, cx: wide ? W * 0.69 : W * 0.5, cy: H * (wide ? 0.52 : 0.55) };
    cam.f = span * cam.dist / (2 * (R + r)) * 0.92;
    const V = (v) => view(v, st.yaw, st.pitch);

    // the wireframe, bucketed by how squarely each piece faces us
    const small = W / dpr < 420;
    const MER = small ? 34 : 44, PAR = small ? 14 : 18;
    const bk = [[], [], [], []];
    const line = (fn, n) => {
      let prev = null;
      for (let i = 0; i <= n; i++) {
        const [u, v] = fn(i / n);
        const p = V(pos(u, v));
        const s = proj(p, cam);
        const fc = facing(p, V(nrm(u, v)), cam.dist);
        if (prev) bk[fc > 0.4 ? 3 : fc > 0.05 ? 2 : fc > -0.35 ? 1 : 0].push(prev[0], prev[1], s[0], s[1]);
        prev = s;
      }
    };
    for (let i = 0; i < MER; i++) line((s) => [i / MER, s], 26);
    for (let j = 0; j < PAR; j++) line((s) => [s, j / PAR], 60);
    [[C.blue, 0.07], [C.blue, 0.14], [C.cyan, 0.34], [C.cyan, 0.62]].forEach(([col, a], b) => {
      ctx.beginPath();
      const L = bk[b];
      for (let i = 0; i < L.length; i += 4) { ctx.moveTo(L[i], L[i + 1]); ctx.lineTo(L[i + 2], L[i + 3]); }
      ctx.strokeStyle = rgba(col, a); ctx.lineWidth = dpr; ctx.stroke();
    });

    // the two generating loops: the cell's edges, glued, become these
    // Segments are gathered by side and stroked once per side: one stroke call
    // per segment was over a thousand calls a frame.
    const strokeSegs = (segs, col, a, w) => {
      if (!segs.length) return;
      ctx.beginPath();
      for (let i = 0; i < segs.length; i += 4) { ctx.moveTo(segs[i], segs[i + 1]); ctx.lineTo(segs[i + 2], segs[i + 3]); }
      ctx.strokeStyle = rgba(col, a); ctx.lineWidth = w; ctx.stroke();
    };
    const loopFront = [], loopBack = [];
    const loop = (fn, name) => {
      let prev = null, best = null;
      for (let i = 0; i <= 90; i++) {
        const [u, v] = fn(i / 90);
        const p = V(pos(u, v)), s = proj(p, cam), fc = facing(p, V(nrm(u, v)), cam.dist);
        if (prev) (fc > 0 ? loopFront : loopBack).push(prev[0], prev[1], s[0], s[1]);
        if (!best || fc > best[2]) best = [s[0], s[1], fc];
        prev = s;
      }
      loopLabels.push([name, best[0] + 8 * dpr, best[1] - 10 * dpr]);
    };
    const loopLabels = [];
    loop((s) => [s, 0], 'ω₁');
    loop((s) => [0, s], 'ω₂');
    strokeSegs(loopBack, C.amber, 0.2, 1.6 * dpr);
    strokeSegs(loopFront, C.amber, 0.85, 1.6 * dpr);

    // k·z mod Λ, wound round the torus
    const f = st.fade;
    const samples = Math.ceil(st.tp * 70);
    let prev = null;
    const windFront = [], windBack = [];
    for (let i = 0; i <= samples; i++) {
      const tt = (i / Math.max(1, samples)) * st.tp;
      const [u, v] = at(tt);
      const p = V(pos(u, v)), s = proj(p, cam), fc = facing(p, V(nrm(u, v)), cam.dist);
      if (prev) (fc > 0 ? windFront : windBack).push(prev[0], prev[1], s[0], s[1]);
      prev = s;
    }
    strokeSegs(windBack, C.violet, 0.22 * f, 1.4 * dpr);
    strokeSegs(windFront, C.violet, 0.2 * f, 5 * dpr);
    strokeSegs(windFront, C.violet, 0.9 * f, 1.4 * dpr);
    nodesT = [];
    for (let k = 1; k <= Math.floor(st.tp); k++) {
      const [u, v] = at(k);
      const p = V(pos(u, v)), s = proj(p, cam), fc = facing(p, V(nrm(u, v)), cam.dist);
      const end = k === 1 || k === STEPS;
      const a = (fc > 0 ? 1 : 0.3) * f;
      node(ctx, s[0], s[1], end ? C.amber : C.violet, (end ? 5 : 4) * dpr * (k === st.hover ? 1.4 : 1), a);
      if (fc > 0 || k === st.hover) label(ctx, k === 1 ? 'P' : k === STEPS ? '9·P' : `${k}P`, s[0] + 9 * dpr, s[1] - 11 * dpr, end ? C.amber : C.violet, (end ? 12 : 10) * dpr, a);
      nodesT.push([k, s[0], s[1]]);
    }
    for (const [name, x, y] of loopLabels) label(ctx, name, x, y, C.amber, 12 * dpr, 0.95);

    // the lattice and its cell — the left half of sheet 05
    nodesL = [];
    lat = null;
    if (wide) {
      const L = Math.min(W * 0.1, H * 0.15);
      const w1 = [L, 0], w2 = [0.38 * L, -0.92 * L];
      const cx = W * 0.2, cy = H * 0.37;
      const O = [cx - (w1[0] + w2[0]) / 2, cy - (w1[1] + w2[1]) / 2];
      lat = { O, w1, w2 };
      const X = (a, b) => [O[0] + a * w1[0] + b * w2[0], O[1] + a * w1[1] + b * w2[1]];
      for (let i = -3; i <= 4; i++) for (let j = -3; j <= 3; j++) {
        const [x, y] = X(i, j);
        if (x < W * 0.03 || x > W * 0.38 || y < H * 0.2 || y > H * 0.56) continue;
        node(ctx, x, y, C.violet, 2 * dpr, 0.9, false);
      }
      const cell = [X(0, 0), X(1, 0), X(1, 1), X(0, 1)];
      ctx.beginPath(); cell.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1]))); ctx.closePath();
      ctx.fillStyle = rgba(C.amber, 0.08); ctx.fill();
      ctx.strokeStyle = rgba(C.amber, 0.85); ctx.lineWidth = 1.4 * dpr; ctx.stroke();
      label(ctx, 'ω₁', X(1, 0)[0] + 4 * dpr, X(1, 0)[1] + 13 * dpr, C.amber, 12 * dpr);
      label(ctx, 'ω₂', X(0, 1)[0] - 20 * dpr, X(0, 1)[1] - 8 * dpr, C.amber, 12 * dpr);
      label(ctx, 'Λ = ℤω₁ + ℤω₂', X(0, 0)[0], X(0, 0)[1] + 30 * dpr, C.ink1, 10.5 * dpr, 0.85, 'left', 500);
      label(ctx, 'glue opposite edges of the cell', X(0, 0)[0], X(0, 0)[1] + 45 * dpr, C.ink, 9 * dpr, 0.7, 'left', 400);

      // the same line, straight, breaking where the cell is glued
      ctx.beginPath();
      let last = null;
      for (let i = 0; i <= samples; i++) {
        const tt = (i / Math.max(1, samples)) * st.tp;
        const [u, v] = at(tt);
        const [x, y] = X(u, v);
        if (!last || Math.abs(u - last[0]) > 0.5 || Math.abs(v - last[1]) > 0.5) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        last = [u, v];
      }
      ctx.strokeStyle = rgba(C.violet, 0.85 * f); ctx.lineWidth = 1.3 * dpr; ctx.stroke();
      for (let k = 1; k <= Math.floor(st.tp); k++) {
        const [u, v] = at(k);
        const [x, y] = X(u, v);
        const end = k === 1 || k === STEPS;
        node(ctx, x, y, end ? C.amber : C.violet, 3.2 * dpr * (k === st.hover ? 1.5 : 1), f);
        nodesL.push([k, x, y]);
      }
      // ≅
      ctx.save();
      ctx.shadowColor = rgba(C.cyan, 0.8); ctx.shadowBlur = 14 * dpr;
      label(ctx, '≅', W * 0.43, H * 0.47, C.hot, 30 * dpr, 0.95, 'center', 700);
      ctx.restore();
    }
  }

  function readout() {
    if (st.hover > 0) {
      const [u, v] = at(st.hover);
      return `${st.hover === 1 ? 'P' : st.hover + 'P'} = ${st.hover}·z mod Λ = ${u.toFixed(3)} ω₁ + ${v.toFixed(3)} ω₂`;
    }
    return `z = ${Z[0].toFixed(3)} ω₁ + ${Z[1].toFixed(3)} ω₂   walking k·z mod Λ,  k = ${Math.max(1, Math.floor(st.tp))}`;
  }
  return {
    id: 'torus', touchAction: 'pan-y',
    title: 'E(ℂ) ≅ ℂ/Λ', sub: 'the curve over the complex numbers is a torus',
    noteHead: 'uniformisation',
    noteBody: 'Weierstrass ℘ maps ℂ/Λ onto the curve, and adding in the lattice becomes the group law — so k·P is a straight line in the cell, and a winding one on the torus.',
    badge: 'VAULTLESS · E/ℂ · SHEET 05', hint: 'drag to turn the torus',
    draw, readout,
    busy: () => true,
    down(x, y) { st.drag = { x, y, yaw: st.yaw, pitch: st.pitch }; st.lastUser = performance.now() / 1000; },
    move(x, y, dpr) {
      if (st.drag) {
        const prev = st.yaw;
        st.yaw = st.drag.yaw + (x - st.drag.x) / dpr * 0.008;
        st.pitch = clamp(st.drag.pitch + (y - st.drag.y) / dpr * 0.006, -0.2, 1.4);
        st.vyaw = (st.yaw - prev) * 60;
        st.lastUser = performance.now() / 1000;
        return 'grabbing';
      }
      let hit = -1, bd = 14 * dpr;
      for (const [k, nx, ny] of [...nodesT, ...nodesL]) {
        const d = Math.hypot(nx - x, ny - y);
        if (d < bd) { bd = d; hit = k; }
      }
      st.hover = hit;
      return 'grab';
    },
    up() { st.drag = null; },
    leave() { st.hover = -1; },
    key(e) {
      if (e.key === 'ArrowLeft') st.yaw -= 0.1;
      else if (e.key === 'ArrowRight') st.yaw += 0.1;
      else if (e.key === 'ArrowUp') st.pitch = clamp(st.pitch + 0.08, -0.2, 1.4);
      else if (e.key === 'ArrowDown') st.pitch = clamp(st.pitch - 0.08, -0.2, 1.4);
      else return false;
      st.lastUser = performance.now() / 1000;
      return true;
    },
  };
}

/* ============================================================ the windows */
/* All three sheets at once, each in its own window with its own loop. They
 * used to share one stage behind tabs, which meant only ever seeing one.
 * Every window draws only while it is on screen and nothing covers it. */
const SCENES = { group: groupLaw, field: finiteField, torus: torus };

function initSheets() {
  for (const fig of document.querySelectorAll('.sheets[data-scene]')) {
    try { mountWindow(fig, SCENES[fig.dataset.scene]); }
    catch (err) { console.warn('vaultless sheet:', err); }   // one failing leaves the others
  }
}

function mountWindow(fig, factory) {
  const c = fig.querySelector('.sheets-canvas');
  if (!factory || !c || !c.getContext) return;
  const ctx = c.getContext('2d');
  const cur = factory();
  const q = (sel) => fig.querySelector(sel);
  const put = (sel, text) => { const el = q(sel); if (el) el.textContent = text; };
  put('.sheets-title', cur.title);
  put('.sheets-sub', cur.sub);
  put('.sheets-note-head', cur.noteHead);
  put('.sheets-note-body', cur.noteBody);
  put('.sheets-badge', cur.badge);
  put('.sheets-hint', cur.hint);
  const readoutEl = q('.sheets-readout');
  c.style.touchAction = cur.touchAction;
  c.dataset.scene = cur.id;
  if (cur.data) for (const [k, v] of Object.entries(cur.data)) c.dataset[k] = String(v);

  let visible = false, raf = 0, lastT = 0, lastDraw = 0, interacting = false, lastRead = '', readAt = -1e9;
  let dpr = 1;

  function frame(t) {
    raf = 0;
    if (covered()) return;                       // resumes when the pop-up closes
    const dt = clamp((t - lastT) / 1000 || 0, 0, 0.1);   // a frame can be stamped before the kick
    lastT = t;
    // ~40fps while it idles (~30 when calm), full rate while someone has hold of it
    if (interacting || t - lastDraw > (reduceMotion ? 32 : 24) * (load.lite ? 2 : 1) || dt === 0) {
      dpr = load.lite ? fit(c, 1.5, 3e5) : fit(c, 2, 6e5);
      ctx.clearRect(0, 0, c.width, c.height);
      cur.draw(ctx, c.width, c.height, dpr, t / 1000, dt);
      // numbers are for reading: a few times a second, or live under the finger
      if (readoutEl && (interacting || t - readAt > 200)) {
        const text = cur.readout();
        if (text !== lastRead) { readoutEl.textContent = text; lastRead = text; readAt = t; }
      }
      lastDraw = t;
    }
    if (visible && !document.hidden && cur.busy()) raf = requestAnimationFrame(frame);
  }
  function kick(now = false) {
    if (raf || document.hidden || covered()) return;
    if (!visible && !now) return;
    lastT = performance.now();
    raf = requestAnimationFrame(frame);
  }

  const local = (e) => {
    const r = c.getBoundingClientRect();
    return [(e.clientX - r.left) * (c.width / r.width), (e.clientY - r.top) * (c.height / r.height)];
  };
  c.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    c.setPointerCapture(e.pointerId);
    interacting = true;
    fig.classList.add('touched');
    cur.down(...local(e), dpr);
    c.style.cursor = 'grabbing';
    kick(true);
  });
  c.addEventListener('pointermove', (e) => {
    const cursor = cur.move(...local(e), dpr);
    c.style.cursor = cursor || '';
    kick(true);
  });
  const release = (e) => {
    if (!interacting) return;
    interacting = false;
    cur.up(...local(e), dpr);
    c.style.cursor = '';
    kick(true);
  };
  c.addEventListener('pointerup', release);
  c.addEventListener('pointercancel', release);
  c.addEventListener('pointerleave', () => { cur.leave(); kick(true); });
  c.addEventListener('keydown', (e) => {
    if (cur.key(e)) { e.preventDefault(); fig.classList.add('touched'); kick(true); }
  });

  // Only while the picture itself is at least a quarter on screen: a caption
  // or a sliver of stage peeking in is not worth a frame.
  new IntersectionObserver(([en]) => { visible = en.isIntersecting && en.intersectionRatio >= 0.25; kick(); },
    { threshold: [0, 0.25] }).observe(c);
  new ResizeObserver(() => kick(true)).observe(c);
  new MutationObserver(() => kick()).observe(document.body, { attributes: true, attributeFilter: ['class'] });
  document.addEventListener('visibilitychange', () => kick());
  kick(true);
}

/* ===================================================== 3D card tilt */

/* The shortcut button leans towards the pointer, with
 * a highlight that follows it. Mouse and pen only: on touch the card is under
 * the finger anyway, and a tilt that fires on every tap reads as a glitch.
 *
 * The hit test is against the card's rectangle as it was BEFORE it tilted.
 * Tilting moves the card's edges; test against the moved edges and a pointer
 * near one falls outside, the tilt drops, the edge moves back under the
 * pointer, and the card flickers. So the rectangle is taken on the way in and
 * kept until the pointer is really gone. */
function initTilt() {
  if (reduceMotion) return;
  const SEL = '.q-btn';
  let active = null, rect = null;
  const inside = (r, e) => e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
  const clear = () => { if (active) active.classList.remove('tilt-on'); active = null; rect = null; };
  const tilt = (el, r, e) => {
    const px = (e.clientX - r.left) / r.width, py = (e.clientY - r.top) / r.height;
    el.style.setProperty('--tx', `${((px - 0.5) * 9).toFixed(2)}deg`);
    el.style.setProperty('--ty', `${((0.5 - py) * 7).toFixed(2)}deg`);
    el.style.setProperty('--gx', `${(px * 100).toFixed(1)}%`);
    el.style.setProperty('--gy', `${(py * 100).toFixed(1)}%`);
    el.style.setProperty('--mx', (px - 0.5).toFixed(3));
    el.style.setProperty('--my', (py - 0.5).toFixed(3));
    el.classList.add('tilt-on');
  };
  document.addEventListener('pointermove', (e) => {
    if (e.pointerType === 'touch') return;
    if (active) {
      if (inside(rect, e) && !active.disabled) { tilt(active, rect, e); return; }
      clear();
    }
    const el = e.target instanceof Element ? e.target.closest(SEL) : null;
    if (!el || el.disabled) return;
    active = el;
    rect = el.getBoundingClientRect();
    tilt(el, rect, e);
  }, { passive: true });
  // left the window, scrolled (the stored rectangle is now stale), lost focus
  document.addEventListener('pointerout', (e) => { if (!e.relatedTarget) clear(); });
  addEventListener('scroll', clear, { passive: true });
  addEventListener('blur', clear);
}

/* Each part stands alone: a failure in one leaves the others, and the page,
 * exactly as they were. */
for (const init of [initField, initSheets, initTilt]) {
  try { init(); } catch (err) { console.warn('vaultless scene:', err); }
}
