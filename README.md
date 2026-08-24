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
   never exported) and returns `B' = k·B`, playing a matrix-rain handshake on its display
   while it works.
4. The oracle also returns its public key `Y = k·G` and a Chaum-Pedersen DLEQ proof
   that `log_G(Y) == log_B(B')`. The browser verifies the proof and checks `Y` against
   the key it pinned on first use, so a swapped or tampered oracle is rejected instead
   of silently yielding a different password.
5. The browser unblinds `S = r⁻¹·B' = k·P` and expands it via HKDF-SHA256 into the final
   password.

Same two inputs (passphrase, index) always regenerate the same password, and
there's no vault file to sync, back up, or leak. Recovering any password requires both
the passphrase *and* physical access to the oracle.

> **Note:** the oracle auto-approves every request it receives — there is no
> physical confirmation step. Possession of the connected device is the whole
> second factor, so anything that can reach its serial port while it's plugged in
> can evaluate `k·B` on points of its choosing.

## Repo layout

```
index.html             the site (markup + styles)
app.js                 crypto + WebSerial UI, loaded as a module so the page can
                         run under a strict CSP with script-src 'self'
vendor/                vendored dependencies — see vendor/VENDOR.md. Nothing in the
  noble-bundle.js        runtime is fetched from a CDN: a third party able to serve
  esp-web-tools/         script here could read the passphrase and every password.
manifest.json          PWA manifest for the site itself
esp-manifest.json      ESP Web Tools flashing manifest (points at firmware_merged.bin)
icons/, favicon.svg    site icons
firmware/              ESP32 firmware (PlatformIO)
  src/main.cpp           oracle firmware — OPRF eval, DLEQ proof, NVS key storage, TFT UI
  platformio.ini         env:esp32dev (what the site flashes) plus the encrypted
                         env:esp32dev-secure / env:esp32dev-provision
  SECURE_PROVISIONING.md how to move to encrypted flash without losing your key
.github/workflows/     CI: builds firmware, merges partitions into firmware_merged.bin,
                         commits it back so the site can flash it via WebSerial
```

## Upgrading an existing oracle

The oracle protocol is now v2: every answer carries a DLEQ proof, and the browser
refuses to derive without one. A device running older firmware reports
`firmware predates protocol v2` — reflash it from the site, or with
`pio run -e esp32dev -t upload`. Your key and passwords are unchanged by this.

Note that `env:esp32dev` deliberately does **not** enable flash encryption, so `k`
is readable from flash by anyone holding the board. Closing that is a separate,
irreversible step — read `firmware/SECURE_PROVISIONING.md` first.

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

## Security

Found a vulnerability? Please report it privately — see [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE) © 2026 S.K.
