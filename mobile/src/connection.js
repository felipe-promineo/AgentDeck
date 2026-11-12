// The phone's connection to Agent Hub on the computer, through the relay
// (relay/server.js; the computer's side is src/remote/host.js).
//
// Pairing (the QR code from Settings → Phone) gives the relay's address, the
// computer's room, this phone's access token and its AES-256-GCM key. Every
// message is JSON, deflated when long, then encrypted with that key:
// base64( iv(12) | ciphertext+tag ), the plaintext's first byte saying
// whether the rest is deflated (1) or not (0). The relay only sees that.

(function () {
  const PAIR_KEY = 'phonePairing';
  const listeners = new Map();      // event name -> Set(fn)
  const pending = new Map();        // request id -> { resolve, reject, timer }
  let ws = null;
  let key = null;                   // CryptoKey
  let pairing = null;
  let nextId = 1;
  let retry = 0;
  let retryTimer = 0;
  let hostOnline = false;
  let state = 'off';                // off | connecting | relay (no computer) | online

  const emit = (name, ...args) => { for (const fn of listeners.get(name) || []) { try { fn(...args); } catch (err) { console.error(err); } } };
  const on = (name, fn) => {
    if (!listeners.has(name)) listeners.set(name, new Set());
    listeners.get(name).add(fn);
    return () => listeners.get(name)?.delete(fn);
  };

  function setState(s) {
    if (s === state) return;
    state = s;
    emit('state', s);
  }

  // ---------- pairing ----------

  const b64urlToBytes = s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), c => c.charCodeAt(0));
  const bytesToB64 = bytes => {
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
  };
  const b64ToBytes = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));

  // agenthub://pair#<base64url JSON> → { relay, room, token, key, host }
  function parseLink(text) {
    const m = /agenthub:\/\/pair#([A-Za-z0-9_-]+)/.exec(String(text || '').trim());
    if (!m) throw new Error('That is not a pairing link from Agent Hub.');
    let p;
    try { p = JSON.parse(new TextDecoder().decode(b64urlToBytes(m[1]))); } catch { throw new Error('The pairing link is damaged.'); }
    if (!p.relay || !p.room || !p.token || !p.key) throw new Error('The pairing link is incomplete.');
    return p;
  }

  function saved() {
    try { return JSON.parse(localStorage.getItem(PAIR_KEY) || 'null'); } catch { return null; }
  }

  async function pair(link) {
    const p = parseLink(link);
    localStorage.setItem(PAIR_KEY, JSON.stringify(p));
    await start();
    return p;
  }

  function unpair() {
    localStorage.removeItem(PAIR_KEY);
    stop();
    pairing = null;
    emit('unpaired');
  }

  // ---------- encryption ----------

  async function deflate(bytes) {
    const s = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(s).arrayBuffer());
  }
  async function inflate(bytes) {
    const s = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(s).arrayBuffer());
  }

  async function seal(obj) {
    let body = new TextEncoder().encode(JSON.stringify(obj));
    let flag = 0;
    if (body.length > 1024 && typeof CompressionStream !== 'undefined') { body = await deflate(body); flag = 1; }
    const plain = new Uint8Array(body.length + 1);
    plain[0] = flag;
    plain.set(body, 1);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plain));
    const out = new Uint8Array(12 + ct.length);
    out.set(iv);
    out.set(ct, 12);
    return bytesToB64(out);
  }

  async function open(d) {
    const buf = b64ToBytes(d);
    const plain = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: buf.subarray(0, 12) }, key, buf.subarray(12)));
    const body = plain[0] === 1 ? await inflate(plain.subarray(1)) : plain.subarray(1);
    return JSON.parse(new TextDecoder().decode(body));
  }

  // ---------- the socket ----------

  async function start() {
    stop();
    pairing = saved();
    if (!pairing) { setState('off'); emit('unpaired'); return; }
    key = await crypto.subtle.importKey('raw', b64urlToBytes(pairing.key), 'AES-GCM', false, ['encrypt', 'decrypt']);
    connect();
  }

  function stop() {
    clearTimeout(retryTimer);
    if (ws) { const old = ws; ws = null; try { old.close(); } catch { /* closed */ } }
    hostOnline = false;
    for (const [, p] of pending) { clearTimeout(p.timer); p.reject(new Error('Disconnected')); }
    pending.clear();
    setState('off');
  }

  function connect() {
    const url = new URL(pairing.relay.replace(/^http/, 'ws').replace(/\/+$/, '') + '/client');
    url.searchParams.set('room', pairing.room);
    url.searchParams.set('token', pairing.token);
    setState('connecting');
    const sock = new WebSocket(url);
    ws = sock;
    // Messages are opened one after the other, in the order they came.
    let chain = Promise.resolve();
    sock.onopen = () => { if (ws === sock) { retry = 0; setState('relay'); } };
    sock.onmessage = ev => {
      if (ws !== sock) return;
      chain = chain.then(() => fromRelay(String(ev.data))).catch(err => console.warn('relay message', err));
    };
    sock.onclose = ev => {
      if (ws !== sock) return;
      ws = null;
      hostOnline = false;
      for (const [, p] of pending) { clearTimeout(p.timer); p.reject(new Error('Disconnected')); }
      pending.clear();
      // Removed on the computer (Settings → Phone): pairing again is the only way back.
      if (ev.code === 4003) { emit('removed'); unpair(); return; }
      setState('connecting');
      const wait = Math.min(15000, 500 * 2 ** retry++);
      retryTimer = setTimeout(() => { if (!ws && pairing) connect(); }, wait);
    };
  }

  async function fromRelay(raw) {
    const m = JSON.parse(raw);
    if (m.t === 'host') {
      const was = hostOnline;
      hostOnline = !!m.online;
      setState(hostOnline ? 'online' : 'relay');
      if (hostOnline && !was) emit('host');
      return;
    }
    if (typeof m.d !== 'string') return;
    let msg;
    try { msg = await open(m.d); } catch { return; }   // not for this key
    if (msg.t === 'reply') {
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.ok) p.resolve(msg.value);
      else p.reject(new Error(msg.error || 'Failed'));
      return;
    }
    emit('message', msg);
  }

  async function sendRaw(obj) {
    if (!ws || ws.readyState !== 1) throw new Error('Not connected');
    ws.send(JSON.stringify({ d: await seal(obj) }));
  }

  // A request to the computer; resolves with its answer.
  function request(msg, timeoutMs = 60000) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error('The computer did not answer')); }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      sendRaw({ ...msg, id }).catch(err => { clearTimeout(timer); pending.delete(id); reject(err); });
    });
  }

  const call = (name, ...args) => request({ t: 'call', name, args });

  // A picture or video of the chat (a media:// address), as a blob: URL.
  const mediaCache = new Map();
  function media(url) {
    if (!mediaCache.has(url)) {
      const p = request({ t: 'media', url }, 120000).then(v => URL.createObjectURL(new Blob([b64ToBytes(v.data)], { type: v.type })));
      p.catch(() => mediaCache.delete(url));
      mediaCache.set(url, p);
    }
    return mediaCache.get(url);
  }

  // The push token of this phone (Firebase), for notifications while the app is closed.
  function sendPushToken(token) {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify({ t: 'fcm', token }));
  }

  window.link = {
    on, start, stop, pair, unpair, parseLink, call, request, media, sendPushToken,
    send: sendRaw,
    get state() { return state; },
    get pairing() { return pairing || saved(); },
  };
})();
