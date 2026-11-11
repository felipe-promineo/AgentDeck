// A pipeline run, driven in code (the ⛓ Pipeline button; pipeline.js has
// the graphs). The governor is still a Claude Code agent that does the
// work, but Agent Hub holds the run: Claude Code asks it before and after
// every step (hooks over the stream-json control channel, see agents.js),
// and this file decides.
//
// - Order: a step can start only when the steps it takes input from are
//   done. A step out of order is refused with the reason and what comes
//   next; once the pipeline has started, no step is skipped. Starting a
//   first step again starts a new run (a new task).
// - Handoff by files: every answer is saved to the run's folder, and each
//   sub-agent gets the paths of its inputs (the task, the outputs it takes,
//   the findings to fix) added to its prompt, so nothing is lost in a
//   retelling and the governor does not paste outputs around.
// - Verdicts: a verdict step's answer is read with Pipeline.parseVerdict.
//   On "changes" the work goes back along its ✕ connection, and the rounds
//   are counted here; after the last one the run goes on and the problems
//   left are listed for the user.
// - Steps that change files at the same time each work in a git worktree
//   (pipelineworktree.js), merged back into the folder when each finishes.
// - Checkpoints: the run's state is saved after every change, by session,
//   so a resumed session goes on from where it stopped.
//
// The state, saved in <runs>/<run id>/state.json: { id, sessionId,
// profileId, profileName, plan (Pipeline.plan, frozen at the start), task,
// status: running | paused | done | stopped, steps: { id: { status: pending
// | running | waiting | done | skipped, round, started, finished, files,
// verdict, findings, called, noVerdict } }, rounds: { gate id: send-backs },
// sendBack: { from, targets, optional, file } | null, issues: [...],
// calls: { tool use id: { node, round, isolate, agentId, worktree } } }.

const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const Pipeline = require('./pipeline');
const worktrees = require('./pipelineworktree');

const TASK = Pipeline.TASK;
const DONE = Pipeline.DONE;
const NOTE = 'Agent Hub pipeline:';
const FINISHED = new Set(['done', 'skipped']);

// Where each run is kept, and which run belongs to which session.
class RunStore {
  constructor(dir) {
    this.dir = dir;
  }

  sessionsFile() { return path.join(this.dir, 'sessions.json'); }

  sessions() {
    try { return JSON.parse(fs.readFileSync(this.sessionsFile(), 'utf8')) || {}; } catch { return {}; }
  }

  // The newest 1000 sessions are enough.
  bind(sessionId, runId) {
    if (!sessionId || !runId) return;
    const all = this.sessions();
    if (all[sessionId]?.run === runId) return;
    all[sessionId] = { run: runId, at: Date.now() };
    const keep = Object.entries(all).sort((a, b) => (b[1].at || 0) - (a[1].at || 0)).slice(0, 1000);
    writeAtomic(this.sessionsFile(), JSON.stringify(Object.fromEntries(keep)));
  }

  runFor(sessionId) {
    return this.sessions()[sessionId]?.run || null;
  }

  runDir(runId) { return path.join(this.dir, runId); }

  load(runId) {
    if (!/^[\w-]{8,64}$/.test(String(runId || ''))) return null;
    try { return JSON.parse(fs.readFileSync(path.join(this.runDir(runId), 'state.json'), 'utf8')); } catch { return null; }
  }

  save(state) {
    fs.mkdirSync(this.runDir(state.id), { recursive: true });
    state.updatedAt = Date.now();
    writeAtomic(path.join(this.runDir(state.id), 'state.json'), JSON.stringify(state, null, 1));
  }

  // A copy of a run under a new id (a forked session goes on from it on its own).
  copy(runId) {
    const state = this.load(runId);
    if (!state) return null;
    const id = randomUUID();
    fs.cpSync(this.runDir(runId), this.runDir(id), { recursive: true });
    const from = this.runDir(runId);
    const to = this.runDir(id);
    for (const s of Object.values(state.steps)) s.files = (s.files || []).map(f => f.split(from).join(to));
    if (state.sendBack?.file) state.sendBack.file = state.sendBack.file.split(from).join(to);
    for (const s of Object.values(state.steps)) if (s.findings?.file) s.findings.file = s.findings.file.split(from).join(to);
    Object.assign(state, { id, copiedFrom: runId, sessionId: null });
    this.save(state);
    return state;
  }
}

function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, text);
  fs.renameSync(temp, file);
}

