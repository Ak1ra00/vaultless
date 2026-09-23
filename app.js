/* Crypto is vendored, never fetched from a CDN — see vendor/VENDOR.md.
 * A third party able to serve script to this page could read the master
 * passphrase and every derived password, so nothing here loads cross-origin. */
import {
  RistrettoPoint, hashToRistretto255,
  bytesToHex, hexToBytes, bytesToNumberLE, numberToBytesLE,
  utf8ToBytes, concatBytes, invert, hkdf, sha256, sha512,
} from './vendor/noble-bundle.js';
import {
  initChrome, toast, setDemo, markResultFilled, confirmDialog,
  vizStart, vizBlind, vizSend, vizOracle, vizReturn, vizUnblind, vizDone, vizReset,
  showPassword, getResultPassword,
  initReturning, rememberLastUse,
} from './ui.js';
import { initSheet, getSheetKey } from './sheet.js';

/* ---------------------------------------------------------------------
 * Clickjacking guard.
 *
 * frame-ancestors cannot be expressed in a <meta> CSP and GitHub Pages cannot
 * send real headers, so this is the only defence available to a page that shows
 * live passwords and holds a master phrase: refuse to run framed. Blank the
 * document first and navigate second — a busting redirect can be cancelled by
 * the framing page, but an emptied document has nothing left to click on. The
 * throw stops the rest of this module, and with it every DOM handler below.
 * ------------------------------------------------------------------- */
if (self !== top) {
  document.documentElement.replaceChildren(
    document.createElement('head'), document.createElement('body'));
  try { top.location = self.location; } catch { /* cross-origin: blank is the point */ }
  throw new Error('vaultless refuses to run inside a frame');
}

/* ---------------------------------------------------------------------
 * Secure-context guard.
 *
 * On plain HTTP the browser withholds navigator.mediaDevices, so the camera
 * vanishes — and the old code reported that as "No camera available", which
 * sends people hunting for a camera fault that is not there. The camera is
 * the symptom; the cause is that the page itself arrived over a channel anyone
 * could rewrite.
 *
 * crypto.getRandomValues is NOT secure-context gated, so derivation keeps
 * working on HTTP. That is the dangerous part: the page will cheerfully make
 * real passwords while a network attacker is free to have replaced app.js with
 * one that posts the master phrase somewhere. Everything this project claims
 * rests on the delivered code being the audited code.
 *
 * localhost and file:// are secure contexts, so development and a downloaded
 * copy are unaffected.
 * ------------------------------------------------------------------- */
const SECURE = window.isSecureContext;
if (!SECURE) {
  const gate = document.getElementById('insecureGate');
  const where = document.getElementById('insecureOrigin');
  if (where) where.textContent = location.origin;
  if (gate) gate.hidden = false;
}

/* ---------------------------------------------------------------------
 * Group order L of ristretto255 / ed25519 (RFC 9380 / RFC 8032).
 * ------------------------------------------------------------------- */
const L = 2n ** 252n + 27742317777372353535851937790883648493n;

/* Modular inverse mod L. Uses the vendored library's implementation rather
 * than a hand-rolled extended Euclid. Note that JS BigInt arithmetic is
 * inherently variable-time, so this is not constant-time and cannot be made
 * so here; it narrows the hand-written surface, it does not remove timing
 * variation. The blinding scalar it operates on is ephemeral and per-request. */
function invMod(a, m) {
  return invert(((a % m) + m) % m, m);
}

/* Uniform scalar in [1, L). Draws 64 bytes and wide-reduces, the same way
 * libsodium's crypto_core_ristretto255_scalar_reduce does. Reducing only 32 bytes
 * mod L is biased: 2^256 / L is about 16, so residues below 2^256 mod L come
 * up roughly 6% more often. */
function randomScalar() {
  let r = 0n;
  while (r === 0n) {
    const buf = new Uint8Array(64);
    crypto.getRandomValues(buf);
    r = bytesToNumberLE(buf) % L;
  }
  return r;
}
function scalarToBytes(s) {
  return numberToBytesLE(((s % L) + L) % L, 32);
}

