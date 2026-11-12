// The phone app's side of the window (see remote/host.js for the connection
// and mobile/ for the app itself).
//
// The window stays the one place that runs your agents: the phone shows what
// the window shows and asks the window to act (start an agent, send a
// message, answer a permission card, stop…), the same way the window's own
// buttons do. So whatever you do on either one shows on both.
//
// - Chats: every call the app makes on a chat's Transcript is kept (mirror.js),
//   and sent to the phones that have that chat open; a phone that opens it
//   gets the calls so far first and draws the same chat.
// - The Hub: its tiles go to every phone each time the Hub redraws.
// - Notifications: what the window notifies about goes to the phones too.
//
// Loaded after render.js (so it records every chat from the start) and
// before app.js; what it uses of app.js (state, hub, startAgent…) is only
// used once the window runs.

(function () {
  if (!window.deck?.onRemoteMessage || !window.mirror) return;
  const M = window.mirror;
  const T = window.Transcript.prototype;

  let clients = [];                 // the connected phones: [{ id, deviceId, name }]
  const logs = new Map();           // chat id -> { ref: WeakRef(transcript), ops: [{ m, args }] }
  const subs = new Map();           // chat id -> Set(client id)
  const fnKeys = new WeakMap();     // function -> key, so a function keeps its key
  const fns = new Map();            // key -> function
  let nextChat = 1;
  let nextFn = 1;
  let depth = 0;
  const forget = new FinalizationRegistry(tid => { logs.delete(tid); subs.delete(tid); });

  const send = (clientId, msg) => window.deck.remoteSend(clientId, msg);
  const sendAll = msg => { if (clients.length) window.deck.remoteSend(null, msg); };

  // ---------- recording the chats ----------

  function chatId(t) {
    if (!t.mirrorTid) {
      t.mirrorTid = 't' + nextChat++;
      logs.set(t.mirrorTid, { ref: new WeakRef(t), ops: [] });
      forget.register(t, t.mirrorTid);
    }
    return t.mirrorTid;
  }

  function fnKey(fn) {
    let k = fnKeys.get(fn);
    if (!k) {
      k = 'f' + nextFn++;
      fnKeys.set(fn, k);
      fns.set(k, fn);
    }
    return k;
  }

  // Calls go out in small batches, so a streaming answer is not one message per word.
  const outbox = new Map();         // client id -> [{ tid, op }]
  let flushTimer = 0;
  function queueOp(clientId, tid, op) {
    if (!outbox.has(clientId)) outbox.set(clientId, []);
    outbox.get(clientId).push({ tid, op });
    if (!flushTimer) flushTimer = setTimeout(flush, 40);
  }
  function flush() {
    flushTimer = 0;
    for (const [clientId, list] of outbox) send(clientId, { t: 'ops', list });
    outbox.clear();
  }

  const encodeOp = op => ({ m: op.m, a: M.encode(op.args, fnKey) });

  function record(t, m, args) {
    const tid = chatId(t);
    const op = { m, args };
    // Streaming text is replaced by the full message once it is done, so a
    // chat opened later does not need it.
    const streaming = m === 'addStreamEvent' || (m === 'add' && args[0]?.type === 'stream_event');
    if (!streaming) logs.get(tid).ops.push(op);
    const to = subs.get(tid);
    if (to?.size) {
      const enc = encodeOp(op);
      for (const c of to) queueOp(c, tid, enc);
    }
  }

  for (const m of M.MIRRORED) {
    const orig = T[m];
    if (typeof orig !== 'function') continue;
    T[m] = function (...args) {
      if (depth > 0) return orig.apply(this, args);
      // A permission or question card: once it is answered (here or on a
      // phone), the other devices show the answer on their card.
      if ((m === 'permission' || m === 'question') && typeof args[1] === 'function') {
        const [req, decide] = args;
        const t = this;
        let done = false;
        args = [req, decision => {
          if (done) return;
          done = true;
          decide(decision);
          t.settlePermission(req.requestId, M.decisionLabel(decision), decision?.behavior !== 'deny');
        }];
      }
      record(this, m, args);
      depth++;
      try {
        return orig.apply(this, args);
      } finally {
        depth--;
      }
    };
  }

  // ---------- the Hub ----------

  // An agent's tile, as data: what hub.js reads to draw it.
  const SKIP = new Set(['view', 'transcript', 'snapshot', 'queue', 'pendingQuestion', 'taskTurns', 'autoText', 'lastResult', 'pendingPreamble']);
  function tileOf(a) {
    const o = {};
    for (const [k, v] of Object.entries(a)) {
      if (SKIP.has(k) || typeof v === 'function') continue;
      if (v == null || typeof v !== 'object') { o[k] = v; continue; }
      if (v instanceof Node) continue;
      try {
        const s = JSON.stringify(v);
        if (s && s.length < 4000) o[k] = JSON.parse(s);
      } catch { /* not plain data */ }
    }
    const t = a.transcript;
    if (t) {
      o.transcript = {
        stepCount: t.stepCount || 0,
        tokens: t.tokens || null,
        turnStartedAt: t.turnStartedAt || null,
        lastTurn: t.lastTurn || null,
        liveStep: t.liveStep || null,
        activity: t.activity || null,
      };
    }
    if (t instanceof window.Transcript) o.tid = chatId(t);
    o.queued = a.queue?.length || 0;
    o.question = !!a.pendingQuestion;
    return o;
  }

  function hubState() {
    let names = {};
    try { names = JSON.parse(localStorage.getItem('agentNames') || '{}'); } catch { /* none */ }
    return {
      items: hubItems().map(tileOf),
      groups: state.groups.groups,
      // Which Category each saved session is in (for History).
      assignments: state.groups.assignments || {},
      agentNames: names,
      usage: lastUsage ? M.encode(lastUsage) : null,
    };
  }

  // The usage bar across the top of the Hub (setUsage), for the phone's Hub.
  let lastUsage = null;
  const setUsage = window.Hub.prototype.setUsage;
  window.Hub.prototype.setUsage = function (usage) {
    lastUsage = usage;
    hubChanged();
    return setUsage.apply(this, arguments);
  };

  let hubTimer = 0;
  function hubChanged() {
    if (!clients.length || hubTimer) return;
    hubTimer = setTimeout(() => {
      hubTimer = 0;
      try { sendAll({ t: 'hub', hub: hubState() }); } catch (err) { console.warn('remote: hub', err); }
    }, 250);
  }
  const hubUpdate = window.Hub.prototype.update;
  window.Hub.prototype.update = function (...args) {
    const r = hubUpdate.apply(this, args);
    hubChanged();
    return r;
  };

  // ---------- what the phone asks for ----------

  // window.deck calls that would act on this computer's screen, or change
  // the app itself, are not the phone's to make.
  const NOT_FOR_PHONE = new Set(['openFile', 'revealFile', 'popupMenu', 'titleDoubleClick', 'pickFolder', 'openConfig', 'applyUpdate', 'quit',
    'setupClaude', 'setupUnity', 'openUnity', 'openTactileSvn', 'notify', 'saveConfig', 'remoteConfigure', 'remotePair', 'remoteRemoveDevice',
    'remoteSend', 'remotePush', 'remoteStatus', 'remoteClients', 'copyText', 'startVoice', 'stopVoice']);
  const listening = new Set();

  // Phone actions change nothing on this screen: the window stays where you are.
  function quietly(fn) {
    const realShow = window.show;
    window.show = () => {};
    try {
      return fn();
    } finally {
      window.show = realShow;
    }
  }

  async function sessionById(sessionId) {
    let session = state.sessions.find(s => s.id === sessionId);
    if (!session) {
      await loadSessions();
      session = state.sessions.find(s => s.id === sessionId);
    }
    return session || null;
  }

  // A chat the phone opens: a running agent, or a saved session (a
  // completed Hub agent is one too). Returns its chat id.
  async function openChat(id) {
    const a = state.agents.get(id);
    if (a) {
      if (a.unread) { a.unread = false; refreshHub(); }
      return { tid: chatId(a.transcript), agentId: a.id, cwd: a.cwd, title: a.title };
    }
    const sessionId = id.startsWith('p:') ? id.slice(2) : id;
    const live = [...state.agents.values()].find(x => x.sessionId === sessionId && !x.removed);
    if (live) return openChat(live.id);
    const session = await sessionById(sessionId);
    if (!session) throw new Error('This session is gone.');
    const p = state.parked.get(sessionId);
    if (p?.unread) { p.unread = false; refreshHub(); }
    const h = await loadHistory(session);
    return { tid: chatId(h.transcript), sessionId, cwd: h.cwd || session.cwd, title: session.title };
  }

  const handlers = {
    // The first message of a phone: everything it needs to draw the app.
    async hello() {
      return {
        hub: hubState(),
        config: state.config,
        folders: recentFolders(),
        draft: { ...ensureDraft() },
        theme: document.documentElement.dataset.theme || 'default',
        platform: window.deck.platform,
        version: await window.deck.appVersion().catch(() => ''),
      };
    },

    async deck(clientId, method, args) {
      if (NOT_FOR_PHONE.has(method) || typeof window.deck[method] !== 'function' || method.startsWith('on')) throw new Error(`${method} is not available on the phone`);
      return window.deck[method](...(args || []));
    },

    // Events of window.deck (command output, sessions changed…), for phones.
    listen(clientId, method) {
      if (!/^on[A-Z]/.test(method) || /^onRemote/.test(method) || typeof window.deck[method] !== 'function' || listening.has(method)) return;
      listening.add(method);
      window.deck[method]((...args) => sendAll({ t: 'event', method, args: M.encode(args) }));
    },

    open(clientId, id) {
      return openChat(id);
    },

    // The phone draws a chat: its calls so far, then each new one.
    subscribe(clientId, tid) {
      const log = logs.get(tid);
      if (!log) throw new Error('This chat is gone.');
      if (!subs.has(tid)) subs.set(tid, new Set());
      subs.get(tid).add(clientId);
      return { ops: log.ops.map(encodeOp) };
    },

    unsubscribe(clientId, tid) {
      subs.get(tid)?.delete(clientId);
    },

    // An answer from a phone: Allow/Deny on a permission card, a question's answers…
    callback(clientId, key, args) {
      const fn = fns.get(key);
      if (!fn) throw new Error('This was already answered.');
      return fn(...M.decode(args || [], null, () => {}));
    },

    // A message to an agent on the Hub (running or completed), or to a saved session.
    async send(clientId, { id, text, images = [] }) {
      text = String(text || '').trim();
      if (!text && !images.length) return false;
      text = text || 'Take a look at the attached files.';
      const a = state.agents.get(id);
      // While Claude waits for an answer to its question, the message is the answer.
      if (a?.pendingQuestion && text) {
        a.pendingQuestion.card.answerWith(text);
        return true;
      }
      if (a || id.startsWith('p:')) {
        if (id.startsWith('p:')) {
          const session = await sessionById(id.slice(2));
          if (!session) return false;
          await loadHistory(session);
        }
        if (playSounds()) sounds.created?.();
        return quietly(() => sendToHubItem(id, text, images));
      }
      // A saved session from History: it continues as an agent.
      const session = await sessionById(id);
      if (!session) return false;
      const h = await loadHistory(session);
      const parked = state.parked.get(session.id);
      if (parked?.moved) h.moved = true;
      const cwd = parked?.moved ? parked.cwd : h.cwd || session.cwd;
      if (!cwd) throw new Error('This session has no saved folder, so it cannot continue.');
      quietly(() => startAgent({ cwd, prompt: text, permissionMode: h.mode || parked?.mode, choice: h.choice || parked?.choice, resume: h, images }));
      return true;
    },

    // A new agent, like a message in the Hub's message box.
    async start(clientId, { text, images = [], folder, groupId = null, choice = null, mode = null }) {
      text = String(text || '').trim() || (images.length ? 'Take a look at the attached files.' : '');
      if (!text) throw new Error('Write what the agent should do.');
      if (!folder) throw new Error('Pick a folder.');
      const before = new Set(state.agents.keys());
      try { localStorage.setItem('lastFolder', folder); } catch { /* not important */ }
      setFolderHidden(folder, false);
      const running = quietly(() => startInFolder({ text, images, folder, groupId, choice: choice || defaultChoice(), mode: mode || defaultMode() }));
      running.catch(err => console.warn('remote: start', err));
      // The new agent exists once the folder checks are done (a moment).
      for (let i = 0; i < 100; i++) {
        const added = [...state.agents.keys()].find(k => !before.has(k));
        if (added) return { id: added };
        await new Promise(r => setTimeout(r, 50));
      }
      return { id: null };
    },

    interrupt(clientId, id) {
      if (state.agents.has(id)) interruptAgent(id);
    },

    restart(clientId, id) {
      return quietly(() => restartAgent(id));
    },

    remove(clientId, id) {
      return quietly(() => removeFromHub(id));
    },

    rename(clientId, sessionId, name) {
      setAgentName(sessionId, String(name || '').trim());
      refreshHub();
    },

    folders() {
      return recentFolders();
    },
  };

  window.deck.onRemoteMessage(async (clientId, msg) => {
    if (msg?.t !== 'call') return;
    const fn = handlers[msg.name];
    try {
      if (!fn) throw new Error(`Unknown request ${msg.name}`);
      const value = await fn(clientId, ...(msg.args || []));
      send(clientId, { t: 'reply', id: msg.id, ok: true, value: M.encode(value) });
    } catch (err) {
      send(clientId, { t: 'reply', id: msg.id, ok: false, error: String(err?.message || err) });
    }
  });

  window.deck.onRemoteClients(list => {
    clients = list || [];
    const present = new Set(clients.map(c => c.id));
    for (const set of subs.values()) for (const c of [...set]) if (!present.has(c)) set.delete(c);
    hubChanged();
  });
  window.deck.remoteClients().then(list => { clients = list || []; }).catch(() => {});

  // ---------- notifications ----------

  // What the window notifies about (finished, needs approval, asks…) goes
  // to the phones as well: to the connected ones through the relay, and as a
  // push notification to the others, if the relay has push set up.
  window.addEventListener('load', () => {
    const notify = window.notifyAbout;
    if (typeof notify !== 'function') return;
    window.notifyAbout = function (a, status, body) {
      notify.apply(this, arguments);
      try {
        const title = window.agentName?.(a) || a.title || 'Agent';
        sendAll({ t: 'notify', id: a.id, title, body, status });
        window.deck.remotePush(title, body, a.id);
      } catch { /* the phones miss this one */ }
    };
  });

  // Settings → Phone uses these.
  window.remoteMirror = { clients: () => clients };
})();
