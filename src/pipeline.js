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
  // "edit": it can change files and run commands, but gets no connector
  // (MCP) tools except the ones its type names (see CONNECTORS).
  const TOOL_SETS = {
    all: null,
    readonly: ['Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch', 'TodoWrite'],
    readshell: ['Read', 'Grep', 'Glob', 'Bash', 'WebFetch', 'WebSearch', 'TodoWrite'],
    edit: ['Read', 'Grep', 'Glob', 'Edit', 'Write', 'NotebookEdit', 'Bash', 'WebFetch', 'WebSearch', 'TodoWrite'],
  };
  const TOOL_NAMES = { all: 'All tools (every connector too)', readonly: 'Read only', readshell: 'Read + shell', edit: 'Edit + shell' };

  // The connectors (MCP servers) a type can be given on top of its tool set,
  // by a short name. One connector has several names, depending on how it is
  // registered: a claude.ai connector is claude_ai_<Name>, a local server the
  // name in .mcp.json. Claude Code ignores names that are not there, so all
  // of them are listed. A type's `mcp` entries are a connector ("unity": all
  // of its tools), a connector and one tool ("tactile-pm:pm_get_task"), or a
  // full tool name ("mcp__server__tool").
  const CONNECTORS = {
    'tactile-pm': { name: 'Tactile PM', servers: ['claude_ai_Tactile_PM', 'tactile-pm'] },
    'tactile-cortex': { name: 'Tactile Cortex', servers: ['claude_ai_Tactile_Cortex', 'tactile-cortex'] },
    // com.tactilegames.unity-mcp, as setupcheck.js writes it to .mcp.json.
    unity: { name: 'Unity MCP', servers: ['unity'] },
    // gameengine mcp, which every Game Engine project registers at its root.
    gameengine: { name: 'Game Engine MCP', servers: ['gameengine', 'game-engine'] },
  };
  const MCP_ENTRY = /^(mcp__[\w.-]+|[\w.-]+(:[\w.-]+)?)$/;
  const cleanList = (list, ok) => [...new Set((Array.isArray(list) ? list : String(list || '').split(/[\s,]+/)).map(x => String(x).trim()).filter(x => x && ok.test(x)))];
  const SKILL_NAME = /^[\w:.-]+$/;

  // A type's `mcp` entries as Claude Code tool names.
  function mcpTools(type) {
    const out = [];
    for (const entry of type?.mcp || []) {
      if (entry.startsWith('mcp__')) { out.push(entry); continue; }
      const [server, tool] = entry.split(':');
      const servers = CONNECTORS[server]?.servers || [server];
      for (const s of servers) out.push(tool ? `mcp__${s}__${tool}` : `mcp__${s}`);
    }
    return [...new Set(out)];
  }
  // The connectors a type uses, by name, for its chips: { 'Tactile PM': 'all' | n tools }.
  function connectorsOf(type) {
    const out = {};
    for (const entry of type?.mcp || []) {
      const [server, tool] = entry.startsWith('mcp__') ? entry.slice(5).split('__') : entry.split(':');
      const name = CONNECTORS[server]?.name || Object.values(CONNECTORS).find(c => c.servers.includes(server))?.name || server;
      if (!tool) out[name] = 'all';
      else if (out[name] !== 'all') out[name] = (out[name] || 0) + 1;
    }
    return out;
  }

  // Read-only tools of the Tactile connectors, for the agents that only
  // look things up: the ticket with everything around it, and the wiki.
  const PM_READ = ['pm_get_task', 'pm_list_comments', 'pm_list_task_attachments', 'pm_get_attachment_download_url', 'pm_read_task_media',
    'pm_get_media_download_url', 'pm_list_task_documents', 'pm_get_task_document', 'pm_list_subtasks', 'pm_list_task_cortex_links',
    'pm_search_tasks', 'pm_find_similar_tasks', 'pm_get_project', 'pm_list_statuses', 'pm_list_epics', 'pm_get_local_skill'].map(t => `tactile-pm:${t}`);
  const CORTEX_READ = ['search_content', 'get_page', 'get_page_info', 'get_html_file'].map(t => `tactile-cortex:${t}`);
  const MODELS = [['inherit', 'Same as the agent'], ['opus', 'Opus'], ['sonnet', 'Sonnet'], ['haiku', 'Haiku']];
  // A sub-agent's effort ('' : the same as the agent's).
  const EFFORTS = [['', 'Same as the agent'], ['low', 'Low'], ['medium', 'Medium'], ['high', 'High'], ['xhigh', 'Extra high'], ['max', 'Max']];

  // The agents the app comes with. Their prompts can be changed in Settings;
  // they cannot be deleted (Reset puts them back as they are here).
  //
  // Model and effort are set per role instead of "Same as the agent": the
  // governor often runs on Auto, which picks Haiku or a low effort for a
  // short message, and every inheriting step would get that too. Steps that
  // decide (planners, reviewers) run on Opus at high effort, implementers on
  // Opus at medium (they follow a plan), and the analysts and testers, which
  // mostly read and run things, on Sonnet at medium. Ask the user, Use a skill
  // and Custom prompt are not sub-agents: the governor does them itself, on
  // its own model, effort and tools (see byGovernor).
  const BUILTIN_TYPES = [
    {
      id: 'analyst',
      effort: 'medium',
      name: 'Requirements analyst',
      description: 'Turns the task into clear requirements, acceptance criteria and open questions.',
      model: 'sonnet',
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
      model: 'opus',
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
      effort: 'medium',
      name: 'Implementer',
      description: 'Makes the code changes the plan describes.',
      model: 'opus',
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
      model: 'sonnet',
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
      model: 'opus',
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
    // A step that runs one of your skills (its card picks which). The
    // governor does it itself: it loads the skill and follows it.
    {
      id: 'use-skill',
      kind: 'skill',
      effort: '',
      name: 'Use a skill',
      description: 'Runs one of your Claude Code skills on the work so far; the card picks the skill.',
      model: 'inherit',
      tools: 'all',
      prompt: [
        'Load the skill with the Skill tool and follow it on the task and the step\'s inputs.',
        'Stay inside what the skill and the task ask for. The step\'s answer: what you did, what the skill produced (or where), and anything you could not do.',
      ].join(' '),
    },
    // A step that does what its card says: the governor follows the text
    // typed on the card itself, word for word.
    {
      id: 'custom-prompt',
      kind: 'prompt',
      effort: '',
      name: 'Custom prompt',
      description: 'Does what you type on its card, at that point of the pipeline.',
      model: 'inherit',
      tools: 'all',
      prompt: [
        'Follow the instructions the user wrote on the card, on the task and the step\'s inputs.',
        'Do exactly what they say, and only that. The step\'s answer: what you did, what you found or produced, and anything you could not do.',
      ].join(' '),
    },

    // ----- Tactile: a Tactile PM ticket, in a Unity or a Game Engine game -----
    // Each type gets only the tools its step needs: the analyst reads the
    // ticket and the wiki but cannot change them; planners and reviewers
    // read; implementers and testers edit, with their engine's MCP server.
    {
      id: 'pm-analyst',
      group: 'Tactile',
      effort: 'medium',
      name: 'Tactile PM analyst',
      description: 'Reads the Tactile PM ticket (comments, attachments, documents, linked tasks) and turns it into requirements and acceptance criteria.',
      model: 'sonnet',
      tools: 'readonly',
      mcp: [...PM_READ, ...CORTEX_READ],
      skills: [],
      prompt: [
        'You are the requirements analyst of a multi-agent pipeline that works Tactile PM tickets. Do not change any file, and never write to Tactile PM: you only read.',
        'When the task names a ticket (a key like ABC-123, or a Tactile PM link), read it with pm_get_task (load the tool with ToolSearch first when it is not loaded),',
        'then everything around it: its comments (pm_list_comments; a newer comment wins over the description), images in the description (pm_read_task_media),',
        'attachments (pm_list_task_attachments), its documents (pm_list_task_documents, then refinement.md, the agreed spec, and technical.md with pm_get_task_document),',
        'linked tasks (pm_get_task on each; a done one\'s implementation.md is the precedent), subtasks, and similar tasks when the ticket is thin.',
        'The description is HTML. Read Tactile Cortex pages the ticket links to, and search Cortex for the feature when the code base does not explain it.',
        'Then read the code the ticket touches, and say whether the project is a Unity game (Assets and ProjectSettings folders, C#) or a Game Engine game (TypeScript, PROJECT.md, gameengine).',
        'Answer with: 1) the ticket (key, title, type, status) and the goal in one or two sentences; 2) what, where, who, the trigger and the expected behaviour;',
        '3) the requirements as a numbered list, each one testable; 4) acceptance criteria, quoted from the ticket or refinement.md where it has them;',
        '5) out of scope; 6) assumptions and open questions, marking the ones that block the work (the governor asks the user those);',
        '7) the files, types, systems, prefabs or scenes involved, with paths. Be concrete and short: the next agents only see what you write.',
      ].join(' '),
    },
    {
      id: 'unity-planner',
      group: 'Unity',
      effort: 'high',
      name: 'Unity planner',
      description: 'Plans the change in a Unity (C#) game, following Tactile\'s C# conventions.',
      model: 'opus',
      tools: 'readonly',
      mcp: [...CORTEX_READ],
      skills: [],
      prompt: [
        'You are the planner of a multi-agent pipeline in a Unity game at Tactile. From the task and the requirements you are given, write an implementation plan. Do not change any file.',
        'Read the project\'s CLAUDE.md / AGENTS.md and the coding standards they point to (for example coding-standards.md), and the code around the change: its assemblies (.asmdef), features, prefabs and scenes.',
        'Follow Tactile\'s Game C# Conventions (Tactile Cortex page 6aa8caaa46b2cbe5be98eaa8; read it with get_page when you need a rule) and C# Testing (6aa8caaa46b2cbe5be98eaa5): EditMode tests with NSubstitute.',
        'Answer with: the approach and why; the changes file by file (path, what changes, new types or methods, which assembly); changes to prefabs, scenes or ScriptableObjects, and whether they need the Unity Editor;',
        'the EditMode tests to add (fixture, cases) and which existing tests cover the area; the order of the work; and the risks (shared code that must compile on Unity N and N-1, save data, serialization).',
        'When the work can be split between several implementers, split it into parts that touch different files and say which part is which.',
      ].join(' '),
    },
    {
      id: 'unity-implementer',
      group: 'Unity',
      effort: 'medium',
      name: 'Unity implementer',
      description: 'Makes the planned C# and asset changes in the Unity project, and recompiles through the Unity MCP.',
      model: 'opus',
      tools: 'edit',
      mcp: ['unity'],
      skills: ['unity-pipeline'],
      prompt: [
        'You are an implementer in a multi-agent pipeline in a Unity game at Tactile. Make the changes the plan gives you, and only those:',
        'when you are given one part of the plan, stay inside that part and its files, because other implementers work on the other parts at the same time.',
        'Follow the project\'s CLAUDE.md / AGENTS.md, its coding standards and Tactile\'s Game C# Conventions, and match the code around you. Edit C# files with your file tools.',
        'Prefabs, scenes and ScriptableObjects: change them through the Unity MCP when the Editor is running, not by hand-editing YAML, unless the change is trivial and safe.',
        'After your changes, recompile through the Unity MCP (wait until the Editor is ready) and fix every compile error and new warning. When the Editor is not reachable, say so; do not close the user\'s Editor.',
        'Answer with what you changed (files and what each change does), how you checked it compiles, and anything you could not do or that differs from the plan.',
      ].join(' '),
    },
    {
      id: 'unity-tester',
      group: 'Unity',
      verdict: true,
      effort: 'medium',
      name: 'Unity tester',
      description: 'Writes and runs the Unity EditMode tests (Unity MCP or the unity CLI) and reports what fails.',
      model: 'sonnet',
      tools: 'edit',
      mcp: ['unity'],
      skills: ['unity-cli', 'unity-pipeline'],
      prompt: [
        'You are the tester of a multi-agent pipeline in a Unity game at Tactile. Check that the change does what the requirements say.',
        'Tactile\'s standard is EditMode tests with NSubstitute (Cortex page "C# Testing", 6aa8caaa46b2cbe5be98eaa5); use PlayMode only for behaviour that needs frames, physics or a running scene.',
        'Add tests for the new behaviour in the project\'s test assemblies, next to the existing tests of that area and in their style. Change only test code: do not fix the code under test; report instead.',
        'Run them: when the project is open in the user\'s Editor, through the Unity MCP (recompile, wait until it is ready, then run the tests, filtered to the area first, then the whole EditMode suite);',
        'otherwise with the unity CLI (unity test <project> --mode EditMode). Never close the user\'s Editor, and never re-run a suite on code that has not changed.',
        'Answer with the tests you added, what you ran (mode, filter, counts), what passed, what failed (with the output) and what you could not test.',
      ].join(' '),
    },
    {
      id: 'unity-reviewer',
      group: 'Unity',
      verdict: true,
      effort: 'high',
      name: 'Unity code reviewer',
      description: 'Reviews the C# changes against the ticket and Tactile\'s client code review guidelines.',
      model: 'opus',
      tools: 'readshell',
      mcp: [...CORTEX_READ],
      skills: [],
      prompt: [
        'You are the code reviewer of a multi-agent pipeline in a Unity game at Tactile. Review the changes (svn diff or git diff, and the files) against the task, the requirements and the plan. Do not change any file.',
        'Review by Tactile\'s guidelines: read them from Tactile Cortex with get_page: Client code review guidelines (6a3a46ca77c60ded819e20ec), Game C# Conventions (6aa8caaa46b2cbe5be98eaa8) and C# Testing (6aa8caaa46b2cbe5be98eaa5),',
        'plus the project\'s own CLAUDE.md / AGENTS.md and coding standards, which win where they are stricter.',
        'Look for bugs, missing requirements, broken edge cases, code that breaks the conventions (for example runtime LINQ, coroutines or reflection where the project bans them, public fields instead of [SerializeField] private, null instead of the Null Object pattern),',
        'shared code that would not compile on the previous supported Unity version, missing or weak EditMode tests, reinvented shared code, and needless complexity.',
        'Start your answer with exactly one line: "VERDICT: APPROVE" when nothing must change, or "VERDICT: CHANGES" when something must.',
        'Then list each problem with its file and line, the guideline or requirement it breaks, why it matters, and what to do. Mark each one as blocking or minor.',
      ].join(' '),
    },
    {
      id: 'ge-planner',
      group: 'Game Engine',
      effort: 'high',
      name: 'Game Engine planner',
      description: 'Plans the change in a Game Engine (TypeScript ECS) game, following the project\'s skills and the engine\'s design.',
      model: 'opus',
      tools: 'readonly',
      mcp: [...CORTEX_READ],
      skills: [],
      prompt: [
        'You are the planner of a multi-agent pipeline in a game built on Tactile\'s Game Engine (gameplay in TypeScript on a Rust ECS). From the task and the requirements you are given, write an implementation plan. Do not change any file.',
        'Read the project\'s PROJECT.md first, then AGENTS.md / CLAUDE.md and the project skills they point to for the area you plan in (.claude/skills), and the code around the change:',
        'its feature folders (src/<feature>/ with schema/<feature>.schema.ts, index.ts as the facade, <feature>.di.ts), systems (defineSystem), components, resources and events.',
        'For engine behaviour the project does not explain, search Tactile Cortex (the Game Engine technical design document is page 6adb2af1df50edf4ea7d8618, and the ADRs are in the game-engine collection).',
        'Keep simulation code deterministic (fixed step, the engine\'s seeded randomness, no wall-clock time) and presentation-only code out of the simulation.',
        'Answer with: the approach and why; the changes file by file (path, what changes, new systems, components, resources, events or schema changes and the code generation they need);',
        'the tests to add (worldTest, renderTest or replays) and the gameengine commands that check the change; the order of the work; and the risks.',
        'When the work can be split between several implementers, split it into parts that touch different files and say which part is which.',
      ].join(' '),
    },
    {
      id: 'ge-implementer',
      group: 'Game Engine',
      effort: 'medium',
      name: 'Game Engine implementer',
      description: 'Makes the planned TypeScript changes in the Game Engine game and checks them with the gameengine MCP.',
      model: 'opus',
      tools: 'edit',
      mcp: ['gameengine'],
      skills: [],
      prompt: [
        'You are an implementer in a multi-agent pipeline in a game built on Tactile\'s Game Engine. Make the changes the plan gives you, and only those:',
        'when you are given one part of the plan, stay inside that part and its files, because other implementers work on the other parts at the same time.',
        'Follow the project\'s PROJECT.md, AGENTS.md / CLAUDE.md and the project skills for the area you change, and match the code around you.',
        'Change schemas in schema/*.schema.ts and regenerate (gen); never edit *.gen.ts files by hand. Keep simulation code deterministic.',
        'Check your work with the gameengine MCP tools (or the gameengine CLI): validate, the type check and lint the project documents, and the tests of the area you changed. Fix what fails.',
        'Answer with what you changed (files and what each change does), what you ran to check it and the results, and anything you could not do or that differs from the plan.',
      ].join(' '),
    },
    {
      id: 'ge-tester',
      group: 'Game Engine',
      verdict: true,
      effort: 'medium',
      name: 'Game Engine tester',
      description: 'Writes and runs the game\'s tests with the gameengine MCP (gameengine test), and reports what fails.',
      model: 'sonnet',
      tools: 'edit',
      mcp: ['gameengine'],
      skills: ['testing', 'mcp-tools'],
      prompt: [
        'You are the tester of a multi-agent pipeline in a game built on Tactile\'s Game Engine. Check that the change does what the requirements say.',
        'Follow the project\'s testing skill and AGENTS.md. Add tests for the new behaviour with the engine\'s test framework (worldTest for simulation, renderTest for what the player sees), next to the existing tests of that area and in their style.',
        'Change only test code and goldens the change really alters: do not fix the code under test; report instead.',
        'Run them with the gameengine MCP test tool (or gameengine test): the changed area first, then the suite the project documents as its gate, on every JS engine it requires (state hashes must match on V8 and Hermes).',
        'Where a state hash cannot show the behaviour, use a session, a screenshot or a replay. Never re-run a suite on code that has not changed.',
        'Answer with the tests you added, what you ran (command, scope, counts), what passed, what failed (with the output) and what you could not test.',
      ].join(' '),
    },
    {
      id: 'ge-reviewer',
      group: 'Game Engine',
      verdict: true,
      effort: 'high',
      name: 'Game Engine code reviewer',
      description: 'Reviews the TypeScript changes against the ticket, the project\'s rules and Tactile\'s code review guidelines.',
      model: 'opus',
      tools: 'readshell',
      mcp: [...CORTEX_READ],
      skills: [],
      prompt: [
        'You are the code reviewer of a multi-agent pipeline in a game built on Tactile\'s Game Engine. Review the changes (git diff, and the files) against the task, the requirements and the plan. Do not change any file.',
        'Review by the project\'s PROJECT.md, AGENTS.md / CLAUDE.md and its skills for the area, and by Tactile\'s guidelines, read from Tactile Cortex with get_page:',
        'Code Review Tips: Must-Haves & Enhancements (6a3a46d077c60ded819e2298) and Backend code review guidelines (6a3a46d077c60ded819e22a1) for TypeScript; the project\'s rules win where they are stricter.',
        'Formatting and types are checked by the tools, so do not comment on them. Look for bugs, missing requirements, broken edge cases, non-deterministic simulation code (wall-clock time, unseeded randomness, presentation services inside a system),',
        'hand-edited generated files, features reaching into each other instead of through their index.ts, SOLID and DRY problems, any, missing or weak tests, and needless complexity.',
        'Start your answer with exactly one line: "VERDICT: APPROVE" when nothing must change, or "VERDICT: CHANGES" when something must.',
        'Then list each problem with its file and line, the guideline or requirement it breaks, why it matters, and what to do. Mark each one as blocking or minor.',
      ].join(' '),
    },
  ];

  // A row of steps from Your task to Done; `back` sends each verdict step's
  // ✕ connection to an earlier step (index → index).
  function chain(types, back) {
    const nodes = types.map((type, i) => ({ id: `n${i + 1}`, type, count: 1, x: 200 + i * 230, y: 110, rounds: 3, note: '' }));
    const ids = ['task', ...nodes.map(n => n.id), 'done'];
    const edges = ids.slice(1).map((id, i) => ({ from: ids[i], to: id }));
    for (const [from, to] of Object.entries(back)) edges.push({ from: nodes[from].id, to: nodes[to].id, kind: 'fail' });
    return { nodes, edges };
  }

  // Ready-made graphs (the editor's "Start from" menu). The Tactile ones read
  // a Tactile PM ticket, plan, implement, test and review in one engine; the
  // tester and the reviewer send the work back to the implementer.
  const TEMPLATES = [
    { id: 'default', name: 'General', graph: () => defaultGraph() },
    { id: 'unity', name: 'Tactile PM ticket → Unity', graph: () => chain(['pm-analyst', 'unity-planner', 'unity-implementer', 'unity-tester', 'unity-reviewer'], { 3: 2, 4: 2 }) },
    { id: 'gameengine', name: 'Tactile PM ticket → Game Engine', graph: () => chain(['pm-analyst', 'ge-planner', 'ge-implementer', 'ge-tester', 'ge-reviewer'], { 3: 2, 4: 2 }) },
  ];
  function template(id) {
    const t = TEMPLATES.find(x => x.id === id) || TEMPLATES[0];
    const { nodes, edges } = t.graph();
    return { nodes, edges };
  }

  // The general graph: understand → plan → implement → review, and the
  // reviewer sends the work back to the implementer when it is not right.
  function defaultGraph() {
    return {
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

  // The setting the app starts with: the agent types, shared by every
  // profile, and the profiles, each a graph of its own. When you start an
  // agent with the ⛓ Pipeline button you pick a profile; the default one is
  // picked first.
  const builtinTypes = () => BUILTIN_TYPES.map(t => ({ kind: 'agent', verdict: false, mcp: [], skills: [], ...t, builtin: true }));
  const TACTILE_PROFILES = () => [
    { id: 'unity', name: 'Unity task implementer', ...template('unity') },
    { id: 'gameengine', name: 'Game Engine task implementer', ...template('gameengine') },
  ];
  function defaults() {
    return {
      enabled: false,
      types: builtinTypes(),
      profiles: [{ id: 'default', name: 'General', ...defaultGraph() }, ...TACTILE_PROFILES()],
      defaultProfile: 'default',
    };
  }

  // The two fixed ends of the graph: your message goes out of "task", and
  // what reaches "done" is the result.
  const TASK = 'task';
  const DONE = 'done';

  const slug = text => String(text || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'agent';
  const isFail = e => e.kind === 'fail';
  // Steps the governor does itself instead of a sub-agent: Use a skill and
  // Custom prompt. (Ask the user is the governor too, but it is a stop.)
  const byGovernor = t => t?.kind === 'skill' || t?.kind === 'prompt';

  // A saved setting that is missing parts (an older version, edited by hand)
  // gets them from the defaults; built-in types it does not have come back.
  function normalizeTypes(saved) {
    const d = builtinTypes();
    const types = Array.isArray(saved) ? saved.filter(t => t && t.id).map(t => {
      const builtin = BUILTIN_TYPES.find(b => b.id === slug(t.id));
      const kind = builtin ? builtin.kind || 'agent' : t.kind === 'ask' ? 'ask' : 'agent';
      return {
        id: slug(t.id), name: String(t.name || t.id), description: String(t.description || ''), prompt: String(t.prompt || ''),
        model: MODELS.some(([v]) => v === t.model) ? t.model : 'inherit', tools: t.tools in TOOL_SETS ? t.tools : 'all',
        effort: EFFORTS.some(([v]) => v === t.effort) ? t.effort : '',
        // Connector tools and skills: a built-in type saved before it had them gets its own.
        mcp: cleanList(t.mcp ?? builtin?.mcp, MCP_ENTRY),
        skills: cleanList(t.skills ?? builtin?.skills, SKILL_NAME),
        ...(builtin?.group ? { group: builtin.group } : {}),
        kind,
        // Whether it can send the work back (a "not right" output).
        verdict: kind === 'ask' || (builtin ? !!builtin.verdict : !!t.verdict),
        builtin: !!builtin,
      };
    }) : d;
    for (const b of d) if (!types.some(t => t.id === b.id)) types.push(b);
    return types;
  }

  // One graph (a profile's, or an older setting's) checked against the types.
  function normalizeGraph(types, saved) {
    const d = defaultGraph();
    const s = saved && typeof saved === 'object' ? saved : {};
    const typeOf = id => types.find(t => t.id === id);
    let nodes = Array.isArray(s.nodes) ? s.nodes.filter(n => n && n.id && n.id !== TASK && n.id !== DONE).map(n => ({
      id: String(n.id), type: String(n.type || ''), count: Math.max(1, Math.min(8, Math.round(Number(n.count) || 1))),
      x: Number(n.x) || 0, y: Number(n.y) || 0, note: String(n.note || ''),
      // Use a skill: which skill; Custom prompt: what it does.
      skill: SKILL_NAME.test(String(n.skill || '')) ? String(n.skill) : '', prompt: String(n.prompt || ''),
      rounds: Math.max(1, Math.min(10, Math.round(Number(n.rounds) || 3))),
    })) : d.nodes;
    // Ask the user, Use a skill and Custom prompt are the governor itself:
    // they never run twice at once.
    for (const n of nodes) if (typeOf(n.type)?.kind === 'ask' || byGovernor(typeOf(n.type))) n.count = 1;
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
    return { nodes, edges };
  }

  // The whole setting: { enabled, types, profiles: [{ id, name, nodes,
  // edges }], defaultProfile }. A setting from before profiles becomes the
  // General profile, and the Tactile ones are added next to it.
  const PROFILE_ID = /^[\w-]{1,40}$/;
  function normalize(saved) {
    const s = saved && typeof saved === 'object' ? saved : {};
    const types = normalizeTypes(s.types);
    let profiles;
    if (Array.isArray(s.profiles) && s.profiles.length) {
      const seen = new Set();
      profiles = s.profiles.filter(p => p && PROFILE_ID.test(String(p.id)) && !seen.has(String(p.id)) && seen.add(String(p.id)))
        .map(p => ({ id: String(p.id), name: String(p.name || 'Pipeline').slice(0, 60), ...normalizeGraph(types, p) }));
    }
    if (!profiles?.length) {
      profiles = Array.isArray(s.nodes)
        ? [{ id: 'default', name: 'General', ...normalizeGraph(types, s) }, ...TACTILE_PROFILES().map(p => ({ ...p, ...normalizeGraph(types, p) }))]
        : defaults().profiles.map(p => ({ ...p, ...normalizeGraph(types, p) }));
    }
    const defaultProfile = profiles.some(p => p.id === s.defaultProfile) ? s.defaultProfile : profiles[0].id;
    return { enabled: !!s.enabled, types, profiles, defaultProfile };
  }

  // One profile as a pipeline to run or check: { enabled, types, nodes,
  // edges, profileId, profileName }; the default one when `profileId` is
  // missing or gone.
  function pick(saved, profileId) {
    const c = normalize(saved);
    const p = c.profiles.find(x => x.id === profileId) || c.profiles.find(x => x.id === c.defaultProfile);
    return { enabled: c.enabled, types: c.types, nodes: p.nodes, edges: p.edges, profileId: p.id, profileName: p.name };
  }

  // What the functions below work on: a single graph ({ types, nodes,
  // edges }, as the editor hands it over), or the whole setting, of which
  // they take `profileId` or the default profile.
  function view(cfg) {
    if (Array.isArray(cfg?.nodes) && !Array.isArray(cfg?.profiles)) {
      const types = normalizeTypes(cfg.types);
      return { enabled: !!cfg.enabled, types, ...normalizeGraph(types, cfg), profileId: cfg.profileId || '', profileName: cfg.profileName || '' };
    }
    return pick(cfg, cfg?.profileId);
  }

  // Problems with the graph, each { level: 'error' | 'warning' | 'info', node?, text }.
  // Errors stop the pipeline from making sense (the governor is told to work
  // around them); warnings are things that are probably a mistake.
  function validate(cfg) {
    const c = view(cfg);
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
      if (n.count > 1 && t.kind !== 'ask' && (t.tools === 'all' || t.tools === 'edit')) out.push({ level: 'info', node: n.id, text: `${n.count} ${t.name} agents run at the same time and can change files: the governor gives each its own part of the work. In a git folder each one works in a worktree of its own, and Agent Hub merges their changes back; elsewhere (SVN) they share the folder.` });
      if (t.kind === 'skill' && !n.skill) out.push({ level: 'warning', node: n.id, text: `${label(n)} has no skill picked: pick one on its card, or the governor skips it.` });
      if (t.kind === 'prompt' && !n.prompt.trim()) out.push({ level: 'warning', node: n.id, text: `${label(n)} has no instructions: type what it should do on its card, or the governor skips it.` });
            if (t.kind !== 'ask' && t.tools === 'all' && t.mcp.length) out.push({ level: 'info', node: n.id, text: `${t.name} has every tool, so it already gets every connector: its connector list adds nothing. Pick a smaller tool set to give it only those.` });
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
  // The tools Agent Hub gives the governor (an in-process MCP server, see
  // pipelinerun.js) to mark a step it does itself.
  const STEP_SERVER = 'agenthub';
  const STEP_TOOLS = { start: `mcp__${STEP_SERVER}__start_step`, finish: `mcp__${STEP_SERVER}__finish_step` };
  const VERDICT_LINE = 'Start your answer with exactly one line: "VERDICT: APPROVE" when the work is right, or "VERDICT: CHANGES" when something must change, then say what must change and why.';
  // The verdict Agent Hub reads (parseVerdict): a JSON block at the end of
  // the answer. The VERDICT: line is only the fallback.
  const VERDICT_FORMAT = [
    'End your answer with your verdict as a JSON block in a ```json fence, in exactly this shape:',
    '{"verdict": "approve" or "changes", "blocking": [{"file": "path", "line": 12, "problem": "what is wrong", "fix": "what to do"}], "minor": [the same shape]}.',
    '"blocking" lists what must change before the work is right; "minor" what could be better. Say "changes" when "blocking" has anything in it, "approve" when it is empty.',
    'Agent Hub reads this block to decide whether the work goes back, so write it even when everything is right.',
  ].join(' ');

  // A verdict step's answer read: { verdict: 'approve' | 'changes', blocking:
  // [{ file, line, problem, fix }], minor: [...], source: 'json' | 'line' },
  // or null when it has none. The last ```json block with a "verdict" wins; a
  // "changes" verdict, or anything blocking, is "changes". Without a block,
  // the first "VERDICT: APPROVE | CHANGES" line counts, with no list.
  function parseVerdict(text) {
    const s = String(text || '');
    const items = list => (Array.isArray(list) ? list : []).map(x => {
      if (typeof x === 'string' && x.trim()) return { file: '', line: null, problem: x.trim(), fix: '' };
      if (!x || typeof x !== 'object' || typeof x.problem !== 'string' || !x.problem.trim()) return null;
      const line = Number(x.line);
      return { file: typeof x.file === 'string' ? x.file : '', line: x.line != null && x.line !== '' && Number.isFinite(line) ? Math.round(line) : null, problem: x.problem.trim(), fix: typeof x.fix === 'string' ? x.fix.trim() : '' };
    }).filter(Boolean);
    const blocks = [...s.matchAll(/```[ \t]*(?:json)?[^\n]*\n([\s\S]*?)```/gi)].map(m => m[1]).reverse();
    for (const block of blocks) {
      let j;
      try { j = JSON.parse(block); } catch { continue; }
      const said = String(j?.verdict || '').trim().toLowerCase();
      if (said !== 'approve' && said !== 'changes') continue;
      const blocking = items(j.blocking);
      return { verdict: said === 'changes' || blocking.length ? 'changes' : 'approve', blocking, minor: items(j.minor), source: 'json' };
    }
    const line = /^[\s>*_#]*VERDICT:\s*\**\s*(APPROVE|CHANGES)\b/im.exec(s);
    return line ? { verdict: line[1].toLowerCase(), blocking: [], minor: [], source: 'line' } : null;
  }

  // Claude Code's --agents value: one sub-agent per type the graph uses
  // (Ask the user, Use a skill and Custom prompt are the governor itself,
  // not sub-agents).
  function subagents(cfg) {
    const c = view(cfg);
    const used = new Set(c.nodes.map(n => n.type));
    const out = {};
    for (const t of c.types) {
      if (!used.has(t.id) || t.kind === 'ask' || byGovernor(t)) continue;
      let prompt = t.prompt || `You are the ${t.name} of a multi-agent pipeline.`;
      if (t.verdict && !/VERDICT:/.test(prompt)) prompt += ' ' + VERDICT_LINE;
      if (t.verdict && !/"verdict"/.test(prompt)) prompt += ' ' + VERDICT_FORMAT;
      out[subagentName(t)] = subagentDef(t, prompt, t.description || t.name);
    }
    return out;
  }

  function subagentDef(t, prompt, description) {
    const def = {
        description: `${description} Part of the multi-agent pipeline: run by the governor only, when the pipeline says so.`,
        prompt,
      };
      // A tool set plus the type's connector tools, and ToolSearch, which
      // loads connector tools when Claude Code defers them. With every tool
      // it already has every connector.
      const mcp = mcpTools(t);
      if (TOOL_SETS[t.tools]) def.tools = [...TOOL_SETS[t.tools], ...(mcp.length ? ['ToolSearch', ...mcp] : [])];
      if (t.skills.length) def.skills = t.skills;
      if (t.model && t.model !== 'inherit') def.model = t.model;
      if (t.effort) def.effort = t.effort;
      return def;
  }

  // The governor's instructions, appended to its system prompt.
  function governorPrompt(cfg) {
    const c = view(cfg);
    const typeOf = id => c.types.find(t => t.id === id);
    const nodeOf = id => c.nodes.find(x => x.id === id);
    const nodeName = id => (id === TASK ? 'the user\'s task' : id === DONE ? 'Done' : `step ${id} (${typeOf(nodeOf(id)?.type)?.name || '?'})`);
    const lines = [
      'You are the GOVERNOR of a multi-agent pipeline that the user set up in Agent Hub. For each task the user gives you, run the pipeline below:',
      'hand each agent step to its sub-agent with the Agent tool (also called Task), using exactly the subagent_type named for the step. Start the call\'s description with the step\'s id, for example "Step n3: implement the plan".',
      'You coordinate and do not do the sub-agents\' work yourself, except for small fixes between steps. Steps marked YOURSELF are yours to do: there is no sub-agent for them.',
      '',
      'Agent Hub runs the pipeline with you, in code: it checks every step you start and refuses one that is out of order (the refusal says what comes next: follow it),',
      'runs each step in the foreground, gives each sub-agent its inputs as files and saves every answer to a file, reads each verdict, counts the rounds,',
      'and after each step tells you what comes next. Its notes start with "Agent Hub pipeline:". The run is saved after every step, so after an error, a restart or a resumed session it goes on from where it stopped.',
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
      if (t.kind === 'skill' && !node.skill) return `- ${nodeName(id)}: no skill picked for it; skip it, pass its inputs on to ${outputs.join(' and ') || 'Done'} and say so.`;
      if (t.kind === 'prompt' && !node.prompt.trim()) return `- ${nodeName(id)}: it has no instructions; skip it, pass its inputs on to ${outputs.join(' and ') || 'Done'} and say so.`;
      if (byGovernor(t)) {
        const what = t.kind === 'skill' ? `Run the skill "${node.skill}": load it with the Skill tool and follow it.`
          : `Follow these instructions from the user, word for word, between the markers: <<<STEP INSTRUCTIONS\n${node.prompt.trim()}\nSTEP INSTRUCTIONS>>>`;
        return `- ${nodeName(id)}: YOURSELF, not a sub-agent. ${what} ${t.prompt}${note}`
          + ` Input: ${inputs.join(' and ') || 'only what a step sends back to it'}. Its output goes to ${outputs.join(' and ') || 'nothing'}.`
          + ` Start it with ${STEP_TOOLS.start} (step "${id}") and end it with ${STEP_TOOLS.finish} (step "${id}" and the step's complete answer).`;
      }
      let line = `- ${nodeName(id)}: subagent_type "${subagentName(t)}"${node.count > 1 ? `, ${node.count} agents at once (start them in one message, each with its own part or angle, then merge their outputs)` : ''}`
        + `. Input: ${inputs.join(' and ') || 'only what a step sends back to it'}. Its output goes to ${outputs.join(' and ') || 'nothing'}.${note}`;
      if (t.verdict) {
        line += back.length
          ? ` It gives a verdict (Agent Hub reads it): on approve go on to ${outputs.join(' and ') || 'Done'}; on changes (blocking problems) the work goes back to ${back.join(' or ')} with its findings, and the pipeline runs again from there, through this step again.`
            + ` At most ${node.rounds} time${node.rounds === 1 ? '' : 's'} for this step; when it is still not right after that, go on and list the problems that are left for the user.`
          : ' It gives a verdict: on changes, fix the blocking problems yourself (or with the step that fits), then go on.';
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
      `- A step you do yourself: call ${STEP_TOOLS.start} first (it tells you the step's input files: read them), do the step, then call ${STEP_TOOLS.finish} with its complete answer, which Agent Hub saves for the next steps. Do not start another step in between.`,
      '- Each sub-agent starts with no memory of this conversation. Agent Hub adds the paths of its input files to the prompt you write (the task, the outputs of the steps before it, the findings to fix), and the sub-agent reads them in full.',
      '  So do not paste earlier outputs into the prompt: write what is specific to this call, such as the part of the plan for one of several agents at once, your corrections between steps, or what the user said.',
      '- Steps that change files and run at the same time each work in a git worktree of their own; Agent Hub merges each one\'s changes back into the folder when it finishes, and tells you about conflicts. Resolve those before the next step.',
      '- After each step, write a short recap for the user, as one line that starts with "Milestone:" (for example "Milestone: 2 of 4, plan ready: 5 changes in 3 files").',
      '- Check every output before passing it on. When something is missing, wrong or contradicts an earlier step, fix it yourself if it is small, or send it back to the same sub-agent with what to change. When parallel agents disagree, decide and say why.',
      '- When work goes back to an earlier step, say so in a Milestone line with the round (for example "Milestone: review round 2 of 3, back to the implementer: 2 blocking problems").',
      '- When the user\'s message is only a question, you may answer it without the pipeline. Once you start the first step, every step runs: Agent Hub does not let you skip one. Starting a first step again starts the pipeline over, as a new task.',
      '- When you stop before the pipeline is done, Agent Hub reminds you once what is next; stopping again pauses the run, and it goes on from there in a later turn.',
      '- If a sub-agent asks the user something, ask the user yourself and pass the answer on (stop to ask: the run pauses and goes on after their answer).',
      '- Your final message: what was done, what the reviews said, what is left open. Follow the rest of your instructions for it.',
    );
    return lines.join('\n');
  }

  // A step's name for people: its type's name, the skill it runs, or the
  // start of its custom prompt.
  function stepLabel(c, node) {
    const t = c.types.find(x => x.id === node.type);
    if (t?.kind === 'skill' && node.skill) return `Skill ${node.skill}`;
    const text = node.prompt?.trim();
    if (t?.kind === 'prompt' && text) return `“${text.split('\n')[0].slice(0, 30)}${text.length > 30 ? '…' : ''}”`;
    return t?.name || node.type || 'Missing type';
  }

  // The steps of a pipeline in the order they run, for the chat's progress
  // panel: { profileName, stages: [[step]], onDemand: [step] }, each step
  // { id, label, kind, agent, self, verdict, count, inputs }. `agent` is the
  // subagent_type the governor starts it with (null: Ask the user, which is
  // the governor's own question, a step the governor does itself, or a step
  // it skips); `self` a Use a skill or Custom prompt step with something to
  // do, which the governor does itself; `inputs` the steps it waits for
  // (TASK for the user's task).
  function steps(cfg) {
    const c = view(cfg);
    const info = id => {
      const node = c.nodes.find(n => n.id === id);
      const t = c.types.find(x => x.id === node.type);
      const self = t?.kind === 'skill' ? !!node.skill : t?.kind === 'prompt' ? !!node.prompt.trim() : false;
      const agent = !t || t.kind === 'ask' || byGovernor(t) ? null : subagentName(t);
      return {
        id, label: stepLabel(c, node), kind: t?.kind || 'agent', agent, self, verdict: !!t?.verdict, count: node.count,
        inputs: c.edges.filter(e => e.to === id && !isFail(e)).map(e => e.from),
      };
    };
    const order = stages(c);
    return { profileName: c.profileName || '', stages: order.map(stage => stage.map(info)), onDemand: order.onDemand.map(info) };
  }

  // What Agent Hub runs (pipelinerun.js): the graph of one profile, frozen
  // when a run starts. { profileId, profileName, stages: [[id]], onDemand:
  // [id], first: [id], nodes: [{ id, label, kind, type, agent, self,
  // verdict, count, rounds, inputs, outputs, back, skip, canEdit, isolate }] }.
  // `self`: a step the governor does itself, in the folder (never isolated);
  // `skill` the skill of a Use a skill step.
  // `inputs` holds TASK, `outputs` may hold DONE; `back` are the ✕ targets;
  // `skip` a step with nothing to run (no skill picked, no instructions, a
  // missing type); `isolate` a step that changes files while another one
  // does too (several agents at once, or a parallel step that edits), so
  // each of its agents works in a git worktree of its own. `first`: the
  // steps that start the pipeline (only the task, or first steps that are
  // stops or skipped, before them).
  function plan(cfg) {
    const c = view(cfg);
    const order = stages(c);
    const info = steps(c);
    const all = [...info.stages.flat(), ...info.onDemand];
    const nodes = all.map(s => {
      const node = c.nodes.find(n => n.id === s.id);
      const t = c.types.find(x => x.id === node.type);
      return {
        id: s.id, label: s.label, kind: s.kind, type: node.type, agent: s.agent, self: s.self, verdict: s.verdict, count: node.count, rounds: node.rounds,
        ...(s.self && s.kind === 'skill' ? { skill: node.skill } : {}),
        inputs: s.inputs,
        outputs: c.edges.filter(e => e.from === s.id && !isFail(e)).map(e => e.to),
        back: c.edges.filter(e => e.from === s.id && isFail(e)).map(e => e.to),
        skip: s.kind !== 'ask' && !s.agent && !s.self,
        canEdit: !!t && t.kind !== 'ask' && !byGovernor(t) && (t.tools === 'all' || t.tools === 'edit'),
        isolate: false,
      };
    });
    const byId = new Map(nodes.map(n => [n.id, n]));
    for (const stage of order) {
      const editing = stage.map(id => byId.get(id)).filter(n => n && n.canEdit && !n.skip);
      for (const n of editing) n.isolate = n.count > 1 || editing.length > 1;
    }
    const first = new Set();
    let grew = true;
    while (grew) {
      grew = false;
      for (const n of nodes) {
        if (first.has(n.id) || !n.inputs.length) continue;
        if (n.inputs.every(i => i === TASK || (first.has(i) && (byId.get(i).kind === 'ask' || byId.get(i).skip)))) { first.add(n.id); grew = true; }
      }
    }
    return { profileId: c.profileId || '', profileName: c.profileName || '', stages: order.map(s => [...s]), onDemand: [...order.onDemand], first: [...first], nodes };
  }

  // A short line for the chat: "Analyst → Planner → Implementer ×2 → Code reviewer (↺ Implementer, 3×)".
  function summary(cfg) {
    const c = view(cfg);
    const name = id => c.types.find(t => t.id === id)?.name || id;
    const step = id => {
      const node = c.nodes.find(x => x.id === id);
      const back = c.edges.filter(e => e.from === id && isFail(e)).map(e => name(c.nodes.find(x => x.id === e.to)?.type));
      return `${stepLabel(c, node)}${node.count > 1 ? ` ×${node.count}` : ''}${back.length ? ` (↺ ${back.join(', ')}, ${node.rounds}×)` : ''}`;
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
  const FALLBACK_TOOLS = { all: 20000, readonly: 3500, readshell: 6000, edit: 9000 };
  const FALLBACK_MCP_TOOL = 300;
  const FALLBACK_MCP_SERVER = 4000;
  const FALLBACK_GOVERNOR = 30000;
  const SUBAGENT_ENV = 500;       // the environment block Claude Code adds to a sub-agent's prompt
  const tokensOf = text => Math.ceil(String(text || '').length / 3.7);

  function estimate(cfg, measured = null) {
    const c = view(cfg);
    const m = measured && !measured.error ? measured : null;
    const memory = m ? (m.governor.memoryFiles || []).reduce((sum, f) => sum + (f.tokens || 0), 0) : 0;
    const mcp = m ? m.governor.mcp || 0 : 0;
    const tools = set => (m?.toolSets?.[set] != null ? m.toolSets[set] + (set === 'all' ? mcp : 0) : FALLBACK_TOOLS[set]);
    const perType = {};
    for (const t of c.types) {
      // Asking the user, a skill and a custom prompt are the governor's own
      // work: no new agent.
      if (t.kind === 'ask' || byGovernor(t)) { perType[t.id] = { instructions: 0, tools: 0, memory: 0, total: 0 }; continue; }
      // Connector tools are not measured: a rough size each (a whole
      // connector more), unless Claude Code defers them.
      const extra = t.tools === 'all' ? 0 : t.mcp.reduce((sum, e) => sum + (e.includes(':') || e.split('__').length > 2 ? FALLBACK_MCP_TOOL : FALLBACK_MCP_SERVER), 0);
      const parts = { instructions: SUBAGENT_ENV + tokensOf(t.prompt), tools: tools(t.tools) + extra, memory };
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
    const agents = c.nodes.filter(n => { const t = c.types.find(x => x.id === n.type); return t?.kind !== 'ask' && !byGovernor(t); }).reduce((sum, n) => sum + n.count, 0);
    const asks = c.nodes.filter(n => c.types.find(t => t.id === n.type)?.kind === 'ask').length;
    const oneRound = governor + steps;
    return { measured: !!m, governor, memory, mcp, perType, steps, oneRound, worst: oneRound + again, rounds, agents, asks };
  }

  const formatTokens = n => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(n >= 1e4 ? 0 : 1)}k` : String(Math.round(n)));

  const cleanMcp = list => cleanList(list, MCP_ENTRY);
  const cleanSkills = list => cleanList(list, SKILL_NAME);

  return { STEP_SERVER, STEP_TOOLS, byGovernor, steps, plan, parseVerdict, VERDICT_FORMAT, pick, PROFILE_ID, TASK, DONE, TOOL_SETS, TOOL_NAMES, CONNECTORS, TEMPLATES, template, mcpTools, connectorsOf, cleanMcp, cleanSkills, MODELS, EFFORTS, BUILTIN_TYPES, estimate, formatTokens, tokensOf, defaults, normalize, validate, stages, subagents, governorPrompt, summary, slug, isFail };
}));
