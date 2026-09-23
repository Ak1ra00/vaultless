/* Presentation layer for vaultless.
 *
 * Nothing in here participates in derivation. It owns the matrix backdrop, the
 * Simple/Expert switch, the passphrase meter, the account-number stepper and
 * the handshake animation. app.js owns the protocol and calls in.
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
               danger = false }) {
  const dlg = $('ask');

  // Nothing modern lacks <dialog>, but a security prompt must never simply
  // vanish, so fall back to the platform box rather than to nothing.
  if (!dlg || typeof dlg.showModal !== 'function') {
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

  const ok = $('askOk'), cancel = $('askCancel');
  ok.textContent = confirmLabel;
  cancel.textContent = cancelLabel;
  ok.classList.toggle('danger', danger);

  return new Promise((resolve) => {
    let value = false;
    const done = (v) => { value = v; dlg.close(); };
    ok.onclick = () => done(true);
    cancel.onclick = () => done(false);
    dlg.addEventListener('close', () => {
      ok.onclick = cancel.onclick = null;
      resolve(value);                 // Escape and dismissal leave it false
    }, { once: true });
    dlg.showModal();
    cancel.focus();                   // the safe answer is the default
  });
}

/* Resolves true only on a deliberate confirm; Escape, Cancel and a dismissed
 * dialog all resolve false. */
export function confirmDialog(opts) {
  return ask({ confirmLabel: 'Continue', ...opts });
}

/* The backdrop used to be drawn here, as a matrix rain. It is now the group
 * E(𝔽₂₁₁) turning in 3D, drawn by scene.js — a separate module, so that the
 * presentation layer that holds the password on screen no longer runs any
 * drawing loop at all. It still answers the handshake: scene.js watches the
 * `handshaking` class vizStart puts on <body>, and nothing else. */

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

/* -------------------------------------------------- account number */
/* There were nicknames here once: a list mapping "bank" to account 2, kept in
 * localStorage so the number did not have to be remembered.
 *
 * They are gone, and the reason is the claim at the top of the page. A
 * nickname is not a secret, but the list of them is a readable inventory of
 * where somebody banks, mails and works, sitting in a browser profile — which
 * is the shape of the thing this project exists to not keep. The account
 * NUMBER is still whatever you type; keeping track of which number is which is
 * now yours to do, in whatever you already trust with that.
 *
 * What is left is the stepper, which holds no state beyond the field itself.
 */

/* A feature that leaves its data behind is not removed. Anyone who saved
 * nicknames still has the list; clear it on the next load, once. */
try { localStorage.removeItem('vaultless.accounts.v1'); } catch { /* private mode */ }

function initAccountNumber() {
  const idx = $('index');
  const bump = (d) => {
    const n = Math.max(0, (Number(idx.value) || 0) + d);
    idx.value = String(n);
    idx.dispatchEvent(new Event('input'));
  };
  $('idxUp').onclick = () => bump(1);
  $('idxDown').onclick = () => bump(-1);
  idx.addEventListener('input', () => { $('card2').classList.add('done'); });
}

/* ------------------------------------------------------- handshake viz */
/* The signature element: the OPRF round trip, played out as it happens.
 *
 * It opens as a pop-up over the page for the length of one derivation, because
 * the button that starts it sits at the bottom of a long form and anything drawn
 * inline played to nobody on a phone. The drawing itself — the curve, the walks
 * across the group, the packets on the wire — is handshake.js, a separate
 * module that reads the stage set here and nothing else. This file owns the
 * pop-up, its words, and the pacing.
 *
 * What it shows, and what it deliberately does not:
 *
 *   B and B' are shown in full. They are the blinded pair — the only values that
 *   ever leave this machine, and exactly what the oracle and anyone on the wire
 *   see anyway. Showing them is the point: this is all there is to see.
 *
 *   P and S are NOT shown. The previous panel put both on screen in full, and
 *   neither is harmless. P = H(phrase ‖ account) is a check value for the
 *   phrase: anyone holding a screenshot of it can test guesses at the phrase
 *   offline, without the oracle — the one attack the oracle exists to stop. S is
 *   one public hash away from the password, which is masked until you ask for
 *   it; printing S next to the mask undid the mask. The trace never logged
 *   either; the animation should not have either.
 *
 * Every duration is a multiple of BEAT, so the whole choreography retimes from
 * one number. app.js paces the awaits between stages to match. */
