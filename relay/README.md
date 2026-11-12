# Agent Hub relay

A small server that connects Agent Hub on your computer with the Agent Hub phone app. Both connect out to it, so neither needs an open port and they don't have to be on the same network.

The relay forwards messages and cannot read them: everything between the computer and a phone is encrypted with a key only those two have (from the pairing QR code). It stores a room id per computer, hashes of the host key and phone tokens, and push tokens.

## Run it

```bash
cd relay
npm install
npm start            # listens on :8787
```

Or with Docker:

```bash
docker build -t agenthub-relay relay
docker run -d --name agenthub-relay -p 8787:8787 -v agenthub-relay:/data agenthub-relay
```

It must be reachable from your phone over the internet, behind HTTPS. Put it behind any reverse proxy that handles WebSockets (Caddy, nginx, a Fly.io or Render app, a Cloudflare Tunnel…) and use its `wss://` address in Agent Hub → Settings → Phone → Relay. `/healthz` answers `ok`.

| Variable | Default | What it does |
| --- | --- | --- |
| `PORT` | `8787` | Port to listen on |
| `DATA_FILE` | `./relay-data.json` (`/data/relay-data.json` in Docker) | Where rooms and push tokens are kept |
| `STATIC_DIR` | – | A folder to serve over HTTP, e.g. `mobile/www` to use the phone app in a browser |
| `FCM_SERVICE_ACCOUNT` | – | A Firebase service account (JSON text, or a path to it), for push notifications while the phone app is closed |

## Push notifications

Phones with the app open get notifications through their connection. For notifications while the app is closed, the relay sends them through Firebase Cloud Messaging:

1. Create a Firebase project, add an Android app with the id `io.agenthub.phone`, and download its `google-services.json` into `mobile/android/app/` (or set it as the `GOOGLE_SERVICES_JSON` secret for the GitHub workflow), then rebuild the app.
2. In the Firebase project's settings, create a service account key and give it to the relay as `FCM_SERVICE_ACCOUNT`.

The notification's title and text (the agent's name and "Finished and waiting for you" or what it asks) go through Firebase in plain text; everything else stays encrypted.
