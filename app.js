/* Blueprint Logger PWA.
 * S8 render · S9 logging · S10 offline queue · polish: each-side single row (L/R buttons),
 * level-based "next set" countdown, Finish button, display names.
 */
(function () {
  'use strict';

  var cfg = window.BP_CONFIG || {};
  var params = new URLSearchParams(location.search);
  var athlete = params.get('athlete') || localStorage.getItem('bp_athlete') || '';
  var token = params.get('token') || localStorage.getItem('bp_token') || '';
  if (params.get('athlete')) localStorage.setItem('bp_athlete', athlete);
  if (params.get('token')) localStorage.setItem('bp_token', token);

  var app = document.getElementById('app');
  var meta = document.getElementById('meta');
  var syncEl = document.getElementById('sync');
  var SESSION = null;

  function todayISO() { return new Date().toLocaleDateString('en-CA'); }
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function uuid() { return (self.crypto && crypto.randomUUID) ? crypto.randomUUID() : 'id-' + Date.now() + '-' + Math.random().toString(16).slice(2); }
  function planUrl() { return cfg.WEBAPP_URL + '?action=plan&athlete=' + encodeURIComponent(athlete) + '&date=' + todayISO() + '&token=' + encodeURIComponent(token); }
  function targetLabel(t) { var noLoad = (t.target_load === '' || t.target_load == null); return noLoad ? (t.target_reps + ' reps') : (t.target_reps + ' × ' + t.target_load + ' lb'); }
  function show(msg, cls) { app.innerHTML = ''; app.appendChild(el('p', cls || 'empty', msg)); }

  // --- logging transport (S9) + offline IndexedDB queue (S10) ---
  function sendLog(rows) {
    return fetch(cfg.WEBAPP_URL, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ action: 'log', athlete: athlete, token: token, rows: rows }) });
  }
  var DB;
  function idb() {
    if (DB) return Promise.resolve(DB);
    return new Promise(function (res, rej) {
      var r = indexedDB.open('bp-logger', 1);
      r.onupgradeneeded = function () { r.result.createObjectStore('queue', { keyPath: 'log_id' }); };
      r.onsuccess = function () { DB = r.result; res(DB); };
      r.onerror = function () { rej(r.error); };
    });
  }
  function qStore(mode) { return idb().then(function (db) { return db.transaction('queue', mode).objectStore('queue'); }); }
  function qAdd(row) { return qStore('readwrite').then(function (s) { return new Promise(function (res) { s.put(row); s.transaction.oncomplete = res; }); }); }
  function qAll() { return qStore('readonly').then(function (s) { return new Promise(function (res) { var rq = s.getAll(); rq.onsuccess = function () { res(rq.result || []); }; }); }); }
  function qDel(ids) { return qStore('readwrite').then(function (s) { ids.forEach(function (id) { s['delete'](id); }); return new Promise(function (res) { s.transaction.oncomplete = res; }); }); }
  function updateBadge() {
    return qAll().then(function (rows) {
      if (rows.length) { syncEl.hidden = false; syncEl.className = 'sync pending'; syncEl.textContent = rows.length + ' pending'; }
      else { syncEl.className = 'sync synced'; syncEl.textContent = 'synced'; setTimeout(function () { if (syncEl.textContent === 'synced') syncEl.hidden = true; }, 1500); }
    });
  }
  var draining = false;
  function drain() {
    if (draining || !navigator.onLine) return Promise.resolve();
    draining = true;
    return qAll().then(function (rows) {
      if (!rows.length) { draining = false; return; }
      return sendLog(rows).then(function (r) { return r.json(); }).then(function (data) {
        if (data && data.ok) return qDel(rows.map(function (x) { return x.log_id; }));
      }).then(function () { draining = false; return updateBadge(); }).catch(function () { draining = false; });
    });
  }
  function logRows(rows) { Promise.all(rows.map(qAdd)).then(updateBadge).then(drain); }
  window.addEventListener('online', drain);
  document.addEventListener('visibilitychange', function () { if (!document.hidden) drain(); });

  // --- "next set" countdown (per exercise). Interval by level: L1=3min, L2=4min, L3=5min;
  //     accessories / reps-only (no level) get a 90s default. ---
  function intervalFor(ex) { var band = ex.level ? parseInt(String(ex.level), 10) : 0; return band ? (band + 2) * 60 : 90; }
  function startTimer(node, sec) {
    var end = Date.now() + sec * 1000;
    function tick() {
      var left = Math.max(0, Math.round((end - Date.now()) / 1000));
      node.textContent = left > 0 ? ('next set ' + Math.floor(left / 60) + ':' + ('0' + (left % 60)).slice(-2)) : 'go';
      if (left > 0) node._t = setTimeout(tick, 250);
    }
    if (node._t) clearTimeout(node._t);
    tick();
  }

  function mkLog(slot, ex, t, side, state) {
    return { log_id: uuid(), session_id: SESSION.session_id, complex_name: slot.complex_name, exercise: ex.exercise,
      set_no: t.set_no, side: side, target_load: t.target_load, target_reps: t.target_reps,
      actual_load: state.load, actual_reps: state.reps, flag: '' };
  }
  // Accessory label: reps + prefilled load (last logged actual) + intensity_pct HINT (never a target).
  function accLabel(t, ex) {
    var s = t.target_reps + ' reps';
    s += (ex.load_prefill !== '' && ex.load_prefill != null) ? (' · ' + ex.load_prefill + ' lb') : ' · log lb';
    if (ex.intensity_pct != null) s += ' · ~' + ex.intensity_pct + (typeof ex.intensity_pct === 'number' ? '%' : '');
    return s;
  }
  function openEdit(row, target, state, showLoad) {
    if (row.querySelector('.edit')) return;
    var box = el('span', 'edit');
    var reps = el('input'); reps.type = 'number'; reps.value = state.reps; reps.inputMode = 'numeric';
    reps.addEventListener('input', function () { state.reps = reps.value === '' ? '' : Number(reps.value); });
    if (showLoad) {
      var load = el('input'); load.type = 'number'; load.value = state.load; load.inputMode = 'decimal';
      load.addEventListener('input', function () { state.load = load.value === '' ? '' : Number(load.value); });
      box.appendChild(load); box.appendChild(el('span', null, ' lb × '));
    }
    box.appendChild(reps); box.appendChild(el('span', null, ' reps'));
    target.replaceWith(box);
  }

  function durLabel(t, ex) {
    var s = t.duration_s + 's hold';
    if (ex.load_prefill !== '' && ex.load_prefill != null) s += ' · ' + ex.load_prefill + ' lb';
    return s;
  }
  function setRow(slot, ex, t, timer) {
    var isDur = !!t.duration_s;
    var row = el('div', 'set' + (t.kind === 'warmup' ? ' warmup' : ''));
    if (t.kind === 'warmup') row.appendChild(el('span', 'set-warm', 'WARM-UP'));
    var isAcc = ex.mode === 'accessory';
    var prefill = isAcc ? ((ex.load_prefill === '' || ex.load_prefill == null) ? '' : ex.load_prefill) : t.target_load;
    var state = { load: prefill, reps: t.target_reps };
    var showLoad = isAcc || (t.target_load !== '' && t.target_load != null);
    var target = el('span', 'set-target', isDur ? durLabel(t, ex) : (isAcc ? accLabel(t, ex) : targetLabel(t)));
    target.addEventListener('click', function () { if (!row.classList.contains('done')) openEdit(row, target, state, showLoad); });
    row.appendChild(target);

    function markDone(side, btn) {
      logRows([mkLog(slot, ex, t, side, state)]);
      btn.classList.add('done'); btn.textContent = (side ? side + ' ' : '') + '✓';
      var bs = row.querySelectorAll('button.tap'), all = true;
      for (var i = 0; i < bs.length; i++) if (!bs[i].classList.contains('done')) all = false;
      if (all) row.classList.add('done');
      startTimer(timer, intervalFor(ex));
    }
    function startHold(side, btn) {                       // duration items: countdown, then log
      var rem = t.duration_s; btn.disabled = true; btn.classList.add('holding');
      btn.textContent = (side ? side + ' ' : '') + rem + 's';
      var iv = setInterval(function () {
        rem--; btn.textContent = (side ? side + ' ' : '') + rem + 's';
        if (rem <= 0) { clearInterval(iv); btn.disabled = false; btn.classList.remove('holding'); markDone(side, btn); }
      }, 1000);
    }
    (ex.each_side ? ['L', 'R'] : ['']).forEach(function (side) {
      var lbl = isDur ? ((side ? side + ' ' : 'Start ') + t.duration_s + 's') : (side || 'Done');
      var btn = el('button', 'tap' + (side ? ' side' : ''), lbl);
      btn.addEventListener('click', function () {
        if (btn.classList.contains('done') || btn.disabled) return;
        if (isDur) startHold(side, btn); else markDone(side, btn);
      });
      row.appendChild(btn);
    });
    return row;
  }

  function render(s) {
    SESSION = s;
    meta.textContent = (s.is_next_planned ? 'Next session · ' : '') + s.date + ' · ' + s.theme + ' · ' + athlete;
    app.innerHTML = '';
    s.slots.forEach(function (slot) {
      var card = el('section', 'slot');
      card.appendChild(el('h2', 'slot-title', slot.slot + ' · ' + slot.complex_name));
      slot.exercises.forEach(function (ex) {
        var box = el('div', 'exercise');
        var head = el('h3', 'ex-name', (ex.display_name || ex.exercise) + (ex.level ? ' · L' + ex.level : ''));
        var timer = el('span', 'timer'); head.appendChild(timer);
        box.appendChild(head);
        var sets = el('div', 'sets');
        ex.sets.forEach(function (t) { sets.appendChild(setRow(slot, ex, t, timer)); });
        box.appendChild(sets);
        card.appendChild(box);
      });
      app.appendChild(card);
    });
    var finish = el('button', 'finish', 'Finish workout');
    finish.addEventListener('click', function () {
      var n = document.querySelectorAll('button.tap.done').length;
      show('Workout complete — ' + n + ' set' + (n === 1 ? '' : 's') + ' logged. Nice work.');
    });
    app.appendChild(finish);
  }

  function load() {
    if (!cfg.WEBAPP_URL || cfg.WEBAPP_URL.indexOf('REPLACE_') === 0) return show('App not configured yet (WEBAPP_URL).', 'err');
    if (!athlete || !token) return show('Missing athlete or token — open your personal link.', 'err');
    fetch(planUrl()).then(function (r) { return r.json(); }).then(function (data) {
      if (!data.ok) return show('Access denied — check your link.', 'err');
      if (!data.session) return show('No upcoming session.');
      render(data.session);
    }).catch(function () { show('Offline and no cached session yet.', 'err'); });
  }

  load();
  updateBadge().then(drain);
})();
