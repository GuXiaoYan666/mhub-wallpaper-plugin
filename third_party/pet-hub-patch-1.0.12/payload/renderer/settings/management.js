(function () {
  'use strict';
  window.PetManagement = { init };
  function init(options) {
    const { ipc, IPC, t, getState, applyState, notify } = options;
    const app = document.getElementById('app');
    const backdrop = document.createElement('div'); backdrop.id = 'managementDialog'; backdrop.className = 'dialog-backdrop';
    const dialog = document.createElement('div'); dialog.className = 'dialog management-dialog'; dialog.setAttribute('role', 'dialog'); dialog.setAttribute('aria-modal', 'true'); dialog.setAttribute('aria-labelledby', 'managementTitle');
    const title = document.createElement('h3'); title.id = 'managementTitle'; title.className = 'dialog-title';
    const tabs = document.createElement('div'); tabs.className = 'segmented management-tabs'; tabs.setAttribute('role', 'tablist'); tabs.setAttribute('aria-label', t('managementTitle'));
    const content = document.createElement('div'); content.className = 'management-content';
    content.id = 'managementContent'; content.setAttribute('role', 'tabpanel');
    const status = document.createElement('p'); status.id = 'managementStatus'; status.className = 'management-status'; status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
    const actions = document.createElement('div'); actions.className = 'name-actions';
    const close = button('managementClose', () => hide()); close.id = 'managementClose'; actions.append(close);
    dialog.append(title, tabs, content, status, actions); backdrop.append(dialog); document.body.append(backdrop);
    let mode = '', returnFocus, busy = false, epoch = 0, prepared = null, preparing = false;
    function text(tag, value, parent) { const el = document.createElement(tag); el.textContent = value; if (parent) parent.append(el); return el; }
    function button(key, fn, primary) { const el = document.createElement('button'); el.type = 'button'; el.className = primary ? 'primary-button' : 'ghost-button'; el.textContent = t(key); el.addEventListener('click', fn); return el; }
    function message(value, error) { status.textContent = value; status.classList.toggle('is-error', !!error); status.setAttribute('role', error ? 'alert' : 'status'); }
    function disabled(value) { busy = value; content.querySelectorAll('button').forEach(node => { node.disabled = value || !!prepared && !node.closest('#restoreConfirmation'); }); tabs.querySelectorAll('button').forEach(node => { node.disabled = value || !!prepared; }); content.setAttribute('aria-busy', String(value)); }
    function errorText(code) { const key = 'management_' + String(code || '').replace(/-/g, '_'); return ['bad_image', 'bad_backup', 'exists', 'too_large', 'no_permission'].includes(String(code || '').replace(/-/g, '_')) ? t(key) : t('managementFailed'); }
    async function request(action, payload) {
      const result = await ipc.invoke(IPC.MANAGE, { action, ...payload });
      if (!result || (!result.ok && !result.cancelled)) throw Object.assign(new Error('operation failed'), { code: result && result.error });
      return result;
    }
    async function task(fn, success) {
      if (busy) return; const ticket = epoch; disabled(true); message(t('managementWorking'));
      try { const result = await fn(); if (ticket !== epoch) return; if (!result.cancelled && success) message(t(success)); else if (result.cancelled) message(''); return result; }
      catch (error) { if (ticket === epoch) message(errorText(error.code), true); }
      finally { if (ticket === epoch) { disabled(false); if (backdrop.hasAttribute('data-open') && !backdrop.contains(document.activeElement)) close.focus(); } }
    }
    function hide() {
      // Preparing can be cancelled; a confirmed restore is a short atomic commit.
      if (busy && !preparing) return;
      if (prepared || preparing) ipc.invoke(IPC.MANAGE, { action: 'backup-cancel' }).catch(() => {});
      prepared = null; preparing = false; epoch++; busy = false;
      backdrop.removeAttribute('data-open'); app.inert = false; if (returnFocus && returnFocus.isConnected) returnFocus.focus();
    }
    async function show(which) {
      if (app.inert || busy) return;
      returnFocus = document.activeElement; mode = which; epoch++; prepared = null; content.replaceChildren(); message(''); close.textContent = t('managementClose');
      title.textContent = t('managementTitle');
      backdrop.setAttribute('data-open', ''); app.inert = true; close.focus();
      await selectMode(which);
    }
    async function selectMode(which) {
      if (busy || prepared) return;
      mode = which; epoch++; content.replaceChildren(); message('');
      tabs.querySelectorAll('button').forEach(node => { const selected = node.dataset.mode === which; node.classList.toggle('is-active', selected); node.setAttribute('aria-selected', String(selected)); node.tabIndex = selected ? 0 : -1; });
      content.setAttribute('aria-labelledby', 'management-tab-' + which);
      if (which === 'diagnostics') await renderDiagnostics();
      else if (which === 'release') { text('h4', t('releaseTitle'), content); text('p', t('releaseNotes'), content); buildInfo(); }
      else await renderBackup();
    }
    function buildInfo() {
      const data = getState(), build = data && data.buildInfo;
      text('p', (data && data.pluginVersion || '—') + (build && build.build ? ' · ' + build.build : ''), content);
    }
    async function renderBackup() {
      content.replaceChildren(); const section = document.createElement('section'); content.append(section);
      text('h4', t('backupSection'), section); text('p', t('backupDesc'), section);
      const row = document.createElement('div'); row.className = 'management-buttons'; section.append(row);
      row.append(button('backupExport', () => task(() => request('backup-export'), 'backupSuccess')),
        button('backupImport', async () => {
          preparing = true;
          const result = await task(() => request('backup-prepare'));
          preparing = false;
          if (!result || result.cancelled || !backdrop.hasAttribute('data-open')) return;
          prepared = result; message('');
          const box = document.createElement('section'); box.className = 'management-confirm'; box.id = 'restoreConfirmation';
          text('h4', t('restoreTitle'), box); text('p', t('restoreSummary', result), box);
          const choices = document.createElement('div'); choices.className = 'management-buttons';
          choices.append(button('restoreCancel', async () => { const result = await task(() => request('backup-cancel')); if (result) { prepared = null; box.remove(); disabled(false); row.lastChild.focus(); } }),
            button('restoreConfirm', async () => { const result = await task(() => request('backup-commit', { token: prepared.token }), 'restoreSuccess'); if (result) { prepared = null; applyState(result.state); box.remove(); disabled(false); row.lastChild.focus(); } }, true));
          box.append(choices); section.after(box); disabled(false); choices.firstChild.focus();
        }));
      const trash = document.createElement('section'); trash.id = 'recycleBin'; content.append(trash);
      text('h4', t('trashTitle'), trash); text('p', t('trashDesc'), trash);
      const ticket = epoch; message(t('managementLoading'));
      try {
        const result = await request('trash-list'); if (ticket !== epoch) return;
        if (!result.items || !result.items.length) text('p', t('trashEmpty'), trash);
        (result.items || []).forEach(item => {
          const row = document.createElement('div'); row.className = 'management-item';
          const label = text('span', item.name || item.id, row); text('small', new Date(item.deletedAt).toLocaleString(), label);
          row.append(button('trashRestore', async () => { const result = await task(() => request('trash-restore', { token: item.token }), 'trashRestored'); if (result) { applyState(result.state); await renderBackup(); message(t('trashRestored')); } })); trash.append(row);
        });
        message('');
      } catch (error) { if (ticket === epoch) message(errorText(error.code), true); }
    }
    function reason(key) { return t('reason_' + String(key).replace(/-/g, '_')); }
    async function renderDiagnostics() {
      const ticket = epoch; content.replaceChildren();
      const controls = document.createElement('div'); controls.className = 'management-buttons'; content.append(controls);
      controls.append(button('diagnosticRefresh', renderDiagnostics), button('diagnosticReconnect', async () => {
        const result = await task(() => ipc.invoke(IPC.RECONNECT)); if (result) message(t('diagnosticReconnecting'));
      }), button('diagnosticExport', () => task(() => request('diagnostics-export'), 'diagnosticExported')));
      message(t('managementLoading'));
      try {
        const result = await ipc.invoke(IPC.DIAGNOSTICS); if (ticket !== epoch) return;
        if (!result || !result.ok || !result.data) throw Error('diagnostics unavailable');
        const data = result.data, state = data.channel && data.channel.state || 'connecting';
        text('h4', t('channel_' + (['connected', 'connecting', 'retrying', 'failed', 'disconnected'].includes(state) ? state : 'failed')), content);
        const reasons = document.createElement('ul'); reasons.className = 'management-list'; content.append(reasons);
        (data.reasons || []).forEach(key => text('li', reason(key), reasons));
        if (!reasons.children.length) text('p', t('diagnosticReady'), content);
        const details = document.createElement('details'); text('summary', t('diagnosticCompatibility'), details); text('p', t('diagnosticAudio'), details); content.append(details);
        if (data.audio && data.audio.failed) text('p', t('diagnosticAudioFailed'), content);
        text('h4', t('diagnosticDevices'), content);
        if (!data.devices.length) text('p', t('diagnosticNoDevices'), content);
        data.devices.forEach(device => text('p', device.name + ' · ' + t('type_' + (['keyboard', 'mouse', 'speaker', 'headset'].includes(device.type) ? device.type : 'unknown')), content));
        text('p', data.lastMessageAt ? t('diagnosticLastMessage', { time: new Date(data.lastMessageAt).toLocaleTimeString() }) : t('diagnosticNoMessage'), content);
        text('h4', t('diagnosticRecent'), content);
        if (!(data.recent || []).length && !(data.adapter && data.adapter.lastRejected)) text('p', t('diagnosticNoMessage'), content);
        (data.recent || []).slice(-5).reverse().forEach(event => text('p', new Date(event.at).toLocaleTimeString() + ' · ' + event.text + ' · ' + (event.delivered ? t('diagnosticDelivered') : reason(event.reason)), content));
        if (data.adapter && data.adapter.lastRejected) { const rejected = data.adapter.lastRejected; text('p', new Date(rejected.at).toLocaleTimeString() + ' · ' + t('diagnosticSuppressed') + ' · ' + reason(rejected.reason), content); }
        message('');
      } catch (_) { if (ticket === epoch) message(t('managementFailed'), true); }
    }
    [['backup', 'backupTitle'], ['diagnostics', 'diagnosticsTitle'], ['release', 'managementVersion']].forEach(([id, label]) => {
      const tab = button(label, () => selectMode(id)); tab.id = 'management-tab-' + id; tab.dataset.mode = id; tab.className = 'segmented-item'; tab.setAttribute('role', 'tab'); tab.setAttribute('aria-controls', content.id); tabs.append(tab);
      tab.addEventListener('keydown', event => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key) || busy || prepared) return;
        event.preventDefault(); const buttons = Array.from(tabs.children), at = buttons.indexOf(tab);
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (at + (event.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length;
        buttons[next].focus(); selectMode(buttons[next].dataset.mode);
      });
    });
    const entries = document.createElement('div'); entries.className = 'desktop-tools'; entries.dataset.tab = 'desktop'; entries.dataset.key = 'managementTools';
    [['backupEntry', 'backupTitle', 'backup'], ['diagnosticsEntry', 'diagnosticsTitle', 'diagnostics']].forEach(([id, label, which]) => {
      const entry = button(label, () => {
        tabs.querySelectorAll('button').forEach(node => { node.textContent = t(node.dataset.mode === 'backup' ? 'backupTitle' : node.dataset.mode === 'diagnostics' ? 'diagnosticsTitle' : 'managementVersion'); node.disabled = false; }); show(which);
      });
      entry.id = id; entry.dataset.i18n = label; entries.append(entry);
    });
    document.getElementById('toggles').append(entries);
    backdrop.addEventListener('mousedown', event => { if (event.target === backdrop) hide(); });
    document.addEventListener('keydown', event => {
      if (!backdrop.hasAttribute('data-open')) return;
      if (event.key === 'Escape') { event.preventDefault(); hide(); }
      if (event.key === 'Tab') {
        const nodes = Array.from(dialog.querySelectorAll('button:not(:disabled)')).filter(node => node.getClientRects().length);
        if (!nodes.length) { event.preventDefault(); return; }
        const first = nodes[0], last = nodes[nodes.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }
    });
  }
})();
