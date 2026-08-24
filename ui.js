/* Presentation layer for vaultless.
 *
 * Nothing in here participates in derivation. It owns the matrix backdrop, the
 * Simple/Expert switch, the passphrase meter, locally-stored account nicknames
 * and the handshake animation. app.js owns the protocol and calls in.
 *
 * The nicknames are a convenience only: they map a name you choose to the
 * account number, live in localStorage, and never reach the oracle or the hash.
 */

const $ = (id) => document.getElementById(id);
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

/* ---------------------------------------------------------------- toast */
let toastTimer = null;
export function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('on'), 2200);
}

/* --------------------------------------------------- matrix rain backdrop */
function initRain() {
  const c = $('rain');
  if (!c || reduceMotion) return;
  const ctx = c.getContext('2d');
  const GLYPHS = 'アイウエオカキクケコサシスセソ0123456789ABCDEF<>*/+=$#@&%';
  let cols = [], w = 0, h = 0, dpr = Math.min(devicePixelRatio || 1, 2);

  function size() {
    w = c.width = innerWidth * dpr;
    h = c.height = innerHeight * dpr;
    c.style.width = innerWidth + 'px';
    c.style.height = innerHeight + 'px';
    const step = 18 * dpr;
    cols = Array.from({ length: Math.ceil(w / step) }, () => ({
      y: Math.random() * -h, speed: (1.1 + Math.random() * 2.2) * dpr, step,
    }));
  }
  size();
  addEventListener('resize', size);

  let raf = null, last = 0;
  function frame(ts) {
    raf = requestAnimationFrame(frame);
    if (ts - last < 55) return;          // ~18fps: it is wallpaper, not a game
    last = ts;
    ctx.fillStyle = 'rgba(7,9,11,0.14)';
    ctx.fillRect(0, 0, w, h);
    ctx.font = `${13 * dpr}px 'IBM Plex Mono', monospace`;
    cols.forEach((col, i) => {
      const ch = GLYPHS[(Math.random() * GLYPHS.length) | 0];
      const x = i * col.step;
      ctx.fillStyle = Math.random() < 0.06 ? 'rgba(160,255,232,0.85)' : 'rgba(60,180,155,0.42)';
      ctx.fillText(ch, x, col.y);
      col.y += col.speed * 6;
      if (col.y > h && Math.random() > 0.975) col.y = Math.random() * -220 * dpr;
    });
  }
  raf = requestAnimationFrame(frame);
  // Don't burn battery in a background tab.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { cancelAnimationFrame(raf); raf = null; }
    else if (!raf) raf = requestAnimationFrame(frame);
  });
}

/* ------------------------------------------------------- simple / expert */
const MODE_KEY = 'vaultless.mode.v1';
function initMode() {
  const apply = (expert) => {
    document.body.classList.toggle('expert', expert);
    $('modeSimple').setAttribute('aria-pressed', String(!expert));
    $('modeExpert').setAttribute('aria-pressed', String(expert));
    try { localStorage.setItem(MODE_KEY, expert ? 'expert' : 'simple'); } catch { /* private mode */ }
  };
  let stored = 'simple';
  try { stored = localStorage.getItem(MODE_KEY) || 'simple'; } catch { /* private mode */ }
  apply(stored === 'expert');
  $('modeSimple').onclick = () => apply(false);
  $('modeExpert').onclick = () => { apply(true); toast('Expert mode — protocol trace enabled'); };
}

/* ------------------------------------------------------ passphrase meter */
/* A rough guide, not a security guarantee: length dominates, variety helps a
 * little, and obvious patterns are penalised so the bar cannot flatter junk. */