/* ---------------------------------------------------------------------
 * Oracle authentication.
 *
 * An oracle that answers over the protocol (today, only the demo's simulated
 * one) could return any point: the bare OPRF gives the browser no way to tell
 * k*B from junk, and the only symptom would be a password that silently
 * differs from the one that was stored. A Chaum-Pedersen DLEQ proof fixes that,
 * proving log_G(Y) == log_B(B') without revealing k — "the same k that made my
 * public key Y made this answer". That turns the OPRF into a VOPRF.
 *
 * The paper oracle needs no proof — the browser does the multiplication
 * itself — but it does need the other half: trust-on-first-use pinning of
 * Y = k*G, which is what makes a substituted sheet detectable.
 * ------------------------------------------------------------------- */
const DLEQ_DST = utf8ToBytes('oprf-vaultless-dleq-v1');
const PIN_KEY = 'vaultless.oracle.pubkey.v1';      // legacy: one key, replaced on accept
const TRUST_KEY = 'vaultless.oracle.trusted.v1';   // current: the set of keys you trust

/* The same short identifier the paper oracle prints on its sheet — SHA-256 of
 * the public key, truncated — so the fingerprint on screen is the one on the
 * paper, and the mismatch dialog can name keys instead of showing 24
 * characters of hex nobody can compare. */
function keyFingerprint(pubkeyHex) {
  const h = bytesToHex(sha256(hexToBytes(pubkeyHex))).slice(0, 8);
  return `${h.slice(0, 4)}-${h.slice(4, 8)}`;
}

function loadTrusted() {
  try {
    const raw = localStorage.getItem(TRUST_KEY);
    if (raw) {
      const v = JSON.parse(raw);
      if (Array.isArray(v)) return v.filter(x => typeof x === 'string' && x.length === 64);
    }
    // Carry across the single key pinned before this was a set.
    const legacy = localStorage.getItem(PIN_KEY);
    if (legacy) return [legacy];
  } catch { /* private mode, or corrupt value: start empty rather than throw */ }
  return [];
}

function saveTrusted(list) {
  try { localStorage.setItem(TRUST_KEY, JSON.stringify(list)); } catch { /* private mode */ }
}

function dleqChallenge(Y, B, Bp, T1, T2) {
  const h = sha512(concatBytes(
    DLEQ_DST, Y.toRawBytes(), B.toRawBytes(), Bp.toRawBytes(),
    T1.toRawBytes(), T2.toRawBytes(),
  ));
  return bytesToNumberLE(h) % L; // 64-byte wide reduce
}

function dleqVerify(Y, B, Bp, c, s) {
  if (c <= 0n || c >= L || s <= 0n || s >= L) return false;
  const T1 = RistrettoPoint.BASE.multiply(s).subtract(Y.multiply(c));
  const T2 = B.multiply(s).subtract(Bp.multiply(c));
  return dleqChallenge(Y, B, Bp, T1, T2) === c;
}

/* Prover — used only by the demo's in-browser simulated oracle. */
function dleqProve(k, B, Bp, Y) {
  const t = randomScalar();
  const T1 = RistrettoPoint.BASE.multiply(t);
  const T2 = B.multiply(t);
  const c = dleqChallenge(Y, B, Bp, T1, T2);
  return { c, s: (t + c * k) % L };
}

/* Trust-on-first-use over the paper oracle's public key. It is what catches a
 * sheet that is not the one this browser has been using — scanning last year's
 * sheet, or someone else's, would otherwise derive different passwords with no
 * error anywhere. */
