/* Printable recovery sheet: the oracle key on paper instead of in hardware.
 *
 * The sheet carries k itself. With k in hand the browser computes S = k*P
 * directly — there is no second party left to hide the input from, so no
 * blinding is needed, and the result is identical to what the hardware oracle
 * returns (the blinding cancels: r⁻¹·(k·(r·P)) = k·P). A sheet is therefore a
 * true backup of a device, not a separate mode with separate passwords.
 *
 * What it costs, stated plainly because the UI must not imply otherwise:
 * k enters this machine on every scan, and a photograph of the sheet is a
 * perfect clone. The hardware oracle exists precisely to prevent both. This is
 * the paper-key model (password + high-entropy key file), which is sound, but
 * it is weaker than the device against a compromised computer or a camera.
 *
 * k is NEVER written to storage — not localStorage, not sessionStorage, not a
 * cookie. It lives in one module-scoped variable, is wiped by an idle timer,
 * and never appears in the protocol trace.
 */

import { sha256, sha512, bytesToHex, utf8ToBytes, concatBytes, RistrettoPoint,
         bytesToNumberLE, numberToBytesLE } from './vendor/noble-bundle.js';
import { qrcode, jsQR } from './vendor/qr-bundle.js';

const L = 2n ** 252n + 27742317777372353535851937790883648493n;

/* ------------------------------------------------------------------ codec */
/* Crockford base32: no I, L, O or U, so nothing in the printed string can be
 * confused for something else when read back by eye or by hand. */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const PREFIX = 'VLT1';
const CHECK_DST = 'vaultless-recovery-v1';

function b32encode(bytes) {
  let out = '', bits = 0, value = 0;
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) { out += ALPHABET[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

function b32decode(str) {
  let bits = 0, value = 0;
  const out = [];
  for (const ch of str) {
    const idx = ALPHABET.indexOf(ch);
    if (idx < 0) throw new Error(`unexpected character “${ch}” in the code`);
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  // 36 bytes need 58 characters, which carry 290 bits — the last two are
  // padding. Requiring them to be zero keeps one key to exactly one string, so
  // two sheets for the same key always read the same and a corrupted final
  // character is reported rather than quietly absorbed.
  if (bits > 0 && (value & ((1 << bits) - 1)) !== 0) {
    throw new Error('the last character of the code is not valid');
  }
  return Uint8Array.from(out);
}

function checksum(k32) {
  return sha256(concatBytes(utf8ToBytes(CHECK_DST), k32)).slice(0, 4);
}

/* Short public identifier for a key: SHA-256(k*G) truncated. Printed on the
 * sheet in the clear so a sheet can be matched to a device — or to another
 * sheet — without scanning it, and so the app can refuse a sheet that is not
 * the oracle this browser has pinned. Derived from the PUBLIC key only. */
export function fingerprint(kScalar) {
  const Y = RistrettoPoint.BASE.multiply(kScalar).toRawBytes();
  const h = bytesToHex(sha256(Y)).slice(0, 8);
  return `${h.slice(0, 4)}-${h.slice(4, 8)}`;
}

export function encodeRecovery(k32) {
  if (k32.length !== 32) throw new Error('key must be 32 bytes');
  return PREFIX + '-' + b32encode(concatBytes(k32, checksum(k32)));
}

/* Forgiving on the way in: any case, any separators, and the Crockford
 * substitutions people actually make when copying by hand. */
export function decodeRecovery(text) {
  let s = String(text).toUpperCase().replace(/[^0-9A-Z]/g, '');
  if (s.startsWith(PREFIX)) s = s.slice(PREFIX.length);
  else if (s.startsWith('VLT')) throw new Error('this looks like a different sheet version');
  s = s.replace(/[IL]/g, '1').replace(/O/g, '0');
  if (s.includes('U')) throw new Error('unexpected character “U” in the code');
  if (!s.length) throw new Error('no code found');

  const bytes = b32decode(s);
  if (bytes.length < 36) throw new Error('code is too short — some characters are missing');
  const k32 = bytes.slice(0, 32);
  const want = checksum(k32);
  const got = bytes.slice(32, 36);
  for (let i = 0; i < 4; i++) {
    if (want[i] !== got[i]) {
      // Without this the sheet would still decode, to a *different* key, and
      // silently produce wrong passwords with no error anywhere.
      throw new Error('checksum failed — the code was mistyped or misread');
    }
  }
  const scalar = bytesToNumberLE(k32) % L;
  if (scalar === 0n) throw new Error('this code does not contain a usable key');
  return scalar;
}

/* Uniform scalar in [1, L).
 *
 * The system CSPRNG is always the base, and anything the user contributes is
 * folded in on top of it — never in place of it. That ordering is the whole
 * safety property here: hashing extra material together with 64 fresh
 * crypto.getRandomValues bytes cannot make the result more predictable than
 * those bytes alone, however poor or repetitive the extra material is. A hand
 * drawing a squiggle produces far less entropy than people imagine, and it is
 * biased and partly observable; treated as a supplement it is a free
 * improvement, treated as a source it would be a downgrade.
 *
 * Reduction is over a full 64-byte digest, matching the firmware, never a
 * 32-byte reduce (biased by roughly 6%).
 */
const KEY_MIX_DST = 'vaultless-key-mix-v1';

export function generateKey(extra) {
  for (let ctr = 0; ctr < 8; ctr++) {
    const sys = new Uint8Array(64);
    crypto.getRandomValues(sys);
    const digest = sha512(concatBytes(
      utf8ToBytes(KEY_MIX_DST),
      Uint8Array.of(ctr),
      sys,
      extra && extra.length ? extra : new Uint8Array(0),
    ));
    const k = bytesToNumberLE(digest) % L;
    if (k !== 0n) return k;
  }
  throw new Error('could not generate a key');
}

/* ------------------------------------------------------ drawn entropy */
/* Records where and when a pointer moved. Positions alone are weak and heavily
 * correlated, so timing deltas go in too, and the estimate below is
 * deliberately pessimistic — it decides when the UI stops asking, not how
 * strong the key is. */
export function createEntropyCollector({ target = 320 } = {}) {
  const bytes = [];
  let count = 0, last = null;

  function push16(v) { bytes.push(v & 255, (v >>> 8) & 255); }

  return {
    /* Returns true if this sample was taken (far enough from the previous). */
    sample(x, y, t) {
      const xi = Math.round(x), yi = Math.round(y);
      if (last) {
        const dx = xi - last.x, dy = yi - last.y;
        if (dx * dx + dy * dy < 9) return false;   // ignore jitter and repeats
      }
      const dt = last ? Math.min(65535, Math.round((t - last.t) * 1000)) : 0;
      push16(xi); push16(yi); push16(dt);
      last = { x: xi, y: yi, t };
      count++;
      return true;
    },
    get count() { return count; },
    get progress() { return Math.min(1, count / target); },
    get done() { return count >= target; },
    take() { return Uint8Array.from(bytes); },
    reset() { bytes.length = 0; count = 0; last = null; },
  };
}

export function scalarTo32(k) {
  return numberToBytesLE(((k % L) + L) % L, 32);
}

/* ------------------------------------------------------------- QR drawing */
export function drawQR(canvas, text, scale = 6) {
  const qr = qrcode(0, 'H');            // highest error correction: it is paper
  qr.addData(text, 'Alphanumeric');
  qr.make();
  const n = qr.getModuleCount();
  const quiet = 4;
  const size = (n + quiet * 2) * scale;
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, size, size);
  ctx.fillStyle = '#000000';
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (qr.isDark(r, c)) {
        ctx.fillRect((c + quiet) * scale, (r + quiet) * scale, scale, scale);
      }
    }
  }
  return { modules: n, version: (n - 17) / 4 };
}