// The text of a sub-agent's answer, as the Agent tool's result has it.
function answerText(response) {
  if (typeof response === 'string') return response.trim();
  const content = response?.content;
  const text = Array.isArray(content) ? content.filter(b => b?.type === 'text').map(b => b.text).join('\n')
    : typeof content === 'string' ? content : typeof response?.result === 'string' ? response.result : '';
  return text.replace(/<tools-used-before-summary>[\s\S]*?<\/tools-used-before-summary>\s*/g, '').trim();
}

class PipelineEngine {
  // runsDir: where runs are saved. cwd: the agent's folder. currentPlan():
  // Pipeline.plan of the profile the agent runs now (a new run freezes it).
  // onChange(snapshot): the window's progress panel. git: pipelineworktree
  // (tests pass their own).
  constructor({ runsDir, cwd, currentPlan, onChange = () => {}, git = worktrees }) {
    this.store = new RunStore(runsDir);
    this.cwd = cwd;
    this.currentPlan = currentPlan;
    this.onChange = onChange;
    this.git = git;
    this.run = null;
    this.sessionId = null;
    this.lastPrompt = '';
    this.blockedStop = false;
    this.promptSinceStep = true;
    this.batch = null;         // the snapshot parallel editing steps start from
    this.gitUsable = null;
  }

  // ---------- sessions and checkpoints ----------

  // The session id is known (or changed): the run belongs to it.
  bindSession(sessionId) {
    this.sessionId = sessionId;
    if (this.run && !this.run.sessionId) {
      this.run.sessionId = sessionId;
      this.save();
    }
    if (this.run) this.store.bind(sessionId, this.run.id);
  }

  // A resumed session takes its run back; a fork goes on from a copy. A run
  // stopped in the middle (the app quit, an error) goes on from its last
  // finished step: a step that was running starts again.
  resume(sessionId, { fork = false } = {}) {
    const runId = this.store.runFor(sessionId);
    if (!runId) return null;
    const state = fork ? this.store.copy(runId) : this.store.load(runId);
    if (!state || !state.plan || !state.steps) return null;
    this.run = state;
    const stale = Object.values(state.calls || {});
    state.calls = {};
    for (const c of stale) if (c.worktree) this.git.remove(this.cwd, c.worktree.path, c.worktree.branch).catch(() => {});
    for (const [id, s] of Object.entries(state.steps)) {
      if (s.status === 'running') {
        // Its round starts over: a half-written answer goes.
        const node = state.plan.nodes.find(n => n.id === id);
        const file = node && path.join(this.store.runDir(state.id), `${node.id}-${Pipeline.slug(node.label)}.r${s.round}.md`);
        if (file) { fs.rmSync(file, { force: true }); s.files = s.files.filter(f => f !== file); }
        Object.assign(s, { status: 'pending', started: 0, finished: 0 });
      }
      // A question card that was open is gone: the step asks again.
      if (s.status === 'waiting' && state.askPending) s.status = 'pending';
    }
    state.askPending = false;
    if (state.status === 'running') state.status = 'paused';
    if (!fork) this.sessionId = sessionId;
    this.save();
    return state;
  }

  save() {
    if (!this.run) return;
    try { this.store.save(this.run); } catch { /* the run goes on in memory */ }
    if (this.sessionId && this.run.sessionId === this.sessionId) {
      try { this.store.bind(this.sessionId, this.run.id); } catch { /* not important */ }
    }
    this.onChange(this.snapshot());
  }

  dir() { return this.run ? this.store.runDir(this.run.id) : ''; }

  // ---------- the graph ----------

  node(id) { return this.run.plan.nodes.find(n => n.id === id); }
  step(id) { return this.run.steps[id]; }
  label(id) { return id === TASK ? 'the task' : id === DONE ? 'Done' : `step ${id} (${this.node(id)?.label || '?'})`; }
  active() { return !!this.run && (this.run.status === 'running' || this.run.status === 'paused'); }

  inputsDone(n) {
    return n.inputs.every(i => i === TASK || FINISHED.has(this.step(i)?.status));
  }

  // The steps that may start now (ids). While a verdict's send-back waits,
  // only its targets; after an Ask-the-user answer, the steps after it or
  // (to change something) its targets.
  next() {
    if (!this.active()) return [];
    const sb = this.run.sendBack;
    if (sb && !sb.optional) return [...sb.targets];
    const ids = [];
    for (const n of this.run.plan.nodes) {
      const s = this.step(n.id);
      if (n.skip) continue;
      const onDemand = this.run.plan.onDemand.includes(n.id);
      if (s.status === 'pending' && this.inputsDone(n) && (!onDemand || s.called)) ids.push(n.id);
      else if (s.status === 'running' && s.started < n.count) ids.push(n.id);
    }
    if (sb?.optional) for (const t of sb.targets) if (!ids.includes(t)) ids.push(t);
    return ids;
  }

