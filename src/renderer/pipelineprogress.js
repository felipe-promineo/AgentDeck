// Where a pipeline agent is: a small graph of its profile's steps beside the
// chat (pipeline.js steps), each one marked as it goes: pending, running,
// done, sent back (its verdict was "changes"), failed, waiting for you (Ask the
// user) and not run (the governor skipped it, or the run stopped before it:
// red when an error stopped it).
//
// What happens comes from the run Agent Hub holds (pipelinerun.js): each
// change of it arrives as a snapshot (setState), so the panel shows exactly
// where the run is, rounds and all. A session from before that, with no
// saved run, is read from the governor's own tool calls, as the chat sees
// them (Transcript calls the methods below): starting a sub-agent with the
// Agent tool (its subagent_type names the step), its result, a question to
// you (AskUserQuestion) and the end of each turn. A sub-agent's own tool
// calls do not count.
//
// It sits in the chat's right margin, or the left one when the right one is
// taken; without room beside the chat it folds into a chip at the bottom
// left of the chat, which opens the graph on a click.

const PP_STATUS = {
  pending: ['○', 'Not started yet'],
  running: ['', 'Running'],
  waiting: ['✋', 'Waiting for your answer'],
  done: ['✓', 'Done'],
  changes: ['↺', 'Sent the work back: its verdict was changes'],
  failed: ['✕', 'Failed'],
  notrun: ['–', 'Not run: it had nothing to run, or the governor went on without it'],
  blocked: ['⊘', 'Not run: an error stopped the pipeline before it'],
};
const PP_SIDE_W = 240;     // the side panel's widest
const PP_SIDE_MIN = 170;   // narrower than this, it folds into the chip

class PipelineProgress {
  constructor(container, root, plan) {
    this.scroller = container;
    this.root = root;
    this.plan = plan;
    this.steps = [...plan.stages.flat(), ...plan.onDemand].map(s => ({ ...s, status: 'pending', round: 1, open: new Set() }));
    this.byId = new Map(this.steps.map(s => [s.id, s]));
    this.calls = new Map();       // tool_use id → { step, background }
    this.turnFresh = true;        // no step started yet in this turn
    this.ranInTurn = false;
    this.failedInTurn = false;

    this.wrap = el('div', 'pp-wrap');
    this.panel = el('div', 'pp-panel');
    this.head = el('button', 'pp-head');
    this.head.type = 'button';
    this.title = el('span', 'pp-title', `⛓ ${plan.profileName || 'Pipeline'}`);
    this.status = el('span', 'pp-status');
    this.head.append(this.title, this.status);
    this.head.onclick = () => {
      if (!this.panel.classList.contains('compact')) return;
      this.panel.classList.toggle('open');
      this.place();
    };
    this.body = el('div', 'pp-body');
    this.nodes = new Map();       // step id → element
    const row = list => {
      const r = el('div', 'pp-stage');
      for (const s of list) {
        const node = el('div', 'pp-node');
        node.append(el('span', 'pp-mark'), el('span', 'pp-label', s.label), el('span', 'pp-round'));
        this.nodes.set(s.id, node);
        r.appendChild(node);
      }
      return r;
    };
    plan.stages.forEach((stage, i) => {
      if (i) this.body.appendChild(el('div', 'pp-link'));
      this.body.appendChild(row(stage));
    });
    if (plan.onDemand.length) this.body.append(el('div', 'pp-section', 'Only when work is sent back'), row(plan.onDemand));
    this.panel.append(this.head, this.body);
    this.wrap.appendChild(this.panel);
    container.insertBefore(this.wrap, root);

    let frame = 0;
    const later = () => { if (!frame) frame = requestAnimationFrame(() => { frame = 0; this.place(); }); };
    new ResizeObserver(later).observe(container);
    new ResizeObserver(later).observe(root);
    window.addEventListener('resize', later);
    container.addEventListener('scroll', later, { passive: true });
    this.render();
  }

  // ---------- the run, as Agent Hub holds it ----------

  // snap: PipelineEngine.snapshot(). From the first one on, the governor's
  // tool calls are no longer read.
  setState(snap) {
    if (!snap?.steps || !Object.keys(snap.steps).length) return;
    this.engine = snap;
    for (const s of this.steps) {
      const x = snap.steps[s.id];
      if (!x) continue;
      s.status = PP_STATUS[x.status] ? x.status : 'pending';
      s.round = x.round || 1;
      s.active = x.active || 0;
      if (s.status === 'changes') this.last = s.id;
    }
    this.render();
  }

  // ---------- what the governor does (sessions without a saved run) ----------

