# Agent Hub for Android

Your computer's Agent Hub on your phone: the Hub with its tiles, every agent's chat, History, and the same permission and question cards. You can start agents, send messages and pictures, answer Allow/Deny and questions, Stop, Restart and remove agents. Agents keep running on the computer, and what you do on one shows on the other.

The computer has to be on with Agent Hub open, and both connect through your relay (see [relay/README.md](../relay/README.md)).

## Set it up

1. Run the relay somewhere your phone can reach.
2. On the computer: Settings → Phone → Relay: its `wss://` address. Connect to the relay turns on.
3. Install the app on the phone (below), open it and press **Scan the QR code**, then in Settings → Phone on the computer press **Pair a phone…** and scan the code. Scanning it with the phone's camera app works too. The code works once, for 10 minutes.

Paired phones are listed in Settings → Phone; Remove disconnects one for good.

## Build the app

The GitHub workflow **Android app** builds an APK on every change to `mobile/` or `src/renderer/` (Actions → Android app → the run → Artifacts). Download it on the phone and install it (allow installing from your browser when Android asks).

To build it yourself you need Node.js, JDK 21 and the Android SDK (Android Studio has both):

```bash
npm install                # in the repository folder: the libraries the app shares with the desktop app
cd mobile
npm install
npm run apk                # → android/app/build/outputs/apk/debug/app-debug.apk
npm run open               # or open it in Android Studio
```

`npm run build` only makes `www/`, the app's web files: the files in `src/` plus the desktop app's chat and Hub code from `../src/renderer`, unchanged. That folder also works in a browser: serve it with the relay (`STATIC_DIR`) and open `https://your-relay/#agenthub://pair#…` with a pairing link.

After changing `build/icon.png`, run `python3 make-icons.py` for the app icons.

## How it works

- `src/connection.js`: the connection to the relay, end-to-end encrypted with the key from the QR code (AES-256-GCM).
- `src/deck.js`: `window.deck`, the same functions the desktop window has, answered by the computer.
- `src/phone.js`: the app: Hub, chats, History, the message box, pairing and notifications.
- On the computer, `src/renderer/remote.js` records every call the app makes on a chat (`mirror.js`) and sends it to the phones that show that chat, which make the same calls with the same `render.js`. So chats look the same, and anything new in the desktop chat shows on the phone after a rebuild.
