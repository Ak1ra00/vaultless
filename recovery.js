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

import { sha256, bytesToHex, utf8ToBytes, concatBytes, RistrettoPoint,
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

/* Uniform scalar in [1, L), drawn the same way the firmware draws it: 64 bytes
 * wide-reduced, never a 32-byte reduce (that is biased by roughly 6%). */
export function generateKey() {
  for (;;) {
    const buf = new Uint8Array(64);
    crypto.getRandomValues(buf);
    const k = bytesToNumberLE(buf) % L;
    if (k !== 0n) return k;
  }
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
