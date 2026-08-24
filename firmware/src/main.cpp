/*
 * Vaultless 2P-OPRF hardware oracle
 * LilyGO T-Display (ESP32 + ST7789 135x240)
 *
 * Protocol v2 (newline-delimited JSON over USB CDC, 115200 baud):
 *   -> {"index":0,"point":"<64 hex chars>"}
 *   <- {"point":"<64 hex>","pubkey":"<64 hex>","proof":{"c":"<64 hex>","s":"<64 hex>"}}
 *   <- {"error":"invalid_point"} | {"error":"bad_json"} | {"error":"bad_request"}
 *
 * The device holds a persistent private scalar k in NVS. It never reveals k,
 * never sees the caller's passphrase in any form, and only ever performs a
 * single scalar multiplication on a blinded (indistinguishable-from-random)
 * point.
 *
 * Every answer carries a Chaum-Pedersen DLEQ proof that log_G(Y) == log_B(B'),
 * i.e. that the same k behind the advertised public key Y produced this answer.
 * Without it the caller cannot distinguish k*B from any other point, and a
 * swapped or faulty device silently yields different passwords. The browser
 * additionally pins Y on first use, which is what makes device substitution
 * detectable — the proof alone would be satisfied by a hostile device proving
 * consistency with its own key.
 *
 * NOTE: requests are auto-approved — there is no physical confirmation step.
 * Possession of the connected device is therefore the only second factor;
 * anything able to talk to this serial port can obtain k*B for any point it
 * chooses.
 */

#include <Arduino.h>
#include <TFT_eSPI.h>
#include <ArduinoJson.h>
#include <Preferences.h>
#include <esp_system.h>
#include <string.h>

extern "C" {
  #include "sodium.h"
}

// How long the matrix handshake animation runs before the answer is sent.
static const uint32_t HANDSHAKE_ANIM_MS = 1100;

TFT_eSPI tft = TFT_eSPI();
Preferences prefs;

static uint8_t g_privkey[32]; // persistent ristretto255 scalar k
static uint8_t g_pubkey[32];  // Y = k*G, advertised to the caller and pinned by it

// ---------------------------------------------------------------------------
// Hex helpers
// ---------------------------------------------------------------------------
static bool hexToBytes(const String &hex, uint8_t *out, size_t outLen) {
  if (hex.length() != outLen * 2) return false;
  for (size_t i = 0; i < outLen; i++) {
    char hi = hex[2 * i];
    char lo = hex[2 * i + 1];
    auto nib = [](char c) -> int {
      if (c >= '0' && c <= '9') return c - '0';
      if (c >= 'a' && c <= 'f') return c - 'a' + 10;
      if (c >= 'A' && c <= 'F') return c - 'A' + 10;
      return -1;
    };
    int h = nib(hi), l = nib(lo);
    if (h < 0 || l < 0) return false;
    out[i] = (uint8_t)((h << 4) | l);
  }
  return true;
}

static String bytesToHex(const uint8_t *data, size_t len) {
  static const char *hexchars = "0123456789abcdef";
  String s;
  s.reserve(len * 2);
  for (size_t i = 0; i < len; i++) {
    s += hexchars[(data[i] >> 4) & 0xF];
    s += hexchars[data[i] & 0xF];
  }
  return s;
}

// ---------------------------------------------------------------------------
// Persistent key management (NVS)
// ---------------------------------------------------------------------------
static bool hasStoredPrivateKey() {
  prefs.begin("oprf", true);
  const bool present = (prefs.getBytesLength("privkey") == 32);
  prefs.end();
  return present;
}