export const BEAT = 900;

/* Reduced motion is not a request to skip the explanation.
 *
 * `prefers-reduced-motion` asks for no MOVEMENT — no churning glyphs, no text
 * settling character by character. Every one of those goes, and they should.
 * But this panel once answered it by collapsing the whole handshake to 84ms, so
 * the one thing on the page that shows the protocol happening showed nothing.
 * So the effects go and the PACING stays: each stage still holds long enough to
 * be read, a little brisker because there is no animation to wait out.
 *
 * Skip is the other way out, and it is total: pending waits resolve at once and
 * later ones do not wait at all, so the password arrives as fast as the maths
 * allows. The waits are presentation only — nothing in the derivation depends
 * on them. */
const DWELL = reduceMotion ? 0.55 : 1;
let skipped = false;
const waiting = new Set();
function dwell(ms) {
  if (skipped) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => { clearTimeout(timer); waiting.delete(done); resolve(); };
    const timer = setTimeout(done, ms * DWELL);
    waiting.add(done);
  });
}

const HEXCHARS = '0123456789abcdef';
const HEX_LEN = 64;

let scrambleRaf = null;

/* Settle text left-to-right out of churning hex.
 *
 * Unsettled characters keep rolling, so the readout reads as a value being
 * computed rather than a string being typed. Resolves when it has landed. Hex
 * is padded to its full 64 so the line does not jump; prose is left as it is. */
