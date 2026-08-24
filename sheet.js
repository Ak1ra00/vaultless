/* UI for the paper oracle — the printed square that stands in for the gadget.
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
  drawQR, createScanner,
} from './recovery.js';
import { toast } from './ui.js';

const $ = (id) => document.getElementById(id);
const IDLE_MS = 5 * 60 * 1000;

let sheetKey = null;
let idleTimer = null;
let scanner = null;

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

function forgetKey() {
  sheetKey = null;
  clearTimeout(idleTimer);
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
  $('card4').classList.toggle('done', loaded);
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

/* -------------------------------------------------------------- creating */
function createSheet() {
  const k = generateKey();
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
  renderStatus();

  $('sheetBtn').onclick = () => {
    const panel = $('sheetPanel');
    const open = panel.style.display !== 'none';
    panel.style.display = open ? 'none' : '';
    if (open) stopScan();
    else if (!sheetKey) startScan();
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
