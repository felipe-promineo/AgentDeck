const { app, BrowserWindow, ipcMain, dialog, shell, Notification, Menu, protocol, net, nativeImage, systemPreferences, globalShortcut } = require('electron');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { AgentManager, fetchModels, summarizeTitle, rateTask, pickGame, mergeNotes, suggestFollowUps, fetchUsage, setProviderLimited } = require('./agents');
const { CodexManager, fetchCodexModels, fetchCodexUsage, listCodexThreads, loadCodexThread } = require('./codex');
const { listSessions, loadTranscript, PROJECTS_DIR } = require('./sessions');
const git = require('./git');
const { repoOf, branchOf } = require('./repos');
const media = require('./media');
const jira = require('./jira');
const connectors = require('./connectors');
const auth = require('./auth');
const accounts = require('./accounts');
const voice = require('./voice');
const agentList = require('./agentlist');
const { runDiff } = require('./branchdiff');
const commands = require('./commands');
const svnBranches = require('./svnbranches');
const handoff = require('./handoff');
const { activity } = require('./activity');
const updates = require('./updates');
const undo = require('./undo');
const csharp = require('./csharp');
const gameFolders = require('./gamefolders');
const toast = require('./toast');
const { ReviewPeer } = require('./reviewpeer');
const pipeline = require('./pipeline');

