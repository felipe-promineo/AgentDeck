// Starts and talks to Claude Code processes.
//
// Each agent is one `claude -p` process in stream-json mode. We write the
// person's messages to its stdin as JSON lines, and it writes every event
// (assistant text, tool calls, tool results, end-of-turn results) to stdout
// as JSON lines. We forward those events to the window unchanged.

const os = require('os');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');
const { randomUUID } = require('crypto');
const { findClaude, spawnClaude, killTree, childEnv } = require('./platform');
const pipeline = require('./pipeline');
const { PipelineEngine, savedSnapshot } = require('./pipelinerun');

// Tells every agent that the chat shows images and videos (see media.js and
// the Markdown rendering in render.js).
const MEDIA_PROMPT = [
  'Your conversation is shown in Agent Hub, a desktop app that renders images and videos in the chat.',
  'To show the user an image or a video, write a Markdown image with its file path, for example',
  '![Grass texture](Assets/Textures/Grass.png) or ![Gameplay recording](/Users/name/Movies/clip.mp4).',
  'Paths can be absolute or relative to your working folder.',
  'Images (png, jpg, gif, webp, tga, psd, psb, exr, tif) show as pictures; videos (mp4, webm, mov) show as players.',
  'Whenever you create or change a texture, image or video, show it this way.',
].join(' ');

// Tells every agent that the app already shows its code changes, so its
// final message is about what behaves differently, not a second list of
// the same changes (see the Changes card in diffview.js).
const CHANGES_PROMPT = [
  'Under your final message, Agent Hub shows a Changes card: every file you changed with its full diff,',
  'and for C# a class diagram of the changed types and how they depend on each other.',
  'So in your final message, do not repeat the code changes: no list or box of changed files (no "CHANGES" box),',
  'no before/after diagrams of classes, calls or dependencies, and no walkthrough of which class now calls which.',
  'Instead, focus on behaviour: what the app or game now does differently for the player or the user,',
  'what stays the same, how to see or test it, and anything you could not check, risks, bugs you noticed and open questions.',
  'Name a file or type only when the reader needs it to act on something.',
  'If the project\'s instructions (CLAUDE.md, a skill) ask you to end with a CHANGES box or a visual summary of the code changes,',
  'the Changes card already is that summary here: keep the visual part for the behaviour instead,',
  'for example the steps a player goes through now, or what happens when an event fires, before and after.',
].join(' ');

// A whole file written again (Write) can change its line endings or
// encoding, which reviewers then see as every line changed.
const EDIT_PROMPT = 'To change an existing file, edit the lines that change (the Edit tool) instead of writing the whole file again, so its line endings and encoding stay as they are.';

// Diffs the user asks for (a branch, a commit) are drawn by Agent Hub from
// a command, so the agent does not write them out (see branchdiff.js).
const DIFF_PROMPT = [
  'When the user wants to see a diff (a branch, a commit, uncommitted changes), do not paste it and do not summarize it file by file.',
  'Write a code block with the language agenthub-diff that holds one git diff, git show or svn diff command, for example',
  '```agenthub-diff\ngit diff main...HEAD\n```',
  'Agent Hub runs that command in your folder and shows the result as a diff viewer with a class diagram.',
  'Find the right refs first (the current branch, the branch it split off from) when the user does not name them. Add a short summary of what the changes are about.',
  'When one command is not enough (only some folders or files, several parts), put several commands in the block, one per line: they show as one diff.',
  'For an SVN branch, use svn diff with revisions and paths or URLs, for example svn diff -r 771150:771161 ^/branches/name/Unity/Assets/Code.',
  'Never paste a diff or parts of one into your message, also not in a diff code block: Agent Hub cannot show a pasted excerpt as well as the real diff.',
].join(' ');

// A command for the user to run gets a Run button in the chat (commands.js),
// when it is in a code block of the shell's language. Run while the agent
// sends it the result (command-ran in app.js).
const RUN_LANG = process.platform === 'win32' ? 'powershell, one command per block, without a prompt' : 'bash, one command per block, without a leading $';
const RUN_PROMPT = `When you give the user a command to run, put it in its own code block tagged ${RUN_LANG} or output in the block: Agent Hub shows a Run button on it that runs it in your folder and shows the output. When you need its result to go on, end your turn there: when the user runs it with that button, you receive it as a shell command they ran (<bash-input>, <bash-stdout>, and in <bash-stderr> the exit code when it failed), and you continue from it.`;

// Progress for long tasks with several parts: Agent Hub shows these lines
// in a Progress panel at the top of the task in the chat (milestones in
// render.js), without a notification.
const MILESTONE_PROMPT = [
  'When a task has several parts (for example animating several pieces, building the model of a feature with several types, or changing many screens),',
  'report your progress while you work: each time you finish a part, write one short line on its own that starts with "Milestone:",',
  'saying what is done and how far you are, for example "Milestone: 3 of 8 pieces animated (dig, merge and spawn)".',
  'Agent Hub shows these lines as progress; they do not notify the user, so do not wait for an answer.',
  'Keep each one to a single line, write them only for tasks with several parts, and not in your final message.',
].join(' ');