  runningIds() {
    return this.run ? this.run.plan.nodes.filter(n => ['running', 'waiting'].includes(this.step(n.id).status)).map(n => n.id) : [];
  }

  // Steps with nothing to run are passed over; the run is done when nothing
  // can start and nothing runs.
  advance() {
    if (!this.active()) return;
    let changed = true;
    while (changed) {
      changed = false;
      for (const n of this.run.plan.nodes) {
        const s = this.step(n.id);
        if (n.skip && s.status === 'pending' && this.inputsDone(n) && !this.run.plan.onDemand.includes(n.id)) {
          s.status = 'skipped';
          changed = true;
        }
      }
    }
    // An Ask-the-user answer may still send the work back, but the run is
    // done when nothing else is left (agents.js reopens it for a send-back).
    const left = this.next().filter(id => !this.run.sendBack?.optional || !this.run.sendBack.targets.includes(id));
    if (!left.length && !this.runningIds().length && (!this.run.sendBack || this.run.sendBack.optional)) this.run.status = 'done';
  }

  // The steps after `id` (forward) or before it, over normal connections,
  // itself included.
  reach(id, forward) {
    const seen = new Set([id]);
    const stack = [id];
    while (stack.length) {
      const at = stack.pop();
      for (const x of (forward ? this.node(at)?.outputs : this.node(at)?.inputs) || []) {
        if (x !== TASK && x !== DONE && !seen.has(x)) { seen.add(x); stack.push(x); }
      }
    }
    return seen;
  }

  // ---------- starting a run ----------

  newRun(task) {
    const plan = this.currentPlan();
    const id = randomUUID();
    const steps = {};
    for (const n of plan.nodes) steps[n.id] = { status: 'pending', round: 1, started: 0, finished: 0, files: [], verdict: null, findings: null, called: false, noVerdict: 0 };
    if (this.run && this.active()) {
      this.run.status = 'stopped';
      this.save();
    }
    this.run = {
      version: 1, id, sessionId: this.sessionId, profileId: plan.profileId, profileName: plan.profileName, createdAt: Date.now(),
      plan, task: String(task || ''), status: 'running', steps, rounds: {}, sendBack: null, issues: [], calls: {},
    };
    fs.mkdirSync(this.dir(), { recursive: true });
    fs.writeFileSync(path.join(this.dir(), 'task.md'), `# The task\n\n${this.run.task || '(See the conversation: the user\'s last message.)'}\n`);
    this.blockedStop = false;
    this.advance();
    this.save();
  }

  // ---------- hooks (agents.js answers Claude Code with what these return) ----------

  // The hooks Agent Hub registers when the governor starts.
  static hooks() {
    return {
      // Read: a step reading its input files is not asked about (see preTool).
      PreToolUse: [{ matcher: 'Agent|Task|AskUserQuestion|Read', hookCallbackIds: ['pipeline-pre'] }],
      PostToolUse: [{ matcher: 'Agent|Task|AskUserQuestion', hookCallbackIds: ['pipeline-post'] }],
      PostToolUseFailure: [{ matcher: 'Agent|Task|AskUserQuestion', hookCallbackIds: ['pipeline-failed'] }],
      SubagentStart: [{ hookCallbackIds: ['pipeline-subagent-start'] }],
      SubagentStop: [{ hookCallbackIds: ['pipeline-subagent-stop'] }],
      UserPromptSubmit: [{ hookCallbackIds: ['pipeline-prompt'] }],
      Stop: [{ hookCallbackIds: ['pipeline-stop'] }],
    };
  }

  async handle(callbackId, input = {}) {
    switch (callbackId) {
      case 'pipeline-pre': return this.preTool(input);
      case 'pipeline-post': return this.postTool(input);
      case 'pipeline-failed': return this.toolFailed(input);
      case 'pipeline-subagent-start': return this.subagentStart(input);
      case 'pipeline-subagent-stop': return this.subagentStop(input);
      case 'pipeline-prompt': return this.prompt(input);
      case 'pipeline-stop': return this.stop(input);
      default: return {};
    }
  }

  isRunFile(file) {
    if (typeof file !== 'string' || !path.isAbsolute(file)) return false;
    const rel = path.relative(path.resolve(this.store.dir), path.resolve(file));
    return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
  }

  isStepAgent(type) {
    const plans = [this.run?.plan, this.currentPlan()].filter(Boolean);
    return !!type && plans.some(p => p.nodes.some(n => n.agent === type));
  }

