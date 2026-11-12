// Agent Hub relay.
//
// Agent Hub on your computer (the host) and the phone app (a client) both
// connect out to this server, so neither needs an open port or the same
// network. The relay only forwards messages between the host and the clients
// of one room. Every message between them is encrypted end to end
// (AES-256-GCM, with a key per phone that only the computer and that phone
// have, from the pairing QR code), so the relay cannot read or change what
// it forwards.
//
// What the relay knows: rooms (a random id per computer), a hash of each
// room's host key, hashes of the phones' access tokens, and the push
// notification tokens of the phones (see push below).
//
//   GET /host?room=<id>&key=<host key>        the computer (WebSocket)
//   GET /client?room=<id>&token=<token>       a phone (WebSocket)
//   GET /healthz                              "ok"
//   GET /*                                    the phone app as a web page, if STATIC_DIR is set
//
// Frames are JSON text:
//   host -> relay   { t: 'tokens', hashes: [sha256(token) hex…] }   the phones that may connect
//                   { to: <client id> | '*', d: <ciphertext> }      to one phone, or all
//                   { t: 'push', title, body, tag }                 a notification for phones that are not connected
//                   { t: 'kick', th: <token hash> }                 disconnects a removed phone
//   relay -> host   { t: 'join', id, th } / { t: 'leave', id }
//                   { from: <client id>, d: <ciphertext> }
//   client -> relay { d: <ciphertext> }
//                   { t: 'fcm', token }                             this phone's push token
//   relay -> client { d: <ciphertext> } / { t: 'host', online: bool }
//
// Settings (environment variables):
//   PORT                 default 8787
//   DATA_FILE            where rooms are kept, default ./relay-data.json
//   STATIC_DIR           a folder served over HTTP (the built phone app, mobile/www)
//   FCM_SERVICE_ACCOUNT  a Firebase service account JSON (the text, or a path to the file), for push notifications

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = Number(process.env.PORT) || 8787;
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'relay-data.json');
const STATIC_DIR = process.env.STATIC_DIR ? path.resolve(process.env.STATIC_DIR) : null;
const MAX_FRAME = 48 * 1024 * 1024;   // images and videos go through in one frame
const ROOM_RE = /^[A-Za-z0-9_-]{16,64}$/;

const sha256 = s => crypto.createHash('sha256').update(String(s)).digest('hex');
const log = (...a) => console.log(new Date().toISOString(), ...a);

// ---------- saved rooms ----------

// room id -> { hostHash, tokens: [hash…], fcm: { tokenHash: [fcm token…] } }
let data = { rooms: {} };
try { data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch { /* first start */ }
data.rooms = data.rooms || {};
let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      fs.writeFileSync(DATA_FILE + '.tmp', JSON.stringify(data));
      fs.renameSync(DATA_FILE + '.tmp', DATA_FILE);
    } catch (err) { log('could not save', err.message); }
  }, 200);
}

// ---------- live connections ----------

// room id -> { host: ws | null, clients: Map(client id -> { ws, th }) }
const live = new Map();
function liveRoom(id) {
  if (!live.has(id)) live.set(id, { host: null, clients: new Map() });
  return live.get(id);
}
const send = (ws, obj) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); };

// ---------- HTTP ----------

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json' };
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/healthz') { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('ok'); return; }
  if (!STATIC_DIR) { res.writeHead(404); res.end(); return; }
  let file = path.normalize(path.join(STATIC_DIR, decodeURIComponent(url.pathname)));
  if (!file.startsWith(STATIC_DIR)) { res.writeHead(403); res.end(); return; }
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
  fs.readFile(file, (err, body) => {
    if (err) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
    res.end(body);
  });
});

// ---------- WebSocket ----------

const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME });
server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://x');
  const room = url.searchParams.get('room') || '';
  const reject = code => { socket.write(`HTTP/1.1 ${code} No\r\n\r\n`); socket.destroy(); };
  if (!ROOM_RE.test(room)) return reject(400);
  if (url.pathname === '/host') {
    const key = url.searchParams.get('key') || '';
    if (key.length < 32) return reject(400);
    const saved = data.rooms[room];
    // The first computer to use a room id owns it.
    if (saved && saved.hostHash !== sha256(key)) return reject(403);
    if (!saved) { data.rooms[room] = { hostHash: sha256(key), tokens: [], fcm: {} }; save(); }
    wss.handleUpgrade(req, socket, head, ws => onHost(ws, room));
  } else if (url.pathname === '/client') {
    const th = sha256(url.searchParams.get('token') || '');
    if (!data.rooms[room]?.tokens.includes(th)) return reject(403);
    wss.handleUpgrade(req, socket, head, ws => onClient(ws, room, th));
  } else {
    reject(404);
  }
});

