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

- The in-browser derivation code (`index.html`)
- The oracle firmware (`firmware/`)
- The build and release pipeline (`.github/workflows/`)

Known and documented — no need to report:

- The oracle auto-approves every request it receives. There is no physical
  confirmation step; possession of the connected device is the entire second
  factor. This is stated in the README.

## Supported versions

Only the current `main` branch is supported.
