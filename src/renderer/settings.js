// The Settings screen: every setting in config.json as a form. Saving writes
// config.json (see config:save in main.js) and applies at once; the file
// stays the place for anything the form does not show.

const EFFORT_OPTIONS = [['', 'Auto'], ['low', 'Low'], ['medium', 'Medium'], ['high', 'High'], ['xhigh', 'Extra high'], ['max', 'Max']];

function settingsField(label, hint, control) {
  const row = el('label', 'settings-field');
  const text = el('div', 'settings-label');
  text.append(el('div', 'settings-name', label));
  if (hint) text.append(el('div', 'settings-hint', hint));
  row.append(text, control);
  return row;
}

function settingsSelect(options, value) {
  const select = document.createElement('select');
  for (const [v, label] of options) {
    const o = document.createElement('option');
    o.value = v;
    o.textContent = label;
    select.appendChild(o);
  }
  // A value the list does not know (set by hand in config.json) stays.
  if (!options.some(([v]) => v === value)) {
    const o = document.createElement('option');
    o.value = value;
    o.textContent = value;
    select.appendChild(o);
  }
  select.value = value;
  return select;
}

function settingsInput(type, value, attrs = {}) {
  const input = document.createElement('input');
  input.type = type;
  if (type === 'checkbox') input.checked = !!value;
  else input.value = value ?? '';
  Object.assign(input, attrs);
  return input;
}

function settingsText(value, placeholder) {
  const area = document.createElement('textarea');
  area.rows = 3;
  area.value = value;
  area.placeholder = placeholder;
  area.spellcheck = false;
  return area;
}

// Names separated by commas, spaces or lines, each once.
function settingsList(text) {
  return [...new Set(String(text || '').split(/[\s,]+/).filter(Boolean))];
}

// Settings → Account: the Claude account Claude Code is signed in with, and
// the others you signed in with before (src/accounts.js). Switch puts
// another one's saved login in place; Add signs in with a new one, and the
// one you are on stays in the list.
const PLAN_NAMES = { pro: 'Pro', max: 'Max', team: 'Team', enterprise: 'Enterprise' };
function accountsPanel() {
  const box = el('div', 'settings-accounts');
  const list = el('div', 'account-list');
  const note = el('div', 'settings-hint account-note');
  const add = el('button', 'account-add', 'Add another account…');
  add.type = 'button';
  box.append(list, note, add);
  const say = text => { note.textContent = text || ''; };

  const render = async () => {
    let data;
    try { data = await window.deck.accounts.list(); } catch (err) { say(`Could not read the accounts: ${err?.message || err}`); return; }
    list.replaceChildren();
    if (!data.signedIn) list.appendChild(el('div', 'account-empty', 'Claude Code is not signed in.'));
    add.textContent = data.signedIn ? 'Add another account…' : 'Sign in…';
    for (const a of data.accounts) {
      const row = el('div', 'account-row' + (a.current ? ' current' : ''));
      row.appendChild(el('div', 'account-avatar', (a.name || a.email || '?').trim()[0].toUpperCase()));
      const who = el('div', 'account-who');
      who.append(el('div', 'account-email', a.email || a.name || 'Unknown account'),
        el('div', 'account-org', [a.orgName, PLAN_NAMES[a.plan] || a.plan].filter(Boolean).join(' · ')));
      row.appendChild(who);
      if (a.current) {
        row.appendChild(el('span', 'account-tag', 'Signed in'));
      } else {
        const go = el('button', 'account-switch', a.expired ? 'Sign in…' : 'Switch');
        go.type = 'button';
        go.title = a.expired ? 'The saved login has expired' : `Use ${a.email} for Claude Code and every agent`;
        go.onclick = () => (a.expired ? signIn(a.email) : switchTo(a));
        const forget = el('button', 'account-forget', '×');
        forget.type = 'button';
        forget.title = 'Remove from the list (its saved login too)';
        forget.onclick = async () => {
          try { await window.deck.accounts.forget(a.id); } catch (err) { say(err?.message || String(err)); }
          window.uiSound?.('tick');
          render();
        };
        row.append(go, forget);
      }
      list.appendChild(row);
    }
  };

  const switchTo = async a => {
    // Running agents use the login Claude Code reads next, so they can end
    // their task on the other account.
    const working = [...state.agents.values()].filter(x => !x.removed && BUSY.includes(x.status) && providerOf(x.choice) !== 'codex');
    if (working.length && !await confirmCard({
      title: `Switch to ${a.email}?`,
      text: `${working.length} agent${working.length === 1 ? ' is' : 's are'} working. They may finish their task on the new account.`,
      agents: working,
      confirmLabel: 'Switch',
      stayLabel: 'Cancel',
    })) return;
    say('Switching…');
    try {
      await window.deck.accounts.switchTo(a.id);
      const status = await window.deck.auth.status().catch(() => null);
      say(status?.loggedIn === false ? 'Claude Code does not accept the saved login. Sign in with this account again.' : '');
      window.uiSound?.('done');
      toast(`Claude: ${status?.email || a.email}`);
      claudeAccountChanged();
    } catch (err) {
      say(`Could not switch: ${err?.message || err}`);
    }
    render();
  };

  const signIn = email => showLoginCard({ add: !email, email, onDone: () => { claudeAccountChanged(); render(); } });
  add.onclick = () => signIn('');
  render();
  return box;
}

