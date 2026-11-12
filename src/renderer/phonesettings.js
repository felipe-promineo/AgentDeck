// Settings → Phone: the phone app's connection (remote/host.js).
//
// The relay is a small server both this computer and your phone connect to
// (relay/ in this repository). Pairing shows a QR code with the relay's
// address and a key only this computer and that phone get; you scan it in
// the phone app. These settings apply at once, without Save.

function phonePanel() {
  const box = el('div', 'settings-phone');

  const relay = settingsInput('text', '', { placeholder: 'wss://relay.example.com', spellcheck: false });
  const enabled = settingsInput('checkbox', false);
  const state = el('div', 'phone-state');
  const pairBtn = el('button', null, 'Pair a phone…');
  pairBtn.type = 'button';
  const qrBox = el('div', 'phone-qr hidden');
  const devices = el('div', 'phone-devices');

  box.append(
    settingsField('Relay', 'The address of your relay server (relay/ in this repository). The relay only forwards messages it cannot read: they are encrypted between this computer and each phone', relay),
    settingsField('Connect to the relay', 'Your phones can reach Agent Hub while this is on and the app is open', enabled),
    state,
    el('div', 'settings-name phone-devices-title', 'Paired phones'),
    devices,
    pairBtn,
    qrBox,
  );

  let status = null;
  const render = s => {
    status = s;
    if (document.activeElement !== relay) relay.value = s.relay || '';
    enabled.checked = !!s.enabled;
    state.className = 'phone-state ' + (s.connected ? 'ok' : s.enabled && s.relay ? 'err' : '');
    state.textContent = !s.enabled ? 'Off: phones cannot connect.'
      : !s.relay ? 'Set the relay address above.'
      : s.connected ? 'Connected to the relay.'
      : s.error || 'Connecting to the relay…';
    devices.replaceChildren();
    if (!s.devices.length) devices.appendChild(el('div', 'settings-hint', 'No phone yet.'));
    for (const d of s.devices) {
      const row = el('div', 'phone-device');
      row.append(
        el('span', 'phone-dot' + (d.online ? ' on' : '')),
        el('span', 'phone-name', d.name || 'Phone'),
        el('span', 'settings-hint', d.online ? 'connected now' : d.lastSeen ? `last seen ${new Date(d.lastSeen).toLocaleString()}` : ''),
      );
      const remove = el('button', 'link', 'Remove');
      remove.type = 'button';
      remove.onclick = async () => render(await window.deck.remoteRemoveDevice(d.id));
      row.appendChild(remove);
      devices.appendChild(row);
    }
    // The QR code goes away once its phone has connected.
    if (qrBox.dataset.device && s.devices.some(d => d.id === qrBox.dataset.device)) {
      qrBox.classList.add('hidden');
      delete qrBox.dataset.device;
    }
    pairBtn.disabled = !s.relay;
  };

  const configure = async values => render(await window.deck.remoteConfigure(values));
  relay.addEventListener('change', () => configure({ relay: relay.value, enabled: relay.value.trim() ? true : enabled.checked }));
  enabled.addEventListener('change', () => configure({ enabled: enabled.checked }));

  pairBtn.onclick = async () => {
    if (!status?.enabled) await configure({ enabled: true });
    let p;
    try { p = await window.deck.remotePair(); } catch (err) {
      qrBox.classList.remove('hidden');
      qrBox.replaceChildren(el('div', 'settings-hint', String(err?.message || err)));
      return;
    }
    qrBox.dataset.device = p.deviceId;
    qrBox.classList.remove('hidden');
    const qr = qrcode(0, 'M');
    qr.addData(p.link);
    qr.make();
    const pic = el('div', 'phone-qr-code');
    pic.innerHTML = qr.createSvgTag({ cellSize: 4, margin: 4, scalable: true });
    const copy = el('button', 'link', 'Copy the pairing link instead');
    copy.type = 'button';
    copy.onclick = () => { window.deck.copyText(p.link); copy.textContent = 'Copied'; };
    qrBox.replaceChildren(pic, el('div', 'settings-hint',
      `Open Agent Hub on your phone and scan this code. It works once, until ${new Date(p.expiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}.`), copy);
  };

  window.deck.remoteStatus().then(render).catch(() => {});
  const off = window.deck.onRemoteStatus(s => { if (box.isConnected) render(s); else off?.(); });
  return box;
}