// The window loads images and videos from disk through media:// (see media.js).
// "stream" lets video players read a file piece by piece.
protocol.registerSchemesAsPrivileged([
  { scheme: 'media', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

// Settings you can edit by hand. The app writes this file with the defaults
// the first time it starts; use "Settings" in the sidebar to open it.
const DEFAULT_CONFIG = {
  claudePath: '',                       // empty means: look in the usual install folders
  // Providers: Claude Code and OpenAI's Codex CLI (codex.js). New agents
  // start on defaultProvider; when its limit is reached they start on the
  // other one, if it is on.
  claudeEnabled: true,
  codexEnabled: false,
  defaultProvider: 'claude',            // claude | codex
  codexPath: '',                        // empty means: look in the usual install folders
  codexModel: 'auto',                   // auto (Luna, Terra or Sol per task, like Claude's Auto), a family (sol, terra, luna, astra: its newest model) or a model id
  codexEffort: '',                      // low | medium | high | xhigh | max | ultra; empty: Auto picks it (with the Auto model), else the model's default
  codexFastMode: false,                 // Codex's Fast service tier for new agents (faster; for some models it uses your limits faster)
  codexExtraArgs: [],                   // extra command-line flags for every Codex agent (codex app-server)
  // The quick calls (titles, Auto's ratings, follow-ups, notes, games) run on
  // helperProvider, or on the other one while it is off or at its limit.
  helperProvider: 'claude',             // claude | codex
  claudeHelperModel: 'haiku',
  codexHelperModel: 'luna',             // a family (its newest model) or a model id; Luna is Codex's Haiku
  defaultPermissionMode: 'bypassPermissions', // default | acceptEdits | auto | plan | bypassPermissions
  defaultModel: 'opus',                 // a value from the model menu, "opus" being the latest Opus; "auto" picks Opus, Sonnet or Haiku per task (automodel.js)
  defaultEffort: 'medium',              // low | medium | high | xhigh | max; empty: Auto picks it (with the Auto model), else the model's default
  defaultFastMode: false,
  // When an agent's conversation reaches this size, Claude Code summarizes it
  // (compacts), so long tasks stop re-reading everything with every step.
  // Codex agents too. 100k to 1m, or 'auto' for Claude Code's and Codex's own choice.
  autoCompact: '200k',
  stuckAfterSeconds: 30,                // waiting this long for Unity to be ready marks the agent as stuck
  staleAfterHours: 0,                   // an agent on the Hub that finished longer ago than this is marked as stale (0: never)
  defaultFolder: '',
  gamesFolder: '',                      // the folder with every game's folder, for Auto game folder (gamefolders.js)
  autoGameFolder: false,                // a new agent whose message is about one game works in that game's folder
  extraArgs: [],                        // extra command-line flags for every agent
  env: {},                              // extra environment variables for every agent
  notifyWhenDone: true,
  notifyStyle: 'tile',                  // tile: the agent's Hub tile in the corner (toast.js) | system: the system's own
  notifyKey: 'Control+Alt+Space',       // from any app, opens the agent of the newest notification (empty: none)
  sounds: true,                         // a sound when you start an agent and when one finishes
  updatePopup: true,                    // a card on the Hub asks to update when a new version is out (off: only the title bar's Update button)
  voiceLanguage: '',                    // the language of voice input (the microphone button), such as en-US; empty: the system's
  hubAfterSend: true,                   // show the Hub after you send a message
  summarizeTitles: true,                // title new agents with a short summary of your message
  suggestFollowUps: true,               // after a task, suggest the messages you will likely send next
  svnServer: 'svn+ssh://svn@tactile.build',   // the Branches view reads <svnServer>/<project>/branches
  svnProjects: ['MergeTavern'],         // empty: every project on the server (older settings: svnProject, one project)
  svnBranchFilter: [],                  // only branches whose names start with one of these (all when empty)
  githubBranches: false,                // also list your GitHub pull requests and branches (githubbranches.js)
  theme: 'default',                     // default | mother (the retro terminal of Alien)
  curvedScreen: true,                   // the retro theme bends the picture like a tube's glass
  // The multi-agent pipeline (pipeline.js): off by default. Its agent types,
  // the graph that connects them and the reviewer loop, as Settings →
  // Multi-agent edits them.
  multiAgent: pipeline.defaults(),
};

let win;
let configPath;
let groupsPath;

// Your session groups: { groups: [{ id, name, collapsed }], assignments: { sessionId: groupId } }.
function readGroups() {
  try {
    return JSON.parse(fs.readFileSync(groupsPath, 'utf8'));
  } catch {
    return { groups: [], assignments: {} };
  }
}

// Shows a native right-click menu and resolves with the id of the item you
// picked, or null when you close the menu without picking anything.
function popupMenu(items) {
  return new Promise(resolve => {
    let done = false;
    const pick = id => { if (!done) { done = true; resolve(id); } };
    const build = list => list.map(item => item.type === 'separator' ? { type: 'separator' } : {
      label: item.label,
      enabled: item.enabled !== false,
      type: item.checked != null ? 'checkbox' : 'normal',
      checked: !!item.checked,
      submenu: item.submenu ? build(item.submenu) : undefined,
      click: item.submenu ? undefined : () => pick(item.id),
    });
    Menu.buildFromTemplate(build(items)).popup({ window: win, callback: () => setTimeout(() => pick(null), 100) });
  });
}

// Shows a file selected in Explorer (Windows) or Finder (macOS). A folder
// opens itself; a file that is gone (the task deleted it) opens the nearest
// folder that still exists. target may be relative to cwd. Resolves with an
// error message, or '' when it worked.
async function revealInFolder(target, cwd) {
  if (typeof target !== 'string' || !target) return 'Not found';
  const wanted = path.resolve(typeof cwd === 'string' ? cwd : '', target);
  let existing = wanted;
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) return 'Not found';
    existing = parent;
  }
  if (existing === wanted && fs.statSync(existing).isFile()) {
    shell.showItemInFolder(existing);
    return '';
  }
  return shell.openPath(existing);
}

function getConfig() {
  try {
    const saved = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    if (!Array.isArray(saved.svnProjects) && typeof saved.svnProject === 'string') saved.svnProjects = [saved.svnProject].filter(Boolean);
    return { ...DEFAULT_CONFIG, ...saved, multiAgent: pipeline.normalize(saved.multiAgent) };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

// The version shown in the top bar. The stable copy (on master) shows the
// version from package.json. The dev copy shows master's major.minor version
// and, as the patch number, how many commits it is ahead of master, so
// 0.3.4 dev is master 0.3.x plus four commits.
function appVersion() {
  const dir = app.getAppPath();
  const run = args => new Promise(resolve => {
    execFile('git', ['-C', dir, ...args], { timeout: 10000 }, (err, out) => resolve(err ? null : out.trim()));
  });
  const stable = { version: app.getVersion(), dev: false };
  return (async () => {
    const branch = await run(['rev-parse', '--abbrev-ref', 'HEAD']);
    if (!branch || branch === 'master') return stable;
    const pkg = await run(['show', 'master:package.json']);
    const ahead = await run(['rev-list', '--count', 'master..HEAD']);
    if (!pkg || ahead == null) return stable;
    try {
      const [major, minor] = JSON.parse(pkg).version.split('.');
      return { version: `${major}.${minor}.${ahead}`, dev: true };
    } catch {
      return stable;
    }
  })();
}

// The agents with a notification out, the newest last, for the shortcut
// that opens them (Settings → Notifications; see openNotified).
const notified = [];
let keyOpenedAt = 0;
let openNotified = () => {};
let notifyKey = '';
let notifyKeyOk = false;
function forget(id) {
  const i = notified.indexOf(id);
  if (i >= 0) notified.splice(i, 1);
}
// Another app can have the key already: then it is not ours (Settings says so).
function registerNotifyKey() {
  const key = String(getConfig().notifyKey || '');
  if (key === notifyKey && (notifyKeyOk || !key)) return;
  if (notifyKey && notifyKeyOk) globalShortcut.unregister(notifyKey);
  notifyKey = key;
  notifyKeyOk = false;
  if (!key) return;
  try { notifyKeyOk = globalShortcut.register(key, () => openNotified()); } catch { notifyKeyOk = false; }
}
app.on('will-quit', () => globalShortcut.unregisterAll());

// The class diagram's model of a change's C# and TypeScript files together
// (csharp.js, typescript.js; TypeScript's parser loads only when needed).
async function codeModel(cwd, files) {
  const list = Array.isArray(files) ? files : [];
  const tsFiles = list.filter(f => /\.[cm]?tsx?$/i.test(f?.path || ''));
  const [cs, tsm] = await Promise.all([
    csharp.model(cwd, list.filter(f => !tsFiles.includes(f))),
    tsFiles.length ? require('./typescript').model(cwd, tsFiles) : null,
  ]);
  if (!tsm) return cs;
  return { nodes: [...cs.nodes, ...tsm.nodes], edges: [...cs.edges, ...tsm.edges], testsLeftOut: cs.testsLeftOut + tsm.testsLeftOut };
}

function send(channel, ...args) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, ...args);
}

const claudeAgents = new AgentManager({ send, getConfig });
const codexAgents = new CodexManager({ send, getConfig });
// The review peer of the whole-window class diagram (reviewpeer.js).
const reviewPeer = new ReviewPeer({ send, getConfig });

// Each agent runs on one provider; calls for an agent go to its manager.
const managerOf = id => (codexAgents.has(id) ? codexAgents : claudeAgents);
const agents = {
  start: opts => (opts?.provider === 'codex' ? codexAgents : claudeAgents).start(opts),
  sendMessage: (id, text, images) => managerOf(id).sendMessage(id, text, images),
  setModel: (id, choice) => managerOf(id).setModel(id, choice),
  respondPermission: (id, requestId, decision) => managerOf(id).respondPermission(id, requestId, decision),
  setPermissionMode: (id, mode) => managerOf(id).setPermissionMode(id, mode),
  interrupt: id => managerOf(id).interrupt(id),
  close: id => managerOf(id).close(id),
  contextUsage: id => managerOf(id).contextUsage(id),
  activeCount: () => claudeAgents.activeCount() + codexAgents.activeCount(),
  closeAll: () => { claudeAgents.closeAll(); codexAgents.closeAll(); reviewPeer.closeAll(); voice.cancel(); },
};

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 760,
    minHeight: 480,
    backgroundColor: '#1f1913',
    // The top bar is part of the page. macOS keeps its window buttons at the
    // top left; on Windows the minimize, maximize and close buttons are drawn
    // at the top right in the app's colors.
    ...(process.platform === 'darwin'
      ? { titleBarStyle: 'hiddenInset' }
      : { titleBarStyle: 'hidden', titleBarOverlay: { color: '#1f1913', symbolColor: '#f1e7dc', height: 52 } }),
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  // Windows would show a File/Edit/View menu whose shortcuts (Ctrl+0, Ctrl+R)
  // clash with the app's own. Copy and paste keep working without it.
  if (process.platform !== 'darwin') win.removeMenu();
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  // Closing the window with busy agents asks first, then quits the app.
  win.on('close', event => allowStop(event));
  // The taskbar button stops flashing when you come back.
  // Coming back yourself empties the notifications; the shortcut that opened
  // one keeps the others for its next press (see openNotified).
  win.on('focus', () => {
    win.flashFrame(false);
    if (Date.now() - keyOpenedAt > 1500) { notified.length = 0; toast.clear(); }
    lookForUpdate();
  });
  // The notifications' window goes with it, or the app would not quit.
  win.on('closed', () => toast.destroy());
  // Links in agent replies open in the normal browser, not inside the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^(https?|mailto):/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  // Nothing replaces Agent Hub's own page: a web link goes to your browser
  // and a local file opens with its usual app.
  win.webContents.on('will-navigate', (event, url) => {
    event.preventDefault();
    if (/^(https?|mailto):/i.test(url)) shell.openExternal(url);
    else if (/^file:/i.test(url)) {
      try {
        const file = require('url').fileURLToPath(url);
        if (fs.existsSync(file)) shell.openPath(file);
      } catch { /* not a path we can open */ }
    }
  });
}

