# Claude Remote: setup and reference

Back to the [README](../README.md) · Installing on Windows, Linux or macOS: [INSTALL.md](INSTALL.md)

```
 Mobile / web app ──┐
                    ├──►  Claude Remote service (your PC)  ──►  Claude Code (Agent SDK)
 Telegram bot ──────┘     core hub + transports
```

- `server/` — the service that runs on the PC. `core.mjs` owns the Claude sessions; each client type is a
  small transport in `server/transports/`.
- `mobile/` — the React Native (Expo) app.

The service works with the same sessions Claude Code stores on this PC, so sessions you started elsewhere show
up in the list. It runs them itself through the Claude Agent SDK; it does not remote-control the desktop app's
window. Avoid sending to the same session from the desktop app and the phone at the same moment.

## Install or update with one script

`install.ps1` sits next to the `server` and `mobile` folders. In PowerShell as Administrator, in that folder:

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

It asks for the Windows account and password the server should run as, an optional proxy, and whether to install
the permission hook and open the firewall. Then it removes the two Claude Remote services from an earlier
install, runs `npm install` in each part, builds the web app, installs both services and starts them. The
password is only passed to Windows for the service; the script does not save it.

- `.\install.ps1 -KeepServices` updates without removing the services, so no password is asked. Use it after
  copying or pulling new files; your settings files are kept.
- `.\install.ps1 -CheckOnly` changes nothing and lists which services would be removed.

It only ever removes services named `clauderemote.exe` and `clauderemoteweb.exe` that run from a `daemon`
folder; Claude's own services are never touched. Claude Code must be installed and signed in on the PC.

## 1. One-time setup on the PC

1. Move this folder to a short path, for example `C:\claude-remote`. Deeply nested folders break Windows'
   260-character path limit when the service launches Claude.
2. Sign in to Claude Code once (the service uses this sign-in):
   ```bash
   claude
   ```
   then type `/login` and follow the steps.
3. Install the service's packages:
   ```bash
   cd C:\claude-remote\server
   npm install
   ```

## 2. Run the service

**Try it in a terminal first**

```bash
npm start
```

It prints the address and token to type into the app. To try the app without signing in or spending usage,
start it in demo mode instead (PowerShell):

```bash
$env:BRIDGE_DEMO=1; npm start
```

**Install as a Windows service** (starts with Windows, no terminal needed). In an Administrator terminal:

```bash
npm run service:install
```

Then follow the printed steps to set the service's Log On account to your own Windows account. This matters:
Claude's sign-in and session history live in your user profile, and the default Local System account cannot
see them. Remove the service with `npm run service:uninstall`.

Settings live in `server/bridge-config.json` (`port`, `host`, `token`). Allow the port (default 8787) through
Windows Firewall for private networks when Windows asks.

## 3. Run the mobile app

```bash
cd C:\claude-remote\mobile
npm install
npx expo start
```

Scan the QR code with the Expo Go app (Android or iPhone). In the app, enter the PC's address, for example
`192.168.1.10:8787`, and the token.

To install it as a standalone Android app, build an APK on this PC with `mobile\build-apk.ps1` (needs Java 17
and the Android SDK in one folder, passed with `-Tools`; default `D:\android-build`). In the app's Settings, tap "Turn on notifications": the app then
notifies you about permission requests and questions while it is in the background, and puts the waiting count
on its icon (launchers that only support a dot show a dot). A permission notification has Allow and Deny
buttons that answer without opening the app; tapping the notification opens its session.

While connected, the app runs a background service (`mobile/modules/keep-alive`) with a permanent "Claude Remote
is connected" notification, which keeps the connection to the PC open after you leave the app. It is not push:
it stops if you force-stop the app or restart the phone (open the app once to start it again), and phones with
aggressive battery saving need Claude Remote set to "Unrestricted" (Settings has a button for this). Keep
Telegram as the channel that always reaches you.
A standalone Android build blocks plain `ws://` traffic by default; add the `expo-build-properties` plugin with
`android.usesCleartextTraffic: true` before building.

## Web app as a Windows service

The app also runs as a website, so you can open it from any browser or phone on the network without Expo.
It is responsive: a single column on phones, sidebar plus chat on wide screens.

```bash
cd mobile
npm run build:web
cd service
npm install
npm start
```

Then open `http://<PC address>:8091`. To keep it running with Windows, run `npm run service:install` in
`mobile/service` from an Administrator terminal (service name: Claude Remote Web). Run `npm run build:web`
again after changing the app; no service restart is needed.

Settings are in `mobile/service/web-config.json`:

| Setting | Meaning | Default |
|---|---|---|
| `port` | Port of the website | 8091 |
| `host` | Network interface to listen on | 0.0.0.0 |
| `serverHost` | Computer running the Claude Remote service; empty means the one the page was opened from | empty |
| `serverPort` | Port of the Claude Remote service | 8787 |

The connect screen is pre-filled from `serverHost` and `serverPort`; you only enter the token.

Permission requests wait on the PC until answered. They show inside the session's chat, in a "Waiting for you"
list above the sessions, and as a count in the browser tab title, including requests made while the app was closed.

