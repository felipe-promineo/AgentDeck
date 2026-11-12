// window.deck on the phone: the same functions the computer's window has
// (src/preload.js), answered by the computer through the relay. The desktop
// files the phone uses (render.js, hub.js, diffview.js…) call them as they
// are.
//
// Calls that would act on the computer's screen (open a file there, show it
// in Finder, a native menu) do nothing here.

(function () {
  const LOCAL = {
    // Filled in from the computer's hello (phone.js).
    platform: 'darwin',
    revealLabel: '',
    openFile: async () => null,
    revealFile: async () => null,
    popupMenu: async () => null,
    titleDoubleClick: async () => null,
    notify: async () => null,
    copyText: async text => { try { await navigator.clipboard.writeText(String(text)); } catch { /* not allowed here */ } },
  };

  const listening = new Map();      // on… method -> Set(fn)
  window.link.on('message', msg => {
    if (msg.t !== 'event') return;
    for (const fn of listening.get(msg.method) || []) {
      try { fn(...(msg.args || [])); } catch (err) { console.error(err); }
    }
  });
  // After a reconnect the computer has to be told again which events to send.
  window.link.on('host', () => { for (const method of listening.keys()) window.link.call('listen', method).catch(() => {}); });

  window.deck = new Proxy(LOCAL, {
    get(target, name) {
      if (typeof name !== 'string') return undefined;
      if (name in target) return target[name];
      if (/^on[A-Z]/.test(name)) {
        return fn => {
          if (!listening.has(name)) {
            listening.set(name, new Set());
            if (window.link.state === 'online') window.link.call('listen', name).catch(() => {});
          }
          listening.get(name).add(fn);
          return () => listening.get(name)?.delete(fn);
        };
      }
      return (...args) => window.link.call('deck', name, args);
    },
  });
})();