async function enforcePin(pubkeyHex, whatItIs) {
  const trusted = loadTrusted();
  if (!trusted.length) {
    const fp = keyFingerprint(pubkeyHex);
    saveTrusted([pubkeyHex]);
    trace('pin', `trusting ${whatItIs} ${fp} (first use)`);
    /* Say it out loud. This used to trace only, and the trace lives in the
     * expert-only panel that Simple mode hides — so the single moment the whole
     * trust-on-first-use scheme hangs on happened with no visible sign at all.
     *
     * It matters more than it looks: the trusted set lives in localStorage,
     * which is per-origin, so it does not survive a move to a new domain. Every
     * returning user is a first use again, and this is their one chance to
     * notice that the key being trusted is not the key they expect. The paper
     * oracle prints the same fingerprint on the sheet, so there is something to
     * compare it against. */
    toast(`Trusting ${whatItIs} ${fp} — check it matches the one printed on your sheet.`);
    return;
  }
  if (trusted.includes(pubkeyHex)) return;

  const fp = keyFingerprint(pubkeyHex);
  const ok = await confirmDialog({
    title: `This ${whatItIs} is not one you have used here`,
    lines: [
      `It presents ${fp}. This browser already trusts ` +
      `${trusted.map(keyFingerprint).join(', ')}.`,
      'A different key makes different passwords — none of the ones you already ' +
      'use. Continue only if you meant to add another oracle. If you did not, ' +
      'stop: something has taken the place of yours.',
    ],
    confirmLabel: `Also trust ${fp}`,
    cancelLabel: 'Stop',
    danger: true,
  });
  if (!ok) throw new Error(`${whatItIs} public key is not one this browser trusts`);

  /* Added, never substituted. Replacing the pinned key meant that owning two
   * legitimate oracles — say a personal sheet and a work sheet, each carrying
   * its own k — silently disarmed the protection for whichever one
   * you had used a minute ago, and trained you to click through the single
   * prompt that matters. */
  saveTrusted([...trusted, pubkeyHex]);
  trace('pin', `now also trusting ${whatItIs} ${fp}`, true);
}

/* Verify an oracle's answer. Throws on any failure — a derivation must never
 * proceed against an unverified oracle. The demo's simulated oracle is never
 * pinned: its key is thrown away with the tab. */
async function verifyOracleResponse(response, B) {
  if (!response.pubkey || !response.proof) {
    throw new Error('oracle did not supply a DLEQ proof — refusing to derive');
  }
  let Y, Bp, c, sScalar;
  try {
    Y = RistrettoPoint.fromHex(response.pubkey);
    Bp = RistrettoPoint.fromHex(response.point);
    c = bytesToNumberLE(hexToBytes(response.proof.c));
    sScalar = bytesToNumberLE(hexToBytes(response.proof.s));
  } catch {
    throw new Error('oracle response is malformed');
  }
  /* Reject the identity element before doing anything else with it.
   *
   * An oracle whose scalar is k = 0 has Y = identity and answers B' = identity,
   * and its DLEQ proof VERIFIES: with k = 0 the Schnorr equation collapses to
   * s = t, so both checks (s*G - c*Y and s*B - c*B') reproduce the prover's
   * commitments exactly. The identity is a perfectly canonical ristretto255
   * encoding, so point decoding does not catch it either.
   *
   * The consequence is total: unblinding gives S = identity for EVERY
   * passphrase and EVERY index, so the passphrase stops contributing at all and
   * the derived password becomes a fixed constant anyone can compute offline.
   * That is precisely the substituted-oracle attack the proof exists to stop.
   *
   * ristretto255 has prime order, so Y != identity already rules out every
   * degenerate k; B' is checked too because it costs nothing. decodeRecovery
   * refuses k = 0 on a sheet for the same reason. */
  if (Y.equals(RistrettoPoint.ZERO) || Bp.equals(RistrettoPoint.ZERO)) {
    throw new Error('oracle presented a zero key — every password it produced ' +
                    'would be a public constant; refusing to derive');
  }
  if (!dleqVerify(Y, B, Bp, c, sScalar)) {
    throw new Error('DLEQ proof failed — this oracle did not compute k*B with ' +
                    'the key it claims; refusing to derive');
  }
  return Bp;
}

/* ---------------------------------------------------------------------
 * UI trace logger (the "protocol trace" signature element)
 * ------------------------------------------------------------------- */
