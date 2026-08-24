/* Crypto is vendored, never fetched from a CDN — see vendor/VENDOR.md.
 * A third party able to serve script to this page could read the master
 * passphrase and every derived password, so nothing here loads cross-origin. */
import {
  RistrettoPoint, hashToRistretto255, ed25519,
  bytesToHex, hexToBytes, bytesToNumberLE, numberToBytesLE,
  utf8ToBytes, concatBytes, invert, hkdf, sha256, sha512,
} from './vendor/noble-bundle.js';
import {
  initChrome, toast, setDemo, markResultFilled,
  vizStart, vizOracle, vizReturn, vizDone, vizReset,
} from './ui.js';
import { initSheet, getSheetKey } from './sheet.js';

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
const PIN_KEY = 'vaultless.oracle.pubkey.v1';

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
 * oracle and the printed recovery sheet. It is what catches a substituted
 * device, and equally a sheet that is not the one this browser has been using —
 * scanning last year's sheet would otherwise derive different passwords with no
 * error anywhere. */
function enforcePin(pubkeyHex, whatItIs) {
  let pinned = null;
  try { pinned = localStorage.getItem(PIN_KEY); } catch { /* private mode */ }
  if (!pinned) {
    try { localStorage.setItem(PIN_KEY, pubkeyHex); } catch { /* private mode */ }
    trace('pin', `pinned ${whatItIs} ${pubkeyHex.slice(0, 16)}… (first use)`);
    return;
  }
  if (pinned === pubkeyHex) return;
  const okToRepin = confirm(
    `WARNING: this ${whatItIs} is not the one previously pinned.\n\n` +
    `pinned: ${pinned.slice(0, 24)}…\n` +
    `this:   ${pubkeyHex.slice(0, 24)}…\n\n` +
    'A different key derives DIFFERENT passwords. Only continue if you ' +
    'deliberately replaced it. Trust this key from now on?');
  if (!okToRepin) throw new Error(`${whatItIs} public key does not match the pinned one`);
  try { localStorage.setItem(PIN_KEY, pubkeyHex); } catch { /* private mode */ }
  trace('pin', `re-pinned ${whatItIs} ${pubkeyHex.slice(0, 16)}…`, true);
}

