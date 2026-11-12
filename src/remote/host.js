// The phone app's connection (Settings → Phone).
//
// Agent Hub connects out to a relay server (relay/server.js), and the phone
// app connects to the same relay; the relay forwards messages between them.
// Each paired phone has its own access token and its own AES-256-GCM key,
// both from the pairing QR code, so only this computer and that phone can
// read what goes through the relay.
//
// This file only keeps the connection, the keys and the paired phones. What
// the messages mean is up to the window (renderer/remote.js): it is the one
// that knows the agents, so it answers the phone. Pictures and videos the
// chat shows (media:// addresses) are read here.
//
// Saved in <userData>/remote.json:
//   { enabled, relay, room, hostKey, devices: [{ id, name, token, key, addedAt, lastSeen, paired }] }

const fs = require('fs');
const os = require('os');
const zlib = require('zlib');
const crypto = require('crypto');

const PAIRING_MINUTES = 10;          // a QR code nobody used stops working after this
const MAX_MEDIA = 40 * 1024 * 1024;

const sha256 = s => crypto.createHash('sha256').update(String(s)).digest('hex');
const random = n => crypto.randomBytes(n).toString('base64url');

// Messages are JSON, deflated when long, then encrypted:
// base64( iv(12) | ciphertext | tag(16) ); the plaintext's first byte says
// whether the rest is deflated (1) or not (0).
function seal(keyB64, obj) {
  let body = Buffer.from(JSON.stringify(obj), 'utf8');
  let flag = 0;
  if (body.length > 1024) { body = zlib.deflateRawSync(body); flag = 1; }
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', Buffer.from(keyB64, 'base64url'), iv);
  const out = Buffer.concat([iv, c.update(Buffer.concat([Buffer.from([flag]), body])), c.final(), c.getAuthTag()]);
  return out.toString('base64');
}
function open(keyB64, d) {
  const buf = Buffer.from(d, 'base64');
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(buf.length - 16);
  const c = crypto.createDecipheriv('aes-256-gcm', Buffer.from(keyB64, 'base64url'), iv);
  c.setAuthTag(tag);
  const plain = Buffer.concat([c.update(buf.subarray(12, buf.length - 16)), c.final()]);
  const body = plain[0] === 1 ? zlib.inflateRawSync(plain.subarray(1)) : plain.subarray(1);
  return JSON.parse(body.toString('utf8'));
}

class RemoteHost {
  constructor({ file, send, fetchMedia }) {
    this.file = file;
    this.sendToWindow = send;
    this.fetchMedia = fetchMedia;
    this.ws = null;
    this.connected = false;
    this.error = null;
    this.clients = new Map();   // relay client id -> device id
    this.retry = 0;
    this.load();
  }

  load() {
    try { this.s = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch { this.s = {}; }
    this.s.enabled = !!this.s.enabled;
    this.s.relay = this.s.relay || '';
    this.s.room = this.s.room || random(18);
    this.s.hostKey = this.s.hostKey || random(32);
    this.s.devices = Array.isArray(this.s.devices) ? this.s.devices : [];
    this.save();
  }

  save() {
    try {
      fs.writeFileSync(this.file, JSON.stringify(this.s, null, 2), { mode: 0o600 });
    } catch { /* tried again with the next change */ }
  }

  // ---------- what Settings shows ----------

  status() {
    const online = new Set(this.clients.values());
    return {
      enabled: this.s.enabled,
      relay: this.s.relay,
      connected: this.connected,
      error: this.error,
      devices: this.s.devices.filter(d => d.paired).map(d => ({ id: d.id, name: d.name, addedAt: d.addedAt, lastSeen: d.lastSeen, online: online.has(d.id) })),
    };
  }

  notifyStatus() {
    this.sendToWindow('remote:status', this.status());
  }

  configure({ enabled, relay } = {}) {
    if (typeof relay === 'string') this.s.relay = relay.trim().replace(/\/+$/, '');
    if (typeof enabled === 'boolean') this.s.enabled = enabled;
    this.save();
    this.restart();
    return this.status();
  }

  // A new phone: its token and key, in a link the QR code holds. The phone
  // shows up under Paired phones once it has connected.
  pair() {
    if (!this.s.relay) throw new Error('Set the relay address first.');
    this.dropUnusedPairings();
    const device = { id: random(6), name: 'Phone', token: random(24), key: random(32), addedAt: Date.now(), lastSeen: 0, paired: false };
    this.s.devices.push(device);
    this.save();
    this.sendTokens();
    const payload = { v: 1, relay: this.s.relay, room: this.s.room, token: device.token, key: device.key, host: os.hostname().replace(/\.local$/, '') };
    return { deviceId: device.id, link: `agenthub://pair#${Buffer.from(JSON.stringify(payload)).toString('base64url')}`, expiresAt: device.addedAt + PAIRING_MINUTES * 60000 };
  }

  removeDevice(id) {
    const d = this.s.devices.find(x => x.id === id);
    if (!d) return this.status();
    this.s.devices = this.s.devices.filter(x => x !== d);
    this.save();
    this.sendRelay({ t: 'kick', th: sha256(d.token) });
    this.sendTokens();
    this.notifyStatus();
    return this.status();
  }

  dropUnusedPairings() {
    const before = this.s.devices.length;
    this.s.devices = this.s.devices.filter(d => d.paired || Date.now() - d.addedAt < PAIRING_MINUTES * 60000);
    if (this.s.devices.length !== before) { this.save(); this.sendTokens(); }
  }

  // ---------- the relay connection ----------

  start() {
    this.restart();
    // Unused QR codes expire.
    setInterval(() => this.dropUnusedPairings(), 60000).unref?.();
  }

  restart() {
    clearTimeout(this.retryTimer);
    if (this.ws) {
      const old = this.ws;
      this.ws = null;
      try { old.close(); } catch { /* already closed */ }
    }
    this.clients.clear();
    this.connected = false;
    this.error = null;
    this.notifyStatus();
    this.sendToWindow('remote:clients', []);
    if (this.s.enabled && this.s.relay) this.connect();
  }

  connect() {
    let url;
    try {
      url = new URL(this.s.relay.replace(/^http/, 'ws') + '/host');
    } catch {
      this.error = 'The relay address is not valid.';
      this.notifyStatus();
      return;
    }
    url.searchParams.set('room', this.s.room);
    url.searchParams.set('key', this.s.hostKey);
    const ws = new WebSocket(url);
    this.ws = ws;
    ws.onopen = () => {
      if (this.ws !== ws) return;
      this.connected = true;
      this.error = null;
      this.retry = 0;
      this.sendTokens();
      this.notifyStatus();
    };
    ws.onmessage = ev => { if (this.ws === ws) this.fromRelay(String(ev.data)); };
    ws.onerror = () => { if (this.ws === ws) this.error = 'Could not reach the relay.'; };
    ws.onclose = ev => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.connected = false;
      if (ev.code === 1006 && !this.error) this.error = 'Could not reach the relay.';
      this.clients.clear();
      this.sendToWindow('remote:clients', []);
      this.notifyStatus();
      // Tries again: after 1 s, then up to every 30 s.
      const wait = Math.min(30000, 1000 * 2 ** this.retry++);
      this.retryTimer = setTimeout(() => { if (this.s.enabled && this.s.relay && !this.ws) this.connect(); }, wait);
    };
  }

