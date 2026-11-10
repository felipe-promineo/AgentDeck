// Draws Claude Code messages into a chat container. Live agents and saved
// transcripts both go through Transcript.add(), because they share one format.

marked.setOptions({ gfm: true, breaks: true });

// Markdown ends an image's path at the first space unless the path is in
// <...>, and agents often leave the brackets out (C:/Users/Jane Doe/a.png).
// This rule reads such a path as if it had them. It is an inline rule, so
// marked never runs it inside code. A path followed by "a title" has a quote
// in it, so the rule leaves that one to marked.
const SPACED_IMAGE = /^!\[([^\]\n]*)\]\(\s*([^\s()<>"'\n][^()<>"'\n]*?\s[^()<>"'\n]*?\.[a-z0-9]{1,5})\s*\)/i;
marked.use({
  extensions: [{
    name: 'spacedImage',
    level: 'inline',
    start: src => src.indexOf('!['),
    tokenizer(src) {
      const match = SPACED_IMAGE.exec(src);
      if (!match) return undefined;
      const image = this.lexer.inlineTokens(`![${match[1]}](<${match[2]}>)`)[0];
      if (image?.type !== 'image') return undefined;
      return { ...image, raw: match[0] };
    },
  }],
});

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

// ---------- images and videos ----------

const VIDEO_EXT = /\.(mp4|webm|mov|m4v)$/i;
const AUDIO_EXT = /\.(wav|mp3|ogg|oga|m4a|aac|flac|opus)$/i;

// The address the window loads a file on disk from (see src/media.js).
function mediaUrl(file) {
  return 'media://file/?path=' + encodeURIComponent(file);
}

// An image before and after a change: the new one on top, cut at a line you
// drag (or move with the slider) to see the old one under it.
function beforeAfter(beforeFile, afterFile) {
  const box = el('div', 'before-after');
  const stage = el('div', 'ba-stage');
  const before = document.createElement('img');
  before.src = mediaUrl(beforeFile);
  before.className = 'ba-before';
  const after = document.createElement('img');
  after.src = mediaUrl(afterFile) + '&t=' + Date.now();
  after.className = 'ba-after';
  const line = el('div', 'ba-line');
  stage.append(before, after, line, el('span', 'ba-label ba-label-before', 'Before'), el('span', 'ba-label ba-label-after', 'After'));
  const slider = document.createElement('input');
  slider.type = 'range';
  slider.min = '0';
  slider.max = '100';
  slider.value = '50';
  slider.className = 'ba-slider';
  slider.setAttribute('aria-label', 'Before and after');
  const set = v => {
    after.style.clipPath = `inset(0 0 0 ${v}%)`;
    line.style.left = `${v}%`;
  };
  slider.oninput = () => set(slider.value);
  // Dragging on the picture moves the line too.
  stage.addEventListener('pointerdown', e => {
    const move = ev => {
      const r = stage.getBoundingClientRect();
      slider.value = String(Math.round(Math.min(100, Math.max(0, ((ev.clientX - r.left) / r.width) * 100))));
      set(slider.value);
    };
    move(e);
    stage.setPointerCapture(e.pointerId);
    stage.onpointermove = move;
    stage.onpointerup = () => { stage.onpointermove = null; };
  });
  set(50);
  box.append(stage, slider);
  return box;
}

// A file path from Markdown: absolute, file://, or relative to the agent's folder.
function resolveMediaPath(src, cwd) {
  if (!src || /^(https?:|data:|media:|blob:)/i.test(src)) return null;
  let p = src;
  if (/^file:/i.test(p)) {
    try { p = decodeURIComponent(new URL(p).pathname); } catch { return null; }
  } else {
    try { p = decodeURIComponent(p); } catch { /* keep as written */ }
  }
  if (p.startsWith('/') || /^[a-z]:[\\/]/i.test(p)) return p;
  if (!cwd) return null;
  return cwd.replace(/[\\/]$/, '') + '/' + p.replace(/^\.\//, '');
}

// The shared notes of an agent's group go to the agent in front of your
// message, between <group-notes> tags (see notesBlock in app.js). The chat
// shows your message without them.
function stripGroupNotes(text) {
  // The notes and a handoff (see startFrom in app.js) can both be there.
  return String(text).replace(/^(\s*<(group-notes|handoff)\b[^>]*>[\s\S]*?<\/\2>)+\s*/, '');
}

// An Excel file's sheets that went with your message (see sheetNote in
// attachments.js) are for the agent: the chat shows the line that names the
// file, not the data.
function stripAttachedData(text) {
  return String(text).replace(/\n?<spreadsheet\b[^>]*>[\s\S]*?<\/spreadsheet>/g, '');
}

// An attached image at full size; Esc or a click closes it.
function openImageOverlay(src) {
  const box = el('div', 'lightbox');
  const img = document.createElement('img');
  img.src = src;
  box.appendChild(img);
  const close = () => { window.uiSound?.('tickDown'); box.remove(); document.removeEventListener('keydown', onKey, true); };
  const onKey = e => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
  box.onclick = close;
  document.addEventListener('keydown', onKey, true);
  document.body.appendChild(box);
  window.uiSound?.('tick');
}

// Full size on click; Esc or another click closes it.
function openLightbox(file) {
  const box = el('div', 'lightbox');
  const img = document.createElement('img');
  img.src = mediaUrl(file);
  box.append(img, el('div', 'lightbox-path', file));
  const close = () => { window.uiSound?.('tickDown'); box.remove(); document.removeEventListener('keydown', onKey, true); };
  const onKey = e => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
  box.onclick = close;
  document.addEventListener('keydown', onKey, true);
  document.body.appendChild(box);
  window.uiSound?.('tick');
}

// A video large, filling the window (like an image's lightbox). It goes on
// from where the small player was, and the small one goes on from where it
// stopped. Esc or a click beside it closes it.
function openVideoLightbox(small) {
  const box = el('div', 'lightbox video-lightbox');
  const video = document.createElement('video');
  video.controls = true;
  video.src = small.currentSrc || small.src;
  const from = small.currentTime || 0;
  const wasPlaying = !small.paused;
  small.pause();
  video.addEventListener('loadedmetadata', () => {
    video.currentTime = from;
    video.play().catch(() => {});
  }, { once: true });
  video.onclick = e => e.stopPropagation();
  box.append(video, el('div', 'lightbox-path', small.dataset.path || ''));
  const close = () => {
    window.uiSound?.('tickDown');
    small.currentTime = video.currentTime || from;
    if (wasPlaying || !video.paused) small.play().catch(() => {});
    video.pause();
    box.remove();
    document.removeEventListener('keydown', onKey, true);
  };
  const onKey = e => { if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); close(); } };
  box.onclick = close;
  document.addEventListener('keydown', onKey, true);
  document.body.appendChild(box);
  window.uiSound?.('tick');
}

// The bar along the bottom of a video in the chat, drawn by the app (the
// browser's own bar cannot take a button of ours): play or pause, the
// timeline, the time, sound on or off, and ⤢ to see the video large. It
// shows while you point at the video and while it is paused. A click on the
// video plays or pauses it; a double click shows it large.
const VIDEO_ICONS = {
  play: '<svg viewBox="0 0 16 16"><path d="M4 2.5v11l9-5.5z" fill="currentColor"/></svg>',
  pause: '<svg viewBox="0 0 16 16"><path d="M3.5 2.5h3v11h-3zM9.5 2.5h3v11h-3z" fill="currentColor"/></svg>',
  sound: '<svg viewBox="0 0 16 16"><path d="M2 6h3l4-3.5v11L5 10H2z" fill="currentColor"/><path d="M11 5.5a3.5 3.5 0 0 1 0 5M12.8 3.6a6 6 0 0 1 0 8.8" stroke="currentColor" stroke-width="1.4" fill="none" stroke-linecap="round"/></svg>',
  muted: '<svg viewBox="0 0 16 16"><path d="M2 6h3l4-3.5v11L5 10H2z" fill="currentColor"/><path d="M11 6l4 4M15 6l-4 4" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>',
  large: '<svg viewBox="0 0 16 16"><path d="M2.5 6V2.5H6M10 2.5h3.5V6M13.5 10v3.5H10M6 13.5H2.5V10" stroke="currentColor" stroke-width="1.6" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>',
};
function videoBar(video) {
  const bar = el('div', 'video-bar');
  const button = (cls, icon, title) => {
    const b = el('button', `video-btn ${cls}`);
    b.type = 'button';
    b.title = title;
    b.innerHTML = VIDEO_ICONS[icon];
    return b;
  };
  const play = button('video-play', 'play', 'Play (click the video too)');
  const seek = document.createElement('input');
  seek.type = 'range';
  seek.className = 'video-seek';
  seek.min = '0';
  seek.max = '1000';
  seek.value = '0';
  const time = el('span', 'video-time', '0:00');
  const sound = button('video-sound', 'sound', 'Sound off');
  const large = button('video-large', 'large', 'See it large (or double-click the video; Esc closes it)');
  bar.append(play, seek, time, sound, large);
  const clock = s => (Number.isFinite(s) ? `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}` : '0:00');
  const showTime = () => {
    time.textContent = `${clock(video.currentTime)} / ${clock(video.duration)}`;
    if (!seeking && video.duration) seek.value = String(Math.round((video.currentTime / video.duration) * 1000));
  };
  let seeking = false;
  const toggle = () => (video.paused ? video.play().catch(() => {}) : video.pause());
  const stop = e => { e.preventDefault(); e.stopPropagation(); };
  play.onclick = e => { stop(e); toggle(); };
  sound.onclick = e => { stop(e); video.muted = !video.muted; };
  large.onclick = e => { stop(e); openVideoLightbox(video); };
  seek.oninput = () => { seeking = true; if (video.duration) video.currentTime = (Number(seek.value) / 1000) * video.duration; };
  seek.onchange = () => { seeking = false; };
  bar.onclick = e => e.stopPropagation();
  video.addEventListener('click', e => { e.preventDefault(); toggle(); });
  video.addEventListener('dblclick', e => { e.preventDefault(); openVideoLightbox(video); });
  video.addEventListener('play', () => { play.innerHTML = VIDEO_ICONS.pause; play.title = 'Pause'; bar.parentNode?.classList.add('playing'); });
  video.addEventListener('pause', () => { play.innerHTML = VIDEO_ICONS.play; play.title = 'Play (click the video too)'; bar.parentNode?.classList.remove('playing'); });
  video.addEventListener('volumechange', () => { sound.innerHTML = VIDEO_ICONS[video.muted ? 'muted' : 'sound']; sound.title = video.muted ? 'Sound on' : 'Sound off'; });
  for (const ev of ['timeupdate', 'loadedmetadata', 'durationchange', 'seeked']) video.addEventListener(ev, showTime);
  return bar;
}

// cwd: the agent's folder. A file that is not where the chat says (an agent
// often names a file it made in a subfolder by its name alone) is looked for
// there by name (findMedia in media.js); when it is nowhere, the chat says so
// instead of showing an empty player.
function mediaElement(file, caption, cwd) {
  let node;
  const name = file.split(/[\\/]/).pop();
  if (VIDEO_EXT.test(file) || AUDIO_EXT.test(file)) {
    node = document.createElement(AUDIO_EXT.test(file) ? 'audio' : 'video');
    // A video gets the app's own bar (videoBar); a sound keeps the browser's.
    node.controls = AUDIO_EXT.test(file);
    node.preload = 'metadata';
    node.src = mediaUrl(file);
  } else {
    node = document.createElement('img');
    node.src = mediaUrl(file);
    node.alt = caption || name;
    // A click opens it large, to review: draw on it and write notes for
    // the agent (imagereview.js).
    node.title = 'Click to review it: draw on it and write what should change';
    node.onclick = () => (window.openImageReview ? openImageReview(node.dataset.path) : openLightbox(node.dataset.path));
  }
  let searched = false;
  node.addEventListener('error', async () => {
    if (!searched && cwd && window.deck?.findMedia) {
      searched = true;
      const found = await window.deck.findMedia(cwd, name).catch(() => null);
      if (found && found !== node.dataset.path) {
        node.dataset.path = found;
        node.title = found;
        node.src = mediaUrl(found);
        return;
      }
    }
    (node.closest('.video-wrap') || node).replaceWith(el('div', 'media-missing', `Cannot ${node.tagName === 'IMG' ? 'show' : 'play'} ${name}: it is not in the agent's folder`));
  });
  node.classList.add('chat-media');
  if (node.tagName === 'AUDIO') node.classList.add('chat-audio');
  node.dataset.path = file;
  if (node.tagName !== 'VIDEO') return node;
  const wrap = el('span', 'video-wrap');
  wrap.append(node, videoBar(node));
  return wrap;
}

// Markdown images with a file path show the file; a video path becomes a player.
// ---------- links and Jira tickets ----------

// Web addresses in plain text (your messages, notes, tool output).
const URL_IN_TEXT = /https?:\/\/[^\s<>"'`]+/g;

// A Jira ticket link: …/browse/KEY, or a board link with ?selectedIssue=KEY.
function jiraKeyOf(href) {
  let url;
  try { url = new URL(href); } catch { return null; }
  if (!/atlassian\.net$|(^|\.)jira\./i.test(url.hostname)) return null;
  const m = url.pathname.match(/\/browse\/([A-Z][A-Z0-9_]+-\d+)/) || (url.searchParams.get('selectedIssue') || '').match(/^([A-Z][A-Z0-9_]+-\d+)$/);
  return m ? m[1] : null;
}

// Plain text with its web addresses turned into links. Punctuation right
// after an address (a period at the end of a sentence) stays text.
function linkify(text) {
  const frag = document.createDocumentFragment();
  let last = 0;
  for (const m of text.matchAll(URL_IN_TEXT)) {
    let url = m[0];
    const trail = url.match(/[.,;:!?)\]]+$/);
    if (trail) url = url.slice(0, -trail[0].length);
    frag.append(text.slice(last, m.index));
    const a = document.createElement('a');
    a.href = url;
    a.textContent = url;
    frag.append(a);
    last = m.index + url.length;
  }
  frag.append(text.slice(last));
  return frag;
}

// Your message's text with the skills and commands it names (/viewCreation)
// as chips: the one it starts with always, the others when the app knows
// the name (window.slashNames, from the message box's list in app.js), so a
// path like /tmp stays text.
function withCommandChips(text) {
  const frag = document.createDocumentFragment();
  let last = 0;
  for (const m of text.matchAll(/(^|\s)\/([A-Za-z0-9](?:[\w:.-]*\w)?)(?=[\s.,;:!?)\]]|$)/g)) {
    const start = m.index + m[1].length;
    if (start > 0 && !window.slashNames?.has(m[2])) continue;
    frag.append(linkify(text.slice(last, start)), el('span', 'slash-chip', '/' + m[2]));
    last = start + 1 + m[2].length;
  }
  frag.append(linkify(text.slice(last)));
  return frag;
}

// A Jira link as a ticket card: Jira icon, key, title and status. The title
// and status come from Jira (see src/jira.js); without them the card shows
// the key alone and still opens the ticket.
function jiraCard(href, key) {
  const a = document.createElement('a');
  a.className = 'jira-card';
  a.href = href;
  a.title = `Open ${key} in Jira`;
  const logo = el('span', 'jira-logo');
  logo.innerHTML = '<svg viewBox="0 0 16 16" width="14" height="14"><path fill="#2684ff" d="M15.4 7.4 8.6.6 8 0 2.9 5.1.6 7.4a.8.8 0 0 0 0 1.2l4.7 4.7L8 16l5.1-5.1.1-.1 2.2-2.2a.8.8 0 0 0 0-1.2zM8 10.2 5.8 8 8 5.8 10.2 8z"/></svg>';
  const summary = el('span', 'jira-summary');
  const status = el('span', 'jira-status');
  a.append(logo, el('span', 'jira-key', key), summary, status);
  window.deck?.jiraIssue?.(key).then(issue => {
    if (!issue) return;
    summary.textContent = issue.summary;
    status.textContent = issue.status;
    status.dataset.category = issue.category;
    a.title = `${issue.type ? issue.type + ' ' : ''}${key}: ${issue.summary}\n${issue.status} · open in Jira`;
  }).catch(() => {});
  return a;
}

