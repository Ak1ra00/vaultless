# vaultless

A vaultless, deterministic password manager backed by a two-party oblivious PRF (OPRF)
over ristretto255 and a physical hardware oracle.

Live at **[vaultless.space](https://vaultless.space)**.

## How it works

1. The browser hashes `passphrase‖index` to a ristretto255 point `P`, blinds it
   with a random scalar `r` to get `B = r·P`.
2. `B` is sent to the oracle — either the LilyGO hardware device over WebSerial, or the
   in-browser simulator.
3. The oracle multiplies by its private scalar `k` (generated on-device, stored in NVS,
   never exported) and returns `B' = k·B`, but only after a human presses the physical
   approve button.
4. The browser unblinds `S = r⁻¹·B' = k·P` and expands it via HKDF-SHA256 into the final
   password.

Same two inputs (passphrase, index) always regenerate the same password, and
there's no vault file to sync, back up, or leak. Recovering any password requires both
the passphrase *and* physical access to the approving oracle.

## Repo layout

```
index.html            the site (crypto + WebSerial UI, single page)
manifest.json          PWA manifest for the site itself
esp-manifest.json      ESP Web Tools flashing manifest (points at firmware_merged.bin)
icons/, favicon.svg    site icons
firmware/               ESP32 firmware (PlatformIO)
  src/main.cpp          oracle firmware — OPRF eval, NVS key storage, TFT UI
  platformio.ini
.github/workflows/      CI: builds firmware, merges partitions into firmware_merged.bin,
                         commits it back so the site can flash it via WebSerial
```

## Building the firmware

```bash
cd firmware
pio run -e esp32dev -t upload
```

Target board is a LilyGO T-Display (ESP32 + ST7789 135×240). Pinout and build flags are
in `firmware/platformio.ini`.

## Flashing from the browser

The site's "Flash LilyGO firmware" button uses
[ESP Web Tools](https://esphome.github.io/esp-web-tools/) over WebSerial — no local
toolchain needed. It reads `esp-manifest.json`, which points at `firmware_merged.bin`,
kept up to date by CI on every push that touches `firmware/`.
