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
  toastTimer = setTimeout(() => t.classList.remove('on'), 3600);
}

/* ------------------------------------------------------------- dialogs */
/* One in-page dialog, used both for asking a question and for confirming.
 *
 * The pin mismatch is the most security-critical decision in the product and it
 * used to be a native confirm(): unstyleable, suppressible by the browser after
 * a couple of dialogs, and exactly the kind of box people dismiss without
 * reading. <dialog> gives a real focus trap and Escape handling for free, and
 * lets the safe answer be the default — Cancel takes focus, and anything other
 * than a deliberate press of the confirm button counts as a refusal.
 *
 * No form element and no method="dialog": this page runs under form-action
 * 'none', and a plain button that calls close() cannot be caught by it. */
function ask({ title, lines = [], confirmLabel = 'OK', cancelLabel = 'Cancel',
               danger = false, input = null }) {
  const dlg = $('ask');
  const wantsInput = !!input;

  // Nothing modern lacks <dialog>, but a security prompt must never simply
  // vanish, so fall back to the platform boxes rather than to nothing.
  if (!dlg || typeof dlg.showModal !== 'function') {
    if (wantsInput) {
      const v = prompt([title, ...lines].join('\n'), input.value || '');
      return Promise.resolve(v === null ? null : v.trim());
    }
    return Promise.resolve(confirm([title, ...lines].join('\n\n')));
  }

  $('askTitle').textContent = title;
  const body = $('askBody');
  body.replaceChildren();      // textContent only: these lines carry key material
  for (const line of lines) {
    const p = document.createElement('p');
    p.textContent = line;
    body.appendChild(p);
  }

  const field = $('askInput'), label = $('askLabel');
  field.hidden = label.hidden = !wantsInput;
  if (wantsInput) {
    label.textContent = input.label || '';
    field.placeholder = input.placeholder || '';
    field.value = input.value || '';
  }

  const ok = $('askOk'), cancel = $('askCancel');
  ok.textContent = confirmLabel;
  cancel.textContent = cancelLabel;
  ok.classList.toggle('danger', danger);

  return new Promise((resolve) => {
    let value = null;
    const done = (v) => { value = v; dlg.close(); };
    ok.onclick = () => done(wantsInput ? field.value.trim() : true);
    cancel.onclick = () => done(wantsInput ? null : false);
    field.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); ok.click(); } };
    dlg.addEventListener('close', () => {
      ok.onclick = cancel.onclick = field.onkeydown = null;
      field.value = '';                       // never leave typed text sitting there
      resolve(!wantsInput && value === null ? false : value);
    }, { once: true });
    dlg.showModal();
    (wantsInput ? field : cancel).focus();    // the safe answer is the default
  });
}

/* Resolves true only on a deliberate confirm; Escape, Cancel and a dismissed
 * dialog all resolve false. */