function settleText(el, target, ms, { hex = true } = {}) {
  cancelAnimationFrame(scrambleRaf);
  const text = hex ? String(target || '').slice(0, HEX_LEN).padEnd(HEX_LEN, '·') : String(target);
  // No settle, but the value still has to stay put long enough to be read.
  if (reduceMotion || skipped) { el.textContent = text; return dwell(ms); }

  return new Promise((resolve) => {
    const t0 = performance.now();
    const step = (now) => {
      /* Clamped below as well as above: the first frame's timestamp can come
       * before t0, and a negative p made `landed` negative — slice(0, -8) plus
       * a churn loop from -8 wrote a string nearly twice the value's length. */
      const p = skipped ? 1 : Math.max(0, Math.min(1, (now - t0) / ms));
      // Ease the settle front so the last characters land unhurriedly.
      const landed = Math.floor(text.length * (1 - Math.pow(1 - p, 2.2)));
      let out = text.slice(0, landed);
      for (let i = landed; i < text.length; i++) {
        out += text[i] === ' ' ? ' ' : HEXCHARS[(Math.random() * 16) | 0];
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
  /* Still says "not known yet", without moving to say it. Leaving the previous
   * stage's value on screen under a `k · B` tag would label B as something it
   * is not. */
  if (reduceMotion || skipped) { el.textContent = '·'.repeat(HEX_LEN); return Promise.resolve(); }
  return new Promise((resolve) => {
    const t0 = performance.now();
    const step = (now) => {
      let out = '';
      for (let i = 0; i < HEX_LEN; i++) out += HEXCHARS[(Math.random() * 16) | 0];
      el.textContent = out;
      if (now - t0 < ms && !skipped) scrambleRaf = requestAnimationFrame(step);
      else resolve();
    };
    scrambleRaf = requestAnimationFrame(step);
  });
}

/* What stands in for the two values that are never put on screen. */
const HIDDEN_P = 'kept off screen · P alone would let anyone test guesses at your phrase';
const HIDDEN_S = 'kept off screen · S is one hash away from your password';

/* Which road this run takes. app.js writes the result card's source line before
 * the first stage, so it is read from there rather than passed in. The paper
 * path has no second party: no blinding, no wire, no proof, and the pop-up must
 * not pretend otherwise. The demo plays the full two-party exchange against a
 * simulated oracle. */
let path = 'paper';
function readPath() {
  const src = ($('resSource')?.textContent || '').toLowerCase();
  return src.includes('demo') ? 'demo' : 'paper';
}
const relay = () => path !== 'paper';

const STEPS = {
  relay: ['hash', 'blind r', 'send B', 'stamp k', "return B'", 'verify π', 'unblind', 'HKDF'],
  paper: ['hash', 'k·P, here', 'S = k·P', 'HKDF'],
};
const STEP_AT = {
  relay: { local: 0, blinding: 1, sending: 2, stamping: 3, returning: 4, unblinding: 6, done: 7 },
  paper: { local: 0, stamping: 1, unblinding: 2, done: 3 },
};

function buildSteps() {
  const list = $('hsSteps');
  list.replaceChildren();
  for (const text of STEPS[relay() ? 'relay' : 'paper']) {
    const li = document.createElement('li');
    li.textContent = text;
    list.appendChild(li);
  }
}

function stage(name) {
  const v = $('viz');
  v.dataset.stage = name || '';
  const at = STEP_AT[relay() ? 'relay' : 'paper'][name];
  [...$('hsSteps').children].forEach((li, i) => {
    li.classList.toggle('done', at !== undefined && (i < at || name === 'done'));
    li.classList.toggle('now', i === at && name !== 'done');
  });
}

function setReadout(tag, value, { churn = false, hex = true, ms = BEAT * 0.8 } = {}) {
  $('vizTag').textContent = tag;
  const el = $('vizHex');
  return churn ? churnHex(el, ms) : settleText(el, value, ms, { hex });
}

/* ------------------------------------------------------- the pop-up */
let popOpen = false;
let lastFocus = null;
let hideTimer = null;
let doneTimer = null;

function openPop() {
  const pop = $('hsPop');
  clearTimeout(hideTimer);
  pop.hidden = false;
  pop.classList.remove('leaving');
  void pop.offsetWidth;               // commit the closed state, so opening animates
  pop.classList.add('on');
  $('viz').classList.add('on');
  // Everything behind it is out of reach while it is up — including to Tab and
  // to a screen reader. The toast and the pin dialog live outside .wrap, so a
  // first-use notice or a key-mismatch question still gets through.
  document.querySelector('.wrap').inert = true;
  if (!popOpen) lastFocus = document.activeElement;
  popOpen = true;
  $('viz').focus({ preventScroll: true });
}

function closePop({ toResult = false } = {}) {
  clearTimeout(doneTimer);
  if (!popOpen) return;
  popOpen = false;
  const pop = $('hsPop');
  $('viz').classList.remove('on');
  pop.classList.remove('on');
  pop.classList.add('leaving');
  document.querySelector('.wrap').inert = false;
  hideTimer = setTimeout(() => {
    pop.hidden = true;
    pop.classList.remove('leaving');
  }, reduceMotion ? 0 : 420);
  if (toResult) landOnResult();
  else if (lastFocus && document.contains(lastFocus)) lastFocus.focus({ preventScroll: true });
}

/* Hand over to the result card: it is where the password now is, and after a
 * pop-up the page underneath may be anywhere. */
function landOnResult() {
  const card = $('resultCard');
  card.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'center' });
  card.classList.remove('landed');
  void card.offsetWidth;
  card.classList.add('landed');
  const btn = $('revealBtn');
  if (!btn.disabled) btn.focus({ preventScroll: true });
}

function skip() {
  if (!popOpen) return;
  skipped = true;
  /* Not cancelAnimationFrame: app.js is awaiting whichever readout is settling,
   * and a cancelled frame is a promise that never resolves. The loops see
   * `skipped` on their next frame and finish themselves. */
  for (const done of [...waiting]) done();
  closePop({ toResult: $('viz').dataset.stage === 'done' });
}

function initHandshakePop() {
  $('hsSkip').onclick = skip;
  $('viz').addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); skip(); }
  });
}