static void loadOrCreatePrivateKey() {
  prefs.begin("oprf", false);
  size_t stored = prefs.getBytesLength("privkey");
  if (stored == 32) {
    prefs.getBytes("privkey", g_privkey, 32);
  } else {
    // Generate a fresh scalar using the hardware RNG, reduced into the
    // ristretto255 scalar field via libsodium's wide-reduction helper
    // (feed 64 random bytes in, get a uniformly distributed 32-byte
    // scalar mod L out — avoids modulo bias from a naive 32-byte reduce).
    uint8_t wide[64];
    randombytes_buf(wide, sizeof(wide));
    crypto_core_ristretto255_scalar_reduce(g_privkey, wide);
    prefs.putBytes("privkey", g_privkey, 32);
    sodium_memzero(wide, sizeof(wide));
  }
  prefs.end();

  // Y = k*G. Advertised with every answer and pinned by the browser on first
  // use; deriving it here means k itself is touched only inside libsodium.
  if (crypto_scalarmult_ristretto255_base(g_pubkey, g_privkey) != 0) {
    tft.setTextColor(TFT_RED, TFT_BLACK);
    tft.drawString("bad private key in NVS", 4, 4);
    while (true) { delay(1000); }
  }
}

// ---------------------------------------------------------------------------
// Display helpers
// ---------------------------------------------------------------------------
static void tftBanner() {
  tft.fillScreen(TFT_BLACK);
  tft.setTextColor(TFT_CYAN, TFT_BLACK);
  tft.setTextDatum(TL_DATUM);
  tft.setTextFont(2);
  tft.drawString("VAULTLESS ORACLE", 4, 4);
  tft.drawFastHLine(0, 20, tft.width(), TFT_DARKGREY);
  tft.setTextColor(TFT_GREEN, TFT_BLACK);
  tft.drawString("idle - waiting for request", 4, 28);
}

static void showRequest(long index) {
  tft.fillScreen(TFT_BLACK);
  tft.setTextColor(TFT_CYAN, TFT_BLACK);
  tft.setTextFont(2);
  tft.drawString("DERIVATION REQUEST", 4, 4);
  tft.drawFastHLine(0, 20, tft.width(), TFT_DARKGREY);

  char idxbuf[24];
  snprintf(idxbuf, sizeof(idxbuf), "index: %ld", index);
  tft.setTextColor(TFT_YELLOW, TFT_BLACK);
  tft.drawString(idxbuf, 4, 46);

  tft.setTextColor(TFT_GREEN, TFT_BLACK);
  tft.drawString("auto-approving...", 4, 90);
}

static void showStatus(const String &line, uint16_t color) {
  tft.fillRect(0, 124, tft.width(), 16, TFT_BLACK);
  tft.setTextColor(color, TFT_BLACK);
  tft.drawString(line, 4, 124);
}

// ---------------------------------------------------------------------------
// Matrix rain — played while the oracle "works" on a handshake.
//
// Drawn straight to the panel (no sprite) to keep RAM free: each column tracks
// only its head row, fall speed and trail length. Per step a column redraws a
// bright head glyph, re-tints the two glyphs behind it, and blanks the cell
// that just fell off the end of its trail.
// ---------------------------------------------------------------------------
static const uint8_t MTX_CHAR_W = 6;   // font 1 cell size at textsize 1
static const uint8_t MTX_CHAR_H = 8;
static const uint8_t MTX_MAX_COLS = 40;

static int16_t mtxHead[MTX_MAX_COLS];
static uint8_t mtxSpeed[MTX_MAX_COLS];
static uint8_t mtxLen[MTX_MAX_COLS];
static uint8_t mtxTick[MTX_MAX_COLS];

static char randGlyph() {
  static const char glyphs[] =
      "0123456789ABCDEFGHJKLMNPQRSTUVWXYZ<>*/+=$#@&%";
  return glyphs[random(sizeof(glyphs) - 1)];
}