  async preTool({ tool_name: tool, tool_input: input = {}, tool_use_id: toolId }) {
    // The run's own files (outside the agent's folder, so Claude Code would
    // ask you each time): reading them is allowed. Nothing else changes.
    if (tool === 'Read') return this.isRunFile(input.file_path) ? allow(input) : {};
    if (tool === 'AskUserQuestion') {
      const ask = this.next().map(id => this.node(id)).find(n => n?.kind === 'ask' && this.step(n.id).status === 'pending');
      if (ask) {
        this.step(ask.id).status = 'waiting';
        this.run.askPending = true;
        this.run.calls[toolId] = { node: ask.id, round: this.step(ask.id).round, ask: true };
        this.save();
      }
      return {};
    }
    const type = input.subagent_type;
    // Agents that are not steps (a quick helper of the governor's) are its own business.
    if (!this.isStepAgent(type)) return {};
    const claim = await this.claim(type, `${input.description || ''}`, toolId);
    if (claim.deny) return deny(`${NOTE} ${claim.deny}`);
    return allow({ ...input, prompt: `${input.prompt || ''}${claim.addendum}`, run_in_background: false, ...(claim.isolate ? { isolation: 'worktree' } : {}) });
  }

  // Which step a call of `type` is, whether it may start, and what its
  // prompt gets: { deny } or { node, addendum, isolate }.
  async claim(type, description, toolId) {
    const wanted = /\bstep\s+([\w-]+)/i.exec(description)?.[1];
    const pick = plan => {
      const all = plan.nodes.filter(n => n.agent === type);
      const named = all.filter(n => n.id === wanted);
      return named.length ? named : all;
    };
    // The user wants a change after the last Ask the user: the run goes on.
    const sb = this.run?.sendBack;
    if (this.run?.status === 'done' && sb?.optional && pick(this.run.plan).some(n => sb.targets.includes(n.id))) this.run.status = 'running';
    if (this.active()) {
      const candidates = pick(this.run.plan);
      const open = this.next();
      const node = candidates.find(n => open.includes(n.id));
      if (node) return this.start(node, toolId);
      // A first step again after a new message from the user: a new task.
      // (Not within one turn: that is a mistake, not a new task.)
      const first = candidates.find(n => this.run.plan.first.includes(n.id) && this.step(n.id).status !== 'pending');
      if (first && !this.run.sendBack && this.promptSinceStep) {
        this.newRun(this.lastPrompt);
        return this.start(this.node(first.id), toolId);
      }
      return { deny: this.refusal(candidates) };
    }
    const plan = this.currentPlan();
    const first = pick(plan).find(n => plan.first.includes(n.id));
    if (!first) {
      const starts = plan.first.map(id => plan.nodes.find(n => n.id === id)).filter(n => n?.agent).map(n => `step ${n.id} (${n.label}, subagent_type "${n.agent}")`);
      return { deny: `no pipeline run is going on, so this step cannot start yet. A run starts with its first step${starts.length ? `: ${starts.join(' or ')}` : ''}.` };
    }
    this.newRun(this.lastPrompt);
    return this.start(this.node(first.id), toolId);
  }

  refusal(candidates) {
    const what = candidates.map(n => this.label(n.id)).join(' or ');
    const open = this.next();
    const why = candidates.map(n => {
      const s = this.step(n.id);
      if (s.status === 'running' && s.started >= n.count) return `${this.label(n.id)} already runs with all its ${n.count} agent${n.count === 1 ? '' : 's'}`;
      if (FINISHED.has(s.status)) return `${this.label(n.id)} is done (its answer is in ${s.files.at(-1) || 'the run folder'})`;
      const missing = n.inputs.filter(i => i !== TASK && !FINISHED.has(this.step(i)?.status)).map(i => this.label(i));
      return missing.length ? `${this.label(n.id)} waits for ${missing.join(' and ')}` : `${this.label(n.id)} runs only when a step sends work back to it`;
    });
    return `${what} cannot start now: ${why.join('; ')}. ${this.whatNext(open)}`;
  }

  // "Next: step n3 (Implementer), subagent_type "pipeline-implementer"."
  whatNext(open = this.next()) {
    if (!open.length) {
      if (this.runningIds().length) return `Wait for ${this.runningIds().map(id => this.label(id)).join(' and ')}.`;
      return 'Every step is done: write your final message.';
    }
    const sb = this.run.sendBack;
    const steps = open.map(id => {
      const n = this.node(id);
      if (n.kind === 'ask') return `${this.label(id)}: stop and ask the user (AskUserQuestion)`;
      const s = this.step(id);
      const more = s.status === 'running' ? n.count - s.started : n.count;
      return `${this.label(id)}, subagent_type "${n.agent}"${more > 1 ? `, ${more} agents at once (one message, each with its own part)` : ''}`;
    });
    if (sb && !sb.optional) return `Next: send the work back to ${sb.targets.length > 1 ? 'one of ' : ''}${steps.join(' or ')}.`;
    return `Next${open.length > 1 ? ', at the same time' : ''}: ${steps.join(sb?.optional ? ' or ' : '; ')}.`;
  }

