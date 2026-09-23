/* The handshake pop-up, drawn.
 *
 * What app.js does to make a password, as a picture you can follow: the phrase
 * hashed onto a curve, walked across the group by r, carried over the wire,
 * walked again by the oracle's k, carried back with its proof, walked home by
 * r⁻¹, and poured through HKDF into the characters of a password.
 *
 * The picture is honest about what it is. The derivation runs on ristretto255,
 * a group of 2²⁵² + … elements that nobody can draw. This draws the same
 * protocol in a group you CAN see: the real curve y² = x³ − 3x + 5, whose one
 * real branch is a circle group, and on it a cyclic subgroup of prime order 197
 * — the 197 dots. Every hop is a genuine chord-and-tangent construction (the
 * line through two points meets the curve a third time; reflect it), every
 * walk is genuine double-and-add, and the loop closes the way the real one
 * does: r⁻¹·(k·(r·P)) lands exactly on k·P. The scalars are made up for the
 * picture, and so is P; none of them is, or is derived from, anything real.
 *
 * Isolation, as for scene.js:
 *
 *   - This module imports nothing and is loaded by its own <script> tag, so it
 *     is a separate module graph. If it throws, app.js — and every password —
 *     carries on, and the pop-up still shows its words.
 *   - It reads the stage ui.js writes on #viz, which oracle path is in use, the
 *     password's LENGTH (fixed by the chosen style), and the readout text — and
 *     the readout only ever holds B and B', the blinded values that already
 *     cross the wire in the open. No phrase, P, S, key or password is reachable
 *     from here, because none of them is ever put where this could read it.
 *   - Math.random below only ever chooses what the picture looks like.
 *   - It writes one thing back: where the finale's character slots sit on the
 *     canvas, so ui.js can fly the masked characters from there into the
 *     result card. That is layout, not data.
 *
 * Motion, in two registers:
 *
 *   - Full: the curve sways in perspective, hops draw themselves, packets
 *     travel the wire trailing their bytes, the projector turns.
 *   - Calm, for prefers-reduced-motion: the camera holds still and nothing
 *     travels — lines and points fade in where they are, packets dissolve from
 *     one end of the wire to the other, glyphs settle without flicker. It
 *     still moves; it just never slides, spins or zooms. A still frame per
 *     stage, which is what this used to do, read as a broken slideshow.
 *
 * And it has to hold 60 frames a second on a phone, so the hot paths draw in
 * batches: glows are pre-rendered sprites rather than a new gradient per
 * point per frame, dots are a few paths rather than a hundred, colours go
 * through globalAlpha rather than a freshly built rgba() string per call, and
 * the canvas has a pixel budget so a 3× phone screen is not asked to fill
 * nine times the pixels. Nothing draws while the pop-up is closed or the tab
 * is hidden.
 */

const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const $ = (id) => document.getElementById(id);
const TAU = Math.PI * 2;
const MONO = '"JetBrains Mono", "IBM Plex Mono", ui-monospace, monospace';

