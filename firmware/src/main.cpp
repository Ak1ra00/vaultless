/*
 * Vaultless 2P-OPRF hardware oracle
 * LilyGO T-Display (ESP32 + ST7789 135x240)
 *
 * Protocol v3 (newline-delimited JSON over USB CDC, 115200 baud):
 *   -> {"point":"<64 hex chars>"}
 *   <- {"point":"<64 hex>","pubkey":"<64 hex>","proof":{"c":"<64 hex>","s":"<64 hex>"}}
 *   <- {"error":"invalid_point"} | {"error":"bad_json"} | {"error":"bad_request"}
 *
 * v3 dropped the "index" field. It was never used in the computation — this
 * device multiplies the blinded point and does nothing else with the request —
 * so carrying it only disclosed which account was being unlocked, to the serial
 * line and to this display. It is still ACCEPTED when present, so a browser
 * predating v3 keeps working; it is simply ignored and never shown.
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

// How long the stamping stage is held on screen before the answer goes back.
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
// Display
//
// The panel is 240x135 in rotation 1. Every screen shares one frame: an 18px
// header, a rule, a body, and a footer whose baseline is FOOTER_Y.
//
// FOOTER_Y matters. The previous status line was drawn at y=124 with a 16px
// font, which needs rows 124..139 on a panel that ends at row 134 — so the one
// line that says what actually happened ("approved - sent", "invalid point!")
// had its bottom third cut off on every single request.
//
// Colours are the web app's palette quantised to 565, so the device and the
// browser read as one product. The value colour is worth stating plainly: this
// oracle only ever touches B and k*B, both of which are BLINDED and neither of
// which it can unblind. Violet means "a disguised value" on the website, so
// every value this screen can legitimately show is violet. It has no business
// rendering anything in the colour the site uses for cleartext.
// ---------------------------------------------------------------------------
#define RGB565(r, g, b) \
  ((uint16_t)((((r) & 0xF8) << 8) | (((g) & 0xFC) << 3) | ((b) >> 3)))

static const uint16_t C_CHROME = RGB565(0x5e, 0xea, 0xd4);  // titles, rules
static const uint16_t C_VALUE  = RGB565(0xa9, 0x8b, 0xff);  // a blinded value
static const uint16_t C_GOOD   = RGB565(0x5e, 0xe8, 0x9a);
static const uint16_t C_WARN   = RGB565(0xf2, 0xb2, 0x63);
static const uint16_t C_BAD    = RGB565(0xef, 0x6a, 0x5f);
static const uint16_t C_INK1   = RGB565(0xa3, 0xba, 0xb5);
static const uint16_t C_INK2   = RGB565(0x7d, 0x93, 0x8e);
static const uint16_t C_RULE   = RGB565(0x2f, 0x3d, 0x45);

static const int16_t HEADER_RULE_Y = 18;
static const int16_t FOOTER_Y      = 117;   // + 16px font = 133, inside 135
static const int16_t HEX_COLS      = 32;    // 32 * 6px + margin fits 240 twice

static char g_fingerprint[10];              // "xxxx-xxxx", matches the browser

/* SHA-256(Y) truncated to four bytes, formatted exactly as recovery.js
 * fingerprint() and app.js keyFingerprint() do, so the string on this screen is
 * character-for-character the one the browser shows when it pins this oracle.
 * Derived from the PUBLIC key only — safe to display, and the whole point is
 * that you can read it across the room. */
static void deriveFingerprint() {
  uint8_t h[32];
  crypto_hash_sha256(h, g_pubkey, 32);
  static const char *hexchars = "0123456789abcdef";
  size_t o = 0;
  for (int i = 0; i < 4; i++) {
    if (i == 2) g_fingerprint[o++] = '-';
    g_fingerprint[o++] = hexchars[(h[i] >> 4) & 0xF];
    g_fingerprint[o++] = hexchars[h[i] & 0xF];
  }
  g_fingerprint[o] = '\0';
  sodium_memzero(h, sizeof(h));
}