  async start(node, toolId) {
    const s = this.step(node.id);
    const sb = this.run.sendBack;
    if (sb && sb.targets.includes(node.id)) this.applySendBack(node.id);
    else if (sb?.optional) this.run.sendBack = null;
    s.status = 'running';
    s.started++;
    this.promptSinceStep = false;
    const call = { node: node.id, round: s.round, isolate: false };
    this.run.calls[toolId] = call;
    if (node.isolate && await this.canIsolate()) {
      // One snapshot for the agents that start together (their hooks can
      // overlap): the first makes it, the others wait for the same one.
      if (!this.batch || this.batch.open <= 0) this.batch = { open: 0, ready: this.git.snapshot(this.cwd).then(r => r.sha) };
      this.batch.open++;
      try {
        call.snapshot = await this.batch.ready;
        call.isolate = true;
      } catch {
        // Not isolated: the agents share the folder.
        this.batch.open--;
      }
    }
    this.save();
    return { node, isolate: call.isolate, addendum: this.addendum(node, call) };
  }

  async canIsolate() {
    if (this.gitUsable === null) this.gitUsable = await this.git.usable(this.cwd).catch(() => false);
    return this.gitUsable;
  }

  // What Agent Hub adds to a step's prompt: where it stands, its input
  // files, and for a verdict step the verdict block.
  addendum(node, call) {
    const s = this.step(node.id);
    const files = [`- The task: ${path.join(this.dir(), 'task.md')}`];
    for (const i of node.inputs) {
      if (i === TASK) continue;
      for (const f of this.step(i)?.files.slice(-1) || []) files.push(`- The output of ${this.label(i)}: ${f}`);
    }
    if (s.findings) files.push(`- What ${this.label(s.findings.from)} found, to fix in this round: ${s.findings.file}`);
    const rounds = Math.max(1, ...this.run.plan.nodes.filter(n => n.back.includes(node.id)).map(n => n.rounds + 1));
    const lines = [
      '',
      '',
      `--- ${NOTE} ${this.label(node.id)}${s.round > 1 ? `, round ${s.round} of at most ${rounds}` : ''} ---`,
      'Read these files in full before you start: they are this step\'s inputs.',
      ...files,
      'Agent Hub saves your final answer for the next steps, so make it complete. Do not write to that folder.',
    ];
    if (call.isolate) lines.push('You work in a git worktree of your own, with the folder\'s current state: change files there. Agent Hub merges your changes back into the folder when you finish. Do not commit.');
    if (node.verdict && node.kind !== 'ask') lines.push(Pipeline.VERDICT_FORMAT);
    return lines.join('\n');
  }

  // The work goes back to `target`: it and the steps between it and the
  // step that sent it back run again (a new round).
  applySendBack(target) {
    const sb = this.run.sendBack;
    this.run.rounds[sb.from] = (this.run.rounds[sb.from] || 0) + 1;
    const after = this.reach(target, true);
    const before = this.reach(sb.from, false);
    for (const n of this.run.plan.nodes) {
      if (n.id !== target && !(after.has(n.id) && before.has(n.id))) continue;
      const s = this.step(n.id);
      Object.assign(s, { status: 'pending', started: 0, finished: 0, verdict: null, noVerdict: 0, round: s.round + 1 });
    }
    const t = this.step(target);
    t.called = true;
    t.findings = { from: sb.from, file: sb.file };
    this.run.sendBack = null;
  }

  async postTool({ tool_name: tool, tool_input: input = {}, tool_response: response, tool_use_id: toolId }) {
    const call = this.run?.calls[toolId];
    if (!call) return {};
    if (tool === 'AskUserQuestion') {
      delete this.run.calls[toolId];
      const answers = response?.answers || response;
      const text = `## The question\n\n${(input.questions || []).map(q => `- ${q.question}${q.options ? ` (${q.options.map(o => o.label).join(' / ')})` : ''}`).join('\n')}\n\n## The user's answer\n\n${typeof answers === 'string' ? answers : '```json\n' + JSON.stringify(answers, null, 2) + '\n```'}\n`;
      return context(this.askAnswered(call.node, text));
    }
    // A step started in the background ends with SubagentStop.
    if (response?.status === 'async_launched' || response?.isAsync) {
      call.agentId = response.agentId || null;
      this.save();
      return context(`${NOTE} ${this.label(call.node)} runs in the background; Agent Hub records its answer when it finishes. Wait for it before the steps after it.`);
    }
    return context(await this.finish(toolId, answerText(response), response));
  }

