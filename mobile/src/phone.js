// The Agent Hub phone app: the Hub, the chats and History of Agent Hub on
// your computer, drawn with the desktop app's own files (render.js, hub.js…,
// copied by build.js), and the computer running every agent.
//
// The computer sends its Hub's tiles each time they change, and for an open
// chat every call it makes on that chat (mirror.js); this file replays them.
// What you do here (send, start an agent, Allow/Deny, Stop) goes to the
// computer as a request (src/renderer/remote.js), so it shows on both.

const $ = id => document.getElementById(id);
const link = window.link;
const Cap = window.Capacitor;
const native = !!Cap?.isNativePlatform?.();
const plugin = name => (native ? Cap.registerPlugin(name) : null);
const LocalNotifications = plugin('LocalNotifications');
const PushNotifications = plugin('PushNotifications');
const BarcodeScanner = plugin('CapacitorBarcodeScanner');
const AppPlugin = plugin('App');

const STATUS_TEXT = {
  starting: 'Starting', working: 'Working', waiting: 'Needs approval', stuck: 'Stuck',
  background: 'Running in the background', idle: 'Completed', error: 'Error', exited: 'Stopped',
};
const BUSY = ['starting', 'working', 'waiting', 'stuck'];

const S = {
  hello: null,
  items: [],                 // the Hub's tiles, as the computer sent them
  groups: [],
  current: { kind: 'hub' },  // { kind: 'hub' } | { kind: 'chat', id, tid, title, cwd }
  chat: null,                // the open chat: { tid, view, transcript }
  images: [],                // pictures to send with the next message: { mediaType, data, name }
  sessions: [],
};

// ---------- small helpers ----------

function toast(text, ms = 2600) {
  const t = $('phone-toast');
  t.textContent = text;
  t.classList.remove('hidden');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.add('hidden'), ms);
}

function homePath(p) {
  const home = S.hello?.config?.home;
  return p && home && p.startsWith(home) ? '~' + p.slice(home.length) : p || '';
}
function folderName(p) {
  return String(p || '').split(/[\\/]/).filter(Boolean).pop() || p || '';
}

// The desktop files call these (they live in the desktop app.js).
window.uiSound = () => {};
window.sfx = () => {};

// ---------- pictures and videos ----------

// The chat shows pictures by their media:// address on the computer; here
// each one is fetched through the relay once.
function fixMedia(root) {
  for (const node of root.querySelectorAll('img[src^="media:"], video[src^="media:"], source[src^="media:"]')) {
    const url = node.getAttribute('src');
    node.removeAttribute('src');
    node.dataset.mediaUrl = url;
    link.media(url).then(blob => {
      node.src = blob;
      if (node.tagName === 'SOURCE') node.parentElement?.load?.();
    }).catch(() => node.classList.add('media-missing'));
  }
}
new MutationObserver(records => {
  for (const r of records) {
    if (r.type === 'attributes' && r.target.getAttribute?.('src')?.startsWith('media:')) fixMedia(r.target.parentElement || document.body);
    for (const n of r.addedNodes) if (n.nodeType === 1) {
      if (/^(IMG|VIDEO|SOURCE)$/.test(n.tagName) && n.getAttribute('src')?.startsWith('media:')) fixMedia(n.parentElement);
      else fixMedia(n);
    }
  }
}).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['src'] });

// ---------- the Hub ----------

const hub = new Hub($('hub-view'), {
  onOpen: id => openChat(id),
  onRemove: id => link.call('remove', id).catch(err => toast(err.message)),
  onInterrupt: id => link.call('interrupt', id).catch(err => toast(err.message)),
  onRestart: id => link.call('restart', id).catch(err => toast(err.message)),
  onContext: id => tileMenu(id),
  onRemoveGroup: () => {},
  onLanded: () => {},
  onReplay: () => {},
  onTab: () => {},
  onReorder: () => {},
  onReorderGroups: () => {},
  onDragSound: () => {},
  onPickGroup: (categoryId, folder) => {
    if (folder) setDraft({ folder, groupId: categoryId || '' });
    $('input').focus();
  },
});

// The desktop Hub shrinks tiles to fit the window's height; the phone scrolls instead.
hub.fitToHeight = () => {};