  turnStart() {
    if (this.engine) return;
    this.turnFresh = true;
    this.ranInTurn = false;
    this.failedInTurn = false;
  }

  // A tool call of the governor's (not of a sub-agent).
  toolStart(block) {
    if (this.engine) return;
    const input = block.input || {};
    if ((block.name === 'Agent' || block.name === 'Task') && typeof input.subagent_type === 'string') {
      this.stepStart(s => s.agent === input.subagent_type, block.id, !!input.run_in_background);
    } else if (block.name === 'AskUserQuestion') {
      this.stepStart(s => s.kind === 'ask', block.id, false, 'waiting');
    }
  }

  stepStart(matches, toolId, background, status = 'running') {
    const candidates = this.steps.filter(matches);
    if (!candidates.length) return;
    const ready = s => s.inputs.every(id => id === Pipeline.TASK || ['done', 'changes', 'notrun'].includes(this.byId.get(id)?.status));
    const waiting = s => ['pending', 'notrun', 'blocked'].includes(s.status);
    let step;
    if (this.turnFresh) {
      this.turnFresh = false;
      // The run goes on (after your answer, or a background step): this
      // step and the ones after it are pending again (the ones it skipped
      // before stay skipped). Otherwise this is a new task: everything
      // starts over.
      step = candidates.find(s => waiting(s) && ready(s));
      if (step) {
        for (const s of this.downstream(step.id)) if (s.status === 'notrun' || s.status === 'blocked') s.status = 'pending';
      } else if (!candidates.some(s => s.status === 'running' || s.status === 'waiting')) {
        for (const s of this.steps) Object.assign(s, { status: 'pending', round: 1, open: new Set() });
        this.calls.clear();
        step = candidates[0];
      }
    }
    // Another of several at once, or the next one waiting, or one run again
    // because a step sent the work back to it.
    step = step
      || candidates.find(s => s.status === status && s.open.size < s.count)
      || candidates.find(s => waiting(s))
      || candidates[0];
    if (['done', 'changes', 'failed'].includes(step.status)) {
      step.round++;
      // What comes after it runs again too.
      for (const s of this.downstream(step.id)) if (s.status !== 'running') s.status = 'pending';
    }
    step.status = status;
    this.last = step.id;
    step.open.add(toolId);
    this.calls.set(toolId, { step: step.id, background });
    this.ranInTurn = true;
    this.render();
  }

  // The result of one of the governor's tool calls.
  toolDone(toolId, isError, text) {
    if (this.engine) return;
    const call = this.calls.get(toolId);
    if (!call) return;
    const step = this.byId.get(call.step);
    // A background sub-agent answers at once that it started; its end comes
    // as a task notification (taskNotification).
    if (call.background && !isError) return;
    this.finishCall(toolId, step, isError, text);
  }

  finishCall(toolId, step, isError, text) {
    this.calls.delete(toolId);
    step.open.delete(toolId);
    if (isError) {
      step.status = 'failed';
      this.failedInTurn = true;
    } else if (!step.open.size && step.status !== 'failed') {
      step.status = step.verdict && step.kind !== 'ask' && /VERDICT:\s*CHANGES/i.test(text || '') ? 'changes' : 'done';
    }
    this.render();
  }

  // A background task finished: the background step it names (or the only
  // one running) is done.
  taskNotification(text) {
    if (this.engine) return;
    const background = [...this.calls].filter(([, c]) => c.background);
    if (!background.length) return;
    const named = background.find(([id]) => text.includes(id)) || (background.length === 1 ? background[0] : null);
    if (!named) return;
    const failed = /<status>\s*(failed|error|killed)/i.test(text);
    this.finishCall(named[0], this.byId.get(named[1].step), failed, text);
  }

  // The governor's turn ended: a step still running was stopped, and the
  // ones it did not reach are not run (blocked, when an error stopped it).
  // A background step still running carries on.
  turnEnd(isError) {
    if (this.engine || !this.ranInTurn) return;
    if ([...this.calls.values()].some(c => c.background)) return this.render();
    for (const s of this.steps) {
      if (s.status === 'running' || s.status === 'waiting') {
        s.status = isError || s.status === 'running' ? 'failed' : 'notrun';
        s.open.clear();
        if (s.status === 'failed') this.failedInTurn = true;
      }
    }
    this.calls.clear();
    const stopped = isError || this.failedInTurn;
    for (const s of this.steps) {
      if (s.status === 'pending' && !this.plan.onDemand.some(d => d.id === s.id)) s.status = stopped ? 'blocked' : 'notrun';
    }
    this.render();
  }