export function confirmDialog(opts) {
  return ask({ confirmLabel: 'Continue', ...opts });
}
/* Resolves the trimmed string, or null if the person backed out. */
export function promptDialog(opts) {
  return ask({ confirmLabel: 'Save', ...opts, input: opts.input || {} });
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

  let raf = null, last = 0, surge = 0;
  function frame(ts) {
    raf = requestAnimationFrame(frame);
    /* The rain answers the handshake. While the oracle is working the whole
     * backdrop quickens and brightens, so the page is visibly doing the thing
     * rather than leaving one panel to mime it. Eased in and out, because a
     * step change reads as a glitch. */
    const want = document.body.classList.contains('handshaking') ? 1 : 0;
    surge += (want - surge) * 0.045;
    if (ts - last < 55 - surge * 26) return;   // ~18fps at rest, ~34fps mid-handshake
    last = ts;
    ctx.fillStyle = `rgba(7,9,11,${0.14 - surge * 0.035})`;
    ctx.fillRect(0, 0, w, h);
    ctx.font = `${13 * dpr}px 'IBM Plex Mono', monospace`;
    const bright = 0.42 + surge * 0.3;
    cols.forEach((col, i) => {
      const ch = GLYPHS[(Math.random() * GLYPHS.length) | 0];
      const x = i * col.step;
      ctx.fillStyle = Math.random() < 0.06 + surge * 0.07
        ? `rgba(160,255,232,${0.85 + surge * 0.15})`
        : `rgba(60,180,155,${bright})`;
      ctx.fillText(ch, x, col.y);
      col.y += col.speed * (6 + surge * 5);
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
  $('addAccount').onclick = async () => {
    /* Refuse to bind a nickname to a number the field does not actually hold.
     * `Number(idx.value) || 0` used to turn anything unparseable into account
     * 0, so a mistyped number quietly saved a nickname pointing at the wrong
     * account — and pressing that chip later derived the wrong password. */
    const raw = idx.value.trim();
    if (!/^\d+$/.test(raw)) {
      toast('Set a whole account number first, 0 or more.');
      idx.focus();
      return;
    }
    const name = await promptDialog({
      title: `Nickname for account number ${raw}`,
      lines: ['Stays on this device. It never reaches the oracle and never ' +
              'changes the password — it is only a label for the number.'],
      input: { label: 'Nickname', placeholder: 'email, bank, work…' },
    });
    if (!name) return;
    const list = loadAccounts().filter(a => a.name !== name);
    list.push({ name: name.slice(0, 24), index: Number(raw) });
    list.sort((a, b) => a.index - b.index);
    saveAccounts(list);
    render();
    toast(`Saved “${name}” as number ${raw}`);
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
/* The signature element: the OPRF round trip, played out with the real bytes.
 *
 * The old version was two emoji and a dot sliding along a wire — which said
 * "something is happening" and nothing else. The whole claim of this project is
 * that your phrase is DISGUISED before the oracle sees it and undisguised
 * afterwards, and that is a thing you can actually watch happen if the values
 * are on screen: P settles, churns into B, travels, comes back changed, and
 * resolves to S. Same bytes the trace logs, same bytes the maths uses.
 *
 * Every duration is a multiple of BEAT, so the whole choreography retimes from
 * one number. app.js paces the awaits between stages to match. */
export const BEAT = 900;

const HEXCHARS = '0123456789abcdef';
const HEX_LEN = 64;

let scrambleRaf = null;

/* Settle text left-to-right out of churning hex.
 *
 * Unsettled characters keep rolling, so the readout reads as a value being
 * computed rather than a string being typed. Resolves when it has landed. */
function settleHex(el, target, ms) {
  cancelAnimationFrame(scrambleRaf);
  const text = String(target || '').slice(0, HEX_LEN).padEnd(HEX_LEN, '·');
  if (reduceMotion) { el.textContent = text; return Promise.resolve(); }

  return new Promise((resolve) => {
    const t0 = performance.now();
    const step = (now) => {
      const p = Math.min(1, (now - t0) / ms);
      // Ease the settle front so the last characters land unhurriedly.
      const landed = Math.floor(text.length * (1 - Math.pow(1 - p, 2.2)));
      let out = text.slice(0, landed);
      for (let i = landed; i < text.length; i++) {
        out += HEXCHARS[(Math.random() * 16) | 0];
      }
      el.textContent = out;
      if (p < 1) { scrambleRaf = requestAnimationFrame(step); }
      else { el.textContent = text; resolve(); }
    };
    scrambleRaf = requestAnimationFrame(step);
  });
}

/* Churn without settling — used while the oracle is working and the browser
 * genuinely does not know the answer yet. */
function churnHex(el, ms) {
  cancelAnimationFrame(scrambleRaf);
  if (reduceMotion) return Promise.resolve();
  return new Promise((resolve) => {
    const t0 = performance.now();
    const step = (now) => {
      let out = '';
      for (let i = 0; i < HEX_LEN; i++) out += HEXCHARS[(Math.random() * 16) | 0];
      el.textContent = out;
      if (now - t0 < ms) scrambleRaf = requestAnimationFrame(step);
      else resolve();
    };
    scrambleRaf = requestAnimationFrame(step);
  });
}

/* Which party is doing the work at each stage. Drives the lift-and-glow, so
 * attention follows the value rather than sitting on both boxes at once. */
const HOT_AT = {
  local: ['partyYou'], blinding: ['partyYou'], sending: [],
  stamping: ['partyOracle'], returning: ['partyOracle'],
  unblinding: ['partyYou'], done: ['partyYou'],
};

function stage(name) {
  const v = $('viz');
  v.dataset.stage = name || '';
  const hot = HOT_AT[name] || [];
  for (const id of ['partyYou', 'partyOracle']) {
    $(id).classList.toggle('hot', hot.includes(id));
  }
}

function setReadout(tag, hex, { churn = false, ms = BEAT * 0.8 } = {}) {
  $('vizTag').textContent = tag;
  const el = $('vizHex');
  return churn ? churnHex(el, ms) : settleHex(el, hex, ms);
}

export function vizReset() {
  cancelAnimationFrame(scrambleRaf);
  const v = $('viz');
  v.classList.remove('on');
  delete v.dataset.stage;
  $('vizLabel').textContent = '';
  $('vizHex').textContent = '';
  $('vizTag').textContent = '';
  for (const id of ['partyYou', 'partyOracle']) $(id).classList.remove('hot');
  document.body.classList.remove('handshaking');
}

/* Opens the stage and shows the point the phrase hashed to. */
export function vizStart(label, hex) {
  vizReset();
  $('viz').classList.add('on');
  $('vizLabel').textContent = label;
  // The backdrop answers the handshake: the rain surges while the oracle works,
  // so the whole page is visibly doing the thing, not just this one panel.
  document.body.classList.add('handshaking');
  stage('local');
  return setReadout('P', hex, { ms: BEAT });
}

/* The blinding step — the reason the oracle learns nothing. */
export function vizBlind(label, hex) {
  $('vizLabel').textContent = label;
  stage('blinding');
  return setReadout('B = r·P', hex, { ms: BEAT * 1.1 });
}

/* Hand it over: the packet crosses the channel. */
export function vizSend(label) {
  $('vizLabel').textContent = label;
  stage('sending');
  return new Promise(r => setTimeout(r, reduceMotion ? 0 : BEAT));
}

/* The oracle is working and we genuinely do not know the answer yet. */
export function vizOracle(label) {
  $('vizLabel').textContent = label;
  stage('stamping');
  $('vizTag').textContent = 'k · B';
  /* Churns until the next stage cancels it, rather than for a fixed time: a
   * hardware oracle takes as long as it takes, and a readout that froze
   * mid-scramble while the device was still thinking would be a lie. The
   * returned promise is a MINIMUM dwell, so the fast paths still read. */
  churnHex($('vizHex'), 120000);
  return new Promise(r => setTimeout(r, reduceMotion ? 0 : BEAT * 1.4));
}

/* Stamped, coming back. */
export function vizReturn(label, hex) {
  $('vizLabel').textContent = label;
  stage('returning');
  return new Promise(r => setTimeout(r, reduceMotion ? 0 : BEAT * 0.9))
    .then(() => setReadout("B' = k·B", hex, { ms: BEAT }));
}

/* Take the disguise off. */
export function vizUnblind(label, hex) {
  $('vizLabel').textContent = label;
  stage('unblinding');
  return setReadout('S = r⁻¹·B\'', hex, { ms: BEAT * 1.2 });
}

export function vizDone(label) {
  $('vizLabel').textContent = label;
  stage('done');
  document.body.classList.remove('handshaking');
  if (reduceMotion) return;
  setTimeout(() => {
    $('viz').classList.remove('on');
    $('vizLabel').textContent = '';   // don't leave the caption orphaned
  }, BEAT * 3);
}

/* The password lands rather than appears.
 *
 * It is derived, not looked up, and watching each character settle out of a
 * churn says that better than any copy could. Left-to-right, easing out, so the
 * last few characters take their time. */
const PW_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz0123456789!@#$%^&*-_=+';
let pwRaf = null;

export function revealPassword(el, pw) {
  cancelAnimationFrame(pwRaf);
  if (reduceMotion) { el.textContent = pw; return; }
  const ms = BEAT * 1.8;
  const t0 = performance.now();
  const step = (now) => {
    const p = Math.min(1, (now - t0) / ms);
    const landed = Math.floor(pw.length * (1 - Math.pow(1 - p, 2.4)));
    let out = pw.slice(0, landed);
    for (let i = landed; i < pw.length; i++) {
      out += PW_CHARS[(Math.random() * PW_CHARS.length) | 0];
    }
    el.textContent = out;
    if (p < 1) pwRaf = requestAnimationFrame(step);
    else el.textContent = pw;
  };
  pwRaf = requestAnimationFrame(step);
}

/* --------------------------------------------------------- result chrome */
export function setDemo(isDemo) {
  $('demoBadge').classList.toggle('on', isDemo);
}
export function markResultFilled(filled) {
  $('resultCard').classList.toggle('empty', !filled);
  $('card4').classList.toggle('done', filled);
}
/* Put the result card back to empty and forget the phrase.
 *
 * The paper key gets a five-minute idle wipe, but the password it produced used
 * to sit on screen indefinitely and the phrase stayed in its input — so the one
 * secret with a lifetime was the one the user could not read off the glass.
 * Called whenever an oracle goes away: forgotten, idled out, or disconnected. */
export function clearResult() {
  const pw = $('pwOut');
  pw.textContent = '';
  pw.style.display = 'none';
  pw.classList.remove('reveal', 'hidden-pw');
  $('pwPlaceholder').style.display = '';
  $('copyBtn').disabled = true;
  const reveal = $('revealBtn');
  reveal.disabled = true;
  reveal.textContent = 'Reveal';
  $('resSource').textContent = 'source: —';
  $('passphrase').value = '';
  $('passphrase').dispatchEvent(new Event('input'));   // reset the strength meter
  setDemo(false);
  markResultFilled(false);
}

function initReveal() {
  const pw = $('pwOut'), btn = $('revealBtn');
  btn.onclick = () => {
    const hidden = pw.classList.toggle('hidden-pw');
    btn.textContent = hidden ? 'Reveal' : 'Hide';
  };
}

/* -------------------------------------------------------------- keyboard */
/* ARIA radiogroup semantics, which the markup was claiming but not providing.
 *
 * All four options carried tabindex="0" and only answered Enter and Space, so
 * Tab walked through every one and the arrow keys did nothing — the widget
 * announced itself as a radiogroup and then behaved like four buttons. Roving
 * tabindex puts exactly the checked option in the tab order; the arrows move
 * selection, as they do in every other radiogroup. */
function initFormatKeys() {
  const opts = [...document.querySelectorAll('.fmt-opt')];
  if (!opts.length) return;

  const syncTabIndex = () => {
    let checked = opts.find(o => o.getAttribute('aria-checked') === 'true');
    if (!checked) checked = opts[0];
    opts.forEach(o => { o.tabIndex = o === checked ? 0 : -1; });
  };

  // app.js owns which format is selected; clicking keeps that one source of truth.
  const select = (el) => { el.click(); syncTabIndex(); el.focus(); };
  const step = (from, delta) =>
    select(opts[(opts.indexOf(from) + delta + opts.length) % opts.length]);

  opts.forEach((el) => {
    el.addEventListener('click', syncTabIndex);
    el.addEventListener('keydown', (e) => {
      switch (e.key) {
        case 'Enter': case ' ':
          e.preventDefault(); el.click(); syncTabIndex(); break;
        case 'ArrowRight': case 'ArrowDown':
          e.preventDefault(); step(el, 1); break;
        case 'ArrowLeft': case 'ArrowUp':
          e.preventDefault(); step(el, -1); break;
        case 'Home':
          e.preventDefault(); select(opts[0]); break;
        case 'End':
          e.preventDefault(); select(opts[opts.length - 1]); break;
        default: break;
      }
    });
  });
  syncTabIndex();
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

/* ------------------------------------------------------------------- nav */
/* Two front doors. The choice decides which oracle's controls exist at all,
 * so neither path is ever shown the other one's buttons to guess at. Kept in
 * the URL so a route can be bookmarked, and remembered so a returning user
 * lands where they left off — Home is always one click away in the header. */
const ORACLE_KEY = 'vaultless.oracle.choice.v1';
let oracleChoice = null;

export function getOracleChoice() { return oracleChoice; }

/* Choosing an oracle no longer jumps into the app — it opens step 2 on the home
 * page, because setting the oracle up IS the next step. The app view is where
 * you go once it is actually ready. */
function setOracle(choice, { remember = true } = {}) {
  oracleChoice = choice;
  document.body.classList.toggle('oracle-hw', choice === 'hardware');
  document.body.classList.toggle('oracle-paper', choice === 'paper');
  $('chooseHardware').setAttribute('aria-pressed', String(choice === 'hardware'));
  $('choosePaper').setAttribute('aria-pressed', String(choice === 'paper'));
  $('homeStep1').classList.toggle('done', !!choice);
  $('homeStep2').hidden = !choice;
  $('continueRow').hidden = !choice;
  if (remember && choice) {
    try { localStorage.setItem(ORACLE_KEY, choice); } catch { /* private mode */ }
  }
  document.dispatchEvent(new CustomEvent('oraclechange', { detail: { choice } }));
}

function setView(inApp, { push = true } = {}) {
  document.body.classList.toggle('in-app', inApp);
  $('viewHome').hidden = inApp;
  $('viewApp').hidden = !inApp;
  const hash = inApp && oracleChoice ? `#${oracleChoice}` : '';
  if (push && location.hash !== hash) {
    history.pushState({ inApp }, '', hash || location.pathname);
  }
  scrollTo({ top: 0, behavior: 'auto' });
  /* Move focus into the view that just appeared. Without this a keyboard user
   * who presses "Continue to my password" is left focused on a button inside a
   * now-hidden subtree, focus falls back to <body>, and the next Tab restarts
   * from the top of the document. Only on a real navigation — stealing focus on
   * first load would be its own bug. */
  if (push) {
    const heading = (inApp ? $('viewApp') : $('viewHome')).querySelector('h2, h3');
    if (heading) {
      heading.tabIndex = -1;
      heading.focus({ preventScroll: true });
    }
  }
  /* Leaving a view has to be able to tear things down — the camera above all,
   * which otherwise keeps running behind a hidden <video> with the machine's
   * recording light still on. */
  document.dispatchEvent(new CustomEvent('viewchange', { detail: { inApp } }));
}

/* Readiness is reported by whichever module owns the oracle; it also decides
 * whether the way forward is open. */
export function setReady(text, ready) {
  const line = $('oracleReady');
  if (line) {
    line.textContent = text;
    line.classList.toggle('ready', !!ready);
  }
  const btn = $('continueBtn');
  if (btn) {
    btn.disabled = !ready;
    $('continueHint').textContent = ready
      ? 'Your oracle is ready.'
      : 'Finish step 2 and this opens up.';
  }
}

function routeFromHash() {
  const h = location.hash.replace('#', '');
  return (h === 'hardware' || h === 'paper') ? h : null;
}

/* esp-web-tools is a large module graph and only the "brand new device" branch
 * ever opens it, yet it used to load on every page view — including the entire
 * paper-oracle path, where nobody will ever flash anything. Fetched when that
 * branch opens instead, which is several seconds before the button can be
 * pressed. Loading it is also what upgrades <esp-web-install-button>, so the
 * button does nothing until this resolves; saying so beats a dead control. */
let flasherLoading = null;
function loadFlasher() {
  if (!flasherLoading) {
    flasherLoading = import('./vendor/esp-web-tools/install-button.js')
      .catch((e) => {
        flasherLoading = null;   // let a later attempt retry
        toast('Could not load the firmware installer — reload and try again.');
        throw e;
      });
  }
  return flasherLoading;
}

function initHardwareFork() {
  const panels = { forkFlash: 'panelFlash', forkReady: 'panelConnect' };
  $('forkFlash').onclick = () => { pickFork(panels, 'forkFlash'); loadFlasher(); };
  $('forkReady').onclick = () => pickFork(panels, 'forkReady');
}

function initNav() {
  const routed = routeFromHash();
  let stored = null;
  try { stored = localStorage.getItem(ORACLE_KEY); } catch { /* private mode */ }
  if (stored !== 'hardware' && stored !== 'paper') stored = null;

  setOracle(routed || stored, { remember: false });
  setView(!!routed, { push: false });

  $('chooseHardware').onclick = () => setOracle('hardware');
  $('choosePaper').onclick = () => setOracle('paper');
  $('continueBtn').onclick = () => setView(true);
  $('homeBtn').onclick = () => setView(false);
  $('chooseDemo').onclick = () => {
    setOracle(oracleChoice || 'paper');
    setView(true);
    toast('Type a phrase, then press “Try the demo” at step 6');
  };
  addEventListener('popstate', () => {
    const h = routeFromHash();
    if (h) setOracle(h, { remember: false });
    setView(!!h, { push: false });
  });
}

export function initChrome() {
  initNav();
  initHardwareFork();
  initRain();
  initMode();
  initStrength();
  initAccounts();
  initReveal();
  initFormatKeys();
}
