// The / commands you can type in the message box: Claude Code's custom
// commands and skills, with their descriptions, for the list that opens when
// a message starts with /. Claude Code runs them itself when a message
// starts with /name; this file only finds their names and descriptions.
//
// Where they are:
// - your own: ~/.claude/commands/**/*.md (a subfolder adds "folder:") and
//   ~/.claude/skills/<name>/SKILL.md
// - the project's: .claude/commands and .claude/skills in the agent's folder
//   and the folders above it
// - plugins (~/.claude/plugins/installed_plugins.json): their commands/ and
//   skills/ folders, named "plugin:name"; plugins you turned off in
//   ~/.claude/settings.json are left out.

const fs = require('fs');
const os = require('os');
const path = require('path');

const CLAUDE = path.join(os.homedir(), '.claude');

// The front matter's description, argument-hint and name (a few lines of
// YAML between --- lines at the top of the file).
function frontMatter(file) {
  let text;
  try {
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(8192);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    text = buf.slice(0, n).toString('utf8');
  } catch {
    return {};
  }
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  const out = {};
  if (m) {
    for (const key of ['name', 'description', 'argument-hint']) {
      const line = new RegExp(`^${key}:\\s*(.*)$`, 'm').exec(m[1]);
      if (line) out[key] = line[1].trim().replace(/^(['"])(.*)\1$/, '$2');
    }
  }
  // Without a description, the first line of text after the front matter.
  if (!out.description) {
    const body = (m ? text.slice(m[0].length) : text).split(/\r?\n/).map(l => l.replace(/^#+\s*/, '').trim()).find(Boolean);
    if (body) out.description = body;
  }
  if (out.description && out.description.length > 200) out.description = out.description.slice(0, 197) + '…';
  return out;
}

const readDir = dir => { try { return fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; } };

// commands/**/*.md: a file in a subfolder is "folder:name".
function commandsIn(dir, prefix, source, out, depth = 0) {
  for (const e of readDir(dir)) {
    const full = path.join(dir, e.name);
    if (e.isDirectory() && depth < 3) commandsIn(full, `${prefix}${e.name}:`, source, out, depth + 1);
    else if (e.isFile() && e.name.endsWith('.md')) {
      const fm = frontMatter(full);
      out.push({ name: prefix + e.name.slice(0, -3), description: fm.description || '', hint: fm['argument-hint'] || '', source, kind: 'command' });
    }
  }
}

function skillsIn(dir, prefix, source, out) {
  for (const e of readDir(dir)) {
    if (!e.isDirectory()) continue;
    const file = path.join(dir, e.name, 'SKILL.md');
    if (!fs.existsSync(file)) continue;
    const fm = frontMatter(file);
    // A name you can't type after / ("create view MVC") is only a label:
    // the skill is then run by its folder's name.
    const name = /^[\w:.-]+$/.test(fm.name || '') ? fm.name : e.name;
    out.push({ name: prefix + name, description: fm.description || '', hint: fm['argument-hint'] || '', source, kind: 'skill' });
  }
}

function plugins() {
  let installed;
  let enabled = {};
  try { installed = JSON.parse(fs.readFileSync(path.join(CLAUDE, 'plugins', 'installed_plugins.json'), 'utf8')).plugins || {}; } catch { return []; }
  try { enabled = JSON.parse(fs.readFileSync(path.join(CLAUDE, 'settings.json'), 'utf8')).enabledPlugins || {}; } catch {}
  const list = [];
  for (const [key, installs] of Object.entries(installed)) {
    if (enabled[key] === false) continue;
    const dir = (Array.isArray(installs) ? installs : []).map(i => i?.installPath).find(p => p && fs.existsSync(p));
    if (dir) list.push({ name: key.split('@')[0], dir });
  }
  return list;
}

// Resolves with [{ name, description, hint, source: 'project'|'user'|'plugin', kind: 'command'|'skill' }],
// without duplicates (the project's version of a name comes first).
function list(cwd) {
  const out = [];
  // The project's folders: the agent's folder and the ones above it, up to
  // (not including) your home folder.
  const home = path.resolve(os.homedir());
  let dir = typeof cwd === 'string' && cwd ? path.resolve(cwd) : null;
  for (let i = 0; dir && i < 8 && dir !== home && dir !== path.dirname(dir); i++, dir = path.dirname(dir)) {
    commandsIn(path.join(dir, '.claude', 'commands'), '', 'project', out);
    skillsIn(path.join(dir, '.claude', 'skills'), '', 'project', out);
  }
  commandsIn(path.join(CLAUDE, 'commands'), '', 'user', out);
  skillsIn(path.join(CLAUDE, 'skills'), '', 'user', out);
  for (const p of plugins()) {
    commandsIn(path.join(p.dir, 'commands'), `${p.name}:`, 'plugin', out);
    skillsIn(path.join(p.dir, 'skills'), `${p.name}:`, 'plugin', out);
  }
  const seen = new Set();
  return out.filter(c => c.name && !seen.has(c.name) && seen.add(c.name));
}

module.exports = { list };