/* Empties the stage without touching whether the pop-up is open. */
function clearStage() {
  cancelAnimationFrame(scrambleRaf);
  clearTimeout(doneTimer);
  const v = $('viz');
  delete v.dataset.stage;
  delete v.dataset.len;
  $('vizLabel').textContent = '';
  $('vizHex').textContent = '';
  $('vizTag').textContent = '';
  document.body.classList.remove('handshaking');
}

export function vizReset() {
  clearStage();
  closePop();
}

/* Opens the pop-up on the point the phrase hashed to. */
export function vizStart(label /* , hex — P, deliberately not shown */) {
  clearStage();
  skipped = false;
  path = readPath();
  const v = $('viz');
  v.dataset.path = path;
  v.dataset.beat = String(BEAT * DWELL);
  $('hsWho').textContent = path === 'paper' ? 'paper oracle' : 'demo key';
  $('hsTitle').textContent = path === 'demo' ? 'Making a demo password' : 'Making your password';
  $('hsSkip').textContent = 'Skip';
  buildSteps();
  openPop();
  $('vizLabel').textContent = label;
  // The backdrop answers the handshake: the group ring behind the page speeds
  // up while the oracle works, so the whole page is visibly doing the thing.
  document.body.classList.add('handshaking');
  stage('local');
  return setReadout('P = H(phrase ‖ account)', HIDDEN_P, { hex: false, ms: BEAT });
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
  return dwell(BEAT);
}

/* The oracle is working and we genuinely do not know the answer yet. */
export function vizOracle(label) {
  $('vizLabel').textContent = label;
  stage('stamping');
  /* On paper there is no B: k is here, and it multiplies P directly. */
  $('vizTag').textContent = relay() ? "B' = k·B" : 'S = k·P';
  /* Churns until the next stage cancels it, rather than for a fixed time, so
   * the readout never freezes mid-scramble while work is still going on. The
   * returned promise is a MINIMUM dwell, so the fast paths still read. */
  churnHex($('vizHex'), 120000);
  return dwell(BEAT * 1.4);
}

/* Stamped, coming back. */
export function vizReturn(label, hex) {
  $('vizLabel').textContent = label;
  stage('returning');
  return dwell(BEAT * 0.9)
    .then(() => setReadout("B' = k·B", hex, { ms: BEAT }));
}

/* Take the disguise off. */
export function vizUnblind(label /* , hex — S, deliberately not shown */) {
  $('vizLabel').textContent = label;
  stage('unblinding');
  return setReadout(relay() ? "S = r⁻¹·B' = k·P" : 'S = k·P', HIDDEN_S,
                    { hex: false, ms: BEAT * 1.2 });
}

export function vizDone(label) {
  $('vizLabel').textContent = label;
  // How many characters the finale fills in. The length is set by the style
  // you chose, not by the secret, so it tells the drawing nothing.
  $('viz').dataset.len = String(currentPassword.length || 16);
  stage('done');
  $('hsTitle').textContent = path === 'demo' ? 'Demo password ready' : 'Your password is ready';
  $('hsSkip').textContent = 'Close';
  setReadout('HKDF-SHA256(S, account)',
             `${currentPassword.length} characters · masked until you press Reveal`,
             { hex: false, ms: BEAT * 0.9 });
  document.body.classList.remove('handshaking');
  // Skipped earlier: the pop-up is already gone, so go straight to the result.
  if (!popOpen) { landOnResult(); return; }
  doneTimer = setTimeout(() => closePop({ toResult: true }), BEAT * 2.8 * DWELL);
}

/* The password lands rather than appears.
 *
 * It is derived, not looked up, and watching each character settle out of a
 * churn says that better than any copy could. Left-to-right, easing out, so the
 * last few characters take their time. */
const PW_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz0123456789!@#$%^&*-_=+';
let pwRaf = null;