static void matrixRain(uint32_t durationMs, long index) {
  const int wCols = tft.width() / MTX_CHAR_W;
  const uint8_t cols = (uint8_t)(wCols > MTX_MAX_COLS ? MTX_MAX_COLS : wCols);
  const uint8_t rows = (uint8_t)(tft.height() / MTX_CHAR_H);

  tft.fillScreen(TFT_BLACK);
  tft.setTextFont(1);
  tft.setTextSize(1);
  tft.setTextDatum(TL_DATUM);

  for (uint8_t c = 0; c < cols; c++) {
    mtxHead[c]  = -(int16_t)random(rows);
    mtxSpeed[c] = 1 + (uint8_t)random(3);
    mtxLen[c]   = 4 + (uint8_t)random(rows > 6 ? rows - 4 : 4);
    mtxTick[c]  = (uint8_t)random(mtxSpeed[c] + 1);
  }

  const uint16_t headCol = tft.color565(200, 255, 225);
  const uint16_t bodyCol = tft.color565(0, 200, 130);
  const uint16_t tailCol = tft.color565(0, 90, 60);

  char buf[2] = {0, 0};
  const uint32_t start = millis();

  while (millis() - start < durationMs) {
    for (uint8_t c = 0; c < cols; c++) {
      if (++mtxTick[c] < mtxSpeed[c]) continue;
      mtxTick[c] = 0;

      const int16_t head = mtxHead[c];
      const int16_t x = c * MTX_CHAR_W;

      if (head - 3 >= 0 && head - 3 < rows) {
        buf[0] = randGlyph();
        tft.setTextColor(tailCol, TFT_BLACK);
        tft.drawString(buf, x, (head - 3) * MTX_CHAR_H);
      }
      if (head - 1 >= 0 && head - 1 < rows) {
        buf[0] = randGlyph();
        tft.setTextColor(bodyCol, TFT_BLACK);
        tft.drawString(buf, x, (head - 1) * MTX_CHAR_H);
      }
      if (head >= 0 && head < rows) {
        buf[0] = randGlyph();
        tft.setTextColor(headCol, TFT_BLACK);
        tft.drawString(buf, x, head * MTX_CHAR_H);
      }

      const int16_t tail = head - mtxLen[c];
      if (tail >= 0 && tail < rows) {
        tft.fillRect(x, tail * MTX_CHAR_H, MTX_CHAR_W, MTX_CHAR_H, TFT_BLACK);
      }

      mtxHead[c]++;
      if (mtxHead[c] - mtxLen[c] > rows) {
        mtxHead[c]  = -(int16_t)random(6);
        mtxSpeed[c] = 1 + (uint8_t)random(3);
        mtxLen[c]   = 4 + (uint8_t)random(rows > 6 ? rows - 4 : 4);
      }
    }
    delay(28);
  }

  // Settle on a legible summary of what was just evaluated.
  tft.fillScreen(TFT_BLACK);
  tft.setTextFont(2);
  tft.setTextColor(tft.color565(0, 220, 140), TFT_BLACK);
  tft.drawString("k . B", 4, 30);
  char idxbuf[24];
  snprintf(idxbuf, sizeof(idxbuf), "index: %ld", index);
  tft.setTextColor(TFT_WHITE, TFT_BLACK);
  tft.drawString(idxbuf, 4, 52);
}

// ---------------------------------------------------------------------------
// Chaum-Pedersen DLEQ proof that log_G(Y) == log_B(B') == k.
//
//   t  <- random scalar
//   T1 = t*G,  T2 = t*B
//   c  = H(DST || Y || B || B' || T1 || T2)  reduced mod L
//   s  = t + c*k  mod L
//
// Verifier recomputes T1' = s*G - c*Y and T2' = s*B - c*B' and checks that
// hashing those reproduces c. Byte encodings must match the browser exactly:
// every scalar is 32-byte little-endian, every point a 32-byte ristretto255
// encoding, and the challenge is a 64-byte SHA-512 digest wide-reduced mod L
// (crypto_core_ristretto255_scalar_reduce == interpreting the digest as a
// little-endian integer mod L, which is what the browser's
// bytesToNumberLE(h) % L does).
// ---------------------------------------------------------------------------
static const char DLEQ_DST[] = "oprf-vaultless-dleq-v1";

