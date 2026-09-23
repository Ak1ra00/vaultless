# Security Policy

`vaultless` derives live passwords from a master passphrase and a paper
oracle — a key printed on a sheet. Please treat any issue affecting passphrase
confidentiality, oracle key (`k`) confidentiality, or the determinism of
derivation as high severity.

## Reporting a vulnerability

Please report privately — do **not** open a public issue.

Use GitHub's private reporting: **Security → Advisories → Report a
vulnerability** on this repository.

Please include a description of the issue, steps to reproduce, and the affected
component (browser derivation, the paper-oracle codec, or the CI pipeline).

## Scope

In scope:

- The in-browser derivation and protocol code (`app.js`), the paper-oracle codec
  (`recovery.js`), its UI (`sheet.js`), the presentation layer (`ui.js`), the
  page itself (`index.html`, `styles.css`) and the live diagrams (`scene.js`,
  `handshake.js`). The diagrams are isolated from derivation by design, so
  anything that lets them reach a phrase, key, `P`, `S` or password is a
  vulnerability
- The offline shell (`sw.js`)
- The vendored dependencies in `vendor/` (see `vendor/VENDOR.md`)
- The CI pipeline (`.github/workflows/`)

Known and documented — no need to report:

- The paper oracle is the paper-key model: `k` enters the computer on every
  scan, and a photograph of the sheet is a perfect copy. Anyone holding the
  sheet and the phrase can derive every password. This is stated in the README
  and on the page before a sheet is printed.
- The site is served from GitHub Pages, which cannot set response headers.
  Protections that only work as real headers — `frame-ancestors`, HSTS — are
  therefore unavailable; the rest of the policy is applied via a `<meta>` CSP,
  and `app.js` refuses to run inside a frame as a stand-in for `frame-ancestors`.
- `k` cannot be scrubbed from JavaScript memory. `sheet.js` drops its last
  reference on idle, on Forget and on unload, which is the most a browser
  allows. Do not scan a sheet on a machine you do not trust.

## Supported versions

Only the current `main` branch is supported.