// ---------- Google Sheets, Docs, Slides and Forms links ----------

// What a docs.google.com link points to: { kind, label, color, where }, or
// null. where: the tab (gid) or cell range the link opens at, when it says.
const GDOC_KINDS = {
  spreadsheets: { kind: 'sheets', label: 'Google Sheet', color: '#1e8e3e' },
  document: { kind: 'docs', label: 'Google Doc', color: '#4285f4' },
  presentation: { kind: 'slides', label: 'Google Slides', color: '#f4b400' },
  forms: { kind: 'forms', label: 'Google Form', color: '#7248b9' },
};
function gdocOf(href) {
  let url;
  try { url = new URL(href); } catch { return null; }
  if (url.hostname !== 'docs.google.com') return null;
  const m = /^\/(spreadsheets|document|presentation|forms)\/d\//.exec(url.pathname);
  if (!m) return null;
  const hash = new URLSearchParams(url.hash.slice(1));
  const range = url.searchParams.get('range') || hash.get('range');
  const gid = url.searchParams.get('gid') || hash.get('gid');
  const where = range ? `Range ${range}` : gid && gid !== '0' ? `Tab ${gid}` : '';
  return { ...GDOC_KINDS[m[1]], where };
}

// A Google file link as a card, like a Jira ticket: the file's icon, its
// name (the link's own text, or the title Google shows for a file shared
// with anyone who has the link, see src/gdocs.js), and the tab or range.
// A page with a folded corner in the file's colour, and its kind's sign in
// white: a grid (Sheets), lines of text (Docs), a slide (Slides), a
// checklist (Forms).
const GDOC_SIGNS = {
  sheets: '<path fill="#fff" d="M4 9h8v6H4z"/><path fill="COLOR" d="M4.8 9.8h2.8v1.8H4.8zm3.6 0h2.8v1.8H8.4zm-3.6 2.6h2.8v1.8H4.8zm3.6 0h2.8v1.8H8.4z"/>',
  docs: '<path fill="#fff" d="M4 9h8v1.3H4zm0 2.5h8v1.3H4zm0 2.5h5.5v1.3H4z"/>',
  slides: '<rect x="3.5" y="9.5" width="9" height="6" rx="0.8" fill="none" stroke="#fff" stroke-width="1.4"/>',
  forms: '<circle cx="5" cy="10.2" r="0.9" fill="#fff"/><path fill="#fff" d="M6.8 9.6h5.2v1.2H6.8z"/><circle cx="5" cy="13.4" r="0.9" fill="#fff"/><path fill="#fff" d="M6.8 12.8h5.2v1.2H6.8z"/>',
};
const GDOC_ICON = (color, kind) => `<svg viewBox="0 0 16 20" width="12" height="15"><path fill="${color}" d="M10 0H2a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V6z"/><path fill="#fff" fill-opacity="0.45" d="M10 0v4a2 2 0 0 0 2 2h4z"/>${(GDOC_SIGNS[kind] || '').replaceAll('COLOR', color)}</svg>`;
function gdocCard(href, doc, text) {
  const a = document.createElement('a');
  a.className = `gdoc-card gdoc-${doc.kind}`;
  a.href = href;
  a.style.setProperty('--gdoc', doc.color);
  const logo = el('span', 'gdoc-logo');
  logo.innerHTML = GDOC_ICON(doc.color, doc.kind);
  // A link written with its own words ([Sprint plan](…)) has its name.
  const named = text && text.trim() !== href && !/^https?:\/\//i.test(text.trim()) ? text.trim() : '';
  const name = el('span', 'gdoc-name', named || doc.label);
  const kind = el('span', 'gdoc-kind', doc.where || doc.label.replace(/^Google /, ''));
  a.append(logo, name, kind);
  a.title = `${named || doc.label}${doc.where ? ' · ' + doc.where : ''}\nOpen in your browser`;
  if (!named) {
    window.deck?.gdocTitle?.(href).then(t => {
      if (!t) return;
      name.textContent = t;
      a.title = `${t}${doc.where ? ' · ' + doc.where : ''}\n${doc.label} · open in your browser`;
    }).catch(() => {});
  }
  return a;
}

// ---------- GitHub links ----------

// What a github.com link points to: { kind, owner, repo, id, key, name,
// fetch }, or null for pages that are not about a repository. kind: pull,
// issue, commit, run, release, file (a file or folder at a commit or
// branch), repo (the repository, or another page of it).
const GITHUB_NOT_OWNERS = new Set(['settings', 'orgs', 'organizations', 'marketplace', 'notifications', 'login', 'logout', 'join', 'search', 'explore',
  'topics', 'sponsors', 'features', 'about', 'pricing', 'apps', 'users', 'new', 'enterprise', 'collections', 'trending', 'codespaces', 'pulls',
  'issues', 'dashboard', 'account', 'security', 'site', 'contact', 'readme', 'copilot', 'stars', 'watching']);
function githubOf(href) {
  let url;
  try { url = new URL(href); } catch { return null; }
  if (!/^(www\.)?github\.com$/i.test(url.hostname)) return null;
  const parts = url.pathname.split('/').filter(Boolean).map(p => { try { return decodeURIComponent(p); } catch { return p; } });
  const [owner, repo, section, a, b] = parts;
  if (!owner || !repo || GITHUB_NOT_OWNERS.has(owner.toLowerCase()) || !/^[\w.-]+$/.test(owner) || !/^[\w.-]+$/.test(repo)) return null;
  const base = { owner, repo: repo.replace(/\.git$/, '') };
  if (section === 'pull' && /^\d+$/.test(a || '')) return { ...base, kind: 'pull', id: a, key: `#${a}`, fetch: true };
  if (section === 'issues' && /^\d+$/.test(a || '')) return { ...base, kind: 'issue', id: a, key: `#${a}`, fetch: true };
  if (section === 'commit' && /^[0-9a-f]{7,40}$/i.test(a || '')) return { ...base, kind: 'commit', id: a, key: a.slice(0, 7), fetch: true };
  if (section === 'actions' && a === 'runs' && /^\d+$/.test(b || '')) return { ...base, kind: 'run', id: b, key: 'Run', fetch: true };
  if (section === 'releases' && a === 'tag' && b) return { ...base, kind: 'release', id: b, key: b, fetch: true };
  if ((section === 'blob' || section === 'tree') && a) {
    const file = parts.slice(4).join('/');
    const lines = /^#L(\d+)(?:-L(\d+))?$/.exec(url.hash);
    const where = lines ? ` · L${lines[1]}${lines[2] ? '–' + lines[2] : ''}` : '';
    const folder = file.includes('/') ? file.slice(0, file.lastIndexOf('/')) : '';
    return { ...base, kind: 'file', id: a, key: file ? file.split('/').pop() + where : a, name: file ? `${folder ? folder + ' · ' : ''}${a}` : `Branch ${a}`, fetch: false };
  }
  const pages = { pulls: 'Pull requests', issues: 'Issues', actions: 'Actions', releases: 'Releases', compare: 'Compare', wiki: 'Wiki', branches: 'Branches', commits: 'Commits' };
  if (section && !pages[section]) return { ...base, kind: 'repo', key: '', name: section, fetch: false };
  return { ...base, kind: 'repo', key: '', name: section ? pages[section] : '', fetch: !section };
}

const GITHUB_ICON = '<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8z"/></svg>';

// A GitHub link as a card, like a Jira ticket: the GitHub mark, the
// repository, the number (or commit, or file), and from GitHub (src/github.js,
// with your gh login) the title, its state (open, merged, closed, draft,
// passed, failed) and the lines it changes.
function githubCard(href, gh, text) {
  const a = document.createElement('a');
  a.className = `github-card github-is-${gh.kind}`;
  a.href = href;
  const logo = el('span', 'github-logo');
  logo.innerHTML = GITHUB_ICON;
  const repo = el('span', 'github-repo', `${gh.owner}/${gh.repo}`);
  a.append(logo, repo);
  if (gh.key) a.append(el('span', 'github-key', gh.key));
  const named = text && text.trim() !== href && !/^https?:\/\//i.test(text.trim()) ? text.trim() : '';
  const title = el('span', 'github-title', named || gh.name || '');
  const detail = el('span', 'github-detail');
  const state = el('span', 'github-state');
  a.append(title, detail, state);
  const what = { pull: 'Pull request', issue: 'Issue', commit: 'Commit', run: 'Workflow run', release: 'Release', file: 'File', repo: 'Repository' }[gh.kind];
  a.title = `${what} · ${gh.owner}/${gh.repo}${gh.key ? ' ' + gh.key : ''}${title.textContent ? '\n' + title.textContent : ''}\nOpen on GitHub`;
  if (gh.fetch) {
    window.deck?.githubLookup?.({ kind: gh.kind, owner: gh.owner, repo: gh.repo, id: gh.id }).then(info => {
      if (!info) return;
      if (info.title) title.textContent = info.title;
      if (info.detail) detail.textContent = info.detail;
      if (info.label) {
        state.textContent = info.label;
        state.dataset.state = info.state;
      }
      a.title = `${what} · ${gh.owner}/${gh.repo}${gh.key ? ' ' + gh.key : ''}\n${info.title || ''}${info.author ? `\nby ${info.author}` : ''}${info.label ? ' · ' + info.label : ''}\nOpen on GitHub`;
    }).catch(() => {});
  }
  return a;
}

// ---------- Cortex links ----------

// A Cortex page link, read from the link alone:
//   https://cortex.tactilews.com/<space>/<page id>/<page-name>#<section>
// Returns { space, page, section } (names made readable from the link), or null.
const cortexWords = s => decodeURIComponent(s || '').replace(/[-_]+/g, ' ').trim();
const cortexTitle = s => s.replace(/\b\w/g, c => c.toUpperCase());
function cortexOf(href) {
  let url;
  try { url = new URL(href); } catch { return null; }
  if (!/^cortex\.tactilews\.com$/i.test(url.hostname)) return null;
  const [space, id, slug] = url.pathname.split('/').filter(Boolean);
  if (!space) return null;
  const isPage = /^[0-9a-f]{24}$/i.test(id || '');
  return {
    space: cortexTitle(cortexWords(space)),
    page: isPage ? (slug ? cortexTitle(cortexWords(slug)) : 'Page') : null,
    section: url.hash.length > 1 ? cortexWords(url.hash.slice(1)).replace(/^\w/, c => c.toUpperCase()) : null,
  };
}

const CORTEX_ICON = '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M3 2.5h7l3 3v8H3z"/><path d="M10 2.5v3h3"/><path d="M5.5 8h5M5.5 10.5h3.5"/></svg>';

// A Cortex link as a card, like a Jira ticket: the space, the page and the
// section it opens at; the link's own words when it has them.
function cortexCard(href, cx, text) {
  const a = document.createElement('a');
  a.className = 'cortex-card';
  a.href = href;
  const logo = el('span', 'cortex-logo');
  logo.innerHTML = CORTEX_ICON;
  const named = text && text.trim() !== href && !/^https?:\/\//i.test(text.trim()) ? text.trim() : '';
  a.append(logo, el('span', 'cortex-space', cx.space), el('span', 'cortex-page', named || cx.page || 'Space'));
  if (cx.section) a.append(el('span', 'cortex-section', `§ ${cx.section}`));
  a.title = `Cortex · ${cx.space}${cx.page ? `\n${named || cx.page}` : ''}${cx.section ? `\nSection: ${cx.section}` : ''}\nOpen in your browser`;
  return a;
}

// ---------- Slack links ----------

// What a Slack link points to, from the link alone (the app has no Slack
// login): { workspace, where, ts, thread, kind }, or null.
//   https://team.slack.com/archives/C0123/p1728900000123456[?thread_ts=…]
//   https://app.slack.com/client/T0123/C0123[/thread/C0123-1728900000.123456]
// The p… number is the message's time (seconds and microseconds), so the
// card can say when it was sent. C…: a channel, G…: a private channel or
// group, D…: a direct message.
function slackOf(href) {
  let url;
  try { url = new URL(href); } catch { return null; }
  const host = url.hostname.toLowerCase();
  if (!/(^|\.)slack\.com$/.test(host)) return null;
  const where = id => (/^D/.test(id) ? 'Direct message' : /^G/.test(id) ? 'Private channel' : 'Channel');
  const parts = url.pathname.split('/').filter(Boolean);
  let channel = null;
  let ts = null;
  let thread = null;
  if (parts[0] === 'archives' && /^[CDG][A-Z0-9]+$/.test(parts[1] || '')) {
    channel = parts[1];
    const p = /^p(\d{10})(\d{6})$/.exec(parts[2] || '');
    if (p) ts = Number(`${p[1]}.${p[2]}`);
    const t = url.searchParams.get('thread_ts');
    if (t && ts && Math.abs(Number(t) - ts) > 0.0000005) thread = Number(t);
  } else if (host === 'app.slack.com' && parts[0] === 'client' && /^[CDG][A-Z0-9]+$/.test(parts[2] || '')) {
    channel = parts[2];
    const t = /^[A-Z0-9]+-(\d+\.\d+)$/.exec(parts[4] || '');
    if (parts[3] === 'thread' && t) { ts = Number(t[1]); thread = ts; }
  } else {
    return null;
  }
  const workspace = host === 'app.slack.com' ? 'Slack' : host.replace(/\.(enterprise\.)?slack\.com$/, '');
  return { workspace, channel, where: where(channel), ts, thread, kind: ts ? 'message' : 'channel' };
}

// "Tue 14 Oct, 10:32" (with the year when it is not this year), or "Today, 10:32".
function slackTime(ts) {
  const d = new Date(ts * 1000);
  const now = new Date();
  const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  if (d.toDateString() === now.toDateString()) return `Today, ${time}`;
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return `Yesterday, ${time}`;
  const date = d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', ...(d.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}) });
  return `${date}, ${time}`;
}

const SLACK_ICON = '<svg viewBox="0 0 16 16" width="14" height="14"><path fill="#e01e5a" d="M3.4 10.1a1.7 1.7 0 1 1-1.7-1.7h1.7zm.8 0a1.7 1.7 0 0 1 3.4 0v4.2a1.7 1.7 0 1 1-3.4 0z"/><path fill="#36c5f0" d="M5.9 3.4a1.7 1.7 0 1 1 1.7-1.7v1.7zm0 .8a1.7 1.7 0 0 1 0 3.4H1.7a1.7 1.7 0 0 1 0-3.4z"/><path fill="#2eb67d" d="M12.6 5.9a1.7 1.7 0 1 1 1.7 1.7h-1.7zm-.8 0a1.7 1.7 0 0 1-3.4 0V1.7a1.7 1.7 0 1 1 3.4 0z"/><path fill="#ecb22e" d="M10.1 12.6a1.7 1.7 0 1 1-1.7 1.7v-1.7zm0-.8a1.7 1.7 0 0 1 0-3.4h4.2a1.7 1.7 0 0 1 0 3.4z"/></svg>';

// A Slack link as a card: the Slack mark, the workspace, what was linked (a
// message, a reply in a thread, or a channel), the link's own words when it
// has them, and when the message was sent.
function slackCard(href, sl, text) {
  const a = document.createElement('a');
  a.className = 'slack-card';
  a.href = href;
  const logo = el('span', 'slack-logo');
  logo.innerHTML = SLACK_ICON;
  const what = sl.kind === 'channel' ? sl.where : sl.thread ? 'Thread reply' : sl.where === 'Direct message' ? 'Direct message' : 'Message';
  const named = text && text.trim() !== href && !/^https?:\/\//i.test(text.trim()) ? text.trim() : '';
  a.append(logo, el('span', 'slack-workspace', sl.workspace), el('span', 'slack-kind', what));
  if (named) a.append(el('span', 'slack-title', named));
  if (sl.ts) a.append(el('span', 'slack-time', slackTime(sl.ts)));
  a.title = `${what} in ${sl.workspace}${sl.kind === 'message' && sl.where !== 'Direct message' ? ` (${sl.where.toLowerCase()} ${sl.channel})` : ''}${sl.ts ? '\nSent ' + new Date(sl.ts * 1000).toLocaleString() : ''}${named ? '\n' + named : ''}\nOpen in Slack`;
  return a;
}