  async toolFailed({ tool_use_id: toolId, error }) {
    const call = this.run?.calls[toolId];
    if (!call) return {};
    delete this.run.calls[toolId];
    const s = this.step(call.node);
    if (call.ask) s.status = 'pending';
    else {
      s.started = Math.max(0, s.started - 1);
      if (!s.started) s.status = 'pending';
      await this.dropWorktree(call);
    }
    this.run.askPending = false;
    this.save();
    return context(`${NOTE} ${this.label(call.node)} failed${error ? `: ${String(error).slice(0, 300)}` : ''}. Start it again. ${this.whatNext()}`);
  }

  async subagentStart({ agent_id: agentId }) {
    if (!this.batch || this.batch.open <= 0 || !agentId) return {};
    const sha = await this.batch.ready.catch(() => null);
    const wt = sha && await this.git.findWorktree(this.cwd, agentId);
    if (wt) await this.git.prepare(wt.path, sha).catch(() => {});
    return {};
  }

  async subagentStop({ agent_id: agentId, last_assistant_message: text }) {
    const entry = Object.entries(this.run?.calls || {}).find(([, c]) => c.agentId && c.agentId === agentId);
    if (!entry) return {};
    // A background step: its answer is the sub-agent's last message (the
    // governor hears of it from Claude Code's task notification).
    await this.finish(entry[0], String(text || ''), { agentId });
    return {};
  }

  // A step's agent answered: save the answer, merge its worktree, read its
  // verdict and say what comes next.
  async finish(toolId, text, response = {}) {
    const call = this.run.calls[toolId];
    delete this.run.calls[toolId];
    const node = this.node(call.node);
    const s = this.step(node.id);
    s.finished++;
    let merge = '';
    if (call.isolate) {
      const wt = response.worktreePath ? { path: response.worktreePath, branch: response.worktreeBranch || '' } : await this.git.findWorktree(this.cwd, response.agentId);
      if (wt) {
        let keep = false;
        try {
          const label = `${node.label}${node.count > 1 ? ` ${s.finished}` : ''}`;
          const result = await this.git.mergeBack(this.cwd, wt.path, call.snapshot, label);
          merge = result.conflicts.length
            ? `Its changes were merged into the folder (${result.merged.length} file${result.merged.length === 1 ? '' : 's'}), with conflicts: ${result.conflicts.map(c => `${c.file} (${c.why})`).join('; ')}. Resolve them in the folder before the next step.`
            : `Its changes were merged into the folder: ${result.merged.length ? result.merged.join(', ') : 'it changed no file'}.`;
        } catch (err) {
          merge = `Merging its worktree (${wt.path}) back failed: ${String(err.message || err).slice(0, 300)}. Its changes are still there: bring them over by hand.`;
          keep = true;
        }
        if (!keep) await this.git.remove(this.cwd, wt.path, wt.branch).catch(() => {});
      }
      this.batch && (this.batch.open -= 1);
    }
    const file = this.outputFile(node, s.round);
    const header = node.count > 1 ? `## Agent ${s.finished} of ${node.count}\n\n` : '';
    fs.appendFileSync(file, `${s.finished > 1 ? '\n\n' : ''}${header}${text || '(No answer.)'}\n${merge ? `\n> ${merge}\n` : ''}`);
    if (!s.files.includes(file)) s.files.push(file);
    if (!s.answers || s.answersRound !== s.round) { s.answers = []; s.answersRound = s.round; }
    s.answers.push(text);
    const parts = [`${NOTE} ${this.label(node.id)}${node.count > 1 ? ` (agent ${s.finished} of ${node.count})` : ''} finished; its answer is saved in ${file}.`];
    if (merge) parts.push(merge);
    if (s.finished < node.count) {
      parts.push(s.started < node.count ? `It needs ${node.count - s.started} more agent${node.count - s.started === 1 ? '' : 's'}: ${this.whatNext()}` : 'Wait for its other agents.');
      this.save();
      return parts.join(' ');
    }
    s.status = 'done';
    if (node.verdict && node.kind !== 'ask') parts.push(this.judge(node, s, file));
    delete s.answers;
    this.advance();
    this.save();
    if (this.run.status === 'done') parts.push(this.finalNote());
    else parts.push(this.whatNext());
    return parts.join(' ');
  }

