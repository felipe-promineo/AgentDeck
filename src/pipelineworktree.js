// Git worktrees for pipeline steps that change files at the same time
// (pipelinerun.js): several implementers of one step, or parallel steps that
// edit. Each agent works in a worktree of its own (Claude Code's Agent tool,
// isolation "worktree"), so they never write over each other's files, and
// Agent Hub merges each one's changes back into the folder when it finishes.
//
// Claude Code makes the worktree from the last commit, which does not have
// the folder's uncommitted changes (the user's own, and the pipeline's
// earlier steps'). So before the agents start, `snapshot` records the folder
// as it is (a commit object nothing points to: the folder, its index and its
// branches are not touched), `prepare` puts that state into each new
// worktree, and `mergeBack` brings back only what the agent changed on top
// of it, file by file with a three-way merge: a file the folder still has as
// it was is replaced, one that changed in the meantime (another agent's work
// merged first) is merged with git merge-file, and overlapping changes are
// left with conflict markers and reported.

const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { randomUUID } = require('crypto');

// Claude Code keeps its worktrees in the folder: never part of a snapshot.
const EXCLUDE = ':(exclude).claude/worktrees';

function git(args, { cwd, env, encoding = 'utf8' } = {}) {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, env: env || process.env, encoding, maxBuffer: 256 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      if (err) {
        err.stdout = stdout;
        err.stderr = String(stderr || '');
        reject(err);
      } else resolve(stdout);
    });
  });
}

// Whether `cwd` is in a git work tree with at least one commit.
async function usable(cwd) {
  try {
    if ((await git(['rev-parse', '--is-inside-work-tree'], { cwd })).trim() !== 'true') return false;
    await git(['rev-parse', '--verify', '-q', 'HEAD'], { cwd });
    return true;
  } catch {
    return false;
  }
}

// The folder as it is now, tracked and untracked files (not ignored ones),
// as a commit object on top of HEAD. A copy of the index is used, so the
// user's own index stays as it is.
async function snapshot(cwd) {
  const top = (await git(['rev-parse', '--show-toplevel'], { cwd })).trim();
  const index = path.resolve(top, (await git(['rev-parse', '--git-path', 'index'], { cwd: top })).trim());
  const temp = path.join(os.tmpdir(), `agenthub-index-${randomUUID()}`);
  try {
    if (fs.existsSync(index)) fs.copyFileSync(index, temp);
    const env = { ...process.env, GIT_INDEX_FILE: temp };
    await git(['add', '-A', '--', '.', EXCLUDE], { cwd: top, env });
    const tree = (await git(['write-tree'], { cwd: top, env })).trim();
    const commit = (await git(['commit-tree', tree, '-p', 'HEAD', '-m', 'Agent Hub pipeline snapshot'], { cwd: top })).trim();
    return { sha: commit, top };
  } finally {
    fs.rmSync(temp, { force: true });
  }
}

// Puts the snapshot's files into a new worktree, so the agent starts from
// the folder as it was. Its index goes back to the last commit, so git
// status there reads like the folder's: the user's new files untracked, their
// changes not staged (a staged NOTES.md would puzzle the agents).
async function prepare(worktree, sha) {
  await git(['read-tree', '-u', '--reset', sha], { cwd: worktree });
  await git(['reset', '-q'], { cwd: worktree });
}

// Claude Code's worktree of a sub-agent (by its agent id), or null.
async function findWorktree(cwd, agentId) {
  if (!/^[\w-]+$/.test(String(agentId || ''))) return null;
  let list;
  try { list = await git(['worktree', 'list', '--porcelain'], { cwd }); } catch { return null; }
  for (const entry of list.split(/\n\n+/)) {
    const wt = /^worktree (.+)$/m.exec(entry)?.[1];
    const branch = /^branch refs\/heads\/(.+)$/m.exec(entry)?.[1] || '';
    if (wt && (branch === `worktree-agent-${agentId}` || path.basename(wt) === `agent-${agentId}`)) return { path: wt, branch };
  }
  return null;
}

const same = (a, b) => (a === null || b === null ? a === b : a.equals(b));
const binary = buf => !!buf && buf.subarray(0, 8000).includes(0);

// What the agent changed in its worktree on top of the snapshot, merged into
// the folder. Resolves with { merged: [file], conflicts: [{ file, why }] }.
// `label` names the agent in conflict markers.
async function mergeBack(cwd, worktree, sha, label = 'agent') {
  const top = (await git(['rev-parse', '--show-toplevel'], { cwd })).trim();
  await git(['add', '-A', '--', '.', EXCLUDE], { cwd: worktree });
  const raw = await git(['diff', '--cached', '--name-status', '--no-renames', '-z', sha], { cwd: worktree });
  const parts = raw.split('\0').filter(Boolean);
  const merged = [];
  const conflicts = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const status = parts[i][0];
    const file = parts[i + 1];
    const ours = path.join(top, file);
    const read = f => (fs.existsSync(f) && fs.statSync(f).isFile() ? fs.readFileSync(f) : null);
    const base = status === 'A' ? null : await git(['show', `${sha}:${file}`], { cwd: top, encoding: 'buffer' }).catch(() => null);
    const theirs = status === 'D' ? null : read(path.join(worktree, file));
    const now = read(ours);
    const write = buf => {
      if (buf === null) fs.rmSync(ours, { force: true });
      else {
        fs.mkdirSync(path.dirname(ours), { recursive: true });
        fs.writeFileSync(ours, buf);
      }
    };
    if (same(now, theirs)) continue;
    // The folder still has it as the agent found it: take the agent's.
    if (same(now, base)) { write(theirs); merged.push(file); continue; }
    if (now === null || theirs === null || binary(now) || binary(theirs) || binary(base)) {
      conflicts.push({ file, why: now === null ? 'deleted in the folder meanwhile' : theirs === null ? `${label} deleted it, but it changed in the folder meanwhile` : 'a binary file changed on both sides' });
      continue;
    }
    // Changed on both sides: a three-way merge.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-merge-'));
    try {
      const [o, b, t] = ['ours', 'base', 'theirs'].map(n => path.join(dir, n));
      fs.writeFileSync(o, now);
      fs.writeFileSync(b, base || Buffer.alloc(0));
      fs.writeFileSync(t, theirs);
      let out;
      let clashes = 0;
      try {
        out = await git(['merge-file', '-p', '-L', 'folder', '-L', 'before', '-L', label, o, b, t], { cwd: top, encoding: 'buffer' });
      } catch (err) {
        // merge-file exits with the number of conflicts (an error is < 0).
        if (!(err.code > 0) || !err.stdout) throw err;
        out = err.stdout;
        clashes = err.code;
      }
      write(out);
      merged.push(file);
      if (clashes) conflicts.push({ file, why: `${clashes} overlapping change${clashes === 1 ? '' : 's'}, left with conflict markers` });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
  return { merged, conflicts };
}

// Removes a worktree and its branch (best effort).
async function remove(cwd, worktree, branch) {
  await git(['worktree', 'remove', '--force', worktree], { cwd }).catch(() => fs.rmSync(worktree, { recursive: true, force: true }));
  await git(['worktree', 'prune'], { cwd }).catch(() => {});
  if (branch) await git(['branch', '-D', branch], { cwd }).catch(() => {});
}

module.exports = { usable, snapshot, prepare, findWorktree, mergeBack, remove };
