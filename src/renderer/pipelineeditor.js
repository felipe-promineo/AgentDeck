// Settings → Multi-agent: the pipeline's graph as cards you drag and connect
// (see pipeline.js for what the governor does with it), and the agent types
// the cards use.
//
// pipelineEditor(saved) returns { element, value() }: value() is the
// multiAgent setting as it is in the editor now (without `enabled`, which
// the main toggle in settings.js owns).
//
// The canvas: Your task on the left, Done on the right, the agents between
// them. Drag a card by its title to move it; drag from the dot on a card's
// right side to another card to connect them; click a line to remove it. A
// card that gives a verdict (a reviewer, a tester, Ask the user) also has a
// red ✕ dot at its bottom: drag it back to an earlier card, where the work
// goes when it is not right (a dashed red line under the cards).

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
  // 🧹 in the canvas's top right corner tidies the cards (see tidy below).
  const canvasWrap = el('div', 'pipe-canvas-wrap');
  const tidyBtn = el('button', 'pipe-tidy', '🧹');
  tidyBtn.type = 'button';
  tidyBtn.title = 'Tidy up: line the cards up in evenly spaced columns, in the order they run, with straight connections that do not cross cards';
  canvasWrap.append(scroller, tidyBtn);
  const problems = el('div', 'pipe-problems');

  // ---------- tokens per request ----------
  const estimateBox = el('div', 'pipe-estimate');

  // ---------- agent types ----------
  const typesBox = el('div', 'pipe-types');

  root.append(bar, canvasWrap, problems, estimateBox, el('div', 'settings-section-title pipe-types-title', 'Agent types'),
    el('div', 'settings-hint', 'The agents the cards use. Each one is a Claude Code sub-agent with its own instructions, model and tools; the governor gives it its part of the task. Ask the user is the governor itself: it stops and asks you.'),
    typesBox);

  const typeOf = id => cfg.types.find(t => t.id === id);
  const nodeOf = id => cfg.nodes.find(n => n.id === id);
  const fmt = P.formatTokens;
  let estimateNow = P.estimate(cfg, pipeMeasured);

  // What matters most about an agent, as chips: only where it differs from
  // the governor (fewer tools than all, its own model, its own effort),
  // plus whether it gives a verdict, how many run at once and how big each
  // of its requests starts. The same as the governor shows nothing; the
  // table under Tokens per request lists everything.
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
    if (t.kind === 'ask') {
      chip('✋ Waits for you', 'ask', 'The governor stops here, shows you where things stand and asks you; the pipeline goes on when you answer');
      return row;
    }
    if (t.tools !== 'all') chip(...ACCESS[t.tools]);
    if (t.verdict) chip('⚖ Verdict', 'verdict', 'It says whether the work is right: when it is not, the work goes back along its ✕ connection');
    if (t.model !== 'inherit') chip(modelName(t.model), 'model', `Always runs on ${modelName(t.model)}, whatever the pipeline agent runs on`);
    if (t.effort) chip(`${P.EFFORTS.find(([e]) => e === t.effort)?.[1]} effort`, `effort effort-${t.effort}`, 'Thinks this hard, whatever the pipeline agent\'s effort is');
    if (count > 1) chip(`×${count} at once`, 'count', `${count} agents run this step at the same time`);
    const tokens = estimateNow.perType[t.id]?.total;
    if (tokens) chip(`${estimateNow.measured ? '' : '≈'}${fmt(tokens)} / request`, 'tokens', 'The context each of its requests starts with: its instructions, its tools and the instruction files (see Tokens per request below)').dataset.type = t.id;
    return row;
  };
  const accessClass = t => (t?.kind === 'ask' ? 'access-ask' : `access-${(ACCESS[t?.tools] || ACCESS.all)[1]}`);

  const newId = (prefix, taken) => { let i = 1; while (taken.has(`${prefix}${i}`)) i++; return `${prefix}${i}`; };

  // Where things are on the surface: Done right of the rightmost card, Your
  // task left of the leftmost one, and room under the cards for the ✕ lines.
  const heightOf = id => cards.get(id)?.offsetHeight || 150;
  const layout = () => {
    const xs = cfg.nodes.map(n => n.x), ys = cfg.nodes.map(n => n.y);
    const minX = xs.length ? Math.min(...xs) : 200, minY = ys.length ? Math.min(...ys) : 110;
    const maxX = xs.length ? Math.max(...xs) + PIPE_NODE_W : 400;
    const bottom = ys.length ? Math.max(...cfg.nodes.map(n => n.y + heightOf(n.id))) : 230;
    const fails = cfg.edges.filter(P.isFail).length;
    // Your task and Done sit level with the cards they connect to, so those
    // lines are straight; without connections, level with the top row.
    const levelWith = ids => {
      const ys = ids.map(id => nodeOf(id)?.y).filter(y => y != null);
      return (ys.length ? ys.reduce((a, b) => a + b, 0) / ys.length : minY) + PIPE_PORT_Y - 22;
    };
    const doneX = maxX + 70;
    return {
      task: { x: Math.max(8, minX - PIPE_TERM_W - 70), y: levelWith(cfg.edges.filter(e => e.from === P.TASK).map(e => e.to)) },
      done: { x: doneX, y: levelWith(cfg.edges.filter(e => e.to === P.DONE && !P.isFail(e)).map(e => e.from)) },
      bottom,
      width: doneX + PIPE_TERM_W + 30,
      height: Math.max(bottom + 50 + fails * 16, 300),
    };
  };

  // ---------- cards ----------
  const cards = new Map();   // node id (and task, done) → element

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
    p.title = kind === 'out' ? 'Drag to another card to send this output there'
      : kind === 'fail' ? 'Not right: drag back to an earlier card, where the work goes when this step says it must change'
        : 'Input';
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
      window.uiSound?.('tickDown');
      render();
    };
    head.append(title, remove);
    card.classList.add(accessClass(typeOf(n.type)));
    const body = el('div', 'pipe-node-body');
    body.appendChild(chips(typeOf(n.type), n.count));
    const t = typeOf(n.type);
    const row = el('div', 'pipe-node-row');
    row.appendChild(typeSelect(n.type, v => {
      n.type = v;
      // A step that no longer gives a verdict loses its ✕ connections.
      if (!typeOf(v)?.verdict) cfg.edges = cfg.edges.filter(e => !(e.from === n.id && P.isFail(e)));
      if (typeOf(v)?.kind === 'ask') n.count = 1;
      render();
    }));
    // Asking you is the governor itself: it never runs twice at once.
    if (t?.kind !== 'ask') row.append(el('span', 'pipe-times', '×'), countInput(n.count, v => { n.count = v; render(); }, 'How many agents run this step at the same time'));
    const note = settingsInput('text', n.note, { placeholder: t?.kind === 'ask' ? 'What to ask about (optional)' : 'Note for this step (optional)' });
    note.className = 'pipe-note';
    note.oninput = () => { n.note = note.value; };
    body.append(row, note);
    card.append(port('in', n.id), head, body, port('out', n.id));
    // A verdict: where the work goes when it is not right, and how often.
    if (t?.verdict) {
      const back = el('div', 'pipe-node-fail');
      const rounds = settingsInput('number', n.rounds, { min: 1, max: 10, step: 1, title: 'How many times at most it sends the work back' });
      rounds.className = 'pipe-count';
      rounds.onchange = () => { n.rounds = Math.max(1, Math.min(10, Math.round(Number(rounds.value) || 3))); rounds.value = n.rounds; drawLines(); check(); };
      const target = cfg.edges.find(e => e.from === n.id && P.isFail(e));
      const where = el('span', 'pipe-fail-label', target ? `✕ back to ${typeOf(nodeOf(target.to)?.type)?.name || '?'}` : '✕ drag ● back');
      where.title = target ? 'When it is not right, the work goes back there' : 'Drag the red dot at the bottom of this card to the step the work goes back to when it is not right';
      back.append(where, el('span', 'pipe-fail-max', '≤'), rounds, el('span', 'pipe-fail-max', '×'));
      body.appendChild(back);
      card.appendChild(port('fail', n.id));
    }
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
    const out = e.target.closest('.pipe-port-out, .pipe-port-fail');
    if (!out || e.button !== 0) return;
    e.preventDefault();
    const from = out.dataset.node;
    const kind = out.classList.contains('pipe-port-fail') ? 'fail' : '';
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    line.classList.add('pipe-line', 'pending');
    if (kind) line.classList.add('pipe-fail-line');
    svg.appendChild(line);
    pending = { from, line };
    surface.classList.add('connecting');
    const move = m => {
      const a = portPoint(from, kind || 'out');
      const b = surfacePoint(m);
      line.setAttribute('d', kind ? `M${a.x},${a.y} C${a.x},${a.y + 60} ${b.x},${b.y + 60} ${b.x},${b.y}` : curve(a, b));
      for (const c of surface.querySelectorAll('.drop-target')) c.classList.remove('drop-target');
      const target = targetAt(m);
      if (target && canConnect(from, target.dataset.node, kind)) target.classList.add('drop-target');
    };
    const up = u => {
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', up);
      surface.classList.remove('connecting');
      for (const c of surface.querySelectorAll('.drop-target')) c.classList.remove('drop-target');
      line.remove();
      pending = null;
      const target = targetAt(u);
      if (target && canConnect(from, target.dataset.node, kind)) {
        // One ✕ connection per card: a new one replaces the old.
        if (kind) cfg.edges = cfg.edges.filter(x => !(x.from === from && P.isFail(x)));
        cfg.edges.push(kind ? { from, to: target.dataset.node, kind } : { from, to: target.dataset.node });
        window.uiSound?.('tick');
        if (kind) render();
        else { drawLines(); check(); }
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
  const canConnect = (from, to, kind = '') => to && from !== to && to !== P.TASK && from !== P.DONE
    && !(kind && to === P.DONE)
    && !cfg.edges.some(e => e.from === from && e.to === to && P.isFail(e) === !!kind);

  // ---------- lines ----------
  const portPoint = (id, kind) => {
    if (id === P.TASK || id === P.DONE) {
      const t = id === P.TASK ? layoutNow.task : layoutNow.done;
      return { x: t.x + (kind === 'out' ? PIPE_TERM_W : 0), y: t.y + 22 };
    }
    const n = nodeOf(id);
    if (kind === 'fail') return { x: n.x + PIPE_NODE_W - 24, y: n.y + heightOf(id) };
    if (kind === 'back') return { x: n.x + PIPE_NODE_W / 2, y: n.y + heightOf(id) + 2 };
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
    const failMarker = svgEl('marker', { id: 'pipe-arrow-fail', viewBox: '0 0 10 10', refX: '9', refY: '5', markerWidth: '7', markerHeight: '7', orient: 'auto-start-reverse' });
    failMarker.appendChild(svgEl('path', { d: 'M0,0 L10,5 L0,10 z', class: 'pipe-arrowhead-fail' }));
    defs.appendChild(failMarker);
    const edgeGroup = (edge, d, fail) => {
      const g = svgEl('g', { class: `pipe-edge${fail ? ' fail' : ''}` });
      const hit = svgEl('path', { d, class: 'pipe-line-hit' });
      const line = svgEl('path', { d, class: `pipe-line${fail ? ' pipe-fail-line' : ''}`, 'marker-end': `url(#${fail ? 'pipe-arrow-fail' : 'pipe-arrow'})` });
      const tip = svgEl('title', {});
      tip.textContent = fail ? 'Where the work goes when it is not right. Click to remove' : 'Click to remove this connection';
      g.append(hit, line, tip);
      g.onclick = () => {
        cfg.edges = cfg.edges.filter(e => e !== edge);
        window.uiSound?.('tickDown');
        if (fail) render();
        else { drawLines(); check(); }
      };
      svg.appendChild(g);
      return g;
    };
    // A connection that would run through a card on its way (one that skips
    // a column, say) goes over the cards instead, each in its own lane.
    let lane = 0;
    const top = cfg.nodes.length ? Math.min(...cfg.nodes.map(n => n.y)) : 110;
    for (const edge of cfg.edges.filter(e => !P.isFail(e))) {
      const a = portPoint(edge.from, 'out');
      const b = portPoint(edge.to, 'in');
      const blocked = cfg.nodes.some(n => n.id !== edge.from && n.id !== edge.to
        && n.x > Math.min(a.x, b.x) - 4 && n.x + PIPE_NODE_W < Math.max(a.x, b.x) + 4
        && Math.max(a.y, b.y) > n.y - 6 && Math.min(a.y, b.y) < n.y + heightOf(n.id) + 6);
      if (!blocked || b.x <= a.x) { edgeGroup(edge, curve(a, b), false); continue; }
      const y = top - 26 - lane++ * 14;
      const r = 14;
      edgeGroup(edge, `M${a.x},${a.y} C${a.x + 24},${a.y} ${a.x + 24},${y} ${a.x + 24 + r},${y} L${b.x - 24 - r},${y} C${b.x - 24},${y} ${b.x - 24},${b.y} ${b.x},${b.y}`, false);
    }
    // "Not right": out of the red dot at the card's bottom, along a lane
    // under the cards, and up into the bottom of the card it goes back to.
    cfg.edges.filter(P.isFail).forEach((edge, i) => {
      const from = portPoint(edge.from, 'fail');
      const to = portPoint(edge.to, 'back');
      const low = layoutNow.bottom + 26 + i * 16;
      const r = 14;
      const dir = to.x < from.x ? -1 : 1;
      // A card under the dot (a column of several): go down the gap right
      // of the column instead of through it.
      const gate = nodeOf(edge.from);
      const under = cfg.nodes.some(n => n.id !== gate.id && n.y > gate.y && n.x < from.x + 8 && n.x + PIPE_NODE_W > from.x - 8);
      const d = under
        ? (() => {
          const gx = gate.x + PIPE_NODE_W + 30 + i * 6;
          const y1 = from.y + 18;
          return `M${from.x},${from.y + 7} L${from.x},${y1 - r} Q${from.x},${y1} ${from.x + r},${y1} L${gx - r},${y1} Q${gx},${y1} ${gx},${y1 + r} L${gx},${low - r} Q${gx},${low} ${gx - r},${low} L${to.x - dir * r},${low} Q${to.x},${low} ${to.x},${low - r} L${to.x},${to.y}`;
        })()
        : `M${from.x},${from.y + 7} L${from.x},${low - r} Q${from.x},${low} ${from.x + dir * r},${low} L${to.x - dir * r},${low} Q${to.x},${low} ${to.x},${low - r} L${to.x},${to.y}`;
      const g = edgeGroup(edge, d, true);
      const label = svgEl('text', { x: (from.x + to.x) / 2, y: low - 5, class: 'pipe-fail-caption', 'text-anchor': 'middle' });
      label.textContent = `✕ not right → back to ${typeOf(nodeOf(edge.to)?.type)?.name || edge.to} (up to ${gate.rounds}×)`;
      g.appendChild(label);
    });
  };

  // Moves everything to where layout() says, then redraws the lines.
  const place = () => {
    layoutNow = layout();
    const { task, done, width, height } = layoutNow;
    surface.style.width = `${width}px`;
    surface.style.height = `${height}px`;
    svg.setAttribute('width', width);
    svg.setAttribute('height', height);
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

  // ---------- tidying up ----------
  // Columns by the longest way from Your task over the normal connections,
  // so every card sits right of everything that feeds it (Ask the user
  // between the analyst and the planner gets its own column between
  // theirs). Within a column, cards are ordered by where the cards feeding
  // them are (fewer crossings) and stacked around one middle line, so a
  // single row is perfectly straight. Cards only reached by going back, or
  // not at all, go in a row underneath.
  const TIDY_GAP_X = 64;
  const TIDY_GAP_Y = 40;
  const TIDY_X = PIPE_TERM_W + 100;
  const TIDY_Y = 120;
  const tidyTargets = () => {
    const normal = cfg.edges.filter(e => !P.isFail(e));
    const depth = new Map();
    // Longest path (the normal connections have no circles once valid; a
    // circle stops after as many passes as there are cards).
    for (const n of cfg.nodes) if (normal.some(e => e.from === P.TASK && e.to === n.id)) depth.set(n.id, 0);
    for (let pass = 0; pass < cfg.nodes.length; pass++) {
      let moved = false;
      for (const e of normal) {
        if (e.from === P.TASK || e.to === P.DONE || !depth.has(e.from)) continue;
        const d = depth.get(e.from) + 1;
        if (!depth.has(e.to) || depth.get(e.to) < d) { depth.set(e.to, d); moved = true; }
      }
      if (!moved) break;
    }
    const columns = [];
    for (const [id, d] of depth) (columns[d] = columns[d] || []).push(id);
    const placed = new Map();
    const order = new Map();
    let x = TIDY_X;
    for (const column of columns.filter(Boolean)) {
      const fed = id => {
        const from = normal.filter(e => e.to === id && order.has(e.from)).map(e => order.get(e.from));
        return from.length ? from.reduce((a, b) => a + b, 0) / from.length : nodeOf(id).y / 1000;
      };
      column.sort((a, b) => fed(a) - fed(b) || nodeOf(a).y - nodeOf(b).y);
      column.forEach((id, i) => order.set(id, i));
      const total = column.reduce((sum, id) => sum + heightOf(id), 0) + (column.length - 1) * TIDY_GAP_Y;
      // One card: its top on the row, so ports (a fixed distance below a
      // card's top) line up. Several: stacked around the row's middle.
      let y = column.length === 1 ? TIDY_Y : TIDY_Y + heightOf(column[0]) / 2 - total / 2;
      for (const id of column) { placed.set(id, { x, y }); y += heightOf(id) + TIDY_GAP_Y; }
      x += PIPE_NODE_W + TIDY_GAP_X;
    }
    // The rest: a row under everything.
    const rest = cfg.nodes.filter(n => !placed.has(n.id)).sort((a, b) => a.x - b.x);
    if (rest.length) {
      const below = Math.max(...[...placed].map(([id, p]) => p.y + heightOf(id)), TIDY_Y) + 90 + cfg.edges.filter(P.isFail).length * 16;
      rest.forEach((n, i) => placed.set(n.id, { x: TIDY_X + i * (PIPE_NODE_W + TIDY_GAP_X), y: below }));
    }
    // Room above the top row for connections that go over the cards.
    const topY = Math.min(...[...placed.values()].map(p => p.y));
    const lanes = normal.filter(e => e.from !== P.TASK && e.to !== P.DONE && (depth.get(e.to) ?? 0) - (depth.get(e.from) ?? 0) > 1).length;
    const shift = Math.max(0, 90 + lanes * 14 - topY);
    if (shift) for (const p of placed.values()) p.y += shift;
    return placed;
  };
  const tidy = () => {
    const targets = tidyTargets();
    const from = new Map(cfg.nodes.map(n => [n.id, { x: n.x, y: n.y }]));
    const start = performance.now();
    const ease = t => 1 - Math.pow(1 - t, 3);
    window.uiSound?.('tick');
    const step = now => {
      const t = Math.min(1, (now - start) / 320);
      for (const n of cfg.nodes) {
        const a = from.get(n.id), b = targets.get(n.id);
        if (!b) continue;
        n.x = Math.round(a.x + (b.x - a.x) * ease(t));
        n.y = Math.round(a.y + (b.y - a.y) * ease(t));
      }
      place();
      if (t < 1) requestAnimationFrame(step);
      else scroller.scrollTo({ left: 0, top: 0, behavior: 'smooth' });
    };
    requestAnimationFrame(step);
  };
  tidyBtn.onclick = tidy;

  // ---------- the whole canvas ----------
  const render = () => {
    for (const c of surface.querySelectorAll('.pipe-node, .pipe-term')) c.remove();
    cards.clear();
    cards.set(P.TASK, terminal(P.TASK, '✉ Your task', 'Your message to the agent'));
    cards.set(P.DONE, terminal(P.DONE, '✓ Done', 'What reaches Done is the result of the pipeline'));
    for (const n of cfg.nodes) cards.set(n.id, nodeCard(n));
    for (const [, card] of cards) surface.appendChild(card);
    place();
    // Card heights are known once they are on screen: the ✕ lines need them.
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
    cfg.nodes.push({ id, type, count: 1, note: '', rounds: 3, ...(x > 1300 ? { x: 200, y: right.y + 200 } : { x, y: right.y }) });
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
      const used = cfg.nodes.filter(n => n.type === t.id).length;
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
      // Your own types: a sub-agent or a stop to ask you, and whether it
      // gives a verdict (a ✕ "not right" output on its cards).
      const kind = settingsSelect([['agent', 'A sub-agent'], ['ask', 'Ask the user (the governor stops)']], t.kind || 'agent');
      kind.onchange = () => { t.kind = kind.value; if (t.kind === 'ask') t.verdict = true; renderTypes(t.id); render(); };
      const verdict = settingsInput('checkbox', t.verdict);
      verdict.onchange = () => {
        t.verdict = verdict.checked;
        if (!t.verdict) cfg.edges = cfg.edges.filter(e => !(P.isFail(e) && nodeOf(e.from)?.type === t.id));
        renderTypes(t.id);
        render();
      };
      const prompt = settingsText(t.prompt, t.kind === 'ask' ? 'What the governor shows you and asks before it goes on' : 'Its instructions: what it does, what it must not do, and what its answer contains');
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
      const ask = t.kind === 'ask';
      item.append(
        settingsField('Name', null, name),
        settingsField('Description', 'The governor reads this to know what the agent is for', desc),
        ...(t.builtin ? [] : [settingsField('Kind', 'Ask the user: the governor stops, shows you where things stand and waits for your answer or approval', kind)]),
        ...(ask ? [] : [
          settingsField('Model', 'Same as the agent: the model the pipeline agent runs on', model),
          settingsField('Effort', 'How hard it thinks. Higher: better on hard steps (planning, review), slower and more tokens', effort),
          settingsField('Tools', 'Read only: it can look but not change files. Read + shell: it can run commands too', tools),
          ...(t.builtin ? [] : [settingsField('Gives a verdict', 'Its cards get a ✕ "not right" output that sends the work back to an earlier step. Its answer starts with VERDICT: APPROVE or VERDICT: CHANGES', verdict)]),
        ]),
        settingsField(ask ? 'What it shows and asks' : 'Instructions', null, prompt),
        actions);
      typesBox.appendChild(item);
    }
    const create = el('button', 'settings-btn pipe-type-new', '+ New agent type');
    create.type = 'button';
    create.onclick = () => {
      const id = newId('custom-', new Set(cfg.types.map(t => t.id)));
      cfg.types.push({ id, name: 'New agent', description: '', prompt: '', model: 'inherit', tools: 'all', effort: '', kind: 'agent', verdict: false, builtin: false });
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

    const sub = Object.entries(e.perType).filter(([id]) => typeOf(id)?.kind !== 'ask' && cfg.nodes.some(n => n.type === id));
    const biggest = sub.reduce((max, [, v]) => Math.max(max, v.total), 0);
    const tiles = el('div', 'pipe-stats');
    const approx = e.measured ? '' : '≈';
    tiles.append(
      stat('Governor, each request', approx + fmt(e.governor), 'The context the governor sends with every request before any work: Claude Code\'s and Agent Hub\'s instructions, the pipeline\'s, its tools and the instruction files', 'main'),
      stat('Largest sub-agent, each request', approx + fmt(biggest), 'Its instructions, its tools and the instruction files; the inputs the governor gives it come on top'),
      stat(`Whole run, first time through (${e.agents + 1} agents${e.asks ? `, stops to ask you ${e.asks}×` : ''})`, approx + fmt(e.oneRound), 'Every agent\'s first request added up: the governor and each step × its count'),
      stat(e.rounds > 1 ? 'Whole run, sent back every time' : 'Whole run, nothing sent back', approx + fmt(e.worst), 'When every ✕ "not right" is taken as often as it may be: the steps from the one it goes back to, up to the one that sends it back, run again', e.rounds > 1 ? 'warn' : ''));
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
      const runs = cfg.nodes.filter(n => n.type === id).reduce((s2, n) => s2 + n.count, 0);
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