  sendRelay(obj) {
    if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(obj));
  }

  sendTokens() {
    this.sendRelay({ t: 'tokens', hashes: this.s.devices.map(d => sha256(d.token)) });
  }

  clientList() {
    return [...this.clients].map(([id, deviceId]) => ({ id, deviceId, name: this.s.devices.find(d => d.id === deviceId)?.name || 'Phone' }));
  }

  fromRelay(raw) {
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    if (m.t === 'join') {
      const d = this.s.devices.find(x => sha256(x.token) === m.th);
      if (!d) return;
      this.clients.set(m.id, d.id);
      d.lastSeen = Date.now();
      if (!d.paired) d.paired = true;
      this.save();
      this.sendToWindow('remote:clients', this.clientList());
      this.notifyStatus();
    } else if (m.t === 'leave') {
      this.clients.delete(m.id);
      this.sendToWindow('remote:clients', this.clientList());
      this.notifyStatus();
    } else if (m.from && typeof m.d === 'string') {
      const d = this.deviceOf(m.from);
      if (!d) return;
      let msg;
      try { msg = open(d.key, m.d); } catch { return; }   // not from this phone
      this.fromPhone(m.from, d, msg);
    }
  }

  deviceOf(clientId) {
    const id = this.clients.get(clientId);
    return id ? this.s.devices.find(d => d.id === id) : null;
  }

  async fromPhone(clientId, device, msg) {
    if (msg.t === 'hello' && typeof msg.device === 'string' && msg.device.trim()) {
      device.name = msg.device.trim().slice(0, 60);
      device.lastSeen = Date.now();
      this.save();
      this.sendToWindow('remote:clients', this.clientList());
      this.notifyStatus();
    }
    // Pictures and videos the chat shows.
    if (msg.t === 'media') {
      try {
        const value = await this.fetchMedia(String(msg.url || ''), MAX_MEDIA);
        this.sendTo(clientId, { t: 'reply', id: msg.id, ok: true, value });
      } catch (err) {
        this.sendTo(clientId, { t: 'reply', id: msg.id, ok: false, error: String(err?.message || err) });
      }
      return;
    }
    this.sendToWindow('remote:message', clientId, msg);
  }

  // To one phone (its relay client id), or to every connected phone (null).
  sendTo(clientId, msg) {
    if (!this.connected) return false;
    const targets = clientId ? [clientId] : [...this.clients.keys()];
    for (const id of targets) {
      const d = this.deviceOf(id);
      if (d) this.sendRelay({ to: id, d: seal(d.key, msg) });
    }
    return true;
  }

  // A notification for phones whose app is closed (the relay sends it
  // through Firebase, if it is set up there).
  push(title, body, tag) {
    this.sendRelay({ t: 'push', title, body, tag });
  }

  hasClients() {
    return this.clients.size > 0;
  }
}

module.exports = { RemoteHost, seal, open };
