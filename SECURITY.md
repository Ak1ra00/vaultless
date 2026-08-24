# Security Policy

`vaultless` derives live passwords from a master passphrase and a hardware
oracle. Please treat any issue affecting passphrase confidentiality, oracle key
(`k`) confidentiality, or the determinism of derivation as high severity.

## Reporting a vulnerability

Please report privately — do **not** open a public issue.

Use GitHub's private reporting: **Security → Advisories → Report a
vulnerability** on this repository.

Please include a description of the issue, steps to reproduce, and the affected
component (browser derivation, firmware oracle, or CI/build pipeline).

## Scope

In scope:

- The in-browser derivation and protocol code (`app.js`), the paper-oracle codec
  (`recovery.js`), its UI (`sheet.js`), the presentation layer (`ui.js`) and the
  page itself (`index.html`)
- The offline shell (`sw.js`)
- The vendored dependencies in `vendor/` (see `vendor/VENDOR.md`)
- The oracle firmware (`firmware/`)
- The build and release pipeline (`.github/workflows/`)

Known and documented — no need to report:

- The oracle auto-approves every request it receives. There is no physical
  confirmation step; possession of the connected device is the entire second
  factor. This is stated in the README.
- The default firmware build (`env:esp32dev`, which is what the website
  flashes) stores the oracle scalar `k` in unencrypted NVS, so anyone holding
  the board can read it out of flash. Closing this requires enabling flash
  encryption, which burns eFuses irreversibly and so is deliberately opt-in —
  see `firmware/SECURE_PROVISIONING.md`.
- The site is served from GitHub Pages, which cannot set response headers.
  Protections that only work as real headers — `frame-ancestors`, HSTS — are
  therefore unavailable; the rest of the policy is applied via a `<meta>` CSP,
  and `app.js` refuses to run inside a frame as a stand-in for `frame-ancestors`.
- `k` cannot be scrubbed from JavaScript memory. `sheet.js` drops its last
  reference on idle, on Forget and on unload, which is the most a browser
  allows; a machine you do not trust needs the hardware oracle, not the sheet.

## Supported versions

Only the current `main` branch is supported.