// Tell the window to reload the sidebar when Claude Code writes a session file,
// including sessions you run in the terminal or another app.
function watchSessions() {
  if (!fs.existsSync(PROJECTS_DIR)) return;
  let timer = null;
  try {
    fs.watch(PROJECTS_DIR, { recursive: true }, (_event, file) => {
      if (!file || !file.endsWith('.jsonl')) return;
      clearTimeout(timer);
      timer = setTimeout(() => send('sessions:changed'), 1500);
    });
  } catch { /* watching is a convenience; the refresh button still works */ }
}

// Opened from the Dock, Finder or the Start menu, the app gets the system's
// short search path, without the folders Homebrew and other installers use,
// so commands like svn, gh and acli would not be found ("spawn svn ENOENT").
// Those folders go at the end of the search path when they exist.
(function extendPath() {
  const home = require('os').homedir();
  const extra = process.platform === 'win32'
    ? ['C:\\Program Files\\TortoiseSVN\\bin', 'C:\\Program Files\\SlikSvn\\bin', 'C:\\Program Files\\Subversion\\bin',
       'C:\\Program Files\\Git\\cmd', 'C:\\Program Files\\GitHub CLI', path.join(home, '.local', 'bin')]
    : ['/opt/homebrew/bin', '/opt/homebrew/sbin', '/usr/local/bin', '/opt/local/bin', path.join(home, '.local', 'bin'), path.join(home, 'bin')];
  const parts = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const dir of extra) if (!parts.includes(dir) && fs.existsSync(dir)) parts.push(dir);
  process.env.PATH = parts.join(path.delimiter);
})();

// The app is called Agent Hub, but its settings (config.json, groups.json,
// snapshots, the Hub's saved agents) stay in the folder from when it was
// called AgentDeck. Electron would otherwise pick a folder named after the app.
// Tests set AGENTDECK_USER_DATA to a folder of their own, so they never
// touch your real settings, groups and Hub.
app.setPath('userData', process.env.AGENTDECK_USER_DATA || path.join(app.getPath('appData'), 'agentdeck'));

