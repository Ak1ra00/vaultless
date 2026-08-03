# ColdCard Entropy Safety Tool

A Bitcoin wallet security verification tool designed to help users assess and protect their ColdCard hardware wallets against known entropy vulnerabilities.

## 🛡️ What is Entropy Vulnerability?

ColdCard Mk3, Mk4, and Mk5 devices running older firmware versions had a weak pseudo-random number generator (PRNG) that could be brute-forced. The seed generation relied on this PRNG instead of true hardware randomness, meaning attackers could theoretically guess your seed.

### Why It Matters:
- **Weak PRNG:** Can only produce ~40-72 bits of entropy
- **Security Standard:** Bitcoin wallets require 128 bits minimum
- **Risk:** Attacker could brute-force your wallet seed in hours to days

## 🔍 How This Tool Helps

### 1. Risk Assessment
Check your wallet's security status by providing:
- Device model (Mk1-Mk5, Q)
- Firmware version used when generating seed
- Whether you used dice rolls during setup
- BIP-39 passphrase usage

### 2. Entropy Calculator
Calculate total entropy from:
- Hardware TRNG (~128 bits)
- Dice rolls (each roll ≈ 2.585 bits of true entropy)
- BIP-39 Passphrase (adds ~147 bits for typical 13-15 word passphrases)

### 3. Firmware Recommendations
Get guidance on which firmware versions are safe for each device model.

## 📋 Security Thresholds

| Entropy | Rating | Status |
|---------|--------|--------|
| ≥ 128 bits | SECURE ✓ | Meets security standard |
| 96-127 bits | WEAK ⚠️ | Below optimal threshold |
| < 96 bits | VULNERABLE 🚨 | Significantly below standard |

## 💡 Best Practices

### Hardware TRNG (True Random Number Generator)
Your ColdCard has a hardware TRNG that provides ~128 bits of entropy when generating your seed. This is the foundation of wallet security.

### Dice Rolls
Each die roll contributes approximately 2.585 bits of true entropy from the randomness of a 6-sided die. Using dice rolls during wallet setup adds this true random entropy to the seed generation process, making brute-force attacks computationally infeasible.

**Example:** 50 dice rolls = ~129 bits of entropy (exceeds security threshold)

### BIP-39 Passphrase
A passphrase adds a "25th word" to your seed, effectively creating a new wallet from the same seed. This adds an additional layer of security (~147 bits for typical passphrases).

## 🔄 Firmware Update Recommendations

| Device | Safe Firmware | Notes |
|--------|--------------|-------|
| Mk1 | All versions | Cannot run affected firmware |
| Mk2 | 4.2.0+ | Fix for entropy vulnerability |
| Mk3 | 5.6.0+ | Entropy fix included |
| Mk4 | 5.6.0+ | Entropy fix included |
| Mk5 | 5.6.0+ | Entropy fix included |
| Q | 1.5.0Q+ | Entropy fix included |

## ⚠️ Important Disclaimer

This tool is **educational only**. Always follow official Coinkite guidance for your specific device. If you discover a vulnerability or believe your wallet is at risk:

1. Do NOT share your seed or private keys
2. Follow ColdCard/Coinkite's official migration procedures
3. Generate new seeds on updated firmware when possible
4. Consider using dice rolls for any future wallet generation

## 📚 Resources

- [Coinkite Blog](https://blog.coinkite.com/) - Official security updates and guidance
- [ColdCard GitHub](https://github.com/coldcard) - Hardware wallet software
- [BIP-39 Specification](https://github.com/bitcoin/bips/blob/master/bip-0039.mediawiki) - Passphrase standard

## 🙏 Credits

Created by [Ak1ra00](https://github.com/ak1ra00) | `~deterministic-entropy`

---

**Remember:** Bitcoin security is your responsibility. Stay informed, stay secure!