const traceEl = document.getElementById('trace');
function trace(step, msg, isErr = false) {
  if (traceEl.querySelector('.empty')) traceEl.replaceChildren();
  const row = document.createElement('div');
  row.className = 'row';
  // Built with textContent, never innerHTML: `msg` carries error strings from
  // outside this file (a decoded sheet, a browser API), and an innerHTML sink
  // on a page holding the master passphrase would hand them script execution.
  const mk = (cls, text) => {
    const el = document.createElement('span');
    el.className = cls;
    el.textContent = text;
    return el;
  };
  row.append(
    mk('t', new Date().toLocaleTimeString('en-GB', { hour12: false })),
    mk('step', String(step)),
    mk(isErr ? 'err' : 'msg', String(msg)),
  );
  traceEl.appendChild(row);
  traceEl.scrollTop = traceEl.scrollHeight;
}
/* A failure the user has to know about.
 *
 * The protocol trace lives inside the expert-only panel, which Simple mode —
 * the default — hides outright. Tracing alone therefore means a button that
 * silently does nothing, which is what every input-validation and transport
 * error in here used to do. Anything a person can act on goes through this, so
 * it lands in both places: the trace for detail, a toast for visibility.
 *
 * `short` exists because the toast is one line on a phone; the trace keeps the
 * long form. */
function fail(step, msg, short = msg) {
  trace(step, msg, true);
  toast(short);
}

document.getElementById('clearTrace').onclick = () => {
  // Built as nodes rather than markup. The string is a literal today, but an
  // innerHTML sink on the page holding the master phrase is not worth keeping
  // around for someone to later feed a variable into.
  const row = document.createElement('div');
  row.className = 'row';
  const empty = document.createElement('span');
  empty.className = 'empty';
  empty.textContent = '— cleared —';
  row.appendChild(empty);
  traceEl.replaceChildren(row);
};

/* ---------------------------------------------------------------------
 * Simulated oracle, for the demo (in-browser, ephemeral session key). It
 * plays the full two-party exchange — blind, stamp, prove, unblind — that the
 * paper path collapses into one local k·P. The scalar lives only in memory
 * for this tab and is never pinned.
 * ------------------------------------------------------------------- */
let simKey = null;
function simulateOracle(blindedHex) {
  if (!simKey) {
    simKey = randomScalar();
    trace('sim', 'generated ephemeral session oracle key (memory-only)');
  }
  const k = ((simKey % L) + L) % L;
  const B = RistrettoPoint.fromHex(blindedHex);
  const Bp = B.multiply(k);
  const Y = RistrettoPoint.BASE.multiply(k);
  const { c, s } = dleqProve(k, B, Bp, Y);
  return {
    point: bytesToHex(Bp.toRawBytes()),
    pubkey: bytesToHex(Y.toRawBytes()),
    proof: { c: bytesToHex(scalarToBytes(c)), s: bytesToHex(scalarToBytes(s)) },
  };
}

document.getElementById('simBtn').onclick = () => runDerivation('simulator');
document.getElementById('deriveBtn').onclick = () => runDerivation('sheet');

/* ---------------------------------------------------------------------
 * Format selector
 * ------------------------------------------------------------------- */
let selectedFormat = 'complex';
document.querySelectorAll('.fmt-opt').forEach(el => {
  el.onclick = () => {
    document.querySelectorAll('.fmt-opt').forEach(o => {
      o.classList.remove('active');
      o.setAttribute('aria-checked', 'false');
    });
    el.classList.add('active');
    el.setAttribute('aria-checked', 'true');
    selectedFormat = el.dataset.fmt;
    document.getElementById('resFmt').textContent = `style: ${el.dataset.label}`;
    document.getElementById('card3').classList.add('done');
  };
});

/* The button used to carry a fixed aria-label ("Show or hide the phrase"), which
 * overrides its visible text — so sighted users read "show" then "hide" while
 * screen-reader users heard the same string both times and never learned which
 * state they were in. The label now follows the state, like the text does. */
document.getElementById('togglePass').onclick = () => {
  const el = document.getElementById('passphrase');
  const btn = document.getElementById('togglePass');
  el.type = el.type === 'password' ? 'text' : 'password';
  const hidden = el.type === 'password';
  btn.textContent = hidden ? 'show' : 'hide';
  btn.setAttribute('aria-label', hidden ? 'Show the phrase' : 'Hide the phrase');
};

/* ---------------------------------------------------------------------
 * Formatting engine — derives a large keystream per-format via a
 * second HKDF stage keyed by format name, then rejection-samples
 * into the target charset/length to avoid modulo bias.
 * ------------------------------------------------------------------- */