static void dleqChallenge(const uint8_t Y[32], const uint8_t B[32],
                          const uint8_t Bp[32], const uint8_t T1[32],
                          const uint8_t T2[32], uint8_t outScalar[32]) {
  const size_t dstLen = sizeof(DLEQ_DST) - 1; // no NUL
  uint8_t buf[dstLen + 32 * 5];
  size_t off = 0;
  memcpy(buf + off, DLEQ_DST, dstLen); off += dstLen;
  memcpy(buf + off, Y,  32); off += 32;
  memcpy(buf + off, B,  32); off += 32;
  memcpy(buf + off, Bp, 32); off += 32;
  memcpy(buf + off, T1, 32); off += 32;
  memcpy(buf + off, T2, 32); off += 32;

  uint8_t digest[64];
  crypto_hash_sha512(digest, buf, off);
  crypto_core_ristretto255_scalar_reduce(outScalar, digest);
  sodium_memzero(digest, sizeof(digest));
}

// Returns false if any group operation fails (degenerate scalar/point).
static bool dleqProve(const uint8_t B[32], const uint8_t Bp[32],
                      const uint8_t Y[32], uint8_t outC[32], uint8_t outS[32]) {
  uint8_t t[32], T1[32], T2[32], ck[32];
  crypto_core_ristretto255_scalar_random(t);

  if (crypto_scalarmult_ristretto255_base(T1, t) != 0) { sodium_memzero(t, 32); return false; }
  if (crypto_scalarmult_ristretto255(T2, t, B) != 0)   { sodium_memzero(t, 32); return false; }

  dleqChallenge(Y, B, Bp, T1, T2, outC);
  crypto_core_ristretto255_scalar_mul(ck, outC, g_privkey);
  crypto_core_ristretto255_scalar_add(outS, t, ck);

  sodium_memzero(t, sizeof(t));
  sodium_memzero(ck, sizeof(ck));
  return true;
}

// ---------------------------------------------------------------------------
// Core OPRF evaluation: B' = k * B
// ---------------------------------------------------------------------------
static bool evaluate(const uint8_t *blindedPoint32, uint8_t *outPoint32) {
  // crypto_scalarmult_ristretto255 returns -1 if the input is not a valid
  // ristretto255 element (e.g. a malformed/malicious point), which we
  // must reject rather than silently operate on.
  int rc = crypto_scalarmult_ristretto255(outPoint32, g_privkey, blindedPoint32);
  return rc == 0;
}

// ---------------------------------------------------------------------------
// Serial request handling
// ---------------------------------------------------------------------------
static void sendJsonError(const char *err) {
  StaticJsonDocument<128> doc;
  doc["error"] = err;
  serializeJson(doc, Serial);
  Serial.print('\n');
}

static void sendJsonPoint(const uint8_t *point32,
                          const uint8_t *proofC32, const uint8_t *proofS32) {
  StaticJsonDocument<512> doc;
  doc["point"]  = bytesToHex(point32, 32);
  doc["pubkey"] = bytesToHex(g_pubkey, 32);
  JsonObject proof = doc["proof"].to<JsonObject>(); // ArduinoJson 7 idiom
  proof["c"] = bytesToHex(proofC32, 32);
  proof["s"] = bytesToHex(proofS32, 32);
  serializeJson(doc, Serial);
  Serial.print('\n');
}