function renderHub() {
  try {
    localStorage.setItem('agentNames', JSON.stringify(S.hello?.hub?.agentNames || {}));
  } catch { /* names fall back to titles */ }
  hub.update(S.items, S.current.kind === 'chat' ? S.current.itemId : null, S.groups);
  const usage = S.hello?.hub?.usage;
  if (usage && JSON.stringify(usage) !== S.usageShown) {
    S.usageShown = JSON.stringify(usage);
    try { hub.setUsage(usage); } catch { /* the bar stays as it was */ }
  }
  if (S.current.kind === 'chat') renderChatHeader();
  // How many need you, on the History button.
  const waiting = S.items.filter(a => a.status === 'waiting' || (a.unread && ['idle', 'error'].includes(a.status))).length;
  document.title = waiting ? `(${waiting}) Agent Hub` : 'Agent Hub';
}

// A long press on a tile: what you can do with that agent.
function tileMenu(id) {
  const a = S.items.find(x => x.id === id);
  if (!a) return;
  const actions = [];
  if (BUSY.includes(a.status)) actions.push(['Stop', () => link.call('interrupt', id)]);
  if (a.stopped) actions.push(['Restart', () => link.call('restart', id)]);
  if (a.sessionId) actions.push(['Rename…', () => {
    const name = prompt('Name', window.agentName?.(a) || a.title || '');
    if (name != null) link.call('rename', a.sessionId, name);
  }]);
  actions.push(['Remove from the Hub', () => link.call('remove', id)]);
  sheet(window.agentName?.(a) || a.title, actions);
}

function sheet(title, actions) {
  document.querySelector('.phone-sheet')?.remove();
  const back = el('div', 'phone-sheet');
  const box = el('div', 'phone-sheet-box');
  if (title) box.appendChild(el('div', 'phone-sheet-title', title));
  for (const [label, fn] of actions) {
    const b = el('button', null, label);
    b.type = 'button';
    b.onclick = () => { back.remove(); Promise.resolve(fn()).catch(err => toast(err.message)); };
    box.appendChild(b);
  }
  const cancel = el('button', 'phone-sheet-cancel', 'Cancel');
  cancel.onclick = () => back.remove();
  box.appendChild(cancel);
  back.appendChild(box);
  back.onclick = e => { if (e.target === back) back.remove(); };
  document.body.appendChild(back);
}

// ---------- chats ----------

// The tile of the open chat (it changes id when a completed agent continues).
function currentItem() {
  if (S.current.kind !== 'chat') return null;
  return S.items.find(a => a.tid && a.tid === S.current.tid)
    || S.items.find(a => a.id === S.current.itemId)
    || (S.current.sessionId && S.items.find(a => a.sessionId === S.current.sessionId))
    || null;
}

async function openChat(id, { fromHistory = false } = {}) {
  let info;
  try {
    info = await link.call('open', id);
  } catch (err) {
    toast(err.message);
    return null;
  }
  closeChat();
  const view = el('div', 'view chat');
  $('views').appendChild(view);
  const transcript = new Transcript(view, info.cwd);
  transcript.onEditPrompt = null;
  S.chat = { tid: info.tid, view, transcript };
  S.current = { kind: 'chat', itemId: id, tid: info.tid, sessionId: info.sessionId || (id.startsWith('p:') ? id.slice(2) : fromHistory ? id : null), title: info.title, cwd: info.cwd, fromHistory };
  show();
  await subscribe();
  view.scrollTop = view.scrollHeight;
  return view;
}

// The chat's calls so far, then each new one as it comes.
async function subscribe() {
  const chat = S.chat;
  if (!chat) return;
  const { ops } = await link.call('subscribe', chat.tid);
  if (S.chat !== chat) return;
  // A fresh copy: after a reconnect the chat is drawn again from the start.
  chat.transcript.root.replaceChildren();
  Object.assign(chat.transcript, { seen: new Set(), tools: new Map(), draft: null, turn: null, prompts: [], turnCount: 0, turnsById: new Map() });
  chat.transcript.replaying = true;
  for (const op of ops) mirror.replay(chat.transcript, op, callBack);
  chat.transcript.replaying = false;
  chat.view.scrollTop = chat.view.scrollHeight;
}

// A function of a recorded call (Allow on a permission card…) runs on the computer.
function callBack(key, args) {
  link.call('callback', key, mirror.encode(args)).catch(err => toast(err.message));
}

function closeChat() {
  if (!S.chat) return;
  link.call('unsubscribe', S.chat.tid).catch(() => {});
  S.chat.view.remove();
  S.chat = null;
}

link.on('message', msg => {
  if (msg.t === 'ops') {
    for (const { tid, op } of msg.list) {
      if (S.chat?.tid !== tid) continue;
      const v = S.chat.view;
      const atBottom = v.scrollHeight - v.scrollTop - v.clientHeight < 80;
      mirror.replay(S.chat.transcript, op, callBack);
      if (atBottom) v.scrollTop = v.scrollHeight;
    }
  } else if (msg.t === 'hub') {
    S.hello.hub = msg.hub;
    S.items = msg.hub.items;
    S.groups = msg.hub.groups;
    renderHub();
  } else if (msg.t === 'notify') {
    notifyAbout(msg);
  }
});

