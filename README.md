# ColdCard Entropy Safety Tool

A tool to verify your Bitcoin wallet entropy security and protect against known vulnerabilities.

## Features

- **Risk Assessment**: Analyzes device model, firmware version, dice rolls, and passphrase setup
- **Entropy Calculator**: Calculate total entropy from hardware RNG, dice rolls, and passphrases
- **Educational Content**: Learn about entropy vulnerabilities and mitigation strategies

## Setup Instructions

1. Build the website:
   ```bash
   npm install --silent
   ```

2. Run tests:
   ```bash
   npm test
   ```

3. Deploy to GitHub Pages:
   - Push changes to the `main` branch
   - Go to Settings > Pages in your repository
   - Enable GitHub Pages from the `main` branch

## Deployment

This site is deployed via GitHub Actions. When you push to `main`, it automatically builds and deploys to GitHub Pages using the domain configured in the `CNAME` file.

---

**Note:** This tool is educational. Always follow official Coinkite guidance for your specific device.