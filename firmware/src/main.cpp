/*
 * Vaultless 2P-OPRF hardware oracle
 * LilyGO T-Display (ESP32 + ST7789 135x240)
 *
 * Protocol (newline-delimited JSON over USB CDC, 115200 baud):
 *   -> {"index":0,"point":"<64 hex chars>"}
 *   <- {"point":"<64 hex chars>"}                 on approval
 *   <- {"error":"rejected"} | {"error":"timeout"} | {"error":"invalid_point"}
 *
 * The device holds a persistent private scalar k in NVS. It never reveals k,
 * never sees the caller's passphrase in any form, and only ever performs a
 * single scalar multiplication on a blinded (indistinguishable-from-random)
 * point.
 */

#include <Arduino.h>
#include <TFT_eSPI.h>
#include <ArduinoJson.h>
#include <Preferences.h>

extern "C" {
  #include "sodium.h"
}

// ---------------------------------------------------------------------------
// Pins (also mirrored as build_flags in platformio.ini)
// ---------------------------------------------------------------------------
#ifndef BTN_APPROVE_PIN
#define BTN_APPROVE_PIN 0
#endif
#ifndef BTN_REJECT_PIN
#define BTN_REJECT_PIN 35
#endif

static const uint32_t APPROVAL_TIMEOUT_MS = 30000;
static const uint32_t DEBOUNCE_MS = 40;

TFT_eSPI tft = TFT_eSPI();
Preferences prefs;

static uint8_t g_privkey[32]; // persistent ristretto255 scalar k

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
  }
  prefs.end();
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
  tft.drawString("APPROVE DERIVATION?", 4, 4);
  tft.drawFastHLine(0, 20, tft.width(), TFT_DARKGREY);

  tft.setTextColor(TFT_WHITE, TFT_BLACK);
  char idxbuf[24];
  snprintf(idxbuf, sizeof(idxbuf), "index: %ld", index);
  tft.setTextColor(TFT_YELLOW, TFT_BLACK);
  tft.drawString(idxbuf, 4, 46);

  tft.setTextColor(TFT_GREEN, TFT_BLACK);
  tft.drawString("[BOOT] approve", 4, 90);
  tft.setTextColor(TFT_RED, TFT_BLACK);
  tft.drawString("[BTN35] reject", 4, 106);
}

static void showStatus(const String &line, uint16_t color) {
  tft.fillRect(0, 124, tft.width(), 16, TFT_BLACK);
  tft.setTextColor(color, TFT_BLACK);
  tft.drawString(line, 4, 124);
}

// ---------------------------------------------------------------------------
// Button handling
// ---------------------------------------------------------------------------
enum class Decision { APPROVED, REJECTED, TIMEOUT };

static bool debouncedRead(int pin, bool activeLow) {
  int level = digitalRead(pin);
  bool pressed = activeLow ? (level == LOW) : (level == HIGH);
  if (!pressed) return false;
  delay(DEBOUNCE_MS);
  level = digitalRead(pin);
  pressed = activeLow ? (level == LOW) : (level == HIGH);
  return pressed;
}

static Decision waitForApproval() {
  uint32_t start = millis();
  while (millis() - start < APPROVAL_TIMEOUT_MS) {
    if (debouncedRead(BTN_APPROVE_PIN, true)) return Decision::APPROVED;
    if (debouncedRead(BTN_REJECT_PIN, false)) return Decision::REJECTED;

    // Live countdown on screen
    uint32_t remaining = (APPROVAL_TIMEOUT_MS - (millis() - start)) / 1000;
    char buf[24];
    snprintf(buf, sizeof(buf), "timeout in %lus", (unsigned long)remaining);
    showStatus(buf, TFT_DARKGREY);
    delay(50);
  }
  return Decision::TIMEOUT;
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

static void sendJsonPoint(const uint8_t *point32) {
  StaticJsonDocument<128> doc;
  doc["point"] = bytesToHex(point32, 32);
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

  Decision d = waitForApproval();
  if (d == Decision::REJECTED) {
    showStatus("rejected", TFT_RED);
    sendJsonError("rejected");
    delay(1200);
    tftBanner();
    return;
  }
  if (d == Decision::TIMEOUT) {
    showStatus("timed out", TFT_ORANGE);
    sendJsonError("timeout");
    delay(1200);
    tftBanner();
    return;
  }

  uint8_t result[32];
  if (!evaluate(blinded, result)) {
    showStatus("invalid point!", TFT_RED);
    sendJsonError("invalid_point");
    delay(1500);
    tftBanner();
    return;
  }

  showStatus("approved - sent", TFT_GREEN);
  sendJsonPoint(result);
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

  pinMode(BTN_APPROVE_PIN, INPUT_PULLUP);
  pinMode(BTN_REJECT_PIN, INPUT); // GPIO35 is input-only; board has ext. pull-up

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
  }
}
