// The only functions the window can call. Everything else (files, processes)
// stays in the main process.

const { contextBridge, ipcRenderer, webUtils } = require('electron');

function on(channel, fn) {
  const listener = (_e, ...args) => fn(...args);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('deck', {
  platform: process.platform,   // 'darwin' on macOS, 'win32' on Windows
  getConfig: () => ipcRenderer.invoke('config:get'),
  openConfig: () => ipcRenderer.invoke('config:open'),
  // The shortcut that opens the notified agent: { key, ok } (ok: it is ours).
  notifyKeyStatus: () => ipcRenderer.invoke('notifyKey:status'),
  saveConfig: values => ipcRenderer.invoke('config:save', values),
  appVersion: () => ipcRenderer.invoke('app:version'),
  latestUpdate: () => ipcRenderer.invoke('update:latest'),
  checkUpdate: () => ipcRenderer.invoke('update:check'),
  changelog: () => ipcRenderer.invoke('app:changelog'),
  applyUpdate: () => ipcRenderer.invoke('update:apply'),
  onUpdate: fn => on('update:available', fn),
  fetchUsage: () => ipcRenderer.invoke('usage:fetch'),
  fetchCodexUsage: () => ipcRenderer.invoke('codex:usage'),
  // { spentUsd, limitUsd, resetsAt } of Tactile Create Art, { expired }, { error } or null.
  fetchCreateArtBudget: () => ipcRenderer.invoke('createart:budget'),
  setProviderLimited: (provider, untilMs) => ipcRenderer.invoke('providers:limited', provider, untilMs),
  repoOf: cwd => ipcRenderer.invoke('repo:of', cwd),
  // The branch its repository is on: { vcs: 'git' | 'svn', name } or null.
  repoBranch: cwd => ipcRenderer.invoke('repo:branch', cwd),
  existingFiles: paths => ipcRenderer.invoke('fs:existing', paths),
  csNamespaces: paths => ipcRenderer.invoke('cs:namespaces', paths),
  csModel: (cwd, files) => ipcRenderer.invoke('cs:model', cwd, files),
  describeAsset: (cwd, file) => ipcRenderer.invoke('assets:describe', cwd, file),
  copyText: text => ipcRenderer.invoke('clipboard:write', text),
  slashCommands: cwd => ipcRenderer.invoke('slash:list', cwd),
  saveTurnChanges: (id, data) => ipcRenderer.invoke('turns:save', id, data),
  loadTurnChanges: ids => ipcRenderer.invoke('turns:load', ids),
  saveSessionChanges: (id, data) => ipcRenderer.invoke('sessionchanges:save', id, data),
  loadSessionChanges: id => ipcRenderer.invoke('sessionchanges:load', id),
  openFile: p => ipcRenderer.invoke('file:open', p),
  // p may be relative to cwd. revealLabel is its name in the menus.
  revealFile: (p, cwd) => ipcRenderer.invoke('file:reveal', p, cwd),
  revealLabel: process.platform === 'darwin' ? 'Show in Finder' : 'Show in Explorer',
  getGroups: () => ipcRenderer.invoke('groups:get'),
  saveGroups: data => ipcRenderer.invoke('groups:save', data),
  popupMenu: items => ipcRenderer.invoke('menu:popup', items),
  titleDoubleClick: () => ipcRenderer.invoke('window:titleDoubleClick'),
  setupClaude: () => ipcRenderer.invoke('setup:claude'),
  setupUnity: cwd => ipcRenderer.invoke('setup:unity', cwd),
  writeMcpJson: root => ipcRenderer.invoke('setup:writeMcpJson', root),
  unityStatus: cwd => ipcRenderer.invoke('unity:status', cwd),
  openUnity: cwd => ipcRenderer.invoke('unity:open', cwd),
  tactileSvnStatus: cwd => ipcRenderer.invoke('tsvn:status', cwd),
  openTactileSvn: cwd => ipcRenderer.invoke('tsvn:open', cwd),
  gitSnapshot: cwd => ipcRenderer.invoke('git:snapshot', cwd),
  gitQuickSnapshot: cwd => ipcRenderer.invoke('git:quickSnapshot', cwd),
  gitChanges: (cwd, snap) => ipcRenderer.invoke('git:changes', cwd, snap),
  subagentEvidence: (sessionId, since) => ipcRenderer.invoke('subagents:evidence', sessionId, since),
  undoFile: (cwd, file, snap) => ipcRenderer.invoke('files:undo', cwd, file, snap),
  fileVersions: (cwd, file) => ipcRenderer.invoke('files:versions', cwd, file),
  fileSpan: (cwd, filePath, changes) => ipcRenderer.invoke('files:span', cwd, filePath, changes),
  restoreFile: (cwd, p, previous, from) => ipcRenderer.invoke('files:restore', cwd, p, previous, from),
  activity: () => ipcRenderer.invoke('activity:get'),
  removeFromHistory: ids => ipcRenderer.invoke('history:remove', ids),
  restoreToHistory: ids => ipcRenderer.invoke('history:restore', ids),
  // A diff the agent or you asked for (see branchdiff.js).
  runDiff: (cwd, command) => ipcRenderer.invoke('diff:run', cwd, command),
  // A shell command from an answer, run by its Run button (see commands.js).
  runCommand: (id, cwd, command) => ipcRenderer.invoke('command:run', id, cwd, command),
  stopCommand: id => ipcRenderer.invoke('command:stop', id),
  onCommandOutput: fn => on('command:output', fn),
  // cached: the list read last with the same settings, or null.
  svnBranches: cached => ipcRenderer.invoke('svn:branches', !!cached),
  svnBranchDiff: (project, branch) => ipcRenderer.invoke('svn:branchDiff', project, branch),
  // A GitHub pull request or branch from the list: { kind, project, number, branch }.
  githubBranchDiff: item => ipcRenderer.invoke('github:branchDiff', item),
  // What only the picked revisions (SVN) or commits (GitHub) changed.
  svnRevisionsDiff: (project, branch, revisions) => ipcRenderer.invoke('svn:revisionsDiff', project, branch, revisions),
  githubCommitsDiff: (item, shas) => ipcRenderer.invoke('github:commitsDiff', item, shas),
  // How far a branch's diff has come (see branchDiff's progress).
  onSvnBranchProgress: fn => on('svn:branchProgress', fn),
  // A large parent is not forked: a handoff instead (see handoff.js).
  sessionContextSize: file => ipcRenderer.invoke('session:contextSize', file),
  sessionHandoff: (file, title) => ipcRenderer.invoke('session:handoff', file, title),
  // Every agent you have had (see agentlist.js).
  rememberAgents: entries => ipcRenderer.invoke('agents:remember', entries),
  listAgents: () => ipcRenderer.invoke('agents:list'),
  // Signing Claude Code in again (see auth.js).
  auth: {
    login: email => ipcRenderer.invoke('auth:login', email),
    input: text => ipcRenderer.invoke('auth:input', text),
    cancel: () => ipcRenderer.invoke('auth:cancel'),
    status: () => ipcRenderer.invoke('auth:status'),
    onOutput: fn => on('auth:output', fn),
  },
  // Voice input for the message box (see voice.js).
  voice: {
    start: locale => ipcRenderer.invoke('voice:start', locale),
    stop: () => ipcRenderer.invoke('voice:stop'),
    cancel: () => ipcRenderer.invoke('voice:cancel'),
    onEvent: fn => on('voice:event', fn),
  },
  // The saved Claude accounts (see accounts.js).
  accounts: {
    list: () => ipcRenderer.invoke('accounts:list'),
    switchTo: id => ipcRenderer.invoke('accounts:switch', id),
    forget: id => ipcRenderer.invoke('accounts:forget', id),
  },
  connectors: {
    list: (cwd, provider) => ipcRenderer.invoke('connectors:list', cwd, provider),
    cached: provider => ipcRenderer.invoke('connectors:cached', provider),
    login: (id, provider) => ipcRenderer.invoke('connectors:login', id, provider),
    cancelLogin: (id, provider) => ipcRenderer.invoke('connectors:cancelLogin', id, provider),
    add: (spec, provider) => ipcRenderer.invoke('connectors:add', spec, provider),
    remove: (spec, provider) => ipcRenderer.invoke('connectors:remove', spec, provider),
  },
  jiraIssue: key => ipcRenderer.invoke('jira:issue', key),
  gdocTitle: url => ipcRenderer.invoke('gdoc:title', url),
  githubLookup: what => ipcRenderer.invoke('github:lookup', what),
  jiraDetails: key => ipcRenderer.invoke('jira:details', key),
  jiraComment: (key, body) => ipcRenderer.invoke('jira:comment', key, body),
  recentMedia: (cwd, sinceMs) => ipcRenderer.invoke('media:recent', cwd, sinceMs),
  // A media file of this name somewhere in cwd (see findMedia in media.js).
  findMedia: (cwd, name) => ipcRenderer.invoke('media:find', cwd, name),
  // An image's bytes ({ mediaType, data } in base64), for the image review.
  pictureData: file => ipcRenderer.invoke('media:picture', file),
  mediaBefore: (cwd, file, snap) => ipcRenderer.invoke('media:before', cwd, file, snap),
  listSessions: () => ipcRenderer.invoke('sessions:list'),
  loadTranscript: file => ipcRenderer.invoke('sessions:load', file),
  pickFolder: () => ipcRenderer.invoke('dialog:pickFolder'),
  startAgent: opts => ipcRenderer.invoke('agent:start', opts),
  measurePipeline: (multiAgent, folder) => ipcRenderer.invoke('pipeline:measure', multiAgent, folder),
  pipelineState: (agentId, sessionId) => ipcRenderer.invoke('pipeline:state', agentId, sessionId),
  sendMessage: (id, text, images) => ipcRenderer.invoke('agent:send', id, text, images),
  // Where a dropped file is on disk (Electron no longer puts it on the File).
  photoshopPicture: (file, maxSide) => ipcRenderer.invoke('media:photoshop', file, maxSide),
  readSpreadsheet: file => ipcRenderer.invoke('media:spreadsheet', file),
  pathForFile: file => { try { return webUtils.getPathForFile(file) || null; } catch { return null; } },
  setModel: (id, choice) => ipcRenderer.invoke('agent:setModel', id, choice),
  listModels: () => ipcRenderer.invoke('models:list'),
  listCodexModels: () => ipcRenderer.invoke('codex:models'),
  respondPermission: (id, requestId, decision) => ipcRenderer.invoke('agent:respondPermission', id, requestId, decision),
  setPermissionMode: (id, mode) => ipcRenderer.invoke('agent:setPermissionMode', id, mode),
  interrupt: id => ipcRenderer.invoke('agent:interrupt', id),
  closeAgent: id => ipcRenderer.invoke('agent:close', id),
  setAttention: (count, badge) => ipcRenderer.invoke('attention', count, badge),
  contextUsage: id => ipcRenderer.invoke('agent:context', id),
  summarizeTitle: text => ipcRenderer.invoke('agent:title', text),
  // How hard a task is (1-3), rated by Haiku, for the Auto model.
  rateTask: (text, context) => ipcRenderer.invoke('agent:rate', text, context),
  // The review peer in the whole-window class diagram (reviewpeer.js).
  reviewAsk: (id, input) => ipcRenderer.invoke('review:ask', id, input),
  reviewInterrupt: id => ipcRenderer.invoke('review:interrupt', id),
  reviewClose: id => ipcRenderer.invoke('review:close', id),
  onReviewEvent: fn => on('review:event', fn),
  gameFolderQuick: (text, current) => ipcRenderer.invoke('gamefolder:quick', text, current),
  gameFolderLookup: (text, current) => ipcRenderer.invoke('gamefolder:lookup', text, current),
  mergeNotes: input => ipcRenderer.invoke('notes:merge', input),
  followUps: input => ipcRenderer.invoke('agent:followups', input),
  notify: (id, title, body, extra) => ipcRenderer.invoke('notify', id, title, body, extra),
  onEvent: fn => on('agent:event', fn),
  onStatus: fn => on('agent:status', fn),
  onSession: fn => on('agent:session', fn),
  // A pipeline agent's run changed (pipelinerun.js): where each step stands.
  onPipeline: fn => on('agent:pipeline', fn),
  onModel: fn => on('agent:model', fn),
  onPermission: fn => on('agent:permission', fn),
  onPermissionCancel: fn => on('agent:permissionCancel', fn),
  onMode: fn => on('agent:mode', fn),
  onBackground: fn => on('agent:background', fn),
  onExit: fn => on('agent:exit', fn),
  onSessionsChanged: fn => on('sessions:changed', fn),
  onQuitting: fn => on('app:quitting', fn),
  onConfirmQuit: fn => on('app:confirmQuit', fn),
  quit: () => ipcRenderer.invoke('app:quit'),
  onNotificationOpen: fn => on('notification:open', fn),
});