function scorePhrase(s) {
  if (!s) return { pct: 0, label: 'Waiting for your phrase…', tip: '', color: 'var(--ink-2)' };
  let pool = 0;
  if (/[a-z]/.test(s)) pool += 26;
  if (/[A-Z]/.test(s)) pool += 26;
  if (/[0-9]/.test(s)) pool += 10;
  if (/[^A-Za-z0-9]/.test(s)) pool += 33;
  let bits = s.length * Math.log2(pool || 1);
  const words = s.trim().split(/\s+/).filter(Boolean).length;
  if (words >= 3) bits += 8;                                  // passphrases are good
  if (/^(.)\1+$/.test(s)) bits = Math.min(bits, 12);           // aaaaaa
  if (/^(1234|abcd|qwer|password|letmein)/i.test(s)) bits = Math.min(bits, 18);
  const pct = Math.max(4, Math.min(100, Math.round((bits / 110) * 100)));
  if (bits < 34)  return { pct, label: 'Too easy to guess',  tip: 'Try three random words', color: 'var(--red)' };
  if (bits < 60)  return { pct, label: 'Getting there',      tip: 'Add another word',       color: 'var(--amber)' };
  if (bits < 85)  return { pct, label: 'Strong',             tip: 'Nice one',               color: 'var(--cyan)' };
  return              { pct, label: 'Excellent',        tip: 'Unbreakable-ish 🛡️',     color: 'var(--green)' };
}
function initStrength() {
  const input = $('passphrase'), bar = $('strengthBar'), txt = $('strengthText'), tip = $('strengthTip');
  const update = () => {
    const r = scorePhrase(input.value);
    bar.style.width = r.pct + '%';
    bar.style.background = r.color;
    txt.textContent = r.label;
    tip.textContent = r.tip;
    $('card1').classList.toggle('done', input.value.length > 0);
  };
  input.addEventListener('input', update);
  update();
}

/* -------------------------------------------------------------- accounts */
const ACC_KEY = 'vaultless.accounts.v1';
function loadAccounts() {
  try { const v = JSON.parse(localStorage.getItem(ACC_KEY) || '[]'); return Array.isArray(v) ? v : []; }
  catch { return []; }
}
function saveAccounts(list) {
  try { localStorage.setItem(ACC_KEY, JSON.stringify(list)); } catch { /* private mode */ }
}
function initAccounts() {
  const wrap = $('accountChips'), idx = $('index');
  const render = () => {
    const list = loadAccounts();
    wrap.replaceChildren();                      // textContent only: names are user input
    for (const acc of list) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'chip';
      chip.setAttribute('aria-pressed', String(String(acc.index) === idx.value));
      const name = document.createElement('span');
      name.textContent = `${acc.name} · ${acc.index}`;
      const x = document.createElement('span');
      x.className = 'x';
      x.textContent = '×';
      x.title = `Forget ${acc.name}`;
      x.onclick = (e) => {
        e.stopPropagation();
        saveAccounts(loadAccounts().filter(a => a.name !== acc.name));
        render();
        toast(`Forgot “${acc.name}”`);
      };
      chip.append(name, x);
      chip.onclick = () => { idx.value = String(acc.index); idx.dispatchEvent(new Event('input')); render(); };
      wrap.appendChild(chip);
    }
    if (!list.length) {
      const hint = document.createElement('span');
      hint.className = 'chip add';
      hint.textContent = 'No nicknames yet — save one below';
      wrap.appendChild(hint);
    }
  };
  $('addAccount').onclick = () => {
    const name = (prompt('Nickname for account number ' + idx.value + '\n(e.g. "email", "bank")') || '').trim();
    if (!name) return;
    const list = loadAccounts().filter(a => a.name !== name);
    list.push({ name: name.slice(0, 24), index: Number(idx.value) || 0 });
    list.sort((a, b) => a.index - b.index);
    saveAccounts(list);
    render();
    toast(`Saved “${name}” as number ${idx.value}`);
  };
  const bump = (d) => {
    const n = Math.max(0, (Number(idx.value) || 0) + d);
    idx.value = String(n);
    idx.dispatchEvent(new Event('input'));
    render();
  };
  $('idxUp').onclick = () => bump(1);
  $('idxDown').onclick = () => bump(-1);
  idx.addEventListener('input', () => { $('card2').classList.add('done'); render(); });
  render();
}

/* ------------------------------------------------------- handshake viz */
export function vizReset() {
  $('viz').classList.remove('on');
  $('vizLabel').textContent = '';
  for (const id of ['wireOut', 'wireIn']) $(id).classList.remove('go', 'back');
  for (const id of ['nodeYou', 'nodeOracle', 'nodeDone']) $(id).classList.remove('hot');
}
export function vizStart(label) {
  if (reduceMotion) { $('vizLabel').textContent = label; return; }
  vizReset();
  $('viz').classList.add('on');
  $('nodeYou').classList.add('hot');
  $('vizLabel').textContent = label;
  requestAnimationFrame(() => $('wireOut').classList.add('go'));
}
export function vizOracle(label) {
  $('vizLabel').textContent = label;
  if (reduceMotion) return;
  $('nodeYou').classList.remove('hot');
  $('nodeOracle').classList.add('hot');
}
export function vizReturn(label) {
  $('vizLabel').textContent = label;
  if (reduceMotion) return;
  $('wireIn').classList.add('back');
}
export function vizDone(label) {
  $('vizLabel').textContent = label;
  if (reduceMotion) return;
  $('nodeOracle').classList.remove('hot');
  $('nodeDone').classList.add('hot');
  setTimeout(() => {
    $('viz').classList.remove('on');
    $('vizLabel').textContent = '';   // don't leave the caption orphaned
  }, 1600);
}

