// The multi-agent pipeline (Settings → Multi-agent, and the ⛓ Pipeline
// button under the message box).
//
// A pipeline agent is one ordinary Claude Code agent, the governor, started
// with extra sub-agents (Claude Code's --agents flag) and a system prompt that
// tells it to run the graph from Settings: it hands each step to that step's
// sub-agent (several at once when a node runs more than one), recaps what came
// back, fixes gaps along the way and passes the result on. The reviewer box
// around the graph checks the whole result and sends it back to a step, up to
// a number of rounds. Everything stays in one chat, one session.
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

  // The agents the app comes with. Their prompts can be changed in Settings;
  // they cannot be deleted (Reset puts them back as they are here).
  const BUILTIN_TYPES = [
    {
      id: 'analyst',
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
  ];

  // The graph the app starts with: understand → plan → implement → review,
  // in a reviewer loop that goes back to the implementer.
  function defaults() {
    return {
      enabled: false,
      types: BUILTIN_TYPES.map(t => ({ ...t, builtin: true })),
      nodes: [
        { id: 'n1', type: 'analyst', count: 1, x: 200, y: 110 },
        { id: 'n2', type: 'planner', count: 1, x: 430, y: 110 },
        { id: 'n3', type: 'implementer', count: 1, x: 660, y: 110 },
      ],
      edges: [
        { from: 'task', to: 'n1' },
        { from: 'n1', to: 'n2' },
        { from: 'n2', to: 'n3' },
        { from: 'n3', to: 'done' },
      ],
      loop: { enabled: true, reviewer: 'reviewer', count: 1, maxRounds: 3, backTo: 'n3' },
    };
  }

  // The two fixed ends of the graph: your message goes out of "task", and
  // what reaches "done" is the result.
  const TASK = 'task';
  const DONE = 'done';

  const slug = text => String(text || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'agent';

  // A saved setting that is missing parts (an older version, edited by hand)
  // gets them from the defaults; built-in types it does not have come back.
  function normalize(saved) {
    const d = defaults();
    const s = saved && typeof saved === 'object' ? saved : {};
    const types = Array.isArray(s.types) ? s.types.filter(t => t && t.id).map(t => ({
      id: slug(t.id), name: String(t.name || t.id), description: String(t.description || ''), prompt: String(t.prompt || ''),
      model: MODELS.some(([v]) => v === t.model) ? t.model : 'inherit', tools: t.tools in TOOL_SETS ? t.tools : 'all',
      builtin: BUILTIN_TYPES.some(b => b.id === t.id),
    })) : d.types;
    for (const b of d.types) if (!types.some(t => t.id === b.id)) types.push(b);
    const nodes = Array.isArray(s.nodes) ? s.nodes.filter(n => n && n.id && n.id !== TASK && n.id !== DONE).map(n => ({
      id: String(n.id), type: String(n.type || ''), count: Math.max(1, Math.min(8, Math.round(Number(n.count) || 1))),
      x: Number(n.x) || 0, y: Number(n.y) || 0, note: String(n.note || ''),
    })) : d.nodes;
    const ids = new Set([TASK, DONE, ...nodes.map(n => n.id)]);
    const seen = new Set();
    const edges = (Array.isArray(s.edges) ? s.edges : d.edges).filter(e => {
      const key = `${e?.from}>${e?.to}`;
      if (!e || !ids.has(e.from) || !ids.has(e.to) || e.from === e.to || e.from === DONE || e.to === TASK || seen.has(key)) return false;
      seen.add(key);
      return true;
    }).map(e => ({ from: e.from, to: e.to }));
    const l = s.loop && typeof s.loop === 'object' ? s.loop : d.loop;
    const loop = {
      enabled: l.enabled !== false,
      reviewer: String(l.reviewer || 'reviewer'),
      count: Math.max(1, Math.min(8, Math.round(Number(l.count) || 1))),
      maxRounds: Math.max(1, Math.min(10, Math.round(Number(l.maxRounds) || 3))),
      backTo: String(l.backTo || ''),
    };
    return { enabled: !!s.enabled, types, nodes, edges, loop };
  }

  // Problems with the graph, each { level: 'error' | 'warning', node?, text }.
  // Errors stop the pipeline from making sense (the governor is told to work
  // around them); warnings are things that are probably a mistake.
  function validate(cfg) {
    const c = normalize(cfg);
    const out = [];
    const typeOf = id => c.types.find(t => t.id === id);
    const label = n => `${typeOf(n.type)?.name || n.type || 'A node'}${c.nodes.filter(m => m.type === n.type).length > 1 ? ` (${n.id})` : ''}`;
    const into = id => c.edges.filter(e => e.to === id);
    const outOf = id => c.edges.filter(e => e.from === id);

    if (!c.nodes.length) out.push({ level: 'error', text: 'The graph has no agents. Add one with + Agent.' });
    for (const n of c.nodes) {
      if (!typeOf(n.type)) out.push({ level: 'error', node: n.id, text: `A node uses the agent type "${n.type}", which no longer exists. Pick another type for it.` });
      if (!into(n.id).length) out.push({ level: 'warning', node: n.id, text: `${label(n)} has no input: nothing is connected to its left side, so it never runs.` });
      if (!outOf(n.id).length) out.push({ level: 'warning', node: n.id, text: `${label(n)}'s output is not used: connect its right side to another agent or to Done.` });
    }
    if (!outOf(TASK).length) out.push({ level: 'error', node: TASK, text: 'Your task is not connected to any agent.' });
    if (!into(DONE).length) out.push({ level: 'error', node: DONE, text: 'Nothing is connected to Done, so the pipeline has no result.' });
    if (c.edges.some(e => e.from === TASK && e.to === DONE)) out.push({ level: 'warning', node: TASK, text: 'Your task goes straight to Done, skipping the agents.' });

    // Reachable from the task, and leading to Done.
    const walk = (start, next) => {
      const seen = new Set([start]);
      const stack = [start];
      while (stack.length) for (const id of next(stack.pop())) if (!seen.has(id)) { seen.add(id); stack.push(id); }
      return seen;
    };
    const fromTask = walk(TASK, id => outOf(id).map(e => e.to));
    const toDone = walk(DONE, id => into(id).map(e => e.from));
    for (const n of c.nodes) {
      if (into(n.id).length && !fromTask.has(n.id)) out.push({ level: 'warning', node: n.id, text: `${label(n)} cannot be reached from Your task, so it never runs.` });
      if (outOf(n.id).length && !toDone.has(n.id)) out.push({ level: 'warning', node: n.id, text: `${label(n)}'s work never reaches Done.` });
    }

    // Loops belong to the reviewer box: a cycle between nodes never ends.
    const cycle = findCycle(c);
    if (cycle) out.push({ level: 'error', node: cycle[0], text: `The connections make a circle (${cycle.map(id => label(c.nodes.find(n => n.id === id))).join(' → ')} → …). Use the reviewer box to go round again instead.` });

    for (const n of c.nodes) {
      const t = typeOf(n.type);
      if (t && n.count > 1 && t.tools === 'all') out.push({ level: 'info', node: n.id, text: `${n.count} ${t.name} agents run at the same time and can change files: the governor gives each its own part of the work.` });
    }
    if (c.loop.enabled) {
      if (!typeOf(c.loop.reviewer)) out.push({ level: 'error', node: 'loop', text: 'The reviewer box has no agent type. Pick one.' });
      if (c.loop.backTo && !c.nodes.some(n => n.id === c.loop.backTo)) out.push({ level: 'warning', node: 'loop', text: 'The reviewer box goes back to a node that no longer exists. Pick where it goes back to.' });
      if (!c.loop.backTo) out.push({ level: 'warning', node: 'loop', text: 'The reviewer box does not say where to go back to: the governor fixes the problems itself.' });
    }
    return out;
  }

  // One circle of node ids, or null.
  function findCycle(c) {
    const state = new Map();
    const path = [];
    const visit = id => {
      state.set(id, 1);
      path.push(id);
      for (const e of c.edges.filter(x => x.from === id && x.to !== DONE)) {
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

  // The nodes in the order they can run: each stage only needs earlier ones.
  // Nodes in a circle or never reached come last, so nothing is lost.
  function stages(c) {
    const left = new Set(c.nodes.map(n => n.id));
    const done = new Set([TASK]);
    const out = [];
    while (left.size) {
      const ready = [...left].filter(id => c.edges.filter(e => e.to === id).every(e => done.has(e.from)) && c.edges.some(e => e.to === id));
      if (!ready.length) break;
      ready.sort((a, b) => (c.nodes.find(n => n.id === a).x - c.nodes.find(n => n.id === b).x) || (c.nodes.find(n => n.id === a).y - c.nodes.find(n => n.id === b).y));
      out.push(ready);
      for (const id of ready) { left.delete(id); done.add(id); }
    }
    if (left.size) out.push([...left]);
    return out;
  }

  const subagentName = type => `pipeline-${slug(type.id)}`;

  // Claude Code's --agents value: one sub-agent per type the graph uses.
  function subagents(cfg) {
    const c = normalize(cfg);
    const used = new Set([...c.nodes.map(n => n.type), ...(c.loop.enabled ? [c.loop.reviewer] : [])]);
    const out = {};
    for (const t of c.types) {
      if (!used.has(t.id)) continue;
      const def = {
        description: `${t.description || t.name} Part of the multi-agent pipeline: run by the governor only, when the pipeline says so.`,
        prompt: t.prompt || `You are the ${t.name} of a multi-agent pipeline.`,
      };
      if (TOOL_SETS[t.tools]) def.tools = TOOL_SETS[t.tools];
      if (t.model && t.model !== 'inherit') def.model = t.model;
      out[subagentName(t)] = def;
    }
    return out;
  }

  // The governor's instructions, appended to its system prompt.
  function governorPrompt(cfg) {
    const c = normalize(cfg);
    const typeOf = id => c.types.find(t => t.id === id);
    const nodeName = id => (id === TASK ? 'the user\'s task' : id === DONE ? 'Done' : `step ${id}`);
    const lines = [
      'You are the GOVERNOR of a multi-agent pipeline that the user set up in Agent Hub. For each task the user gives you, run the pipeline below:',
      'hand each step to its sub-agent with the Agent tool (also called Task), using exactly the subagent_type named for the step.',
      'You coordinate and do not do the steps\' work yourself, except for small fixes between steps.',
      '',
      'The pipeline:',
    ];
    let n = 0;
    for (const stage of stages(c)) {
      n++;
      const parallel = stage.length > 1 ? ' (these steps run at the same time: start them in one message)' : '';
      lines.push(`Stage ${n}${parallel}:`);
      for (const id of stage) {
        const node = c.nodes.find(x => x.id === id);
        const t = typeOf(node.type);
        if (!t) { lines.push(`- ${nodeName(id)}: no agent type; skip it.`); continue; }
        const inputs = c.edges.filter(e => e.to === id).map(e => (e.from === TASK ? 'the user\'s task' : `the output of ${nodeName(e.from)} (${typeOf(c.nodes.find(x => x.id === e.from)?.type)?.name || '?'})`));
        const outputs = c.edges.filter(e => e.from === id).map(e => nodeName(e.to));
        lines.push(`- ${nodeName(id)}: ${t.name}, subagent_type "${subagentName(t)}"${node.count > 1 ? `, ${node.count} agents at once (start them in one message, each with its own part or angle, then merge their outputs)` : ''}.`
          + ` Input: ${inputs.join(' and ') || 'nothing (skip it)'}. Its output goes to ${outputs.join(' and ') || 'nothing'}.${node.note ? ` Note from the user: ${node.note}` : ''}`);
      }
    }
    const finals = c.edges.filter(e => e.to === DONE).map(e => nodeName(e.from));
    lines.push(`The result of the pipeline is the output of ${finals.join(' and ') || 'the last step'}.`);
    if (c.loop.enabled && typeOf(c.loop.reviewer)) {
      const r = typeOf(c.loop.reviewer);
      const back = c.nodes.find(x => x.id === c.loop.backTo);
      lines.push('',
        `Review loop: when the pipeline is through, run the reviewer, subagent_type "${subagentName(r)}"${c.loop.count > 1 ? ` (${c.loop.count} at once, each looking at a different aspect)` : ''}, on the whole result, with the task, the requirements and the plan.`,
        `If it reports blocking problems, ${back ? `send them to ${nodeName(back.id)} (${typeOf(back.type)?.name || '?'}) and run the pipeline again from there` : 'fix them yourself'}, then review again.`,
        `Stop after ${c.loop.maxRounds} review round${c.loop.maxRounds === 1 ? '' : 's'} at most; if problems are left then, list them for the user.`);
    }
    lines.push('',
      'How to run it:',
      '- Each sub-agent starts with no memory of this conversation: give it the user\'s task word for word, plus everything it needs from earlier steps (the full outputs it takes as input, not just a summary), and the folder you work in.',
      '- After each step, write a short recap for the user, as one line that starts with "Milestone:" (for example "Milestone: 2 of 4, plan ready: 5 changes in 3 files").',
      '- Check every output before passing it on. When something is missing, wrong or contradicts an earlier step, fix it yourself if it is small, or send it back to the same sub-agent with what to change. When parallel agents disagree, decide and say why.',
      '- When the task is only a question or a trivial change, you may skip steps that add nothing; say which ones you skipped.',
      '- If a sub-agent asks the user something, ask the user yourself and pass the answer on.',
      '- Your final message: what was done, what the review said, what is left open. Follow the rest of your instructions for it.',
    );
    return lines.join('\n');
  }

  // A short line for the chat: "Analyst → Planner → Implementer ×2 · ↻ Reviewer (3 rounds)".
  function summary(cfg) {
    const c = normalize(cfg);
    const name = id => c.types.find(t => t.id === id)?.name || id;
    const steps = stages(c).map(stage => stage.map(id => {
      const node = c.nodes.find(x => x.id === id);
      return `${name(node.type)}${node.count > 1 ? ` ×${node.count}` : ''}`;
    }).join(' + ')).join(' → ');
    const loop = c.loop.enabled ? ` · ↻ ${name(c.loop.reviewer)} (up to ${c.loop.maxRounds} round${c.loop.maxRounds === 1 ? '' : 's'})` : '';
    return (steps || 'no steps') + loop;
  }

  return { TASK, DONE, TOOL_SETS, TOOL_NAMES, MODELS, BUILTIN_TYPES, defaults, normalize, validate, stages, subagents, governorPrompt, summary, slug };
}));