const CHARSETS = {
  complex: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*()-_=+[]{}',
  alnum:   'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789',
  pin:     '0123456789',
};
const FORMAT_LENGTHS = { complex: 20, alnum: 16, b64url: 20, pin: 6 };

function rejectionSample(streamBytes, charset) {
  const n = charset.length;
  const limit = Math.floor(256 / n) * n;
  const out = [];
  let i = 0;
  while (out.length < streamBytes.__need) {
    if (i >= streamBytes.length) throw new Error('keystream exhausted — increase derived length');
    const b = streamBytes[i++];
    if (b < limit) out.push(charset[b % n]);
  }
  return out.join('');
}

function formatPassword(oprfOutput, format) {
  const need = FORMAT_LENGTHS[format];
  // Second-stage HKDF, keyed by format so each format is independently
  // deterministic yet derived from the same OPRF secret.
  const stream = hkdf(sha256, oprfOutput, utf8ToBytes(format), utf8ToBytes('oprf-vaultless-fmt-v1'), 128);
  if (format === 'b64url') {
    const b64 = btoa(String.fromCharCode(...stream))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    return b64.slice(0, need);
  }
  stream.__need = need;
  return rejectionSample(stream, CHARSETS[format]);
}

/* ---------------------------------------------------------------------
 * Main derivation flow
 * ------------------------------------------------------------------- */
