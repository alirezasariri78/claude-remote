# Installing Claude Remote

Back to the [README](../README.md) · Reference: [SETUP.md](SETUP.md)

Claude Remote runs on the computer where you use Claude Code. It installs two background services:

| Service | What it does | Default port |
|---|---|---|
| **Claude Remote** | Runs your Claude Code sessions and talks to the apps and the Telegram bot | 8787 |
| **Claude Remote Web** | Serves the web app (phone browser / PWA) | 8091 |

Both run as **your** user account, because Claude Code keeps its sign-in and session history in your home folder.

- [Before you start (all systems)](#before-you-start-all-systems)
- [Windows](#windows)
- [Linux](#linux)
- [macOS](#macos)
- [Connect your phone](#connect-your-phone)
- [Update, uninstall, logs](#update-uninstall-logs)
- [Troubleshooting](#troubleshooting)

## Before you start (all systems)

1. **Node.js 20 or newer**: https://nodejs.org (or your package manager). Check with `node -v`.
2. **Claude Code, installed and signed in** as the same user that will run the service:
   ```bash
   claude          # then type /login and follow the steps
   ```
3. **Git** (to download and update the project), or download the ZIP from GitHub.
4. **Get the code**, ideally into a short path:
   ```bash
   git clone https://github.com/alirezasariri78/claude-remote.git
   cd claude-remote
   ```

The installers ask the same questions on every system:

- **HTTP proxy**: only if this computer needs one to reach the internet (company networks). Leave empty otherwise.
- **Desktop-app permission hook**: forwards permission prompts from the Claude desktop app and terminal sessions to your phone. Recommended.
- **Firewall**: opens the two ports for your local network so your phone can connect.

---

## Windows

Windows 10 or 11. Open **PowerShell as Administrator** (right-click → Run as administrator) in the project folder:

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

It also asks for your **Windows account and password**. The password is handed to Windows for the service's log-on and is not saved by the script. The script then:

1. removes an earlier Claude Remote install (only its own two services, never Claude's),
2. installs the packages and builds the web app,
3. installs the services **Claude Remote** and **Claude Remote Web**, starts them, and sets them to start with Windows,
4. optionally installs the hook and opens the ports for private networks in Windows Firewall.

Options: `-KeepServices` (update without asking for the password again), `-CheckOnly` (change nothing, show what is installed).

Tip: use a short folder such as `C:\claude-remote`. Very long paths can hit Windows' 260-character limit when the service starts Claude.

---

## Linux

Any distribution with **systemd** (Ubuntu, Debian, Fedora, Arch, …). Run as your **normal user, not with sudo**:

```bash
chmod +x install.sh
./install.sh
```

It installs two **systemd user services**, `claude-remote` and `claude-remote-web`, and enables *linger* for your user so they keep running after you log out and start at boot (this one step may ask for your sudo password). If `ufw` is active, it offers to open the ports.

Check them with:

```bash
systemctl --user status claude-remote claude-remote-web
```

No systemd (for example some containers or WSL without systemd)? Run the service in a terminal instead: `cd server && npm install && npm start`.

---

## macOS

macOS 12 or newer. In Terminal, in the project folder, as your normal user:

```bash
chmod +x install.sh
./install.sh
```

It installs two **launch agents**, `com.clauderemote.server` and `com.clauderemote.web`, in `~/Library/LaunchAgents`. They start when you log in and restart if they stop. If macOS asks whether **node** may accept incoming network connections, choose **Allow**, otherwise your phone cannot connect.

Launch agents run while you are logged in. Keep the Mac awake (System Settings → Energy / Battery, or `caffeinate`) when you want to reach it from your phone.

---

## Connect your phone

At the end, the installer prints the computer's address. The **access token** is the `token` value in `server/bridge-config.json`.

- **Phone browser / PWA**: open `http://<computer address>:8091` and enter the token. Use the browser menu → *Install app* (or *Add to Home screen*) for an app icon. For notifications and the icon badge, see [SETUP.md](SETUP.md#installing-the-web-app-on-a-phone-pwa).
- **Android app**: install the APK (from the GitHub Releases page, or build it with `mobile/build-apk.ps1` on Windows) and enter `<computer address>:8787` and the token.
- **Telegram bot**: works from anywhere, no ports needed.
  1. In Telegram, talk to `@BotFather`, send `/newbot`, and copy the bot token.
  2. Put it in `server/bridge-config.json` → `telegram.botToken` (and `telegram.proxy` if Telegram needs a proxy).
  3. Restart the service (see below), message your bot, and it replies with your user id.
  4. Put that id in `telegram.allowedUserIds`, for example `[123456789]`, and restart again.

The phone must be on the same network as the computer, or both on a VPN such as Tailscale. **Never forward the ports to the internet**: whoever has the address and token can run commands on your computer.

---

## Update, uninstall, logs

| | Windows | Linux | macOS |
|---|---|---|---|
| **Update** | `git pull`, then `.\install.ps1 -KeepServices` | `git pull && ./install.sh --update` | `git pull && ./install.sh --update` |
| **Restart** (after editing `bridge-config.json`) | `Restart-Service clauderemote.exe` (as Administrator), or services.msc | `systemctl --user restart claude-remote` | `launchctl kickstart -k gui/$(id -u)/com.clauderemote.server` |
| **Status** | `.\install.ps1 -CheckOnly`, or services.msc | `./install.sh --check` | `./install.sh --check` |
| **Logs** | `server\daemon\*.log`, `mobile\service\daemon\*.log` | `journalctl --user -u claude-remote -f` | `~/Library/Logs/claude-remote/` |
| **Uninstall** | `npm run service:uninstall` in `server` and in `mobile\service` (as Administrator) | `./install.sh --uninstall` | `./install.sh --uninstall` |

Updates keep your settings: `server/bridge-config.json` (token, ports, proxy, Telegram) and `mobile/service/web-config.json` are never overwritten.

To remove the desktop-app hook on any system: `cd server && npm run hook:uninstall`.

---

## Troubleshooting

**The phone cannot connect.** Check that both are on the same network, that the firewall allows ports 8787 and 8091, and that the service is running (status command above). From the computer itself, `http://localhost:8091` should open the web app.

**"authentication_failed" or Claude does not answer.** Claude Code is not signed in for the user the service runs as. Sign in as that user (`claude`, then `/login`) and restart the service.

**Claude cannot reach the internet from the service** (company network). Services do not read your shell's proxy settings. Set `"proxy"` in `server/bridge-config.json` (the installer asks for it) and restart.

**`node` not found by the service on Linux/macOS** (for example after switching Node versions with nvm). Run `./install.sh --update`: it records the current location of `node` and `claude` in the service definition.

**Desktop-app prompts do not reach the phone.** The hook only affects Claude sessions started after it was installed: restart the desktop app's sessions. Check that forwarding is on in the app's Settings or the bot's menu.