static void uiFrame(const char *title, const char *right, uint16_t rightColor) {
  tft.fillScreen(TFT_BLACK);
  tft.setTextDatum(TL_DATUM);
  tft.setTextFont(1);
  tft.setTextSize(1);
  tft.setTextColor(C_CHROME, TFT_BLACK);
  tft.drawString(title, 4, 5);
  if (right) {
    tft.setTextColor(rightColor, TFT_BLACK);
    tft.drawString(right, tft.width() - 4 - tft.textWidth(right, 1), 5);
  }
  tft.drawFastHLine(0, HEADER_RULE_Y, tft.width(), C_RULE);
}

static void uiFooter(const char *text, uint16_t color) {
  tft.drawFastHLine(0, FOOTER_Y - 4, tft.width(), C_RULE);
  tft.setTextFont(1);
  tft.setTextSize(1);
  tft.setTextColor(color, TFT_BLACK);
  tft.drawString(text, 4, FOOTER_Y + 3);
}

/* 64 hex characters as two rows of 32 — the whole value, not a prefix. */
static void uiHexBlock(const char *hex64, int16_t y, uint16_t color) {
  char row[HEX_COLS + 1];
  tft.setTextFont(1);
  tft.setTextSize(1);
  tft.setTextColor(color, TFT_BLACK);
  for (int r = 0; r < 2; r++) {
    memcpy(row, hex64 + r * HEX_COLS, HEX_COLS);
    row[HEX_COLS] = '\0';
    tft.drawString(row, 6, y + r * 11);
  }
}

// Counts requests since boot. Shown instead of the account number: a bystander
// learning that this is the fourth handshake of the session learns nothing,
// whereas "index: 7" told them which account was being opened.
static uint32_t g_requestSeq = 0;

static void showBoot(const char *headline, const char *sub, const char *foot,
                     uint16_t color) {
  uiFrame("VAULTLESS ORACLE", "boot", color);
  tft.setTextFont(2);
  tft.setTextColor(color, TFT_BLACK);
  tft.drawString(headline, (tft.width() - tft.textWidth(headline, 2)) / 2, 44);
  if (sub) {
    tft.setTextFont(1);
    tft.setTextColor(C_INK2, TFT_BLACK);
    tft.drawString(sub, (tft.width() - tft.textWidth(sub, 1)) / 2, 74);
  }
  uiFooter(foot, C_INK2);
}

// ---------------------------------------------------------------------------
// Persistent key management (NVS)
// ---------------------------------------------------------------------------
// Defined with the DLEQ helpers below; called from loadOrCreatePrivateKey.
// (deriveFingerprint and showBoot are defined in the Display section above,
// which is why that section comes first — this one draws to the screen.)
static void deriveNonceKey(void);

#ifdef VAULTLESS_ALLOW_PROVISION
static bool hasStoredPrivateKey() {
  prefs.begin("oprf", true);
  const bool present = (prefs.getBytesLength("privkey") == 32);
  prefs.end();
  return present;
}
#endif

