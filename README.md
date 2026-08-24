# vaultless

A vaultless, deterministic password manager backed by a two-party oblivious PRF (OPRF)
over ristretto255 and an oracle that lives outside your head — either a physical
device or a printed square of paper.

Live at **[vaultless.space](https://vaultless.space)**.

The site opens by asking which oracle you have, then walks you through setting it
up before it asks for anything else:

```
hardware   choose → install firmware (only if new) → connect ─┐
                                                              ├→ phrase → account → style → password
paper      choose → scan it, or: scribble → create → print ───┘
```

## How it works

1. The browser hashes `passphrase‖index` to a ristretto255 point `P`, blinds it
   with a random scalar `r` to get `B = r·P`.
2. `B` is sent to the oracle — the LilyGO device over WebSerial, or the in-browser
   simulator. (A paper oracle takes a different route; see below.)
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
the passphrase *and* the oracle.

### The paper oracle

A paper oracle carries `k` itself, printed as a QR square and a typable code. With
`k` in hand the browser computes `S = k·P` directly — there is no second party left
to hide the input from, so no blinding and no proof. It lands on the same point the
device returns, because the blinding cancels: `r⁻¹·(k·(r·P)) = k·P`. **The same `k`
therefore gives byte-identical passwords whether it is held by a device or by a sheet
of paper**, which makes a sheet a genuine backup of a device rather than a parallel
mode with parallel passwords.

The printed code is `VLT1-` followed by 58 Crockford base32 characters — 63 in all,
encoding `k` (32 bytes) and a SHA-256 checksum (4 bytes). Crockford omits `I`, `L`,
`O` and `U` so nothing can be misread by eye or by hand; input maps `I`/`L`→`1` and
`O`→`0` and ignores case and separators. The checksum is what stops a misread
decoding to a *different* key and silently producing wrong passwords. 63 alphanumeric
characters fit a version-5 QR at error-correction level H (30% recovery), which is
what paper in a drawer needs.

Creating one asks you to scribble in a box, and the pointer track is folded in:

```
k = reduce(SHA-512(dst ‖ ctr ‖ 64 CSPRNG bytes ‖ drawn bytes))
```

The system CSPRNG is always the base and the drawing goes on top, never in place of
it — hashing extra material together with fresh `crypto.getRandomValues` bytes cannot
make the result more predictable than those bytes alone, however lazy the scribble.

> **A paper oracle is weaker than a device, and deliberately so.** `k` enters your
> computer on every scan, and a photograph of the sheet is a perfect clone — both are
> exactly what the hardware oracle exists to prevent. It is the paper-key model
> (passphrase + high-entropy key file), which is sound, but it is a different threat
> model. The sheet is **not** encrypted under your passphrase: that would let the
> passphrase alone reconstruct `k`, collapsing two factors into one.

An existing device's `k` cannot be exported — there is no export command, by design.
To hold one key in both forms, generate it in the browser, print the sheet, then load
that key onto a device with `env:esp32dev-provision`.

> **Note:** the oracle auto-approves every request it receives — there is no
> physical confirmation step. Possession of the connected device is the whole
> second factor, so anything that can reach its serial port while it's plugged in
> can evaluate `k·B` on points of its choosing.

## Repo layout

```
index.html             the site (markup + styles)
app.js                 protocol: derivation, WebSerial transport, DLEQ verification
ui.js                  chrome: routing between the two oracle paths, matrix backdrop,
                         simple/expert switch, passphrase meter, account nicknames
sheet.js               paper oracle UI: entropy pad, scanning, printing, key lifetime
recovery.js            paper oracle codec: Crockford base32, checksum, QR draw/scan
                         (all four load as modules, so the page runs under a strict
                         CSP with script-src 'self' and no inline script)
vendor/                vendored dependencies — see vendor/VENDOR.md. Nothing in the
  noble-bundle.js        runtime is fetched from a CDN: a third party able to serve
  qr-bundle.js           script here could read the passphrase and every password.
  esp-web-tools/         Fonts are vendored too, so the CSP can forbid every
  fonts/                 external origin outright.
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

**Reflash any device built before the DLEQ nonce fix.** That firmware sampled its
proof nonce from the ESP32 RNG, which this build never seeds with RF entropy, so two
proofs could share a nonce and `s = t + c*k` then hands over `k` outright. The nonce
is now derived from `k` and the request, so no run-time randomness is involved. The
wire format did not change and neither did your key, so passwords and the pinned
public key are unaffected — but the fix only reaches the device by reflashing it.

The oracle protocol is also v2: every answer carries a DLEQ proof, and the browser
refuses to derive without one. A device running older firmware reports
`firmware predates protocol v2`. Reflash from the site, or with
`pio run -e esp32dev -t upload`.

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

The site's **Install firmware** button (step 2, hardware path) uses
[ESP Web Tools](https://esphome.github.io/esp-web-tools/) over WebSerial — no local
toolchain needed. It reads `esp-manifest.json`, which points at `firmware_merged.bin`,
kept up to date by CI on every push that touches `firmware/`.

## Security

Found a vulnerability? Please report it privately — see [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE) © 2026 S.K.