// ---------- screens ----------

function show() {
  const chat = S.current.kind === 'chat';
  $('hub-view').classList.toggle('hidden', chat);
  $('back-to-hub').classList.toggle('hidden', !chat);
  $('toggle-sidebar').classList.toggle('hidden', chat);
  $('composer-folder').classList.toggle('hidden', chat);
  $('composer-group').classList.toggle('hidden', chat);
  $('input').placeholder = chat ? 'Message the agent…' : 'Describe a task for a new agent…';
  if (chat) renderChatHeader();
  else {
    $('view-title').textContent = 'Agent HUB';
    $('view-subtitle').textContent = S.hello ? `on ${S.hello.host || link.pairing?.host || 'your computer'}` : '';
    $('view-status').classList.add('hidden');
    $('composer-stop').classList.add('hidden');
    $('composer-restart').classList.add('hidden');
    renderHub();
  }
}

function renderChatHeader() {
  const a = currentItem();
  $('view-title').textContent = a ? window.agentName?.(a) || a.title : S.current.title || 'Session';
  $('view-subtitle').textContent = homePath(a?.cwd || S.current.cwd);
  const pill = $('view-status');
  if (a && !a.parked) {
    pill.classList.remove('hidden');
    pill.replaceChildren(el('span', `dot ${a.status}`), document.createTextNode(a.question ? 'Asks you a question' : STATUS_TEXT[a.status] || a.status));
  } else {
    pill.classList.add('hidden');
  }
  $('composer-stop').classList.toggle('hidden', !a || !['working', 'stuck'].includes(a.status));
  $('composer-restart').classList.toggle('hidden', !a?.stopped || BUSY.includes(a.status));
}

function backToHub() {
  closeChat();
  S.current = { kind: 'hub' };
  show();
}

// ---------- History ----------

function setHistoryOpen(open) {
  document.body.classList.toggle('history-open', open);
  if (open) loadHistory();
}

async function loadHistory() {
  try {
    S.sessions = await deck.listSessions();
  } catch (err) {
    toast(err.message);
    return;
  }
  renderHistory();
}

function renderHistory() {
  const list = $('history-list');
  const q = $('search').value.trim().toLowerCase();
  list.replaceChildren();
  const groupOf = id => S.hello?.hub?.assignments?.[id];
  const groupName = id => S.groups.find(g => g.id === id)?.name;
  const names = S.hello?.hub?.agentNames || {};
  for (const s of S.sessions) {
    const title = names[s.id] || s.title || 'Session';
    if (q && !`${title} ${s.cwd}`.toLowerCase().includes(q)) continue;
    const item = el('div', 'history-item');
    const cat = groupName(groupOf(s.id));
    item.append(
      el('div', 'history-title', (cat ? `# ${cat} · ` : '') + title),
      el('div', 'history-meta', `${folderName(s.cwd)} · ${timeAgo(s.updatedAt)}`),
    );
    item.onclick = () => { setHistoryOpen(false); openChat(s.id, { fromHistory: true }); };
    list.appendChild(item);
    if (list.children.length >= 200) break;
  }
  if (!list.children.length) list.appendChild(el('div', 'settings-hint', q ? 'Nothing found.' : 'No saved sessions.'));
}

function timeAgo(ms) {
  if (!ms) return '';
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
}

// ---------- the message box ----------

function setDraft({ folder, groupId }) {
  if (folder !== undefined) {
    const sel = $('composer-folder');
    if (![...sel.options].some(o => o.value === folder)) sel.prepend(new Option(folderName(folder), folder));
    sel.value = folder;
  }
  if (groupId !== undefined) $('composer-group').value = groupId || '';
}

function renderPickers() {
  const folders = [...new Set([S.hello?.draft?.folder, ...(S.hello?.folders || [])].filter(Boolean))];
  const sel = $('composer-folder');
  const keep = sel.value;
  sel.replaceChildren(...folders.map(f => new Option(folderName(f), f)));
  sel.value = keep && folders.includes(keep) ? keep : folders[0] || '';
  const g = $('composer-group');
  const keepG = g.value;
  g.replaceChildren(new Option('No category', ''), ...S.groups.map(x => new Option('# ' + x.name, x.id)));
  g.value = keepG || S.hello?.draft?.groupId || '';
}