## Permission prompts from the desktop app

Sessions you run in the Claude desktop app or a terminal ask for permission on the computer. With the hook
installed, those prompts are also sent to Telegram and the mobile app, and your remote answer is applied.

```bash
cd server
npm run hook:install
```

Run it as your own Windows user (not as Administrator for another account). It adds one entry to
`%USERPROFILE%.claudesettings.json` and keeps a backup; `npm run hook:uninstall` removes it. Restart the
Claude Remote service and any open Claude sessions afterwards.

- The service waits `desktopApprovals.waitSeconds` (default 300) for a remote answer. With no answer, Claude
  shows its normal prompt on the computer.
- Turn forwarding on or off from the bot's menu ("PC session approvals") or the app's Settings.
- Questions Claude asks with multiple-choice options are not forwarded; they stay on the computer.
- If the service is stopped, the hook does nothing and Claude behaves as usual.

## Installing the web app on a phone (PWA)

The web app can be installed as an app with its own icon. Browsers allow that, notifications and the number on
the icon only on a secure address (https, or http://localhost). For a plain http address on your own network,
tell Chrome on the phone to trust it:

1. Open `chrome://flags/#unsafely-treat-insecure-origin-as-secure`.
2. Enter the app's address, for example `http://192.168.1.10:8091`, set the flag to Enabled, and relaunch Chrome.
3. Open the app, then use the browser menu > "Install app" (or "Add to Home screen").
4. In the app's Settings, tap "Turn on notifications".

While requests are waiting, the installed app shows their count on its icon where the system supports it
(Windows, macOS, iOS). On Android the launcher draws the dot or number from the notifications, one per request.
Notifications arrive while the app is open or in the background, not after it has been closed completely;
the Telegram bot covers that case. The icons are in `mobile/public/icons`.

## Security

Whoever has the address and token can run commands on your PC as you.

- Keep the service on your home network, or use Tailscale to reach it from outside. Do not forward the port
  on your router.
- The connection is unencrypted `ws://`. On networks you do not control, use Tailscale (which encrypts) or
  put a TLS reverse proxy in front.
- To change the token, edit `bridge-config.json` and restart the service.

## Telegram bot

Lets you use the service from anywhere: the bot only makes outbound requests, so nothing is opened on the
network, and it goes out through your proxy.

1. In Telegram, open `@BotFather`, send `/newbot`, and follow the steps. It gives you a bot token.
2. Open `server/bridge-config.json` and put the token in `telegram.botToken`. If the PC needs a proxy to reach
   Telegram, set `telegram.proxy` (for example `http://127.0.0.1:8080`); otherwise `HTTPS_PROXY` is used.
3. Restart the service, open your bot in Telegram and send any message. It replies with your Telegram user id.
4. Put that number in `telegram.allowedUserIds`, for example `[123456789]`, and restart the service again.

The bot ignores everyone who is not in `allowedUserIds` and never acts in groups. Treat the bot token like a
password: anyone who has it can impersonate the bot.

Send `/menu` for the main menu; everything is reachable from its inline buttons (sessions, sections, new
session, usage, permission mode, and per-session actions: move to section, rename, archive, stop, delete).

Commands: `/menu`, `/sessions`, `/sections`, `/section Name`, `/new`, `/current`, `/stop`, `/mode`, `/usage`, `/help`. Any other message goes to the
selected session. Permission requests arrive with Allow / Deny buttons.

## Sections

A session's section comes from two places:

- the Claude desktop app's sidebar sections, read (never written) from the app's own config file, and
- a label set from the mobile app or the bot, stored with the session. If both exist, this label is shown.

Moving a session from the mobile app or bot does not change the desktop app's sidebar. The desktop format is
internal to the app; if an app update changes it, desktop sections simply stop showing here.

## Adding another client

Clients never talk to Claude directly; they go through the core (`transports/telegram.mjs` is a full example):

```js
// server/transports/myclient.mjs
export function startMyClient(core, config) {
  const stop = core.subscribe((event) => {
    // event.type: 'items' | 'stream' | 'stream_end' | 'state' | 'permission_request'
    //           | 'permission_resolved' | 'session_meta' | 'sessions' | 'rate_limit'
  });
  // await core.request('list_sessions')
  // await core.request('send', { sessionId, text })
  // await core.request('permission_response', { requestId, behavior: 'allow' })
  return { name: 'telegram', stop };
}
```

Add it to `transportFactories` in `server/index.mjs`. Every client sees the same sessions and events, and a
permission request can be answered from whichever client gets to it first.

Commands (`core.request(type, params)`): `list_sessions`, `open_session`, `new_session`, `send`,
`permission_response`, `interrupt`, `set_mode`, `rename`, `set_section`, `archive`, `delete_session`,
`stop_process`, `get_usage`, `list_dirs`.

## Testing the service

```bash
node test-client.mjs 127.0.0.1:8787 <token> C:\some\test\folder
```

Sends one prompt, approves the permission request, and prints the result.
