'use strict';
(() => {
  const root = document.querySelector('[data-emergency-app]');
  const alarmRoot = document.querySelector('[data-security-alarm]');
  if (!root && !alarmRoot) return;
  const mode = root?.dataset.emergencyApp || 'monitor';
  const csrf = document.querySelector('meta[name="csrf-token"]').content;
  const errorBox = root?.querySelector('[data-live-error]') || alarmRoot.querySelector('[data-live-error]');
  const list = root?.querySelector('[data-emergency-list]');
  const pending = new Map();
  const ringing = new Map();
  const dialog = alarmRoot?.querySelector('dialog');
  const handled = new Set();
  let audio, socket, soundEnabled = false, lastAlarmAt = 0, history = false, page = 1, filter = 'all', fetching = false, again = false, currentSignature = '';
  const activeTones = new Set();
  let dialogSignature = '';
  const date = value => new Intl.DateTimeFormat('en-PH', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Manila' }).format(new Date(value));
  const shortDate = value => new Intl.DateTimeFormat('en-PH', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Manila' }).format(new Date(value));
  const needsResponse = report => ['Submitted', 'Acknowledged'].includes(report.status);
  const statusClass = status => ({ Submitted: 'pending', Acknowledged: 'pending', Responding: 'responding', Resolved: 'resolved' })[status] || 'pending';
  function node(tag, text, className) { const el = document.createElement(tag); if (text !== undefined) el.textContent = text; if (className) el.className = className; return el; }
  function link(text, href) { const el = node('a', text, 'text-link'); el.href = href; return el; }
  function connectionText() {
    const state = !navigator.onLine ? 'offline' : socket?.connected ? 'connected' : 'reconnecting';
    const message = state === 'offline' ? 'Offline. Updates are paused.' : state === 'reconnecting' ? 'Reconnecting. Updates may be delayed.' : '';
    document.querySelectorAll('[data-connection]').forEach(indicator => {
      indicator.textContent = message;
      indicator.dataset.state = state;
      indicator.hidden = state === 'connected';
    });
  }
  async function get(url, options) {
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 10000);
    try {
      const response = await fetch(url, { credentials: 'same-origin', signal: controller.signal, ...options });
      if (response.redirected || response.status === 401 || response.status === 403) throw new Error('Session expired or access removed. Sign in again.');
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'The request failed.');
      return data;
    } finally { clearTimeout(timer); }
  }
  async function change(report, status, button) {
    button.disabled = true;
    try {
      await get('/security/reports/' + report.id + '/status', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-CSRF-Token': csrf }, body: JSON.stringify({ status }) });
      await refresh();
    } catch (error) { errorBox.textContent = error.message; }
    finally { button.disabled = false; }
  }
  function statusButton(report) {
    const statuses = ['Submitted', 'Acknowledged', 'Responding', 'Resolved'];
    const status = statuses[statuses.indexOf(report.status) + 1];
    if (!status) return null;
    const responding = ['Submitted', 'Acknowledged'].includes(report.status);
    const button = node('button', responding ? 'Respond to Emergency' : 'Mark ' + status, 'button emergency-button' + (responding ? '' : ' is-resolve'));
    button.type = 'button'; button.addEventListener('click', () => responding ? respond(report, button) : change(report, status, button)); return button;
  }
  function card(report) {
    const el = node('article', undefined, 'emergency-report');
    el.dataset.reportId = report.id;
    el.dataset.status = report.status;
    const meta = node('div', undefined, 'emergency-report-meta');
    meta.append(node('span', report.type, 'emergency-type'), node('span', needsResponse(report) ? 'Needs response' : report.status, 'emergency-status is-' + statusClass(report.status)));
    if (report.escalated_at && needsResponse(report)) meta.append(node('span', 'Escalated', 'emergency-escalated'));
    const time = node('time', shortDate(report.created_at)); time.dateTime = new Date(report.created_at).toISOString(); meta.append(time);
    el.append(meta, node('h3', report.location), node('p', report.description, 'emergency-description emergency-preview'));
    const actions = node('div', undefined, 'emergency-report-actions');
    if (mode === 'security' && report.status !== 'Resolved') actions.append(statusButton(report));
    actions.append(link('View Details', (mode === 'security' ? '/security' : '/emergency') + '/reports/' + report.id));
    el.append(actions); return el;
  }
  function pulse() {
    if (!soundEnabled || !audio || audio.state !== 'running' || !ringing.size) return;
    if (Date.now() - lastAlarmAt < 1500) return;
    lastAlarmAt = Date.now();
    // A repeating two-tone alarm continues until security accepts the report.
    for (const [offset, frequency] of [[0, 740], [0.4, 880]]) {
      const oscillator = audio.createOscillator(); const gain = audio.createGain();
      const start = audio.currentTime + offset;
      oscillator.type = 'sine'; oscillator.frequency.value = frequency;
      gain.gain.setValueAtTime(0, start); gain.gain.linearRampToValueAtTime(0.08, start + 0.03); gain.gain.linearRampToValueAtTime(0, start + 0.3);
      oscillator.connect(gain); gain.connect(audio.destination); oscillator.start(start); oscillator.stop(start + 0.32);
      activeTones.add(oscillator);
      oscillator.onended = () => { activeTones.delete(oscillator); oscillator.disconnect(); gain.disconnect(); };
    }
  }
  function audioUI() {
    document.querySelectorAll('[data-audio-status]').forEach(status => {
      status.textContent = soundEnabled ? '' : 'Alarm sound is blocked by your browser.';
      status.hidden = soundEnabled;
    });
  }
  function prepareAudio() {
    if (!alarmRoot) return;
    try {
      const Audio = window.AudioContext || window.webkitAudioContext;
      if (!Audio) throw new Error('Audio unavailable');
      if (!audio) {
        audio = new Audio();
        audio.onstatechange = () => { soundEnabled = audio.state === 'running'; audioUI(); pulse(); };
      }
      soundEnabled = audio.state === 'running';
      // Autoplay is attempted automatically. Normal page interaction also retries resume.
      // Never wait on a blocked resume promise before opening the popup.
      if (!soundEnabled) void audio.resume().then(() => { soundEnabled = audio.state === 'running'; audioUI(); pulse(); }).catch(() => { soundEnabled = false; audioUI(); });
      audioUI();
    } catch { soundEnabled = false; audioUI(); }
  }
  function stopTones() {
    for (const tone of activeTones) { try { tone.stop(); } catch { /* Already ended. */ } }
    activeTones.clear();
  }
  function renderAlarm() {
    if (!alarmRoot) return;
    if (!ringing.size) {
      dialog.close(); stopTones(); dialogSignature = ''; audioUI(); return;
    }
    const signature = JSON.stringify([...ringing.values()]);
    if (signature !== dialogSignature) {
      const content = alarmRoot.querySelector('[data-alarm-reports]');
      content.replaceChildren(...[...ringing.values()].map(report => {
        const item = node('article', undefined, 'emergency-alarm-item');
        item.dataset.reportId = report.id;
        const meta = node('div', undefined, 'emergency-report-meta');
        meta.append(node('span', report.type, 'emergency-type'), node('time', shortDate(report.created_at)));
        item.append(meta, node('h3', report.location), node('p', report.description, 'emergency-description'));
        item.append(statusButton(report));
        return item;
      }));
      alarmRoot.querySelector('[data-alarm-count]').textContent = String(ringing.size);
      dialogSignature = signature;
    }
    if (!dialog.open) dialog.showModal();
    prepareAudio(); pulse();
  }
  async function respond(report, button) {
    button.disabled = true;
    try {
      await get('/security/reports/' + report.id + '/respond', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-CSRF-Token': csrf }, body: JSON.stringify({}) });
      document.querySelectorAll('[data-live-error]').forEach(box => { box.textContent = ''; });
      handled.add(report.id); ringing.delete(report.id); dialogSignature = '';
      renderAlarm();
      await refresh();
    } catch (error) {
      document.querySelectorAll('[data-live-error]').forEach(box => { box.textContent = error.message; });
      button.disabled = false;
    }
  }
  function syncAlarm(reports) {
    if (!alarmRoot) return;
    const current = new Map(reports.map(report => [report.id, report]));
    for (const id of ringing.keys()) {
      const report = current.get(id);
      if (!report || ['Responding', 'Resolved'].includes(report.status)) { ringing.delete(id); handled.add(id); }
    }
    let added = false;
    for (const report of reports) {
      if (ringing.has(report.id)) ringing.set(report.id, report);
      else if (report.status === 'Submitted' && !handled.has(report.id)) { ringing.set(report.id, report); added = true; }
    }
    if (added) lastAlarmAt = 0;
    renderAlarm();
  }
  dialog?.addEventListener('cancel', event => event.preventDefault());
  if (alarmRoot) {
    prepareAudio();
    for (const event of ['pointerdown', 'keydown', 'touchend']) document.addEventListener(event, prepareAudio, { capture: true, passive: true });
    window.addEventListener('focus', prepareAudio);
  }
  function renderDetail(report) {
    const statusLabel = document.querySelector('[data-report-status]');
    statusLabel.textContent = report.status;
    statusLabel.className = 'emergency-status is-' + statusClass(report.status);
    const facts = node('div', undefined, 'emergency-detail-facts');
    for (const [label, value] of [['Reported', date(report.created_at)], ['Contact number', report.contact_number || 'Not provided']]) {
      const fact = node('p'); fact.append(node('span', label), document.createTextNode(value)); facts.append(fact);
    }
    const body = root.querySelector('[data-report-body]'); body.replaceChildren(node('h2', report.location), node('p', report.description, 'emergency-description'), facts);
    const audit = root.querySelector('[data-report-history]');
    audit.replaceChildren(...report.history.map(item => {
      const entry = node('li'); entry.append(node('strong', item.action === 'Escalated' ? 'Escalated' : item.status), node('span', date(item.created_at) + (root.dataset.security === 'true' && item.actor_id ? ' · Account #' + item.actor_id : ''))); return entry;
    }));
    const controls = root.querySelector('[data-status-controls]');
    if (root.dataset.security === 'true') { const button = statusButton(report); controls.replaceChildren(...(button ? [button] : [])); }
  }
  async function refresh() {
    if (fetching) { again = true; return; }
    fetching = true;
    try {
      if (!navigator.onLine) { connectionText(); return; }
      if (mode === 'detail') {
        const { report } = await get('/api/emergencies/' + root.dataset.reportId); renderDetail(report);
        if (alarmRoot) syncAlarm((await get('/api/emergencies')).reports);
      } else {
        const active = await get('/api/emergencies');
        syncAlarm(active.reports);
        if (mode === 'monitor') { errorBox.textContent = ''; connectionText(); return; }
        const result = history ? await get('/api/emergencies?history=1&page=' + page) : active;
        let visible = result.reports.filter(report => history || filter === 'all' || (filter === 'pending' ? needsResponse(report) : report.status === 'Responding'));
        if (mode === 'security' && !history) visible = visible.slice().sort((a, b) => Number(needsResponse(b)) - Number(needsResponse(a)));
        const signature = JSON.stringify({ reports: visible, history, page, filter });
        if (signature !== currentSignature) {
          const empty = node('div', undefined, 'emergency-empty');
          empty.append(node('span', history ? 'No resolved reports' : filter === 'pending' ? 'No reports need a response' : filter === 'responding' ? 'No reports in progress' : 'No active reports'), node('p', history ? 'Completed reports will appear here.' : 'New reports will appear here automatically.'));
          list.replaceChildren(...(visible.length ? visible.map(report => card(report)) : [empty]));
          currentSignature = signature;
        }
        const next = root.querySelector('[data-next-page]'); next.hidden = !history; next.disabled = result.reports.length < 25;
        if (mode === 'security') {
          const submitted = active.reports.filter(needsResponse);
          pending.clear(); submitted.forEach(report => pending.set(report.id, report));
          root.querySelector('[data-alert-count]').textContent = String(pending.size);
          const attention = root.querySelector('[data-emergency-attention]');
          attention?.classList.toggle('is-alerting', pending.size > 0);
          document.title = (pending.size ? '(' + pending.size + ') ' : '') + 'Emergency Dashboard | CSPConnect';
          const counts = root.querySelector('[data-emergency-counts]');
          counts.replaceChildren(...[['Needs response', Number(active.counts.Submitted) + Number(active.counts.Acknowledged), 'pending'], ['Responding', active.counts.Responding, 'responding'], ['Resolved', active.counts.Resolved, 'resolved']].map(([label, total, state]) => {
            const item = node('div', undefined, 'emergency-stat is-' + state);
            item.append(node('span', label), node('strong', String(total))); return item;
          }));
          pulse();
        }
      }
      errorBox.textContent = ''; connectionText();
    } catch (error) { errorBox.textContent = error.name === 'AbortError' ? 'Updates are delayed. Trying again.' : error.message; }
    finally { fetching = false; if (again) { again = false; void refresh(); } }
  }
  root?.querySelector('[data-history]')?.addEventListener('click', event => {
    history = !history; page = 1;
    event.currentTarget.textContent = history ? 'Back to active' : 'View history';
    const title = root.querySelector('[data-list-title]'); if (title) title.textContent = history ? 'Report history' : mode === 'security' ? 'Active reports' : 'My reports';
    const filters = root.querySelector('.emergency-filter-bar'); if (filters) filters.hidden = history;
    void refresh();
  });
  root?.querySelector('[data-next-page]')?.addEventListener('click', () => { page++; void refresh(); });
  root?.querySelectorAll('[data-emergency-filter]').forEach(button => button.addEventListener('click', () => {
    filter = button.dataset.emergencyFilter;
    root.querySelectorAll('[data-emergency-filter]').forEach(item => { const selected = item === button; item.classList.toggle('is-selected', selected); item.setAttribute('aria-pressed', String(selected)); });
    void refresh();
  }));
  if (typeof window.io === 'function') {
    socket = window.io({ auth: { csrfToken: csrf }, reconnectionDelay: 1000, reconnectionDelayMax: 10000 });
    socket.on('connect', () => { connectionText(); void refresh(); });
    socket.on('emergency:ready', () => void refresh());
    socket.on('emergency:changed', () => void refresh());
    socket.on('disconnect', connectionText); socket.on('connect_error', connectionText);
  }
  window.addEventListener('online', () => { connectionText(); void refresh(); });
  window.addEventListener('offline', connectionText);
  window.addEventListener('pageshow', () => void refresh());
  const form = document.querySelector('[data-emergency-form]');
  if (form) {
    const update = () => { form.querySelector('button[type="submit"]').disabled = !navigator.onLine; form.querySelector('[data-form-connection]').textContent = navigator.onLine ? '' : 'Offline — submission is unavailable. Call official emergency channels directly.'; };
    update(); window.addEventListener('offline', update); window.addEventListener('online', update);
    form.addEventListener('submit', () => { form.querySelector('button[type="submit"]').disabled = true; });
  }
  connectionText(); void refresh();
  const recovery = setInterval(() => void refresh(), 15000); const alarm = setInterval(pulse, 500);
  window.addEventListener('pagehide', event => { if (!event.persisted) { clearInterval(recovery); clearInterval(alarm); socket?.disconnect(); audio?.close(); } });
})();