static void handleLine(const String &line) {
  StaticJsonDocument<512> doc;
  DeserializationError err = deserializeJson(doc, line);
  if (err) {
    sendJsonError("bad_json");
    return;
  }

#ifdef VAULTLESS_ALLOW_PROVISION
  // One-time key import, present only in env:esp32dev-provision. Refuses once a
  // key exists, so it cannot be used to overwrite a live oracle — but a build
  // carrying it must never be left on the device: against a *blank* device it
  // lets whoever reaches the serial port choose k, and a caller who then pins
  // that public key would be deriving passwords the attacker can reproduce.
  {
    const char *cmd = doc["cmd"] | "";
    if (strcmp(cmd, "provision") == 0) {
      if (hasStoredPrivateKey()) {
        sendJsonError("already_provisioned");
        return;
      }
      const char *keyHexC = doc["key"] | "";
      String keyHex = String(keyHexC);
      uint8_t k[32];
      if (keyHex.length() != 64 || !hexToBytes(keyHex, k, 32)) {
        sodium_memzero(k, sizeof(k));
        sendJsonError("bad_key");
        return;
      }
      uint8_t probe[32];
      if (crypto_scalarmult_ristretto255_base(probe, k) != 0) {
        sodium_memzero(k, sizeof(k));
        sendJsonError("bad_key");   // zero or otherwise degenerate scalar
        return;
      }
      prefs.begin("oprf", false);
      prefs.putBytes("privkey", k, 32);
      prefs.end();
      memcpy(g_privkey, k, 32);
      memcpy(g_pubkey, probe, 32);
      sodium_memzero(k, sizeof(k));

      StaticJsonDocument<128> res;
      res["pubkey"] = bytesToHex(g_pubkey, 32);
      serializeJson(res, Serial);
      Serial.print('\n');
      showStatus("provisioned", TFT_GREEN);
      return;
    }
  }
#endif

  long index = doc["index"] | -1;
  const char *pointHexC = doc["point"] | "";

  String pointHex = String(pointHexC);

  if (index < 0 || pointHex.length() != 64) {
    sendJsonError("bad_request");
    return;
  }

  uint8_t blinded[32];
  if (!hexToBytes(pointHex, blinded, 32)) {
    sendJsonError("bad_hex");
    return;
  }

  showRequest(index);
  delay(220);

  // Requests are auto-approved: the scalar mult runs first, then the matrix
  // handshake plays before the answer goes back over the wire.
  uint8_t result[32];
  const bool ok = evaluate(blinded, result);

  matrixRain(HANDSHAKE_ANIM_MS, index);

  if (!ok) {
    showStatus("invalid point!", TFT_RED);
    sendJsonError("invalid_point");
    delay(1500);
    tftBanner();
    return;
  }

  uint8_t proofC[32], proofS[32];
  if (!dleqProve(blinded, result, g_pubkey, proofC, proofS)) {
    showStatus("proof failed!", TFT_RED);
    sendJsonError("proof_failed");
    delay(1500);
    tftBanner();
    return;
  }

  showStatus("approved - sent", TFT_GREEN);
  sendJsonPoint(result, proofC, proofS);
  delay(900);
  tftBanner();
}

// ---------------------------------------------------------------------------
// Arduino entry points
// ---------------------------------------------------------------------------
static String g_lineBuf;

void setup() {
  Serial.begin(115200);
  uint32_t bootStart = millis();
  while (!Serial && millis() - bootStart < 2000) { delay(10); }

  randomSeed(esp_random()); // vary the matrix rain between boots

  tft.init();
  tft.setRotation(1);
  tft.fillScreen(TFT_BLACK);

  if (sodium_init() < 0) {
    tft.setTextColor(TFT_RED, TFT_BLACK);
    tft.drawString("libsodium init FAILED", 4, 4);
    while (true) { delay(1000); }
  }

  loadOrCreatePrivateKey();
  tftBanner();
}

void loop() {
  while (Serial.available()) {
    char c = (char)Serial.read();
    if (c == '\n') {
      g_lineBuf.trim();
      if (g_lineBuf.length() > 0) {
        handleLine(g_lineBuf);
      }
      g_lineBuf = "";
    } else if (c != '\r') {
      g_lineBuf += c;
      if (g_lineBuf.length() > 1024) g_lineBuf = ""; // guard against garbage
    }
  }
}

// ---------------------------------------------------------------------------
// ESP-IDF entry point. Building against "framework = arduino, espidf" (as
// opposed to plain "arduino") skips PlatformIO's usual auto-generated
// app_main() shim, so it's provided here directly.
// ---------------------------------------------------------------------------
extern "C" void app_main() {
  initArduino();
  setup();
  while (true) {
    loop();
    // loop() returns immediately when no serial data is waiting, so without
    // this the main task spins at 100% on CPU 0, starves IDLE0 and trips the
    // task watchdog every 5s ("Task watchdog got triggered ... IDLE0").
    delay(1);
  }
}
