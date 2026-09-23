# vaultless

A vaultless, deterministic password manager backed by a two-party oblivious PRF (OPRF)
over ristretto255 and an oracle that lives outside your head — either a physical
device or a printed square of paper.

Live at **[vaultless.space](https://vaultless.space)**.

![The home page: the headline beside the live torus sheet, E(ℂ) ≅ ℂ/Λ](docs/home.jpg)

The site opens by asking which oracle you have, then walks you through setting it
up before it asks for anything else:

```
hardware   choose → install firmware (only if new) → connect ─┐
                                                              ├→ phrase → account → style → password
paper      choose → scan it, or: scribble → create → print ───┘
```

That tour is for the first visit. Someone who already owns an oracle skips it:

```
this browser has used it     Welcome back → Unlock my passwords ──────────┐
                                                                          ├→ phrase → password
new laptop, private window   Already have an oracle? → scan / plug in ────┘
```

## Using it

- **First time.** Pick hardware or paper, get it ready (flash and connect the
  device, or scribble, create and print a sheet), then type your phrase, pick an
  account number and a style, and press **Make my password**. The handshake opens
  over the page and plays out as it happens: the blinded point going out, `k·B`
  coming back, the proof being checked, HKDF filling in the characters. **Skip**
  (or Escape) closes it and the password arrives at once; it is the same password
  either way.

  ![The handshake pop-up: the oracle's k walking B across the curve, one chord at a time](docs/handshake.jpg)

- **Coming back on the same browser.** A *Welcome back* card lists the oracles this
  browser trusts, by fingerprint. One button opens the camera or the connect button
  and lands you at the phrase box, with the last account number and style already
  filled in. The same card forgets an oracle you no longer use.
- **Coming back on a new browser.** Nothing is stored there, so there is nothing to
  welcome you back with — but *Already have an oracle?* opens the camera for a
  paper square (or lets you type its code) or the connect button for a device, in
  one press. This browser has never seen the oracle, so the first derivation trusts
  it and names its fingerprint: check it against the device's idle screen or the
  sheet.
- **One phrase, many passwords.** Change the account number for each site. The
  oracle is an input too, so the same phrase and number on a different oracle make
  a different password — which is why, once this browser trusts an oracle, a
  different one is stopped with a warning before any password is made.

Once a password is made:

- It appears **masked**. **Reveal** shows it; **Copy** puts it on the clipboard and
  clears the clipboard again 60 seconds later, if it still holds the password.
- The result, the phrase field and the clipboard copy are all wiped the moment the
  oracle goes away — unplugged, forgotten, or idled out.
- A paper key, scanned or just created, lives in one variable for the session. It is dropped after
  5 minutes idle, on **Forget this oracle**, and on reload, and it is never written
  anywhere.

## What this site stores

Nothing secret. Every entry is in `localStorage` on this origin, and clearing site
data removes all of it.

| key | holds | why |
| --- | --- | --- |
| `vaultless.oracle.trusted.v1` | the public keys `Y` you have accepted | the pin that catches a swapped oracle; also what the *Welcome back* card is shown for |
| `vaultless.oracle.choice.v1` | `hardware` or `paper` | reopen the path you last took |
| `vaultless.lastuse.v1` | last account number and password style | pick up where you left off |
| `vaultless.mode.v1` | `simple` or `expert` | the explanation level |
| `vaultless.oracle.pubkey.v1` | a single pinned key, from before the set existed | read once to carry it into the set; never written |

Never stored: the passphrase, the paper oracle's `k`, `r`, any point on the wire,
or any password. Account nicknames were stored once (`vaultless.accounts.v1`);
the feature is gone, and the site deletes that key on load.

## How it works

1. The browser hashes `passphrase‖index` to a ristretto255 point `P`, blinds it
   with a random scalar `r` to get `B = r·P`.
2. `B` — and nothing else — is sent to the oracle: the LilyGO device over WebSerial,
   or the in-browser simulator. (A paper oracle takes a different route; see below.)
   The account index used to travel alongside it. It was never part of the oracle's
   computation, so all it did was tell the device, its display and the serial line
   which account was being opened; protocol v3 drops it.
3. The oracle multiplies by its private scalar `k` (generated on-device, stored in NVS,
   never exported) and returns `B' = k·B`. Its screen shows the same three stages the
   browser does — the blinded point arriving, `k·B` being computed, the stamped answer
   going back — with the real values in full. Both are blinded and neither can be undone
   without the browser's `r`, so putting them on a screen gives nothing away.
4. The oracle also returns its public key `Y = k·G` and a Chaum-Pedersen DLEQ proof
   that `log_G(Y) == log_B(B')`. The browser verifies the proof and checks `Y` against
   the key it pinned on first use, so a swapped or tampered oracle is rejected instead
   of silently yielding a different password. It also refuses `Y` or `B'` equal to the
   identity element: a `k = 0` oracle produces a proof that *verifies*, and would drive
   every passphrase to the same publicly computable password.
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
> can evaluate `k·B` on points of its choosing. The device's buttons cycle its
> information pages and wake the screen; they are deliberately not on the path
> between a request arriving and it being answered, so pressing one can never
> approve anything.

## The look

The page is drawn after the sheets in [Ak1ra00/oracle](https://github.com/Ak1ra00/oracle),
and none of its diagrams are pictures — each one is computed from the maths it
shows, and each one can be taken hold of:

| | |
| --- | --- |
| ![Sheet 01: the chord-and-tangent group law on y² = x³ − 3x + 5 over ℝ](docs/sheet-group.jpg) | ![Sheet 02: the 196 points of E(𝔽₂₁₁) in 3D, with the walk k·P](docs/sheet-field.jpg) |
| **01 ℝ** — drag `P` and `Q`; the chord, the third point and `P + Q` follow. | **02 𝔽₂₁₁** — all 196 points of `y² ≡ x³ − 3x + 5 (mod 211)`. The group has 197 elements, a prime, so every point walks the whole of it. Click one to walk from it. |

**05 ℂ** (at the top of this page) is an elliptic curve over the complex numbers:
a torus, `ℂ/Λ`, with scalar multiplication as the straight line `k·z mod Λ` wound
round it — drag to turn it. The ring behind the whole page is `E(𝔽₂₁₁)` laid out in scalar order; it
turns slowly, and quickly while a derivation is running.

The handshake pop-up draws the protocol itself on the same curve over ℝ. Its one
real branch is a circle group, and on it sits a cyclic subgroup of prime order 197:
the dots. Each step is walked across that group by genuine double-and-add, one
chord or tangent per hop. The line meets the curve a third time, the reflection is
the sum, and the bits of the scalar light up as they are spent. `r` walks `P` to
`B`, the oracle's `k` walks `B` to `B′`, and `r⁻¹` walks it home. The loop closes
the way the real one does, landing exactly on `k·P`. The scalars and `P` in the
picture are made up; the real ones are in ristretto255, whose order ℓ runs round
the projector at the bottom.

The readout under it shows `B` and `B′` in full, because they are the only values
that leave the machine and are public anyway. It does **not** show `P` or `S`.
`P = H(phrase ‖ account)` would let anyone with a screenshot test guesses at the
phrase offline, without the oracle. `S` is one hash away from the password, which
stays masked.

The sheets and the ring live in `scene.js`, and the handshake drawing in
`handshake.js`. Both are walled off from the passwords:

- Each imports nothing and is loaded by its own `<script>` tag, so each is a
  separate module graph. If either throws, derivation carries on.
- `scene.js` reads only whether `<body>` has the `handshaking` class.
  `handshake.js` reads only the stage name, which oracle path is in use, the
  password's length (set by the style) and the readout, which only ever holds
  `B` and `B′`. No phrase, key, `P`, `S` or password is reachable from either,
  and the curves they draw are toys over ℝ and 𝔽₂₁₁ that share nothing with
  ristretto255.
- With reduced motion on, every scene is a still frame that moves only when you
  drag it, and the handshake still plays, one still frame per stage, at a shorter
  dwell. Nothing animates off-screen or in a hidden tab.

## Repo layout

```
index.html             the page: markup only
styles.css             the stylesheet — the CSP allows no inline <style> element
app.js                 protocol: derivation, WebSerial transport, DLEQ verification,
                         trusted-key pinning, clipboard scrub
ui.js                  chrome: routing between the two oracle paths, the welcome-back
                         and quick-entry cards, simple/expert switch, passphrase meter,
                         account number, the handshake pop-up and its pacing,
                         masking and reveal
sheet.js               paper oracle UI: entropy pad, scanning, printing, key lifetime
recovery.js            paper oracle codec: Crockford base32, checksum, QR draw/scan
scene.js               the live sheets and the backdrop — isolated, see "The look"
handshake.js           the handshake pop-up's drawing — isolated the same way
                         (every script loads as a module, so the page runs under a
                          strict CSP with script-src 'self' and no inline script)
sw.js                  offline shell: the app is served cache-first, so the code you
                         reviewed is the code that runs; the firmware is never cached
vendor/                vendored dependencies — see vendor/VENDOR.md. Nothing in the
  noble-bundle.js        runtime is fetched from a CDN: a third party able to serve
  qr-bundle.js           script here could read the passphrase and every password.
  esp-web-tools/         Fonts are vendored too, so the CSP can forbid every
  fonts/                 external origin outright.
manifest.json          PWA manifest for the site itself
esp-manifest.json      ESP Web Tools flashing manifest (points at firmware_merged.bin)
icons/, favicon.svg    site icons
docs/                  the screenshots in this README
firmware/              ESP32 firmware (PlatformIO)
  src/main.cpp           oracle firmware — OPRF eval, DLEQ proof, NVS key storage, TFT UI
                         (the idle screen shows the oracle's fingerprint, the same
                          xxxx-xxxx string the browser pins and a paper sheet prints)
  platformio.ini         env:esp32dev (what the site flashes) plus the encrypted
                         env:esp32dev-secure / env:esp32dev-provision
  SECURE_PROVISIONING.md how to move to encrypted flash without losing your key
.github/workflows/     CI: builds firmware, merges partitions into firmware_merged.bin
                         and commits it back so the site can flash it via WebSerial;
                         audits vendor/ against the npm registry
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

Protocol v3 then removed the `index` field from the request, for the reason given in
step 2 above. That change is backward-compatible in both directions: v3 firmware still
accepts a request carrying an index, and the browser retries once with the index if a
v2 device rejects the request without it — noting in the trace that reflashing would
stop the disclosure. So nothing breaks if you do not reflash; you simply keep telling
the device which account you are opening.

> **Never tick "erase device" when reflashing an oracle you have used.** Installing
> firmware leaves NVS — and therefore `k` — alone, which is why your passwords survive
> a reflash. Erasing wipes NVS, and every password that oracle ever made is gone with
> no recovery path. `esp-manifest.json` sets `new_install_prompt_erase` to `false` so
> the site does not offer it, but `esptool erase_flash` will still do it if you ask.

Note that `env:esp32dev` deliberately does **not** enable flash encryption, so `k`
is readable from flash by anyone holding the board. Closing that is a separate,
irreversible step — read `firmware/SECURE_PROVISIONING.md` first.

## Moving domains

The site moved to `vaultless.space` from an earlier domain. Derivation is entirely
domain-independent — same phrase, same oracle, same passwords — but three things do
not travel, and one of them matters:

- **The trusted-key set does not move.** `localStorage` is per-origin, so on the new
  domain every browser starts with nothing pinned and the next derivation trusts your
  oracle on first use. That is exactly the case the pin exists to catch, so the first
  use now says which fingerprint it is trusting: compare it against the one on the
  device's idle screen or printed on your sheet before you rely on the password.
  The last account number and style, the oracle kind and the simple/expert
  preference are lost the same way — none of them secret, all of them one visit
  to set again.

- **Sheets printed before the move name the old domain.** The key on them is fine —
  it is just 32 bytes and cares nothing for DNS — but the instruction line points
  somewhere that may no longer resolve. Either keep a redirect on the old domain or
  reprint from the same key.

- **Browsers that visited the old domain cached it.** The service worker there serves
  the shell cache-first, so anyone who used the old address keeps getting that copy of
  the app, offline-first, even after the domain stops resolving — frozen, and no longer
  receiving updates. To close that out, serve a page from the OLD origin that
  unregisters the worker and redirects here.

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

That binary carries a build-provenance attestation, so you do not have to take the
committed file on trust:

```bash
gh attestation verify firmware_merged.bin --repo Ak1ra00/vaultless
```

The build tooling is pinned to exact versions (`platformio.ini`, the workflow's `pip
install`, and `idf_component.yml`) so that what the attestation points at can actually
be rebuilt and compared.

## Security

Found a vulnerability? Please report it privately — see [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE) © 2026 S.K.