  // The steps that take this one's work, directly or through others.
  downstream(id) {
    const out = [];
    const seen = new Set([id]);
    const stack = [id];
    while (stack.length) {
      const at = stack.pop();
      for (const s of this.steps) {
        if (!seen.has(s.id) && s.inputs.includes(at)) { seen.add(s.id); out.push(s); stack.push(s.id); }
      }
    }
    return out;
  }

  // ---------- drawing ----------

  render() {
    for (const s of this.steps) {
      const node = this.nodes.get(s.id);
      const [mark, what] = PP_STATUS[s.status];
      node.className = `pp-node pp-${s.status}`;
      node.querySelector('.pp-mark').textContent = mark;
      const many = this.engine ? s.active : s.open.size;
      node.querySelector('.pp-round').textContent = s.round > 1 ? `round ${s.round}` : s.count > 1 && many > 1 ? `×${many}` : '';
      node.title = `${s.label}: ${what}${s.round > 1 ? ` (round ${s.round})` : ''}`;
    }
    const main = this.steps.filter(s => !this.plan.onDemand.some(d => d.id === s.id));
    const finished = main.filter(s => ['done', 'changes', 'notrun'].includes(s.status)).length;
    const now = this.steps.filter(s => s.status === 'running' || s.status === 'waiting');
    const failed = this.steps.some(s => s.status === 'failed' || s.status === 'blocked');
    const skipped = main.filter(s => s.status === 'notrun').length;
    const of = `${finished}/${main.length}`;
    const run = this.engine;
    const issues = run?.issues ? ` · ${run.issues} open` : '';
    this.status.textContent = run && !now.length && run.status === 'done' ? `Done${skipped ? ` · ${skipped} not run` : ''}${issues}`
      : run && !now.length && run.status === 'paused' && this.byId.get(this.last)?.status !== 'changes' ? `${of} · paused`
        : now.length ? `${finished + 1}/${main.length} · ${now.map(s => s.label).join(' + ')}`
      : failed ? `${of} · stopped`
        // The last step to answer sent the work back: the governor goes back.
        : this.byId.get(this.last)?.status === 'changes' ? `${of} · sent back`
          : finished === main.length ? `Done${skipped ? ` · ${skipped} skipped` : ''}`
            : finished ? of : 'Not started';
    this.panel.title = run ? `The run's files: ${run.folder}` : '';
    this.panel.classList.toggle('busy', !!now.length);
    this.panel.classList.toggle('stopped', !now.length && failed);
    this.place();
  }

  // In the right margin, or the left one when something lies under it on
  // the right (a wide diagram, the review peer's panel); a chip at the
  // bottom left when neither margin has room. The chip opens the graph.
  place() {
    const p = this.panel;
    if (!this.scroller.offsetParent) return;
    const area = this.scroller.getBoundingClientRect();
    const msgs = this.root.getBoundingClientRect();
    const right = area.right - msgs.right - 28;
    const left = msgs.left - area.left - 28;
    const set = (side, width) => {
      p.classList.remove('compact', 'side-left', 'side-right');
      p.classList.add(`side-${side}`);
      p.style.width = `${width}px`;
      // On the left it goes under the "You asked" card, which sits there.
      const pin = side === 'left' ? this.scroller.querySelector('.prompt-pin.show .prompt-pin-bar') : null;
      const r = pin?.getBoundingClientRect();
      p.style.top = r?.width && r.left < area.left + width + 40 ? `${r.bottom - area.top + 12}px` : '';
    };
    p.classList.remove('faded');
    if (right >= PP_SIDE_MIN) {
      set('right', Math.min(PP_SIDE_W, right));
      if (this.covers() && left >= PP_SIDE_MIN) set('left', Math.min(PP_SIDE_W, left));
      // Over something wide on both sides: see-through until pointed at.
      if (this.covers()) p.classList.add('faded');
      return;
    }
    p.classList.remove('side-left', 'side-right');
    p.classList.add('compact');
    p.style.top = '';
    p.style.width = p.classList.contains('open') ? `${Math.min(PP_SIDE_W + 20, area.width - 36)}px` : '';
  }

  // Whether chat content lies under the panel (the messages' own boxes
  // span the chat and do not count; see Transcript.pinCovers).
  covers() {
    const r = this.panel.getBoundingClientRect();
    if (!r.width || !r.height) return false;
    for (const x of [r.left + 4, r.left + r.width / 2, r.right - 4]) {
      for (const y of [r.top + 4, r.top + r.height / 2, r.bottom - 4]) {
        for (const node of document.elementsFromPoint(x, y)) {
          if (node === this.root || !this.root.contains(node)) continue;
          if (!node.querySelector('.msg-text, .msg-user')) return true;
        }
      }
    }
    return false;
  }
}

window.PipelineProgress = PipelineProgress;