// Tactile Create Art (the tactile-create-art connector) spends real money
// from the user's monthly budget: the same rules Tactile Create gives its
// own agents, shorter.
const ART_PROMPT = [
  'If you have the Tactile Create Art tools (the tactile-create-art connector), every generation costs money from the user\'s monthly Create Art budget.',
  'One image the user asked for is fine to make; before a 3D model, a video, a retexture or more than four images, say which provider you will use and roughly what it costs, and wait for a yes (unless the user already said to go ahead in this conversation).',
  'If a generation call times out, the job is still running: check it with get_generation_job instead of running it again, and never repeat a paid generation that failed without saying so first.',
  'When only the surface of a 3D model is wrong, retexture it instead of generating it again. After paid generations, say what they cost when the tool tells you.',
].join(' ');

const SYSTEM_PROMPT = `${MEDIA_PROMPT}\n\n${CHANGES_PROMPT}\n\n${EDIT_PROMPT}\n\n${DIFF_PROMPT}\n\n${RUN_PROMPT}\n\n${MILESTONE_PROMPT}\n\n${ART_PROMPT}`;

// 'auto', or the size in tokens when it is between 100k and 1M (false otherwise).
function compactTokens(value) {
  if (value === 'auto') return 'auto';
  const m = /^(\d+(?:\.\d+)?)([km]?)$/.exec(value);
  if (!m) return false;
  let n = Number(m[1]) * (m[2] === 'm' ? 1e6 : m[2] === 'k' ? 1e3 : 1);
  if (!m[2] && n < 1000) n *= 1000;   // "200" is shorthand for 200k
  return n >= 100000 && n <= 1000000 ? n : false;
}

// Claude Code's arguments for an agent (also used to measure a pipeline's
// baseline, see measureBaseline, so both see the same context).
function claudeArgs(config, { resumeId, forkSession, resumeSessionAt, permissionMode, model, effort, fastMode, pipeline: asPipeline, runsDir } = {}) {
  // A pipeline agent (the Pipeline button under the message box) is the
  // governor: it gets the pipeline's sub-agents and its instructions. Only
  // while the pipeline is on in Settings; otherwise it is a normal agent.
  // `asPipeline` is the profile to run (true: the default one).
  const governed = !!asPipeline && config.multiAgent?.enabled;
  const run = governed ? pipeline.pick(config.multiAgent, typeof asPipeline === 'string' ? asPipeline : undefined) : null;
  const args = [
    '-p',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--permission-mode', permissionMode || config.defaultPermissionMode,
    // Send permission questions to us over stdout instead of refusing them.
    '--permission-prompt-tool', 'stdio',
    // Without this flag the CLI refuses a later switch to bypass mode.
    '--allow-dangerously-skip-permissions',
    '--append-system-prompt', governed ? `${SYSTEM_PROMPT}\n\n${pipeline.governorPrompt(run)}` : SYSTEM_PROMPT,
  ];
  if (governed) args.push('--agents', JSON.stringify(pipeline.subagents(run)));
  // The run's files (pipelinerun.js) live in Agent Hub's settings folder:
  // the governor and its sub-agents read them there.
  if (governed && runsDir) args.push('--add-dir', runsDir);
  // "auto" is the app's own (automodel.js picks a real model before this);
  // if one ever slips through, Claude Code uses its default.
  if (model && model !== 'default' && model !== 'auto') args.push('--model', model);
  if (effort) args.push('--effort', effort);
  if (fastMode) args.push('--settings', JSON.stringify({ fastMode: true }));
  // Compact the conversation at this size (see autoCompact in main.js). A
  // value the CLI would refuse is left out, so the agent still starts.
  const compact = String(config.autoCompact || '').trim().toLowerCase();
  if (compactTokens(compact) !== false) args.push('--autocompact', compact);
  if (resumeId) args.push('--resume', resumeId);
  // A fork starts a new session that begins with a copy of resumeId's conversation.
  if (resumeId && forkSession) args.push('--fork-session');
  // Going back to one of your messages: the session up to the answer before it.
  if (resumeId && typeof resumeSessionAt === 'string' && /^[\w-]{8,64}$/.test(resumeSessionAt)) args.push('--resume-session-at', resumeSessionAt);
  args.push(...(config.extraArgs || []));
  return args;
}

class AgentManager {
  constructor({ send, getConfig, runsDir = () => null }) {
    this.send = send;          // send(channel, ...args) to the window
    this.getConfig = getConfig;
    this.runsDir = runsDir;    // where pipeline runs are saved (pipelinerun.js)
    this.agents = new Map();
  }