/* mode: 'sheet' (your paper oracle) | 'simulator' (the demo) */
async function runDerivation(mode) {
  const useSimulator = mode === 'simulator';
  const useSheet = mode === 'sheet';
  const passphrase = document.getElementById('passphrase').value;
  const deriveBtn = document.getElementById('deriveBtn');
  const simBtn = document.getElementById('simBtn');

  /* Refusing here as well as behind the gate: the gate is DOM, and DOM can be
   * dismissed from a console or defeated by a stylesheet that never loaded. */
  if (!SECURE) {
    fail('input', 'refusing to derive: this page is not in a secure context',
         'Not on HTTPS — this page could have been altered in transit. Refusing to make a password.');
    return;
  }

  if (!passphrase) {
    fail('input', 'master passphrase is required', 'Type your secret phrase first.');
    return;
  }

  /* The index goes into the hash input and the HKDF salt, so it has to be
   * exactly what the user meant. parseInt was too forgiving: "12x" silently
   * became 12, and anything non-numeric became NaN, which stringifies to
   * "NaN" and derives a password from it. Require a plain non-negative
   * integer, and keep it inside the range it has always had (a signed
   * 32-bit integer), so every account number ever used still works.
   *
   * The field is type="text" inputmode="numeric" for this to work at all. As a
   * number input it returned "" for anything the browser judged invalid — "-5",
   * "1e5", "abc" — so the `|| '0'` below turned every one of them into account
   * ZERO and derived a confident, correctly formatted password for the wrong
   * account. The validation was already right; it just never saw the input. */
  const rawIndex = (document.getElementById('index').value || '0').trim();
  if (!/^\d+$/.test(rawIndex)) {
    fail('input', 'index must be a non-negative whole number',
         'The account number has to be a whole number, 0 or more.');
    return;
  }
  const index = Number(rawIndex);
  if (!Number.isSafeInteger(index) || index > 2147483647) {
    fail('input', 'index is out of range (max 2147483647)',
         'That account number is too large — the most is 2147483647.');
    return;
  }
  if (useSheet && !getSheetKey()) {
    fail('input', 'no paper oracle loaded — scan its square or type its code first',
         'No paper oracle loaded — scan its square or type its code first.');
    return;
  }

  deriveBtn.disabled = true; simBtn.disabled = true;
  setDemo(useSimulator);
  document.getElementById('resSource').textContent =
    `source: ${useSimulator ? 'demo simulator' : 'your paper oracle'}`;

  try {
    trace('1/7', `hashing "${index}" to a ristretto255 point`);
    const msg = concatBytes(utf8ToBytes(passphrase), utf8ToBytes('||'), utf8ToBytes(String(index)));
    const P = hashToRistretto255(msg, { DST: 'oprf-vaultless-pwd-v1-HashToGroup' });

    let S;
    if (useSheet) {
      /* With k in hand there is no second party, so no blinding and no proof:
       * the browser computes k·P itself. The blinding in the oracle path
       * cancels — r⁻¹·(k·(r·P)) = k·P — so this lands on exactly the same
       * point, and therefore exactly the same password, as the demo's
       * two-party road would with the same k. */
      const k = getSheetKey();
      trace('2/4', 'using your paper oracle (its key is here, so no round trip)');
      await enforcePin(bytesToHex(RistrettoPoint.BASE.multiply(k).toRawBytes()), 'paper oracle');
      trace('3/4', 'computing S = k·P locally');
      /* No blinding stage here, and the animation says so: with k in hand there
       * is no second party to hide the input from, so nothing crosses a channel.
       * Showing a disguise step the paper path does not perform would be the one
       * kind of prettiness this project cannot afford. */
      await vizStart('turning your phrase into a point on the curve…', bytesToHex(P.toRawBytes()));
      const stampingPaper = vizOracle('your paper oracle is doing the handshake…');
      S = P.multiply(k);
      await stampingPaper;
      await vizUnblind('landing on the shared secret…', bytesToHex(S.toRawBytes()));
    } else {

    await vizStart('turning your phrase into a point on the curve…', bytesToHex(P.toRawBytes()));

    trace('2/7', 'generating blinding scalar r and computing B = r·P');
    const r = randomScalar();
    const B = P.multiply(r);
    const blindedHex = bytesToHex(B.toRawBytes());
    trace('2/7', `B = ${blindedHex.slice(0, 16)}…`);
    await vizBlind('disguising it — this is all the oracle ever sees…', blindedHex);

    trace('3/7', 'sending {point} to the simulated oracle, in memory');
    await vizSend('handing it over…');
    const stamping = vizOracle('the demo key is stamping it…');
    const response = simulateOracle(blindedHex);
    await stamping;                                  // let the animation read
    if (response.error) throw new Error(`oracle rejected: ${response.error}`);
    if (!response.point) throw new Error('oracle response missing point');
    trace('4/7', `received B' = ${response.point.slice(0, 16)}…`);
    await vizReturn('stamped, and on its way back…', response.point);

    trace('5/7', 'verifying the DLEQ proof that B\' = k·B');
    const Bp = await verifyOracleResponse(response, B);
    trace('5/7', 'proof ok (simulator, not pinned)');

    trace('6/7', 'unblinding: S = r⁻¹·B\'');
    const rInv = invMod(r, L);
    S = Bp.multiply(rInv);
    await vizUnblind('taking the disguise off — only you can do this…',
                     bytesToHex(S.toRawBytes()));
    }

    /* One more guard covering both paths at once — the demo and paper.
     * Anything that lands on the identity here means the shared secret
     * carries no key at all, and HKDF would happily expand it into a real-looking
     * password regardless. */
    if (S.equals(RistrettoPoint.ZERO)) {
      throw new Error('derivation collapsed to the identity element — the oracle ' +
                      'key is degenerate; refusing to derive');
    }
    const sBytes = S.toRawBytes();

    trace(useSheet ? '4/4' : '7/7', 'expanding shared secret via HKDF-SHA256');
    const salt = utf8ToBytes(String(index));
    const oprfOutput = hkdf(sha256, sBytes, salt, utf8ToBytes('oprf-vaultless-pwd-v1'), 32);

    const password = formatPassword(oprfOutput, selectedFormat);
    showResult(password);
    // So the next visit opens on this account and style instead of account 0.
    rememberLastUse(index, selectedFormat);
    vizDone(useSimulator ? 'demo password ready' : 'your password is ready');
    trace('done', `password derived · ${password.length} chars`);
  } catch (e) {
    trace('error', e.message, true);
    vizReset();
    // Never send the reader to the trace: in Simple mode it is not on screen.
    toast(e.message.length > 70
      ? 'Could not make a password. Switch to Expert mode for the full reason.'
      : e.message);
  } finally {
    deriveBtn.disabled = false; simBtn.disabled = false;
  }
}

/* ui.js owns the result card, including whether the password is on screen at
 * all — it arrives hidden. */
function showResult(pw) {
  showPassword(pw);
}