// Windows groups taskbar buttons and shows notifications by this id. It keeps
// the old name, so Windows treats the renamed app as the same app.
const APP_ID = 'com.agentdeck.app';
if (process.platform === 'win32') app.setAppUserModelId(APP_ID);

// Windows shows notifications only for an app id that a Start Menu shortcut
// carries. Gives the Agent Hub shortcut that id, or makes the shortcut (for
// this copy) when there is none; `npm run make-app` in the stable copy points
// it there again.
function registerForNotifications() {
  if (process.platform !== 'win32') return;
  const link = path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Agent Hub.lnk');
  try {
    if (fs.existsSync(link)) {
      if (shell.readShortcutLink(link).appUserModelId !== APP_ID) {
        shell.writeShortcutLink(link, 'update', { appUserModelId: APP_ID });
      }
    } else {
      shell.writeShortcutLink(link, 'create', {
        target: process.execPath,
        args: `"${app.getAppPath()}"`,
        cwd: app.getAppPath(),
        icon: path.join(__dirname, '..', 'build', 'icon.ico'),
        iconIndex: 0,
        description: 'Agent Hub',
        appUserModelId: APP_ID,
      });
    }
  } catch { /* without it there are no notifications, but everything else works */ }
}

app.whenReady().then(() => {
  media.registerProtocol(protocol, net, path.join(app.getPath('userData'), 'media-previews'));
  ipcMain.handle('media:recent', (_e, cwd, sinceMs) => media.recentMedia(cwd, sinceMs));
  // A Photoshop file you attach: its picture for Claude (see photoshop.js).
  ipcMain.handle('media:photoshop', (_e, file, maxSide) => {
    if (typeof file !== 'string' || !/\.(psd|psb)$/i.test(file)) return null;
    const p = require('./photoshop').preview(file, Math.min(Number(maxSide) || 2048, 4096));
    return p && { type: p.type, data: p.data.toString('base64'), width: p.width, height: p.height };
  });
  // An Excel file you attach: its sheets as CSV text (see spreadsheet.js).
  ipcMain.handle('media:spreadsheet', (_e, file) => require('./spreadsheet').read(file));
  ipcMain.handle('media:find', (_e, cwd, name) => media.findMedia(cwd, name).catch(() => null));
  ipcMain.handle('media:picture', (_e, file) => media.pictureData(file, path.join(app.getPath('userData'), 'media-previews')));
  ipcMain.handle('media:before', (_e, cwd, file, snap) => media.mediaBefore(cwd, file, snap, path.join(app.getPath('userData'), 'media-before')).catch(() => null));
  ipcMain.handle('jira:issue', (_e, key) => jira.issue(key));
  ipcMain.handle('gdoc:title', (_e, url) => require('./gdocs').title(url));
  ipcMain.handle('github:lookup', (_e, what) => require('./github').lookup(what));
  ipcMain.handle('jira:details', (_e, key) => jira.details(key));
  ipcMain.handle('jira:comment', (_e, key, body) => jira.comment(key, body));
  const removed = require('./removedsessions');
  removed.setFile(path.join(app.getPath('userData'), 'removed-sessions.json'));
  ipcMain.handle('activity:get', () => activity(path.join(app.getPath('userData'), 'activity-cache.json'), removed.list()));
  ipcMain.handle('history:remove', (_e, ids) => removed.remove(ids));
  ipcMain.handle('history:restore', (_e, ids) => removed.restore(ids));
  ipcMain.handle('session:contextSize', (_e, file) => (typeof file === 'string' ? handoff.contextSize(file) : 0));
  ipcMain.handle('session:handoff', (_e, file, title) => (typeof file === 'string' ? handoff.handoff(getConfig(), file, String(title || '')) : null));
  ipcMain.handle('diff:run', (_e, cwd, command) => runDiff(cwd, command));
  ipcMain.handle('command:run', (_e, id, cwd, command) => commands.run(getConfig(), String(id), cwd, command, send));
  ipcMain.handle('command:stop', (_e, id) => commands.stop(String(id)));
  // The Branches view (renderer/branches.js, src/svnbranches.js).
  ipcMain.handle('svn:branches', (_e, cached) => (cached ? svnBranches.cachedBranches : svnBranches.listBranches)(getConfig(), app.getPath('userData')));
  ipcMain.handle('github:branchDiff', (e, item) => require('./githubbranches').githubDiff(item, path.join(app.getPath('userData'), 'branch-diffs'), progress => {
    if (!e.sender.isDestroyed()) e.sender.send('svn:branchProgress', String(item?.project || ''), String(item?.number || item?.branch || ''), progress);
  }));
  ipcMain.handle('svn:branchDiff', (e, project, branch) => svnBranches.branchDiff(getConfig(), String(project || ''), String(branch || ''), path.join(app.getPath('userData'), 'branch-diffs'), progress => {
    if (!e.sender.isDestroyed()) e.sender.send('svn:branchProgress', String(project || ''), String(branch || ''), progress);
  }));
  // What only the revisions or commits you picked changed.
  ipcMain.handle('svn:revisionsDiff', (_e, project, branch, revisions) => svnBranches.revisionsDiff(getConfig(), String(project || ''), String(branch || ''), revisions));
  ipcMain.handle('github:commitsDiff', (_e, item, shas) => require('./githubbranches').commitsDiff(item, shas, path.join(app.getPath('userData'), 'branch-diffs')));
  ipcMain.handle('agents:remember', (_e, entries) => agentList.remember(entries));
  ipcMain.handle('agents:list', () => agentList.list());
  // Before a sign-in, the account you are on is saved, so you can switch back
  // to it (Settings → Account, accounts.js).
  ipcMain.handle('auth:login', async (_e, email) => {
    await accounts.remember(getConfig()).catch(() => {});
    return auth.login(getConfig(), send, typeof email === 'string' ? email : '');
  });
  ipcMain.handle('auth:input', (_e, text) => auth.input(text));
  ipcMain.handle('auth:cancel', () => auth.cancel());
  ipcMain.handle('auth:status', () => auth.status(getConfig()));
  accounts.setFile(path.join(app.getPath('userData'), 'claude-accounts.json'));
  ipcMain.handle('accounts:list', () => accounts.list(getConfig()));
  ipcMain.handle('accounts:switch', (_e, id) => accounts.switchTo(getConfig(), String(id)));
  ipcMain.handle('accounts:forget', (_e, id) => accounts.forget(getConfig(), String(id)));
  ipcMain.handle('voice:start', (_e, locale) => voice.start(locale, send));
  ipcMain.handle('voice:stop', () => voice.stop());
  ipcMain.handle('voice:cancel', () => voice.cancel());
  // Each call names its provider: Claude Code's connectors, or Codex's.
  const connectorsOf = provider => (provider === 'codex' ? connectors.codex : connectors);
  ipcMain.handle('connectors:list', (_e, cwd, provider) => connectorsOf(provider).list(getConfig(), cwd));
  ipcMain.handle('connectors:cached', (_e, provider) => connectorsOf(provider).cached());
  ipcMain.handle('connectors:login', (_e, id, provider) => connectorsOf(provider).login(getConfig(), id));
  ipcMain.handle('connectors:cancelLogin', (_e, id, provider) => connectorsOf(provider).cancelLogin(id));
  ipcMain.handle('connectors:add', (_e, spec, provider) => connectorsOf(provider).add(getConfig(), spec));
  ipcMain.handle('connectors:remove', (_e, spec, provider) => connectorsOf(provider).remove(getConfig(), spec));
  // Shows the Agent Hub icon in the Dock also when you run `npm start`.
  if (app.dock) app.dock.setIcon(path.join(__dirname, '..', 'build', 'icon.png'));
  configPath = path.join(app.getPath('userData'), 'config.json');
  groupsPath = path.join(app.getPath('userData'), 'groups.json');
  agentList.init(app.getPath('userData'));
  gameFolders.init(app.getPath('userData'));
  if (!fs.existsSync(configPath)) fs.writeFileSync(configPath, JSON.stringify(DEFAULT_CONFIG, null, 2));

  ipcMain.handle('config:get', () => ({ ...getConfig(), home: require('os').homedir() }));
  ipcMain.handle('config:open', () => shell.openPath(configPath));
  ipcMain.handle('notifyKey:status', () => ({ key: notifyKey, ok: notifyKeyOk }));
  // The Settings screen: its values replace those in config.json; settings
  // it does not show (added by hand) stay.
  ipcMain.handle('config:save', (_e, values) => {
    let current = {};
    try { current = JSON.parse(fs.readFileSync(configPath, 'utf8')); } catch { /* start from the defaults */ }
    const next = { ...DEFAULT_CONFIG, ...current };
    for (const [key, value] of Object.entries(values || {})) {
      if (key in DEFAULT_CONFIG && typeof value === typeof DEFAULT_CONFIG[key] && Array.isArray(value) === Array.isArray(DEFAULT_CONFIG[key])) next[key] = value;
    }
    fs.writeFileSync(configPath, JSON.stringify(next, null, 2));
    registerNotifyKey();
    return { ...getConfig(), home: require('os').homedir() };
  });
  ipcMain.handle('app:quit', () => quitNow());
  ipcMain.handle('usage:fetch', () => (getConfig().claudeEnabled === false ? null : fetchUsage(getConfig())));
  ipcMain.handle('codex:usage', () => (getConfig().codexEnabled ? fetchCodexUsage(getConfig()) : null));
  // The Tactile Create Art budget (createart.js): numbers only, never the sign-in.
  ipcMain.handle('createart:budget', () => require('./createart').budget());
  ipcMain.handle('providers:limited', (_e, provider, untilMs) => setProviderLimited(provider, untilMs));
  ipcMain.handle('app:version', () => appVersion());
  ipcMain.handle('update:latest', () => latestUpdate);
  // Settings → Check for updates: a look right now. The dev copy does not
  // update itself (it is on the dev branch), so it only says so.
  ipcMain.handle('update:check', async () => {
    if ((await appVersion()).dev) return { dev: true };
    const found = await lookNow().catch(() => undefined);
    return found === undefined ? { offline: true } : { found: found || null };
  });
  ipcMain.handle('app:changelog', () => updates.changelog(app.getAppPath()));
  ipcMain.handle('update:apply', () => applyUpdate());
  // Sessions you removed from History stay out (removedsessions.js).
  // History: Claude Code's sessions, and Codex's threads while Codex is on.
  ipcMain.handle('sessions:list', async () => {
    const gone = require('./removedsessions').list();
    const codex = getConfig().codexEnabled ? await listCodexThreads(getConfig()) : [];
    return [...listSessions(), ...codex].filter(x => !gone.has(x.id)).sort((a, b) => b.updatedAt - a.updatedAt);
  });
  ipcMain.handle('git:snapshot', (_e, cwd) => git.snapshot(cwd, path.join(app.getPath('userData'), 'snapshots')));
  ipcMain.handle('git:quickSnapshot', (_e, cwd) => git.quickSnapshot(cwd, path.join(app.getPath('userData'), 'snapshots')));
  ipcMain.handle('git:changes', (_e, cwd, snap) => git.changesSince(cwd, snap));
  ipcMain.handle('subagents:evidence', (_e, sessionId, since) => require('./subagents').evidence(sessionId, since));
  const turnDir = path.join(app.getPath('userData'), 'turn-changes');
  require('./turnchanges').prune(turnDir);
  ipcMain.handle('turns:save', (_e, id, data) => require('./turnchanges').save(turnDir, id, data));
  ipcMain.handle('turns:load', (_e, ids) => require('./turnchanges').load(turnDir, ids));
  // An agent's Changes card, all its tasks together (updateSession in app.js).
  const sessionChangesDir = path.join(app.getPath('userData'), 'session-changes');
  require('./turnchanges').prune(sessionChangesDir);
  ipcMain.handle('sessionchanges:save', (_e, id, data) => require('./turnchanges').saveJson(sessionChangesDir, id, data));
  ipcMain.handle('sessionchanges:load', async (_e, id) => (await require('./turnchanges').load(sessionChangesDir, [id]))[id] || null);
  ipcMain.handle('files:undo', (_e, cwd, file, snap) => undo.undoFile(cwd, file, snap));
  ipcMain.handle('files:versions', (_e, cwd, file) => undo.versions(cwd, file));
  ipcMain.handle('files:span', (_e, cwd, filePath, changes) => undo.span(cwd, filePath, changes));
  ipcMain.handle('files:restore', (_e, cwd, p, previous, from) => undo.restoreFile(cwd, p, previous, from));
  ipcMain.handle('repo:of', (_e, cwd) => repoOf(cwd));
  ipcMain.handle('repo:branch', (_e, cwd) => branchOf(cwd));
  // Which of these files still exist (for the Changes card).
  ipcMain.handle('fs:existing', (_e, paths) => (Array.isArray(paths) ? paths : []).filter(p => typeof p === 'string' && fs.existsSync(p)));
  // The namespace of C# files, for their titles in the Changes card: the
  // first "namespace X" line in the first 256 KB, or null.
  ipcMain.handle('cs:model', (_e, cwd, files) => codeModel(cwd, files));
  ipcMain.handle('clipboard:write', (_e, text) => { require('electron').clipboard.writeText(String(text ?? '')); return true; });
  ipcMain.handle('assets:describe', (_e, cwd, file) => require('./unityassets').describeAsset(cwd, file).catch(err => ({ error: err.message })));
  ipcMain.handle('slash:list', (_e, cwd) => require('./slashcommands').list(cwd));
  // A file the diagram shows but the task did not change: open it in your editor.
  ipcMain.handle('file:open', (_e, p) => (typeof p === 'string' && fs.existsSync(p) ? shell.openPath(p) : 'Not found'));
  // Show in Explorer / Finder, in the right-click menus of a session and of a changed file.
  ipcMain.handle('file:reveal', (_e, p, cwd) => revealInFolder(p, cwd));
  ipcMain.handle('cs:namespaces',(_e, paths) => Promise.all((Array.isArray(paths) ? paths : []).slice(0, 500).map(async p => {
    if (typeof p !== 'string' || !/\.cs$/i.test(p)) return null;
    try {
      const handle = await fs.promises.open(p, 'r');
      try {
        const { buffer, bytesRead } = await handle.read(Buffer.alloc(256 * 1024), 0, 256 * 1024, 0);
        return /^[ \t]*namespace[ \t]+([A-Za-z_][\w.]*)/m.exec(buffer.toString('utf8', 0, bytesRead))?.[1] || null;
      } finally {
        await handle.close();
      }
    } catch {
      return null;
    }
  })));
  ipcMain.handle('groups:get', () => readGroups());
  ipcMain.handle('groups:save', (_e, data) => fs.writeFileSync(groupsPath, JSON.stringify(data, null, 2)));
  ipcMain.handle('menu:popup', (_e, items) => popupMenu(items));
  // A double-click on the top bar that reached the page (the system did not
  // take it as a title-bar double-click): do what the system would, by its
  // setting on a Mac (System Settings → Desktop & Dock → "Double-click a
  // window's title bar to": zoom, minimize or nothing).
  // What the agents need (see setupcheck.js): Claude Code, and in a Unity
  // project the Unity bridge.
  ipcMain.handle('setup:claude', () => require('./setupcheck').claudeStatus(getConfig()));
  ipcMain.handle('setup:unity', (_e, cwd) => require('./setupcheck').unityBridge(getConfig(), cwd));
  ipcMain.handle('setup:writeMcpJson', (_e, root) => require('./setupcheck').writeMcpJson(root));
  // The Unity Editor for a folder: open or not, and focus or start it.
  ipcMain.handle('unity:status', (_e, cwd) => require('./unityapp').status(cwd));
  ipcMain.handle('unity:open', (_e, cwd) => require('./unityapp').open(cwd));
  ipcMain.handle('tsvn:status', (_e, cwd) => require('./tactilesvn').status(cwd));
  ipcMain.handle('tsvn:open', (_e, cwd) => require('./tactilesvn').open(cwd));
  ipcMain.handle('window:titleDoubleClick', () => {
    if (!win) return;
    const action = process.platform === 'darwin' ? systemPreferences.getUserDefault('AppleActionOnDoubleClick', 'string') : 'Maximize';
    if (action === 'None') return;
    if (action === 'Minimize') { win.minimize(); return; }
    if (win.isMaximized()) win.unmaximize();
    else win.maximize();
  });
  ipcMain.handle('sessions:load', (_e, file) => (/^codex:/.test(String(file)) ? loadCodexThread(getConfig(), String(file).slice(6)) : loadTranscript(file)));
  ipcMain.handle('dialog:pickFolder', async () => {
    const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] });
    return r.canceled ? null : r.filePaths[0];
  });
  ipcMain.handle('agent:start', (_e, opts) => agents.start(opts));
  ipcMain.handle('agent:send', (_e, id, text, images) => agents.sendMessage(id, text, images));
  ipcMain.handle('agent:setModel', (_e, id, choice) => agents.setModel(id, choice));
  let models = null;
  ipcMain.handle('models:list', async () => {
    if (!models) models = await fetchModels(getConfig());
    return models;
  });
  let codexModels = null;
  ipcMain.handle('codex:models', async () => {
    if (!codexModels) codexModels = await fetchCodexModels(getConfig());
    return codexModels;
  });
  ipcMain.handle('agent:respondPermission', (_e, id, requestId, decision) => agents.respondPermission(id, requestId, decision));
  ipcMain.handle('agent:setPermissionMode', (_e, id, mode) => agents.setPermissionMode(id, mode));
  ipcMain.handle('agent:interrupt', (_e, id) => agents.interrupt(id));
  ipcMain.handle('agent:close', (_e, id) => agents.close(id));
  // The number of agents that wait for you, as a red badge on the Dock icon
  // (on Windows, on the taskbar button; the window draws that badge). The icon
  // bounces once (on Windows, the taskbar button flashes) when one more starts
  // waiting while you are elsewhere.
  let attention = 0;
  ipcMain.handle('attention', (_e, count, badge) => {
    if (process.platform === 'darwin' && app.dock) {
      app.setBadgeCount(count);
      if (count > attention && !win.isFocused()) app.dock.bounce('informational');
    } else {
      const image = count && badge ? nativeImage.createFromDataURL(badge) : null;
      win.setOverlayIcon(image, count ? `${count} waiting for you` : '');
      if (count > attention && !win.isFocused()) win.flashFrame(true);
    }
    attention = count;
  });
  ipcMain.handle('agent:context', (_e, id) => agents.contextUsage(id));
  ipcMain.handle('agent:followups', (_e, input) => (getConfig().suggestFollowUps ? suggestFollowUps(getConfig(), input || {}) : []));
  ipcMain.handle('notes:merge', (_e, input) => mergeNotes(getConfig(), input || {}));
  ipcMain.handle('agent:title', (_e, text) => (getConfig().summarizeTitles ? summarizeTitle(getConfig(), text) : null));
  ipcMain.handle('gamefolder:quick', (_e, text, current) => gameFolders.quick(getConfig().gamesFolder, String(text || ''), current || ''));
  ipcMain.handle('gamefolder:lookup', (_e, text, current) => gameFolders.lookup(getConfig().gamesFolder, String(text || ''), current || '', (q, o) => pickGame(getConfig(), q, o)));
  ipcMain.handle('review:ask', (_e, id, input) => reviewPeer.ask(String(id), input || {}));
  ipcMain.handle('review:interrupt', (_e, id) => reviewPeer.interrupt(String(id)));
  ipcMain.handle('review:close', (_e, id) => reviewPeer.close(String(id)));
  ipcMain.handle('agent:rate', (_e, text, context) => rateTask(getConfig(), String(text || ''), String(context || '')));
  // Clicking a notification opens its agent. The app keeps each notification
  // until it closes, or Windows would forget the click handler.
  const shown = new Set();
  const openFrom = id => {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    send('notification:open', id);
  };
  const openClicked = id => { notified.length = 0; openFrom(id); };
  toast.init({ onOpen: openClicked, onDismiss: id => forget(id) });
  // The shortcut (Ctrl+Alt+Space, from any app): the agent of the newest
  // notification; pressed again, the one before. Without any, the app comes
  // to the front. Windows lets only the app with the focus bring a window
  // forward; on top for a moment, it comes anyway.
  openNotified = () => {
    const id = notified.pop();
    keyOpenedAt = Date.now();
    if (id) toast.remove(id);
    const behind = !win.isFocused();
    if (behind) win.setAlwaysOnTop(true);
    if (id) openFrom(id);
    else {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    }
    if (behind) win.setAlwaysOnTop(false);
  };
  registerNotifyKey();
  // extra: { tile, theme }, the agent's Hub tile for the app's own notification,
  // and focused: whether the page has the focus. After a notification brought
  // the window forward (openFrom), the window could miss losing the focus again
  // and win.isFocused() stayed true, so no notification came; the page knows.
  ipcMain.handle('notify', (_e, id, title, body, extra) => {
    if (!getConfig().notifyWhenDone || (extra ? extra.focused : win.isFocused())) return;
    forget(id);
    notified.push(id);
    if (getConfig().notifyStyle !== 'system' && extra?.tile) {
      toast.show({ id, title, body, tile: extra.tile, theme: extra.theme });
      return;
    }
    // The app plays its own sounds, so the notification stays silent then.
    const n = new Notification({ title, body, silent: getConfig().sounds !== false });
    shown.add(n);
    n.on('click', () => openClicked(id));
    n.on('close', () => shown.delete(n));
    // Since Electron 42, macOS can refuse the notification of an app that is
    // only signed for this Mac (make-app.sh): the app's own one comes instead.
    n.on('failed', () => {
      shown.delete(n);
      if (extra?.tile) toast.show({ id, title, body, tile: extra.tile, theme: extra.theme });
    });
    n.show();
  });

  registerForNotifications();
  createWindow();
  watchForUpdates();
  watchSessions();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