  // The window may pick the id itself (so it can show the agent's tile before
  // this process has started anything); otherwise a new one is made here.
  start({ id: wantedId, cwd, resumeId, forkSession, resumeSessionAt, permissionMode, model, effort, fastMode, title, pipeline: asPipeline }) {
    const config = this.getConfig();
    const id = typeof wantedId === 'string' && /^[\w-]{8,64}$/.test(wantedId) && !this.agents.has(wantedId) ? wantedId : randomUUID();
    // A pipeline governor's run is held here (pipelinerun.js): Claude Code
    // asks it before and after every step through hooks. A resumed session
    // goes on with its saved run; a fork with a copy of it. Going back to an
    // earlier message (resumeSessionAt) starts without one.
    const governed = !!asPipeline && config.multiAgent?.enabled && !!this.runsDir();
    const runsDir = governed ? this.runsDir() : null;
    const args = claudeArgs(config, { resumeId, forkSession, resumeSessionAt, permissionMode, model, effort, fastMode, pipeline: asPipeline, runsDir });

    const proc = spawnClaude(config.claudePath, args, {
      cwd,
      // Lets Claude ask you questions with options (the AskUserQuestion tool),
      // as in the Claude desktop app. They arrive as permission requests.
      env: childEnv({ CLAUDE_CODE_ENABLE_ASK_USER_QUESTION_TOOL: 'true', ...config.env }),
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const agent = { id, proc, cwd, title, status: 'starting', sessionId: forkSession ? null : resumeId || null, stderr: '', pending: new Set() };
    this.agents.set(id, agent);
    if (governed) {
      const profile = typeof asPipeline === 'string' ? asPipeline : undefined;
      agent.engine = new PipelineEngine({
        runsDir, cwd,
        // A new run takes the profile as Settings has it then.
        currentPlan: () => pipeline.plan(pipeline.pick(this.getConfig().multiAgent, profile)),
        onChange: snap => this.send('agent:pipeline', id, snap),
      });
      if (resumeId && !resumeSessionAt) {
        try { agent.engine.resume(resumeId, { fork: !!forkSession }); } catch { /* starts without a run */ }
      }
      if (agent.sessionId) agent.engine.bindSession(agent.sessionId);
      // The hooks go with "initialize", before your first message.
      proc.stdin.write(JSON.stringify({ type: 'control_request', request_id: `pipeline-init-${id}`, request: { subtype: 'initialize', hooks: PipelineEngine.hooks() } }) + '\n');
    }

    let buffer = '';
    proc.stdout.on('data', chunk => {
      buffer += chunk.toString('utf8');
      let nl;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (line.trim()) this.handleLine(agent, line);
      }
    });
    proc.stderr.on('data', chunk => {
      agent.stderr = (agent.stderr + chunk.toString('utf8')).slice(-8000);
    });
    proc.on('error', err => {
      this.setStatus(agent, 'error');
      this.send('agent:event', id, { type: 'app_error', message: `Could not start claude: ${err.message}` });
    });
    proc.on('exit', code => {
      this.setStatus(agent, code === 0 || agent.closing ? 'exited' : 'error');
      this.send('agent:exit', id, { code, stderr: agent.stderr });
      this.agents.delete(id);
    });

    return { id };
  }

  handleLine(agent, line) {
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    if (msg.type === 'control_request') return this.handleControlRequest(agent, msg);
    if (msg.type === 'control_cancel_request') {
      agent.pending.delete(msg.request_id);
      this.send('agent:permissionCancel', agent.id, msg.request_id);
      if (!agent.pending.size && agent.status === 'waiting') this.setStatus(agent, 'working');
      return;
    }
    if (msg.type === 'control_response') {
      // An answer to one of our requests; request() may be waiting for it.
      const waiting = agent.waiting?.get(msg.response?.request_id);
      if (waiting) {
        agent.waiting.delete(msg.response.request_id);
        waiting(msg.response);
      }
      return;
    }
    if (msg.session_id && msg.session_id !== agent.sessionId) {
      agent.sessionId = msg.session_id;
      this.send('agent:session', agent.id, msg.session_id);
      agent.engine?.bindSession(msg.session_id);
    }
    // The mode can change without us asking, for example when Claude leaves
    // plan mode. The CLI reports the new mode in init and status events.
    if (msg.type === 'system' && msg.permissionMode && msg.permissionMode !== agent.mode) {
      agent.mode = msg.permissionMode;
      this.send('agent:mode', agent.id, msg.permissionMode);
    }
    if (msg.type === 'system' && msg.subtype === 'status') return;
    if (msg.type === 'system' && msg.subtype === 'init') {
      this.setStatus(agent, agent.status === 'starting' ? 'idle' : agent.status);
      if (msg.model && msg.model !== agent.model) {
        agent.model = msg.model;
        this.send('agent:model', agent.id, msg.model);
      }
    }
    // Late pieces of a message must not hide an open question or approval.
    if ((msg.type === 'assistant' || msg.type === 'stream_event') && !agent.pending.size) this.setStatus(agent, 'working');
    // Commands the agent runs in the background (a render, a recording) can
    // outlast its turn: it ends its answer and carries on when they finish
    // (Claude Code wakes it up). Until then it is "background", not done.
    if (msg.type === 'system' && msg.subtype === 'background_tasks_changed') {
      agent.background = Array.isArray(msg.tasks) ? msg.tasks : [];
      this.send('agent:background', agent.id, agent.background.map(t => t.description || t.task_type || 'A background task'));
      clearTimeout(agent.backgroundTimer);
      // The jobs are done: the agent normally starts working again at once.
      // If it does not, it is done.
      if (!agent.background.length && agent.status === 'background') {
        agent.backgroundTimer = setTimeout(() => { if (agent.status === 'background') this.setStatus(agent, 'idle'); }, 8000);
      }
    }
    if (msg.type === 'result') this.setStatus(agent, msg.is_error ? 'error' : agent.background?.length ? 'background' : 'idle');
    if (msg.type === 'result') agent.engine?.turnEnded();
    this.send('agent:event', agent.id, msg);
  }

  // The CLI asks before it runs a tool that your permission mode and rules do
  // not already allow. It waits until we answer with respondPermission().
  handleControlRequest(agent, msg) {
    if (msg.request?.subtype === 'can_use_tool') {
      agent.pending.add(msg.request_id);
      this.setStatus(agent, 'waiting');
      this.send('agent:permission', agent.id, { requestId: msg.request_id, ...msg.request });
      return;
    }
    // A pipeline governor's hooks: its run decides (pipelinerun.js). An
    // error in it lets the step go on rather than stopping the agent.
    if (msg.request?.subtype === 'hook_callback' && agent.engine) {
      const answer = response => this.writeJson(agent, { type: 'control_response', response: { subtype: 'success', request_id: msg.request_id, response } });
      agent.engine.handle(msg.request.callback_id, msg.request.input || {})
        .then(answer, err => { console.error('pipeline hook', msg.request.callback_id, err); answer({}); });
      return;
    }
    // We do not handle other requests (other hook callbacks, SDK MCP servers),
    // so we answer with an error to keep the CLI from waiting for us.
    this.writeJson(agent, {
      type: 'control_response',
      response: { subtype: 'error', request_id: msg.request_id, error: `Agent Hub does not handle ${msg.request?.subtype}` },
    });
  }

  // decision is { behavior: 'allow', updatedInput, updatedPermissions? }
  // or { behavior: 'deny', message }.
  respondPermission(id, requestId, decision) {
    const agent = this.agents.get(id);
    if (!agent || !agent.pending.has(requestId)) return;
    agent.pending.delete(requestId);
    this.writeJson(agent, { type: 'control_response', response: { subtype: 'success', request_id: requestId, response: decision } });
    if (!agent.pending.size) this.setStatus(agent, 'working');
  }

  writeJson(agent, obj) {
    if (agent.proc.stdin.writable) agent.proc.stdin.write(JSON.stringify(obj) + '\n');
  }

  // A pipeline agent's run as the progress panel shows it, or null.
  pipelineState(id) {
    return this.agents.get(id)?.engine?.snapshot() || null;
  }

  setStatus(agent, status) {
    if (agent.status === status) return;
    agent.status = status;
    this.send('agent:status', agent.id, status);
  }

  // images: [{ mediaType, data }] (base64), sent before the text so Claude
  // sees them. Claude reads png, jpeg, gif and webp.
  sendMessage(id, text, images = []) {
    const agent = this.agents.get(id);
    if (!agent) throw new Error('Agent is not running');
    const pictures = (Array.isArray(images) ? images : [])
      .filter(i => /^image\/(png|jpeg|gif|webp)$/.test(i?.mediaType) && typeof i.data === 'string')
      .map(i => ({ type: 'image', source: { type: 'base64', media_type: i.mediaType, data: i.data } }));
    const msg = { type: 'user', message: { role: 'user', content: [...pictures, { type: 'text', text }] } };
    // The task of a run that starts in this turn (the prompt hook has it too).
    if (agent.engine) agent.engine.lastPrompt = String(text || '');
    agent.proc.stdin.write(JSON.stringify(msg) + '\n');
    this.setStatus(agent, 'working');
  }

  control(id, request) {
    const agent = this.agents.get(id);
    if (!agent) return;
    agent.proc.stdin.write(JSON.stringify({ type: 'control_request', request_id: randomUUID(), request }) + '\n');
  }

  // Sends a control request and waits for the CLI's answer (null after 10
  // seconds without one, or when the request failed).
  request(id, request) {
    const agent = this.agents.get(id);
    if (!agent) return Promise.resolve(null);
    const requestId = randomUUID();
    agent.waiting = agent.waiting || new Map();
    return new Promise(resolve => {
      const timer = setTimeout(() => {
        agent.waiting.delete(requestId);
        resolve(null);
      }, 10000);
      agent.waiting.set(requestId, response => {
        clearTimeout(timer);
        resolve(response.subtype === 'success' ? response.response : null);
      });
      this.writeJson(agent, { type: 'control_request', request_id: requestId, request });
    });
  }

  // How full the context window is: { totalTokens, maxTokens, percentage,
  // categories: [{ name, tokens, kind }] }, the same numbers as /context.
  contextUsage(id) {
    return this.request(id, { subtype: 'get_context_usage' });
  }

  // Changes model, effort and fast mode from the next turn on, the same as the
  // /model, /effort and /fast commands in the terminal.
  setModel(id, { model, effort, fastMode }) {
    this.control(id, { subtype: 'set_model', model: model && model !== 'default' && model !== 'auto' ? model : null });
    this.control(id, { subtype: 'apply_flag_settings', settings: { effortLevel: effort || null, fastMode: !!fastMode } });
  }

  setPermissionMode(id, mode) {
    this.control(id, { subtype: 'set_permission_mode', mode });
  }

  // Asks Claude to stop the current turn but keeps the process alive, the same
  // as pressing Esc in the terminal.
  interrupt(id) {
    const agent = this.agents.get(id);
    if (!agent) return;
    const req = { type: 'control_request', request_id: randomUUID(), request: { subtype: 'interrupt' } };
    agent.proc.stdin.write(JSON.stringify(req) + '\n');
  }

  // Stops the claude process and every command it is running.
  killGroup(agent) {
    killTree(agent.proc);
  }

  // Asks the agent to finish (end of input), and stops it after two seconds.
  close(id) {
    const agent = this.agents.get(id);
    if (!agent) return;
    agent.closing = true;
    agent.proc.stdin.end();
    setTimeout(() => { if (agent.proc.exitCode === null) this.killGroup(agent); }, 2000);
  }

  // Agents that are busy right now: working, starting, or waiting for you.
  activeCount() {
    return [...this.agents.values()].filter(a => ['working', 'starting', 'waiting'].includes(a.status)).length;
  }

  // The app is quitting, so there is no time to wait.
  closeAll() {
    for (const agent of this.agents.values()) {
      agent.closing = true;
      this.killGroup(agent);
    }
    for (const proc of helperProcesses) killTree(proc);
  }
}

// ---------- quick helper calls ----------

// The quick calls below (titles, ratings, follow-ups, notes, games) run on
// the provider Settings → Providers picks for them (helperProvider), with
// its quick-task model: Haiku on Claude, by default. While that provider is
// off or at its usage limit, they run on the other one, when it is on and
// not at its limit too. On Codex it is a quick thread on Codex's app-server
// (codexAsk in codex.js), wrapped to look like `claude -p --output-format json`.
const limitedUntil = { claude: 0, codex: 0 };
function setProviderLimited(provider, untilMs) {
  if (provider in limitedUntil) limitedUntil[provider] = Number(untilMs) || 0;
}

function helperProvider(config) {
  const on = { claude: config.claudeEnabled !== false, codex: !!config.codexEnabled };
  const usable = p => on[p] && limitedUntil[p] <= Date.now();
  const want = config.helperProvider === 'codex' ? 'codex' : 'claude';
  const other = want === 'codex' ? 'claude' : 'codex';
  if (usable(want)) return want;
  if (usable(other)) return other;
  return on[want] || !on[other] ? want : other;
}

// args: Claude Code's arguments, with "haiku" where the quick-task model goes.
function spawnHelper(config, args, options) {
  if (helperProvider(config) === 'codex') return codexHelper(config);
  const model = config.claudeHelperModel || 'haiku';
  return spawnClaude(config.claudePath, args.map(a => (a === 'haiku' ? model : a)), options);
}

function codexHelper(config) {
  const fake = new EventEmitter();
  fake.stdout = new PassThrough();
  fake.stdin = new PassThrough();
  let prompt = '';
  fake.stdin.on('data', d => { prompt += d; });
  fake.stdin.on('end', async () => {
    const text = await require('./codex').codexAsk(config, prompt).catch(() => null);
    fake.stdout.end(JSON.stringify(text == null ? { is_error: true } : { result: text.trim(), is_error: false, total_cost_usd: 0 }));
    setImmediate(() => fake.emit('close', text == null ? 1 : 0));
  });
  return fake;
}

// Asks the CLI which models this account can use. This is the same list, with
// the same descriptions, that the model menu in the Claude desktop app shows.
// We start a short-lived process, send the "initialize" request and read the
// "models" field of the answer. No API call is made.
const helperProcesses = new Set();   // short-lived claude processes, stopped when the app quits

function fetchModels(config) {
  return new Promise(resolve => {
    const proc = spawnClaude(config.claudePath,
      ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose'],
      { cwd: os.homedir(), env: childEnv(config.env), stdio: ['pipe', 'pipe', 'ignore'] });
    helperProcesses.add(proc);
    let buffer = '';
    const finish = models => {
      clearTimeout(timer);
      helperProcesses.delete(proc);
      killTree(proc);
      resolve(models);
    };
    const timer = setTimeout(() => finish(null), 15000);
    proc.on('error', () => finish(null));
    proc.stdout.on('data', chunk => {
      buffer += chunk.toString('utf8');
      for (const line of buffer.split('\n')) {
        if (!line.includes('"control_response"')) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.response?.request_id === 'models') return finish(msg.response.response?.models || null);
        } catch { /* incomplete line, wait for more data */ }
      }
    });
    proc.stdin.write(JSON.stringify({ type: 'control_request', request_id: 'models', request: { subtype: 'initialize' } }) + '\n');
  });
}