/* Internal now: the reveal is driven by renderPassword, not by app.js. */
function revealPassword(el, pw) {
  cancelAnimationFrame(pwRaf);
  if (reduceMotion) { el.textContent = pw; return; }
  const ms = BEAT * 1.8;
  const t0 = performance.now();
  const step = (now) => {
    const p = Math.max(0, Math.min(1, (now - t0) / ms));   // see settleText
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
/* The derived password lives HERE, in a module variable, and reaches the DOM
 * only while it is revealed.
 *
 * The previous version blurred the text with CSS, which hides it from a glance
 * and from nothing else: the characters stayed in the document, so the
 * aria-live region announced them, find-in-page matched them, select-all copied
 * them, any extension could read them, and a blur is partly reversible from a
 * screenshot. Masking means the page genuinely does not contain the password
 * until someone asks for it.
 *
 * Copy keeps working while hidden because it reads getResultPassword() rather
 * than the element — the whole point being that you can paste a password you
 * have never put on screen. */
const MASK_CHAR = '•';
let currentPassword = '';
let revealed = false;
let animateNextReveal = false;

export function getResultPassword() { return currentPassword; }

function renderPassword({ animate = false } = {}) {
  const el = $('pwOut'), btn = $('revealBtn');
  el.replaceChildren();
  el.classList.toggle('masked', !revealed);

  if (revealed) {
    if (animate) revealPassword(el, currentPassword);
    else el.textContent = currentPassword;
  } else if (currentPassword) {
    /* Dots for the eye, a sentence for a screen reader — which would otherwise
     * read twenty bullet characters aloud, one at a time. */
    const dots = document.createElement('span');
    dots.setAttribute('aria-hidden', 'true');
    dots.textContent = MASK_CHAR.repeat(currentPassword.length);
    const spoken = document.createElement('span');
    spoken.className = 'sr-only';
    spoken.textContent =
      `Password ready, ${currentPassword.length} characters, hidden. ` +
      'Use Reveal to show it, or Copy to copy it without showing it.';
    el.append(dots, spoken);
  }

  btn.textContent = revealed ? 'Hide' : 'Reveal';
  btn.setAttribute('aria-pressed', String(revealed));
}

/* Hidden by default: a password appears as dots and stays that way until asked
 * for, so deriving one in front of someone reveals nothing. */
export function showPassword(pw) {
  currentPassword = pw;
  revealed = false;
  animateNextReveal = true;      // the settle animation belongs to the reveal
  $('pwPlaceholder').style.display = 'none';
  const el = $('pwOut');
  el.style.display = 'block';
  el.classList.remove('reveal');
  void el.offsetWidth;           // restart the entrance animation
  el.classList.add('reveal');
  $('revealBtn').disabled = false;
  $('copyBtn').disabled = false;
  renderPassword();
  markResultFilled(true);
}

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
  currentPassword = '';          // the value itself, not merely what is drawn
  revealed = false;
  animateNextReveal = false;
  const pw = $('pwOut');
  pw.replaceChildren();
  pw.style.display = 'none';
  pw.classList.remove('reveal', 'masked');
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
  /* The one copy this function cannot reach.
   *
   * Everything above is in this document, but a password the user copied is in
   * the system clipboard on its own 60-second timer owned by app.js. Without
   * this, pressing Forget — or letting the paper oracle idle out — reported the
   * password gone while it was still pasteable for up to another minute, which
   * is precisely the promise this function exists to keep. app.js scrubs on
   * hearing it; the event carries nothing, because the password must not. */
  document.dispatchEvent(new CustomEvent('resultcleared'));
}

function initReveal() {
  $('revealBtn').onclick = () => {
    if (!currentPassword) return;
    revealed = !revealed;
    /* Animate the first reveal of a given password, because that is the moment
     * worth watching. Toggling it back and forth afterwards swaps instantly —
     * a 1.6s flourish on every press would just be in the way. */
    renderPassword({ animate: revealed && animateNextReveal });
    if (revealed) animateNextReveal = false;
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
/* One front door: the paper oracle is the only kind there is. The app view is
 * kept in the URL (#paper) so it can be bookmarked, and the retired #hardware
 * route still opens it, so an old bookmark lands somewhere useful instead of on
 * the home page's first step. Home is always one click away in the header. */

/* Which oracle was chosen used to be remembered here. There is no choice left
 * to remember, so the old value is removed rather than left behind — the page
 * says it keeps nothing it does not need. */
try { localStorage.removeItem('vaultless.oracle.choice.v1'); } catch { /* private mode */ }

function setView(inApp, { push = true } = {}) {
  document.body.classList.toggle('in-app', inApp);
  $('viewHome').hidden = inApp;
  $('viewApp').hidden = !inApp;
  const hash = inApp ? '#paper' : '';
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
  /* The fast lane's last step. Once the oracle is actually ready there is
   * nothing left for "Continue" to confirm, so skip it and put the cursor where
   * the only remaining input goes. */
  if (ready && fastLaneArmed) {
    fastLaneArmed = false;
    setView(true);
    applyLastUse();
    $('passphrase').focus({ preventScroll: true });
    toast('Oracle ready — type your phrase');
  }
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
      : 'Finish step 1 and this opens up.';
  }
}

/* ------------------------------------------------- returning visitors */
/* Someone who has derived a password here before should not be walked through
 * setup again. The trusted-key set proves they have — it is only written after
 * an oracle has actually answered — so it is the signal this keys off.
 *
 * The one thing that genuinely cannot be skipped is presenting the oracle: it
 * is the second factor, and the paper key is deliberately wiped on reload.
 * Everything AROUND that can go: which branch of the fork, and the press of
 * "Continue".
 *
 * This drives the existing controls rather than reimplementing them — it clicks
 * the same fork buttons a person would — so the setup and derivation paths stay
 * exactly as they were and there is nothing new to keep in step. */
const LAST_KEY = 'vaultless.lastuse.v1';
let fastLaneArmed = false;

function loadLastUse() {
  try {
    const v = JSON.parse(localStorage.getItem(LAST_KEY) || 'null');
    if (v && typeof v === 'object' && /^\d+$/.test(String(v.index ?? ''))) return v;
  } catch { /* private mode, or corrupt */ }
  return null;
}

/* Called after a password is actually produced, so the next visit can land on
 * the same account and style instead of resetting to account 0 every time. */
export function rememberLastUse(index, fmt) {
  try {
    localStorage.setItem(LAST_KEY, JSON.stringify({ index: String(index), fmt }));
  } catch { /* private mode */ }
}

function applyLastUse() {
  const last = loadLastUse();
  if (!last) return;
  const idx = $('index');
  idx.value = String(last.index);
  idx.dispatchEvent(new Event('input'));
  if (last.fmt) {
    // Click the option rather than setting state directly: app.js owns which
    // format is selected, and clicking is how it finds out.
    const opt = document.querySelector(`.fmt-opt[data-fmt="${CSS.escape(last.fmt)}"]`);
    if (opt) opt.click();
  }
}

/* Leaves the fast lane and puts the ordinary setup pages back. */
function showSetup() {
  document.body.classList.remove('returning');
  $('welcomeBack').hidden = true;
  $('haveOracle').hidden = false;
}

/* One press: open the scan branch and start the camera, with the typed-code
 * box focused for anyone who would rather type. */
function unlock() {
  showSetup();
  /* The shortcut has done its job. Leaving it sitting above a running camera
   * only invites a second press, which would tear the scan down and restart
   * it. */
  $('haveOracle').hidden = true;
  fastLaneArmed = true;                 // setReady() takes it from here
  $('forkHave').click();                // opens the scan panel and starts the camera
  $('sheetManual').focus({ preventScroll: true });
  $('homeStep1').scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'center' });
}