const CLIPBOARD_CLEAR_MS = 60000;
let clipboardTimer = null;
/* What was last written to the clipboard, kept so the scrub can tell our own
 * copy from something the user copied since. Cleared as soon as it is scrubbed;
 * it is the same secret as the one on screen and gets the same treatment. */
let copiedPassword = '';

/* Best-effort scrub, so a derived password does not sit in the system clipboard.
 *
 * Reading the clipboard back is the precise way to do this — only clear what we
 * put there — but navigator.clipboard.readText() raises a permission prompt in
 * Chromium, and it would arrive a full minute after the copy with nothing on
 * screen to explain it. On a security tool that is exactly the prompt people
 * should refuse, and refusing it meant no clearing at all.
 *
 * So: read back only where permission has already been granted — permissions
 * .query() never prompts — and otherwise simply overwrite. Clobbering something
 * copied since is a small annoyance; leaving a password in the clipboard is not. */
async function scrubClipboard(pw) {
  try {
    let mayRead = false;
    try {
      const st = await navigator.permissions.query({ name: 'clipboard-read' });
      mayRead = st.state === 'granted';
    } catch { /* Firefox and Safari do not know this permission name */ }
    if (mayRead && (await navigator.clipboard.readText()) !== pw) return;  // theirs, not ours
    await navigator.clipboard.writeText('');
    trace('clipboard', 'cleared after 60s');
  } catch { /* not focused, or write denied — leave it alone */ }
}
document.getElementById('copyBtn').onclick = async () => {
  // From the module variable, never the element — while hidden the element
  // holds dots, and copying dots would be a memorable kind of useless.
  const pw = getResultPassword();
  if (!pw) return;
  await navigator.clipboard.writeText(pw);
  const btn = document.getElementById('copyBtn');
  const original = btn.textContent;
  btn.textContent = 'Copied ✓';
  setTimeout(() => (btn.textContent = original), 2400);
  toast('Copied — cleared from the clipboard in 60 seconds');
  clearTimeout(clipboardTimer);
  copiedPassword = pw;
  clipboardTimer = setTimeout(() => {
    copiedPassword = '';
    scrubClipboard(pw);
  }, CLIPBOARD_CLEAR_MS);
};

/* Scrub on demand, not only on the timer.
 *
 * ui.js clears the result card whenever an oracle goes away — forgotten, idled
 * out, or unplugged — and its whole point is that the password should not
 * outlive the oracle that made it. The clipboard copy is the one that used to,
 * for up to a full minute after the app said everything was cleared. Forgetting
 * is a deliberate "wipe it now", so it takes the clipboard with it. */
document.addEventListener('resultcleared', () => {
  if (!copiedPassword) return;
  clearTimeout(clipboardTimer);
  clipboardTimer = null;
  const pw = copiedPassword;
  copiedPassword = '';
  scrubClipboard(pw);
});

/* Start the presentation layer (backdrop, mode switch, meter, account number). */
initChrome();
initSheet();

/* Offer the fast lane to anyone this browser has already derived for. The
 * trusted-key store and the hashing live here, so the fingerprints are handed
 * over rather than looked up in the presentation layer. */
initReturning(
  loadTrusted().map(keyFingerprint),
  /* Remove one trusted key, or all of them when fp is null, and report what is
   * left. Matching on the fingerprint rather than the raw key keeps the public
   * keys themselves out of the presentation layer. */
  (fp) => {
    const left = fp === null ? [] : loadTrusted().filter(k => keyFingerprint(k) !== fp);
    saveTrusted(left);
    trace('pin', fp === null ? 'forgot every trusted oracle' : `forgot oracle ${fp}`, true);
    return left.map(keyFingerprint);
  },
);

/* ---------------------------------------------------------------------
 * Offline shell.
 *
 * A password manager that needs the network to hand you a password is not much
 * of one — and every load without this re-fetches the derivation code from the
 * host, so the code you audited last week is only the code that runs today if
 * the host is still honest. Caching the shell pins it between updates.
 *
 * Registration is last and its failure is never fatal: no service worker means
 * the site behaves exactly as it did before, which is also what happens on
 * file:// and in browsers that do not support one.
 * ------------------------------------------------------------------- */
if ('serviceWorker' in navigator && isSecureContext) {
  addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => { /* not fatal */ });
  });
}