function verifyOracleResponse(response, B, pin = true) {
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
  if (!dleqVerify(Y, B, Bp, c, sScalar)) {
    throw new Error('DLEQ proof failed — this device did not compute k*B with ' +
                    'the key it claims; refusing to derive');
  }
  if (!pin) return Bp;
  enforcePin(response.pubkey, 'oracle');
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
document.getElementById('clearTrace').onclick = () => {
  traceEl.innerHTML = '<div class="row"><span class="empty">— cleared —</span></div>';
};

/* ---------------------------------------------------------------------
 * WebSerial transport
 * ------------------------------------------------------------------- */
const wsBadge = document.getElementById('wsBadge');
const serialSupported = 'serial' in navigator;
wsBadge.textContent = serialSupported ? 'supported' : 'unsupported';
wsBadge.classList.add(serialSupported ? 'on' : 'warn');

let port = null, writer = null, reader = null, readableClosed = null;
const connDot = document.getElementById('connDot');
const connLabel = document.getElementById('connLabel');
const connectBtn = document.getElementById('connectBtn');
const disconnectBtn = document.getElementById('disconnectBtn');

function setConnected(state, label) {
  connDot.className = 'dot' + (state ? ' live' : '');
  connLabel.textContent = label;
  connectBtn.disabled = state;
  disconnectBtn.disabled = !state;
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
    trace('serial', 'WebSerial is not supported in this browser', true);
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
    trace('serial', `connection failed: ${e.message}`, true);
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
/* One button, whichever second factor is actually present. */
document.getElementById('deriveBtn').onclick = () =>
  runDerivation(getSheetKey() ? 'sheet' : 'hardware');

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

document.getElementById('togglePass').onclick = () => {
  const el = document.getElementById('passphrase');
  const btn = document.getElementById('togglePass');
  el.type = el.type === 'password' ? 'text' : 'password';
  btn.textContent = el.type === 'password' ? 'show' : 'hide';
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
    trace('input', 'master passphrase is required', true);
    return;
  }

  /* The index goes into the hash input and the HKDF salt, so it has to be
   * exactly what the user meant. parseInt was too forgiving: "12x" silently
   * became 12, and anything non-numeric became NaN, which stringifies to
   * "NaN" and derives a password from it. Require a plain non-negative
   * integer, and keep it inside the range the firmware's `long` can hold. */
  const rawIndex = (document.getElementById('index').value || '0').trim();
  if (!/^\d+$/.test(rawIndex)) {
    trace('input', 'index must be a non-negative whole number', true);
    return;
  }
  const index = Number(rawIndex);
  if (!Number.isSafeInteger(index) || index > 2147483647) {
    trace('input', 'index is out of range (max 2147483647)', true);
    return;
  }
  if (mode === 'hardware' && !writer) {
    trace('input', 'no oracle connected — connect your gadget, load a recovery sheet, or try the demo', true);
    return;
  }
  if (useSheet && !getSheetKey()) {
    trace('input', 'no recovery sheet loaded — scan or type your code first', true);
    return;
  }

  deriveBtn.disabled = true; simBtn.disabled = true;
  setDemo(useSimulator);
  document.getElementById('resSource').textContent =
    `source: ${useSimulator ? 'demo simulator' : useSheet ? 'recovery sheet' : 'your gadget'}`;

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
      trace('2/4', 'using the key from your recovery sheet (no oracle round trip)');
      enforcePin(bytesToHex(RistrettoPoint.BASE.multiply(k).toRawBytes()), 'recovery sheet');
      trace('3/4', 'computing S = k·P locally');
      vizStart('reading your sheet…');
      vizOracle('applying your key…');
      await new Promise(r => setTimeout(r, 450));
      S = P.multiply(k);
      vizReturn('done…');
    } else {

    trace('2/7', 'generating blinding scalar r and computing B = r·P');
    const r = randomScalar();
    const B = P.multiply(r);
    const blindedHex = bytesToHex(B.toRawBytes());
    trace('2/7', `B = ${blindedHex.slice(0, 16)}…`);

    trace('3/7', `sending {index, point} to ${useSimulator ? 'simulator' : 'oracle'} over ${useSimulator ? 'memory' : 'WebSerial'}`);
    vizStart('sending a disguised request…');
    let response;
    if (useSimulator) {
      vizOracle('the demo key is stamping it…');
      await new Promise(r => setTimeout(r, 700));   // let the animation read
      response = simulateOracle(blindedHex);
    } else {
      vizOracle('your gadget is stamping it…');
      response = await sendToOracle({ index, point: blindedHex });
    }
    if (response.error) throw new Error(`oracle rejected: ${response.error}`);
    if (!response.point) throw new Error('oracle response missing point');
    trace('4/7', `received B' = ${response.point.slice(0, 16)}…`);
    vizReturn('stamped answer coming back…');

    trace('5/7', 'verifying DLEQ proof that B\' = k·B under the pinned key');
    const Bp = verifyOracleResponse(response, B, !useSimulator);
    trace('5/7', useSimulator ? 'proof ok (simulator, not pinned)' : 'proof ok · oracle key matches pin');

    trace('6/7', 'unblinding: S = r⁻¹·B\'');
    const rInv = invMod(r, L);
    S = Bp.multiply(rInv);
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
    toast(e.message.length > 70 ? 'Could not make a password — see the trace' : e.message);
  } finally {
    deriveBtn.disabled = false; simBtn.disabled = false;
  }
}

function showResult(pw) {
  document.getElementById('pwPlaceholder').style.display = 'none';
  const el = document.getElementById('pwOut');
  el.style.display = 'block';
  el.textContent = pw;
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
document.getElementById('copyBtn').onclick = async () => {
  const pw = document.getElementById('pwOut').textContent;
  if (!pw) return;
  await navigator.clipboard.writeText(pw);
  const btn = document.getElementById('copyBtn');
  const original = btn.textContent;
  btn.textContent = 'Copied ✓';
  setTimeout(() => (btn.textContent = original), 1400);
  toast('Copied — clears from the clipboard in 60 seconds');
  // Best-effort clipboard scrub, so a derived password does not sit in the
  // system clipboard indefinitely. Only clears if we still own what we wrote.
  clearTimeout(clipboardTimer);
  clipboardTimer = setTimeout(async () => {
    try {
      if (await navigator.clipboard.readText() === pw) {
        await navigator.clipboard.writeText('');
        trace('clipboard', 'cleared after 60s');
      }
    } catch { /* permission denied or not focused — leave it alone */ }
  }, CLIPBOARD_CLEAR_MS);
};

/* Start the presentation layer (backdrop, mode switch, meter, nicknames). */
initChrome();
initSheet();