/* Trust has to be revocable from the page.
 *
 * Pinning an oracle was a one-way door: the only way to drop one was DevTools,
 * so a browser that had seen a few oracles kept listing them for ever with no
 * way to tidy up. Each is a chip with an x, and forgetting one is confirmed
 * because it is a security control being switched off, not a preference.
 *
 * `forget` is supplied by app.js — it owns the store — and hands back whatever
 * is left so this can redraw without knowing how any of that works. */
let forgetTrusted = null;

function renderTrusted(fingerprints) {
  const wrap = $('wbFps');
  wrap.replaceChildren();
  for (const fp of fingerprints) {
    const chip = document.createElement('span');
    chip.className = 'chip';
    const name = document.createElement('span');
    name.className = 'wb-fp';
    name.textContent = fp;
    const x = document.createElement('button');
    x.type = 'button';
    x.className = 'x';
    x.textContent = '×';
    x.setAttribute('aria-label', `Forget oracle ${fp}`);
    x.title = `Forget ${fp}`;
    x.onclick = () => forgetOne(fp);
    chip.append(name, x);
    wrap.appendChild(chip);
  }
  $('wbForgetAll').hidden = fingerprints.length < 2;
}

async function forgetOne(fp, all = false) {
  const ok = await confirmDialog({
    title: all ? 'Forget every oracle this browser trusts?' : `Forget oracle ${fp}?`,
    lines: [
      all
        ? 'None of them will be recognised here again.'
        : `${fp} will not be recognised here again.`,
      'Your passwords do not change — they come from the phrase and the oracle, ' +
      'not from this list. What you lose is the warning: the next oracle to answer ' +
      'will be trusted on first use without being questioned, so check its ' +
      'fingerprint when it is.',
    ],
    confirmLabel: all ? 'Forget all' : 'Forget it',
    cancelLabel: 'Keep it',
    danger: true,
  });
  if (!ok) return;

  const left = forgetTrusted ? forgetTrusted(all ? null : fp) : [];
  if (!left.length) {
    showSetup();
    toast(all ? 'All oracles forgotten' : `Forgot oracle ${fp}`);
    $('homeStep1').scrollIntoView({ block: 'start' });
    return;
  }
  renderTrusted(left);
  toast(`Forgot oracle ${fp}`);
}

