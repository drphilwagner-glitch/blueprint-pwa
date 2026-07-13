/* Blueprint Logger PWA.
 * S8: render session. S9: tap-to-log, tap-and-edit override, each-side L/R rows, rest timer.
 * (S10 adds the offline IndexedDB queue + sync badge — it replaces logRows()'s transport.)
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
  var SESSION = null;

  function todayISO() { return new Date().toLocaleDateString('en-CA'); }
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function uuid() { return (self.crypto && crypto.randomUUID) ? crypto.randomUUID() : 'id-' + Date.now() + '-' + Math.random().toString(16).slice(2); }
  function planUrl() { return cfg.WEBAPP_URL + '?action=plan&athlete=' + encodeURIComponent(athlete) + '&date=' + todayISO() + '&token=' + encodeURIComponent(token); }
  function targetLabel(t) { var noLoad = (t.target_load === '' || t.target_load == null); return noLoad ? (t.target_reps + ' reps') : (t.target_reps + ' × ' + t.target_load + ' lb'); }
  function show(msg, cls) { app.innerHTML = ''; app.appendChild(el('p', cls || 'empty', msg)); }

  // --- logging transport (S9) + offline queue (S10) ---------------------------------
  // Every logged set is written to an IndexedDB queue FIRST (survives app kill), then the
  // queue drains to the server. Each row carries a stable client log_id, so re-draining is
  // idempotent (server skips known ids) -> zero dupes (HARD rule 4). text/plain avoids the
  // Apps Script CORS preflight.
  var syncEl = document.getElementById('sync');

  function sendLog(rows) {
    return fetch(cfg.WEBAPP_URL, {
      method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ action: 'log', athlete: athlete, token: token, rows: rows })
    });
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
  function store(mode) { return idb().then(function (db) { return db.transaction('queue', mode).objectStore('queue'); }); }
  function qAdd(row) { return store('readwrite').then(function (s) { return new Promise(function (res) { s.put(row); s.transaction.oncomplete = res; }); }); }
  function qAll() { return store('readonly').then(function (s) { return new Promise(function (res) { var rq = s.getAll(); rq.onsuccess = function () { res(rq.result || []); }; }); }); }
  function qDel(ids) { return store('readwrite').then(function (s) { ids.forEach(function (id) { s['delete'](id); }); return new Promise(function (res) { s.transaction.oncomplete = res; }); }); }

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
        if (data && data.ok) return qDel(rows.map(function (x) { return x.log_id; }));  // acked (idempotent) -> remove
      }).then(function () { draining = false; return updateBadge(); })
        .catch(function () { draining = false; });   // still offline / failed -> keep queued
    });
  }

  function logRows(rows) { Promise.all(rows.map(qAdd)).then(updateBadge).then(drain); }

  window.addEventListener('online', drain);
  document.addEventListener('visibilitychange', function () { if (!document.hidden) drain(); });

  // --- rest timer (per exercise) ---
  function startTimer(node, sec) {
    var end = Date.now() + sec * 1000;
    function tick() {
      var left = Math.max(0, Math.round((end - Date.now()) / 1000));
      node.textContent = left > 0 ? ('rest ' + Math.floor(left / 60) + ':' + ('0' + (left % 60)).slice(-2)) : 'rest ✓';
      if (left > 0) node._t = setTimeout(tick, 250);
    }
    if (node._t) clearTimeout(node._t);
    tick();
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
        var head = el('h3', 'ex-name', ex.exercise + (ex.level ? ' · L' + ex.level : ''));
        var timer = el('span', 'timer'); head.appendChild(timer);
        box.appendChild(head);
        var sets = el('div', 'sets');
        ex.sets.forEach(function (t) {
          (ex.each_side ? ['L', 'R'] : ['']).forEach(function (side) {
            sets.appendChild(setRow(slot, ex, t, side, timer));
          });
        });
        box.appendChild(sets);
        card.appendChild(box);
      });
      app.appendChild(card);
    });
  }

  function setRow(slot, ex, t, side, timer) {
    var row = el('div', 'set' + (t.kind === 'warmup' ? ' warmup' : ''));
    if (side) row.appendChild(el('span', 'side-tag', side));
    else if (t.kind === 'warmup') row.appendChild(el('span', 'set-warm', 'WARM-UP'));

    var state = { load: t.target_load, reps: t.target_reps };
    var target = el('span', 'set-target', targetLabel(t));
    target.addEventListener('click', function () { if (!row.classList.contains('done')) openEdit(row, target, state, t); });
    row.appendChild(target);

    var btn = el('button', 'tap', 'Done');
    btn.addEventListener('click', function () {
      if (row.classList.contains('done')) return;
      logRows([{
        log_id: uuid(), session_id: SESSION.session_id, complex_name: slot.complex_name, exercise: ex.exercise,
        set_no: t.set_no, side: side, target_load: t.target_load, target_reps: t.target_reps,
        actual_load: state.load, actual_reps: state.reps, flag: ''
      }]);
      row.classList.add('done'); btn.classList.add('done'); btn.textContent = '✓';
      startTimer(timer, ex.rest_s || 120);
    });
    row.appendChild(btn);
    return row;
  }

  // tap-and-edit: replace the target label with number inputs for actual load/reps
  function openEdit(row, target, state, t) {
    if (row.querySelector('.edit')) return;
    var box = el('span', 'edit'), noLoad = (t.target_load === '' || t.target_load == null);
    var reps = el('input'); reps.type = 'number'; reps.value = state.reps; reps.inputMode = 'numeric';
    reps.addEventListener('input', function () { state.reps = reps.value === '' ? '' : Number(reps.value); });
    if (!noLoad) {
      var load = el('input'); load.type = 'number'; load.value = state.load; load.inputMode = 'decimal';
      load.addEventListener('input', function () { state.load = load.value === '' ? '' : Number(load.value); });
      box.appendChild(load); box.appendChild(el('span', null, ' lb × '));
    }
    box.appendChild(reps); box.appendChild(el('span', null, ' reps'));
    target.replaceWith(box);
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
  updateBadge().then(drain);   // surface + drain any queue that survived an app kill
})();