// Asks Claude Code (on Haiku, the fastest model) for a short title that
// summarizes a task, at most 5 words. It runs without MCP servers and tools,
// which makes it start faster, and saves no session, so it does not show up
// in History. Resolves with the title, or null.
function summarizeTitle(config, text) {
  return new Promise(resolve => {
    const proc = spawnHelper(config,
      ['-p', '--model', 'haiku', '--output-format', 'json', '--strict-mcp-config', '--tools', '', '--no-session-persistence'],
      { cwd: os.tmpdir(), env: childEnv(config.env), stdio: ['pipe', 'pipe', 'ignore'] });
    helperProcesses.add(proc);
    let out = '';
    const timer = setTimeout(() => { killTree(proc); }, 30000);
    proc.stdout.on('data', d => { out += d; });
    proc.on('error', () => resolve(null));
    proc.on('close', () => {
      clearTimeout(timer);
      helperProcesses.delete(proc);
      try {
        const result = JSON.parse(out);
        if (result.is_error || typeof result.result !== 'string') return resolve(null);
        // One line, no "Title:" label, no quotes or end punctuation, at most 5 words.
        const title = result.result.split('\n')[0]
          .replace(/^["'`*#\s]+|["'`*.!?\s]+$/g, '')
          .replace(/^title\s*:\s*/i, '')
          .replace(/^["'`*\s]+/, '')
          .split(/\s+/).slice(0, 5).join(' ');
        resolve(title || null);
      } catch {
        resolve(null);
      }
    });
    proc.stdin.end(
      'Summarize this task as a short title of at most 5 words. Reply with only the title, no quotes, no punctuation at the end.\n\n'
      + 'Task: ' + text.slice(0, 2000));
  });
}

// How hard a task is, for the Auto model (automodel.js in the window): Haiku
// rates it 1 (quick and simple), 2 (normal work) or 3 (hard). Same kind of
// call as summarizeTitle. context: for a follow-up message, the task it
// belongs to (so "yes, do it" is rated as the work it starts). Resolves with
// { level, cost } (level null when it could not tell; cost in dollars).
function rateTask(config, text, context = '') {
  return new Promise(resolve => {
    const proc = spawnHelper(config,
      ['-p', '--model', 'haiku', '--output-format', 'json', '--strict-mcp-config', '--tools', '', '--no-session-persistence'],
      { cwd: os.tmpdir(), env: childEnv(config.env), stdio: ['pipe', 'pipe', 'ignore'] });
    helperProcesses.add(proc);
    let out = '';
    const timer = setTimeout(() => { killTree(proc); }, 20000);
    proc.stdout.on('data', d => { out += d; });
    proc.on('error', () => resolve(null));
    proc.on('close', () => {
      clearTimeout(timer);
      helperProcesses.delete(proc);
      try {
        const result = JSON.parse(out);
        const n = Number(/[123]/.exec(String(result.result || ''))?.[0]);
        // The rating's own cost goes into the Auto report (autoreport.js).
        resolve({ level: result.is_error || !n ? null : n, cost: Number(result.total_cost_usd) || 0 });
      } catch {
        resolve(null);
      }
    });
    proc.stdin.end(
      (context
        ? 'A coding agent is working on this task: ' + context.slice(0, 1500) + '\n\nRate how hard the work this new message asks for is.\n'
        : 'Rate how hard this task is for a coding agent working in a code base.\n')
      + '1 = quick and simple: a question, a small edit, a rename, running a command, a short explanation.\n'
      + '2 = normal work: a feature or fix in a few files, a review, a moderate investigation.\n'
      + '3 = hard: deep debugging, design or architecture, many files, subtle reasoning, a long or vague spec.\n'
      + 'Reply with only the number.\n\n' + (context ? 'New message: ' : 'Task: ') + text.slice(0, 3000));
  });
}

// The messages you are most likely to send next, after an agent finished a
// task: up to three short ones, written as you would write them. Resolves
// with an array (empty when it failed). See loadFollowUps in app.js.
function suggestFollowUps(config, { task = '', answer = '', notes = '' }) {
  return new Promise(resolve => {
    const proc = spawnHelper(config,
      ['-p', '--model', 'haiku', '--output-format', 'json', '--strict-mcp-config', '--tools', '', '--no-session-persistence'],
      { cwd: os.tmpdir(), env: childEnv(config.env), stdio: ['pipe', 'pipe', 'ignore'] });
    helperProcesses.add(proc);
    let out = '';
    const timer = setTimeout(() => { killTree(proc); }, 45000);
    proc.stdout.on('data', d => { out += d; });
    proc.on('error', () => resolve([]));
    proc.on('close', () => {
      clearTimeout(timer);
      helperProcesses.delete(proc);
      try {
        const result = JSON.parse(out);
        if (result.is_error || typeof result.result !== 'string') return resolve([]);
        const lines = result.result.split('\n')
          .map(l => l.trim().replace(/^(\d+[.)]|[-*•])\s*/, '').replace(/^["'`]+|["'`]+$/g, '').trim())
          .filter(l => l && l.length <= 120 && !/^(here|suggest|follow)/i.test(l));
        resolve([...new Set(lines)].slice(0, 3));
      } catch {
        resolve([]);
      }
    });
    proc.stdin.end([
      'A user works with an AI coding agent. The agent just finished the task below. Write the 3 messages the user is most likely to send next,',
      'as the user would type them: short (at most 10 words), direct, in the same language and tone as the user\'s message.',
      'Prefer the obvious next steps: the same change for the next item, fixing what the agent says is left or risky, checking or testing it, committing.',
      'Do not repeat the task. Do not invent features the conversation does not point to.',
      'Reply with only the 3 messages, one per line, no numbering, no quotes.',
      '',
      `<user_message>\n${task.slice(0, 3000)}\n</user_message>`,
      '',
      `<agent_final_message>\n${answer.slice(0, 6000)}\n</agent_final_message>`,
      ...(notes ? ['', `<project_notes>\n${notes.slice(0, 2000)}\n</project_notes>`] : []),
    ].join('\n'));
  });
}

// A group's shared notes, after one of its agents finished a task: Haiku
// adds what the agent learned that will help the other agents later, and
// keeps the notes short. Resolves with the new notes, '' when they did not
// change, or null when it failed. See learnFrom in app.js.
const NOTES_LIMIT = 40;
function mergeNotes(config, { notes = '', category = '', task = '', answer = '', files = [] }) {
  return new Promise(resolve => {
    const proc = spawnHelper(config,
      ['-p', '--model', 'haiku', '--output-format', 'json', '--strict-mcp-config', '--tools', '', '--no-session-persistence'],
      { cwd: os.tmpdir(), env: childEnv(config.env), stdio: ['pipe', 'pipe', 'ignore'] });
    helperProcesses.add(proc);
    let out = '';
    const timer = setTimeout(() => { killTree(proc); }, 90000);
    proc.stdout.on('data', d => { out += d; });
    proc.on('error', () => resolve(null));
    proc.on('close', () => {
      clearTimeout(timer);
      helperProcesses.delete(proc);
      try {
        const result = JSON.parse(out);
        if (result.is_error || typeof result.result !== 'string') return resolve(null);
        const text = result.result.trim();
        if (/^NO_CHANGE\b/.test(text)) return resolve('');
        const lines = text.split('\n').map(l => l.trim()).filter(l => /^[-*] \S/.test(l)).map(l => '- ' + l.slice(2).trim());
        resolve(lines.length ? lines.slice(0, NOTES_LIMIT).join('\n') : '');
      } catch {
        resolve(null);
      }
    });
    proc.stdin.end([
      `You keep the shared notes of a group of AI coding agents${category ? ` (the category "${category}")` : ''} that work on the same project.`,
      'Every agent in the group reads these notes before it works. One agent just finished a task; its messages during the task are below. Update the notes with what it learned that will help the other agents on later tasks.',
      '',
      'Keep only lasting, reusable knowledge: how the project, its tools and its environment work (commands, ports, paths, conventions, pitfalls, what failed and what worked instead) and the user\'s preferences.',
      'Leave out the task\'s own progress, results and file lists, guesses, and anything that is only true for this one task.',
      '',
      'Rules:',
      `- At most ${NOTES_LIMIT} lines, each a "- " bullet with one short sentence.`,
      '- When something new contradicts a note, replace that note.',
      '- Merge duplicates. Keep the wording of notes you do not change.',
      '- If the agent learned nothing worth keeping, reply with exactly: NO_CHANGE',
      '- Otherwise reply with only the complete updated notes: no heading, no other text.',
      '',
      `<notes>\n${notes.trim() || '(none yet)'}\n</notes>`,
      '',
      `<task>\n${task.slice(0, 3000)}\n</task>`,
      '',
      `<agent_messages>\n${answer.slice(-14000)}\n</agent_messages>`,
      '',
      `Files it changed: ${files.slice(0, 40).join(', ') || 'none'}`,
    ].join('\n'));
  });
}

// Your plan's usage limits, without an agent: Claude Code reports them (a
// "rate_limit_event") with every reply, so this sends Haiku a one-word
// message, not saved as a session, and keeps only that report. It costs a
// very small amount of usage. Resolves with the rate_limit_info, or null.
function fetchUsage(config) {
  return new Promise(resolve => {
    const proc = spawnClaude(config.claudePath,
      ['-p', '--model', 'haiku', '--output-format', 'stream-json', '--verbose', '--strict-mcp-config', '--tools', '', '--no-session-persistence'],
      { cwd: os.tmpdir(), env: childEnv(config.env), stdio: ['pipe', 'pipe', 'ignore'] });
    helperProcesses.add(proc);
    let buffer = '';
    let info = null;
    const timer = setTimeout(() => { killTree(proc); }, 45000);
    proc.stdout.on('data', d => {
      buffer += d;
      let nl;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        try {
          const msg = JSON.parse(line);
          if (msg.type === 'rate_limit_event' && msg.rate_limit_info) info = msg.rate_limit_info;
        } catch { /* not a JSON line */ }
      }
    });
    proc.on('error', () => resolve(null));
    proc.on('close', () => {
      clearTimeout(timer);
      helperProcesses.delete(proc);
      resolve(info);
    });
    proc.stdin.end('Reply with only: ok');
  });
}

// Auto game folder's slow step (gamefolders.js): Haiku answers the question
// with { game, name }. With a task to read it gets only the Tactile PM
// connector's pm_get_task, its tools loaded on demand (loading every
// connector's tools up front costs fifty times more). Resolves with null
// when it fails or takes too long.
function pickGame(config, question, { task = null } = {}) {
  return new Promise(resolve => {
    const args = ['-p', '--model', 'haiku', '--output-format', 'json', '--no-session-persistence'];
    if (task) args.push('--tools', 'ToolSearch', '--allowedTools', 'ToolSearch,mcp__claude_ai_Tactile_PM__pm_get_task');
    else args.push('--strict-mcp-config', '--tools', '');
    const proc = spawnHelper(config, args,
      { cwd: os.tmpdir(), env: { ...childEnv(config.env), ENABLE_TOOL_SEARCH: 'true' }, stdio: ['pipe', 'pipe', 'ignore'] });
    helperProcesses.add(proc);
    let out = '';
    const timer = setTimeout(() => { killTree(proc); }, task ? 25000 : 12000);
    proc.stdout.on('data', d => { out += d; });
    proc.on('error', () => resolve(null));
    proc.on('close', () => {
      clearTimeout(timer);
      helperProcesses.delete(proc);
      try {
        const result = JSON.parse(out);
        if (result.is_error) return resolve(null);
        resolve(JSON.parse(/\{[\s\S]*\}/.exec(String(result.result || ''))[0]));
      } catch {
        resolve(null);
      }
    });
    proc.stdin.end(question);
  });
}

// ---------- a pipeline's baseline (Settings → Multi-agent) ----------

// What Claude Code would put in a request before any work, in a folder:
// it starts with these arguments, answers "initialize" and then
// "get_context_usage" (the numbers of /context). No message is sent, so it
// costs nothing. Resolves with the usage, or null.
function contextProbe(config, args, cwd) {
  return new Promise(resolve => {
    const proc = spawnClaude(config.claudePath, [...args, '--no-session-persistence'],
      { cwd, env: childEnv(config.env), stdio: ['pipe', 'pipe', 'ignore'] });
    helperProcesses.add(proc);
    let buffer = '';
    let done = false;
    const finish = value => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      helperProcesses.delete(proc);
      killTree(proc);
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), 30000);
    proc.on('error', () => finish(null));
    proc.on('exit', () => finish(null));
    const write = obj => { try { proc.stdin.write(JSON.stringify(obj) + '\n'); } catch { finish(null); } };
    proc.stdout.on('data', chunk => {
      buffer += chunk.toString('utf8');
      let nl;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (!line.includes('"control_response"')) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        const id = msg.response?.request_id;
        if (id === 'init') write({ type: 'control_request', request_id: 'usage', request: { subtype: 'get_context_usage' } });
        if (id === 'usage') finish(msg.response.subtype === 'success' ? msg.response.response : null);
      }
    });
    write({ type: 'control_request', request_id: 'init', request: { subtype: 'initialize' } });
  });
}

// The governor of `multiAgent` (the editor's pipeline, saved or not) in
// `cwd`, measured as it would start, and the tools of each sub-agent tool
// set. Resolves with { governor: { total, model, categories, memoryFiles,
// mcpTools }, toolSets: { all, readonly, readshell } } or { error }.
async function measurePipeline(config, multiAgent, cwd) {
  if (config.claudeEnabled === false) return { error: 'Claude is off in Settings → Providers.' };
  if (!cwd || !require('fs').existsSync(cwd)) return { error: 'Pick a folder that exists.' };
  // `multiAgent` is the editor's profile as one graph: it is the one measured.
  const governed = { ...config, multiAgent: { ...pipeline.normalize(multiAgent), enabled: true } };
  const model = config.defaultModel && config.defaultModel !== 'auto' ? config.defaultModel : undefined;
  const sets = Object.entries(pipeline.TOOL_SETS).filter(([, tools]) => tools);
  const [usage, ...subsets] = await Promise.all([
    contextProbe(governed, claudeArgs(governed, { pipeline: true, model }), cwd),
    // Only the tool definitions count here: no MCP servers, no prompt of ours.
    ...sets.map(([, tools]) => contextProbe(config, ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--strict-mcp-config', '--tools', tools.join(',')], cwd)),
  ]);
  if (!usage) return { error: 'Claude Code did not answer. Is it installed and signed in?' };
  const category = (u, id) => u?.categories?.find(c => c.id === id)?.tokens || 0;
  const toolSets = { all: category(usage, 'system_tools') };
  sets.forEach(([name], i) => { if (subsets[i]) toolSets[name] = category(subsets[i], 'system_tools'); });
  return {
    governor: {
      total: usage.totalTokens || 0,
      model: usage.model || '',
      categories: (usage.categories || []).filter(c => c.kind === 'used').map(c => ({ id: c.id, name: c.name, tokens: c.tokens })),
      deferred: category(usage, 'system_tools_deferred'),
      memoryFiles: (usage.memoryFiles || []).map(f => ({ path: f.path, type: f.type, tokens: f.tokens })),
      mcpTools: (usage.mcpTools || []).map(t => ({ name: t.name || t.toolName || '', server: t.serverName || t.server || '', tokens: t.tokens || 0 })),
      // MCP tools a sub-agent with every tool gets too.
      mcp: category(usage, 'mcp_tools') || (usage.mcpTools || []).reduce((sum, t) => sum + (t.tokens || 0), 0),
    },
    toolSets,
    folder: cwd,
    at: Date.now(),
  };
}

// A saved session's last pipeline run, as the progress panel shows it.
function pipelineSnapshot(runsDir, sessionId) {
  try { return runsDir ? savedSnapshot(runsDir, sessionId) : null; } catch { return null; }
}

module.exports = { AgentManager, measurePipeline, pipelineSnapshot, fetchModels, findClaude, summarizeTitle, rateTask, pickGame, mergeNotes, suggestFollowUps, fetchUsage, setProviderLimited, compactTokens, SYSTEM_PROMPT, EDIT_PROMPT };
