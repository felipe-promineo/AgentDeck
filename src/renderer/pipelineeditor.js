// Settings → Multi-agent: the pipeline's graph as cards you drag and connect
// (see pipeline.js for what the governor does with it), and the agent types
// the cards use.
//
// pipelineEditor(saved) returns { element, value() }: value() is the
// multiAgent setting as it is in the editor now (without `enabled`, which
// the main toggle in settings.js owns).
//
// The canvas: Your task on the left, Done on the right, the agents between
// them inside the reviewer box. Drag a card by its title to move it; drag
// from the dot on a card's right side to another card to connect them; click
// a line to remove it. The box's dashed arrow is the loop back to a step.

const PIPE_NODE_W = 196;
const PIPE_PORT_Y = 21;          // the ports sit at the middle of a card's title bar
const PIPE_TERM_W = 112;

// The last measurement (see the estimate panel), kept while the app runs so
// reopening Settings does not measure again.
let pipeMeasured = null;

function pipelineEditor(saved, { folder = '', folders = [], home = '' } = {}) {
  const P = window.Pipeline;
  let cfg = P.normalize(saved);
  const root = el('div', 'pipe-editor');

  // ---------- toolbar ----------
  const bar = el('div', 'pipe-toolbar');
  const add = document.createElement('select');
  add.className = 'pipe-add';
  const reset = el('button', 'settings-btn', 'Reset to the default pipeline');
  reset.type = 'button';
  bar.append(add, reset, el('div', 'settings-hint pipe-help',
    'Drag a card by its title to move it. Drag from the dot on its right side to another card to connect them; click a line to remove it.'));

  // ---------- canvas ----------
  const scroller = el('div', 'pipe-canvas');
  const surface = el('div', 'pipe-surface');
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.classList.add('pipe-lines');
  surface.appendChild(svg);
  scroller.appendChild(surface);
  const problems = el('div', 'pipe-problems');

  // ---------- tokens per request ----------
  const estimateBox = el('div', 'pipe-estimate');

  // ---------- agent types ----------
  const typesBox = el('div', 'pipe-types');

  root.append(bar, scroller, problems, estimateBox, el('div', 'settings-section-title pipe-types-title', 'Agent types'),
    el('div', 'settings-hint', 'The agents the cards use. Each one is a Claude Code sub-agent with its own instructions, model and tools; the governor gives it its part of the task.'),
    typesBox);

  const typeOf = id => cfg.types.find(t => t.id === id);
  const nodeOf = id => cfg.nodes.find(n => n.id === id);
  const fmt = P.formatTokens;
  let estimateNow = P.estimate(cfg, pipeMeasured);

  // What matters most about an agent, as chips: what it may do (read only,
  // shell, or change files), its model and effort, how many run at once,
  // and how big each of its requests starts.
  const ACCESS = {
    readonly: ['👁 Read only', 'read', 'It can read the code but not change anything'],
    readshell: ['⌘ Read + shell', 'shell', 'It can read and run commands, but has no tools to edit files'],
    all: ['✎ Edits files', 'write', 'It has every tool: it can change files and run commands'],
  };
  const modelName = v => (v === 'inherit' ? 'Agent\'s model' : P.MODELS.find(([m]) => m === v)?.[1] || v);
  const chips = (t, count) => {
    const row = el('div', 'pipe-chips');
    if (!t) return row;
    const chip = (text, kind, title) => {
      const c = el('span', `pipe-chip ${kind}`, text);
      if (title) c.title = title;
      row.appendChild(c);
      return c;
    };
    const [text, kind, title] = ACCESS[t.tools] || ACCESS.all;
    chip(text, kind, title);
    chip(modelName(t.model), t.model === 'inherit' ? 'dim' : 'model', t.model === 'inherit' ? 'The model the pipeline agent runs on' : `Always runs on ${modelName(t.model)}`);
    chip(t.effort ? `${P.EFFORTS.find(([e]) => e === t.effort)?.[1]} effort` : 'Agent\'s effort', t.effort ? `effort effort-${t.effort}` : 'dim', 'How hard it thinks');
    if (count > 1) chip(`×${count} at once`, 'count', `${count} agents run this step at the same time`);
    const tokens = estimateNow.perType[t.id]?.total;
    if (tokens) chip(`${estimateNow.measured ? '' : '≈'}${fmt(tokens)} / request`, 'tokens', 'The context each of its requests starts with: its instructions, its tools and the instruction files (see Tokens per request below)').dataset.type = t.id;
    return row;
  };
  const accessClass = t => `access-${(ACCESS[t?.tools] || ACCESS.all)[1]}`;

  const newId = (prefix, taken) => { let i = 1; while (taken.has(`${prefix}${i}`)) i++; return `${prefix}${i}`; };

  // Where things are on the surface. The reviewer box wraps the agents; Done
  // sits right of it, and Your task left of the leftmost agent.
  const layout = () => {
    const xs = cfg.nodes.map(n => n.x), ys = cfg.nodes.map(n => n.y);
    const heights = cfg.nodes.map(n => cards.get(n.id)?.offsetHeight || 118);
    const minX = xs.length ? Math.min(...xs) : 200, minY = ys.length ? Math.min(...ys) : 110;
    const maxX = xs.length ? Math.max(...xs) + PIPE_NODE_W : 400;
    const maxY = ys.length ? Math.max(...cfg.nodes.map((n, i) => n.y + heights[i])) : 230;
    const box = { x: minX - 26, y: minY - 74, w: Math.max(maxX - minX + 52, 560), h: maxY - minY + 100 };
    const midY = minY + PIPE_PORT_Y - 22;
    return {
      box,
      task: { x: Math.max(8, box.x - PIPE_TERM_W - 50), y: midY },
      done: { x: box.x + box.w + 50, y: midY },
      width: box.x + box.w + 50 + PIPE_TERM_W + 30,
      height: Math.max(box.y + box.h + 70, 300),
    };
  };

  // ---------- cards ----------
  const cards = new Map();   // node id (and task, done) → element
  let loopBox = null;

  const typeSelect = (value, onChange) => {
    const select = document.createElement('select');
    for (const t of cfg.types) select.appendChild(new Option(t.name, t.id));
    if (!typeOf(value)) select.appendChild(new Option(`Missing: ${value || 'none'}`, value || ''));
    select.value = value;
    select.onchange = () => onChange(select.value);
    return select;
  };
  const countInput = (value, onChange, title) => {
    const input = settingsInput('number', value, { min: 1, max: 8, step: 1, title });
    input.className = 'pipe-count';
    input.onchange = () => {
      const n = Math.max(1, Math.min(8, Math.round(Number(input.value) || 1)));
      input.value = n;
      onChange(n);
    };
    return input;
  };
  const port = (kind, id) => {
    const p = el('div', `pipe-port pipe-port-${kind}`);
    p.dataset.node = id;
    p.title = kind === 'out' ? 'Drag to another card to send this output there' : 'Input';
    return p;
  };

  const nodeCard = n => {
    const card = el('div', 'pipe-node');
    card.dataset.node = n.id;
    const head = el('div', 'pipe-node-head');
    const title = el('span', 'pipe-node-title', typeOf(n.type)?.name || 'Missing type');
    const remove = el('button', 'icon pipe-node-remove', '×');
    remove.type = 'button';
    remove.title = 'Remove this card';
    remove.onclick = () => {
      cfg.nodes = cfg.nodes.filter(x => x.id !== n.id);
      cfg.edges = cfg.edges.filter(e => e.from !== n.id && e.to !== n.id);
      if (cfg.loop.backTo === n.id) cfg.loop.backTo = '';
      window.uiSound?.('tickDown');
      render();
    };
    head.append(title, remove);
    card.classList.add(accessClass(typeOf(n.type)));
    const body = el('div', 'pipe-node-body');
    body.appendChild(chips(typeOf(n.type), n.count));
    const row = el('div', 'pipe-node-row');
    row.append(typeSelect(n.type, v => { n.type = v; render(); }),
      el('span', 'pipe-times', '×'),
      countInput(n.count, v => { n.count = v; render(); }, 'How many agents run this step at the same time'));
    const note = settingsInput('text', n.note, { placeholder: 'Note for this step (optional)' });
    note.className = 'pipe-note';
    note.oninput = () => { n.note = note.value; };
    body.append(row, note);
    card.append(port('in', n.id), head, body, port('out', n.id));
    dragCard(card, head, n);
    return card;
  };

  const terminal = (id, label, hint) => {
    const card = el('div', `pipe-term pipe-term-${id}`);
    card.dataset.node = id;
    card.title = hint;
    card.append(el('span', null, label));
    if (id === P.TASK) card.append(port('out', id));
    else card.prepend(port('in', id));
    return card;
  };

  // The reviewer box: which agent reviews the result, how many at once, how
  // many rounds, and which step it sends problems back to.
  const loopCard = () => {
    const box = el('div', 'pipe-loop');
    box.dataset.node = 'loop';
    const head = el('div', 'pipe-loop-head');
    const on = settingsInput('checkbox', cfg.loop.enabled, { title: 'Review the result, and go round again when it is not right' });
    on.onchange = () => { cfg.loop.enabled = on.checked; render(); };
    const rounds = settingsInput('number', cfg.loop.maxRounds, { min: 1, max: 10, step: 1, title: 'Review rounds at most' });
    rounds.className = 'pipe-count';
    rounds.onchange = () => { cfg.loop.maxRounds = Math.max(1, Math.min(10, Math.round(Number(rounds.value) || 3))); rounds.value = cfg.loop.maxRounds; drawLines(); check(); };
    const back = document.createElement('select');
    back.appendChild(new Option('the governor fixes it', ''));
    for (const n of cfg.nodes) back.appendChild(new Option(`${typeOf(n.type)?.name || n.type}${cfg.nodes.filter(m => m.type === n.type).length > 1 ? ` (${n.id})` : ''}`, n.id));
    back.value = cfg.nodes.some(n => n.id === cfg.loop.backTo) ? cfg.loop.backTo : '';
    back.onchange = () => { cfg.loop.backTo = back.value; drawLines(); check(); };
    const bits = [
      el('span', 'pipe-loop-label', '↻ Reviewer'),
      typeSelect(cfg.loop.reviewer, v => { cfg.loop.reviewer = v; render(); }),
      el('span', 'pipe-times', '×'),
      countInput(cfg.loop.count, v => { cfg.loop.count = v; render(); }, 'How many reviewers look at the result at the same time'),
      el('span', 'pipe-loop-text', 'up to'), rounds, el('span', 'pipe-loop-text', 'rounds, back to'), back,
    ];
    head.append(on, ...bits);
    if (cfg.loop.enabled) {
      const reviewerChips = chips(typeOf(cfg.loop.reviewer), cfg.loop.count);
      reviewerChips.classList.add('pipe-loop-chips');
      head.appendChild(reviewerChips);
    }
    for (const c of head.querySelectorAll('select, input:not([type="checkbox"])')) c.disabled = !cfg.loop.enabled;
    box.classList.toggle('off', !cfg.loop.enabled);
    box.appendChild(head);
    return box;
  };

  // ---------- moving cards ----------
  const dragCard = (card, handle, n) => {
    handle.onpointerdown = e => {
      if (e.button !== 0 || e.target.closest('button')) return;
      e.preventDefault();
      handle.setPointerCapture(e.pointerId);
      const start = { x: e.clientX, y: e.clientY, nx: n.x, ny: n.y };
      card.classList.add('dragging');
      handle.onpointermove = m => {
        n.x = Math.max(PIPE_TERM_W + 90, Math.round(start.nx + m.clientX - start.x));
        n.y = Math.max(80, Math.round(start.ny + m.clientY - start.y));
        place();
      };
      handle.onpointerup = () => {
        handle.onpointermove = handle.onpointerup = null;
        card.classList.remove('dragging');
      };
    };
  };

  // ---------- connecting ----------
  let pending = null;   // the line being drawn from an output
  const surfacePoint = e => {
    const r = surface.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  surface.addEventListener('pointerdown', e => {
    const out = e.target.closest('.pipe-port-out');
    if (!out || e.button !== 0) return;
    e.preventDefault();
    const from = out.dataset.node;
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    line.classList.add('pipe-line', 'pending');
    svg.appendChild(line);
    pending = { from, line };
    surface.classList.add('connecting');
    const move = m => {
      const a = portPoint(from, 'out');
      line.setAttribute('d', curve(a, surfacePoint(m)));
      for (const c of surface.querySelectorAll('.drop-target')) c.classList.remove('drop-target');
      const target = targetAt(m);
      if (target && canConnect(from, target.dataset.node)) target.classList.add('drop-target');
    };
    const up = u => {
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', up);
      surface.classList.remove('connecting');
      for (const c of surface.querySelectorAll('.drop-target')) c.classList.remove('drop-target');
      line.remove();
      pending = null;
      const target = targetAt(u);
      if (target && canConnect(from, target.dataset.node)) {
        cfg.edges.push({ from, to: target.dataset.node });
        window.uiSound?.('tick');
        drawLines();
        check();
      }
    };
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', up);
  });
  // The card (or Done) under the pointer: dropping anywhere on a card connects to it.
  const targetAt = e => {
    const hit = document.elementFromPoint(e.clientX, e.clientY);
    const card = hit?.closest('.pipe-node, .pipe-term-done');
    return card && surface.contains(card) ? card : null;
  };
  const canConnect = (from, to) => to && from !== to && to !== P.TASK && from !== P.DONE
    && !cfg.edges.some(e => e.from === from && e.to === to);

  // ---------- lines ----------
  const portPoint = (id, kind) => {
    if (id === P.TASK || id === P.DONE) {
      const t = id === P.TASK ? layoutNow.task : layoutNow.done;
      return { x: t.x + (kind === 'out' ? PIPE_TERM_W : 0), y: t.y + 22 };
    }
    const n = nodeOf(id);
    return { x: n.x + (kind === 'out' ? PIPE_NODE_W : 0), y: n.y + PIPE_PORT_Y };
  };
  const curve = (a, b) => {
    const dx = Math.max(40, Math.abs(b.x - a.x) / 2);
    return `M${a.x},${a.y} C${a.x + dx},${a.y} ${b.x - dx},${b.y} ${b.x},${b.y}`;
  };
  const svgEl = (tag, attrs) => {
    const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
    return node;
  };
  let layoutNow = null;
  const drawLines = () => {
    svg.replaceChildren();
    const defs = svgEl('defs', {});
    const marker = svgEl('marker', { id: 'pipe-arrow', viewBox: '0 0 10 10', refX: '9', refY: '5', markerWidth: '7', markerHeight: '7', orient: 'auto-start-reverse' });
    marker.appendChild(svgEl('path', { d: 'M0,0 L10,5 L0,10 z', class: 'pipe-arrowhead' }));
    defs.appendChild(marker);
    svg.appendChild(defs);
    for (const edge of cfg.edges) {
      const d = curve(portPoint(edge.from, 'out'), portPoint(edge.to, 'in'));
      const g = svgEl('g', { class: 'pipe-edge' });
      const hit = svgEl('path', { d, class: 'pipe-line-hit' });
      const line = svgEl('path', { d, class: 'pipe-line', 'marker-end': 'url(#pipe-arrow)' });
      const tip = svgEl('title', {});
      tip.textContent = 'Click to remove this connection';
      g.append(hit, line, tip);
      g.onclick = () => {
        cfg.edges = cfg.edges.filter(e => e !== edge);
        window.uiSound?.('tickDown');
        drawLines();
        check();
      };
      svg.appendChild(g);
    }
    // The loop: out of the reviewer box's bottom, round under it, and up
    // into the step it goes back to.
    const back = nodeOf(cfg.loop.backTo);
    if (cfg.loop.enabled && back) {
      const { box } = layoutNow;
      const bottom = box.y + box.h;
      const from = { x: box.x + box.w - 36, y: bottom };
      const cardH = cards.get(back.id)?.offsetHeight || 118;
      const to = { x: back.x + PIPE_NODE_W / 2, y: back.y + cardH + 2 };
      const low = bottom + 30;
      const d = `M${from.x},${from.y} C${from.x},${low} ${from.x},${low} ${from.x - 30},${low} L${to.x + 30},${low} C${to.x},${low} ${to.x},${low} ${to.x},${to.y}`;
      svg.appendChild(svgEl('path', { d, class: 'pipe-line pipe-loop-line', 'marker-end': 'url(#pipe-arrow)' }));
      const label = svgEl('text', { x: (from.x + to.x) / 2, y: low - 6, class: 'pipe-loop-caption', 'text-anchor': 'middle' });
      label.textContent = `changes needed → back to ${typeOf(back.type)?.name || back.id} (up to ${cfg.loop.maxRounds}×)`;
      svg.appendChild(label);
    }
  };

  // Moves everything to where layout() says, then redraws the lines.
  const place = () => {
    layoutNow = layout();
    const { box, task, done, width, height } = layoutNow;
    surface.style.width = `${width}px`;
    surface.style.height = `${height}px`;
    svg.setAttribute('width', width);
    svg.setAttribute('height', height);
    Object.assign(loopBox.style, { left: `${box.x}px`, top: `${box.y}px`, width: `${box.w}px`, height: `${box.h}px` });
    for (const [id, card] of cards) {
      const at = id === P.TASK ? task : id === P.DONE ? done : nodeOf(id);
      card.style.left = `${at.x}px`;
      card.style.top = `${at.y}px`;
    }
    drawLines();
  };

  // ---------- problems ----------
  const check = () => {
    renderEstimate();
    const found = P.validate(cfg);
    for (const [id, card] of cards) {
      const mine = found.filter(p => p.node === id);
      card.classList.toggle('pipe-error', mine.some(p => p.level === 'error'));
      card.classList.toggle('pipe-warning', !mine.some(p => p.level === 'error') && mine.some(p => p.level === 'warning'));
      card.querySelector('.pipe-badge')?.remove();
      const serious = mine.filter(p => p.level !== 'info');
      if (serious.length) {
        const badge = el('span', 'pipe-badge', '!');
        badge.title = serious.map(p => p.text).join('\n');
        card.appendChild(badge);
      }
    }
    loopBox.classList.toggle('pipe-error', found.some(p => p.node === 'loop' && p.level === 'error'));
    problems.replaceChildren();
    if (!found.length) {
      problems.appendChild(el('div', 'pipe-problem ok', '✓ The pipeline is connected: every agent gets an input and its output is used.'));
      return;
    }
    for (const p of found) {
      const row = el('div', `pipe-problem ${p.level}`, `${p.level === 'error' ? '✕' : p.level === 'warning' ? '⚠' : 'ℹ'} ${p.text}`);
      if (p.node && cards.has(p.node)) {
        row.classList.add('linked');
        row.title = 'Show it';
        row.onclick = () => {
          const card = cards.get(p.node);
          card.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' });
          card.classList.remove('flash');
          void card.offsetWidth;
          card.classList.add('flash');
        };
      }
      problems.appendChild(row);
    }
  };

  // ---------- the whole canvas ----------
  const render = () => {
    for (const c of surface.querySelectorAll('.pipe-node, .pipe-term, .pipe-loop')) c.remove();
    cards.clear();
    loopBox = loopCard();
    surface.appendChild(loopBox);
    cards.set(P.TASK, terminal(P.TASK, '✉ Your task', 'Your message to the agent'));
    cards.set(P.DONE, terminal(P.DONE, '✓ Done', 'What reaches Done is the result the reviewer checks'));
    for (const n of cfg.nodes) cards.set(n.id, nodeCard(n));
    for (const [, card] of cards) surface.appendChild(card);
    place();
    // Card heights are known once they are on screen: the box and the loop line need them.
    requestAnimationFrame(place);
    check();
    fillAdd();
  };

  // ---------- adding cards ----------
  const fillAdd = () => {
    add.replaceChildren(new Option('+ Agent…', ''));
    for (const t of cfg.types) add.appendChild(new Option(t.name, t.id));
    add.value = '';
  };
  add.onchange = () => {
    const type = add.value;
    if (!type) return;
    const id = newId('n', new Set(cfg.nodes.map(n => n.id)));
    // Right of the rightmost card, or under it when the row is long.
    const right = cfg.nodes.reduce((m, n) => (n.x > m.x ? n : m), { x: 0, y: 110 });
    const x = right.x ? right.x + PIPE_NODE_W + 34 : 200;
    cfg.nodes.push(x > 1300 ? { id, type, count: 1, x: 200, y: right.y + 170, note: '' } : { id, type, count: 1, x, y: right.y, note: '' });
    window.uiSound?.('tick');
    render();
    requestAnimationFrame(() => cards.get(id)?.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' }));
  };
  reset.onclick = () => {
    const enabled = cfg.enabled;
    cfg = { ...P.defaults(), enabled };
    window.uiSound?.('tick');
    render();
    renderTypes();
  };

  // ---------- agent types ----------
  const renderTypes = (openId = null) => {
    typesBox.replaceChildren();
    for (const t of cfg.types) {
      const item = document.createElement('details');
      item.className = 'pipe-type';
      if (t.id === openId) item.open = true;
      const sum = document.createElement('summary');
      const used = cfg.nodes.filter(n => n.type === t.id).length + (cfg.loop.enabled && cfg.loop.reviewer === t.id ? 1 : 0);
      sum.append(el('span', 'pipe-type-name', t.name),
        chips(t, 1),
        el('span', 'pipe-type-meta', [t.builtin ? 'built in' : 'yours', used ? `used ${used}×` : 'not used'].join(' · ')),
        el('span', 'pipe-type-desc', t.description));
      item.appendChild(sum);

      const name = settingsInput('text', t.name);
      name.oninput = () => { t.name = name.value || t.id; sum.querySelector('.pipe-type-name').textContent = t.name; };
      name.onchange = () => render();
      const desc = settingsInput('text', t.description, { placeholder: 'What it does, in one sentence' });
      desc.oninput = () => { t.description = desc.value; sum.querySelector('.pipe-type-desc').textContent = t.description; };
      const model = settingsSelect(P.MODELS, t.model);
      model.onchange = () => { t.model = model.value; renderTypes(t.id); render(); };
      const effort = settingsSelect(P.EFFORTS, t.effort || '');
      effort.onchange = () => { t.effort = effort.value; renderTypes(t.id); render(); };
      const tools = settingsSelect(Object.entries(P.TOOL_NAMES), t.tools);
      tools.onchange = () => { t.tools = tools.value; renderTypes(t.id); render(); };
      const prompt = settingsText(t.prompt, 'Its instructions: what it does, what it must not do, and what its answer contains');
      prompt.rows = 6;
      prompt.oninput = () => { t.prompt = prompt.value; renderEstimate(); };

      const actions = el('div', 'pipe-type-actions');
      if (t.builtin) {
        const restore = el('button', 'settings-btn', 'Restore its instructions');
        restore.type = 'button';
        restore.onclick = () => {
          const original = P.BUILTIN_TYPES.find(b => b.id === t.id);
          Object.assign(t, original, { builtin: true });
          renderTypes(t.id);
          render();
        };
        actions.appendChild(restore);
      } else {
        const del = el('button', 'settings-btn danger-text', 'Delete this type');
        del.type = 'button';
        del.title = used ? 'Cards that use it show a problem until you pick another type' : '';
        del.onclick = () => {
          cfg.types = cfg.types.filter(x => x !== t);
          window.uiSound?.('tickDown');
          renderTypes();
          render();
        };
        actions.appendChild(del);
      }
      item.append(
        settingsField('Name', null, name),
        settingsField('Description', 'The governor reads this to know what the agent is for', desc),
        settingsField('Model', 'Same as the agent: the model the pipeline agent runs on', model),
        settingsField('Effort', 'How hard it thinks. Higher: better on hard steps (planning, review), slower and more tokens', effort),
        settingsField('Tools', 'Read only: it can look but not change files. Read + shell: it can run commands too', tools),
        settingsField('Instructions', null, prompt),
        actions);
      typesBox.appendChild(item);
    }
    const create = el('button', 'settings-btn pipe-type-new', '+ New agent type');
    create.type = 'button';
    create.onclick = () => {
      const id = newId('custom-', new Set(cfg.types.map(t => t.id)));
      cfg.types.push({ id, name: 'New agent', description: '', prompt: '', model: 'inherit', tools: 'all', builtin: false });
      window.uiSound?.('tick');
      renderTypes(id);
      render();
      requestAnimationFrame(() => typesBox.querySelector('details[open] input')?.focus());
    };
    typesBox.appendChild(create);
  };

  // ---------- the estimate panel ----------
  // Measured: Claude Code, started as the governor would be in the folder,
  // reports its context (agents.js measurePipeline). The instruction files
  // it found (CLAUDE.md, AGENTS.md, rules, the global ones) are what every
  // agent of the pipeline reads, sub-agents too.
  const shortFolder = f => (home && f && (f === home || f.startsWith(home + '/') || f.startsWith(home + '\\')) ? '~' + f.slice(home.length) : f);
  const folderSelect = document.createElement('select');
  folderSelect.className = 'pipe-folder';
  let measureFolder = pipeMeasured?.folder || folder || folders[0] || '';
  const fillFolders = () => {
    folderSelect.replaceChildren();
    for (const f of [...new Set([measureFolder, ...folders].filter(Boolean))]) folderSelect.appendChild(new Option(`📁 ${shortFolder(f)}`, f));
    folderSelect.appendChild(new Option('Choose folder…', '__choose'));
    folderSelect.value = measureFolder || '__choose';
  };
  fillFolders();
  const measureBtn = el('button', 'settings-btn', 'Measure');
  measureBtn.type = 'button';
  let measuring = false;
  let measureNote = '';
  const measure = async () => {
    if (measuring || !window.deck?.measurePipeline) return;
    if (!measureFolder) { measureNote = 'Pick the folder your agents work in.'; renderEstimate(); return; }
    measuring = true;
    measureNote = '';
    renderEstimate();
    const result = await window.deck.measurePipeline(P.normalize(cfg), measureFolder).catch(err => ({ error: String(err?.message || err) }));
    measuring = false;
    if (result?.error) measureNote = result.error;
    else { pipeMeasured = { ...result, prompt: P.governorPrompt(cfg) }; }
    render();
  };
  measureBtn.onclick = measure;
  folderSelect.onchange = async () => {
    if (folderSelect.value === '__choose') {
      const chosen = await window.deck?.pickFolder?.();
      if (chosen) measureFolder = chosen;
      fillFolders();
      if (!chosen) return;
    } else measureFolder = folderSelect.value;
    measure();
  };

  const CATEGORY_NAMES = { system_prompt: 'System prompt + pipeline instructions', system_tools: 'Tools', memory_files: 'Instruction files', skills: 'Skills', custom_agents: 'Pipeline agents list', mcp_tools: 'MCP tools', messages: 'Message', slash_commands: 'Commands' };
  const stat = (label, value, hint, kind = '') => {
    const tile = el('div', `pipe-stat ${kind}`);
    tile.append(el('div', 'pipe-stat-value', value), el('div', 'pipe-stat-label', label));
    if (hint) tile.title = hint;
    return tile;
  };
  const renderEstimate = () => {
    estimateNow = P.estimate(cfg, pipeMeasured);
    for (const c of root.querySelectorAll('.pipe-chip.tokens')) {
      const total = estimateNow.perType[c.dataset.type]?.total;
      if (total) c.textContent = `${estimateNow.measured ? '' : '≈'}${fmt(total)} / request`;
    }
    const e = estimateNow;
    const m = pipeMeasured;
    estimateBox.replaceChildren();
    const head = el('div', 'pipe-estimate-head');
    head.append(el('div', 'settings-section-title', 'Tokens per request'), folderSelect, measureBtn);
    measureBtn.disabled = measuring;
    measureBtn.textContent = measuring ? 'Measuring…' : m ? 'Measure again' : 'Measure';
    const status = el('div', 'settings-hint pipe-estimate-status');
    if (measuring) status.textContent = 'Starting Claude Code in the folder to read what it loads (no message is sent, so it costs nothing)…';
    else if (measureNote) { status.textContent = measureNote; status.classList.add('danger-text'); }
    else if (m) {
      const changed = m.prompt !== P.governorPrompt(cfg);
      status.textContent = `Measured in ${shortFolder(m.folder)} at ${new Date(m.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}${m.governor.model ? `, on ${m.governor.model}` : ''}.`
        + (changed ? ' The graph changed since: the governor\'s number is from before, Measure again for the exact one.' : '');
    } else status.textContent = 'Rough defaults. Measure reads what Claude Code loads in the folder: CLAUDE.md, AGENTS.md, rules, skills and MCP tools.';
    head.appendChild(status);
    estimateBox.appendChild(head);

    const sub = Object.entries(e.perType).filter(([id]) => cfg.nodes.some(n => n.type === id) || (cfg.loop.enabled && cfg.loop.reviewer === id));
    const biggest = sub.reduce((max, [, v]) => Math.max(max, v.total), 0);
    const tiles = el('div', 'pipe-stats');
    const approx = e.measured ? '' : '≈';
    tiles.append(
      stat('Governor, each request', approx + fmt(e.governor), 'The context the governor sends with every request before any work: Claude Code\'s and Agent Hub\'s instructions, the pipeline\'s, its tools and the instruction files', 'main'),
      stat('Largest sub-agent, each request', approx + fmt(biggest), 'Its instructions, its tools and the instruction files; the inputs the governor gives it come on top'),
      stat(`Whole run, 1 round (${e.agents + 1} agents)`, approx + fmt(e.oneRound), 'Every agent\'s first request added up: the governor, each step × its count, and the reviewers'),
      stat(`Whole run, ${e.rounds} rounds`, approx + fmt(e.worst), 'When the reviewer sends it back every time: the steps from the one it goes back to, and the reviewers, run again', e.rounds > 1 ? 'warn' : ''));
    estimateBox.appendChild(tiles);

    // The governor's context, by part, as a bar.
    if (m) {
      const parts = m.governor.categories.filter(c => c.tokens > 0 && c.id !== 'messages');
      const sum = parts.reduce((s2, c) => s2 + c.tokens, 0) || 1;
      const barEl = el('div', 'pipe-bar');
      const legend = el('div', 'pipe-legend');
      parts.forEach((c, i) => {
        const seg = el('div', `pipe-seg seg-${i % 6}`);
        seg.style.width = `${(c.tokens / sum) * 100}%`;
        seg.title = `${CATEGORY_NAMES[c.id] || c.name}: ${fmt(c.tokens)}`;
        barEl.appendChild(seg);
        const item = el('span', 'pipe-legend-item');
        item.append(el('span', `pipe-dot seg-${i % 6}`), `${CATEGORY_NAMES[c.id] || c.name} ${fmt(c.tokens)}`);
        legend.appendChild(item);
      });
      estimateBox.append(el('div', 'pipe-estimate-sub', 'The governor\'s context'), barEl, legend);
    }

    // The instruction files every agent reads.
    const files = el('div', 'pipe-files');
    files.appendChild(el('div', 'pipe-estimate-sub', 'Instruction files every agent reads'));
    if (!m) files.appendChild(el('div', 'settings-hint', 'Measure to find them (CLAUDE.md, CLAUDE.local.md, .claude/rules, and AGENTS.md in a project without CLAUDE.md, in the folder and the folders above it, plus your global ones).'));
    else if (!m.governor.memoryFiles.length) files.appendChild(el('div', 'settings-hint', 'None: there is no CLAUDE.md or AGENTS.md in this folder, the folders above it, or your global settings.'));
    else {
      for (const f of [...m.governor.memoryFiles].sort((a, b) => b.tokens - a.tokens)) {
        const row = el('div', 'pipe-file');
        const shown = shortFolder(f.path);
        const name = el('span', 'pipe-file-name', shown.length > 90 ? `…${shown.slice(-89)}` : shown);
        name.title = f.path;
        row.append(name, el('span', 'pipe-file-type', f.type || ''), el('span', 'pipe-file-tokens', fmt(f.tokens)));
        if (f.tokens > 5000) { row.classList.add('big'); row.title = 'A big file: every request of every agent carries it'; }
        files.appendChild(row);
      }
    }
    if (m?.governor.mcpTools.length) files.appendChild(el('div', 'settings-hint', `MCP tools: ${m.governor.mcpTools.length} (${fmt(m.governor.mcp)}). Sub-agents with every tool get them too.`));
    if (m?.governor.deferred) files.appendChild(el('div', 'settings-hint', `Not counted: ${fmt(m.governor.deferred)} of tools that load only when an agent looks for them.`));
    estimateBox.appendChild(files);

    // Per agent type the graph uses.
    const table = el('div', 'pipe-table');
    const header = el('div', 'pipe-row pipe-row-head');
    for (const h of ['Agent', 'Runs', 'Can', 'Model', 'Effort', 'Instructions', 'Tools', 'Files', 'Each request']) header.appendChild(el('span', null, h));
    table.appendChild(header);
    for (const [id, v] of sub) {
      const t = typeOf(id);
      const runs = cfg.nodes.filter(n => n.type === id).reduce((s2, n) => s2 + n.count, 0) + (cfg.loop.enabled && cfg.loop.reviewer === id ? cfg.loop.count : 0);
      const row = el('div', `pipe-row ${accessClass(t)}`);
      const [accessText, accessKind] = ACCESS[t.tools] || ACCESS.all;
      row.append(el('span', 'pipe-row-name', t.name), el('span', null, `×${runs}`), el('span', `pipe-chip ${accessKind}`, accessText),
        el('span', t.model === 'inherit' ? 'dim' : 'strong', modelName(t.model)),
        el('span', t.effort ? 'strong' : 'dim', t.effort ? P.EFFORTS.find(([x]) => x === t.effort)?.[1] : 'Agent\'s'),
        el('span', null, fmt(v.instructions)), el('span', null, approx + fmt(v.tools)), el('span', null, e.measured ? fmt(v.memory) : '?'),
        el('span', 'strong', approx + fmt(v.total)));
      table.appendChild(row);
    }
    estimateBox.append(el('div', 'pipe-estimate-sub', 'Each sub-agent'), table,
      el('div', 'settings-hint pipe-estimate-foot', 'This is the baseline: the smallest each request can be. Every request also carries the conversation so far (for a sub-agent: what the governor hands it, then its own tool results), and an agent makes one request per step it takes. Claude Code caches the repeated part, so the baseline costs much less after an agent\'s first request.'));
  };

  // The first time the panel is on screen, measure (only Claude Code
  // starting, no message), unless a measurement from before is there.
  if (!pipeMeasured && window.IntersectionObserver) {
    const seen = new IntersectionObserver(entries => {
      if (!entries.some(x => x.isIntersecting)) return;
      seen.disconnect();
      if (!root.classList.contains('off')) measure();
    });
    requestAnimationFrame(() => seen.observe(estimateBox));
  }

  render();
  renderTypes();

  return {
    element: root,
    value: () => {
      const { enabled, ...rest } = P.normalize(cfg);
      return rest;
    },
    problems: () => P.validate(cfg),
  };
}

window.pipelineEditor = pipelineEditor;