  outputFile(node, round) {
    return path.join(this.dir(), `${node.id}-${Pipeline.slug(node.label)}.r${round}.md`);
  }

  // A verdict step's verdict: approve, changes (back, or left for the user
  // after the last round), or none (asked once more).
  judge(node, s, file) {
    const verdicts = s.answers.map(a => Pipeline.parseVerdict(a));
    if (verdicts.some(v => !v)) {
      s.noVerdict++;
      if (s.noVerdict < 2) {
        Object.assign(s, { status: 'pending', started: 0, finished: 0 });
        fs.renameSync(file, file.replace(/\.md$/, `.no-verdict-${s.noVerdict}.md`));
        s.files = s.files.filter(f => f !== file);
        return `Its answer has no verdict block, so Agent Hub cannot tell whether the work is right. Run ${this.label(node.id)} again, and remind it to end with the verdict block.`;
      }
      s.verdict = 'none';
      this.run.issues.push({ step: node.id, round: s.round, problem: `${node.label} gave no verdict twice; its answer is in ${file}.` });
      return 'It again gave no verdict: Agent Hub goes on, and the final message must say the work was not judged.';
    }
    const blocking = verdicts.flatMap(v => v.blocking);
    const verdict = verdicts.some(v => v.verdict === 'changes') ? 'changes' : 'approve';
    s.verdict = verdict;
    try { fs.writeFileSync(file.replace(/\.md$/, '.verdict.json'), JSON.stringify({ verdict, blocking, minor: verdicts.flatMap(v => v.minor) }, null, 2)); } catch { /* the .md has it */ }
    if (verdict === 'approve') return 'Verdict: approve.';
    const count = blocking.length ? `${blocking.length} blocking problem${blocking.length === 1 ? '' : 's'}` : 'changes';
    if (!node.back.length) return `Verdict: changes (${count}). It has no ✕ connection: fix the blocking problems yourself, or with the step that fits, then go on.`;
    const used = this.run.rounds[node.id] || 0;
    if (used >= node.rounds) {
      for (const b of blocking.length ? blocking : [{ problem: `See ${file}.` }]) this.run.issues.push({ step: node.id, round: s.round, ...b });
      return `Verdict: changes (${count}), but the work already went back ${used} time${used === 1 ? '' : 's'}, the most this step allows: go on, and list the problems left for the user in your final message.`;
    }
    this.run.sendBack = { from: node.id, targets: [...node.back], optional: false, file };
    return `Verdict: changes (${count}): the work goes back (round ${used + 2} of at most ${node.rounds + 1}). Agent Hub gives the step its findings.`;
  }

  // An Ask-the-user step got its answer: go on, or (when the user wants a
  // change) back along its ✕ connection.
  askAnswered(id, text) {
    const node = this.node(id);
    const s = this.step(id);
    const file = this.outputFile(node, s.round);
    fs.writeFileSync(file, text);
    if (!s.files.includes(file)) s.files.push(file);
    s.status = 'done';
    s.finished = 1;
    this.run.askPending = false;
    const used = this.run.rounds[id] || 0;
    if (node.back.length && used < node.rounds) this.run.sendBack = { from: id, targets: [...node.back], optional: true, file };
    else if (node.back.length) this.run.issues.push({ step: id, round: s.round, problem: 'The user was asked the most times this step allows; anything they still wanted changed is left open.' });
    this.advance();
    this.save();
    const after = node.outputs.filter(o => o !== DONE).map(o => this.label(o));
    const back = this.run.sendBack?.from === id ? this.run.sendBack.targets.map(t => this.label(t)) : [];
    return [`${NOTE} the user answered ${this.label(id)} (saved in ${file}).`,
      back.length ? `If they approved, go on${after.length ? ` to ${after.join(' and ')}` : ''}; if they want something changed, send the work back to ${back.join(' or ')} with what they said.` : '',
      this.run.status === 'done' ? this.finalNote() : this.whatNext()].filter(Boolean).join(' ');
  }

  finalNote() {
    const issues = this.run.issues;
    return `Every step is done${issues.length ? `, with ${issues.length} problem${issues.length === 1 ? '' : 's'} left open: ${issues.map(i => `${i.file ? `${i.file}${i.line ? `:${i.line}` : ''}: ` : ''}${i.problem}`).join('; ')}` : ''}. The run's files are in ${this.dir()}. Write your final message: what was done, what the reviews said, what is left open.`;
  }

  async dropWorktree(call) {
    if (!call.isolate) return;
    this.batch && (this.batch.open -= 1);
  }