static void loadOrCreatePrivateKey() {
  prefs.begin("oprf", false);
  size_t stored = prefs.getBytesLength("privkey");
  if (stored == 32) {
    prefs.getBytes("privkey", g_privkey, 32);
  } else {
    showBoot("generating key", "first boot - this happens once",
             "writing to NVS", C_WARN);
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
  deriveNonceKey();

  if (crypto_scalarmult_ristretto255_base(g_pubkey, g_privkey) != 0) {
    showBoot("bad key in NVS", "the stored scalar is not usable",
             "erase NVS and reflash", C_BAD);
    while (true) { delay(1000); }
  }

  deriveFingerprint();
}

// ---------------------------------------------------------------------------
// Idle pages
//
// The idle screen used to be a title and the words "idle - waiting for request",
// which used 44 of 135 rows and told you nothing you could act on. It now leads
// with the fingerprint, because that is the one thing about this device a person
// ever needs to read: it is how you tell two oracles apart, how you match a
// device to a printed sheet, and how you check that the key your browser pinned
// is the key in front of you.
//
// The button cycles pages. It never approves anything — requests are still
// auto-approved, exactly as SECURITY.md documents, and nothing here is on the
// path between a request arriving and it being answered.
// ---------------------------------------------------------------------------
static const uint8_t IDLE_PAGES = 3;
static uint8_t g_idlePage = 0;

static void showIdle() {
  char buf[40];
  switch (g_idlePage) {
    case 0: {
      uiFrame("VAULTLESS ORACLE", "ready", C_GOOD);
      tft.fillCircle(tft.width() - 8 - tft.textWidth("ready", 1) - 7, 8, 3, C_GOOD);
      tft.setTextFont(4);
      tft.setTextColor(C_VALUE, TFT_BLACK);
      tft.drawString(g_fingerprint,
                     (tft.width() - tft.textWidth(g_fingerprint, 4)) / 2, 44);
      tft.setTextFont(1);
      tft.setTextColor(C_INK2, TFT_BLACK);
      const char *cap = "oracle fingerprint";
      tft.drawString(cap, (tft.width() - tft.textWidth(cap, 1)) / 2, 80);
      snprintf(buf, sizeof(buf), "%lu served", (unsigned long)g_requestSeq);
      uiFooter(buf, C_INK2);
      tft.setTextColor(C_INK2, TFT_BLACK);
      tft.drawString("BTN >", tft.width() - 4 - tft.textWidth("BTN >", 1), FOOTER_Y + 3);
      break;
    }
    case 1: {
      uiFrame("STATUS", "2/3", C_INK2);
      const uint32_t mins = millis() / 60000UL;
      tft.setTextFont(1);
      tft.setTextColor(C_INK2, TFT_BLACK);
      tft.drawString("requests served", 6, 30);
      tft.drawString("uptime", 6, 56);
      tft.drawString("key", 6, 82);
      tft.setTextFont(2);
      tft.setTextColor(C_INK1, TFT_BLACK);
      snprintf(buf, sizeof(buf), "%lu", (unsigned long)g_requestSeq);
      tft.drawString(buf, 130, 26);
      snprintf(buf, sizeof(buf), "%luh %02lum",
               (unsigned long)(mins / 60), (unsigned long)(mins % 60));
      tft.drawString(buf, 130, 52);
      tft.setTextColor(C_GOOD, TFT_BLACK);
      tft.drawString("in NVS", 130, 78);
      uiFooter("protocol v3", C_INK2);
      break;
    }
    default: {
      uiFrame("ABOUT", "3/3", C_INK2);
      tft.setTextFont(1);
      tft.setTextColor(C_INK1, TFT_BLACK);
      tft.drawString("Requests are auto-approved.", 6, 30);
      tft.drawString("Anything on this USB port can", 6, 44);
      tft.drawString("use the key while plugged in.", 6, 58);
      tft.setTextColor(C_WARN, TFT_BLACK);
      tft.drawString("Unplug when you are done.", 6, 78);
      uiFooter("k never leaves this device", C_INK2);
      break;
    }
  }
}

// ---------------------------------------------------------------------------
// Backlight and buttons
//
// On/off only, via digitalWrite. PWM dimming would be nicer but the LEDC API
// changed shape between Arduino-ESP32 2.x and 3.x, and a display that refuses to
// light up is a worse outcome than one that cannot fade.
//
// Both buttons are inputs and nothing else: GPIO 0 has an internal pull-up,
// GPIO 35 is input-only on the ESP32 and relies on the T-Display's onboard one.
// ---------------------------------------------------------------------------
#ifndef VAULTLESS_BTN_A
#define VAULTLESS_BTN_A 35
#endif
#ifndef VAULTLESS_BTN_B
#define VAULTLESS_BTN_B 0
#endif

static const uint32_t SCREEN_SLEEP_MS = 5UL * 60UL * 1000UL;

static bool     g_backlightOn = true;
static uint32_t g_lastActivity = 0;

static void setBacklight(bool on) {
  if (on == g_backlightOn) return;
  g_backlightOn = on;
  digitalWrite(TFT_BL, on ? TFT_BACKLIGHT_ON : !TFT_BACKLIGHT_ON);
}

static void noteActivity() {
  g_lastActivity = millis();
  setBacklight(true);
}

/* Polled from loop(), never blocking: a held button must not stall the serial
 * reader, because that is the path a derivation request arrives on. */
static void pollButtons() {
  static bool lastA = true, lastB = true;
  static uint32_t lastChange = 0;
  const uint32_t now = millis();
  if (now - lastChange < 40) return;              // debounce

  const bool a = digitalRead(VAULTLESS_BTN_A);
  const bool b = digitalRead(VAULTLESS_BTN_B);

  if ((a != lastA && !a) || (b != lastB && !b)) { // active low, on press
    lastChange = now;
    const bool wasAsleep = !g_backlightOn;
    noteActivity();
    // The first press after the screen sleeps only wakes it; it does not also
    // change the page out from under whoever just pressed it.
    if (!wasAsleep) {
      g_idlePage = (uint8_t)((g_idlePage + (!b ? IDLE_PAGES - 1 : 1)) % IDLE_PAGES);
      showIdle();
    } else {
      showIdle();
    }
  }
  lastA = a;
  lastB = b;

  if (g_backlightOn && now - g_lastActivity > SCREEN_SLEEP_MS) setBacklight(false);
}

// ---------------------------------------------------------------------------
// Handshake staging
//
// Mirrors what the browser now shows, so glancing between the two tells one
// story rather than two: the blinded point arrives, k multiplies it, the
// stamped answer goes back. The values are the real ones, in full.
//
// Both B and k*B are safe to put on a screen. B is blinded and k*B is still
// blinded — neither can be undone without the browser's r, and both are already
// on the wire. What is NOT here is as deliberate: no passphrase (this device has
// never seen one), no account index (protocol v3 stopped sending it), and no k.
//
// This replaces the matrix rain. The rain was decoration that happened during
// the one moment the screen could be saying something true.
// ---------------------------------------------------------------------------
static const uint32_t DWELL_RECV_MS  = 700;
static const uint32_t DWELL_SENT_MS  = 1200;

static char randHexChar() {
  static const char hexchars[] = "0123456789abcdef";
  return hexchars[random(16)];
}

static void showReceiving(uint32_t seq, const char *blindedHex) {
  char title[24];
  snprintf(title, sizeof(title), "REQUEST #%lu", (unsigned long)seq);
  uiFrame(title, "receiving", C_VALUE);

  tft.setTextFont(2);
  tft.setTextColor(C_VALUE, TFT_BLACK);
  tft.drawString("B", 6, 24);
  tft.setTextFont(1);
  tft.setTextColor(C_INK2, TFT_BLACK);
  tft.drawString("blinded point in", 22, 29);

  uiHexBlock(blindedHex, 50, C_VALUE);
  uiFooter("disguised - the phrase is not in here", C_INK2);
}

/* The scalar multiplication takes a few milliseconds; this runs for long enough
 * to be read, and churns the value rather than freezing it, exactly as the
 * browser's readout does while it is waiting on this device. */
static void showStamping(uint32_t seq, uint32_t durationMs) {
  char title[24];
  snprintf(title, sizeof(title), "REQUEST #%lu", (unsigned long)seq);
  uiFrame(title, "stamping", C_CHROME);

  tft.setTextFont(2);
  tft.setTextColor(C_CHROME, TFT_BLACK);
  tft.drawString("k . B", 6, 24);

  const uint16_t churnCol = RGB565(0x4a, 0x7a, 0x74);
  const int16_t barX = 6, barY = 104, barW = tft.width() - 12;
  tft.fillRect(barX, barY, barW, 3, C_RULE);

  char row[HEX_COLS + 1];
  row[HEX_COLS] = '\0';
  const uint32_t start = millis();
  uint32_t elapsed = 0;
  while ((elapsed = millis() - start) < durationMs) {
    tft.setTextFont(1);
    tft.setTextColor(churnCol, TFT_BLACK);
    for (int r = 0; r < 2; r++) {
      for (int i = 0; i < HEX_COLS; i++) row[i] = randHexChar();
      tft.drawString(row, 6, 50 + r * 11);
    }
    tft.fillRect(barX, barY, (int16_t)((uint32_t)barW * elapsed / durationMs), 3, C_CHROME);
    delay(45);
  }
  tft.fillRect(barX, barY, barW, 3, C_CHROME);
}

static void showSent(uint32_t seq, const char *resultHex) {
  char title[24];
  snprintf(title, sizeof(title), "REQUEST #%lu", (unsigned long)seq);
  uiFrame(title, "sent", C_GOOD);

  tft.setTextFont(2);
  tft.setTextColor(C_VALUE, TFT_BLACK);
  tft.drawString("B'", 6, 24);
  tft.setTextFont(1);
  tft.setTextColor(C_INK2, TFT_BLACK);
  tft.drawString("stamped, still blinded", 30, 29);

  uiHexBlock(resultHex, 50, C_VALUE);
  uiFooter("answer + DLEQ proof sent", C_GOOD);
}

/* Errors say what happened and what it means, on a screen that is fully
 * visible. The old version was a clipped half-line of red text. */
static void showError(uint32_t seq, const char *headline,
                      const char *line1, const char *line2, const char *code) {
  char title[24];
  snprintf(title, sizeof(title), "REQUEST #%lu", (unsigned long)seq);
  uiFrame(title, "rejected", C_BAD);

  tft.setTextFont(2);
  tft.setTextColor(C_BAD, TFT_BLACK);
  tft.drawString(headline, 6, 34);
  tft.setTextFont(1);
  tft.setTextColor(C_INK1, TFT_BLACK);
  if (line1) tft.drawString(line1, 6, 62);
  if (line2) tft.drawString(line2, 6, 76);
  uiFooter(code, C_BAD);
}

// ---------------------------------------------------------------------------
// Chaum-Pedersen DLEQ proof that log_G(Y) == log_B(B') == k.
//
//   t  <- H(nonce_key || Y || B || B')   -- deterministic, see below
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
//
// THE NONCE IS DERIVED, NOT SAMPLED.
//
// s = t + c*k is a Schnorr equation: two proofs sharing a nonce under different
// challenges give s1 - s2 = (c1 - c2)*k, so k = (s1 - s2)/(c1 - c2) and the
// oracle key is gone. Sampling t from the RNG made that a live risk here,
// because this firmware never enables Wi-Fi or Bluetooth and ESP-IDF documents
// that with the RF subsystem and SAR ADC both off "the output of the RNG should
// be considered as pseudo-random only". A PRNG replaying its sequence after a
// power cycle is exactly the two-proofs-one-nonce case.
//
// Deriving t from a secret nonce key and the request (EdDSA / RFC 6979 style)
// removes the RNG from the request path entirely. Distinct requests give
// distinct t. An identical request gives an identical t, hence an identical
// challenge and an identical s -- a byte-for-byte replay of the same proof,
// which yields no second equation and leaks nothing.
//
// This also restores the property the design depends on: the oracle is a pure
// deterministic function of (k, B). All protocol randomness is the client's
// blinding scalar r, generated in the browser by a real CSPRNG. That is what
// lets a commodity microcontroller stand in for a secure element, and it is
// why no entropy source is needed here at run time.
//
// (Hedging -- mixing fresh entropy into the nonce hash -- would additionally
// harden against fault injection and is safe to add, but it reintroduces a
// run-time RNG dependency, so it is deliberately not done.)
// ---------------------------------------------------------------------------
static const char DLEQ_DST[]  = "oprf-vaultless-dleq-v1";
static const char NONCE_KEY_DST[] = "oprf-vaultless-nonce-key-v1";
static const char NONCE_DST[]     = "oprf-vaultless-nonce-v1";

static uint8_t g_noncekey[32]; // SHA-512(NONCE_KEY_DST || k), truncated

// Derived once at boot so k is read as rarely as possible.
static void deriveNonceKey(void) {
  const size_t dstLen = sizeof(NONCE_KEY_DST) - 1;
  uint8_t buf[dstLen + 32];
  memcpy(buf, NONCE_KEY_DST, dstLen);
  memcpy(buf + dstLen, g_privkey, 32);

  uint8_t digest[64];
  crypto_hash_sha512(digest, buf, sizeof(buf));
  memcpy(g_noncekey, digest, 32);

  sodium_memzero(buf, sizeof(buf));
  sodium_memzero(digest, sizeof(digest));
}

// t = reduce(SHA-512(NONCE_DST || nonce_key || Y || B || B' || ctr)).
// ctr only exists so the function is total: a reduced digest can in principle
// be zero, which no group operation accepts. At 2^-252 per attempt it will
// never advance, and an attacker cannot steer it because nonce_key is secret.
static void dleqNonce(const uint8_t Y[32], const uint8_t B[32],
                      const uint8_t Bp[32], uint8_t ctr, uint8_t outScalar[32]) {
  const size_t dstLen = sizeof(NONCE_DST) - 1;
  uint8_t buf[dstLen + 32 * 4 + 1];
  size_t off = 0;
  memcpy(buf + off, NONCE_DST, dstLen);   off += dstLen;
  memcpy(buf + off, g_noncekey, 32);      off += 32;
  memcpy(buf + off, Y,  32);              off += 32;
  memcpy(buf + off, B,  32);              off += 32;
  memcpy(buf + off, Bp, 32);              off += 32;
  buf[off++] = ctr;

  uint8_t digest[64];
  crypto_hash_sha512(digest, buf, off);
  crypto_core_ristretto255_scalar_reduce(outScalar, digest);

  sodium_memzero(buf, sizeof(buf));
  sodium_memzero(digest, sizeof(digest));
}

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
  bool ok = false;

  for (uint8_t ctr = 0; ctr < 8 && !ok; ctr++) {
    dleqNonce(Y, B, Bp, ctr, t);
    ok = crypto_scalarmult_ristretto255_base(T1, t) == 0 &&
         crypto_scalarmult_ristretto255(T2, t, B) == 0;
  }
  if (!ok) { sodium_memzero(t, sizeof(t)); return false; }

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
      showBoot("provisioned", g_fingerprint, "flash the secure build now", C_GOOD);
      return;
    }
  }
