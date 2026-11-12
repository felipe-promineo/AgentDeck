// What the Mac window and the phone app share to draw the same chats
// (remote.js on the Mac, mobile/ on the phone).
//
// A chat on the phone is drawn by the same Transcript class (render.js): the
// Mac records every call the app makes on a chat's Transcript (add a message,
// a note, a permission card, the Changes card…) and the phone makes the same
// calls on its own copy. Arguments go over as JSON: a turn becomes its
// number in the chat, a function (the Allow/Deny answer of a permission card)
// becomes a key the phone sends back when it is called.

(function () {
  // The Transcript methods the app calls from outside (app.js); calls they
  // make inside the Transcript are not recorded, the phone's copy makes them
  // itself.
  const MIRRORED = ['add', 'note', 'noteIn', 'finishTurn', 'startTurn', 'showDiff', 'truncateAt', 'permission', 'question',
    'cancelPermission', 'settlePermission', 'showGitChanges', 'showMedia', 'restoreChanges', 'addStreamEvent', 'clearDraft'];

  const T = window.Transcript.prototype;

  // Every turn gets its number in its chat, on the Mac and on the phone alike,
  // so a call about "turn 3" means the same turn on both.
  const startTurn = T.startTurn;
  T.startTurn = function (...args) {
    const turn = startTurn.apply(this, args);
    this.turnCount = (this.turnCount || 0) + 1;
    turn.mirrorId = this.turnCount;
    this.turnsById = this.turnsById || new Map();
    this.turnsById.set(turn.mirrorId, turn);
    return turn;
  };

  // A permission or question card that was answered elsewhere (on the other
  // device): it shows the answer and has no buttons any more.
  T.settlePermission = function (requestId, label, ok) {
    const card = this.root.querySelector(`.permission[data-request-id="${CSS.escape(String(requestId))}"]`);
    if (!card || card.classList.contains('answered')) return;
    const result = document.createElement('div');
    result.className = 'perm-result' + (ok === true ? ' ok' : ok === false ? ' err' : '');
    result.textContent = label;
    const buttons = card.querySelector('.perm-buttons, .question-actions, .q-actions');
    if (buttons) buttons.replaceWith(result);
    else card.appendChild(result);
    card.classList.add('answered');
    card.querySelectorAll('button, input, textarea').forEach(b => { b.disabled = true; });
  };

  // What a permission decision shows on the card that did not get it.
  function decisionLabel(d) {
    if (!d) return 'Answered';
    if (d.behavior === 'deny') return 'Denied';
    if (d.updatedInput?.answers) return 'Answered';
    if (d.updatedPermissions?.length) return 'Allowed (and remembered)';
    return 'Allowed';
  }

  // ---------- to JSON and back ----------

  function encode(value, fnKey, seen = new WeakSet(), depth = 0) {
    if (value == null || typeof value === 'number' || typeof value === 'boolean' || typeof value === 'string') return value;
    if (typeof value === 'function') return fnKey ? { __fn: fnKey(value) } : null;
    if (typeof value !== 'object' || depth > 40) return null;
    if (typeof Node !== 'undefined' && value instanceof Node) return null;
    if (seen.has(value)) return null;
    seen.add(value);
    if (value.mirrorId && value.el && value.live) return { __turn: value.mirrorId };
    if (value instanceof Map) return { __map: [...value].map(([k, v]) => [encode(k, fnKey, seen, depth + 1), encode(v, fnKey, seen, depth + 1)]) };
    if (value instanceof Set) return { __set: [...value].map(v => encode(v, fnKey, seen, depth + 1)) };
    if (Array.isArray(value)) return value.map(v => encode(v, fnKey, seen, depth + 1));
    if (value instanceof Date) return value.getTime();
    if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return null;
    const out = {};
    for (const k of Object.keys(value)) out[k] = encode(value[k], fnKey, seen, depth + 1);
    return out;
  }

  function decode(value, transcript, callFn) {
    if (value == null || typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.map(v => decode(v, transcript, callFn));
    if ('__fn' in value) return (...args) => callFn(value.__fn, args);
    if ('__turn' in value) return transcript.turnsById?.get(value.__turn) || null;
    if ('__map' in value) return new Map(value.__map.map(([k, v]) => [decode(k, transcript, callFn), decode(v, transcript, callFn)]));
    if ('__set' in value) return new Set(value.__set.map(v => decode(v, transcript, callFn)));
    const out = {};
    for (const k of Object.keys(value)) out[k] = decode(value[k], transcript, callFn);
    return out;
  }

  // Makes one recorded call on a Transcript (the phone's copy).
  function replay(transcript, op, callFn) {
    if (!MIRRORED.includes(op.m) || typeof transcript[op.m] !== 'function') return;
    try {
      transcript[op.m](...decode(op.a || [], transcript, callFn));
    } catch (err) {
      console.warn('mirror: could not replay', op.m, err);
    }
  }

  window.mirror = { MIRRORED, encode, decode, replay, decisionLabel };
})();