// Quitting (or closing the window) stops the agents. When some are still
// busy, the app asks first. If you quit anyway, the window first saves which
// agents were busy, so they continue the next time the app opens.
let quitConfirmed = false;
function allowStop(event) {
  const busy = agents.activeCount();
  if (quitConfirmed || !busy || !win || win.isDestroyed()) return true;
  event.preventDefault();
  // The window asks, in the app itself (see confirmQuit in app.js). If the
  // window cannot answer (it crashed), the system dialog asks instead.
  if (win.webContents.isCrashed()) {
    const choice = dialog.showMessageBoxSync(win, {
      type: 'warning',
      buttons: ['Quit', 'Cancel'],
      defaultId: 0,
      cancelId: 1,
      message: busy === 1 ? '1 agent is still working' : `${busy} agents are still working`,
      detail: 'Quitting stops them now. They continue where they stopped the next time you open the app.',
    });
    if (choice === 0) quitNow();
    return false;
  }
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  send('app:confirmQuit');
  return false;
}

// The stable copy looks for a new version on GitHub 3 seconds after it
// opens, every time its window gets the focus, and every 30 minutes, and
// tells the window when there is one.
// The commit this app started from: when the folder moves on after that
// (promote moves the stable copy forward), a restart is an update too.
let startHead = null;
try { startHead = require('child_process').execFileSync('git', ['-C', app.getAppPath(), 'rev-parse', 'HEAD'], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null; } catch { /* not a git folder */ }
let latestUpdate = null;
let lookForUpdate = () => {};
let looking = null;
// One look at GitHub (a look already running is shared, so two never fetch
// at once). Resolves with what updates.check found: the new version, null
// for none, undefined when GitHub couldn't be reached.
function lookNow() {
  if (looking) return looking;
  looking = updates.check(app.getAppPath(), startHead).then(found => {
    // undefined: GitHub couldn't be reached, so what was found before stays.
    if (found !== undefined && JSON.stringify(found) !== JSON.stringify(latestUpdate)) {
      latestUpdate = found;
      send('update:available', found);
    }
    return found;
  }).finally(() => { looking = null; });
  return looking;
}
function watchForUpdates() {
  const look = () => lookNow().catch(() => {});
  // Every time the window gets the focus (a look already running is shared).
  lookForUpdate = () => look();
  setTimeout(look, 3 * 1000);
  setInterval(look, 30 * 60 * 1000);
}

// Moves the stable copy to the new version and restarts the app. The window
// has already asked about busy agents; like quitting, they continue after
// the restart. When the new version needs other packages, a separate shell
// installs them after the app has quit, then opens it again.
async function applyUpdate() {
  const result = await updates.apply(app.getAppPath());
  if (!result.ok) return result;
  if (result.packagesChanged) updates.installAndRelaunch(app.getAppPath(), result);
  else app.relaunch({ args: [app.getAppPath()] });
  quitNow();
  return result;
}


// The agents' state is saved by the window (app:quitting), then the app quits.
function quitNow() {
  quitConfirmed = true;
  send('app:quitting');
  setTimeout(() => app.quit(), 300);
}

app.on('before-quit', event => {
  if (allowStop(event)) { agents.closeAll(); commands.stopAll(); }
});
// Quit normally (and stop the agents) also when the app is stopped with
// Ctrl-C in the terminal that runs `npm start`.
process.on('SIGINT', () => app.quit());
// Closing the window quits the app, also on macOS: the agents stop with it
// anyway, and an app left running would keep the code it started with while
// a reopened window loads the newer files (after promote or an update).
app.on('window-all-closed', () => {
  agents.closeAll();
  commands.stopAll();
  app.quit();
});
