# Vendored dependencies

These files are committed deliberately. The site derives live passwords, so
nothing in its runtime is fetched from a third-party CDN — a compromised or
hijacked CDN would otherwise be able to read the master passphrase and every
derived password.

All artifacts are built from npm tarballs, verified by the integrity hashes
below (npm `sha512` subresource integrity, as recorded in `package-lock.json`).

## `noble-bundle.js`

Bundled crypto surface used by `index.html`.

| package | version | npm integrity |
| --- | --- | --- |
| `@noble/curves` | 1.4.2 | `sha512-TavHr8qycMChk8UwMld0ZDRvatedkzWfH8IiaeGCfymOP5i0hSCozz9vHOL0nkwk7HRMlFnAiKpS2jrUmSybcw==` |
| `@noble/hashes` | 1.4.0 | `sha512-V1JJ1WTRUqHHrOSh597hURcMqVKVGL/ea3kv0gSnEdsEZ0/+VyPghM1lMNGc00z7CIQorSvbKpuJkxvuHbvdbg==` |

Exports: `RistrettoPoint`, `hashToRistretto255`, `ed25519`, `bytesToHex`,
`hexToBytes`, `bytesToNumberLE`, `numberToBytesLE`, `utf8ToBytes`,
`concatBytes`, `invert`, `hkdf`, `sha256`.

### Rebuilding

```bash
npm install @noble/curves@1.4.2 @noble/hashes@1.4.0 esbuild
# entry.js re-exports the symbols listed above
npx esbuild entry.js --bundle --format=esm --minify --target=es2020 \
  --outfile=vendor/noble-bundle.js
```

## `esp-web-tools/`

Verbatim copy of `esp-web-tools@10.4.0` `dist/web/`, used by the "Flash
firmware" button. The directory is copied whole because the entry point
(`install-button.js`) dynamically imports its sibling chunks by relative path.

| package | version | npm integrity |
| --- | --- | --- |
| `esp-web-tools` | 10.4.0 | `sha512-3pwkeFFm5Fj7UQo8SJNYK5RXrtNCpq6X9QoI6bMT4GBZWgrJqjn0YvM9ihG74BtMoSFYXfmDtkehuxe50PTMPQ==` |

It previously loaded from `unpkg.com/esp-web-tools@10`, a mutable major-version
range. It is not in the crypto path, but it shares an origin with the
derivation UI and can read the passphrase field, so it is pinned too.

### Rebuilding

```bash
npm install esp-web-tools@10.4.0
cp -r node_modules/esp-web-tools/dist/web/. vendor/esp-web-tools/
```

## Updating

Bump the version, re-run the steps above, re-record the integrity hash from
`package-lock.json`, and diff the result before committing.