/* app.js hands over the fingerprints, because it owns the trusted-key store and
 * the hashing needed to shorten them. No fingerprints means no fast lane. */
export function initReturning(fingerprints, forget) {
  if (!fingerprints || !fingerprints.length) return;
  if (document.body.classList.contains('in-app')) return;   // deep-linked; leave it

  forgetTrusted = forget;
  renderTrusted(fingerprints);
  $('wbForgetAll').onclick = () => forgetOne(null, true);
  const last = loadLastUse();
  if (last) {
    const opt = document.querySelector(`.fmt-opt[data-fmt="${CSS.escape(last.fmt || '')}"]`);
    const style = opt ? opt.dataset.label : null;
    $('wbLastText').textContent =
      `account ${last.index}${style ? ` · ${style}` : ''}`;
    $('wbLast').hidden = false;
  }
  document.body.classList.add('returning');
  $('welcomeBack').hidden = false;
  $('wbGo').onclick = () => unlock();
  $('wbSetup').onclick = () => { showSetup(); $('homeStep1').scrollIntoView({ block: 'start' }); };
}

/* The welcome card needs a trusted key to appear, so it can only ever help
 * someone on a browser that has already derived a password here. The case it
 * misses is the one a long-standing user hits most often — a new laptop, a
 * cleared profile, a private window — where nothing stored proves anything and
 * the page has no choice but to show the first-timer's tour.
 *
 * So the same shortcut is offered up front, unconditionally, and answers a
 * question instead of guessing at one. It runs `unlock`, which means the fork
 * buttons, the scanner and the derivation path are all exactly the ones the
 * long way round uses. */
function initQuickEntry() {
  $('quickPaper').onclick = () => unlock();
  $('quickNew').onclick = () =>
    $('homeStep1').scrollIntoView({
      behavior: reduceMotion ? 'auto' : 'smooth',
      block: 'start',
    });
}

function routeFromHash() {
  const h = location.hash.replace('#', '');
  return h === 'paper' || h === 'hardware';
}

function initNav() {
  setView(routeFromHash(), { push: false });

  $('continueBtn').onclick = () => setView(true);
  $('homeBtn').onclick = () => setView(false);
  $('chooseDemo').onclick = () => {
    setView(true);
    toast('Type a phrase, then press “Try the demo” at step 5');
  };
  addEventListener('popstate', () => setView(routeFromHash(), { push: false }));
}

export function initChrome() {
  initHandshakePop();
  initNav();
  initQuickEntry();
  initMode();
  initStrength();
  initAccountNumber();
  initReveal();
  initFormatKeys();
}