/* --------------------------------------------------------- result chrome */
export function setDemo(isDemo) {
  $('demoBadge').classList.toggle('on', isDemo);
}
export function markResultFilled(filled) {
  $('resultCard').classList.toggle('empty', !filled);
  $('card4').classList.toggle('done', filled);
}
function initReveal() {
  const pw = $('pwOut'), btn = $('revealBtn');
  btn.onclick = () => {
    const hidden = pw.classList.toggle('hidden-pw');
    btn.textContent = hidden ? 'Reveal' : 'Hide';
  };
}

/* -------------------------------------------------------------- keyboard */
function initFormatKeys() {
  document.querySelectorAll('.fmt-opt').forEach((el) => {
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); el.click(); }
    });
  });
}


/* Exclusive reveal: picking one branch of a setup fork closes the other, so a
 * step never shows two half-finished paths at once. */
export function pickFork(panels, chosen) {
  for (const [id, panelId] of Object.entries(panels)) {
    const on = id === chosen;
    $(id).setAttribute('aria-pressed', String(on));
    $(panelId).hidden = !on;
  }
}

export function setReady(text, ready) {
  const el = $('oracleReady');
  if (!el) return;
  el.textContent = text;
  el.classList.toggle('ready', !!ready);
}

/* ------------------------------------------------------------------- nav */
/* Two front doors. The choice decides which oracle's controls exist at all,
 * so neither path is ever shown the other one's buttons to guess at. Kept in
 * the URL so a route can be bookmarked, and remembered so a returning user
 * lands where they left off — Home is always one click away in the header. */
const ORACLE_KEY = 'vaultless.oracle.choice.v1';
let oracleChoice = null;

export function getOracleChoice() { return oracleChoice; }

function applyRoute(choice, { push = true } = {}) {
  oracleChoice = choice;
  const inApp = choice === 'gadget' || choice === 'paper';
  document.body.classList.toggle('in-app', inApp);
  document.body.classList.toggle('oracle-gadget', choice === 'gadget');
  document.body.classList.toggle('oracle-paper', choice === 'paper');
  $('viewHome').hidden = inApp;
  $('viewApp').hidden = !inApp;
  if (inApp) {
    try { localStorage.setItem(ORACLE_KEY, choice); } catch { /* private mode */ }
  } else {
    try { localStorage.removeItem(ORACLE_KEY); } catch { /* private mode */ }
  }
  // Each module owns its own bit of chrome; tell them the route moved rather
  // than reaching across into their state from here.
  document.dispatchEvent(new CustomEvent('oraclechange', { detail: { choice } }));
  const hash = inApp ? `#${choice}` : '';
  if (push && location.hash !== hash) history.pushState({ choice }, '', hash || location.pathname);
  scrollTo({ top: 0, behavior: 'auto' });
}

function routeFromHash() {
  const h = location.hash.replace('#', '');
  return (h === 'gadget' || h === 'paper') ? h : null;
}

function initGadgetFork() {
  const panels = { forkFlash: 'panelFlash', forkReady: 'panelConnect' };
  $('forkFlash').onclick = () => pickFork(panels, 'forkFlash');
  $('forkReady').onclick = () => pickFork(panels, 'forkReady');
}

function initNav() {
  let start = routeFromHash();
  if (!start) {
    try { start = localStorage.getItem(ORACLE_KEY); } catch { /* private mode */ }
    if (start !== 'gadget' && start !== 'paper') start = null;
  }
  applyRoute(start, { push: false });

  $('chooseGadget').onclick = () => applyRoute('gadget');
  $('choosePaper').onclick = () => applyRoute('paper');
  $('chooseDemo').onclick = () => {
    applyRoute('paper');
    toast('Type a phrase, then press “Try the demo” at step 4');
  };
  $('homeBtn').onclick = () => applyRoute(null);
  addEventListener('popstate', () => applyRoute(routeFromHash(), { push: false }));
}

export function initChrome() {
  initNav();
  initGadgetFork();
  initRain();
  initMode();
  initStrength();
  initAccounts();
  initReveal();
  initFormatKeys();
}
