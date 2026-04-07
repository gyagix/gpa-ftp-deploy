# ⚡ GPA FTP Deploy

> FTP/FTPS/SFTP upload for VS Code — built for Windows Samba shares, mapped drives and multi-environment workflows.

[![VS Code Marketplace](https://img.shields.io/visual-studio-marketplace/v/GPAutomation.gpa-ftp-deploy?label=Marketplace&logo=visualstudiocode&color=00c9a7)](https://marketplace.visualstudio.com/items?itemName=GPAutomation.gpa-ftp-deploy)
[![Downloads](https://img.shields.io/visual-studio-marketplace/d/GPAutomation.gpa-ftp-deploy?color=0084ff)](https://marketplace.visualstudio.com/items?itemName=GPAutomation.gpa-ftp-deploy)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
---

## Why this extension?

Most FTP extensions break when `localRoot` is a mapped network drive (`Z:\projects\myapp`) or a UNC path (`\\server\share\myapp`). This one doesn't.

**Key highlights:**
- 🗂️ **Multiple profiles** — dev / staging / prod, switchable from the status bar
- 🔐 **OS Keychain storage** — passwords go to Windows Credential Manager or macOS Keychain, never to `settings.json`
- 🌐 **Network drive safe** — supports mapped drives, UNC/Samba paths, and Git Bash / WSL auto-conversion
- 💾 **Upload on save** — per-profile toggle, zero friction
- 🖱️ **Explorer context menu** — right-click any file or folder → Upload

---

## Supported protocols

| Protocol | Port | Notes |
|----------|------|-------|
| **FTP**  | 21   | Standard, passive mode |
| **FTPS** | 21 / 990 | TLS — explicit (STARTTLS) or implicit |
| **SFTP** | 22   | SSH — password or private key |

---

## Installation

**From the Marketplace** (recommended):

1. Open VS Code → Extensions (`Ctrl+Shift+X`)
2. Search `GPA FTP Deploy`
3. Click **Install**

**From VSIX** (manual):

```bash
npm install
npm install -g @vscode/vsce
vsce package
# Extensions → ··· → Install from VSIX → select the generated .vsix
```

---

## Configuration

Open the workspace settings with `Ctrl+Shift+P` → **FTP Deploy: Open Workspace Config**  
and add your profiles under `.vscode/settings.json`:

```jsonc
{
  "ftpDeploy.profiles": {

    "dev": {
      "protocol": "ftp",
      "host": "192.168.1.100",
      "port": 21,
      "user": "ftpuser",
      // password: use "FTP Deploy: Save Password to Keychain" — never put it here
      "remotePath": "/var/www/myapp",
      "localRoot": "Z:\\projects\\myapp",   // mapped drive ✓
      "uploadOnSave": true,
      "passive": true,
      "ignore": [".git", "node_modules", ".vs", "*.user", "Thumbs.db"]
    },

    "staging": {
      "protocol": "ftps",
      "host": "staging.example.com",
      "user": "deploy",
      "remotePath": "/var/www/staging",
      "ftpsImplicit": false,          // true = port 990; false = STARTTLS port 21
      "rejectUnauthorized": true,
      "uploadOnSave": false
    },

    "prod": {
      "protocol": "sftp",
      "host": "prod.example.com",
      "port": 22,
      "user": "deploy",
      "remotePath": "/var/www/prod",
      "privateKeyPath": "C:\\Users\\you\\.ssh\\id_rsa",
      "uploadOnSave": false
    }

  }
}
```

### Accepted `localRoot` formats

| Format | Example |
|--------|---------|
| Windows mapped drive | `Z:\\projects\\myapp` |
| UNC / Samba path | `\\\\server\\share\\myapp` |
| Git Bash / WSL | `/z/projects/myapp` → auto-converted |
| *(empty)* | Uses the VS Code workspace root |

---

## Password management

Passwords should **never** live in `settings.json`. Use the Command Palette (`Ctrl+Shift+P`):

| Command | Action |
|---------|--------|
| `FTP Deploy: Save Password to Keychain` | Prompts for password, stores it in the OS keychain |
| `FTP Deploy: Remove Password from Keychain` | Deletes the stored password |

**Resolution order:**
1. OS keychain (Windows Credential Manager / macOS Keychain)
2. `password` field in `settings.json` — used with a migration warning
3. Interactive prompt → automatically saved to keychain

---

## Commands

All commands are available via the Command Palette (`Ctrl+Shift+P`):

| Command | Description |
|---------|-------------|
| `FTP Deploy: Select Profile` | Switch active profile (QuickPick) |
| `FTP Deploy: Upload Current File` | Upload the file open in the editor |
| `FTP Deploy: Upload Entire Folder` | Upload the entire `localRoot` |
| `FTP Deploy: Upload →` | Right-click a file/folder in the Explorer |
| `FTP Deploy: Save Password to Keychain` | Store password securely |
| `FTP Deploy: Remove Password from Keychain` | Delete stored password |
| `FTP Deploy: Test Connection` | Verify server connectivity |
| `FTP Deploy: Show Log` | Open Output → FTP Deploy |
| `FTP Deploy: Open Workspace Config` | Open `.vscode/settings.json` |
| `FTP Deploy: Add Profile` | Guided wizard for a new profile |

---

## Status bar

The active profile is shown in the bottom-right status bar:

```
☁ FTP: dev       ← click to switch
```

Click it (or run `FTP Deploy: Select Profile`) to change profile. The selection is remembered per workspace.

---

## Protocol reference

### FTP
```jsonc
{ "protocol": "ftp", "passive": true }
```

### FTPS (FTP over TLS)
```jsonc
{
  "protocol": "ftps",
  "ftpsImplicit": false,       // true = port 990; false = STARTTLS port 21
  "rejectUnauthorized": false  // false only for self-signed certificates
}
```

### SFTP (SSH)
```jsonc
{
  "protocol": "sftp",
  "port": 22,
  // password auth: use "Save Password to Keychain"
  // key-based auth:
  "privateKeyPath": "C:\\Users\\you\\.ssh\\id_rsa",
  "passphrase": ""  // leave empty if key has no passphrase
}
```

---

## Requirements

- VS Code `^1.80.0`
- Node.js 18+ *(only for building from source)*

---

## Contributing

Pull requests and issues are welcome!

1. Fork the repo
2. Create your branch: `git checkout -b feature/my-feature`
3. Commit: `git commit -m 'feat: add my feature'`
4. Push: `git push origin feature/my-feature`
5. Open a Pull Request

---

## License

[MIT](LICENSE) © 2026 GPAutomation / gyagix
