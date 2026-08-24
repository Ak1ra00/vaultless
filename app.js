/* Crypto is vendored, never fetched from a CDN — see vendor/VENDOR.md.
 * A third party able to serve script to this page could read the master
 * passphrase and every derived password, so nothing here loads cross-origin. */
import {
  RistrettoPoint, hashToRistretto255,
  bytesToHex, hexToBytes, bytesToNumberLE, numberToBytesLE,
  utf8ToBytes, concatBytes, invert, hkdf, sha256, sha512,
} from './vendor/noble-bundle.js';
import {
  initChrome, toast, setDemo, markResultFilled, confirmDialog, clearResult,
  vizStart, vizBlind, vizSend, vizOracle, vizReturn, vizUnblind, vizDone, vizReset,
  revealPassword, getOracleChoice, setReady,
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

/* Uniform scalar in [1, L). Draws 64 bytes and wide-reduces, matching the
 * firmware's crypto_core_ristretto255_scalar_reduce. Reducing only 32 bytes
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
 * The bare OPRF gives the browser no way to tell k*B from junk: a swapped or
 * tampered device can return any point and the only symptom is a password
 * that silently differs from the one that was stored. Two things fix that.
 *
 *  1. A Chaum-Pedersen DLEQ proof, proving log_G(Y) == log_B(B') without
 *     revealing k — i.e. "the same k that made my public key Y made this
 *     answer". That turns the OPRF into a VOPRF.
 *  2. Trust-on-first-use pinning of Y. The proof alone is not enough: a
 *     hostile device can present its own Y' and prove consistency with it.
 *     Pinning is what makes a substituted device detectable.
 * ------------------------------------------------------------------- */
const DLEQ_DST = utf8ToBytes('oprf-vaultless-dleq-v1');
const PIN_KEY = 'vaultless.oracle.pubkey.v1';      // legacy: one key, replaced on accept
const TRUST_KEY = 'vaultless.oracle.trusted.v1';   // current: the set of keys you trust

/* The same short identifier the paper oracle prints on its sheet — SHA-256 of
 * the public key, truncated — so a device and a sheet holding one key show one
 * fingerprint, and the mismatch dialog can name keys instead of showing 24
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

/* Prover — used only by the in-browser simulator. The hardware oracle runs
 * the equivalent in firmware (see firmware/src/main.cpp, dleqProve). */
function dleqProve(k, B, Bp, Y) {
  const t = randomScalar();
  const T1 = RistrettoPoint.BASE.multiply(t);
  const T2 = B.multiply(t);
  const c = dleqChallenge(Y, B, Bp, T1, T2);
  return { c, s: (t + c * k) % L };
}

/* Verify a hardware response and enforce the pin. Throws on any failure —
 * a derivation must never proceed against an unverified oracle. */
/* Trust-on-first-use over the oracle's public key, shared by the hardware
 * hardware oracle and the paper oracle. It is what catches a substituted
 * device, and equally a sheet that is not the one this browser has been using —
 * scanning last year's sheet would otherwise derive different passwords with no
 * error anywhere. */
async function enforcePin(pubkeyHex, whatItIs) {
  const trusted = loadTrusted();
  if (!trusted.length) {
    saveTrusted([pubkeyHex]);
    trace('pin', `trusting ${whatItIs} ${keyFingerprint(pubkeyHex)} (first use)`);
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
   * legitimate oracles — a device and a work device, or a device and a sheet
   * carrying a different k — silently disarmed the protection for whichever one
   * you had used a minute ago, and trained you to click through the single
   * prompt that matters. */
  saveTrusted([...trusted, pubkeyHex]);
  trace('pin', `now also trusting ${whatItIs} ${fp}`, true);
}

async function verifyOracleResponse(response, B, pin = true) {
  if (!response.pubkey || !response.proof) {
    throw new Error('oracle did not supply a DLEQ proof — firmware predates ' +
                    'protocol v2, reflash it before deriving');
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
   * That is precisely the substituted-device attack the proof and the pin exist
   * to stop, and it lands hardest on first use, when there is no pin yet.
   *
   * ristretto255 has prime order, so Y != identity already rules out every
   * degenerate k; B' is checked too because it costs nothing. The firmware
   * refuses the same cases (libsodium returns -1 on an identity result) and
   * decodeRecovery refuses k = 0, so this is the browser catching up with the
   * two places that already got it right. */
  if (Y.equals(RistrettoPoint.ZERO) || Bp.equals(RistrettoPoint.ZERO)) {
    throw new Error('oracle presented a zero key — every password it produced ' +
                    'would be a public constant; refusing to derive');
  }
  if (!dleqVerify(Y, B, Bp, c, sScalar)) {
    throw new Error('DLEQ proof failed — this device did not compute k*B with ' +
                    'the key it claims; refusing to derive');
  }
  if (!pin) return Bp;
  /* Y as re-encoded from the parsed point, never response.pubkey as it arrived.
   * The comparison is string equality, so an oracle answering in uppercase hex
   * would trip the "not one you have used here" dialog with nothing actually
   * wrong — and that is the one dialog users must not be taught to dismiss. */
  await enforcePin(bytesToHex(Y.toRawBytes()), 'oracle');
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
  // Built with textContent, never innerHTML: `msg` carries device output and
  // oracle error strings, so anything able to write to the serial port would
  // otherwise get script execution on a page holding the master passphrase.
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
 * WebSerial transport
 * ------------------------------------------------------------------- */
const wsBadge = document.getElementById('wsBadge');
const serialSupported = 'serial' in navigator;
wsBadge.textContent = serialSupported ? 'supported' : 'unsupported';
wsBadge.classList.add(serialSupported ? 'on' : 'warn');
/* Say so where the choice is made. Without this a Firefox or Safari user picks
 * the option the home page labels "strongest", walks three screens into it, and
 * presses a Connect button that cannot ever work. */
if (!serialSupported) {
  for (const id of ['hwUnsupported', 'hwUnsupportedPanel']) {
    const el = document.getElementById(id);
    if (el) el.hidden = false;
  }
}

let port = null, writer = null, reader = null, readableClosed = null;
const connDot = document.getElementById('connDot');
const connLabel = document.getElementById('connLabel');
const connectBtn = document.getElementById('connectBtn');
const disconnectBtn = document.getElementById('disconnectBtn');

function setConnected(state, label) {
  if (getOracleChoice() === 'paper') return;   // the pill is showing the paper oracle
  connDot.className = 'dot' + (state ? ' live' : '');
  connLabel.textContent = label;
  connectBtn.disabled = state || !serialSupported;
  disconnectBtn.disabled = !state;
  document.getElementById('homeStep2').classList.toggle('done', state);
  setReady(state ? 'Oracle connected and ready' : 'Oracle not connected yet', state);
}

let lineBuffer = '';
/* In-flight oracle requests, oldest first. Each entry owns its own timeout
 * timer and is removed from the queue by whichever of the two fires first, so
 * a timed-out request can never leave a stale slot behind for a later reply to
 * satisfy — that desynchronises the queue and pairs every subsequent response
 * with the wrong request. */
let pending = [];

async function readLoop() {
  const decoder = new TextDecoderStream();
  readableClosed = port.readable.pipeTo(decoder.writable);
  reader = decoder.readable.getReader();
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) {
        lineBuffer += value;
        let idx;
        while ((idx = lineBuffer.indexOf('\n')) >= 0) {
          const line = lineBuffer.slice(0, idx).trim();
          lineBuffer = lineBuffer.slice(idx + 1);
          if (!line) continue;
          // The device shares this line with its ESP-IDF boot log and panic
          // handler, so only actual protocol replies may satisfy a pending
          // request — anything else is surfaced as device output instead of
          // being parsed as a response.
          if (line.startsWith('{') && pending.length) {
            const entry = pending.shift();
            clearTimeout(entry.timer);
            entry.resolve(line);
          } else {
            trace('device', line, /error|panic|abort|assert/i.test(line));
          }
        }
      }
    }
  } catch (e) {
    trace('serial', `read loop ended: ${e.message}`, true);
  }
}

async function connectSerial() {
  if (!serialSupported) {
    fail('serial', 'WebSerial is not supported in this browser',
         "This browser can't talk to USB devices — try Chrome or Edge, or use a paper oracle.");
    return;
  }
  try {
    port = await navigator.serial.requestPort();
    await port.open({ baudRate: 115200 });
    const encoder = new TextEncoderStream();
    encoder.readable.pipeTo(port.writable);
    writer = encoder.writable.getWriter();
    readLoop();
    setConnected(true, 'oracle connected');
    trace('serial', 'WebSerial port opened @ 115200 baud');
  } catch (e) {
    // Dismissing the browser's own port picker is a choice, not a fault: it
    // throws NotFoundError, and toasting an error over it would be nagging.
    if (e.name === 'NotFoundError') trace('serial', 'no port chosen');
    else fail('serial', `connection failed: ${e.message}`, 'Could not open the oracle — is it plugged in?');
  }
}

async function disconnectSerial() {
  try {
    if (reader) await reader.cancel();
    if (writer) await writer.close();
    if (port) await port.close();
  } catch (e) { /* best-effort teardown */ }
  for (const entry of pending.splice(0)) {
    clearTimeout(entry.timer);
    entry.reject(new Error('serial port closed'));
  }
  port = null; writer = null; reader = null;
  setConnected(false, 'oracle disconnected');
  clearResult();          // the oracle is gone; its password should not linger
  trace('serial', 'port closed');
}

async function sendToOracle(payloadObj, timeoutMs = 30000) {
  if (!writer) throw new Error('serial port not open');
  const line = JSON.stringify(payloadObj) + '\n';
  const entry = {};
  const responsePromise = new Promise((resolve, reject) => {
    entry.resolve = resolve;
    entry.reject = reject;
    entry.timer = setTimeout(() => {
      const i = pending.indexOf(entry);
      if (i >= 0) pending.splice(i, 1);
      reject(new Error('oracle response timed out'));
    }, timeoutMs);
  });
  pending.push(entry);
  await writer.write(line);
  const raw = await responsePromise;
  return JSON.parse(raw);
}

connectBtn.onclick = connectSerial;
disconnectBtn.onclick = disconnectSerial;
connectBtn.disabled = !serialSupported;

// Reclaim the header pill whenever the route leaves paper mode.
document.addEventListener('oraclechange', (e) => {
  if (e.detail.choice !== 'hardware') return;
  connDot.className = 'dot' + (writer ? ' live' : '');
  connLabel.textContent = writer ? 'oracle connected' : 'oracle disconnected';
  document.getElementById('homeStep2').classList.toggle('done', !!writer);
  setReady(writer ? 'Oracle connected and ready' : 'Oracle not connected yet', !!writer);
});

/* ---------------------------------------------------------------------
 * Simulated oracle (in-browser, ephemeral session key — for testing
 * without hardware). The scalar lives only in memory for this tab.
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
/* The oracle chosen on the home page decides which path this runs. */
document.getElementById('deriveBtn').onclick = () =>
  runDerivation(getOracleChoice() === 'paper' ? 'sheet' : 'hardware');

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
/* mode: 'hardware' | 'simulator' | 'sheet' */
async function runDerivation(mode) {
  const useSimulator = mode === 'simulator';
  const useSheet = mode === 'sheet';
  const passphrase = document.getElementById('passphrase').value;
  const deriveBtn = document.getElementById('deriveBtn');
  const simBtn = document.getElementById('simBtn');

  if (!passphrase) {
    fail('input', 'master passphrase is required', 'Type your secret phrase first.');
    return;
  }

  /* The index goes into the hash input and the HKDF salt, so it has to be
   * exactly what the user meant. parseInt was too forgiving: "12x" silently
   * became 12, and anything non-numeric became NaN, which stringifies to
   * "NaN" and derives a password from it. Require a plain non-negative
   * integer, and keep it inside the range the firmware's `long` can hold.
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
  if (mode === 'hardware' && !writer) {
    fail('input', 'no oracle connected — connect your hardware oracle, load your paper oracle, or try the demo',
         'No oracle connected — set one up on the home page, or try the demo.');
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
    `source: ${useSimulator ? 'demo simulator' : useSheet ? 'your paper oracle' : 'your hardware oracle'}`;

  try {
    trace('1/7', `hashing "${index}" to a ristretto255 point`);
    const msg = concatBytes(utf8ToBytes(passphrase), utf8ToBytes('||'), utf8ToBytes(String(index)));
    const P = hashToRistretto255(msg, { DST: 'oprf-vaultless-pwd-v1-HashToGroup' });

    let S;
    if (useSheet) {
      /* With k in hand there is no second party, so no blinding and no proof:
       * the browser computes k·P itself. The blinding in the oracle path
       * cancels — r⁻¹·(k·(r·P)) = k·P — so this lands on exactly the same
       * point, and therefore exactly the same password, as the hardware. */
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

    trace('3/7', `sending {point} to ${useSimulator ? 'simulator' : 'oracle'} over ${useSimulator ? 'memory' : 'WebSerial'}`);
    await vizSend('handing it over…');
    let response;
    if (useSimulator) {
      const stamping = vizOracle('the demo key is stamping it…');
      response = simulateOracle(blindedHex);
      await stamping;                                // let the animation read
    } else {
      const stamping = vizOracle('your oracle is stamping it…');
      /* Protocol v3 drops `index` from the request. The oracle never used it —
       * it multiplies the blinded point and nothing else — so carrying it only
       * told the device, its display, and anyone reading the serial line which
       * account was being unlocked. The index still reaches the derivation
       * through the hash-to-group input and the HKDF salt, where the blinding
       * already covers it.
       *
       * A device still on v2 firmware requires the field and answers
       * bad_request without it, so fall back once rather than breaking every
       * oracle in the field — and say plainly what reflashing would buy. */
      response = await sendToOracle({ point: blindedHex });
      if (response.error === 'bad_request') {
        trace('3/7', 'oracle runs v2 firmware — retrying with the account number in ' +
                     'the clear; reflash it to stop disclosing which account you open', true);
        response = await sendToOracle({ index, point: blindedHex });
      }
      await stamping;
    }
    if (response.error) throw new Error(`oracle rejected: ${response.error}`);
    if (!response.point) throw new Error('oracle response missing point');
    trace('4/7', `received B' = ${response.point.slice(0, 16)}…`);
    await vizReturn('stamped, and on its way back…', response.point);

    trace('5/7', 'verifying DLEQ proof that B\' = k·B under the pinned key');
    const Bp = await verifyOracleResponse(response, B, !useSimulator);
    trace('5/7', useSimulator ? 'proof ok (simulator, not pinned)' : 'proof ok · oracle key matches pin');

    trace('6/7', 'unblinding: S = r⁻¹·B\'');
    const rInv = invMod(r, L);
    S = Bp.multiply(rInv);
    await vizUnblind('taking the disguise off — only you can do this…',
                     bytesToHex(S.toRawBytes()));
    }

    /* One more guard covering all three paths at once — hardware, simulator and
     * paper. Anything that lands on the identity here means the shared secret
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

function showResult(pw) {
  document.getElementById('pwPlaceholder').style.display = 'none';
  const el = document.getElementById('pwOut');
  el.style.display = 'block';
  revealPassword(el, pw);
  el.classList.remove('hidden-pw');
  el.classList.remove('reveal');
  void el.offsetWidth;            // restart the entrance animation
  el.classList.add('reveal');
  const reveal = document.getElementById('revealBtn');
  reveal.disabled = false;
  reveal.textContent = 'Hide';
  document.getElementById('copyBtn').disabled = false;
  markResultFilled(true);
}

const CLIPBOARD_CLEAR_MS = 60000;
let clipboardTimer = null;

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
  const pw = document.getElementById('pwOut').textContent;
  if (!pw) return;
  await navigator.clipboard.writeText(pw);
  const btn = document.getElementById('copyBtn');
  const original = btn.textContent;
  btn.textContent = 'Copied ✓';
  setTimeout(() => (btn.textContent = original), 2400);
  toast('Copied — cleared from the clipboard in 60 seconds');
  clearTimeout(clipboardTimer);
  clipboardTimer = setTimeout(() => scrubClipboard(pw), CLIPBOARD_CLEAR_MS);
};

/* Start the presentation layer (backdrop, mode switch, meter, nicknames). */
initChrome();
initSheet();

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