/* ---------------------------------------------------------------- scanner */
/* Prefers the browser's native detector; falls back to the vendored decoder so
 * Safari and Firefox still work. Manual entry always remains available. */
export function createScanner({ video, canvas, onResult, onError }) {
  let stream = null, raf = null, detector = null, stopped = false;

  async function start() {
    stopped = false;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment' }, audio: false,
      });
    } catch (e) {
      onError(e.name === 'NotAllowedError'
        ? 'Camera permission was denied — you can type the code instead.'
        : 'No camera available — you can type the code instead.');
      return false;
    }
    video.srcObject = stream;
    video.setAttribute('playsinline', '');
    await video.play().catch(() => {});
    if (typeof BarcodeDetector !== 'undefined') {
      try { detector = new BarcodeDetector({ formats: ['qr_code'] }); } catch { detector = null; }
    }
    raf = requestAnimationFrame(tick);
    return true;
  }

  async function tick() {
    if (stopped) return;
    raf = requestAnimationFrame(tick);
    if (!video.videoWidth) return;
    try {
      if (detector) {
        const found = await detector.detect(video);
        if (found.length) return hit(found[0].rawValue);
      } else {
        const w = canvas.width = video.videoWidth;
        const h = canvas.height = video.videoHeight;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(video, 0, 0, w, h);
        const res = jsQR(ctx.getImageData(0, 0, w, h).data, w, h);
        if (res) return hit(res.data);
      }
    } catch { /* a bad frame is not an error worth surfacing */ }
  }

  function hit(value) { stop(); onResult(value); }

  function stop() {
    stopped = true;
    if (raf) cancelAnimationFrame(raf);
    raf = null;
    if (stream) for (const t of stream.getTracks()) t.stop();
    stream = null;
    video.srcObject = null;
  }

  return { start, stop };
}