  // Your message: the answer to an Ask-the-user step the governor asked in
  // its own words, or what to do next. While a run is not done, the
  // governor is told where it stands.
  prompt({ prompt }) {
    this.lastPrompt = String(prompt || '');
    this.blockedStop = false;
    this.promptSinceStep = true;
    if (!this.active()) return {};
    const waiting = this.run.plan.nodes.find(n => n.kind === 'ask' && this.step(n.id).status === 'waiting');
    if (waiting && !this.run.askPending) return context(this.askAnswered(waiting.id, `## The user's answer\n\n${this.lastPrompt}\n`), 'UserPromptSubmit');
    if (this.run.status === 'paused') {
      this.run.status = 'running';
      this.save();
    }
    const done = this.run.plan.nodes.filter(n => FINISHED.has(this.step(n.id).status)).map(n => n.id);
    return context(`${NOTE} a run of the ${this.run.profileName || 'pipeline'} pipeline is not done${done.length ? ` (done: ${done.map(id => this.label(id)).join(', ')})` : ''}; its files are in ${this.dir()}. If this message is about it, go on: ${this.whatNext()} If it is a new task, start the pipeline's first step: that starts a new run.`, 'UserPromptSubmit');
  }

  // The governor wants to end its turn: once per turn it is told what is
  // left; stopping again pauses the run. An Ask-the-user step asked in
  // words (no question card) waits for your next message.
  stop({ stop_hook_active: again }) {
    if (!this.active()) return {};
    const open = this.next();
    const ask = open.map(id => this.node(id)).find(n => n?.kind === 'ask' && this.step(n.id).status === 'pending');
    if (ask) {
      this.step(ask.id).status = 'waiting';
      this.run.askPending = false;
      this.save();
      return {};
    }
    if (this.run.plan.nodes.some(n => this.step(n.id).status === 'waiting') || !open.length) return {};
    if (again || this.blockedStop) {
      this.run.status = 'paused';
      this.save();
      return {};
    }
    this.blockedStop = true;
    return { decision: 'block', reason: `${NOTE} the pipeline is not done. ${this.whatNext(open)} Run it now. If you must stop first (to ask the user something a step needs), stop again: the run pauses here and goes on later.` };
  }

  // The governor's turn ended (an answer, an error or Esc): a step whose
  // answer never came starts again in the next turn.
  turnEnded() {
    this.blockedStop = false;
    if (!this.run) return;
    let changed = false;
    for (const [id, call] of Object.entries(this.run.calls)) {
      if (call.ask || call.agentId) continue;
      delete this.run.calls[id];
      const s = this.step(call.node);
      s.started = Math.max(s.finished, s.started - 1);
      if (s.started <= s.finished && s.status === 'running') s.status = 'pending';
      if (call.isolate) this.batch && (this.batch.open -= 1);
      changed = true;
    }
    if (this.run.status === 'running' && !this.runningIds().length && this.next().length) {
      this.run.status = 'paused';
      changed = true;
    }
    if (changed) this.save();
  }

  // ---------- for the window ----------

  // { runId, profileId, profileName, status, folder, issues, steps: { id: {
  // status, round, count, active, verdict } } }; the panel's own statuses:
  // pending, running, waiting, done, changes (it sent the work back), notrun
  // (passed over), failed.
  snapshot() {
    const r = this.run;
    if (!r) return { status: 'idle', steps: {} };
    const steps = {};
    for (const n of r.plan.nodes) {
      const s = r.steps[n.id];
      const sentBack = s.status === 'done' && s.verdict === 'changes' && (r.sendBack?.from === n.id);
      const asked = r.sendBack?.from === n.id && r.sendBack.optional;
      steps[n.id] = {
        status: sentBack ? 'changes' : s.status === 'skipped' ? 'notrun' : s.status,
        round: s.round, count: n.count, active: Math.max(0, s.started - s.finished), verdict: s.verdict, asked,
      };
    }
    return { runId: r.id, profileId: r.profileId, profileName: r.profileName, status: r.status, folder: this.dir(), issues: r.issues.length, steps };
  }
}

const deny = reason => ({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } });
const allow = updatedInput => ({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', updatedInput } });
const context = (text, event = 'PostToolUse') => (text ? { hookSpecificOutput: { hookEventName: event, additionalContext: text } } : {});

// A session's last run, read only (a saved session in History).
function savedSnapshot(runsDir, sessionId) {
  const store = new RunStore(runsDir);
  const state = store.load(store.runFor(sessionId));
  if (!state?.plan) return null;
  const engine = new PipelineEngine({ runsDir, cwd: '', currentPlan: () => state.plan });
  engine.run = state;
  return engine.snapshot();
}

module.exports = { PipelineEngine, RunStore, answerText, savedSnapshot };