function onHost(ws, roomId) {
  const r = liveRoom(roomId);
  // A second connection from the same computer replaces the first.
  if (r.host) r.host.close(4000, 'replaced');
  r.host = ws;
  ws.isAlive = true;
  log('host up', roomId.slice(0, 6));
  for (const [id, c] of r.clients) {
    send(ws, { t: 'join', id, th: c.th });
    send(c.ws, { t: 'host', online: true });
  }
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('message', raw => {
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    const saved = data.rooms[roomId];
    if (m.t === 'tokens' && Array.isArray(m.hashes)) {
      saved.tokens = m.hashes.filter(h => typeof h === 'string' && /^[0-9a-f]{64}$/.test(h)).slice(0, 50);
      for (const th of Object.keys(saved.fcm || {})) if (!saved.tokens.includes(th)) delete saved.fcm[th];
      save();
      // Phones that were removed are disconnected.
      for (const [, c] of r.clients) if (!saved.tokens.includes(c.th)) c.ws.close(4003, 'removed');
    } else if (m.t === 'kick') {
      for (const [, c] of r.clients) if (c.th === m.th) c.ws.close(4003, 'removed');
    } else if (m.t === 'push') {
      push(roomId, m).catch(err => log('push failed', err.message));
    } else if (typeof m.d === 'string') {
      if (m.to === '*') for (const [, c] of r.clients) send(c.ws, { d: m.d });
      else send(r.clients.get(m.to)?.ws, { d: m.d });
    }
  });
  ws.on('close', () => {
    if (r.host !== ws) return;
    r.host = null;
    log('host down', roomId.slice(0, 6));
    for (const [, c] of r.clients) send(c.ws, { t: 'host', online: false });
  });
}

let nextClient = 1;
function onClient(ws, roomId, th) {
  const r = liveRoom(roomId);
  const id = 'c' + (nextClient++);
  r.clients.set(id, { ws, th });
  ws.isAlive = true;
  send(ws, { t: 'host', online: !!r.host });
  send(r.host, { t: 'join', id, th });
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('message', raw => {
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    if (m.t === 'fcm' && typeof m.token === 'string' && m.token.length < 4096) {
      const saved = data.rooms[roomId];
      saved.fcm = saved.fcm || {};
      saved.fcm[th] = [m.token];
      save();
    } else if (typeof m.d === 'string') {
      send(r.host, { from: id, d: m.d });
    }
  });
  ws.on('close', () => {
    r.clients.delete(id);
    send(r.host, { t: 'leave', id });
  });
}

// Connections that stop answering (a phone that lost its network) are closed.
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    try { ws.ping(); } catch { /* closing */ }
  }
}, 25000);

// ---------- push notifications (Firebase Cloud Messaging) ----------

// Phones that are connected get notifications through their connection; the
// others (the app is closed) get one through FCM, when it is set up.
let fcmAccount = null;
try {
  const v = process.env.FCM_SERVICE_ACCOUNT;
  if (v) fcmAccount = JSON.parse(v.trim().startsWith('{') ? v : fs.readFileSync(v, 'utf8'));
} catch (err) { log('FCM_SERVICE_ACCOUNT unreadable:', err.message); }

let fcmToken = null;
async function fcmAccessToken() {
  if (fcmToken && fcmToken.until > Date.now() + 60000) return fcmToken.value;
  const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({ iss: fcmAccount.client_email, scope: 'https://www.googleapis.com/auth/firebase.messaging', aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 })}`;
  const sig = crypto.createSign('RSA-SHA256').update(unsigned).sign(fcmAccount.private_key).toString('base64url');
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${unsigned}.${sig}` }),
  });
  const j = await res.json();
  if (!j.access_token) throw new Error('no FCM access token');
  fcmToken = { value: j.access_token, until: Date.now() + (j.expires_in || 3600) * 1000 };
  return fcmToken.value;
}

async function push(roomId, { title, body, tag }) {
  if (!fcmAccount) return;
  const saved = data.rooms[roomId];
  const r = live.get(roomId);
  const connected = new Set([...(r?.clients.values() || [])].map(c => c.th));
  const tokens = Object.entries(saved?.fcm || {}).filter(([th]) => !connected.has(th)).flatMap(([, t]) => t);
  if (!tokens.length) return;
  const access = await fcmAccessToken();
  for (const token of tokens) {
    const res = await fetch(`https://fcm.googleapis.com/v1/projects/${fcmAccount.project_id}/messages:send`, {
      method: 'POST',
      headers: { authorization: `Bearer ${access}`, 'content-type': 'application/json' },
      body: JSON.stringify({ message: {
        token,
        notification: { title: String(title || 'Agent Hub').slice(0, 200), body: String(body || '').slice(0, 500) },
        android: { priority: 'high', notification: { tag: String(tag || '').slice(0, 100) || undefined, channel_id: 'agents' } },
      } }),
    });
    // A token the phone no longer uses is forgotten.
    if (res.status === 404 || res.status === 400) {
      for (const th of Object.keys(saved.fcm)) saved.fcm[th] = saved.fcm[th].filter(t => t !== token);
      save();
    }
  }
}

server.listen(PORT, () => log(`Agent Hub relay on :${PORT}${STATIC_DIR ? `, serving ${STATIC_DIR}` : ''}${fcmAccount ? ', push on' : ''}`));