const C = {
  cyan: '#2bd9c9', cyanHot: '#7ff2e6', violet: '#b98aff', violetHot: '#d3b3ff',
  amber: '#e0a640', green: '#35d488', ink0: '#eafbf9', ink1: '#cfe7e6', ink2: '#7e9b9f',
  line: '#1f3a40', lineBright: '#3a545b', bg: '#05080a',
};
const rgba = (hex, a) => {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${Math.max(0, Math.min(1, a))})`;
};
const clamp01 = (v) => Math.max(0, Math.min(1, v));
const seg = (t, a, b) => clamp01((t - a) / (b - a));
const easeOut = (t) => 1 - Math.pow(1 - clamp01(t), 3);
const easeIO = (t) => { t = clamp01(t); return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; };

/* ============================================================ the group */
/* The real branch of y² = x³ − 3x + 5 is a circle, and not only as a shape:
 * measured with the invariant differential dx/y, adding points on the curve is
 * adding angles. So u ∈ [0, 1) names a point — u = 0 is 𝒪, at infinity, and
 * u = ½ is the one point of order two, where the curve crosses the axis — and
 * P(u) + P(v) = P(u + v). Then j/197 for j = 0 … 196 is a subgroup of prime
 * order 197, and scalar multiplication is multiplication mod 197.
 *
 * u(x) is the integral of dx/y from the root, which has an inverse-square-root
 * singularity there; substituting x = e₁ + s² removes it. Checked against the
 * chord rule: the line through P(u) and P(v) meets P(−u−v) to within 3·10⁻⁴. */
const f = (x) => x * x * x - 3 * x + 5;
const E1 = (() => {
  let lo = -3, hi = -2;
  for (let i = 0; i < 80; i++) { const m = (lo + hi) / 2; if (f(m) < 0) lo = m; else hi = m; }
  return (lo + hi) / 2;
})();
const QC = E1 * E1 - 3;                   // f(x) = (x − e₁)(x² + e₁x + e₁² − 3)
const SMAX = 240, NS = 5000;
const sT = new Float64Array(NS + 1), zT = new Float64Array(NS + 1);
const HALF = (() => {
  const h = (t) => { const x = E1 + t * t; return 2 / Math.sqrt(x * x + E1 * x + QC); };
  let z = 0;
  for (let i = 1; i <= NS; i++) {
    const s0 = sT[i - 1], s1 = SMAX * (i / NS) ** 2;
    sT[i] = s1;
    z += (s1 - s0) / 6 * (h(s0) + 4 * h((s0 + s1) / 2) + h(s1));
    zT[i] = z;
  }
  return z + 2 / SMAX;                     // the tail beyond SMAX is 2/s to within 10⁻⁶
})();

function onCurve(u) {
  u -= Math.floor(u);
  const d = Math.abs(0.5 - u) * 2 * HALF;
  let s;
  if (d >= zT[NS]) s = 2 / Math.max(1e-6, HALF - d);
  else {
    let a = 0, b = NS;
    while (b - a > 1) { const m = (a + b) >> 1; if (zT[m] < d) a = m; else b = m; }
    s = sT[a] + (d - zT[a]) / (zT[b] - zT[a]) * (sT[b] - sT[a]);
  }
  const x = E1 + s * s;
  return { x, y: (u < 0.5 ? 1 : -1) * Math.sqrt(Math.max(0, f(x))) };
}

const N = 197;
const PTS = Array.from({ length: N }, (_, j) => (j ? onCurve(j / N) : null));
const mod = (a) => ((a % N) + N) % N;

/* Double-and-add, read off the scalar's bits from the top, one hop per group
 * operation — each hop records which bit it is spending. */
function walk(from, m) {
  const bits = m.toString(2), hops = [];
  let acc = from;
  for (let i = 1; i < bits.length; i++) {
    const d = mod(2 * acc);
    hops.push({ a: acc, b: acc, r: d, bit: i });
    acc = d;
    if (bits[i] === '1') {
      const s = mod(acc + from);
      hops.push({ a: acc, b: from, r: s, bit: i });
      acc = s;
    }
  }
  return { start: from, hops, end: acc, bits };
}

/* ============================================================ the view */
const XMIN = -2.75, XMAX = 3.45, YMAX = 5.9;
const XC = (XMIN + XMAX) / 2;
const visible = (j) => j > 0 && PTS[j].x <= XMAX - 0.2 && Math.abs(PTS[j].y) <= YMAX - 0.25;
/* Past this the point is off the picture anyway, and far enough out the
 * perspective divide would fold it back onto the screen — so nothing beyond it
 * is drawn at all. */
const XFAR = XMAX + 2.5;
const drawable = (j) => j > 0 && PTS[j].x <= XFAR;

// Scalar pairs with r·r⁻¹ ≡ 1 (mod 197), both short enough to walk in a beat.
const PAIRS = [];
for (let r = 9; r < 64; r++) for (let q = 9; q < 64; q++) if ((r * q) % N === 1) PAIRS.push([r, q]);
const pick = (n) => (Math.random() * n) | 0;

/* A picture worth looking at: every landmark on screen, well apart, and as
 * much of each walk visible as can be had. Chosen by trying a few. */
function makePlan(paper) {
  let best = null, bestScore = -Infinity;
  for (let t = 0; t < 160; t++) {
    const a = 1 + pick(N - 1);
    if (!visible(a)) continue;
    const k = 17 + pick(47);
    const S = mod(k * a);
    let plan;
    if (paper) {
      plan = { a, k, S, marks: [a, S], walks: { stamp: walk(a, k) } };
    } else {
      const [r, ri] = PAIRS[pick(PAIRS.length)];
      const B = mod(r * a), Bp = mod(k * B);
      plan = { a, k, r, ri, B, Bp, S, marks: [a, B, Bp, S],
               walks: { blind: walk(a, r), stamp: walk(B, k), unblind: walk(Bp, ri) } };
    }
    if (!plan.marks.every(visible)) continue;
    if (new Set(plan.marks).size !== plan.marks.length) continue;
    let score = 0, n = 0;
    for (const w of Object.values(plan.walks)) for (const h of w.hops) { n++; if (visible(h.r)) score++; }
    score /= Math.max(1, n);
    for (let i = 0; i < plan.marks.length; i++) {
      for (let j = i + 1; j < plan.marks.length; j++) {
        const p = PTS[plan.marks[i]], q = PTS[plan.marks[j]];
        if (Math.hypot(p.x - q.x, (p.y - q.y) / 2) < 0.9) score -= 0.4;
      }
    }
    if (score > bestScore) { bestScore = score; best = plan; }
  }
  return best;
}

/* ============================================================ drawing */
const cv = $('hsCanvas');
const ctx = cv && cv.getContext ? cv.getContext('2d') : null;
const viz = $('viz'), pop = $('hsPop');
const CALM = reduceMotion;

let W = 0, H = 0, dpr = 1;
let L = null;                              // layout, recomputed on resize
let stageName = '', stageT0 = 0, beat = 900, path = 'paper', plan = null;

/* ---- drawing primitives that stay cheap at 60fps */
let curFont = '';
function setFont(f) { if (f !== curFont) { ctx.font = f; curFont = f; } }
function paint(color, alpha) { ctx.globalAlpha = clamp01(alpha); ctx.fillStyle = color; ctx.strokeStyle = color; }
function text(str, x, y, { color = C.ink2, size = 10, weight = 500, align = 'left', base = 'middle', alpha = 1 } = {}) {
  if (alpha <= 0.005) return;
  setFont(`${weight} ${size}px ${MONO}`);
  ctx.textAlign = align; ctx.textBaseline = base;
  paint(color, alpha);
  ctx.fillText(str, x, y);
  ctx.globalAlpha = 1;
}

/* A soft glow, pre-rendered once per colour and stamped with drawImage — a new
 * radial gradient per point per frame was most of what a phone spent here. */
const SPRITES = new Map();
function glowSprite(color) {
  let sp = SPRITES.get(color);
  if (sp) return sp;
  sp = document.createElement('canvas');
  sp.width = sp.height = 64;
  const g = sp.getContext('2d'), gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  gr.addColorStop(0, rgba(color, 1)); gr.addColorStop(1, rgba(color, 0));
  g.fillStyle = gr; g.fillRect(0, 0, 64, 64);
  SPRITES.set(color, sp);
  return sp;
}
function glow(x, y, r, color, alpha) {
  if (alpha <= 0.01 || r <= 0) return;
  ctx.globalAlpha = clamp01(alpha);
  ctx.drawImage(glowSprite(color), x - r, y - r, 2 * r, 2 * r);
  ctx.globalAlpha = 1;
}

function layout() {
  const r = cv.getBoundingClientRect();
  W = Math.max(1, r.width); H = Math.max(1, r.height);
  // Crisp on a retina screen, but never more than ~1.4M pixels to fill.
  dpr = Math.min(2, window.devicePixelRatio || 1, Math.sqrt(1.4e6 / (W * H)));
  cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
  curFont = '';                               // a resize resets the context's state
  const narrow = W < 520;
  const R = Math.max(14, Math.min(28, Math.min(W, H) * 0.065));
  const nodeY = H * 0.46;
  const you = { x: narrow ? R + 8 : W * 0.085, y: nodeY };
  const orc = { x: W - (narrow ? R + 8 : W * 0.085), y: nodeY };
  const x0 = you.x + R * 1.9, x1 = orc.x - R * 1.9;
  const y0 = H * 0.15, y1 = H * 0.79;
  const traceY = H * 0.065;
  const trace = [
    [you.x, you.y - R * 1.25], [you.x, traceY], [orc.x, traceY], [orc.x, orc.y - R * 1.25],
  ];
  const lens = [0];
  for (let i = 1; i < trace.length; i++) {
    lens.push(lens[i - 1] + Math.hypot(trace[i][0] - trace[i - 1][0], trace[i][1] - trace[i - 1][1]));
  }
  L = {
    narrow, R, you, orc, x0, x1, y0, y1, traceY, trace, lens,
    cx: (x0 + x1) / 2, cy: (y0 + y1) / 2,
    sx: (x1 - x0) / (XMAX - XMIN), sy: (y1 - y0) / (2 * YMAX),
    ringY: H * 0.885, ringRX: Math.min(W * 0.33, 330), ringRY: Math.max(9, H * 0.05),
  };
}

let yaw = -0.2;
function proj(x, y) {
  const X = (x - XC) * L.sx, Y = -y * L.sy;
  const Xr = X * Math.cos(yaw), Z = X * Math.sin(yaw);
  const sc = 1100 / (1100 + Z);
  return [L.cx + Xr * sc, L.cy + Y * sc];
}
const projJ = (j) => proj(PTS[j].x, PTS[j].y);

function along(q) {                         // a point q ∈ [0,1] of the way along the wire
  const tot = L.lens[L.lens.length - 1], d = clamp01(q) * tot;
  for (let i = 1; i < L.trace.length; i++) {
    if (d <= L.lens[i] || i === L.trace.length - 1) {
      const t = (d - L.lens[i - 1]) / Math.max(1e-6, L.lens[i] - L.lens[i - 1]);
      const [ax, ay] = L.trace[i - 1], [bx, by] = L.trace[i];
      return [ax + (bx - ax) * t, ay + (by - ay) * t];
    }
  }
  return L.trace[L.trace.length - 1];
}

/* ---- backdrop: a floor that recedes, and the projector that shows the curve */
function floor(t) {
  const hz = H * 0.58, vp = W / 2;
  ctx.lineWidth = 1;
  for (const band of [[0, 4, 0.05], [5, 9, 0.034], [10, 14, 0.018]]) {
    ctx.beginPath();
    for (let a = band[0]; a <= band[1]; a++) {
      for (const i of a ? [-a, a] : [0]) { ctx.moveTo(vp + i * W * 0.012, hz); ctx.lineTo(vp + i * W * 0.11, H); }
    }
    paint(C.cyan, band[2]); ctx.stroke();
  }
  const off = CALM ? 0.3 : (t * 0.00011) % 1;
  for (let k = 0; k < 9; k++) {
    const z = (k + off) / 9, y = hz + (H - hz) * z * z;
    paint(C.cyan, 0.075 * z);
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
  }
  ctx.globalAlpha = 1;
}

/* The order of ristretto255 — the real group, written round the base of the
 * picture of the toy one. */
const ELL = 'ℓ = 7237005577332262213973186563042994240857116359379907606001950938285454250989 · ristretto255 · prime order · ';
function projector(t, alpha) {
  if (alpha <= 0.01) return;
  const { ringY: cy, ringRX: rx, ringRY: ry } = L, cx = W / 2;
  const g = ctx.createLinearGradient(0, cy, 0, L.y0);
  g.addColorStop(0, rgba(C.cyan, 0.075 * alpha)); g.addColorStop(1, rgba(C.cyan, 0));
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.moveTo(cx - rx * 0.78, cy); ctx.lineTo(cx - rx * 1.12, L.y0);
  ctx.lineTo(cx + rx * 1.12, L.y0); ctx.lineTo(cx + rx * 0.78, cy); ctx.closePath(); ctx.fill();

  ctx.lineWidth = 1;
  paint(C.cyan, 0.28 * alpha);
  ctx.beginPath(); ctx.ellipse(cx, cy, rx, ry, 0, 0, TAU); ctx.stroke();
  ctx.setLineDash([3, 5]);
  paint(C.cyan, 0.2 * alpha);
  ctx.beginPath(); ctx.ellipse(cx, cy, rx * 0.72, ry * 0.72, 0, 0, TAU); ctx.stroke();
  ctx.setLineDash([]);

  const circ = TAU * Math.sqrt((rx * rx + ry * ry) / 2) * 0.86;
  const n = Math.max(24, Math.min(ELL.length, Math.floor(circ / 6.4)));
  const rot = CALM ? 0.4 : t * 0.00006;
  setFont(`500 9px ${MONO}`); ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  let hotNow = null;
  for (let i = 0; i < n; i++) {
    const a = rot + (i / n) * TAU;
    const front = (Math.sin(a) + 1) / 2;
    const hot = front > 0.5;
    if (hot !== hotNow) { ctx.fillStyle = hot ? C.cyanHot : C.cyan; hotNow = hot; }
    ctx.globalAlpha = (0.06 + 0.42 * front * front) * alpha;
    ctx.fillText(ELL[i], cx + Math.cos(a) * rx * 0.86, cy + Math.sin(a) * ry * 0.86);
  }
  ctx.globalAlpha = 1;
}

/* ---- the curve and its 197 points */
const CURVE = (() => {
  const top = [], smax = Math.sqrt(XMAX + 1.6 - E1);
  for (let i = 0; i <= 140; i++) {
    const sv = smax * (i / 140) ** 1.15, x = E1 + sv * sv;
    top.push([x, Math.sqrt(Math.max(0, f(x)))]);
  }
  return top;
})();

/* Projected once per frame and stroked from the cache: the glow, the line
 * itself and the reflection all share one set of points. */
function curvePath(reveal) {
  const n = CURVE.length - 1, upto = Math.max(1, Math.round(n * reveal));
  const pts = [];
  for (let i = upto; i >= 0; i--) pts.push(proj(CURVE[i][0], -CURVE[i][1]));
  for (let i = 1; i <= upto; i++) pts.push(proj(CURVE[i][0], CURVE[i][1]));
  return pts;
}
function strokePts(pts) {
  ctx.beginPath();
  ctx.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
  ctx.stroke();
}
function curve(pts, strength = 1) {
  ctx.lineJoin = 'round'; ctx.lineCap = 'round';
  ctx.lineWidth = 6; paint(C.cyan, 0.1 * strength); strokePts(pts);
  ctx.lineWidth = 1.5; paint(C.cyanHot, 0.88 * strength); strokePts(pts);
  ctx.globalAlpha = 1;
}

/* The group's dots, twinkling — four paths, not a hundred and thirty. */
function dots(alpha, t) {
  const LV = 4, buckets = Array.from({ length: LV }, () => []);
  const speed = CALM ? 0.0009 : 0.0023;
  for (let j = 1; j < N; j++) {
    if (!visible(j)) continue;
    const tw = 0.5 + 0.5 * Math.sin(t * speed + j * 2.399);
    buckets[Math.min(LV - 1, (tw * LV) | 0)].push(projJ(j));
  }
  for (let q = 0; q < LV; q++) {
    const tw = (q + 0.5) / LV, r = 1.3 + 0.6 * tw;
    ctx.beginPath();
    for (const [x, y] of buckets[q]) { ctx.moveTo(x + r, y); ctx.arc(x, y, r, 0, TAU); }
    paint(C.cyanHot, (0.35 + 0.4 * tw) * alpha); ctx.fill();
  }
  ctx.globalAlpha = 1;
}

/* The hologram's reflection on the floor under it. */
function reflection(pts) {
  const base = L.y1 + 10;
  ctx.save();
  ctx.beginPath(); ctx.rect(L.x0 - 18, base - 4, L.x1 - L.x0 + 36, H - base); ctx.clip();
  ctx.translate(0, base); ctx.scale(1, -0.2); ctx.translate(0, -L.cy);
  ctx.lineWidth = 1.5; paint(C.cyan, 0.24); strokePts(pts);
  ctx.restore();
  ctx.globalAlpha = 1;
}

/* Dust in the projector's light, rising — or, calm, glinting where it hangs. */
const DUST = Array.from({ length: 38 }, () => ({ x: Math.random(), s: 0.3 + Math.random() * 0.7, o: Math.random() }));
function dust(t) {
  const cx = W / 2, rx = L.ringRX;
  ctx.fillStyle = C.cyanHot;
  for (const d of DUST) {
    const k = CALM ? d.o : (d.o + t * 0.00005 * d.s) % 1;
    const y = L.ringY - k * (L.ringY - L.y0);
    const x = cx + (d.x * 2 - 1) * rx * (0.78 + 0.34 * k);
    const glint = CALM ? 0.5 + 0.5 * Math.sin(t * 0.0012 + d.o * 40) : 1;
    ctx.globalAlpha = 0.35 * Math.sin(k * Math.PI) * d.s * glint;
    ctx.fillRect(x, y, 1.5, 1.5);
  }
  ctx.globalAlpha = 1;
}

/* A slow scan line down the stage, the way a display refreshes. */
function sweep(t) {
  if (CALM) return;
  const y = ((t * 0.00012) % 1.3) * H - H * 0.15;
  const g = ctx.createLinearGradient(0, y - 40, 0, y + 4);
  g.addColorStop(0, rgba(C.cyan, 0)); g.addColorStop(1, rgba(C.cyan, 0.035));
  ctx.fillStyle = g; ctx.fillRect(0, y - 40, W, 44);
  paint(C.cyanHot, 0.06); ctx.fillRect(0, y + 3, W, 1);
  ctx.globalAlpha = 1;
}

/* ---- the two parties and the wire between them */
function hexPath(x, y, R, rot = 0) {
  ctx.beginPath();
  for (let i = 0; i < 6; i++) {
    const a = rot + Math.PI / 6 + (i * TAU) / 6;
    const px = x + Math.cos(a) * R, py = y + Math.sin(a) * R;
    i ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
  }
  ctx.closePath();
}

function node(p, { color, glyph, name, sub, hot = 0, seal = 0, t = 0, flash = 0 }) {
  const R = L.R;
  glow(p.x, p.y, R * 3, color, 0.28 * Math.max(hot, flash));
  if (seal > 0.01) {                           // the oracle's seal, turning while k works
    ctx.lineWidth = 1.2;
    const breathe = CALM ? 0.65 + 0.35 * Math.sin(t * 0.004) : 1;
    for (const [k, dir, dash] of [[1.55, 1, [4, 6]], [1.95, -1, [2, 9]]]) {
      ctx.setLineDash(dash);
      paint(color, 0.55 * seal * breathe);
      hexPath(p.x, p.y, R * k, CALM ? 0 : dir * t * 0.0012);
      ctx.stroke();
    }
    ctx.setLineDash([]);
  }
  hexPath(p.x, p.y, R);
  paint('#0a1014', 0.95); ctx.fill();
  ctx.lineWidth = 1.6; paint(color, 0.45 + 0.55 * Math.max(hot, flash)); ctx.stroke();
  hexPath(p.x, p.y, R * 0.74);
  ctx.lineWidth = 1; paint(color, 0.18 + 0.2 * hot); ctx.stroke();
  ctx.globalAlpha = 1;
  text(glyph, p.x, p.y + 1, { color: hot > 0.3 ? color : C.ink1, size: Math.round(R * 0.8), weight: 700, align: 'center' });
  text(name, p.x, p.y + R * 1.45, { color: C.ink1, size: L.narrow ? 8.5 : 9.5, weight: 600, align: 'center', alpha: 0.9 });
  if (sub) text(sub, p.x, p.y + R * 1.45 + 12, { color, size: L.narrow ? 8 : 9, align: 'center', alpha: 0.8 });
}

function wire(glowAmt, alpha = 1) {
  const pts = L.trace;
  ctx.lineWidth = 1.2; ctx.lineJoin = 'round';
  paint(C.lineBright, 0.8 * alpha);
  ctx.beginPath(); pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y))); ctx.stroke();
  if (glowAmt > 0.01) {
    ctx.lineWidth = 5; paint(C.violet, 0.12 * glowAmt);
    ctx.beginPath(); pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y))); ctx.stroke();
  }
  paint(C.lineBright, alpha);
  ctx.beginPath();
  for (const [x, y] of pts.slice(1, -1)) { ctx.moveTo(x + 2.4, y); ctx.arc(x, y, 2.4, 0, TAU); }   // vias
  ctx.fill();
  ctx.globalAlpha = 1;
}

function wireBytes() {
  const hex = ($('vizHex')?.textContent || '').match(/[0-9a-f]{2}/g);
  return hex && hex.length ? hex : null;
}
const byteAt = (bytes, i) => bytes ? bytes[i % bytes.length] : ((Math.random() * 256) | 0).toString(16).padStart(2, '0');

function packet(q, forward, color, t, { proof = false } = {}) {
  const bytes = wireBytes();
  const at = (qq) => along(forward ? qq : 1 - qq);
  if (CALM) {
    /* Nothing travels: the bytes surface along the whole wire and sink again,
     * while the light hands over from one end to the other. */
    const a = Math.sin(Math.PI * clamp01(q));
    for (let i = 0; i < 12; i++) {
      const [x, y] = at((i + 0.5) / 12);
      text(byteAt(bytes, i), x, y - 9, { color, size: 9, align: 'center', alpha: 0.75 * a });
    }
    const [sx, sy] = at(0), [dx, dy] = at(1);
    glow(sx, sy, 22, color, 0.55 * (1 - q));
    glow(dx, dy, 22, color, 0.55 * q);
    if (proof) { const [px, py] = at(1); text('π', px + 14, py, { color: C.green, size: 11, weight: 700, align: 'center', alpha: q }); }
    return;
  }
  for (let i = 1; i <= 14; i++) {              // the bytes, strung out behind it
    const qq = q - i * 0.02;
    if (qq < 0) break;
    const [x, y] = at(qq);
    text(byteAt(bytes, i), x, y - 9, { color, size: 9, align: 'center', alpha: 0.85 * (1 - i / 15) });
  }
  const [x, y] = at(q);
  glow(x, y, 22, color, 0.55);
  ctx.save(); ctx.translate(x, y); ctx.rotate(Math.PI / 4 + t * 0.004);
  paint(C.ink0, 0.95); ctx.fillRect(-4.5, -4.5, 9, 9);
  paint(color, 1); ctx.lineWidth = 1.5; ctx.strokeRect(-7, -7, 14, 14);
  ctx.restore();
  ctx.globalAlpha = 1;
  if (proof) {                                  // π rides along with B'
    const a = t * 0.006;
    text('π', x + Math.cos(a) * 15, y + Math.sin(a) * 15, { color: C.green, size: 11, weight: 700, align: 'center' });
  }
}

/* ---- marks and hops on the curve */
function mark(j, color, label, { alpha = 1, pulse = 0, ring = 0, big = false } = {}) {
  if (!drawable(j)) return;
  const [x, y] = projJ(j);
  if (ring > 0 && ring < 1) {
    ctx.lineWidth = 1.5; paint(color, 0.9 * (1 - ring));
    // calm: the ring glows and fades where it is; full: it spreads outward
    ctx.beginPath(); ctx.arc(x, y, CALM ? 11 : 5 + ring * 34, 0, TAU); ctx.stroke();
  }
  glow(x, y, 16 + pulse * 8, color, 0.5 * alpha);
  const rr = big ? 6.5 : 5;
  paint(C.bg, alpha); ctx.beginPath(); ctx.arc(x, y, rr, 0, TAU); ctx.fill();
  ctx.lineWidth = 2; paint(color, alpha);
  ctx.beginPath(); ctx.arc(x, y, rr, 0, TAU); ctx.stroke();
  ctx.beginPath(); ctx.arc(x, y, rr * 0.42, 0, TAU); ctx.fill();
  ctx.globalAlpha = 1;
  if (label) {
    const right = x < L.x1 - 60;
    text(label, x + (right ? 10 : -10), y - 11, { color, size: 11, weight: 700, align: right ? 'left' : 'right', alpha });
  }
}

/* One group operation, drawn as it is done: the line (a chord through two
 * points, or the tangent when doubling), the third point where it meets the
 * curve again, and the reflection across the axis that makes the sum. Full
 * motion draws each of those out; calm fades each one in where it lies. */
function hop(h, q, color, alpha) {
  const A = PTS[h.a], B = PTS[h.b], R = PTS[mod(-h.r)], S = PTS[h.r];
  if (Math.abs(R.x - A.x) < 1e-9) return;
  const lam = (R.y - A.y) / (R.x - A.x);
  const lo = Math.min(A.x, B.x, R.x) - 0.45, hi = Math.min(XFAR, Math.max(A.x, B.x, R.x) + 0.45);
  if (A.x > XFAR) return;
  const grow = easeOut(seg(q, 0, 0.42));
  const g = CALM ? 1 : grow, fade = CALM ? grow : 1;
  const xa = A.x - (A.x - lo) * g, xb = A.x + (hi - A.x) * g;
  const p0 = proj(xa, A.y + lam * (xa - A.x)), p1 = proj(xb, A.y + lam * (xb - A.x));
  for (const [w, a] of [[6, 0.12], [1.6, 0.95]]) {
    ctx.lineWidth = w; paint(color, a * alpha * fade);
    ctx.beginPath(); ctx.moveTo(p0[0], p0[1]); ctx.lineTo(p1[0], p1[1]); ctx.stroke();
  }
  if (h.a !== h.b && q < 0.7 && B.x <= XFAR) {  // the point being added
    const [bx, by] = proj(B.x, B.y);
    ctx.lineWidth = 1; paint(color, 0.7 * alpha * fade);
    ctx.beginPath(); ctx.arc(bx, by, 7, 0, TAU); ctx.stroke();
  }
  ctx.globalAlpha = 1;
  if (R.x > XFAR) return;
  const [rx, ry] = proj(R.x, R.y);
  if (q > 0.36) {                               // where the line meets the curve again
    const hit = seg(q, 0.36, 0.5);
    ctx.lineWidth = 1.4; paint(color, alpha * (q < 0.9 ? 1 : 0.5) * (CALM ? hit : 1));
    ctx.beginPath(); ctx.arc(rx, ry, 4.5, 0, TAU); ctx.stroke();
    if (!CALM && hit < 1 && alpha > 0.9) {
      paint(color, 0.8 * (1 - hit));
      ctx.beginPath(); ctx.arc(rx, ry, 4.5 + hit * 16, 0, TAU); ctx.stroke();
    }
  }
  if (q > 0.48) {                               // …and its mirror image is the sum
    const m = easeOut(seg(q, 0.48, 0.8));
    const [sx, sy] = proj(S.x, CALM ? S.y : R.y + (S.y - R.y) * m);
    ctx.setLineDash([3, 4]); ctx.lineWidth = 1.3; paint(color, 0.9 * alpha * (CALM ? m : 1));
    ctx.beginPath(); ctx.moveTo(rx, ry); ctx.lineTo(sx, sy); ctx.stroke(); ctx.setLineDash([]);
  }
  ctx.globalAlpha = 1;
}

/* Plays a walk across [t0, t1] of the stage and returns where it has got to. */
function playWalk(w, e, t0, t1, color) {
  const n = w.hops.length;
  if (!n) return { acc: w.start, bit: -1, done: true };
  const hd = (t1 - t0) / n;
  const k = Math.floor((e - t0) / hd);
  const doneUpto = Math.max(0, Math.min(k, n));
  for (let i = Math.max(0, doneUpto - 3); i < doneUpto; i++) {
    hop(w.hops[i], 1, color, 0.12 + 0.1 * (i - doneUpto + 3));
  }
  if (k < 0) return { acc: w.start, bit: -1, done: false };
  if (k >= n) return { acc: w.end, bit: w.bits.length, done: true };
  const q = (e - t0 - k * hd) / hd;
  hop(w.hops[k], q, color, 1);
  return { acc: q > 0.8 ? w.hops[k].r : w.hops[k].a, bit: w.hops[k].bit, done: false, moving: q };
}

/* The scalar's bits, with the one being spent lit up. */
function bitsLabel(name, w, cur, x, y, color, align) {
  const bits = w.bits, cw = 7.4, total = (name.length + 3 + bits.length) * cw;
  let px = align === 'right' ? x - total : align === 'center' ? x - total / 2 : x;
  px = Math.max(4, Math.min(W - 4 - total, px));      // never off the edge of a phone
  text(name + ' = ', px, y, { color, size: 11, weight: 600, alpha: 0.9 });
  px += (name.length + 3) * cw;
  for (let i = 0; i < bits.length; i++) {
    const on = i === cur, past = i < cur;
    text(bits[i], px + i * cw, y, { color: on ? C.ink0 : color, size: 11, weight: on ? 800 : 500, alpha: on ? 1 : past ? 0.85 : 0.35 });
    if (on) { paint(color, 0.9); ctx.fillRect(px + i * cw - 0.5, y + 8, cw - 1.5, 1.5); ctx.globalAlpha = 1; }
  }
  text('₂', px + bits.length * cw + 1, y + 3, { color, size: 9, alpha: 0.6 });
}

/* ---- the finale: S through HKDF into the password's characters, masked */
const GLYPHS = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789!@#$%&*=+';
let slotsSent = '';
function finale(e, len, now) {
  const n = Math.max(1, Math.min(40, len)), b = beat;
  const cw = Math.min(22, (W * 0.8) / n), total = cw * n, x0 = (W - total) / 2, y = L.ringY;
  /* Hand ui.js the row, in canvas CSS pixels, so it can fly the characters
   * from exactly here to the result card. Written only when it changes. */
  const row = `${x0.toFixed(1)},${cw.toFixed(2)},${y.toFixed(1)},${n}`;
  if (row !== slotsSent) { viz.dataset.slots = row; slotsSent = row; }

  const [sx, sy] = projJ(plan.S);
  const beamIn = easeOut(seg(e, 0, 0.35 * b));
  if (beamIn > 0) {
    const g = ctx.createLinearGradient(sx, sy, W / 2, y);
    g.addColorStop(0, rgba(C.cyanHot, 0.7)); g.addColorStop(1, rgba(C.cyan, 0.15));
    ctx.strokeStyle = g; ctx.lineWidth = 1.5;
    ctx.globalAlpha = CALM ? beamIn : 1;
    ctx.beginPath(); ctx.moveTo(sx, sy);
    const reach = CALM ? 1 : beamIn;
    ctx.lineTo(sx + (W / 2 - sx) * reach, sy + (y - 14 - sy) * reach); ctx.stroke();
    ctx.globalAlpha = 1;
  }
  text(`HKDF-SHA256(S, account) → ${len} characters`, W / 2, y - 22,
       { color: C.ink2, size: L.narrow ? 8.5 : 9.5, align: 'center', alpha: seg(e, 0.1 * b, 0.4 * b) });
  const settled = [];
  ctx.lineWidth = 1;
  for (let i = 0; i < n; i++) {
    const t0 = 0.2 * b + (i / n) * 0.9 * b;
    if (e < t0) continue;
    const p = seg(e, t0, t0 + 0.34 * b);
    const x = x0 + i * cw + cw / 2;
    paint(C.cyan, (0.25 + 0.35 * p) * (CALM ? p : 1));
    ctx.strokeRect(x - cw / 2 + 1.5, y - 10, cw - 3, 20);
    if (p >= 1) settled.push(x);
    else if (CALM) text('•', x, y + 1, { color: C.cyanHot, size: 14, weight: 700, align: 'center', alpha: p });
    else text(GLYPHS[(Math.random() * GLYPHS.length) | 0], x, y + 1, { color: C.violetHot, size: 12, align: 'center', alpha: 0.8 });
  }
  ctx.globalAlpha = 1;
  for (const x of settled) {
    glow(x, y, 10, C.cyan, 0.35);
    text('•', x, y + 1, { color: C.cyanHot, size: 14, weight: 700, align: 'center' });
  }
  if (e > 1.3 * b) {
    const pulse = 0.5 + 0.5 * Math.sin((e - 1.3 * b) * (CALM ? 0.003 : 0.006));
    paint(C.cyan, 0.06 + 0.05 * pulse);
    ctx.fillRect(x0 - 6, y - 14, total + 12, 28);
    ctx.globalAlpha = 1;
  }
}

/* ---- the DLEQ proof: same k on both sides, checked before anything is used */
function proofCard(state, alpha) {
  if (alpha <= 0.01) return;
  const x = W / 2, y = L.traceY + 26;
  const ok = state === 'ok';
  const txt = ok ? '✓ proof verified · log_G(Y) = log_B(B′)' : 'π · log_G(Y) = log_B(B′) · checking…';
  setFont(`600 ${L.narrow ? 9 : 10.5}px ${MONO}`);
  const w = ctx.measureText(txt).width + 22;
  paint('#0a1014', 0.92 * alpha);
  ctx.beginPath(); ctx.rect(x - w / 2, y - 11, w, 22); ctx.fill();
  ctx.lineWidth = 1; paint(ok ? C.green : C.violet, 0.7 * alpha); ctx.stroke();
  ctx.globalAlpha = 1;
  text(txt, x, y + 0.5, { color: ok ? C.green : C.violetHot, size: L.narrow ? 9 : 10.5, weight: 600, align: 'center', alpha });
}

/* ---- hash-to-curve: bits streaming out of "you" and condensing into P */
const SPARKS = Array.from({ length: 46 }, (_, i) => ({
  delay: (i / 46) * 0.5, bend: (Math.random() - 0.5) * 1.6, bit: Math.random() < 0.5 ? '0' : '1',
}));
function hashing(e) {
  const b = beat, [px, py] = projJ(plan.a), { x: ux, y: uy } = L.you;
  if (CALM) {
    // the same story without anything flying: a thread from you to P fades in
    ctx.setLineDash([2, 5]); ctx.lineWidth = 1;
    paint(C.cyan, 0.55 * easeOut(seg(e, 0, 0.7 * b)));
    ctx.beginPath(); ctx.moveTo(ux, uy); ctx.lineTo(px, py); ctx.stroke();
    ctx.setLineDash([]); ctx.globalAlpha = 1;
  } else {
    for (const sp of SPARKS) {
      const p = seg(e, sp.delay * b, (sp.delay + 0.36) * b);
      if (p <= 0 || p >= 1) continue;
      const q = easeIO(p);
      const cx = (ux + px) / 2, cy = Math.min(uy, py) - H * 0.25 * sp.bend;
      const x = (1 - q) * (1 - q) * ux + 2 * (1 - q) * q * cx + q * q * px;
      const y = (1 - q) * (1 - q) * uy + 2 * (1 - q) * q * cy + q * q * py;
      text(sp.bit, x, y, { color: q > 0.7 ? C.cyanHot : C.cyan, size: 10, weight: 600, align: 'center', alpha: Math.sin(p * Math.PI) });
    }
  }
  text('SHA-512 → ristretto255', (ux + px) / 2, Math.max(L.y0 + 8, Math.min(uy, py) - H * 0.2),
       { color: C.cyan, size: 9.5, align: 'center', alpha: 0.7 * Math.sin(seg(e, 0, 0.9 * b) * Math.PI) });
}

/* ============================================================ the frame */
const ORDER = ['local', 'blinding', 'sending', 'stamping', 'returning', 'unblinding', 'done'];
const past = (name) => ORDER.indexOf(stageName) > ORDER.indexOf(name);

function draw(now) {
  if (!ctx || !L || !plan) return;
  const b = beat, e = now - stageT0, st = stageName;
  const paper = path === 'paper';
  yaw = CALM ? -0.22 : -0.22 + 0.3 * Math.sin(now * 0.00021);

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.globalAlpha = 1;
  ctx.clearRect(0, 0, W, H);
  floor(now);
  const lamp = st === 'done' ? 1 - easeOut(seg(e, 0, 0.5 * b)) : 1;
  projector(now, lamp);
  if (lamp > 0.05) dust(now);
  sweep(now);
  text('E(ℝ) ⊃ ⟨G⟩ ≅ ℤ/197ℤ', L.x0 + 2, L.traceY + 22, { color: C.ink2, size: 9, alpha: 0.7 });

  const reveal = st === 'local' ? easeOut(seg(e, 0, 0.6 * b)) : 1;
  const cpts = curvePath(CALM ? 1 : reveal);
  reflection(cpts);

  // the arena: everything on the curve is clipped to it
  ctx.save();
  ctx.beginPath(); ctx.rect(L.x0 - 18, L.y0 - 14, L.x1 - L.x0 + 36, L.y1 - L.y0 + 28); ctx.clip();
  curve(cpts, CALM ? reveal : 1);
  dots(st === 'local' ? seg(e, 0.2 * b, 0.8 * b) : 1, now);

  const P = C.cyan, V = C.violet, K = C.amber;
  let bits = null;
  if (st === 'local') {
    hashing(e);
    if (e > 0.78 * b) mark(plan.a, P, 'P', { ring: seg(e, 0.78 * b, 1.2 * b), alpha: CALM ? seg(e, 0.6 * b, 0.95 * b) : 1 });
  } else {
    const dimP = st === 'done' ? 0.35 : 0.55;
    mark(plan.a, P, 'P', { alpha: st === 'blinding' ? 0.9 : dimP });
  }

  if (!paper) {
    if (st === 'blinding') {
      const w = plan.walks.blind, s = playWalk(w, e, 0.05 * b, 1.02 * b, V);
      mark(s.acc, V, s.done ? 'B' : '', { big: true, alpha: 1, ring: s.done ? seg(e, 1.02 * b, 1.4 * b) : 0 });
      bits = ['r', w, s.bit, V, 'left'];
    }
    if (past('blinding')) mark(plan.B, V, 'B', { alpha: st === 'sending' || st === 'stamping' ? 1 : 0.5 });
    if (st === 'stamping') {
      const w = plan.walks.stamp, s = playWalk(w, e, 0.12 * b, 1.3 * b, K);
      beam(s.acc, K, e);
      mark(s.acc, K, s.done ? "B'" : '', {
        big: true, alpha: 1, pulse: s.done ? 0.5 + 0.5 * Math.sin(e * (CALM ? 0.004 : 0.008)) : 0,
      });
      bits = ['k', w, s.bit, K, 'right'];
    }
    if (past('stamping')) mark(plan.Bp, V, "B'", { alpha: st === 'returning' ? 1 : 0.5 });
    if (st === 'unblinding') {
      const w = plan.walks.unblind, s = playWalk(w, e, 0.3 * b, 1.12 * b, C.cyanHot);
      mark(s.acc, C.cyanHot, s.done ? 'S = k·P' : '', { big: true, ring: s.done ? seg(e, 1.12 * b, 1.6 * b) : 0 });
      bits = ['r⁻¹', w, s.bit, C.cyanHot, 'left'];
    }
  } else if (st === 'stamping') {
    const w = plan.walks.stamp, s = playWalk(w, e, 0.1 * b, 1.3 * b, K);
    beam(s.acc, K, e);
    mark(s.acc, K, s.done ? 'S' : '', { big: true });
    bits = ['k', w, s.bit, K, 'right'];
  } else if (st === 'unblinding') {
    const r = (e % (0.7 * b)) / (0.7 * b);
    mark(plan.S, C.cyanHot, 'S = k·P', { ring: r, pulse: 0.5 });
  }
  if (st === 'done') mark(plan.S, C.cyanHot, 'S', { pulse: 0.6 });
  ctx.restore();

  if (bits) {
    const [name, w, cur, color] = bits;
    if (L.narrow) {
      // no room beside the curve on a phone: centred above the projector
      bitsLabel(name, w, cur, W / 2, L.ringY - 24, color, 'center');
    } else {                                    // under the party that holds the scalar
      const who = bits[4] === 'right' ? L.orc : L.you;
      bitsLabel(name, w, cur, who.x, who.y + L.R * 1.45 + 30, color, 'center');
    }
  }

  // the wire, and what crosses it
  const flying = st === 'sending' || (st === 'returning' && e < 0.9 * b);
  wire(flying ? 1 : 0, paper ? 0.35 : 1);
  if (paper) {
    text('no wire · k is on this machine', W / 2, L.traceY - 8,
         { color: C.ink2, size: 9, align: 'center', alpha: 0.75 });
  }
  if (st === 'sending') packet(easeIO(seg(e, 0.04 * b, 0.94 * b)), true, V, now);
  if (st === 'returning' && e < 0.9 * b) packet(easeIO(seg(e, 0, 0.86 * b)), false, K, now, { proof: true });
  if (!paper) {
    if (st === 'returning') proofCard('checking', seg(e, 0.86 * b, 1.1 * b));
    if (st === 'unblinding') proofCard('ok', 1 - seg(e, 0.55 * b, 0.8 * b));
  }

  // the parties
  const youHot = ['local', 'blinding', 'unblinding', 'done'].includes(st) ? 1 : 0;
  const orcHot = st === 'stamping' || (st === 'returning' && e < 0.3 * b) ? 1 : 0;
  const arrived = st === 'sending' ? seg(e, 0.9 * b, 1.0 * b)
    : st === 'returning' ? seg(e, 0.84 * b, 0.9 * b) * (1 - seg(e, 1.2 * b, 1.6 * b)) : 0;
  node(L.you, { color: C.cyan, glyph: 'r', name: 'YOU', sub: paper ? '' : 'holds r', hot: youHot,
                flash: st === 'returning' ? arrived : 0, t: now });
  node(L.orc, {
    color: C.amber, glyph: 'k',
    name: paper ? 'SHEET' : 'DEMO KEY', sub: 'holds k',
    hot: orcHot, seal: st === 'stamping' ? 1 : 0, t: now, flash: st === 'sending' ? arrived : 0,
  });

  if (st === 'done') finale(e, Number(viz.dataset.len) || 16, now);
}

/* The oracle's scalar reaching in to the point it is multiplying. */
function beam(j, color, e) {
  if (!drawable(j)) return;
  const [x, y] = projJ(j), { x: ox, y: oy } = L.orc;
  const flick = CALM ? 0.4 + 0.2 * Math.sin(e * 0.004) : 0.35 + 0.35 * Math.sin(e * 0.03) ** 2;
  const g = ctx.createLinearGradient(ox, oy, x, y);
  g.addColorStop(0, rgba(color, 0.55 * flick)); g.addColorStop(1, rgba(color, 0.05));
  ctx.strokeStyle = g; ctx.lineWidth = 1;
  ctx.setLineDash([2, 5]);
  ctx.beginPath(); ctx.moveTo(ox, oy); ctx.lineTo(x, y); ctx.stroke();
  ctx.setLineDash([]);
}

/* ============================================================ lifecycle */
let raf = 0, lastDraw = 0;
function tick(now) {
  raf = 0;
  if (!pop || pop.hidden || document.hidden) return;
  // every frame at full motion; ~30 a second when calm, which is all fades need
  if (!CALM || now - lastDraw > 30) { draw(now); lastDraw = now; }
  raf = requestAnimationFrame(tick);
}
function kick() { if (!raf) raf = requestAnimationFrame(tick); }

function onStage() {
  const next = viz.dataset.stage || '';
  if (next === stageName) { kick(); return; }
  if (next === 'local' || !plan) {
    path = viz.dataset.path || 'paper';
    plan = makePlan(path === 'paper');
    slotsSent = '';
    delete viz.dataset.slots;
  }
  beat = Number(viz.dataset.beat) || 900;
  stageName = next;
  stageT0 = performance.now();
  kick();
}

if (ctx && viz && pop) {
  layout();
  new ResizeObserver(() => { layout(); slotsSent = ''; kick(); }).observe(cv);
  new MutationObserver(onStage).observe(viz, { attributes: true, attributeFilter: ['data-stage', 'data-len'] });
  new MutationObserver(kick).observe(pop, { attributes: true, attributeFilter: ['hidden'] });
  document.addEventListener('visibilitychange', kick);
}