#endif

  // "index" is accepted for compatibility with pre-v3 browsers and validated if
  // it is there, but it is not read into the computation and not displayed. See
  // the protocol note at the top of this file.
  const JsonVariantConst idxField = doc["index"];   // read-only: never inserts
  const bool hasIndex = !idxField.isNull();
  const long index = hasIndex ? (idxField | -1L) : 0L;
  const char *pointHexC = doc["point"] | "";

  String pointHex = String(pointHexC);

  if ((hasIndex && index < 0) || pointHex.length() != 64) {
    sendJsonError("bad_request");
    return;
  }

  uint8_t blinded[32];
  if (!hexToBytes(pointHex, blinded, 32)) {
    sendJsonError("bad_hex");
    return;
  }

  const uint32_t seq = ++g_requestSeq;
  noteActivity();                       // a request always wakes the screen
  showReceiving(seq, pointHex.c_str());
  delay(DWELL_RECV_MS);

  // Requests are auto-approved: the scalar mult runs first, then the staged
  // handshake plays before the answer goes back over the wire.
  uint8_t result[32];
  const bool ok = evaluate(blinded, result);

  showStamping(seq, HANDSHAKE_ANIM_MS);

  if (!ok) {
    showError(seq, "invalid point",
              "Not a ristretto255 element.", "Nothing was stamped.",
              "error: invalid_point");
    sendJsonError("invalid_point");
    delay(2200);
    showIdle();
    return;
  }

  uint8_t proofC[32], proofS[32];
  if (!dleqProve(blinded, result, g_pubkey, proofC, proofS)) {
    showError(seq, "proof failed",
              "Could not prove the answer", "came from this key.",
              "error: proof_failed");
    sendJsonError("proof_failed");
    delay(2200);
    showIdle();
    return;
  }

  sendJsonPoint(result, proofC, proofS);
  // Named rather than inlined: passing .c_str() of a temporary String is legal
  // but reads like a lifetime bug, and this file should not make a reviewer
  // stop to check that it isn't one.
  const String resultHex = bytesToHex(result, 32);
  showSent(seq, resultHex.c_str());
  delay(DWELL_SENT_MS);
  showIdle();
}

// ---------------------------------------------------------------------------
// Arduino entry points
// ---------------------------------------------------------------------------
static String g_lineBuf;

void setup() {
  Serial.begin(115200);
  uint32_t bootStart = millis();
  while (!Serial && millis() - bootStart < 2000) { delay(10); }

  randomSeed(esp_random()); // vary the stamping churn between boots

  tft.init();
  tft.setRotation(1);
  tft.fillScreen(TFT_BLACK);

  pinMode(VAULTLESS_BTN_A, INPUT);          // input-only pin, board pulls it up
  pinMode(VAULTLESS_BTN_B, INPUT_PULLUP);
  pinMode(TFT_BL, OUTPUT);
  digitalWrite(TFT_BL, TFT_BACKLIGHT_ON);
  noteActivity();

  if (sodium_init() < 0) {
    showBoot("libsodium failed", "the crypto library did not start",
             "reflash the firmware", C_BAD);
    while (true) { delay(1000); }
  }

  loadOrCreatePrivateKey();
  showIdle();
}

void loop() {
  pollButtons();
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