function autosize() {
  const input = $('input');
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, window.innerHeight * 0.35) + 'px';
}

async function sendMessage() {
  const input = $('input');
  const text = input.value.trim();
  const images = S.images.map(({ mediaType, data }) => ({ mediaType, data }));
  if (!text && !images.length) return;
  const sendBtn = $('send');
  sendBtn.disabled = true;
  try {
    if (S.current.kind === 'chat') {
      const a = currentItem();
      await link.call('send', { id: a?.id || S.current.sessionId || S.current.itemId, text, images });
    } else {
      const folder = $('composer-folder').value;
      if (!folder) { toast('Pick a folder first.'); return; }
      await link.call('start', { text, images, folder, groupId: $('composer-group').value || null });
      toast('Agent started');
    }
    input.value = '';
    S.images = [];
    renderAttachments();
    autosize();
  } catch (err) {
    toast(err.message);
  } finally {
    sendBtn.disabled = false;
  }
}

function renderAttachments() {
  const box = $('composer-attachments');
  box.replaceChildren();
  box.classList.toggle('hidden', !S.images.length);
  S.images.forEach((img, i) => {
    const chip = el('div', 'phone-attachment');
    const pic = document.createElement('img');
    pic.src = `data:${img.mediaType};base64,${img.data}`;
    const x = el('button', null, '✕');
    x.onclick = () => { S.images.splice(i, 1); renderAttachments(); };
    chip.append(pic, x);
    box.appendChild(chip);
  });
}

// Pictures are made smaller on the phone (at most 2000 px) before they go.
function readPicture(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, 2000 / Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * scale);
      c.height = Math.round(img.height * scale);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(img.src);
      resolve({ mediaType: 'image/jpeg', data: c.toDataURL('image/jpeg', 0.85).split(',')[1], name: file.name });
    };
    img.onerror = reject;
    img.src = URL.createObjectURL(file);
  });
}

// ---------- notifications ----------

let notifyId = 1;
async function notifyAbout({ id, title, body }) {
  const viewing = S.current.kind === 'chat' && currentItem()?.id === id;
  if (document.visibilityState === 'visible') {
    if (!viewing) toast(`${title}: ${body}`, 4000);
    return;
  }
  if (LocalNotifications) {
    LocalNotifications.schedule({ notifications: [{ id: notifyId++, title, body, channelId: 'agents', extra: { agentId: id } }] }).catch(() => {});
  } else if ('Notification' in window && Notification.permission === 'granted') {
    const n = new Notification(title, { body, tag: id });
    n.onclick = () => { window.focus(); openChat(id); };
  }
}

async function setUpNotifications() {
  if (LocalNotifications) {
    try {
      await LocalNotifications.requestPermissions();
      await LocalNotifications.createChannel?.({ id: 'agents', name: 'Agents', description: 'An agent finished or needs you', importance: 4 });
      LocalNotifications.addListener('localNotificationActionPerformed', e => {
        const id = e.notification?.extra?.agentId;
        if (id) openChat(id);
      });
    } catch { /* no notifications then */ }
  } else if ('Notification' in window && Notification.permission === 'default') {
    Notification.requestPermission().catch(() => {});
  }
  // Push (Firebase): only in a build that has google-services.json (see mobile/README.md).
  if (PushNotifications && window.PHONE_PUSH) {
    try {
      const perm = await PushNotifications.requestPermissions();
      if (perm.receive === 'granted') {
        PushNotifications.addListener('registration', t => { S.pushToken = t.value; link.sendPushToken(t.value); });
        PushNotifications.addListener('pushNotificationActionPerformed', e => {
          const id = e.notification?.data?.agentId || e.notification?.tag;
          if (id) setTimeout(() => openChat(id), 800);
        });
        await PushNotifications.register();
      }
    } catch { /* no push then */ }
  }
}

// ---------- connecting ----------

function renderLinkState() {
  const st = link.state;
  const dot = $('link-state');
  dot.className = 'link-state ' + st;
  dot.title = { online: 'Connected to your computer', relay: 'Your computer is not connected (is Agent Hub open there?)', connecting: 'Connecting…', off: 'Not connected' }[st];
  const banner = $('composer-banner');
  const text = st === 'relay' ? `Agent Hub on ${link.pairing?.host || 'your computer'} is not connected. Open it there (Settings → Phone must be on).`
    : st === 'connecting' && S.hello ? 'Reconnecting…' : '';
  banner.textContent = text;
  banner.classList.toggle('hidden', !text);
}

