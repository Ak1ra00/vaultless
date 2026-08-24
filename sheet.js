/* UI for the paper oracle — the printed square that stands in for a device.
 *
 * It plays the same role the hardware does: it holds k and performs the
 * handshake half of the derivation. It is not a password and no password is
 * printed on it; without the master phrase it produces nothing.
 *
 * Holds the scanned key for the session and nothing longer. k is kept in one
 * module-scoped variable and is never written to localStorage, sessionStorage,
 * a cookie, the URL, or the protocol trace — only its fingerprint is ever
 * displayed. An idle timer drops it, as does the Forget button and a reload.
 *
 * (JavaScript cannot reliably scrub a BigInt from memory; dropping the last
 * reference is the most that can be done here. On a machine you do not trust,
 * the hardware oracle is the answer, not this.)
 */

import {
  encodeRecovery, decodeRecovery, generateKey, scalarTo32, fingerprint,
  drawQR, createScanner, createEntropyCollector,
} from './recovery.js';
import { toast, pickFork, setReady } from './ui.js';

const $ = (id) => document.getElementById(id);
const IDLE_MS = 5 * 60 * 1000;

let sheetKey = null;
let idleTimer = null;
let scanner = null;

const PAPER_PANELS = { forkHave: 'panelScan', forkCreate: 'panelCreate' };

export function getSheetKey() { return sheetKey; }

function touchIdle() {
  clearTimeout(idleTimer);
  if (!sheetKey) return;
  idleTimer = setTimeout(() => {
    forgetKey();
    toast('Paper oracle cleared after 5 minutes idle');
  }, IDLE_MS);
}

function setKey(k) {
  sheetKey = k;
  renderStatus();
  touchIdle();
}

/* Wipe every rendered copy of the key.
 *
 * Dropping the scalar is only half of forgetting it. After createSheet the full
 * VLT1- code sits in #sheetCode as text and the same bytes sit in #sheetQR as
 * canvas pixels, and hiding the panel leaves both in the document. Without this
 * the idle timer announces "Paper oracle cleared" while the key is still on the
 * page, and re-opening the create fork shows the old key underneath a status
 * line reading "No paper oracle loaded". */
function clearSheetOutput() {
  $('sheetOutput').style.display = 'none';
  $('sheetCode').textContent = '';
  $('sheetFp').textContent = '';
  $('sheetDate').textContent = '';
  const qr = $('sheetQR');
  qr.getContext('2d').clearRect(0, 0, qr.width, qr.height);
  qr.width = qr.height = 0;          // drop the backing store as well as the paint
  $('createSheetBtn').textContent = 'Create my paper oracle';
  // A typed code survives a failed decode in this field; it is the key too.
  $('sheetManual').value = '';
}

function forgetKey() {
  sheetKey = null;
  clearTimeout(idleTimer);
  // Put step 1 back to its question, rather than leaving whichever branch was
  // last open sitting there with nothing loaded behind it.
  pickFork(PAPER_PANELS, null);
  stopScan();
  clearSheetOutput();
  renderStatus();
}

function renderStatus() {
  const loaded = !!sheetKey;
  $('sheetStatus').textContent = loaded
    ? `Paper oracle loaded · ${fingerprint(sheetKey)}`
    : 'No paper oracle loaded';
  $('sheetStatus').classList.toggle('good', loaded);
  $('sheetForget').style.display = loaded ? '' : 'none';
  // The source is reported on the result card; keep the button one plain verb.
  $('deriveBtn').textContent = 'Make my password';
  $('homeStep2').classList.toggle('done', loaded);
  // In paper mode the header pill and the step-1 readiness line both track the
  // paper oracle rather than the (irrelevant) WebSerial connection.
  if (document.body.classList.contains('oracle-paper')) {
    $('connDot').className = 'dot' + (loaded ? ' live' : '');
    $('connLabel').textContent = loaded ? 'paper oracle ready' : 'no paper oracle';
    setReady(loaded ? `Paper oracle ready · ${fingerprint(sheetKey)}` : 'No paper oracle loaded yet',
             loaded);
  }
}

/* ------------------------------------------------------------- accepting */
function acceptCode(text) {
  let k;
  try {
    k = decodeRecovery(text);
  } catch (e) {
    $('sheetError').textContent = e.message;
    toast(e.message);
    return false;
  }
  $('sheetError').textContent = '';
  setKey(k);
  stopScan();
  toast(`Paper oracle loaded · ${fingerprint(k)}`);
  return true;
}

/* -------------------------------------------------------------- scanning */
async function startScan() {
  $('sheetError').textContent = '';
  $('sheetScanArea').style.display = '';
  scanner = createScanner({
    video: $('sheetVideo'),
    canvas: $('sheetCanvas'),
    onResult: (value) => acceptCode(value),
    onError: (msg) => {
      $('sheetError').textContent = msg;
      $('sheetScanArea').style.display = 'none';
    },
  });
  const started = await scanner.start();
  if (!started) scanner = null;
}

function stopScan() {
  if (scanner) { scanner.stop(); scanner = null; }
  $('sheetScanArea').style.display = 'none';
}

/* ------------------------------------------------------------- entropy pad */
/* A drawing surface whose pointer track is folded into key generation. The
 * randomness is the browser's either way — see generateKey — so this cannot
 * weaken the key. What it genuinely buys is that the person watching the bar
 * fill understands a key is being made for them, right now, from something
 * only they did. */
let entropy = null;