// Every link opens in your browser; Jira ticket links become ticket cards,
// Google Sheets, Docs, Slides and Forms links become file cards, GitHub
// links become cards with their title and state, and Slack links message cards.
function decorateLinks(root) {
  for (const a of [...root.querySelectorAll('a[href]')]) {
    if (a.closest('.jira-card, .gdoc-card, .github-card, .slack-card, .cortex-card')) continue;
    const href = a.getAttribute('href');
    if (!/^https?:/i.test(href)) continue;
    a.target = '_blank';
    const key = jiraKeyOf(href);
    if (key) { a.replaceWith(jiraCard(href, key)); continue; }
    const doc = gdocOf(href);
    if (doc) { a.replaceWith(gdocCard(href, doc, a.textContent)); continue; }
    const gh = githubOf(href);
    if (gh) { a.replaceWith(githubCard(href, gh, a.textContent)); continue; }
    const sl = slackOf(href);
    if (sl) { a.replaceWith(slackCard(href, sl, a.textContent)); continue; }
    const cx = cortexOf(href);
    if (cx) a.replaceWith(cortexCard(href, cx, a.textContent));
  }
  return root;
}

// A link to a file (an HTML report, a source file at a line) opens it with
// its usual app: an HTML page in your browser, code in your editor.
function markFileLinks(root, cwd) {
  for (const a of root.querySelectorAll('a[href]')) {
    const href = a.getAttribute('href');
    if (/^(https?:|mailto:|#)/i.test(href)) continue;
    const file = resolveMediaPath(href.replace(/#.*$/, ''), cwd);
    if (file) a.dataset.file = file.replace(/:\d+(:\d+)?$/, '');
  }
}

// One handler for the whole window: a click on a web link opens it in your
// normal browser (the main process turns window.open into shell.openExternal),
// a file link opens the file, and no link ever takes the window to another page.
document.addEventListener('click', e => {
  const a = e.target.closest?.('a[href]');
  if (!a) return;
  const href = a.getAttribute('href');
  if (href.startsWith('#') || /^javascript:/i.test(href)) return;
  e.preventDefault();
  e.stopPropagation();
  if (/^https?:/i.test(href)) window.open(a.href, '_blank');
  else if (a.dataset.file) window.deck.openFile(a.dataset.file);
  else if (/^mailto:/i.test(href)) window.open(href, '_blank');
}, true);

// DOMPurify drops a link it cannot place, and it reads the drive in a
// Windows path ("C:/…", "C:\…") as an unknown kind of link ("c:"), so an
// agent's image or video with a full path showed as a broken picture. An
// image's source that is a drive path stays; markdown() then shows the file
// through media:// (mediaElement), never by loading the path itself.
DOMPurify.addHook('uponSanitizeAttribute', (node, data) => {
  if (node.nodeName === 'IMG' && data.attrName === 'src' && /^[a-z]:([\\/]|%5c)/i.test(data.attrValue)) data.forceKeepAttr = true;
});

// A JSON block in an answer gets a Copy button at its top right, so it can
// be pasted somewhere else as it is: a ```json block, or any block whose
// text reads as JSON.
function addJsonCopy(root) {
  for (const code of root.querySelectorAll('pre > code')) {
    const text = code.textContent;
    const tagged = /\blanguage-(json|jsonc|json5)\b/.test(code.className);
    let json = tagged;
    if (!json && /^\s*[[{]/.test(text)) { try { JSON.parse(text); json = true; } catch { /* not JSON */ } }
    if (!json) continue;
    const pre = code.parentElement;
    const wrap = el('div', 'code-copy-wrap');
    pre.replaceWith(wrap);
    const button = el('button', 'code-copy', 'Copy JSON');
    button.type = 'button';
    button.title = 'Copy this JSON to paste it somewhere else';
    button.onclick = async e => {
      e.stopPropagation();
      try {
        await window.deck.copyText(text.replace(/\n$/, ''));
        button.textContent = 'Copied';
        window.uiSound?.('tick');
      } catch {
        button.textContent = 'Could not copy';
      }
      setTimeout(() => { button.textContent = 'Copy JSON'; }, 1600);
    };
    wrap.append(pre, button);
  }
}

// A shell command in an answer (```bash, or ```powershell on Windows) gets
// Copy and Run buttons, like in Claude's desktop app. Run runs it in the
// agent's folder (commands.js) and shows its output under the block; Stop
// ends it while it runs. When it ends, a command-ran event tells app.js,
// which passes the result on to the agent.
const SHELL_LANGS = window.deck.platform === 'win32'
  ? /\blanguage-(powershell|pwsh|ps1)\b/
  : /\blanguage-(bash|sh|zsh|shell)\b/;
const commandOutputs = new Map();
window.deck.onCommandOutput((id, text) => commandOutputs.get(id)?.(text));
let commandCount = 0;

function addShellRun(root, cwd) {
  for (const code of root.querySelectorAll('pre > code')) {
    if (!SHELL_LANGS.test(code.className)) continue;
    const command = code.textContent.replace(/\n$/, '');
    if (!command.trim()) continue;
    const pre = code.parentElement;
    const wrap = el('div', 'code-copy-wrap code-run-wrap');
    pre.replaceWith(wrap);
    const actions = el('div', 'code-actions');
    const copy = el('button', 'code-copy', 'Copy');
    copy.type = 'button';
    copy.title = 'Copy this command';
    copy.onclick = async e => {
      e.stopPropagation();
      try {
        await window.deck.copyText(command);
        copy.textContent = 'Copied';
        window.uiSound?.('tick');
      } catch {
        copy.textContent = 'Could not copy';
      }
      setTimeout(() => { copy.textContent = 'Copy'; }, 1600);
    };
    const runButton = el('button', 'code-copy code-run', '▶ Run');
    runButton.type = 'button';
    runButton.title = `Run this command in ${cwd || 'your home folder'}`;
    let id = null;
    let output = null;
    runButton.onclick = async e => {
      e.stopPropagation();
      if (id) { window.deck.stopCommand(id); return; }
      id = `cmd-${Date.now()}-${++commandCount}`;
      if (!output) {
        output = el('div', 'code-run-output');
        output.append(el('div', 'code-run-status'), el('pre', 'code-run-text'));
        wrap.after(output);
      }
      const status = output.firstChild;
      const text = output.lastChild;
      text.textContent = '';
      text.hidden = true;
      status.className = 'code-run-status running';
      status.textContent = 'Running…';
      runButton.textContent = '■ Stop';
      runButton.title = 'Stop this command';
      commandOutputs.set(id, chunk => {
        const atEnd = text.scrollTop + text.clientHeight >= text.scrollHeight - 4;
        text.hidden = false;
        text.textContent = (text.textContent + chunk).slice(-200000);
        if (atEnd) text.scrollTop = text.scrollHeight;
      });
      const { code: exit } = await window.deck.runCommand(id, cwd, command);
      commandOutputs.delete(id);
      id = null;
      status.className = `code-run-status ${exit === 0 ? 'ok' : 'failed'}`;
      status.textContent = exit === 0 ? 'Done' : exit == null ? 'Stopped' : exit === -1 ? 'Could not start' : `Failed (exit code ${exit})`;
      if (exit === 0 && !text.textContent) status.textContent = 'Done, no output';
      runButton.textContent = '▶ Run again';
      runButton.title = `Run this command again in ${cwd || 'your home folder'}`;
      wrap.dispatchEvent(new CustomEvent('command-ran', { bubbles: true, detail: { command, exit, output: text.textContent } }));
    };
    actions.append(copy, runButton);
    wrap.append(pre, actions);
  }
}

// "You asked" cards standing beside the message box (Transcript.placePin)
// go back to their chats: when another agent's card takes the place, or the
// view changes (app.js show()). keep: a card to leave where it is. The ▲ ▼
// buttons beside the box (Transcript.placeTurnNav) go back the same way;
// only: 'pins' or 'navs' to move back only those.
function homePinBars(keep = null, only = null) {
  for (const nav of only === 'pins' ? [] : document.querySelectorAll('#composer > .turn-nav-box')) {
    if (nav === keep) continue;
    nav.classList.remove('nav-beside');
    for (const p of ['left', 'top']) nav.style.removeProperty(p);
    nav._home?.appendChild(nav);
  }
  for (const bar of only === 'navs' ? [] : document.querySelectorAll('#composer .prompt-pin-bar')) {
    if (bar === keep) continue;
    bar.classList.remove('pin-beside');
    for (const p of ['left', 'top', 'width', 'visibility']) bar.style.removeProperty(p);
    bar._home?.appendChild(bar);
  }
}
window.homePinBars = homePinBars;

// A table wider than the chat column grows sideways into the free space
// beside the chat, centred on it, up to the window's width less a margin;
// wider than that, it scrolls inside its box. Fitted again when the text's
// width changes (the window is resized, the chat opens).
const TABLE_MARGIN = 72;
function fitTables(root) {
  for (const wrap of root.querySelectorAll(':scope .table-wrap')) {
    const table = wrap.firstElementChild;
    if (!table) continue;
    wrap.classList.remove('wide');
    wrap.style.removeProperty('--tw');
    const column = wrap.clientWidth;
    if (!column) continue;
    table.style.width = 'max-content';
    const natural = table.offsetWidth;
    table.style.width = '';
    if (natural <= column + 1) continue;
    const room = Math.max(column, Math.min(window.innerWidth - TABLE_MARGIN, 1800));
    wrap.style.setProperty('--tw', `${Math.min(natural + 2, room)}px`);
    wrap.classList.add('wide');
  }
}
// The room beside the chat changes with the window, not the chat's width.
let tableResize = null;
window.addEventListener('resize', () => {
  clearTimeout(tableResize);
  tableResize = setTimeout(() => {
    for (const div of document.querySelectorAll('.msg-text')) if (div.querySelector(':scope .table-wrap')) fitTables(div);
  }, 120);
});
const tableWatch = new ResizeObserver(entries => {
  for (const e of entries) {
    const w = Math.round(e.contentRect.width);
    if (e.target._tableWidth === w) continue;
    e.target._tableWidth = w;
    fitTables(e.target);
  }
});

function markdown(text, cwd) {
  const div = el('div', 'msg-text');
  // Text boxes drawn with ╔═╗ characters become cards (see boxcard.js).
  // Diagrams drawn with │ ├ └ ▼ get a diagram block (also boxcard.js).
  const { text: rest, boxes } = extractBoxes(text);
  div.innerHTML = DOMPurify.sanitize(marked.parse(fenceGraphs(rest)), { ADD_ATTR: ['target'] });
  decorateGraphs(div);
  for (const slot of div.querySelectorAll('[data-boxcard]')) {
    const lines = boxes[Number(slot.dataset.boxcard)];
    try {
      slot.replaceWith(renderBoxCard(lines));
    } catch {
      slot.replaceWith(el('pre', null, lines.join('\n')));
    }
  }
  // ```agenthub-diff blocks: Agent Hub runs the command and shows the diff.
  for (const code of div.querySelectorAll('pre > code.language-agenthub-diff')) {
    code.parentElement.replaceWith(diffBlock(code.textContent.trim(), cwd));
  }
  // A diff the agent pasted (```diff) is drawn the same way, when it reads as one.
  for (const code of div.querySelectorAll('pre > code.language-diff, pre > code.language-patch')) {
    const files = parsePastedDiff(code.textContent);
    if (files.length) code.parentElement.replaceWith(changesCard(files, cwd, { title: 'Diff in the answer' }));
  }
  decorateLinks(div);
  markFileLinks(div, cwd);
  addJsonCopy(div);
  addShellRun(div, cwd);
  // Tables go in a box that can grow past the chat into the window's free
  // space, and scrolls sideways when even that is not enough (fitTables).
  for (const table of div.querySelectorAll('table')) {
    const wrap = el('div', 'table-wrap');
    table.replaceWith(wrap);
    wrap.appendChild(table);
  }
  if (div.querySelector('.table-wrap')) tableWatch.observe(div);
  for (const img of div.querySelectorAll('img')) {
    const file = resolveMediaPath(img.getAttribute('src'), cwd);
    if (file) img.replaceWith(mediaElement(file, img.getAttribute('alt'), cwd));
  }
  return div;
}

// A diff that the agent (an agenthub-diff block) or you (/diff in the
// message box) asked for: Agent Hub runs the read-only command in the folder
// (see branchdiff.js) and draws it like a task's Changes card.
const DIFF_FILE_LIMIT = 200;
function diffBlock(command, cwd) {
  const box = el('div', 'diff-block');
  box.appendChild(el('div', 'note', `Loading ${command.split('\n')[0] || 'the diff of this branch'}…`));
  // Several commands (one per line) show as one diff.
  const commands = command.split('\n').map(c => c.trim()).filter(c => c && !c.startsWith('#'));
  const run = commands.length > 1
    ? Promise.all(commands.map(c => window.deck.runDiff(cwd, c))).then(results => {
      const failed = results.find(r => !r?.ok);
      if (failed) return failed;
      return { ok: true, diff: results.map(r => r.diff).join('\n'), title: `${commands[0]} and ${commands.length - 1} more` };
    })
    : window.deck.runDiff(cwd, commands[0] || '');
  run.then(r => {
    box.replaceChildren();
    if (!r?.ok) {
      box.appendChild(el('div', 'note err', `${command || '/diff'}: ${r?.error || 'it did not run'}`));
      return;
    }
    const files = parseUnifiedDiff(r.diff || '');
    if (!files.length) {
      box.appendChild(el('div', 'note', `${r.title}: no differences`));
      return;
    }
    box.appendChild(changesCard(files.slice(0, DIFF_FILE_LIMIT), cwd, { title: r.title }));
    if (files.length > DIFF_FILE_LIMIT) box.appendChild(el('div', 'note', `and ${files.length - DIFF_FILE_LIMIT} more files, not shown`));
  }).catch(err => {
    box.replaceChildren(el('div', 'note err', `${command}: ${err?.message || err}`));
  });
  return box;
}

// A diff written into an answer: git's format, svn's (Index: lines), or an
// excerpt with "--- path" headers, @@ lines or "..." between the parts.
// Excerpts without @@ numbers are marked, so no line numbers are made up.
function parsePastedDiff(text) {
  if (/^diff --git /m.test(text)) return parseUnifiedDiff(text);
  const files = [];
  let file = null;
  const lines = String(text).replace(/\r/g, '').split('\n');
  const start = path => {
    file = { path: path.trim(), status: 'mod', lines: [], excerpt: true };
    files.push(file);
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const index = /^Index: (.+)$/.exec(line);
    if (index) { start(index[1]); continue; }
    if (/^=+$/.test(line)) continue;
    const minus = /^--- (?:a\/)?(\S[^\t]*?)(\t.*)?$/.exec(line);
    const next = lines[i + 1] || '';
    if (minus && (next.startsWith('+++ ') || next.startsWith('@@') || /[\/.]\w+$/.test(minus[1]))) {
      if (!file || file.lines.length || file.path !== minus[1]) start(minus[1] === '/dev/null' ? '' : minus[1]);
      if (minus[1] === '/dev/null') file.status = 'new';
      continue;
    }
    const plus = /^\+\+\+ (?:b\/)?(\S[^\t]*?)(\t.*)?$/.exec(line);
    // "+++ path" without a "---" line before it: a new file's excerpt.
    if (plus && !/^--- /.test(lines[i - 1] || '') && /[\\/.]\w+$/.test(plus[1])) {
      start(plus[1]);
      file.status = 'new';
      continue;
    }
    if (!file) continue;
    if (plus) {
      if (plus[1] === '/dev/null') file.status = 'del';
      else file.path = plus[1];
      continue;
    }
    if (line.startsWith('@@')) {
      file.lines.push(['hunk', line]);
      if (/^@@ -\d+/.test(line)) file.excerpt = false;
    } else if (/^\s*(\.\.\.|…)\s*$/.test(line)) file.lines.push(['hunk', '⋯']);
    else if (line.startsWith('+')) file.lines.push(['add', line]);
    else if (line.startsWith('-')) file.lines.push(['del', line]);
    else if (line.startsWith(' ') || line === '') file.lines.push(['ctx', ' ' + line.slice(1)]);
  }
  // Trailing blank lines are not part of the diff.
  for (const f of files) while (f.lines.length && f.lines[f.lines.length - 1][0] === 'ctx' && !f.lines[f.lines.length - 1][1].trim()) f.lines.pop();
  return files.filter(f => f.path && f.lines.some(([k]) => k === 'add' || k === 'del'));
}

// What an agent is doing, in plain words, for its Hub tile: "Editing
// SpawnerRig.cs", "Waiting for Unity", or the description it gave a command.
function stepPhrase(name, input = {}) {
  const base = p => String(p || '').split(/[\\/]/).pop();
  const words = s => s.replace(/_/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
  switch (name) {
    case 'Bash':
    case 'PowerShell': {
      if (input.description) return input.description;
      const cmd = String(input.command || '').trim().split('\n')[0];
      return cmd ? `Running ${cmd.slice(0, 60)}` : 'Running a command';
    }
    case 'Edit':
    case 'MultiEdit': return `Editing ${base(input.file_path)}`;
    case 'Write': return `Writing ${base(input.file_path)}`;
    case 'NotebookEdit': return `Editing ${base(input.notebook_path)}`;
    case 'Read': return `Reading ${base(input.file_path)}`;
    case 'Grep': return `Searching for "${String(input.pattern || '').slice(0, 40)}"`;
    case 'Glob': return `Looking for ${input.pattern || 'files'}`;
    case 'WebFetch': return 'Reading a web page';
    case 'WebSearch': return `Searching the web for "${String(input.query || '').slice(0, 40)}"`;
    case 'Task':
    case 'Agent': return input.description ? `Helper: ${input.description}` : 'Running a helper agent';
    case 'TodoWrite': return 'Updating its plan';
    case 'Skill': return `Using the ${input.skill || ''} skill`.replace('  ', ' ');
    case 'AskUserQuestion': return 'Asking you a question';
    case 'ToolSearch': return 'Loading tools';
  }
  // Connector tools: mcp__unity__unity_wait_for_ready -> "Unity: wait for ready".
  const [prefix, server, ...rest] = String(name).split('__');
  if (prefix === 'mcp' && rest.length) {
    const tool = words(rest.join(' ')).replace(new RegExp('^' + server + ' '), '');
    if (/wait.*ready/.test(tool)) return `Waiting for ${server[0].toUpperCase()}${server.slice(1)}`;
    return `${server[0].toUpperCase()}${server.slice(1)}: ${tool}`;
  }
  return words(String(name));
}

// The one argument worth showing next to a tool name in the collapsed card.
function toolSummary(name, input = {}) {
  const pick = input.command || input.file_path || input.notebook_path || input.pattern
    || input.url || input.query || input.description || input.prompt || input.skill;
  if (pick) return String(pick).split('\n')[0];
  const first = Object.values(input).find(v => typeof v === 'string');
  return first ? first.split('\n')[0] : '';
}

function resultText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map(c => (c.type === 'text' ? c.text : `[${c.type}]`)).join('\n');
  }
  return JSON.stringify(content, null, 2);
}

function clip(text, max = 6000) {
  return text.length > max ? text.slice(0, max) + `\n… (${text.length - max} more characters)` : text;
}

const DESTINATION_NAMES = {
  session: 'for this session',
  localSettings: 'in this project (only you)',
  projectSettings: 'in this project (shared)',
  userSettings: 'in all projects',
};

// Describes one suggested permission update, for example
// "Always allow Bash(npm start) in this project (only you)".
function describeSuggestion(s) {
  const where = DESTINATION_NAMES[s.destination] || '';
  if (s.type === 'addRules') {
    const rules = s.rules.map(r => (r.ruleContent ? `${r.toolName}(${r.ruleContent})` : r.toolName)).join(', ');
    return `Always allow ${rules} ${where}`.trim();
  }
  if (s.type === 'addDirectories') return `Allow access to ${s.directories.join(', ')} ${where}`.trim();
  if (s.type === 'setMode') return `Allow, and switch to ${s.mode} mode ${where}`.trim();
  return null;
}

// Tokens of one API call or one whole task. Input, cached context and output
// all count against a subscription's usage limits.
function tokenParts(usage) {
  return {
    input: usage?.input_tokens || 0,
    cacheWrite: usage?.cache_creation_input_tokens || 0,
    cacheRead: usage?.cache_read_input_tokens || 0,
    output: usage?.output_tokens || 0,
  };
}

function totalTokens(usage) {
  const t = tokenParts(usage);
  return t.input + t.cacheWrite + t.cacheRead + t.output;
}

// Adds up the API calls of a task.
function sumUsage(turn) {
  const sum = { input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0 };
  for (const u of turn.usage.values()) {
    const t = tokenParts(u);
    sum.input_tokens += t.input;
    sum.cache_creation_input_tokens += t.cacheWrite;
    sum.cache_read_input_tokens += t.cacheRead;
    sum.output_tokens += t.output;
  }
  return sum;
}

function formatTokens(n) {
  if (n < 1000) return `${n}`;
  if (n < 1e6) return `${(n / 1000).toFixed(n < 10000 ? 1 : 0)}k`;
  return `${(n / 1e6).toFixed(1)}M`;
}

// Temporary files never count as an agent's work: files in a Temp, tmp or
// .tmp folder (like Unity's Temp/), names with "tmp" or "temp" as a separate
// word (tmp_fix.py, board.temp.cs, not Template.cs), backup and editor
// leftovers (.tmp .temp .bak .orig .rej .swp ~), .DS_Store, and the Unity
// .meta file of any of these.
function isTempFile(p) {
  const parts = String(p).replace(/\\/g, '/').split('/');
  if (parts.slice(0, -1).some(dir => /^\.?(temp|tmp)$/i.test(dir))) return true;
  // Agents put their own helpers in folders like ClaudeTemp: always temporary.
  if (parts.some(n => /claude[_\-]?temp/i.test(n))) return true;
  const name = parts.pop().replace(/\.meta$/i, '');
  if (name === '.DS_Store' || name.endsWith('~')) return true;
  if (/\.(tmp|temp|bak|orig|rej|swp)$/i.test(name)) return true;
  const stem = name.replace(/\.[^.]+$/, '');
  return /(^|[_.\-\s])(tmp|temp)([_.\-\s\d]|$)/i.test(stem);
}

// A name that may be a temporary helper, with "Temp" as part of a word:
// TempClick, TempAtlasProbe/, AtlasTemp, ClaudeTemp (not Template, Attempt,
// Temperature). Real code can be named like this too, so such a file is only
// left out once it is gone (see hideGoneTemp).
function maybeTempFile(p) {
  const words = String(p).replace(/\\/g, '/').split('/').map(n => n.replace(/\.meta$/i, '').replace(/\.[^.]+$/, ''));
  return words.some(n => /(^|[_.\-\s])(Temp|Tmp|TEMP|TMP)[A-Z]/.test(n) || /[a-z](Temp|Tmp)$/.test(n) || /claude[_\-]?temp/i.test(n));
}

// How long a tool call says it will wait on purpose, in ms: the sleeps in a
// command (sleep 60), and inputs that name a duration (duration, seconds,
// waitSeconds, recordSeconds, delayMs …). Keys ending in "ms" are
// milliseconds, the others seconds. Bash's timeout is a limit, not a wait.
function plannedWaitMs(input) {
  let ms = 0;
  const command = typeof input.command === 'string' ? input.command : '';
  for (const m of command.matchAll(/\bsleep\s+(\d+(?:\.\d+)?)([smh]?)\b/g)) {
    ms += Number(m[1]) * ({ m: 60000, h: 3600000 }[m[2]] || 1000);
  }
  for (const [key, value] of Object.entries(input)) {
    if (key === 'timeout' || typeof value !== 'number' || value <= 0) continue;
    if (!/duration|seconds|secs|wait|record|delay|length/i.test(key)) continue;
    ms += /(ms|millis|milliseconds)$/i.test(key) ? value : value * 1000;
  }
  return ms;
}

// Tools that only look at things; their calls and results never count as the
// agent's work.
// The Unity tools (Unity MCP) that wait for the editor to be ready: an agent
// is only "stuck" while it waits on these (see stuckInfo).
const UNITY_WAIT = /^mcp__unity__\w*(wait_for_ready|status|recompile|refresh|compile)/i;

const READ_ONLY = new Set(['Read', 'Grep', 'Glob', 'LS', 'WebFetch', 'WebSearch', 'TodoWrite', 'Skill', 'ToolSearch']);

// The parts of a turn's evidence that can change files. A shell command is
// split into its commands (at ; && || | and new lines), and the ones that
// only read are left out: grep, cat, sed -n, ls, find, svn diff, git log and
// the like, unless they write their output to a file (> or tee) or edit in
// place (sed -i). Any other command counts, so a script or a tool nobody
// knows still names the files it may change. A tool's input (JSON) counts
// whole.
const READ_COMMAND = /^(cd|pushd|popd|ls|ll|cat|bat|head|tail|less|more|grep|egrep|fgrep|rg|ag|ack|find|fd|wc|file|stat|du|df|diff|cmp|cut|sort|uniq|tr|column|nl|jq|yq|xxd|hexdump|od|strings|which|where|type|command|echo|printf|true|false|test|\[|\[\[|pwd|date|sleep|basename|dirname|realpath|readlink|tree|sed|awk|gawk|for|while|until|if|elif|else|then|do|done|fi|case|esac|setopt|set|export|local|read|wait|time|svn +(st|stat|status|di|diff|log|info|cat|ls|list|blame|praise|annotate)|git +(status|diff|log|show|blame|ls-files|rev-parse|branch|grep|config +--get))\b/i;
const WRITES = /(^|[^0-9&<>])>>?\s*(?!&|\/dev\/null)|\btee\b|\b(sed|perl|ruby)\b[^|;&]*\s-[a-z]*i|\bawk\b[^|;&]*-i\s*inplace|\bfind\b[^|;&]*-(delete|exec|execdir)\b/i;
// A shell command split at ; && || | and new lines that are not inside
// quotes (grep -E "a|b" stays one part). A heredoc's body (python3 - <<'EOF'
// … EOF) stays in the part of the command it is for: its lines are a
// script, not commands of their own (a script line "for f in glob(…)" is
// not the shell's read-only for).
function shellParts(text) {
  const parts = [];
  let cur = '';
  let quote = null;
  const heredocs = [];   // the end words of the heredocs started on this line
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '\\' && quote !== "'") { cur += c + (text[i + 1] || ''); i++; continue; }
    if (quote) { if (c === quote) quote = null; cur += c; continue; }
    if (c === '<' && text[i + 1] === '<' && text[i + 2] !== '<') {
      const m = /^<<(-?)\s*(['"]?)([A-Za-z_][\w-]*)\2/.exec(text.slice(i));
      if (m) { heredocs.push({ word: m[3], tabs: !!m[1] }); cur += m[0]; i += m[0].length - 1; continue; }
    }
    if (c === '\n' && heredocs.length) {
      // The bodies, up to their end words, go with this part.
      let at = i + 1;
      for (const h of heredocs) {
        while (at < text.length) {
          const end = text.indexOf('\n', at);
          const line = text.slice(at, end < 0 ? text.length : end);
          at = end < 0 ? text.length : end + 1;
          if ((h.tabs ? line.replace(/^\t+/, '') : line).trim() === h.word) break;
          cur += `\n${line}`;
        }
      }
      heredocs.length = 0;
      parts.push(cur.trim());
      cur = '';
      i = at - 1;
      continue;
    }
    if (c === '"' || c === "'") { quote = c; cur += c; continue; }
    if (c === '\n' || c === ';' || c === '|' || (c === '&' && text[i + 1] === '&')) {
      parts.push(cur.trim());
      cur = '';
      if ((c === '|' && text[i + 1] === '|') || c === '&') i++;
      continue;
    }
    cur += c;
  }
  parts.push(cur.trim());
  return parts.filter(Boolean);
}

// A shell command with its simple variables filled in: after N=Foo and
// R=Assets/Res, "cat > $R/$N.asset" reads "cat > Assets/Res/Foo.asset", so
// the files a command makes through variables count as named. Values made
// by a command ($(...) or backticks) stay as they are.
function expandShellVars(text) {
  if (!text.includes('$')) return text;
  const vars = new Map();
  const fill = value => value.replace(/\$\{(\w+)\}|\$(\w+)/g, (m, a, b) => vars.has(a || b) ? vars.get(a || b) : m);
  const ASSIGN = /(?:^|[\s;&|(])(?:export\s+)?([A-Za-z_]\w*)=("([^"`]*)"|'([^']*)'|([^\s;&|'"`()]*))(?=[\s;&|)]|$)/gm;
  for (const m of text.matchAll(ASSIGN)) {
    const value = m[3] ?? m[4] ?? m[5] ?? '';
    if (value.includes('$(')) continue;
    vars.set(m[1], m[4] != null ? value : fill(value));
  }
  return vars.size ? fill(text) : text;
}

// The turn's evidence with shell variables filled in (see expandShellVars).
function expandedEvidence(turn) {
  const all = turn.evidence || [];
  if (turn.expanded && turn.expandedFrom === all.length) return turn.expanded;
  turn.expanded = all.map(text => (/^\s*[{[]/.test(text) ? text : expandShellVars(text)));
  turn.expandedFrom = all.length;
  return turn.expanded;
}

// A path from a command as a regular expression that matches the files it
// leads to: a folder matches what is in it, * any part of a name, and **/
// any number of folders.
function pathPattern(w) {
  const re = w.replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*\//g, '\u0000').replace(/\*\*/g, '\u0001').replace(/\*/g, '[^/]*')
    .replace(/\u0000/g, '(?:[^/]*/)*').replace(/\u0001/g, '.*');
  return new RegExp(`(^|/)${re}(/|$)`, 'i');
}

function writingEvidence(turn) {
  const all = expandedEvidence(turn);
  if (turn.writing && turn.writingFrom === all.length) return turn.writing;
  turn.writing = all.map(text => {
    if (/^\s*[{[]/.test(text)) return text;
    return shellParts(text).map(part => part
      // Leading words that are not the command: env assignments, "do", "(",
      // "x=$(" (the command inside counts).
      .replace(/^(\w+=\$\(|[({!]\s*|\$\(|\w+=("[^"]*"|'[^']*'|[^\s$]*)\s+|\b(do|then|else|time|sudo|command)\s+)+/g, ''))
      .filter(part => part && (!READ_COMMAND.test(part) || WRITES.test(part)))
      .join('\n');
  }).filter(Boolean);
  turn.writingFrom = all.length;
  return turn.writing;
}

// Splits the output of `git diff` into one entry per file.
// A binary file the task added or removed (git's "Binary files … differ").
const addedOrRemovedBinary = f => (f.status === 'new' || f.status === 'del') && f.lines.some(([, t]) => /^Binary files /.test(t || ''));

function parseUnifiedDiff(text) {
  const files = [];
  let file = null;
  for (const line of text.split('\n')) {
    if (line.startsWith('diff --git ')) {
      file = { path: '', status: 'mod', lines: [] };
      const m = line.match(/ b\/(.*)$/);
      if (m) file.path = m[1];
      files.push(file);
    } else if (!file) {
      continue;
    } else if (line.startsWith('new file mode')) {
      file.status = 'new';
    } else if (line.startsWith('deleted file mode')) {
      file.status = 'del';
    } else if (line.startsWith('Binary files')) {
      file.status = file.status === 'mod' ? 'bin' : file.status;
      file.binary = true;
      file.lines.push(['hunk', line]);
    } else if (line.startsWith('+++ ')) {
      if (line !== '+++ /dev/null') file.path = line.slice(4).replace(/^b\//, '');
    } else if (line.startsWith('rename from ')) {
      // A moved file (svn mv, git mv, or moved and saved again): git finds
      // it by its content. SVN lists it as the old path deleted and the new
      // one added; here it is one file, with where it came from.
      file.from = line.slice('rename from '.length);
    } else if (line.startsWith('--- ') || line.startsWith('index ') || line.startsWith('similarity') || line.startsWith('rename ')) {
      continue;
    } else if (line.startsWith('@@')) {
      file.lines.push(['hunk', line]);
    } else if (line.startsWith('+')) {
      file.lines.push(['add', line]);
    } else if (line.startsWith('-')) {
      file.lines.push(['del', line]);
    } else if (line.startsWith(' ')) {
      file.lines.push(['ctx', line]);
    }
  }
  return files.filter(f => f.path);
}

// Splits a conversation into turns. A turn starts with your message and ends
// with Claude's final answer. Everything Claude does in between (tool calls,
// thinking, notes to itself) goes into a collapsed "steps" section, and after
// the turn the chat shows only the final answer and a list of changed files.
class Transcript {
  constructor(container, cwd) {
    this.root = el('div', 'messages');
    container.appendChild(this.root);
    this.scroller = container;
    this.cwd = cwd || null;
    this.seen = new Set();          // content blocks already drawn
    this.tools = new Map();         // tool_use id -> { card, name, input }
    this.draft = null;              // text streaming in before the full message arrives
    this.turn = null;               // the turn in progress
    this.prompts = [];              // your messages: { el, text }, in order
    this.createPromptPin(container);
    this.createTurnNav(container);
  }

  // A pipeline agent's steps beside the chat (pipelineprogress.js); `plan`
  // is Pipeline.steps of the profile it runs. Once per chat.
  attachPipeline(plan) {
    if (this.pipe || !plan || !window.PipelineProgress) return;
    this.pipe = new PipelineProgress(this.scroller, this.root, plan);
  }

  // ---------- which message the output on screen answers ----------

  // A bar at the top of the chat with your message for the output on screen,
  // shown once that message has scrolled out of view. Clicking it scrolls back
  // to the message. It has no height of its own, so showing and hiding it does
  // not move the chat.
  createPromptPin(container) {
    this.pin = el('div', 'prompt-pin');
    const bar = el('button', 'prompt-pin-bar');
    bar.type = 'button';
    bar.title = 'Scroll to your message';
    this.pinText = el('span', 'prompt-pin-text');
    bar.append(el('span', 'prompt-pin-label', 'You asked'), this.pinText);
    bar.onclick = () => {
      const target = this.pinTarget?.el;
      if (!target) return;
      const top = this.scroller.scrollTop + target.getBoundingClientRect().top - this.scroller.getBoundingClientRect().top - 12;
      this.scroller.scrollTo({ top, behavior: 'smooth' });
    };
    this.pin.appendChild(bar);
    this.pinBar = bar;
    container.insertBefore(this.pin, this.root);
    let frame = 0;
    const later = () => { if (!frame) frame = requestAnimationFrame(() => { frame = 0; this.updatePromptPin(); this.updateTurnNav(); }); };
    container.addEventListener('scroll', later, { passive: true });
    // Wide content can appear without a scroll (a class diagram opening).
    window.addEventListener('resize', later);
    new ResizeObserver(later).observe(this.root);
    // Beside the message box, it follows the box when it grows (see placePin).
    const box = document.querySelector('#composer .composer-box');
    if (box) new ResizeObserver(later).observe(box);
  }

  // With room beside the chat, the card stands to the left of the message
  // box, its bottom level with the box's, growing upwards. Returns false
  // when there is not enough room there (it then keeps its place in the
  // margin at the top).
  // The card then lives in the message box's footer (the chat's scroll area
  // ends above the box and would cut it off), and goes back to its chat when
  // it is not needed there (see homePinBars).
  // The room to the left of the message box, in pixels (0 without a box).
  roomBeside() {
    const box = document.querySelector('#composer .composer-box');
    if (!box || !box.offsetParent || !this.scroller.offsetParent) return 0;
    return box.getBoundingClientRect().left - this.scroller.getBoundingClientRect().left - 32;
  }

  placePin() {
    const bar = this.pinBar;
    const composer = document.getElementById('composer');
    const box = composer?.querySelector('.composer-box');
    const clear = () => {
      if (bar.parentNode !== this.pin) this.pin.appendChild(bar);
      bar.classList.remove('pin-beside');
      for (const p of ['left', 'top', 'width']) bar.style.removeProperty(p);
      return false;
    };
    const room = this.roomBeside();
    if (room < 170) return clear();
    const b = box.getBoundingClientRect();
    homePinBars(bar, 'pins');
    const width = Math.min(room, 360);
    bar._home = this.pin;
    if (bar.parentNode !== composer) composer.appendChild(bar);
    bar.classList.add('pin-beside');
    bar.style.width = `${width}px`;
    const c = composer.getBoundingClientRect();
    bar.style.left = `${b.left - 16 - width - c.left}px`;
    bar.style.top = `${b.bottom - c.top - bar.offsetHeight}px`;
    return true;
  }

  // True when chat content lies under the bar: a few points across it are
  // checked for anything of the chat below it. The containers that hold the
  // messages (turns, answers) span the whole chat area but are empty in the
  // margin, so they do not count; anything else there (a class diagram
  // wider than the chat, a wide table) does.
  pinCovers() {
    const r = this.pinBar.getBoundingClientRect();
    if (!r.width || !r.height) return false;
    const xs = [r.left + 4, r.left + r.width / 2, r.right - 4];
    const ys = [r.top + 4, r.top + r.height / 2, r.bottom - 4];
    for (const x of xs) {
      for (const y of ys) {
        for (const node of document.elementsFromPoint(x, y)) {
          if (node === this.root || !this.root.contains(node)) continue;
          if (!node.querySelector('.msg-text, .msg-user')) return true;
        }
      }
    }
    return false;
  }

  updatePromptPin() {
    // The card shows the message the output at the bottom of the chat
    // belongs to: the last one that starts above the bottom edge. Beside the
    // message box (wide windows) it always shows; as a bar at the top of a
    // narrow chat, only once that message has scrolled up out of view.
    const area = this.scroller.getBoundingClientRect();
    const beside = getComputedStyle(this.pinBar).flexDirection === 'column' && this.roomBeside() >= 170;
    let index = -1;
    for (let i = 0; i < this.prompts.length; i++) {
      if (this.prompts[i].el.getBoundingClientRect().top < area.bottom - 4) index = i;
      else break;
    }
    const current = this.prompts[index];
    const show = !!current && (beside || current.el.getBoundingClientRect().bottom < area.top + 4);
    this.pin.classList.toggle('show', show);
    if (!show && this.pinBar.parentNode !== this.pin) homePinBars();
    if (show && this.pinTarget !== current) {
      this.pinTarget = current;
      this.pinText.textContent = current.text;
      this.pinText.title = current.text;
    }
    // In the margin beside the chat (wide windows), the card must not cover
    // what is under it, such as a class diagram wider than the chat: it
    // tucks into a small tab (pointing at it opens it), and hides when even
    // the tab would cover something. At the top of a narrow chat it is a
    // bar over the chat on purpose.
    if (!show) return;
    const inMargin = getComputedStyle(this.pinBar).flexDirection === 'column';
    if (!inMargin) { this.pin.classList.remove('tucked', 'hidden-over'); this.placePin(); return; }
    if (this.pinBar.matches(':hover')) return;
    this.pin.classList.remove('tucked', 'hidden-over');
    // Beside the message box it hides only when something wide lies under it.
    if (this.placePin()) {
      this.pinBar.style.visibility = '';
      if (this.pinCovers()) this.pinBar.style.visibility = 'hidden';
      return;
    }
    if (!this.pinCovers()) return;
    this.pin.classList.add('tucked');
    if (this.pinCovers()) this.pin.classList.add('hidden-over');
  }

  // ---------- going from one of your messages to the next ----------

  // Buttons beside the message box, to its right: ▲ and ▼ go to your
  // previous or next message, so a long answer is skipped in one click, and
  // ⤓, there once you have scrolled up, goes back to the bottom. They show
  // only when the chat is longer than the window. Without room beside the
  // box (a narrow window) they stay at the bottom right of the chat (see
  // placeTurnNav).
  createTurnNav(container) {
    this.nav = el('div', 'turn-nav');
    const box = el('div', 'turn-nav-box');
    const pair = el('div', 'turn-nav-pair');
    const button = (parent, cls, path) => {
      const b = el('button', 'turn-nav-btn ' + cls);
      b.type = 'button';
      b.innerHTML = `<svg viewBox="0 0 16 16" aria-hidden="true">${path}</svg>`;
      parent.appendChild(b);
      return b;
    };
    this.navUp = button(pair, 'up', '<path d="M3.5 10l4.5-4.5 4.5 4.5"/>');
    this.navDown = button(pair, 'down', '<path d="M3.5 6l4.5 4.5 4.5-4.5"/>');
    this.navBottom = button(box, 'bottom', '<path d="M3.5 5l4.5 4.5 4.5-4.5M3.5 13h9"/>');
    this.navBottom.title = 'Back to the bottom';
    box.prepend(pair);
    this.navUp.onclick = () => { this.updateTurnNav(); this.goToPrompt(this.navUpIndex); };
    this.navDown.onclick = () => { this.updateTurnNav(); this.goToPrompt(this.navDownIndex); };
    this.navBottom.onclick = () => {
      this.navGoal = null;
      this.scroller.scrollTo({ top: this.scroller.scrollHeight, behavior: 'smooth' });
    };
    this.nav.appendChild(box);
    this.navBox = box;
    container.insertBefore(this.nav, this.root);
  }

  // Like the "You asked" card (placePin), the buttons then live in the
  // message box's footer, because the chat's scroll area ends above the box
  // and would cut them off. Their bottom is level with the box's, 12 pixels
  // to its right. homePinBars puts them back in their chat when the view
  // changes.
  placeTurnNav() {
    const nav = this.navBox;
    const composer = document.getElementById('composer');
    const box = composer?.querySelector('.composer-box');
    const home = () => {
      if (nav.parentNode !== this.nav) this.nav.appendChild(nav);
      nav.classList.remove('nav-beside');
      for (const p of ['left', 'top']) nav.style.removeProperty(p);
    };
    if (!box || !box.offsetParent || !this.scroller.offsetParent) return home();
    const b = box.getBoundingClientRect();
    const room = this.scroller.getBoundingClientRect().right - b.right - 16;
    if (room < 34 + 24) return home();
    nav._home = this.nav;
    if (nav.parentNode !== composer) {
      homePinBars(nav, 'navs');
      composer.appendChild(nav);
    }
    nav.classList.add('nav-beside');
    const c = composer.getBoundingClientRect();
    nav.style.left = `${b.right + 12 - c.left}px`;
    nav.style.top = `${b.bottom - c.top - nav.offsetHeight}px`;
  }

  // Which of your messages ▲ and ▼ lead to: the last one above the top of
  // the window, and the first one below it. While a click's scroll is still
  // on its way, they count from the message it goes to, so clicking again
  // right away moves one message further.
  updateTurnNav() {
    const s = this.scroller;
    const n = this.prompts.length;
    const longer = s.scrollHeight > s.clientHeight + 4;
    this.nav.classList.toggle('show', longer && n > 0);
    this.navBox.classList.toggle('show', longer && n > 0);
    if (!longer || !n) return this.placeTurnNav();
    const top = s.getBoundingClientRect().top;
    let above = -1;
    let below = n;
    for (let i = 0; i < n; i++) {
      const y = this.prompts[i].el.getBoundingClientRect().top;
      if (y < top - 8) above = i;
      if (y > top + 40) { below = i; break; }
    }
    const goal = this.navGoal;
    this.navUpIndex = goal != null ? goal - 1 : above;
    this.navDownIndex = goal != null ? goal + 1 : below;
    this.navUp.disabled = this.navUpIndex < 0;
    this.navDown.disabled = this.navDownIndex >= n;
    this.navUp.title = this.navUp.disabled ? 'No earlier message of yours' : `Your previous message (${this.navUpIndex + 1} of ${n})`;
    this.navDown.title = this.navDown.disabled ? 'No later message of yours' : `Your next message (${this.navDownIndex + 1} of ${n})`;
    const away = s.scrollHeight - s.scrollTop - s.clientHeight > 80;
    this.nav.classList.toggle('away', away);
    this.navBox.classList.toggle('away', away);
    // Placed last: ⤓ coming or going changes their height.
    this.placeTurnNav();
  }

  goToPrompt(index) {
    const prompt = this.prompts[index];
    if (!prompt) return;
    this.navGoal = index;
    clearTimeout(this.navGoalTimer);
    this.navGoalTimer = setTimeout(() => { this.navGoal = null; this.updateTurnNav(); }, 700);
    const top = this.scroller.scrollTop + prompt.el.getBoundingClientRect().top - this.scroller.getBoundingClientRect().top - 12;
    this.scroller.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
  }

  // Keep the view pinned to the bottom only when the person has not scrolled up.
  pinned(change) {
    const atBottom = this.scroller.scrollHeight - this.scroller.scrollTop - this.scroller.clientHeight < 80;
    change();
    if (atBottom) this.scroller.scrollTop = this.scroller.scrollHeight;
  }

  append(node) {
    this.pinned(() => this.root.appendChild(node));
  }

  // /diff in the message box: the diff, without asking the agent.
  showDiff(command) {
    this.finishTurn();
    const box = el('div', 'diff-request');
    box.append(el('div', 'msg-user diff-command', `/diff${command ? ' ' + command : ''}`), diffBlock(command, this.cwd));
    this.append(box);
  }

  // Notes go into the current turn, under its steps, so they stay visible.
  note(text, isError) {
    const node = el('div', isError ? 'note err' : 'note');
    node.appendChild(linkify(String(text)));
    decorateLinks(node);
    if (this.turn) this.pinned(() => this.turn.live.appendChild(node));
    else this.append(node);
  }

  // ---------- turns ----------

  startTurn() {
    this.activity = 'Starting…';
    this.liveStep = null;
    const turn = {
      startedAt: Date.now(),
      el: el('div', 'turn'),
      steps: el('details', 'steps hidden'),
      // Milestones and the agent's plan while it works (see addMilestones).
      progress: el('details', 'turn-progress hidden'),
      summary: el('summary'),
      body: el('div', 'steps-body'),
      live: el('div', 'turn-live'),
      skills: el('div', 'turn-skills'),
      answer: el('div', 'turn-answer'),
      skillNames: new Set(),
      stepCount: 0,
      pendingText: [],      // text written since the last tool call; the last batch is the answer
      changes: new Map(),   // file path -> { path, created, content, hunks }
      usage: new Map(),     // API message id -> its token usage, while the task runs
    };
    turn.summary.append(el('span', 'steps-spinner'), el('span', 'steps-text', 'Working…'));
    turn.steps.append(turn.summary, turn.body);
    turn.progress.open = true;
    turn.el.append(turn.progress, turn.steps, turn.live, turn.skills, turn.answer);
    this.turn = turn;
    this.pipe?.turnStart();
    this.append(turn.el);
    return turn;
  }

  ensureTurn() {
    return this.turn || this.startTurn();
  }

  // The skills the agent ran during the task, in a row above its answer.
  // Plugin skills ("plugin:name") show their own name; the full name is in
  // the tooltip.
  addSkill(turn, name) {
    const short = name?.split(':').pop();
    if (!short || turn.skillNames.has(short)) return;
    turn.skillNames.add(short);
    if (!turn.skills.childElementCount) turn.skills.appendChild(el('span', 'skills-label', 'Skills'));
    const chip = el('span', 'skill-chip', short);
    chip.title = name;
    this.pinned(() => turn.skills.appendChild(chip));
  }

  // A message that starts with /name runs that skill. The CLI does not report
  // it, so the name is checked against the skills it listed at the start.
  addSlashSkill(turn, text) {
    const name = String(text || '').trim().match(/^\/([\w:.-]+)/)?.[1];
    if (name && this.skillList?.has(name)) this.addSkill(turn, name);
  }

  addStep(node, activity) {
    const turn = this.ensureTurn();
    turn.steps.classList.remove('hidden');
    this.pinned(() => turn.body.appendChild(node));
    if (activity) {
      turn.summary.querySelector('.steps-text').textContent = activity;
      this.activity = activity;
    }
    this.onUpdate?.();
  }

  // ---------- state for the Hub ----------

  get stepCount() {
    return this.turn ? this.turn.stepCount : this.lastTurn?.stepCount || 0;
  }

  // Tokens of the task in progress, or of the last finished task.
  get tokens() {
    return this.turn ? sumUsage(this.turn) : this.lastTurn?.usage || null;
  }

  get turnStartedAt() {
    return this.turn?.startedAt || null;
  }

  // Ends the turn: the last text Claude wrote becomes the visible answer, the
  // changed files are listed, and the steps line shows a short summary.
  finishTurn(result) {
    const turn = this.turn;
    if (!turn) return;
    this.pipe?.turnEnd(!!(result && (result.is_error || /^error/.test(result.subtype || ''))));
    this.clearDraft();
    this.turn = null;
    // Names the task's saved Changes card (see restoreChanges).
    turn.endUuid = this.lastAssistant?.uuid || null;

    this.pinned(() => {
      // The changed files come first, then Claude's message about them.
      const toolFiles = this.toolChanges(turn.changes).filter(f => !isTempFile(f.path));
      turn.files = toolFiles;
      if (toolFiles.length) turn.answer.appendChild(changesCard(this.withEarlier(turn, toolFiles), this.cwd, { animate: !!result }));
      if (toolFiles.length) this.hideGoneTemp(turn).catch(() => {});
      // Then drop files that no longer exist, unless the snapshot comparison
      // (showGitChanges) has replaced this card in the meantime. Only for a
      // task that just ended (it has a result): in a saved session, a file
      // that is gone now may have been reverted since, and it still is part
      // of what the agent did.
      if (result) this.pruneMissing(turn).then(removed => {
        if (!removed || turn.gitShown) return;
        this.pinned(() => {
          turn.answer.querySelector(':scope > .changes')?.remove();
          if (!turn.changes.size) return;
          turn.files = this.toolChanges(turn.changes);
          turn.answer.prepend(changesCard(this.withEarlier(turn, turn.files), this.cwd));
        });
      }).catch(() => {});
      for (const node of turn.pendingText) turn.answer.appendChild(node);
      if (!turn.pendingText.length && result?.result && !result.is_error) turn.answer.appendChild(markdown(result.result, this.cwd));
    });

    const parts = [`${turn.stepCount} step${turn.stepCount === 1 ? '' : 's'}`];
    if (result?.duration_ms) parts.push(`${(result.duration_ms / 1000).toFixed(1)}s`);
    // The result's usage covers the whole task; without a result (a saved
    // session), add up the API calls.
    const usage = result?.usage || sumUsage(turn);
    if (totalTokens(usage)) parts.push(`${formatTokens(totalTokens(usage))} tokens`);
    turn.summary.querySelector('.steps-text').textContent = parts.join(' · ');
    turn.el.classList.add('done');
    // The task's progress folds away under its title once it is done.
    if (turn.progressBody) turn.progress.open = false;
    this.lastFinished = turn;
    this.lastTurn = {
      stepCount: turn.stepCount,
      durationMs: result?.duration_ms || Date.now() - turn.startedAt,
      usage,
      changedFiles: turn.changes.size,
    };
    this.activity = result?.is_error ? 'Stopped with an error' : 'Finished';
    this.onUpdate?.();
    if (!turn.stepCount) turn.steps.classList.add('hidden');
    else turn.steps.classList.remove('hidden');

    if (result?.is_error) {
      if (result.api_error_status === 401) {
        this.noteIn(turn, 'Claude Code\'s saved login was rejected. Sign in again on the card Agent Hub shows, then send your message again.', true);
      }
      // The CLI often sends the error both as assistant text and as the result.
      const shown = turn.pendingText.some(n => n.textContent.trim() === (result.result || '').trim());
      if (!shown) this.noteIn(turn, result.result || `Turn ended with an error (${result.subtype})`, true);
    } else if (result?.subtype && result.subtype !== 'success') {
      this.noteIn(turn, `Turn ended: ${result.subtype}`);
    }
  }

  noteIn(turn, text, isError) {
    turn.live.appendChild(el('div', isError ? 'note err' : 'note', text));
  }

  // ---------- messages ----------

  add(msg) {
    // The last answer before each of your messages is where a rewind to that
    // message continues from (see editPrompt).
    if (msg.type === 'assistant' && msg.uuid) this.lastAssistant = { uuid: msg.uuid, session: msg.session_id || null };
    // A sub-agent's own messages (the pipeline's steps) are not the
    // governor's: they do not move the pipeline's progress.
    this.fromSubagent = !!msg.parent_tool_use_id;
    switch (msg.type) {
      case 'user': return this.addUser(msg.message, msg.tool_use_result, msg.isSynthetic || msg.isMeta);
      case 'assistant': return this.addAssistant(msg.message);
      case 'stream_event': return this.addStreamEvent(msg.event);
      case 'result': return this.finishTurn(msg);
      case 'system':
        if (msg.subtype === 'init') {
          if (Array.isArray(msg.skills)) {
            this.skillList = new Set(msg.skills);
            // The task's message may have been a /skill command.
            if (this.turn && this.prompts.length) this.addSlashSkill(this.turn, this.prompts[this.prompts.length - 1].text);
          }
          this.addStep(el('div', 'note', msg.provider === 'codex'
            ? `Session ready · Codex · ${msg.model} · ${msg.permissionMode}${msg.codex_version ? ` · Codex CLI ${msg.codex_version}` : ''}`
            : `Session ready · ${msg.model} · ${msg.permissionMode} · Claude Code ${msg.claude_code_version || ''}`));
        } else if (msg.subtype === 'compact_boundary') {
          // Claude Code summarized the conversation so far (autoCompact in Settings).
          const before = msg.compact_metadata?.pre_tokens;
          this.note(`Conversation compacted${before ? ` at ${Math.round(before / 1000)}k tokens` : ''}: the agent now has a summary of the earlier part, so it may have lost details from it.`);
        } else if (msg.subtype === 'api_retry' && msg.attempt === 1) {
          this.note(`API error (${msg.error}), retrying…`, true);
        }
        return;
      case 'app_error': return this.note(msg.message, true);
    }
  }

  // Text that Claude Code adds by itself (a skill's instructions when the
  // agent runs a skill, notes about attached images) is for the agent, not
  // you: it stays out of the chat and does not start a new turn.
  addUser(message, toolUseResult, synthetic) {
    const content = message.content;
    // A background command the agent started has finished: Claude Code wakes
    // the agent with a <task-notification> "message" so it can carry on. That
    // is not yours; it starts a new turn with a line about what finished.
    const first = typeof content === 'string' ? content : content?.find?.(b => b.type === 'text')?.text || '';
    // The summary Claude Code writes when it compacts the conversation is
    // for the agent (the chat shows a note at the compact_boundary instead).
    if (/^This session is being continued from a previous conversation/.test(first)) return;
    // Claude Code's answer to a command the app sent (a model change: "Set
    // model to opus"): a small note, not a message of yours.
    const local = /^\s*<local-command-stdout>([\s\S]*?)<\/local-command-stdout>\s*$/.exec(first);
    if (local) {
      const said = local[1].replace(/`/g, '').trim();
      if (said) this.note(said);
      return;
    }
    // A command you ran with a Run button (command-ran in app.js), or with
    // !command in the terminal: a note that starts the agent's next turn.
    const ran = /^\s*<bash-input>([\s\S]*?)<\/bash-input>[\s\S]*?<bash-stderr>([\s\S]*?)<\/bash-stderr>/.exec(first);
    if (ran) {
      this.finishTurn();
      const failed = ran[2].trim().split('\n').pop();
      this.noteIn(this.startTurn(), `You ran ${ran[1].trim().split('\n')[0].slice(0, 120)}${failed ? ` · ${failed}` : ''}`);
      return;
    }
    if (/^\s*<task-notification>/.test(first)) {
      this.pipe?.taskNotification(first);
      this.finishTurn();
      const summary = /<summary>([\s\S]*?)<\/summary>/.exec(first)?.[1]?.trim();
      this.noteIn(this.startTurn(), summary || 'A background task finished.');
      return;
    }
    // A skill you start with /name arrives only as its instructions.
    if (synthetic && this.turn) {
      const text = typeof content === 'string' ? content : content.find(b => b.type === 'text')?.text || '';
      const dir = text.match(/^Base directory for this skill: (.+)/)?.[1];
      if (dir) this.addSkill(this.turn, dir.trim().split(/[\\/]/).pop());
    }
    // The group's shared notes that went along with your message are not
    // part of what you wrote (see notesBlock in app.js).
    const texts = (synthetic ? []
      : typeof content === 'string' ? [content]
      : content.filter(b => b.type === 'text').map(b => b.text))
      .map(t => stripAttachedData(stripGroupNotes(t))).filter(t => t.trim());
    if (texts.length) {
      // Your message starts a new turn.
      this.finishTurn();
      const bubbles = texts.map(t => {
        const b = el('div', 'msg-user');
        b.appendChild(withCommandChips(t));
        return decorateLinks(b);
      });
      // Images you attached show as small pictures in your message.
      const pictures = Array.isArray(content) ? content.filter(b => b.type === 'image' && b.source?.type === 'base64') : [];
      if (pictures.length) {
        const row = el('div', 'msg-images');
        for (const p of pictures) {
          const img = document.createElement('img');
          img.src = `data:${p.source.media_type};base64,${p.source.data}`;
          img.alt = 'Attached image';
          img.onclick = () => openImageOverlay(img.src);
          row.appendChild(img);
        }
        bubbles[bubbles.length - 1].appendChild(row);
      }
      for (const b of bubbles) this.append(b);
      const prompt = { el: bubbles[0], text: texts.join('\n').trim(), after: this.lastAssistant || null };
      this.prompts.push(prompt);
      this.addEditButton(prompt, bubbles[bubbles.length - 1]);
      this.startTurn();
      prompt.turn = this.turn;
      this.addSlashSkill(this.turn, texts.join('\n'));
    }
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block.type === 'tool_result') this.fillTool(block, toolUseResult);
      }
    }
  }

  // ---------- going back to one of your messages ----------

  // Pointing at one of your messages shows Edit. Editing it and sending
  // continues the conversation from just before that message, with the new
  // text (the app does that, see rewindTo in app.js); what came after it
  // leaves the chat.
  addEditButton(prompt, bubble) {
    const button = el('button', 'msg-edit', 'Edit');
    button.type = 'button';
    button.title = 'Change this message and continue from here';
    button.onclick = e => {
      e.stopPropagation();
      this.editPrompt(prompt);
    };
    // The message itself, hidden while you edit it.
    const body = el('span', 'msg-body');
    body.append(...bubble.childNodes);
    bubble.classList.add('editable');
    bubble.append(body, button);
    prompt.bubble = bubble;
  }

  editPrompt(prompt) {
    const index = this.prompts.indexOf(prompt);
    const bubble = prompt.bubble || prompt.el;
    if (index < 0 || !this.onEditPrompt || bubble.querySelector('.msg-edit-box')) return;
    const box = el('div', 'msg-edit-box');
    const input = document.createElement('textarea');
    input.value = prompt.text;
    input.rows = Math.min(10, Math.max(2, prompt.text.split('\n').length));
    const later = this.prompts.slice(index);
    const files = later.flatMap(p => p.turn?.files || []).filter(f => f.status !== 'bin' && !f.undone);
    const options = el('div', 'msg-edit-options');
    let undo = null;
    if (files.length) {
      const label = el('label', 'msg-edit-undo');
      undo = document.createElement('input');
      undo.type = 'checkbox';
      label.append(undo, document.createTextNode(` Also undo the ${files.length} file change${files.length === 1 ? '' : 's'} made since this message`));
      options.appendChild(label);
    }
    const note = later.length > 1
      ? `The ${later.length - 1} message${later.length === 2 ? '' : 's'} after it, and the answers, leave the chat.`
      : 'Its answer leaves the chat.';
    options.appendChild(el('span', 'msg-edit-note', note));
    const cancel = el('button', null, 'Cancel');
    const send = el('button', 'msg-edit-send', 'Send');
    const buttons = el('div', 'msg-edit-buttons');
    buttons.append(cancel, send);
    box.append(input, options, buttons);
    bubble.classList.add('editing');
    bubble.appendChild(box);
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
    const close = () => { box.remove(); bubble.classList.remove('editing'); };
    const submit = () => {
      const text = input.value.trim();
      if (!text) return;
      close();
      this.onEditPrompt(index, text, { undoFiles: !!undo?.checked, files });
    };
    cancel.onclick = e => { e.stopPropagation(); close(); };
    send.onclick = e => { e.stopPropagation(); submit(); };
    box.onclick = e => e.stopPropagation();
    input.addEventListener('keydown', e => {
      e.stopPropagation();
      if (e.key === 'Escape') { e.preventDefault(); close(); }
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); submit(); }
    });
  }

  // Removes your message number index, and everything after it, from the chat.
  truncateAt(index) {
    const prompt = this.prompts[index];
    if (!prompt) return;
    this.clearDraft();
    let node = prompt.el;
    while (node) {
      const next = node.nextSibling;
      node.remove();
      node = next;
    }
    this.prompts = this.prompts.slice(0, index);
    this.turn = null;
    this.lastAssistant = prompt.after;
    this.lastFinished = this.prompts[index - 1]?.turn || null;
    this.pin.classList.remove('show');
    this.onUpdate?.();
  }

  addAssistant(message) {
    const turn = this.ensureTurn();
    // One API call can arrive as several messages with the same id and usage.
    if (message.usage && message.id) {
      turn.usage.set(message.id, message.usage);
      this.onUpdate?.();
    }
    for (const block of message.content || []) {
      const key = `${message.id}|${block.type}|${block.id || (block.text || block.thinking || '').slice(0, 300)}`;
      if (this.seen.has(key)) continue;
      this.seen.add(key);

      if (block.type === 'text' && block.text.trim()) {
        this.clearDraft();
        // "Milestone: …" lines go to the Progress panel, not into the answer.
        const rest = this.addMilestones(turn, block.text);
        if (!rest.trim()) continue;
        const node = markdown(rest, this.cwd);
        turn.pendingText.push(node);
        // Everything the agent said during the task (for the group's notes:
        // what failed and what worked is often said along the way).
        (turn.texts ||= []).push(block.text);
        this.addStep(node, block.text.split('\n')[0].slice(0, 120));
        this.liveStep = block.text.split('\n').find(l => l.trim())?.replace(/[*_`#>]/g, '').trim().slice(0, 140) || this.liveStep;
      } else if (block.type === 'thinking' && block.thinking) {
        const d = el('details', 'thinking');
        d.append(el('summary', null, 'Thinking'), el('pre', null, block.thinking));
        this.addStep(d, 'Thinking…');
        this.liveStep = 'Thinking…';
      } else if (block.type === 'tool_use') {
        if (block.name === 'Skill') this.addSkill(turn, block.input?.skill);
        if (!this.fromSubagent) this.pipe?.toolStart(block);

        this.noteEvidence(turn, block);
        this.trackTool(turn, block);
        this.clearDraft();
        // Text before a tool call was a note to itself, not the answer.
        turn.pendingText = [];
        turn.stepCount++;
        this.addStep(this.toolCard(block), `${block.name} · ${toolSummary(block.name, block.input)}`);
        this.liveStep = stepPhrase(block.name, block.input);
        if (block.name === 'TodoWrite' && Array.isArray(block.input?.todos)) this.showPlan(turn, block.input.todos);
      }
    }
  }

  // ---------- progress of long tasks ----------

  // The Progress panel at the top of a task: the milestones the agent writes
  // ("Milestone: 3 of 8 pieces animated", see MILESTONE_PROMPT in agents.js),
  // each with the time since the task started, and its plan (the TodoWrite
  // list) with how many items are done. No sound and no notification: it is
  // there for when you open the agent while it works. Returns the text
  // without its milestone lines.
  addMilestones(turn, text) {
    const kept = [];
    for (const line of text.split('\n')) {
      const m = /^\s*(?:[-*>]\s*)?(?:\*\*|__)?milestone(?:\*\*|__)?\s*:\s*(?:\*\*|__)?\s*(.+?)\s*$/i.exec(line);
      if (!m) { kept.push(line); continue; }
      const what = m[1].replace(/^\*\*|\*\*$/g, '').trim();
      if (!what) continue;
      turn.milestones = (turn.milestones || 0) + 1;
      const row = el('div', 'milestone');
      const mins = Math.max(0, Math.round((Date.now() - turn.startedAt) / 60000));
      row.append(el('span', 'milestone-mark', '◆'), el('span', 'milestone-text', what), el('span', 'milestone-time', this.replaying ? '' : mins ? `${mins} min` : 'now'));
      this.pinned(() => {
        this.progressList(turn).appendChild(row);
        this.renderProgressHead(turn);
      });
      this.liveStep = `◆ ${what}`.slice(0, 140);
    }
    return kept.join('\n');
  }

  progressList(turn) {
    if (!turn.progressBody) {
      turn.progressHead = el('summary', 'progress-head');
      turn.progressPlan = el('div', 'progress-plan hidden');
      turn.progressBody = el('div', 'progress-list');
      turn.progress.append(turn.progressHead, turn.progressPlan, turn.progressBody);
      turn.progress.classList.remove('hidden');
    }
    return turn.progressBody;
  }

  renderProgressHead(turn) {
    const head = turn.progressHead;
    head.textContent = '';
    const parts = [];
    if (turn.plan) parts.push(`${turn.plan.done} of ${turn.plan.total} done`);
    if (turn.milestones) parts.push(`${turn.milestones} milestone${turn.milestones === 1 ? '' : 's'}`);
    head.append(el('span', 'progress-title', 'Progress'), el('span', 'progress-count', parts.join(' · ')));
    if (turn.plan) {
      const bar = el('span', 'progress-bar');
      const fill = el('span', 'progress-fill');
      fill.style.width = `${Math.round((turn.plan.done / Math.max(1, turn.plan.total)) * 100)}%`;
      bar.appendChild(fill);
      head.appendChild(bar);
    }
  }

  // The agent's plan, as it updates it: ✓ done, ▶ in progress, ○ to do.
  showPlan(turn, todos) {
    this.progressList(turn);
    const done = todos.filter(t => t.status === 'completed').length;
    turn.plan = { done, total: todos.length };
    // The tile's step line: what it is on now, and how far the plan is.
    const now = todos.find(t => t.status === 'in_progress');
    if (todos.length) this.liveStep = `${now ? `▶ ${now.activeForm || now.content} · ` : ''}${done} of ${todos.length} done`.slice(0, 140);
    this.pinned(() => {
      const plan = turn.progressPlan;
      plan.textContent = '';
      plan.classList.toggle('hidden', !todos.length);
      for (const t of todos) {
        const row = el('div', `plan-item ${t.status || 'pending'}`);
        row.append(el('span', 'plan-mark', t.status === 'completed' ? '✓' : t.status === 'in_progress' ? '▶' : '○'),
          el('span', null, t.status === 'in_progress' && t.activeForm ? t.activeForm : t.content || ''));
        plan.appendChild(row);
      }
      this.renderProgressHead(turn);
    });
  }

  toolCard(block) {
    const d = el('details', 'tool');
    const summary = el('summary');
    summary.append(
      el('span', 'tool-name', block.name),
      el('span', 'tool-arg', toolSummary(block.name, block.input)),
      el('span', 'tool-state pending', '…'),
    );
    d.append(summary, el('pre', null, clip(JSON.stringify(block.input, null, 2))));
    this.tools.set(block.id, { card: d, name: block.name, input: block.input || {} });
    return d;
  }

  fillTool(block, toolUseResult) {
    this.pipe?.toolDone(block.tool_use_id, !!block.is_error, resultText(block.content));
    this.turn?.openTools?.delete(block.tool_use_id);
    if (this.turn?.unityWait?.ids.has(block.tool_use_id)) this.turn.unityWait.lastEnd = Date.now();
    const tool = this.tools.get(block.tool_use_id);
    if (!tool) return;
    const state = tool.card.querySelector('.tool-state');
    state.className = 'tool-state ' + (block.is_error ? 'err' : 'ok');
    state.textContent = block.is_error ? 'failed' : 'done';
    const out = el('pre');
    out.appendChild(linkify(clip(resultText(block.content))));
    decorateLinks(out);
    if (block.is_error) out.style.color = 'var(--err)';
    tool.card.appendChild(out);
    if (!block.is_error) this.recordChange(tool, toolUseResult);
    // A tool that makes a file on its own (a Unity recorder, a screenshot
    // tool) often only names the file in its result. Shell output is left
    // out: an `ls` there would list other agents' files too.
    if (!block.is_error && this.turn && !READ_ONLY.has(tool.name) && !['Bash', 'PowerShell'].includes(tool.name)) {
      (this.turn.results = this.turn.results || []).push(resultText(block.content).slice(0, 20000));
    }
  }

  // ---------- changed files ----------

  // After Edit and Write, the CLI reports the file path and the changed lines
  // ("structuredPatch"), or the full content for a new file.
  recordChange(tool, result) {
    if (!result || typeof result !== 'object' || !this.turn) return;
    const isNew = result.type === 'create';
    const hunks = Array.isArray(result.structuredPatch) ? result.structuredPatch : [];
    if (!isNew && !hunks.length) return;
    const path = result.filePath || tool.input.file_path;
    // Files outside the agent's folder are its own helpers (scripts in /tmp
    // or a scratch folder), not part of the work.
    if (!path || !this.isInside(path)) return;
    const entry = this.turn.changes.get(path) || { path, created: false, content: null, hunks: [] };
    if (isNew) {
      entry.created = true;
      entry.content = result.content || '';
    }
    entry.hunks.push(...hunks);
    this.turn.changes.set(path, entry);
  }

  // What the agent did during the task that can change files: the files it
  // edited or wrote, the commands it ran, the scripts it wrote, and the input
  // of other tools that change things (Unity tools, sub-agents). Read-only
  // tools do not count: reading a file does not change it.
  noteEvidence(turn, block) {
    const SCRIPT = /\.(py|sh|bash|zsh|js|mjs|cjs|ts|rb|pl|ps1|command|bat|cmd)$/i;
    const input = block.input || {};
    turn.touched = turn.touched || new Set();
    turn.evidence = turn.evidence || [];
    const file = input.file_path || input.notebook_path;
    if (file) turn.touched.add(file);
    if (block.name === 'Bash' || block.name === 'PowerShell') turn.evidence.push(String(input.command || ''));
    else if (block.name === 'Write' && SCRIPT.test(file || '')) turn.evidence.push(String(input.content || ''));
    else if (!READ_ONLY.has(block.name) && !['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(block.name)) {
      try { turn.evidence.push(JSON.stringify(input)); } catch { /* not important */ }
    }
  }

  // ---------- stuck agents ----------

  // Remembers which tool calls are still running, and since when the agent
  // has been waiting for Unity.
  trackTool(turn, block) {
    const summary = toolSummary(block.name, block.input || {});
    turn.openTools = turn.openTools || new Map();
    turn.openTools.set(block.id, { name: block.name, summary, startedAt: Date.now(), plannedMs: plannedWaitMs(block.input || {}) });
    // Waiting for Unity: the Unity tools that wait for it to be ready
    // (wait_for_ready, status, recompile, refresh), one after another.
    // Any other tool call ends the wait.
    if (UNITY_WAIT.test(block.name)) {
      if (!turn.unityWait) turn.unityWait = { since: Date.now(), count: 0, ids: new Set(), lastEnd: 0 };
      turn.unityWait.count++;
      turn.unityWait.ids.add(block.id);
      turn.unityWait.summary = block.name.replace(/^mcp__unity__/, '');
    } else {
      turn.unityWait = null;
    }
  }

  // Whether the task in progress looks stuck: it has been waiting for Unity
  // to be ready (UNITY_WAIT calls, one after another) for at least longMs.
  // Other tool calls never count, however long they run.
  // Returns { name, summary, since, count? } or null.
  stuckInfo({ longMs }) {
    const w = this.turn?.unityWait;
    if (!w) return null;
    const now = Date.now();
    // Still waiting: a Unity call is running, or the last one ended a moment
    // ago (between two polls). Once the agent does something else, it is not.
    const open = [...w.ids].some(id => this.turn.openTools?.has(id));
    if (!open && now - w.lastEnd > 10000) return null;
    if (now - w.since < longMs) return null;
    return { name: 'waiting for Unity', summary: w.summary, since: w.since, count: w.count > 1 ? w.count : undefined };
  }

  // True when the agent edited or wrote this file (path relative to its
  // folder) with its own tools, or one of its sub-agents did.
  agentEdited(turn, rel) {
    const abs = this.cwd ? `${this.cwd.replace(/[\\/]$/, '')}/${rel}` : rel;
    if (turn.touched?.has(abs) || turn.touched?.has(rel)) return true;
    // The tools report paths with the system's separator (\ on Windows).
    return [...(turn.touched || [])].some(p => this.relativePath(p).replace(/\\/g, '/').toLowerCase() === rel.toLowerCase());
  }

  // True when the agent changed this file (path relative to its folder): it
  // edited or wrote it, or named it in a command that can write files, a
  // script or a tool's input. A command that only reads (grep, cat, sed -n,
  // svn diff) does not count: another agent in the same folder may have
  // changed the file the agent was only looking at.
  agentTouched(turn, rel) {
    if (this.agentEdited(turn, rel)) return true;
    const name = rel.split('/').pop();
    return writingEvidence(turn).some(text => text.includes(rel) || text.includes(name));
  }

  // True when the agent worked in this file's folder: it named the folder
  // (a script that writes images into it names the folder, not each image),
  // or it changed another file there. For images and other binary files
  // added or removed during the task.
  folderTouched(turn, rel) {
    const dir = rel.replace(/\\/g, '/').split('/').slice(0, -1).join('/');
    if (!dir) return false;
    const inDir = p => this.relativePath(p).replace(/\\/g, '/').toLowerCase().startsWith(dir.toLowerCase() + '/');
    if ([...(turn.touched || [])].some(inDir)) return true;
    return writingEvidence(turn).some(text => text.replace(/\\/g, '/').includes(dir));
  }

  // True when a command or tool input named a deleted file by a path of at
  // least two parts that leads to it: its folder ("rm -r
  // Animations/TierTransitionView") or a pattern ("rm TierTransition/*.cs").
  // Those delete (or move) files they do not name one by one.
  folderNamed(turn, rel) {
    const file = rel.replace(/\\/g, '/');
    turn.pathWords = turn.pathWords || new Map();   // evidence text -> its path-like words
    return expandedEvidence(turn).some(text => {
      let words = turn.pathWords.get(text);
      if (!words) {
        // Only what deletes or moves files ("grep -r x Assets/Code" names a
        // folder too, and deletes nothing).
        const deletes = /\b(rm|rmdir|del|erase|rd|Remove-Item|rmtree|unlink|unlinkSync|rmSync|remove|delete|DeleteAsset|MoveAsset|mv|Move-Item|rename|renames|renameSync)\b/i.test(text);
        words = !deletes ? [] : text.replace(/\\/g, '/').split(/[\s'"`;|&()<>,=]+/)
          .map(w => w.replace(/^\.\//, '').replace(/\/+$/, ''))
          .filter(w => /[^/]\/[^/]/.test(w) && w.length < 300)
          .map(pathPattern);
        turn.pathWords.set(text, words);
      }
      return words.some(re => re.test(file));
    });
  }

  // True when a command or script that writes names a pattern with a
  // wildcard that matches this file: a script that edits every file of
  // glob('Expedition/**/*.cs') names none of them one by one. The pattern
  // needs a folder name of its own ("**/*.cs" alone matches anything).
  patternNamed(turn, rel) {
    const file = rel.replace(/\\/g, '/');
    turn.globWords = turn.globWords || new Map();   // evidence text -> its wildcard patterns
    return writingEvidence(turn).some(text => {
      let words = turn.globWords.get(text);
      if (!words) {
        words = text.replace(/\\/g, '/').split(/[\s'"`;|&()<>,=[\]{}]+/)
          .map(w => w.replace(/^\.\//, '').replace(/\/+$/, ''))
          .filter(w => w.includes('*') && /(^|\/)[^*/]+\//.test(w) && w.length < 300)
          .map(pathPattern);
        turn.globWords.set(text, words);
      }
      return words.some(re => re.test(file));
    });
  }

  // Like agentTouched, for an image or video found in the folder: the agent
  // named it in a command or a tool's input, or a tool's result named it.
  agentMadeMedia(turn, file) {
    const rel = this.relativePath(file);
    if (turn.touched?.has(file) || this.agentTouched(turn, rel)) return true;
    const name = rel.split(/[\\/]/).pop();
    return (turn.results || []).some(text => text.includes(rel) || text.includes(name));
  }

  isInside(p) {
    if (!this.cwd) return true;
    return p === this.cwd || this.relativePath(p) !== p;
  }

  // Leaves out files the agent created and deleted again during the task:
  // only files that still exist when it is done are part of its work. Resolves
  // true when something was left out.
  async pruneMissing(turn) {
    const paths = [...turn.changes.keys()];
    if (!paths.length || !window.deck?.existingFiles) return false;
    const existing = new Set(await window.deck.existingFiles(paths));
    let removed = false;
    for (const p of paths) {
      if (!existing.has(p)) {
        turn.changes.delete(p);
        removed = true;
      }
    }
    return removed;
  }

  // Helpers with a temporary-looking name (maybeTempFile) that the agent
  // made and that are gone now leave the turn's Changes card.
  async hideGoneTemp(turn) {
    const files = turn.files || [];
    const candidates = files.filter(f => f.status !== 'del' && maybeTempFile(f.path));
    if (!candidates.length || !window.deck?.existingFiles) return;
    const abs = candidates.map(f => resolveMediaPath(f.path, this.cwd) || f.path);
    const existing = new Set(await window.deck.existingFiles(abs).catch(() => abs));
    const gone = new Set(candidates.filter((f, i) => !existing.has(abs[i])).map(f => f.path));
    if (!gone.size) return;
    turn.files = files.filter(f => !gone.has(f.path));
    for (const p of [...turn.changes.keys()]) if (gone.has(this.relativePath(p))) turn.changes.delete(p);
    this.pinned(() => {
      turn.answer.querySelector(':scope > .changes')?.remove();
      if (turn.files.length) turn.answer.prepend(changesCard(this.withEarlier(turn, turn.files), this.cwd));
    });
  }

  // The changes of the same files in the tasks before this one, oldest first
  // (f.earlier: [{ status, lines }]), so a file's version from this task can
  // be rebuilt from the session's history after the files were reverted (see
  // versions in src/undo.js).
  withEarlier(turn, files) {
    const key = p => String(p).replace(/\\/g, '/').toLowerCase();
    const before = [];
    for (const p of this.prompts) {
      if (p.turn === turn) break;
      if (p.turn?.files) before.push(p.turn.files);
    }
    for (const f of files) {
      f.earlier = before.flatMap(list => list.filter(e => key(e.path) === key(f.path)).map(e => ({ status: e.status, lines: e.lines })));
    }
    return files;
  }

  relativePath(p) {
    if (!this.cwd) return p;
    // Either separator and any case: Windows paths come as C:\Repos or c:/Repos.
    const root = this.cwd.replace(/[\\/]$/, '').replace(/\\/g, '/').toLowerCase();
    return p.replace(/\\/g, '/').toLowerCase().startsWith(root + '/') ? p.slice(root.length + 1) : p;
  }

  // Turns the Edit/Write reports into the same shape as a parsed git diff:
  // [{ path, status: 'new' | 'mod' | 'del', lines: [[kind, text]] }].
  toolChanges(changes) {
    return [...changes.values()].map(f => {
      const lines = [];
      if (f.created) {
        for (const line of (f.content || '').replace(/\n$/, '').split('\n')) lines.push(['add', '+' + line]);
      }
      for (const h of f.hunks) {
        lines.push(['hunk', `@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`]);
        for (const line of h.lines) lines.push([line[0] === '+' ? 'add' : line[0] === '-' ? 'del' : 'ctx', line]);
      }
      return { path: this.relativePath(f.path), status: f.created ? 'new' : 'mod', lines };
    });
  }

  // Replaces the turn's Changes card with the snapshot comparison, which also
  // includes files changed by shell commands. A folder snapshot records only
  // code files, so with merge=true the Edit/Write reports for other files
  // (for example a .prefab) are kept.
  // otherEdit(path): true when another agent edited that file during this
  // task (see editedByOther in app.js). ownOnly(file): that file with only
  // this agent's lines (see ownDiff in app.js).
  async showGitChanges(turn, diffText, merge, { otherEdit = null, ownOnly = null } = {}) {
    if (!turn || diffText == null) return;
    turn.gitShown = true;
    // The snapshot also catches changes you (or other agents) made in the same
    // folder while this agent worked. Only files the agent touched stay, and
    // a file another agent edited meanwhile only when this agent edited it too.
    const own = f => this.agentEdited(turn, f.path) || (f.from && this.agentEdited(turn, f.from));
    let files = pairMoves(parseUnifiedDiff(diffText)).filter(f => !isTempFile(f.path) && (own(f) || (!otherEdit?.(f.path)
      && (this.agentTouched(turn, f.path) || (f.from && this.agentTouched(turn, f.from))
      || (addedOrRemovedBinary(f) && this.folderTouched(turn, f.path))
      || (f.status === 'del' && this.folderNamed(turn, f.path))
      || this.patternNamed(turn, f.path) || (f.from && this.patternNamed(turn, f.from))
      || (f.from && this.folderNamed(turn, f.from))))));
    // In a file both agents changed, the other agent's lines are left out:
    // the file shows only what this agent's edits did (when they still undo
    // from the file; else the whole diff, as before).
    if (ownOnly && otherEdit) {
      files = (await Promise.all(files.map(async f => {
        if (!otherEdit(f.path) || f.status !== 'mod') return f;
        const mine = await ownOnly(f).catch(() => null);
        if (mine === 'none') return null;
        return mine ? { ...mine, ownOnly: true } : f;
      }))).filter(Boolean);
    }
    if (merge) {
      await this.pruneMissing(turn).catch(() => {});
      // The snapshot's paths use /, the Edit/Write reports the system's own
      // separator (\ on Windows), and the case of a drive letter may differ.
      const key = p => p.replace(/\\/g, '/').toLowerCase();
      const seen = new Set(files.map(f => key(f.path)));
      for (const f of this.toolChanges(turn.changes)) if (!seen.has(key(f.path)) && !isTempFile(f.path)) files.push(f);
    }
    turn.files = files;
    this.pinned(() => {
      turn.answer.querySelector(':scope > .changes')?.remove();
      if (files.length) turn.answer.prepend(changesCard(this.withEarlier(turn, files), this.cwd, { animate: true }));
    });
    if (files.length) this.hideGoneTemp(turn).catch(() => {});
    if (this.lastFinished === turn && this.lastTurn) {
      this.lastTurn.changedFiles = files.length;
      this.onUpdate?.();
    }
  }

  // Puts back a task's Changes card as the snapshot comparison made it
  // (saved in src/turnchanges.js), when a saved session is opened again.
  restoreChanges(turn, files) {
    if (!turn || !Array.isArray(files) || !files.length) return;
    turn.gitShown = true;
    turn.files = files;
    this.pinned(() => {
      turn.answer.querySelector(':scope > .changes')?.remove();
      turn.answer.prepend(changesCard(this.withEarlier(turn, files), this.cwd));
    });
  }

  // ---------- new images and videos ----------

  // Images and videos that appeared or changed in the agent's folder during
  // the task, in a card next to the code changes. Files the agent already
  // showed in its message are left out.
  showMedia(turn, files, snap = null) {
    if (!turn || !files?.length) return;
    const shown = new Set([...turn.el.querySelectorAll('.msg-text .chat-media')].map(n => n.dataset.path));
    // The search finds every new file in the folder, also those other agents
    // (or you) made at the same time. Only files this agent made stay.
    files = files.filter(f => !shown.has(f.path) && !isTempFile(f.path) && this.agentMadeMedia(turn, f.path));
    if (!files.length) return;
    const card = el('div', 'media-card');
    const videos = files.filter(f => f.kind === 'video').length;
    const sounds = files.filter(f => f.kind === 'audio').length;
    const images = files.length - videos - sounds;
    const parts = [];
    if (images) parts.push(`${images} new or changed image${images === 1 ? '' : 's'}`);
    if (videos) parts.push(`${videos} video${videos === 1 ? '' : 's'}`);
    if (sounds) parts.push(`${sounds} sound${sounds === 1 ? '' : 's'}`);
    card.appendChild(el('div', 'changes-head', parts.join(' · ')));
    const grid = el('div', 'media-grid');
    for (const f of files) {
      const item = el('figure', 'media-item');
      const media = mediaElement(f.path, null, this.cwd);
      item.append(media, el('figcaption', null, this.relativePath(f.path)));
      grid.appendChild(item);
      // A changed image: before and after, with a slider between them.
      if (f.kind === 'image' && window.deck?.mediaBefore) {
        window.deck.mediaBefore(this.cwd, f.path, snap).then(before => {
          if (!before) return;
          this.pinned(() => {
            media.replaceWith(beforeAfter(before, f.path));
            item.classList.add('compare');
          });
        }).catch(() => {});
      }
    }
    card.appendChild(grid);
    this.pinned(() => {
      turn.el.querySelector('.media-card')?.remove();
      const changes = turn.answer.querySelector(':scope > .changes');
      if (changes) changes.after(card);
      else turn.answer.prepend(card);
    });
  }

  // ---------- permission prompts ----------

  // A card that asks you to allow or deny one tool call. decide(decision)
  // sends the answer to the agent. It stays visible outside the steps.
  permission(req, decide) {
    const card = el('div', 'permission');
    const head = el('div', 'perm-head');
    head.append(el('span', 'perm-icon', '⚠'), el('span', null, req.title || `Claude wants to use ${req.display_name || req.tool_name}`));
    card.appendChild(head);
    if (req.description) card.appendChild(el('div', 'perm-desc', req.description));

    const input = req.input || {};
    const main = input.command || input.file_path || input.url || input.pattern;
    card.appendChild(el('pre', 'perm-input', clip(main ? String(main) : JSON.stringify(input, null, 2), 3000)));
    if (req.decision_reason) card.appendChild(el('div', 'perm-desc', req.decision_reason));
    if (req.blocked_path) card.appendChild(el('div', 'perm-desc', `Path: ${req.blocked_path}`));

    const buttons = el('div', 'perm-buttons');
    const finish = (decision, label) => {
      window.uiSound?.(decision.behavior === 'allow' ? 'approve' : 'deny');
      decide(decision);
      buttons.replaceWith(el('div', 'perm-result ' + (decision.behavior === 'allow' ? 'ok' : 'err'), label));
      card.classList.add('answered');
    };

    const allow = el('button', 'primary', 'Allow once');
    allow.onclick = () => finish({ behavior: 'allow', updatedInput: input }, 'Allowed');
    buttons.appendChild(allow);

    for (const s of req.permission_suggestions || []) {
      const label = describeSuggestion(s);
      if (!label) continue;
      const b = el('button', null, label);
      b.onclick = () => finish({ behavior: 'allow', updatedInput: input, updatedPermissions: [s] }, label);
      buttons.appendChild(b);
    }

    const deny = el('button', 'danger', 'Deny');
    deny.onclick = () => finish({ behavior: 'deny', message: 'The user denied this action.' }, 'Denied');
    buttons.appendChild(deny);

    card.appendChild(buttons);
    card.dataset.requestId = req.requestId;
    const turn = this.ensureTurn();
    this.pinned(() => turn.live.appendChild(card));
    this.scroller.scrollTop = this.scroller.scrollHeight;
    return card;
  }

  // A question from Claude (the AskUserQuestion tool), drawn like in the
  // Claude desktop app: each question with its options as clickable cards,
  // plus a field for your own answer. decide(decision) sends the answers.
  // The returned card has answerWith(text), used when you type the answer in
  // the message box instead.
  question(req, decide) {
    const input = req.input || {};
    const questions = input.questions || [];
    const chosen = questions.map(() => new Set());   // selected option labels per question
    const own = questions.map(() => '');             // typed answer per question

    const card = el('div', 'permission question-card');
    card.dataset.requestId = req.requestId;
    const head = el('div', 'perm-head');
    const who = req.who || 'Claude';
    head.append(el('span', 'question-icon', '?'), el('span', null, questions.length > 1 ? `${who} has some questions` : `${who} has a question`));
    card.appendChild(head);

    const answers = () => {
      const out = {};
      questions.forEach((q, i) => {
        const parts = [...chosen[i]];
        if (own[i].trim()) parts.push(own[i].trim());
        if (parts.length) out[q.question] = parts.join(', ');
      });
      return out;
    };
    const complete = () => Object.keys(answers()).length === questions.length;

    const footer = el('div', 'perm-buttons');
    const submit = el('button', 'primary', 'Answer');
    const skip = el('button', null, 'Skip');
    footer.append(submit, skip);

    let done = false;
    const finish = (decision, label) => {
      if (done) return;
      done = true;
      window.uiSound?.(decision.behavior === 'allow' ? 'approve' : 'deny');
      decide(decision);
      card.classList.add('answered');
      for (const b of card.querySelectorAll('button, input')) b.disabled = true;
      footer.replaceWith(el('div', 'perm-result ' + (decision.behavior === 'allow' ? 'ok' : 'err'), label));
    };
    const send = () => {
      if (!complete()) return;
      const a = answers();
      finish({ behavior: 'allow', updatedInput: { ...input, answers: a } }, Object.values(a).join(' · '));
    };
    submit.onclick = send;
    skip.onclick = () => finish({ behavior: 'deny', message: 'The user chose not to answer these questions.' }, 'Skipped');
    const refresh = () => { submit.disabled = !complete(); };

    // When every question takes one answer, picking the last missing one sends
    // them all right away, without a click on Answer.
    const instant = questions.every(q => !q.multiSelect);
    const pickers = [];   // per question: pick(labels) marks those options

    questions.forEach((q, i) => {
      const block = el('div', 'question');
      const title = el('div', 'question-title');
      if (q.header) title.appendChild(el('span', 'question-chip', q.header));
      title.appendChild(el('span', null, q.question));
      block.appendChild(title);
      if (q.multiSelect) block.appendChild(el('div', 'question-hint', 'Pick one or more'));

      const list = el('div', 'question-options');
      const buttons = [];
      (q.options || []).forEach((o, n) => {
        const b = el('button', 'question-option');
        b.type = 'button';
        const text = el('span', 'question-option-text');
        text.append(el('span', 'question-option-label', o.label));
        if (o.description) text.append(el('span', 'question-option-desc', o.description));
        b.append(el('span', 'question-key', String(n + 1)), text);
        b.onclick = () => {
          if (q.multiSelect) {
            chosen[i].has(o.label) ? chosen[i].delete(o.label) : chosen[i].add(o.label);
          } else {
            chosen[i] = new Set([o.label]);
            own[i] = '';
            other.value = '';
          }
          for (const [k, btn] of buttons.entries()) btn.classList.toggle('selected', chosen[i].has(q.options[k].label));
          refresh();
          // The last missing answer sends them all (with its own sound).
          if (instant && complete()) send();
          else window.uiSound?.('select');
        };
        buttons.push(b);
        list.appendChild(b);
      });
      block.appendChild(list);
      pickers[i] = labels => {
        chosen[i] = new Set(labels);
        own[i] = '';
        other.value = '';
        for (const [k, btn] of buttons.entries()) btn.classList.toggle('selected', chosen[i].has(q.options[k].label));
      };

      const other = document.createElement('input');
      other.className = 'question-other';
      other.placeholder = 'Or type your own answer…';
      other.oninput = () => {
        own[i] = other.value;
        if (!q.multiSelect && other.value.trim()) {
          chosen[i].clear();
          for (const btn of buttons) btn.classList.remove('selected');
        }
        refresh();
      };
      other.onkeydown = e => {
        if (e.key === 'Enter') {
          e.preventDefault();
          if (pickByNumber(i, other.value)) refresh();
          send();
        }
      };
      block.appendChild(other);
      card.appendChild(block);
    });

    card.appendChild(footer);
    refresh();

    // Typed option numbers ("2", or "1, 3" where more answers are allowed)
    // count as picking those options. Returns false for any other text.
    function pickByNumber(i, text) {
      const q = questions[i];
      const nums = String(text).trim().split(/\s*[,\s]\s*/).filter(Boolean);
      if (!nums.length || !nums.every(n => /^\d+$/.test(n))) return false;
      const labels = nums.map(n => q.options?.[Number(n) - 1]?.label);
      if (labels.some(l => !l) || (!q.multiSelect && labels.length > 1)) return false;
      pickers[i](labels);
      return true;
    }

    // A typed answer from the message box answers the first unanswered
    // question. Once every question has an answer, they are sent.
    card.answerWith = text => {
      const i = Math.max(0, questions.findIndex((_, k) => !chosen[k].size && !own[k].trim()));
      if (!pickByNumber(i, text)) {
        own[i] = text;
        const field = card.querySelectorAll('.question-other')[i];
        if (field) field.value = text;
      }
      refresh();
      // More questions still open: a small click for this answer.
      if (!complete()) window.uiSound?.('select');
      send();
    };
    // Enter in an empty message box sends answers that are complete (after
    // picking several options with the number keys).
    card.sendIfComplete = () => { if (complete()) { send(); return true; } return false; };

    const turn = this.ensureTurn();
    this.pinned(() => turn.live.appendChild(card));
    this.scroller.scrollTop = this.scroller.scrollHeight;
    return card;
  }

  cancelPermission(requestId) {
    const card = this.root.querySelector(`.permission[data-request-id="${CSS.escape(requestId)}"]`);
    const buttons = card?.querySelector('.perm-buttons');
    if (buttons) {
      buttons.replaceWith(el('div', 'perm-result', 'Cancelled'));
      card.classList.add('answered');
    }
  }

  // ---------- streaming text ----------

  // Partial messages: show text as it arrives, under the steps, then swap it
  // for the rendered Markdown when the complete message comes in.
  addStreamEvent(event) {
    if (event?.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
      const turn = this.ensureTurn();
      if (!this.draft) {
        this.draft = el('div', 'msg-draft');
        turn.live.appendChild(this.draft);
      }
      this.pinned(() => { this.draft.textContent += event.delta.text; });
    }
  }

  clearDraft() {
    if (this.draft) this.draft.remove();
    this.draft = null;
  }
}

window.Transcript = Transcript;
window.isTempFile = isTempFile;
window.totalTokens = totalTokens;
window.formatTokens = formatTokens;
window.tokenParts = tokenParts;
window.el = el;