async function hello() {
  let h;
  try {
    h = await link.call('hello', { device: deviceName() });
  } catch (err) {
    toast(err.message);
    return;
  }
  h.host = link.pairing?.host;
  S.hello = h;
  S.items = h.hub.items;
  S.groups = h.hub.groups;
  deck.platform = h.platform;
  if (h.theme && window.applyTheme) {
    try { applyTheme(h.theme, { powerOn: false, curved: false }); } catch { /* default look */ }
  }
  renderPickers();
  for (const m of ['onSessionsChanged']) deck[m](() => { if (document.body.classList.contains('history-open')) loadHistory(); });
  if (S.pushToken) link.sendPushToken(S.pushToken);
  // Back after a reconnect: the open chat is drawn again.
  if (S.current.kind === 'chat') subscribe().catch(() => {});
  show();
}

function deviceName() {
  const ua = navigator.userAgent;
  const m = /Android [\d.]+; ([^;)]+?)(?: Build|\))/.exec(ua);
  return m ? m[1].trim() : /iPhone/.test(ua) ? 'iPhone' : 'Phone';
}

function showPairing(error = '') {
  $('pair').classList.remove('hidden');
  $('pair-error').textContent = error;
}

async function pairWith(text) {
  try {
    await link.pair(text);
    $('pair').classList.add('hidden');
    $('pair-link').value = '';
  } catch (err) {
    showPairing(err.message);
  }
}

link.on('state', st => {
  renderLinkState();
  if (st === 'online') hello();
});
// The computer sends the hello again on its own when it comes back (host event).
link.on('unpaired', () => showPairing());
link.on('removed', () => showPairing('This phone was removed on the computer. Pair it again to connect.'));

// ---------- wiring ----------

$('back-to-hub').onclick = backToHub;
$('toggle-sidebar').onclick = () => setHistoryOpen(true);
$('close-history').onclick = () => setHistoryOpen(false);
$('drawer-backdrop').onclick = () => setHistoryOpen(false);
$('search').oninput = renderHistory;
$('unpair').onclick = () => { if (confirm('Disconnect this phone from your computer? You need its QR code to connect again.')) { setHistoryOpen(false); link.unpair(); } };
$('send').onclick = sendMessage;
$('input').addEventListener('input', autosize);
$('input').addEventListener('keydown', e => {
  // On a phone Enter makes a new line; Send sends. With a keyboard, Ctrl/⌘+Enter sends.
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); sendMessage(); }
});
$('composer-stop').onclick = () => { const a = currentItem(); if (a) link.call('interrupt', a.id).catch(err => toast(err.message)); };
$('composer-restart').onclick = () => { const a = currentItem(); if (a) link.call('restart', a.id).catch(err => toast(err.message)); };
$('composer-attach').onclick = () => $('attach-input').click();
$('attach-input').onchange = async e => {
  for (const f of e.target.files) {
    try { S.images.push(await readPicture(f)); } catch { toast(`Could not read ${f.name}`); }
  }
  e.target.value = '';
  renderAttachments();
};
$('pair-go').onclick = () => pairWith($('pair-link').value);
$('pair-scan').onclick = async () => {
  if (!BarcodeScanner) { $('pair-scan').closest('.pair-card').querySelector('details').open = true; return; }
  try {
    const r = await BarcodeScanner.scanBarcode({ hint: 0, scanInstructions: 'Point at the code in Agent Hub → Settings → Phone' });
    if (r?.ScanResult) pairWith(r.ScanResult);
  } catch (err) {
    showPairing(err?.message || String(err));
  }
};

// The pairing link opened from the camera app (agenthub://pair#…).
AppPlugin?.addListener('appUrlOpen', e => { if (/^agenthub:\/\/pair/.test(e.url || '')) pairWith(e.url); });
// Android's back button: closes History, then the chat.
AppPlugin?.addListener('backButton', () => {
  if (document.querySelector('.phone-sheet')) document.querySelector('.phone-sheet').remove();
  else if (document.body.classList.contains('history-open')) setHistoryOpen(false);
  else if (S.current.kind === 'chat') backToHub();
  else AppPlugin.minimizeApp?.();
});
// In a browser: a pairing link in the address (…/#agenthub://pair#…).
const hashLink = (() => { try { return decodeURIComponent(location.hash.slice(1)); } catch { return ''; } })();
if (!native && hashLink.startsWith('agenthub://pair')) {
  const l = hashLink;
  history.replaceState(null, '', location.pathname);
  link.pair(l).catch(err => showPairing(err.message));
} else {
  renderLinkState();
  if (link.pairing) link.start();
  else showPairing();
}
setUpNotifications();
show();
