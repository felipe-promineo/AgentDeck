// The multi-agent pipeline (Settings → Multi-agent, and the ⛓ Pipeline
// button under the message box).
//
// A pipeline agent is one ordinary Claude Code agent, the governor, started
// with extra sub-agents (Claude Code's --agents flag) and a system prompt that
// tells it to run the graph from Settings: it hands each step to that step's
// sub-agent (several at once when a node runs more than one), recaps what came
// back, fixes gaps along the way and passes the result on. A node that gives a
// verdict (the Code reviewer, the Tester) can send the work back to an earlier
// step when it is not right, up to a number of rounds; an "Ask the user" node
// stops the governor to show the user where things stand and wait for an
// answer or an approval. Everything stays in one chat, one session.
//
// This file is loaded by the main process (require) and by the window (a
// <script>, as window.Pipeline), so the Settings editor warns about the same
// problems the governor would run into.

(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Pipeline = api;
}(typeof self !== 'undefined' ? self : this, () => {
  // Which tools a sub-agent gets. "all": every tool of the governor.
  const TOOL_SETS = {
    all: null,
    readonly: ['Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch', 'TodoWrite'],
    readshell: ['Read', 'Grep', 'Glob', 'Bash', 'WebFetch', 'WebSearch', 'TodoWrite'],
  };
  const TOOL_NAMES = { all: 'All tools', readonly: 'Read only', readshell: 'Read + shell' };
  const MODELS = [['inherit', 'Same as the agent'], ['opus', 'Opus'], ['sonnet', 'Sonnet'], ['haiku', 'Haiku']];
  // A sub-agent's effort ('' : the same as the agent's).
  const EFFORTS = [['', 'Same as the agent'], ['low', 'Low'], ['medium', 'Medium'], ['high', 'High'], ['xhigh', 'Extra high'], ['max', 'Max']];

  // The agents the app comes with. Their prompts can be changed in Settings;
  // they cannot be deleted (Reset puts them back as they are here).
  const BUILTIN_TYPES = [
    {
      id: 'analyst',
      effort: 'medium',
      name: 'Requirements analyst',
      description: 'Turns the task into clear requirements, acceptance criteria and open questions.',
      model: 'inherit',
      tools: 'readonly',
      prompt: [
        'You are the requirements analyst of a multi-agent pipeline. Read the task and the parts of the code base it touches.',
        'Do not change any file.',
        'Answer with: 1) the goal in one or two sentences, 2) the requirements as a numbered list, each one testable,',
        '3) acceptance criteria, 4) what is out of scope, 5) assumptions you made and open questions,',
        '6) the files, types and systems involved, with paths.',
        'Be concrete and short; the next agents only see what you write.',
      ].join(' '),
    },
    {
      id: 'planner',
      effort: 'high',
      name: 'Planner',
      description: 'Writes a step-by-step implementation plan from the requirements.',
      model: 'inherit',
      tools: 'readonly',
      prompt: [
        'You are the planner of a multi-agent pipeline. From the task and the requirements you are given, write an implementation plan.',
        'Do not change any file. Read the code you need to make the plan precise.',
        'Answer with: the approach and why, the changes file by file (path, what changes, new types or functions),',
        'the order to make them in, how to test each one, and the risks.',
        'When the work can be split between several implementers, split it into parts that touch different files and say which part is which.',
      ].join(' '),
    },
    {
      id: 'implementer',
      effort: '',
      name: 'Implementer',
      description: 'Makes the code changes the plan describes.',
      model: 'inherit',
      tools: 'all',
      prompt: [
        'You are an implementer in a multi-agent pipeline. Make the changes the plan gives you, and only those:',
        'when you are given one part of the plan, stay inside that part and its files, because other implementers work on the other parts at the same time.',
        'Follow the conventions of the code around you. Build or run the tests when the project has them.',
        'Answer with what you changed (files and what each change does), what you checked and how, and anything you could not do or that differs from the plan.',
      ].join(' '),
    },
    {
      id: 'tester',
      verdict: true,
      effort: 'medium',
      name: 'Tester',
      description: 'Writes and runs tests for the change, and reports what fails.',
      model: 'inherit',
      tools: 'all',
      prompt: [
        'You are the tester of a multi-agent pipeline. Check that the change does what the requirements say:',
        'run the existing tests and the build, add tests for the new behaviour where the project has tests, and try the edge cases.',
        'Do not fix the code under test; report instead. Answer with what passed, what failed (with the output), and what you could not test.',
      ].join(' '),
    },
    {
      id: 'reviewer',
      verdict: true,
      effort: 'high',
      name: 'Code reviewer',
      description: 'Reviews the result against the requirements and the plan, and lists what must change.',
      model: 'inherit',
      tools: 'readshell',
      prompt: [
        'You are the reviewer of a multi-agent pipeline. Review the changes (git diff or svn diff, and the files) against the task, the requirements and the plan.',
        'Do not change any file. Look for bugs, missing requirements, broken edge cases, needless complexity and code that does not fit the project.',
        'Start your answer with exactly one line: "VERDICT: APPROVE" when nothing must change, or "VERDICT: CHANGES" when something must.',
        'Then list each problem with its file and line, why it is a problem, and what to do. Mark each one as blocking or minor.',
      ].join(' '),
    },
    // Not a sub-agent: the governor itself stops here and asks you.
    {
      id: 'ask-user',
      kind: 'ask',
      verdict: true,
      effort: '',
      name: 'Ask the user',
      description: 'Stops the pipeline, shows you where things stand and waits for your answer or approval.',
      model: 'inherit',
      tools: 'readonly',
      prompt: [
        'Stop the pipeline here and ask the user. First show them, short and concrete, what the pipeline has achieved so far, fitted to the steps before this one:',
        'after understanding the task or the requirements, your understanding, the requirements, the assumptions you made and the open questions or problems they need to settle;',
        'after a plan, the plan and its risks; after an implementation, the changes (each file and what changed, how it was checked) and ask for their approval;',
        'after a review or tests, what they found.',
        'Write that summary as your message, then ask with the AskUserQuestion tool: one clear question with two to four options (for example "Approve, go on" and "Change something"; the user can always type their own answer).',
        'Agent Hub shows it as a question card and tells the user you need them. If you do not have that tool, end your turn with the question instead.',
        'Do nothing else until the user replies.',
      ].join(' '),
    },
  ];

  // The graph the app starts with: understand → plan → implement → review,
  // and the reviewer sends the work back to the implementer when it is not right.
  function defaults() {
    return {
      enabled: false,
      types: BUILTIN_TYPES.map(t => ({ kind: 'agent', verdict: false, ...t, builtin: true })),
      nodes: [
        { id: 'n1', type: 'analyst', count: 1, x: 200, y: 110, rounds: 3, note: '' },
        { id: 'n2', type: 'planner', count: 1, x: 430, y: 110, rounds: 3, note: '' },
        { id: 'n3', type: 'implementer', count: 1, x: 660, y: 110, rounds: 3, note: '' },
        { id: 'n4', type: 'reviewer', count: 1, x: 890, y: 110, rounds: 3, note: '' },
      ],
      edges: [
        { from: 'task', to: 'n1' },
        { from: 'n1', to: 'n2' },
        { from: 'n2', to: 'n3' },
        { from: 'n3', to: 'n4' },
        { from: 'n4', to: 'done' },
        { from: 'n4', to: 'n3', kind: 'fail' },
      ],
    };
  }

  // The two fixed ends of the graph: your message goes out of "task", and
  // what reaches "done" is the result.
  const TASK = 'task';
  const DONE = 'done';

  const slug = text => String(text || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'agent';
  const isFail = e => e.kind === 'fail';

  // A saved setting that is missing parts (an older version, edited by hand)
  // gets them from the defaults; built-in types it does not have come back.
  function normalize(saved) {
    const d = defaults();
    const s = saved && typeof saved === 'object' ? saved : {};
    const types = Array.isArray(s.types) ? s.types.filter(t => t && t.id).map(t => {
      const builtin = BUILTIN_TYPES.find(b => b.id === slug(t.id));
      const kind = builtin ? builtin.kind || 'agent' : t.kind === 'ask' ? 'ask' : 'agent';
      return {
        id: slug(t.id), name: String(t.name || t.id), description: String(t.description || ''), prompt: String(t.prompt || ''),
        model: MODELS.some(([v]) => v === t.model) ? t.model : 'inherit', tools: t.tools in TOOL_SETS ? t.tools : 'all',
        effort: EFFORTS.some(([v]) => v === t.effort) ? t.effort : '',
        kind,
        // Whether it can send the work back (a "not right" output).
        verdict: kind === 'ask' || (builtin ? !!builtin.verdict : !!t.verdict),
        builtin: !!builtin,
      };
    }) : d.types;
    for (const b of d.types) if (!types.some(t => t.id === b.id)) types.push(b);
    const typeOf = id => types.find(t => t.id === id);
    let nodes = Array.isArray(s.nodes) ? s.nodes.filter(n => n && n.id && n.id !== TASK && n.id !== DONE).map(n => ({
      id: String(n.id), type: String(n.type || ''), count: Math.max(1, Math.min(8, Math.round(Number(n.count) || 1))),
      x: Number(n.x) || 0, y: Number(n.y) || 0, note: String(n.note || ''),
      rounds: Math.max(1, Math.min(10, Math.round(Number(n.rounds) || 3))),
    })) : d.nodes;
    // One "Ask the user" is the governor itself: it never runs twice at once.
    for (const n of nodes) if (typeOf(n.type)?.kind === 'ask') n.count = 1;
    let rawEdges = Array.isArray(s.edges) ? s.edges : d.edges;
    // The first version had a reviewer box around the graph (loop): it
    // becomes a reviewer node before Done that sends the work back.
    if (s.loop && typeof s.loop === 'object' && Array.isArray(s.nodes)) {
      if (s.loop.enabled !== false && typeOf(s.loop.reviewer)) {
        const taken = new Set(nodes.map(n => n.id));
        let i = 1;
        while (taken.has(`n${i}`)) i++;
        const id = `n${i}`;
        const right = nodes.reduce((m, n) => (n.x > m.x ? n : m), { x: 0, y: 110 });
        nodes = [...nodes, { id, type: s.loop.reviewer, count: Math.max(1, Math.min(8, Number(s.loop.count) || 1)), x: right.x + 230, y: right.y, note: '', rounds: Math.max(1, Math.min(10, Number(s.loop.maxRounds) || 3)) }];
        rawEdges = [
          ...rawEdges.map(e => (e?.to === DONE ? { ...e, to: id } : e)),
          { from: id, to: DONE },
          ...(s.loop.backTo ? [{ from: id, to: s.loop.backTo, kind: 'fail' }] : []),
        ];
      }
    }
    const ids = new Set([TASK, DONE, ...nodes.map(n => n.id)]);
    const seen = new Set();
    const edges = rawEdges.filter(e => {
      if (!e) return false;
      const fail = e.kind === 'fail';
      const key = `${e.from}>${e.to}${fail ? '!' : ''}`;
      if (!ids.has(e.from) || !ids.has(e.to) || e.from === e.to || e.from === DONE || e.to === TASK || seen.has(key)) return false;
      // Only a node that gives a verdict has a "not right" output, and it goes back to a step.
      if (fail && (e.to === DONE || !typeOf(nodes.find(n => n.id === e.from)?.type)?.verdict)) return false;
      seen.add(key);
      return true;
    }).map(e => (e.kind === 'fail' ? { from: e.from, to: e.to, kind: 'fail' } : { from: e.from, to: e.to }));
    return { enabled: !!s.enabled, types, nodes, edges };
  }

  // Problems with the graph, each { level: 'error' | 'warning' | 'info', node?, text }.
  // Errors stop the pipeline from making sense (the governor is told to work
  // around them); warnings are things that are probably a mistake.
  function validate(cfg) {
    const c = normalize(cfg);
    const out = [];
    const typeOf = id => c.types.find(t => t.id === id);
    const label = n => `${typeOf(n.type)?.name || n.type || 'A node'}${c.nodes.filter(m => m.type === n.type).length > 1 ? ` (${n.id})` : ''}`;
    const into = id => c.edges.filter(e => e.to === id);
    const outOf = id => c.edges.filter(e => e.from === id && !isFail(e));
    const failOf = id => c.edges.filter(e => e.from === id && isFail(e));

    if (!c.nodes.length) out.push({ level: 'error', text: 'The graph has no agents. Add one with + Agent.' });
    for (const n of c.nodes) {
      if (!typeOf(n.type)) out.push({ level: 'error', node: n.id, text: `A node uses the agent type "${n.type}", which no longer exists. Pick another type for it.` });
      if (!into(n.id).length) out.push({ level: 'warning', node: n.id, text: `${label(n)} has no input: nothing is connected to its left side, so it never runs.` });
      if (!outOf(n.id).length) out.push({ level: 'warning', node: n.id, text: `${label(n)}'s output is not used: connect its right side to another agent or to Done.` });
    }
    if (!outOf(TASK).length) out.push({ level: 'error', node: TASK, text: 'Your task is not connected to any agent.' });
    if (!into(DONE).length) out.push({ level: 'error', node: DONE, text: 'Nothing is connected to Done, so the pipeline has no result.' });
    if (c.edges.some(e => e.from === TASK && e.to === DONE)) out.push({ level: 'warning', node: TASK, text: 'Your task goes straight to Done, skipping the agents.' });

    // Reachable from the task (sending back counts), and leading to Done.
    const walk = (start, next) => {
      const seen = new Set([start]);
      const stack = [start];
      while (stack.length) for (const id of next(stack.pop())) if (!seen.has(id)) { seen.add(id); stack.push(id); }
      return seen;
    };
    const fromTask = walk(TASK, id => c.edges.filter(e => e.from === id).map(e => e.to));
    const toDone = walk(DONE, id => into(id).filter(e => !isFail(e)).map(e => e.from));
    for (const n of c.nodes) {
      if (into(n.id).length && !fromTask.has(n.id)) out.push({ level: 'warning', node: n.id, text: `${label(n)} cannot be reached from Your task, so it never runs.` });
      if (outOf(n.id).length && !toDone.has(n.id)) out.push({ level: 'warning', node: n.id, text: `${label(n)}'s work never reaches Done.` });
    }

    // Going round again is what "not right" connections are for: a circle
    // of normal connections never ends.
    const cycle = findCycle(c);
    if (cycle) out.push({ level: 'error', node: cycle[0], text: `The connections make a circle (${cycle.map(id => label(c.nodes.find(n => n.id === id))).join(' → ')} → …). To go round again, connect a reviewer's ✕ "not right" output back instead.` });

    for (const n of c.nodes) {
      const t = typeOf(n.type);
      if (!t) continue;
      if (n.count > 1 && t.kind !== 'ask' && t.tools === 'all') out.push({ level: 'info', node: n.id, text: `${n.count} ${t.name} agents run at the same time and can change files: the governor gives each its own part of the work.` });
      if (t.verdict) {
        const back = failOf(n.id);
        if (!back.length && t.kind !== 'ask') out.push({ level: 'info', node: n.id, text: `${label(n)} has no ✕ "not right" connection: when it finds problems, the governor fixes them itself.` });
        // Back means upstream: a step that leads to this one.
        const upstream = walk(n.id, id => into(id).filter(e => !isFail(e)).map(e => e.from));
        for (const e of back) {
          if (!upstream.has(e.to)) out.push({ level: 'warning', node: n.id, text: `${label(n)}'s ✕ "not right" connection goes to ${label(c.nodes.find(m => m.id === e.to))}, which is not a step before it. Send it back to a step that leads to it.` });
        }
        if (back.length > 1) out.push({ level: 'warning', node: n.id, text: `${label(n)} has ${back.length} ✕ "not right" connections: the governor picks the one that fits the problems.` });
      }
    }
    return out;
  }

  // One circle of node ids over the normal connections, or null.
  function findCycle(c) {
    const state = new Map();
    const path = [];
    const visit = id => {
      state.set(id, 1);
      path.push(id);
      for (const e of c.edges.filter(x => x.from === id && x.to !== DONE && !isFail(x))) {
        if (state.get(e.to) === 1) return path.slice(path.indexOf(e.to));
        if (!state.has(e.to)) { const found = visit(e.to); if (found) return found; }
      }
      state.set(id, 2);
      path.pop();
      return null;
    };
    for (const n of c.nodes) if (!state.has(n.id)) { const found = visit(n.id); if (found) return found; }
    return null;
  }

  // The nodes in the order they can run (over the normal connections): each
  // stage only needs earlier ones. Nodes in a circle or never reached come
  // last, so nothing is lost; nodes that only "not right" connections reach
  // are `onDemand`.
  function stages(c) {
    const normalInto = id => c.edges.filter(e => e.to === id && !isFail(e));
    const onDemand = c.nodes.filter(n => !normalInto(n.id).length && c.edges.some(e => e.to === n.id && isFail(e))).map(n => n.id);
    const left = new Set(c.nodes.map(n => n.id).filter(id => !onDemand.includes(id)));
    const done = new Set([TASK]);
    const out = [];
    const at = id => c.nodes.find(n => n.id === id);
    while (left.size) {
      const ready = [...left].filter(id => normalInto(id).length && normalInto(id).every(e => done.has(e.from) || onDemand.includes(e.from)));
      if (!ready.length) break;
      ready.sort((a, b) => (at(a).x - at(b).x) || (at(a).y - at(b).y));
      out.push(ready);
      for (const id of ready) { left.delete(id); done.add(id); }
    }
    if (left.size) out.push([...left]);
    out.onDemand = onDemand;
    return out;
  }

  const subagentName = type => `pipeline-${slug(type.id)}`;
  const VERDICT_LINE = 'Start your answer with exactly one line: "VERDICT: APPROVE" when the work is right, or "VERDICT: CHANGES" when something must change, then say what must change and why.';

  // Claude Code's --agents value: one sub-agent per type the graph uses
  // ("Ask the user" is the governor itself, not a sub-agent).
  function subagents(cfg) {
    const c = normalize(cfg);
    const used = new Set(c.nodes.map(n => n.type));
    const out = {};
    for (const t of c.types) {
      if (!used.has(t.id) || t.kind === 'ask') continue;
      let prompt = t.prompt || `You are the ${t.name} of a multi-agent pipeline.`;
      if (t.verdict && !/VERDICT:/.test(prompt)) prompt += ' ' + VERDICT_LINE;
      const def = {
        description: `${t.description || t.name} Part of the multi-agent pipeline: run by the governor only, when the pipeline says so.`,
        prompt,
      };
      if (TOOL_SETS[t.tools]) def.tools = TOOL_SETS[t.tools];
      if (t.model && t.model !== 'inherit') def.model = t.model;
      if (t.effort) def.effort = t.effort;
      out[subagentName(t)] = def;
    }
    return out;
  }

  // The governor's instructions, appended to its system prompt.
  function governorPrompt(cfg) {
    const c = normalize(cfg);
    const typeOf = id => c.types.find(t => t.id === id);
    const nodeOf = id => c.nodes.find(x => x.id === id);
    const nodeName = id => (id === TASK ? 'the user\'s task' : id === DONE ? 'Done' : `step ${id} (${typeOf(nodeOf(id)?.type)?.name || '?'})`);
    const lines = [
      'You are the GOVERNOR of a multi-agent pipeline that the user set up in Agent Hub. For each task the user gives you, run the pipeline below:',
      'hand each agent step to its sub-agent with the Agent tool (also called Task), using exactly the subagent_type named for the step.',
      'You coordinate and do not do the steps\' work yourself, except for small fixes between steps.',
      '',
      'The pipeline:',
    ];
    const describe = id => {
      const node = nodeOf(id);
      const t = typeOf(node.type);
      if (!t) return `- ${nodeName(id)}: no agent type; skip it.`;
      const inputs = c.edges.filter(e => e.to === id && !isFail(e)).map(e => (e.from === TASK ? 'the user\'s task' : `the output of ${nodeName(e.from)}`));
      const outputs = c.edges.filter(e => e.from === id && !isFail(e)).map(e => nodeName(e.to));
      const back = c.edges.filter(e => e.from === id && isFail(e)).map(e => nodeName(e.to));
      const note = node.note ? ` Note from the user for this step: ${node.note}` : '';
      if (t.kind === 'ask') {
        return `- ${nodeName(id)}: ASK THE USER. This is not a sub-agent: you stop here yourself. ${t.prompt}${note}`
          + ` Input: ${inputs.join(' and ') || 'what the pipeline has so far'}.`
          + ` When the user answers or approves, take their answer into account and go on to ${outputs.join(' and ') || 'Done'}.`
          + ` When they reject it or ask for changes, ${back.length ? `go back to ${back.join(' or ')} with what they said, and run the pipeline again from there (up to ${node.rounds} times)` : 'make the changes they ask for with the step that fits, then ask them again'}.`;
      }
      let line = `- ${nodeName(id)}: subagent_type "${subagentName(t)}"${node.count > 1 ? `, ${node.count} agents at once (start them in one message, each with its own part or angle, then merge their outputs)` : ''}.`
        + ` Input: ${inputs.join(' and ') || 'only what a step sends back to it'}. Its output goes to ${outputs.join(' and ') || 'nothing'}.${note}`;
      if (t.verdict) {
        line += back.length
          ? ` It gives a verdict: on "VERDICT: APPROVE" go on to ${outputs.join(' and ') || 'Done'}; on "VERDICT: CHANGES" (blocking problems), send its findings back to ${back.join(' or ')} and run the pipeline again from there, through this step again.`
            + ` Do this at most ${node.rounds} time${node.rounds === 1 ? '' : 's'} for this step; when it is still not right after that, go on and list the problems that are left for the user.`
          : ' It gives a verdict: on "VERDICT: CHANGES", fix the blocking problems yourself (or with the step that fits), then go on.';
      }
      return line;
    };
    const order = stages(c);
    order.forEach((stage, i) => {
      lines.push(`Stage ${i + 1}${stage.length > 1 ? ' (these steps run at the same time: start them in one message)' : ''}:`);
      for (const id of stage) lines.push(describe(id));
    });
    if (order.onDemand.length) {
      lines.push('Only when a step sends work back to them:');
      for (const id of order.onDemand) lines.push(describe(id));
    }
    const finals = c.edges.filter(e => e.to === DONE).map(e => nodeName(e.from));
    lines.push(`The result of the pipeline is the output of ${finals.join(' and ') || 'the last step'}.`);
    lines.push('',
      'How to run it:',
      '- Each sub-agent starts with no memory of this conversation: give it the user\'s task word for word, plus everything it needs from earlier steps (the full outputs it takes as input, not just a summary), and the folder you work in.',
      '- After each step, write a short recap for the user, as one line that starts with "Milestone:" (for example "Milestone: 2 of 4, plan ready: 5 changes in 3 files").',
      '- Check every output before passing it on. When something is missing, wrong or contradicts an earlier step, fix it yourself if it is small, or send it back to the same sub-agent with what to change. When parallel agents disagree, decide and say why.',
      '- When work goes back to an earlier step, say so in a Milestone line with the round (for example "Milestone: review round 2 of 3, back to the implementer: 2 blocking problems").',
      '- When the task is only a question or a trivial change, you may skip agent steps that add nothing; say which ones you skipped. Never skip an "Ask the user" step.',
      '- If a sub-agent asks the user something, ask the user yourself and pass the answer on.',
      '- Your final message: what was done, what the reviews said, what is left open. Follow the rest of your instructions for it.',
    );
    return lines.join('\n');
  }

  // A short line for the chat: "Analyst → Planner → Implementer ×2 → Code reviewer (↺ Implementer, 3×)".
  function summary(cfg) {
    const c = normalize(cfg);
    const name = id => c.types.find(t => t.id === id)?.name || id;
    const step = id => {
      const node = c.nodes.find(x => x.id === id);
      const back = c.edges.filter(e => e.from === id && isFail(e)).map(e => name(c.nodes.find(x => x.id === e.to)?.type));
      return `${name(node.type)}${node.count > 1 ? ` ×${node.count}` : ''}${back.length ? ` (↺ ${back.join(', ')}, ${node.rounds}×)` : ''}`;
    };
    return stages(c).map(stage => stage.map(step).join(' + ')).join(' → ') || 'no steps';
  }

  // ---------- how big each request starts ----------
  //
  // Every request an agent makes re-sends its whole context: the system
  // prompt, the tool definitions, the instruction files (CLAUDE.md,
  // AGENTS.md, rules) and the conversation so far. The baseline is that
  // context before any work: what the first request carries, and the
  // smallest any later request can be.
  //
  // measured (from Agent Hub's main process, see measurePipeline in
  // agents.js) is what Claude Code itself reports for the governor in the
  // chosen folder: { governor: { total, categories, memoryFiles, mcp },
  // toolSets: { readonly, readshell, all } }. Without it the numbers are
  // rough defaults. Sub-agents cannot be measured on their own: theirs is
  // their instructions + their tools + the instruction files.
  const FALLBACK_TOOLS = { all: 20000, readonly: 3500, readshell: 6000 };
  const FALLBACK_GOVERNOR = 30000;
  const SUBAGENT_ENV = 500;       // the environment block Claude Code adds to a sub-agent's prompt
  const tokensOf = text => Math.ceil(String(text || '').length / 3.7);

  function estimate(cfg, measured = null) {
    const c = normalize(cfg);
    const m = measured && !measured.error ? measured : null;
    const memory = m ? (m.governor.memoryFiles || []).reduce((sum, f) => sum + (f.tokens || 0), 0) : 0;
    const mcp = m ? m.governor.mcp || 0 : 0;
    const tools = set => (m?.toolSets?.[set] != null ? m.toolSets[set] + (set === 'all' ? mcp : 0) : FALLBACK_TOOLS[set]);
    const perType = {};
    for (const t of c.types) {
      // Asking the user is a turn of the governor's own: no new agent.
      if (t.kind === 'ask') { perType[t.id] = { instructions: 0, tools: 0, memory: 0, total: 0 }; continue; }
      const parts = { instructions: SUBAGENT_ENV + tokensOf(t.prompt), tools: tools(t.tools), memory };
      perType[t.id] = { ...parts, total: parts.instructions + parts.tools + parts.memory };
    }
    const base = id => perType[id]?.total || 0;
    const cost = n => n.count * base(n.type);
    const governor = m ? m.governor.total : FALLBACK_GOVERNOR;
    const steps = c.nodes.reduce((sum, n) => sum + cost(n), 0);
    // Every "not right" connection that is used every time: the steps from
    // the one it goes back to up to the node that sends it back run again.
    const reach = (start, next) => {
      const seen = new Set();
      const stack = [start];
      while (stack.length) {
        const id = stack.pop();
        if (seen.has(id)) continue;
        seen.add(id);
        stack.push(...next(id));
      }
      return seen;
    };
    let again = 0;
    let rounds = 1;
    for (const e of c.edges.filter(isFail)) {
      const gate = c.nodes.find(n => n.id === e.from);
      const after = reach(e.to, id => c.edges.filter(x => x.from === id && !isFail(x)).map(x => x.to));
      const before = reach(gate.id, id => c.edges.filter(x => x.to === id && !isFail(x)).map(x => x.from));
      const loop = c.nodes.filter(n => after.has(n.id) && before.has(n.id)).reduce((sum, n) => sum + cost(n), 0);
      again += (gate.rounds - 1) * loop;
      rounds = Math.max(rounds, gate.rounds);
    }
    const agents = c.nodes.filter(n => c.types.find(t => t.id === n.type)?.kind !== 'ask').reduce((sum, n) => sum + n.count, 0);
    const asks = c.nodes.filter(n => c.types.find(t => t.id === n.type)?.kind === 'ask').length;
    const oneRound = governor + steps;
    return { measured: !!m, governor, memory, mcp, perType, steps, oneRound, worst: oneRound + again, rounds, agents, asks };
  }

  const formatTokens = n => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(n >= 1e4 ? 0 : 1)}k` : String(Math.round(n)));

  return { TASK, DONE, TOOL_SETS, TOOL_NAMES, MODELS, EFFORTS, BUILTIN_TYPES, estimate, formatTokens, tokensOf, defaults, normalize, validate, stages, subagents, governorPrompt, summary, slug, isFail };
}));
