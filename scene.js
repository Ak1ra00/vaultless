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
 *   - The only application state it reads is the `handshaking` class on
 *     <body>, which says a derivation is in progress and nothing else. No
 *     phrase, point, key or password is reachable from here. The curve maths
 *     below is a toy over ℝ and 𝔽₂₁₁ and shares nothing with the ristretto255
 *     group derivation actually uses.
 *   - Reduced motion: every scene draws a still frame and never moves on its
 *     own. Dragging still works; that motion is the user's.
 *   - Nothing animates off-screen or in a hidden tab.
 */

const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const $ = (id) => document.getElementById(id);
const TAU = Math.PI * 2;

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

function fit(c, maxDpr) {
  const dpr = Math.min(window.devicePixelRatio || 1, maxDpr);
  const w = Math.max(1, Math.round(c.clientWidth * dpr));
  const h = Math.max(1, Math.round(c.clientHeight * dpr));
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
function label(ctx, text, x, y, col, px, alpha = 1, align = 'left', weight = 600) {
  ctx.font = `${weight} ${px}px ${MONO}`;
  ctx.textAlign = align;
  ctx.textBaseline = 'middle';
  ctx.fillStyle = rgba(col, alpha);
  ctx.fillText(text, x, y);
}
const fmt = (v, d = 2) => (v < 0 ? '−' : '') + Math.abs(v).toFixed(d);

/* ========================================================= the backdrop */

/* The group E(𝔽₂₁₁) as a ring, ordered by scalar: the i-th point round the
 * ring is (i+1)·G. Its radius and height come from that point's coordinates.
 * So neighbours on the ring — k·G and (k+1)·G — land nowhere near each other,
 * and the line joining them in order zig-zags with no pattern at all. That
 * scatter is the discrete-log problem, and it is the reason the oracle can
 * hand back k·B without anyone recovering k. */
function initField() {
  const c = $('field');
  if (!c || !c.getContext) return;
  const ctx = c.getContext('2d');
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

  let yaw = 0.6, mx = 0, my = 0, tmx = 0, tmy = 0, surge = 0, cursor = 0;
  let raf = 0, lastT = 0, lastDraw = 0, lastMove = 0;

  function draw(now, dt) {
    const dpr = fit(c, 1.5);
    const W = c.width, H = c.height;
    ctx.clearRect(0, 0, W, H);

    const want = document.body.classList.contains('handshaking') ? 1 : 0;
    surge += (want - surge) * Math.min(1, dt * 3);
    if (!reduceMotion) {
      yaw += dt * (0.035 + surge * 0.3);
      mx += (tmx - mx) * Math.min(1, dt * 2.5);
      my += (tmy - my) * Math.min(1, dt * 2.5);
      cursor += dt * (6 + surge * 60);
    }
    const scroll = reduceMotion ? 0 : window.scrollY;
    const y0 = yaw + scroll * 0.0006 + mx * 0.22;
    const p0 = 0.3 + my * 0.07 + (reduceMotion ? 0 : Math.min(0.12, scroll * 0.00008));
    const dist = 3.4;
    const cam = { dist, f: Math.max(W, H * 0.62) * 1.26, cx: W * 0.5, cy: H * 0.52 };

    const P = ring.map((v) => proj(view(v, y0, p0), cam));
    const near = (z) => clamp((dist + 1.3 - z) / 2.6, 0, 1);

    // the walk, in scalar order — the zig-zag nothing can shortcut
    const bucket = [[], [], []];
    for (let i = 0; i < P.length; i++) {
      const a = P[i], b = P[(i + 1) % P.length];
      const n = near((a[3] + b[3]) / 2);
      bucket[n > 0.66 ? 2 : n > 0.33 ? 1 : 0].push(a, b);
    }
    [0.035, 0.07, 0.12].forEach((al, i) => {
      ctx.beginPath();
      for (let j = 0; j < bucket[i].length; j += 2) {
        ctx.moveTo(bucket[i][j][0], bucket[i][j][1]);
        ctx.lineTo(bucket[i][j + 1][0], bucket[i][j + 1][1]);
      }
      ctx.strokeStyle = rgba(C.violet, al * (1 + surge));
      ctx.lineWidth = dpr;
      ctx.stroke();
    });

    // the points
    const head = Math.floor(cursor) % P.length;
    for (let i = 0; i < P.length; i++) {
      const [x, y, , z] = P[i];
      const n = near(z);
      const behind = (head - i + P.length) % P.length;      // 0 = the cursor itself
      const lit = !reduceMotion && behind < 14 ? (1 - behind / 14) * (0.35 + surge * 0.65) : 0;
      const r = (0.9 + 1.5 * n + lit * 2.2) * dpr;
      ctx.fillStyle = rgba(lit > 0.02 ? C.hot : C.cyan, 0.1 * (0.4 + n) + lit * 0.18);
      ctx.beginPath(); ctx.arc(x, y, r * 3.2, 0, TAU); ctx.fill();
      ctx.fillStyle = rgba(lit > 0.02 ? C.hot : C.cyan, 0.22 + 0.5 * n + lit * 0.4);
      ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); ctx.fill();
    }

    // the formulas, drifting in depth
    for (const L of LABELS) {
      const [x, y, , z] = proj(view(L.p, y0 * 0.8, p0), cam);
      const n = near(z);
      label(ctx, L.text, x, y, n > 0.5 ? C.ink1 : C.ink, (8.5 + 4 * n) * dpr,
            0.06 + 0.16 * n + surge * 0.08, 'center', 500);
    }
    lastDraw = now;
  }

  function loop(t) {
    raf = 0;
    const dt = Math.min(0.1, (t - lastT) / 1000 || 0);
    lastT = t;
    // ~30fps at rest, full rate while the oracle works or the pointer moves
    const busy = surge > 0.05 || document.body.classList.contains('handshaking') || t - lastMove < 1500;
    if (busy || t - lastDraw > 32) draw(t, dt);
    if (!reduceMotion && !document.hidden) raf = requestAnimationFrame(loop);
  }
  function kick() {
    if (raf || document.hidden) return;
    if (reduceMotion) { draw(performance.now(), 0); return; }
    lastT = performance.now();
    raf = requestAnimationFrame(loop);
  }
  addEventListener('pointermove', (e) => {
    if (e.pointerType === 'touch') return;
    tmx = (e.clientX / innerWidth - 0.5) * 2;
    tmy = (e.clientY / innerHeight - 0.5) * 2;
    lastMove = performance.now();
  }, { passive: true });
  addEventListener('resize', () => { if (reduceMotion) kick(); });
  document.addEventListener('visibilitychange', kick);
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => { if (reduceMotion) kick(); });
  // reduced motion still has to answer the handshake — with one still frame
  new MutationObserver(() => { if (reduceMotion) { surge = document.body.classList.contains('handshaking') ? 1 : 0; kick(); } })
    .observe(document.body, { attributes: true, attributeFilter: ['class'] });
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
    if (!reduceMotion && !st.grab && t - st.lastUser > 3.5) {
      st.xQ = 1.26 + 0.69 * Math.sin(t * 0.42);   // Q.x in [0.57, 1.95]
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
    id: 'group', touchAction: 'none',
    title: 'E : y² = x³ − 3x + 5', sub: 'over ℝ',
    noteHead: 'group law',
    noteBody: 'the chord through P and Q meets E again at −R; reflect it to get P + Q = R. k·P is this, repeated — the oracle’s whole job.',
    badge: 'VAULTLESS · E/ℝ · SHEET 01', hint: 'drag P or Q along the curve',
    draw, readout,
    busy: () => !reduceMotion || !!st.grab,
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
    P: [17, 15], walk: walkFrom([17, 15], STEPS), grow: reduceMotion ? STEPS - 1 : 0,
    hold: 0, fade: 1, yaw: -0.42, pitch: 0.92, vyaw: 0, drag: null, lastUser: -1e9, hover: -1,
  };
  let cam = null, shown = [];
  const to3 = (x, y, h = 0) => [(x / (FP - 1)) * 2 - 1, h, (y / (FP - 1)) * 2 - 1];

  function restart(P) { st.P = P; st.walk = walkFrom(P, STEPS); st.grow = reduceMotion ? STEPS - 1 : 0; st.hold = 0; st.fade = 1; }

  function draw(ctx, W, H, dpr, t, dt) {
    if (!reduceMotion) {
      if (!st.drag) {
        st.yaw += st.vyaw * dt;
        st.vyaw *= Math.pow(0.04, dt);
        if (t - st.lastUser > 2.5) st.yaw += dt * 0.1;
      }
      if (st.grow < STEPS - 1) st.grow = Math.min(STEPS - 1, st.grow + dt * 1.5);
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
    for (let i = 0; i < shown.length; i++) {
      const [x, y, k] = shown[i];
      const r = Math.max(1.1, k / cam.f * 5.6) * dpr * (i === st.hover ? 2 : 1);
      ctx.fillStyle = rgba(C.cyan, 0.13); ctx.beginPath(); ctx.arc(x, y, r * 3.2, 0, TAU); ctx.fill();
      ctx.fillStyle = rgba(i === st.hover ? C.hot : C.cyan, 0.9); ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); ctx.fill();
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
    busy: () => !reduceMotion || !!st.drag,
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
    tp: reduceMotion ? STEPS : 0, hold: 0, fade: 1, hover: -1,
  };
  let cam = null, lat = null, nodesT = [], nodesL = [];
  const pos = (u, v) => { const th = TAU * u, ph = TAU * v, q = R + r * Math.cos(ph); return [q * Math.cos(th), r * Math.sin(ph), q * Math.sin(th)]; };
  const nrm = (u, v) => { const th = TAU * u, ph = TAU * v; return [Math.cos(ph) * Math.cos(th), Math.sin(ph), Math.cos(ph) * Math.sin(th)]; };
  const at = (t) => [fract(t * Z[0]), fract(t * Z[1])];

  function draw(ctx, W, H, dpr, t, dt) {
    if (!reduceMotion) {
      if (!st.drag) {
        st.yaw += st.vyaw * dt;
        st.vyaw *= Math.pow(0.04, dt);
        if (t - st.lastUser > 2.5) st.yaw += dt * 0.16;
      }
      if (st.tp < STEPS) st.tp = Math.min(STEPS, st.tp + dt * 1.25);
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
    const loop = (fn, name) => {
      let prev = null, best = null;
      for (let i = 0; i <= 90; i++) {
        const [u, v] = fn(i / 90);
        const p = V(pos(u, v)), s = proj(p, cam), fc = facing(p, V(nrm(u, v)), cam.dist);
        if (prev) {
          ctx.beginPath(); ctx.moveTo(prev[0], prev[1]); ctx.lineTo(s[0], s[1]);
          ctx.strokeStyle = rgba(C.amber, fc > 0 ? 0.85 : 0.2); ctx.lineWidth = 1.6 * dpr; ctx.stroke();
        }
        if (!best || fc > best[2]) best = [s[0], s[1], fc];
        prev = s;
      }
      loopLabels.push([name, best[0] + 8 * dpr, best[1] - 10 * dpr]);
    };
    const loopLabels = [];
    loop((s) => [s, 0], 'ω₁');
    loop((s) => [0, s], 'ω₂');

    // k·z mod Λ, wound round the torus
    const f = st.fade;
    const samples = Math.ceil(st.tp * 70);
    let prev = null;
    for (let i = 0; i <= samples; i++) {
      const tt = (i / Math.max(1, samples)) * st.tp;
      const [u, v] = at(tt);
      const p = V(pos(u, v)), s = proj(p, cam), fc = facing(p, V(nrm(u, v)), cam.dist);
      if (prev) {
        ctx.beginPath(); ctx.moveTo(prev[0], prev[1]); ctx.lineTo(s[0], s[1]);
        if (fc > 0) { ctx.strokeStyle = rgba(C.violet, 0.2 * f); ctx.lineWidth = 5 * dpr; ctx.stroke(); }
        ctx.strokeStyle = rgba(C.violet, (fc > 0 ? 0.9 : 0.22) * f); ctx.lineWidth = 1.4 * dpr; ctx.stroke();
      }
      prev = s;
    }
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
    busy: () => !reduceMotion || !!st.drag,
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

/* ======================================================= the viewer */

function initSheets() {
  const fig = $('sheets'), c = $('sceneCanvas');
  if (!fig || !c || !c.getContext) return;
  const ctx = c.getContext('2d');
  const scenes = { group: groupLaw(), field: finiteField(), torus: torus() };
  const ui = {
    title: $('sheetTitle'), sub: $('sheetSub'), head: $('sheetNoteHead'), body: $('sheetNoteBody'),
    badge: $('sheetBadge'), hint: $('sheetHint'), readout: $('sheetReadout'),
  };
  const tabs = [...fig.querySelectorAll('[role="tab"]')];
  let cur = null, visible = false, raf = 0, lastT = 0, lastDraw = 0, interacting = false, lastRead = '';
  let dpr = 1;

  function select(id, focus = false) {
    cur = scenes[id];
    for (const tb of tabs) {
      const on = tb.dataset.scene === id;
      tb.setAttribute('aria-selected', String(on));
      tb.tabIndex = on ? 0 : -1;
      if (on && focus) tb.focus();
    }
    ui.title.textContent = cur.title;
    ui.sub.textContent = cur.sub;
    ui.head.textContent = cur.noteHead;
    ui.body.textContent = cur.noteBody;
    ui.badge.textContent = cur.badge;
    ui.hint.textContent = cur.hint;
    c.style.touchAction = cur.touchAction;
    c.dataset.scene = id;
    if (cur.data) for (const [k, v] of Object.entries(cur.data)) c.dataset[k] = String(v);
    fig.classList.remove('switching'); void fig.offsetWidth; fig.classList.add('switching');
    kick(true);
  }

  function frame(t) {
    raf = 0;
    const dt = Math.min(0.1, (t - lastT) / 1000 || 0);
    lastT = t;
    // ~40fps while it idles, full rate while someone has hold of it
    if (interacting || t - lastDraw > 24 || dt === 0) {
      dpr = fit(c, 2);
      ctx.clearRect(0, 0, c.width, c.height);
      cur.draw(ctx, c.width, c.height, dpr, t / 1000, dt);
      const text = cur.readout();
      if (text !== lastRead) { ui.readout.textContent = text; lastRead = text; }
      lastDraw = t;
    }
    if (visible && !document.hidden && cur.busy()) raf = requestAnimationFrame(frame);
  }
  function kick(now = false) {
    if (raf || document.hidden || !cur) return;
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

  tabs.forEach((tb, i) => {
    tb.addEventListener('click', () => select(tb.dataset.scene));
    tb.addEventListener('keydown', (e) => {
      const d = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
      if (!d) return;
      e.preventDefault();
      select(tabs[(i + d + tabs.length) % tabs.length].dataset.scene, true);
    });
  });

  new IntersectionObserver(([en]) => { visible = en.isIntersecting; kick(); }).observe(fig);
  new ResizeObserver(() => kick(true)).observe(c);
  document.addEventListener('visibilitychange', () => kick());
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => kick(true));

  select(fig.dataset.start || 'torus');
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