// Opens the screen. config: the settings now; onSaved(config) after a save.
function openSettings(config, { onSaved } = {}) {
  if (document.querySelector('.settings-modal')) return;
  const overlay = el('div', 'settings-modal');
  const card = el('div', 'settings-card');
  const head = el('div', 'settings-head');
  head.append(el('div', 'settings-title', 'Settings'));
  const body = el('div', 'settings-body');
  // At the top: look for a new version now (see updateRow below).

  // New agents
  const folder = settingsInput('text', config.defaultFolder, { placeholder: 'The folder of the agent you started last' });
  const pick = el('button', null, 'Choose…');
  pick.type = 'button';
  pick.onclick = async e => {
    e.preventDefault();
    const chosen = await window.deck.pickFolder();
    if (chosen) folder.value = chosen;
  };
  const folderRow = el('div', 'settings-inline');
  folderRow.append(folder, pick);
  const gamesFolder = settingsInput('text', config.gamesFolder, { placeholder: 'For example ~/svn' });
  const pickGames = el('button', null, 'Choose…');
  pickGames.type = 'button';
  pickGames.onclick = async e => {
    e.preventDefault();
    const chosen = await window.deck.pickFolder();
    if (chosen) gamesFolder.value = chosen;
  };
  const gamesRow = el('div', 'settings-inline');
  gamesRow.append(gamesFolder, pickGames);
  const autoGame = settingsInput('checkbox', config.autoGameFolder);
  const mode = settingsSelect(PERMISSION_MODES.map(m => [m.value, m.label]), config.defaultPermissionMode || 'bypassPermissions');
  // The same choices as the model menu (Auto, Opus, Sonnet, Haiku, Fable); a
  // saved choice that is no longer in it stays listed so it is not lost.
  const modelChoices = menuModels().map(m => [m.value, shortName(m)]);
  if (config.defaultModel && !modelChoices.some(([v]) => v === config.defaultModel)) modelChoices.push([config.defaultModel, shortName(modelByValue(config.defaultModel))]);
  const model = settingsSelect(modelChoices, config.defaultModel || 'opus');
  const reportBtn = el('button', 'settings-btn', 'Open report');
  reportBtn.type = 'button';
  reportBtn.onclick = () => autoReport.open();
  const effort = settingsSelect(EFFORT_OPTIONS, config.defaultEffort ?? 'medium');
  const fast = settingsInput('checkbox', config.defaultFastMode);
  // Providers: Claude Code and Codex, each on or off, and which one new
  // agents start on (the other takes over while its limit is reached).
  const claudeOn = settingsInput('checkbox', config.claudeEnabled !== false);
  const codexOn = settingsInput('checkbox', !!config.codexEnabled);
  const provider = settingsSelect([['claude', 'Claude'], ['codex', 'Codex']], config.defaultProvider || 'claude');
  // Codex's model: Auto, or the newest Sol, Terra, Luna or Astra, as in its
  // model menu (picker.js). A model saved by its id shows as its family when
  // it is that family's newest.
  const codexModelChoices = () => [['auto', 'Auto'], ...codexMenuModels().map(m => [m.value, m.displayName])];
  const codexModel = settingsSelect(codexModelChoices(), codexChoiceModel(config.codexModel));
  const codexEffortOptions = () => {
    const m = codexModelByValue(codexModel.value);
    const levels = m.supportedEffortLevels?.length ? m.supportedEffortLevels : ['low', 'medium', 'high', 'xhigh', 'max'];
    return [['', 'Auto'], ...levels.map(l => [l, EFFORT_NAMES[l] || l])];
  };
  const codexEffortSlot = el('div', 'settings-inline');
  let codexEffort = settingsSelect(codexEffortOptions(), config.codexEffort || '');
  codexEffortSlot.appendChild(codexEffort);
  codexModel.onchange = () => {
    const keep = codexEffort.value;
    const next = settingsSelect(codexEffortOptions(), '');
    if ([...next.options].some(o => o.value === keep)) next.value = keep;
    next.disabled = codexEffort.disabled;
    codexEffort.replaceWith(next);
    codexEffort = next;
  };
  const codexFast = settingsInput('checkbox', !!config.codexFastMode);
  const codexPath = settingsInput('text', config.codexPath, { placeholder: 'Found by itself: Homebrew, npm or ~/.local/bin' });
  const codexExtraArgs = settingsText((config.codexExtraArgs || []).join('\n'), 'One flag or value per line, for example\n-c\nmodel_verbosity="low"');
  // Quick tasks: the provider and model for titles, Auto's ratings,
  // follow-ups, group notes and game folders.
  const helperProvider = settingsSelect([['claude', 'Claude'], ['codex', 'Codex']], config.helperProvider || 'claude');
  const claudeHelperModel = settingsSelect(menuModels().filter(m => m.value !== 'auto').map(m => [m.value, shortName(m)]), config.claudeHelperModel || 'haiku');
  const helperChoices = () => (codexMenuModels().length ? codexMenuModels().map(m => [m.value, m.displayName]) : [['luna', 'Luna']]);
  const codexHelperModel = settingsSelect(helperChoices(), config.codexHelperModel ? codexChoiceModel(config.codexHelperModel) : 'luna');
  // The model menus get Codex's list once it is loaded (see fillCodexModels).
  const refill = (select, options) => {
    const keep = select.value;
    const next = settingsSelect(options, keep);
    select.replaceChildren(...next.options);
    select.value = keep;
  };
  let codexLoading = null;
  const fillCodexModels = () => {
    if (codexMenuModels().length || codexLoading) return;
    for (const select of [codexModel, codexHelperModel]) select.appendChild(new Option('Loading Codex\'s models…', '__loading', false, false)).disabled = true;
    codexLoading = loadCodexModels().then(models => {
      codexLoading = null;
      for (const select of [codexModel, codexHelperModel]) select.querySelector('option[value="__loading"]')?.remove();
      if (!models.length) {
        for (const select of [codexModel, codexHelperModel]) select.appendChild(new Option('Could not load the models: is Codex installed and signed in?', '__failed', false, false)).disabled = true;
        return;
      }
      refill(codexModel, codexModelChoices());
      refill(codexHelperModel, helperChoices());
      codexModel.onchange();
    });
  };
  const compact = settingsSelect([['150k', '150k tokens'], ['200k', '200k tokens'], ['300k', '300k tokens'], ['500k', '500k tokens'], ['auto', 'When Claude Code / Codex decides']], config.autoCompact || '200k');

  // The app
  const hubAfterSend = settingsInput('checkbox', config.hubAfterSend !== false);
  const titles = settingsInput('checkbox', config.summarizeTitles !== false);
  const followUps = settingsInput('checkbox', config.suggestFollowUps !== false);
  // The agent's Hub tile in the corner of the screen (toast.js), the
  // system's own notifications, or none.
  const notify = settingsSelect([['tile', 'Agent tile'], ['system', 'System notification'], ['off', 'Off']],
    config.notifyWhenDone === false ? 'off' : config.notifyStyle === 'system' ? 'system' : 'tile');
  // Ctrl+Alt+Space, from any app, opens the agent of the newest notification.
  const notifyKey = settingsInput('checkbox', config.notifyKey !== '');
  const notifyKeyField = settingsField('Open with Ctrl+Alt+Space', 'From any app: opens the agent of the newest notification; press again for the one before', notifyKey);
  window.deck.notifyKeyStatus?.().then(s => {
    if (s?.key && !s.ok) notifyKeyField.querySelector('.settings-hint').textContent = 'Another app already uses Ctrl+Alt+Space, so it does nothing here. Close that app (or change its shortcut) and turn this off and on again';
  }).catch(() => {});
  const sounds = settingsInput('checkbox', config.sounds !== false);
  // The locales Apple's and Windows' speech recognition both know; a value
  // set by hand in config.json stays listed.
  const voiceLanguage = settingsSelect([['', 'The system\'s language'], ['en-US', 'English (US)'], ['en-GB', 'English (UK)'], ['da-DK', 'Danish'], ['de-DE', 'German'], ['es-ES', 'Spanish (Spain)'], ['es-MX', 'Spanish (Mexico)'], ['fr-FR', 'French'], ['it-IT', 'Italian'], ['pl-PL', 'Polish'], ['pt-BR', 'Portuguese (Brazil)'], ['sv-SE', 'Swedish'], ['nb-NO', 'Norwegian'], ['nl-NL', 'Dutch'], ['ja-JP', 'Japanese'], ['zh-CN', 'Chinese']], config.voiceLanguage || '');
  const updatePopup = settingsInput('checkbox', config.updatePopup !== false);
  const theme = settingsSelect(THEMES, config.theme || 'default');
  // Updates: look on GitHub now instead of waiting for the next look (the
  // app looks when its window gets the focus and every 30 minutes).
  const updateRow = el('div', 'settings-update');
  const updateBtn = el('button', 'settings-btn', 'Check for updates');
  updateBtn.type = 'button';
  const updateNote = el('span', 'settings-hint settings-update-note');
  updateRow.append(updateBtn, updateNote);
  updateBtn.onclick = async () => {
    updateBtn.disabled = true;
    updateNote.textContent = 'Checking GitHub…';
    updateRow.querySelector('.settings-update-go')?.remove();
    const r = await window.deck.checkUpdate().catch(() => ({ offline: true }));
    updateBtn.disabled = false;
    if (r.dev) updateNote.textContent = 'This is the dev copy: it does not update itself. Promote from the dev folder instead.';
    else if (r.offline) updateNote.textContent = 'GitHub could not be reached. Try again in a moment.';
    else if (!r.found) updateNote.textContent = `You have the latest version (${$('app-version').textContent}).`;
    else {
      const n = r.found.behind;
      updateNote.textContent = `${r.found.version ? `v${r.found.version}` : 'A new version'} is available (${n} new commit${n === 1 ? '' : 's'}).`;
      const go = el('button', 'settings-btn settings-update-go', 'Update and restart');
      go.type = 'button';
      // The same as the button next to the version: agents that are working
      // get the card that says they continue after the restart.
      go.onclick = () => $('app-update').onclick();
      updateRow.insertBefore(go, updateNote);
    }
  };
  const curved = settingsInput('checkbox', config.curvedScreen !== false);
  const staleAfter = settingsInput('number', config.staleAfterHours ?? 0, { min: 0, step: 1 });

  // Branch diff
  const svnProjects = settingsInput('text', svnProjectList(config).join(', '), { placeholder: 'Every project' });
  const svnBranchFilter = settingsInput('text', (config.svnBranchFilter || []).join(', '), { placeholder: 'Every branch' });
  const githubBranches = settingsInput('checkbox', config.githubBranches);

  // Stuck agents
  const stuckAfter = settingsInput('number', config.stuckAfterSeconds, { min: 5, step: 5 });

  // Claude Code
  const claudePath = settingsInput('text', config.claudePath, { placeholder: 'Found by itself: the newest Claude Code installed' });
  const extraArgs = settingsText((config.extraArgs || []).join('\n'), 'One flag or value per line, for example\n--add-dir\nC:\\Some\\Folder');
  const env = settingsText(Object.entries(config.env || {}).map(([k, v]) => `${k}=${v}`).join('\n'), 'One per line: NAME=value');

  // Multi-agent: the main switch, and the pipeline's graph and agent types
  // (pipelineeditor.js). Off: no Pipeline button, and every agent is a normal one.
  const multiOn = settingsInput('checkbox', !!config.multiAgent?.enabled);
  // Its token estimate measures in the folder you work in (lastFolder and
  // recentFolders are app.js's).
  const pipeline = pipelineEditor(config.multiAgent, {
    folder: typeof lastFolder === 'function' ? lastFolder() : config.defaultFolder,
    folders: typeof recentFolders === 'function' ? recentFolders() : [],
    home: config.home || '',
  });
  const showMulti = () => {
    pipeline.element.classList.toggle('off', !multiOn.checked);
    pipeline.element.title = multiOn.checked ? '' : 'Turn on the multi-agent pipeline to use it';
  };
  multiOn.addEventListener('change', showMulti);
  showMulti();

  // Settings of a provider that is off are greyed out (see showProviders).
  const providerRows = { claude: [], codex: [] };
  const claudeOnly = row => (providerRows.claude.push(row), row);
  const codexOnly = row => (providerRows.codex.push(row), row);
  const showProviders = () => {
    const on = { claude: claudeOn.checked, codex: codexOn.checked };
    for (const [p, rows] of Object.entries(providerRows)) {
      for (const row of rows) {
        row.classList.toggle('off', !on[p]);
        row.title = on[p] ? '' : `Turn on ${p === 'codex' ? 'Codex' : 'Claude'} in Providers to change this`;
        for (const c of row.querySelectorAll('input, select, textarea, button')) c.disabled = !on[p];
      }
      for (const select of [provider, helperProvider]) {
        const option = [...select.options].find(o => o.value === p);
        if (option) option.disabled = !on[p];
      }
    }
  };
  claudeOn.addEventListener('change', showProviders);
  codexOn.addEventListener('change', showProviders);
  codexOn.addEventListener('change', () => { if (codexOn.checked) fillCodexModels(); });

  const section = (title, ...rows) => {
    const s = el('div', 'settings-section');
    if (title) s.appendChild(el('div', 'settings-section-title', title));
    s.append(...rows);
    return s;
  };
  // The settings in groups, listed in the bar on the left (see nav below).
  const tabs = [
    // Not in a settingsField: that is a <label>, and a click on its text
    // would press the first button in it.
    ['account', 'Account', [section('Claude',
      el('div', 'settings-hint account-intro', 'The account Claude Code and every Claude agent use. The accounts you signed in with before stay in the list, so switching back needs no new sign-in.'),
      accountsPanel())]],
    ['agents', 'Agents', [section(null,
      settingsField('Folder', 'Where a new agent works until you pick one in the Hub', folderRow),
      settingsField('Games folder', 'The folder with one folder per game', gamesRow),
      settingsField('Auto game folder', 'A new agent whose message is about one game (by any of its names, or a PM task about it) works in that game\'s folder, for that agent only. About no game or several: the folder you picked', autoGame),
      settingsField('Permissions', null, mode),
      settingsField('Compact the conversation at', 'Every step re-reads the whole conversation, so long tasks get expensive. Smaller: less usage, but the agent remembers fewer details from early in the task', compact))]],
    ['model', 'Providers', [
      section(null,
        settingsField('Start new agents on', 'When its usage limit is reached, new agents start on the other provider (if it is on). Agents that are working wait for their own provider\'s limit to reset, so their conversation stays where it is', provider)),
      section('Claude',
        settingsField('Use Claude', 'Claude Code, with your Claude login', claudeOn),
        claudeOnly(settingsField('Model', 'Auto picks Opus, Sonnet or Haiku for each task', model)),
        claudeOnly(settingsField('Auto model report', 'What Auto cost against running everything on Opus at medium effort', reportBtn)),
        claudeOnly(settingsField('Effort', 'Auto: with the Auto model, it picks the effort for each task too; with another model, the model\'s default', effort)),
        claudeOnly(settingsField('Fast mode', 'Faster answers from the same model', fast))),
      section('Codex',
        settingsField('Use Codex', 'OpenAI\'s Codex CLI, with your ChatGPT login (codex login in a terminal). Its agents read the project\'s CLAUDE.md and your global one', codexOn),
        codexOnly(settingsField('Model', 'Auto picks Sol, Terra or Luna for each task. Each one is its newest version; Astra is for exceptions', codexModel)),
        codexOnly(settingsField('Effort', 'Auto: with the Auto model, it picks the effort for each task too; with another model, the model\'s default', codexEffortSlot)),
        codexOnly(settingsField('Fast mode', 'Codex\'s Fast tier: 1.5 to 2 times faster; for Sol and Astra it uses your limits faster', codexFast))),
      section('Quick tasks',
        settingsField('Run quick tasks on', 'Short titles, Auto\'s ratings, suggested follow-ups, group notes and finding the game folder. While this provider is off or at its usage limit, they run on the other one', helperProvider),
        claudeOnly(settingsField('Claude model', 'Haiku is the fastest and uses the least of your limits', claudeHelperModel)),
        codexOnly(settingsField('Codex model', 'Luna is the fastest and uses the least of your limits', codexHelperModel)))]],
    ['app', 'App', [section(null,
      settingsField('Theme', 'Nostromo: the screens of the ship’s computer in Alien, on an old tube', theme),
      settingsField('Curved screen', 'Nostromo only: the screen has the bulging shape of a tube’s glass, with scanlines that bow with it', curved),
      settingsField('Show the Hub after sending', 'Off: stay in the chat after you send a message', hubAfterSend),
      settingsField('Stale after', 'Hours. An agent on the Hub that finished longer ago than this is marked as stale: its tank goes grey with a Stale stamp that says how long ago it finished, so the ones you worked with lately stand out. 0: off', staleAfter),
      settingsField('Short titles', 'Name new agents with a summary of your message, written by the quick-task model (Providers → Quick tasks)', titles),
      settingsField('Suggest follow-ups', 'After a task, the messages you will likely send next, written by the quick-task model. → or a click puts one in the box, Alt+1–3 sends it', followUps),
      settingsField('Notifications', 'When an agent finishes or needs you while the app is in the background: its tile in the corner of the screen, or the system\'s notification', notify),
      notifyKeyField,
      settingsField('Sounds', 'For everything you and the agents do', sounds),
      settingsField('Voice language', `The language you speak to the microphone button next to Send (${IS_MAC ? '⌘⇧Space' : 'Ctrl+Shift+Space'}). ${IS_MAC ? 'macOS' : 'Windows'} turns it into text itself, so nothing is downloaded`, voiceLanguage),
      settingsField('Update pop-up', 'A card on the Hub asks you to update when a new version is out. Off: only the Update button next to the version in the title bar shows it', updatePopup))]],
    ['multiagent', 'Multi-agent', [
      section(null,
        settingsField('Multi-agent pipeline', 'Adds a ⛓ Pipeline button under the message box. With it on, the new agent is a governor: it hands each step below to its own agents (several at once where a card says so), recaps their work, fixes what is missing between steps, and has the reviewer send the result back until it is right. Claude only. Off: every agent is a normal one', multiOn)),
      section('Pipeline', pipeline.element)]],
    ['branches', 'Branch diff', [section(null,
      settingsField('Projects', `The Branches view lists ${(config.svnServer || 'svn+ssh://svn@tactile.build').replace(/\/+$/, '')}/<project>/branches for each one. Separate them with commas. Empty: every project someone committed to in the last year`, svnProjects),
      settingsField('Branch names', 'Only branches whose names start with one of these. Separate them with commas. Empty: every branch', svnBranchFilter),
      settingsField('GitHub', 'Also list your open pull requests and the branches you pushed in the last 90 days, for the account gh is signed in with', githubBranches))]],
    ['advanced', 'Advanced', [
      section('Claude Code',
        claudeOnly(settingsField('Claude Code program', 'Empty: the app finds it', claudePath)),
        claudeOnly(settingsField('Extra flags', 'Added to every Claude agent', extraArgs))),
      section('Codex',
        codexOnly(settingsField('Codex program', 'Empty: the app finds it', codexPath)),
        codexOnly(settingsField('Extra flags', 'Added to every Codex agent (codex app-server)', codexExtraArgs))),
      section('Both providers',
        settingsField('Environment variables', 'For every agent, on Claude and on Codex', env)),
      section('Stuck agents',
        settingsField('Waiting for Unity for', 'Seconds. An agent only counts as stuck while it waits for Unity to be ready', stuckAfter))]],
  ];
  // A bar on the left with the groups: clicking one scrolls the list to it,
  // and the group you are reading is lit up as you scroll.
  const nav = el('div', 'settings-nav');
  nav.setAttribute('role', 'navigation');
  const groups = new Map();
  for (const [id, label, sections] of tabs) {
    const b = el('button', 'settings-nav-item', label);
    b.type = 'button';
    b.dataset.group = id;
    nav.appendChild(b);
    const group = el('div', 'settings-group');
    group.dataset.group = id;
    group.append(el('div', 'settings-group-title', label), ...sections);
    groups.set(id, group);
    body.appendChild(group);
  }
  const scrollToGroup = (id, smooth = true) => {
    const group = groups.get(id);
    body.scrollTo({ top: group.offsetTop - 4, behavior: smooth ? 'smooth' : 'auto' });
  };
  const light = id => { for (const b of nav.children) b.classList.toggle('active', b.dataset.group === id); };
  const lightFromScroll = () => {
    // The group whose title is near the top of the list (in its upper
    // third, at most 160px down) is the one being read; at the very top it
    // is the first. (The list is the groups' offset parent.)
    const top = body.scrollTop + Math.min(160, Math.max(24, body.clientHeight / 3));
    let current = tabs[0][0];
    if (body.scrollTop < 4) return light(current);
    for (const [id, group] of groups) if (group.offsetTop <= top) current = id;
    light(current);
  };
  body.addEventListener('scroll', lightFromScroll, { passive: true });
  nav.onclick = e => {
    const b = e.target.closest('.settings-nav-item');
    if (!b) return;
    window.uiSound?.('tick');
    light(b.dataset.group);
    scrollToGroup(b.dataset.group);
  };
  // Room under the last group, so its title can scroll up to the top too.
  const fitEnd = () => {
    const last = [...groups.values()].pop();
    body.style.paddingBottom = `${Math.max(16, body.clientHeight - last.offsetHeight - 8)}px`;
  };
  requestAnimationFrame(() => { fitEnd(); lightFromScroll(); });
  showProviders();
  if (codexOn.checked) fillCodexModels();
  // A setting that cannot be saved: the list scrolls to it.
  const showSettingOf = input => {
    input.scrollIntoView({ block: 'center', behavior: 'smooth' });
    input.focus({ preventScroll: true });
  };


  const problem = el('div', 'settings-problem hidden');
  const foot = el('div', 'settings-foot');
  const file = el('button', 'link', 'Open config.json');
  file.type = 'button';
  file.title = 'The file with these settings';
  file.onclick = () => window.deck.openConfig();
  const cancel = el('button', null, 'Cancel');
  cancel.type = 'button';
  const save = el('button', 'settings-save', 'Save');
  save.type = 'button';
  foot.append(file, problem, cancel, save);
  head.appendChild(updateRow);
  const main = el('div', 'settings-main');
  main.append(nav, body);
  card.append(head, main, foot);
  overlay.appendChild(card);
  document.body.appendChild(overlay);
  requestAnimationFrame(() => overlay.classList.add('show'));
  window.uiSound?.('open');

  const close = () => {
    document.removeEventListener('keydown', onKey, true);
    overlay.classList.remove('show');
    setTimeout(() => overlay.remove(), 200);
  };
  const number = (input, fallback) => {
    const n = Number(input.value);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  };
  const submit = async () => {
    const envVars = {};
    for (const line of env.value.split('\n').map(l => l.trim()).filter(Boolean)) {
      const eq = line.indexOf('=');
      if (eq < 1) {
        problem.textContent = `"${line}" is not NAME=value.`;
        problem.classList.remove('hidden');
        showSettingOf(env);
        return;
      }
      envVars[line.slice(0, eq).trim()] = line.slice(eq + 1);
    }
    const next = {
      defaultFolder: folder.value.trim(),
      gamesFolder: gamesFolder.value.trim().replace(/^~(?=$|[\\/])/, config.home || '~'),
      autoGameFolder: autoGame.checked,
      defaultPermissionMode: mode.value,
      defaultModel: model.value,
      defaultEffort: effort.value,
      defaultFastMode: fast.checked,
      claudeEnabled: claudeOn.checked,
      codexEnabled: codexOn.checked,
      defaultProvider: provider.value,
      codexModel: codexModel.value,
      codexEffort: codexEffort.value,
      codexPath: codexPath.value.trim(),
      codexFastMode: codexFast.checked,
      codexExtraArgs: codexExtraArgs.value.split('\n').map(l => l.trim()).filter(Boolean),
      helperProvider: helperProvider.value,
      claudeHelperModel: claudeHelperModel.value,
      codexHelperModel: codexHelperModel.value,
      autoCompact: compact.value,
      hubAfterSend: hubAfterSend.checked,
      summarizeTitles: titles.checked,
      suggestFollowUps: followUps.checked,
      notifyWhenDone: notify.value !== 'off',
      notifyStyle: notify.value === 'system' ? 'system' : 'tile',
      notifyKey: notifyKey.checked ? (config.notifyKey || 'Control+Alt+Space') : '',
      sounds: sounds.checked,
      updatePopup: updatePopup.checked,
      voiceLanguage: voiceLanguage.value,
      theme: theme.value,
      curvedScreen: curved.checked,
      stuckAfterSeconds: number(stuckAfter, 30),
      staleAfterHours: Math.max(0, Number(staleAfter.value)) || 0,
      svnProjects: settingsList(svnProjects.value).map(p => p.replace(/^\/+|\/+$/g, '')).filter(Boolean),
      svnBranchFilter: settingsList(svnBranchFilter.value),
      githubBranches: githubBranches.checked,
      claudePath: claudePath.value.trim(),
      extraArgs: extraArgs.value.split('\n').map(l => l.trim()).filter(Boolean),
      env: envVars,
      multiAgent: { ...pipeline.value(), enabled: multiOn.checked },
    };
    if (!next.claudeEnabled && !next.codexEnabled) {
      problem.textContent = 'Keep at least one provider on.';
      problem.classList.remove('hidden');
      showSettingOf(claudeOn);
      return;
    }
    save.disabled = true;
    try {
      const saved = await window.deck.saveConfig(next);
      close();
      onSaved?.(saved);
    } catch (err) {
      problem.textContent = `Could not save: ${err?.message || err}`;
      problem.classList.remove('hidden');
      save.disabled = false;
    }
  };
  const onKey = e => {
    // A card over Settings (signing in, Switch's question) has the keys.
    if (document.querySelector('.quit-modal')) return;
    if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); close(); }
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); e.stopImmediatePropagation(); submit(); }
  };
  document.addEventListener('keydown', onKey, true);
  cancel.onclick = close;
  save.onclick = submit;
  overlay.onclick = e => { if (e.target === overlay) close(); };
}

window.openSettings = openSettings;