function initEntropyPad() {
  const pad = $('entropyPad');
  const ctx = pad.getContext('2d');
  entropy = createEntropyCollector({ target: 200 });
  let drawing = false;

  const fit = () => {
    const r = pad.getBoundingClientRect();
    const dpr = Math.min(devicePixelRatio || 1, 2);
    pad.width = Math.max(1, Math.round(r.width * dpr));
    pad.height = Math.max(1, Math.round(r.height * dpr));
    ctx.scale(dpr, dpr);
    ctx.lineWidth = 2;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = 'rgba(94,234,212,.75)';
  };
  fit();
  /* The pad starts inside a closed fork panel, so it measures 0x0 and its
   * backing store would stay that size once the panel opens. Watch the element
   * itself rather than the window, so it is re-fitted the moment it is shown. */
  let lastW = 0;
  new ResizeObserver(() => {
    const w = pad.getBoundingClientRect().width;
    if (w > 0 && Math.abs(w - lastW) > 1) { lastW = w; fit(); }
  }).observe(pad);

  function redrawHint() {
    const r = pad.getBoundingClientRect();
    ctx.clearRect(0, 0, r.width, r.height);
  }

  function render() {
    const p = entropy.progress;
    $('entropyBar').style.width = (p * 100) + '%';
    $('entropyBar').style.background = entropy.done ? 'var(--green)' : 'var(--cyan)';
    $('entropyText').textContent = entropy.done
      ? 'Enough — you can make your oracle now'
      : `Keep scribbling… ${Math.round(p * 100)}%`;
    pad.classList.toggle('full', entropy.done);
    $('createSheetBtn').disabled = !entropy.done;
  }

  const at = (e) => {
    const r = pad.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  pad.addEventListener('pointerdown', (e) => {
    drawing = true;
    pad.setPointerCapture(e.pointerId);
    const { x, y } = at(e);
    ctx.beginPath();
    ctx.moveTo(x, y);
    entropy.sample(x, y, performance.now());
    render();
  });
  pad.addEventListener('pointermove', (e) => {
    if (!drawing) return;
    const { x, y } = at(e);
    if (entropy.sample(x, y, performance.now())) {
      ctx.lineTo(x, y);
      ctx.stroke();
      render();
    }
  });
  /* Only pointerup/pointercancel end a stroke. Leaving the box mid-drag must
   * not: the pointer is captured, so events keep arriving, and a hand that
   * wanders past the edge and back should go on drawing rather than silently
   * stopping. */
  for (const ev of ['pointerup', 'pointercancel']) {
    pad.addEventListener(ev, (e) => {
      drawing = false;
      if (pad.hasPointerCapture?.(e.pointerId)) pad.releasePointerCapture(e.pointerId);
    });
  }

  $('entropyReset').onclick = () => {
    entropy.reset();
    redrawHint();
    render();
  };
  render();
}

/* -------------------------------------------------------------- creating */
function createSheet() {
  const k = generateKey(entropy ? entropy.take() : undefined);
  const code = encodeRecovery(scalarTo32(k));
  const fp = fingerprint(k);

  drawQR($('sheetQR'), code, 6);
  // Grouped for reading aloud and typing back; the decoder ignores separators.
  // Group the body only, so the VLT1- prefix stays readable as one token.
  const body = code.slice(5).replace(/(.{4})/g, '$1 ').trim();
  $('sheetCode').textContent = code.slice(0, 5) + body;
  $('sheetFp').textContent = fp;
  $('sheetDate').textContent = new Date().toISOString().slice(0, 10);
  $('sheetOutput').style.display = '';
  $('createSheetBtn').textContent = 'Create a different one';

  // Load it straight away so "print, then use it" works without rescanning.
  setKey(k);
  toast(`Paper oracle created · ${fp} — print it now`);
}

export function initSheet() {
  initEntropyPad();
  renderStatus();
  document.addEventListener('oraclechange', renderStatus);

  /* Nothing above stopped the camera when the scan screen went away: hiding the
   * <video> leaves the MediaStream live, the tracks open and the machine's
   * recording light on, which is the wrong signal for a page whose whole claim
   * is that nothing leaves the device. Tear it down whenever the screen it
   * belongs to is no longer the one being shown. */
  document.addEventListener('viewchange', stopScan);
  document.addEventListener('oraclechange', (e) => {
    if (e.detail.choice !== 'paper') stopScan();
  });

  $('forkHave').onclick = () => {
    pickFork(PAPER_PANELS, 'forkHave');
    if (!sheetKey) startScan();
  };
  $('forkCreate').onclick = () => {
    pickFork(PAPER_PANELS, 'forkCreate');
    stopScan();
  };
  $('sheetScanBtn').onclick = () => startScan();
  $('sheetStopBtn').onclick = () => stopScan();
  $('sheetForget').onclick = () => { forgetKey(); toast('Paper oracle forgotten'); };
  $('sheetManualBtn').onclick = () => {
    if (acceptCode($('sheetManual').value)) $('sheetManual').value = '';
  };
  $('sheetManual').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); $('sheetManualBtn').click(); }
  });
  $('createSheetBtn').onclick = createSheet;
  $('printSheetBtn').onclick = () => window.print();

  // Any interaction with a loaded key restarts its idle countdown.
  for (const ev of ['click', 'keydown']) document.addEventListener(ev, touchIdle, true);
  // Never leave the key live in a tab someone walked away from.
  addEventListener('pagehide', forgetKey);
}
