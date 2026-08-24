# Encrypted provisioning

The default build stores the oracle scalar `k` in **plaintext NVS**. Anyone who
gets the board for a few minutes can run `esptool.py read_flash` and extract
`k`. With `k` and a guessed passphrase, every password is derivable offline,
forever — the "you must physically hold the device" property is gone after a
single moment of access.

`env:esp32dev-secure` fixes that by enabling ESP32 flash encryption and
encrypted NVS.

---

## Read this before you start

**Enabling flash encryption burns eFuses. It cannot be undone.** The board is
permanently changed. Development mode is selected in
`sdkconfig.secure.defaults` precisely so UART re-flashing keeps working;
switching to release mode permanently disables the UART downloader, and a
mistake after that leaves you with no recovery path.

**Re-flashing wipes NVS, which destroys `k`.** A new `k` means every password
you have ever derived changes and you are locked out of those accounts. Either
carry the old key across (below), or accept that you must rotate every password.

**The website does not flash this build.** `esp-manifest.json` points at
`firmware_merged.bin`, built from `env:esp32dev`, which is deliberately left
unencrypted. Nobody who clicks "Flash" on the site burns an eFuse.

---

## Option A — accept a new key

Simplest, and correct if you have not stored any derived password yet.

```bash
cd firmware
pio run -e esp32dev-secure -t upload
```

The device generates a fresh `k` on first boot. The browser will see a public
key that does not match its pin and will ask you to confirm the change. Every
password must then be re-derived and rotated at the service that uses it.

## Option B — carry the existing key across

Keeps every password you already have.

### 1. Extract `k` from the current (unencrypted) device

This works precisely *because* the current firmware does not encrypt flash.

```bash
esptool.py --port /dev/ttyACM0 read_flash 0x9000 0x5000 nvs.bin
python $IDF_PATH/components/nvs_flash/nvs_partition_tool/nvs_tool.py nvs.bin
```

Find the `privkey` entry in namespace `oprf` and record its 32 bytes as hex
(64 characters, little-endian, exactly as stored).

### 2. Flash the provisioning build

```bash
pio run -e esp32dev-provision -t upload
```

This burns the eFuses and erases NVS. It also compiles in a one-time
`provision` command.

### 3. Import the key

With the board connected, send one line over the serial port at 115200 baud:

```json
{"cmd":"provision","key":"<the 64 hex characters from step 1>"}
```

It replies `{"pubkey":"..."}` on success, or `{"error":"already_provisioned"}`
if a key is already present — the command refuses to overwrite a live oracle.

Confirm the returned `pubkey` matches what your browser has pinned. If it does,
the migration worked and your passwords are unchanged.

### 4. Immediately flash the normal encrypted build over it

```bash
pio run -e esp32dev-secure -t upload
```

**Do not skip this.** The provisioning build will accept a `provision` command
from anything that can reach the serial port whenever NVS is empty. Against a
blank device that lets an attacker choose `k`; if you then pinned that public
key, every password you derived would be one they can reproduce. `k` itself
survives this re-flash, because it is already in encrypted NVS.

---

## Verifying it worked

```bash
esptool.py --port /dev/ttyACM0 read_flash 0x9000 0x5000 nvs.bin
strings nvs.bin | grep -i privkey
```

On an encrypted device this returns nothing readable. If you can still see
plaintext NVS structure, encryption is not active — stop and recheck before
trusting the device with anything.
