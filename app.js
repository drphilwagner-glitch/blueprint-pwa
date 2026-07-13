/* Blueprint Logger PWA.
 * A complex is an interleaved superset: round r = A set r, then the paired exercise(s) set r
 * (an exercise drops out once its sets run out). ONE timer per complex, started by the A-side
 * only, once per round (not reset by the R side or the paired exercise). Interval comes from the
 * server (slot.interval_s), configurable in the Workbook.
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
  function show(msg, cls) { app.innerHTML = ''; app.appendChild(el('p', cls || 'empty', msg)); }

  // ---- offline queue (IndexedDB). Logs are idempotent (client log_id), so the drain is
  //      fire-and-forget: POST no-cors, and on any resolved send remove from the queue; a
  //      failed/offline send stays queued and retries. Robust flag reset + periodic retry. ----
  function sendLog(rows) {
    return fetch(cfg.WEBAPP_URL, { method: 'POST', mode: 'no-cors', headers: { 'Content-Type': 'text/plain;charset=utf-8' },
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
    }).catch(function () {});
  }
  var draining = false;
  function drain() {
    if (draining || !navigator.onLine) return Promise.resolve();
    draining = true;
    return qAll().then(function (rows) {
      if (!rows.length) { draining = false; return; }
      return sendLog(rows)
        .then(function () { return qDel(rows.map(function (x) { return x.log_id; })); })  // sent (idempotent) -> remove
        .then(function () { draining = false; return updateBadge(); })
        .catch(function () { draining = false; });                                        // offline/failed -> keep queued
    }).catch(function () { draining = false; });
  }
  function logRows(rows) { Promise.all(rows.map(qAdd)).then(updateBadge).then(drain); }
  window.addEventListener('online', drain);
  document.addEventListener('visibilitychange', function () { if (!document.hidden) drain(); });
  setInterval(function () { if (navigator.onLine) drain(); }, 15000);   // safety-net retry

  // ---- one timer per complex; restarts each new round when the A-side begins ----
  function startTimer(node, sec) {
    if (!node) return;
    var end = Date.now() + sec * 1000;
    function tick() {
      var left = Math.max(0, Math.round((end - Date.now()) / 1000));
      node.textContent = left > 0 ? ('next round ' + Math.floor(left / 60) + ':' + ('0' + (left % 60)).slice(-2)) : 'go';
      if (left > 0) node._t = setTimeout(tick, 250);
    }
    if (node._t) clearTimeout(node._t);
    tick();
  }

  // ---- labels ----
  function targetLabel(t) { var noLoad = (t.target_load === '' || t.target_load == null); return noLoad ? (t.target_reps + ' reps') : (t.target_reps + ' × ' + t.target_load + ' lb'); }
  function accLabel(t, ex) {
    var s = t.target_reps + ' reps';
    if (ex.load_prefill !== '' && ex.load_prefill != null) s += ' · ' + ex.load_prefill + ' lb';   // no "log lb" nudge
    if (ex.intensity_pct != null) s += ' · ~' + ex.intensity_pct + (typeof ex.intensity_pct === 'number' ? '%' : '');
    return s;
  }
  function durLabel(t, ex) {
    var s = t.duration_s + 's hold';
    if (ex.load_prefill !== '' && ex.load_prefill != null) s += ' · ' + ex.load_prefill + ' lb';
    return s;
  }
  function mkLog(slot, ex, t, side, state) {
    return { log_id: uuid(), session_id: SESSION.session_id, complex_name: slot.complex_name, exercise: ex.exercise,
      set_no: t.set_no, side: side, target_load: t.target_load, target_reps: t.target_reps,
      actual_load: state.load, actual_reps: state.reps, flag: '' };
  }
  // Tap the chip to adjust actual reps (+ load, where applicable) before logging.
  function editChip(labelText, state, showLoad) {
    var chip = el('button', 'chip', labelText + '  ✎');
    chip.type = 'button';
    chip.addEventListener('click', function () {
      if (chip.dataset.editing) return; chip.dataset.editing = '1'; chip.textContent = '';
      var reps = el('input'); reps.type = 'number'; reps.value = state.reps; reps.inputMode = 'numeric'; reps.setAttribute('aria-label', 'reps');
      reps.addEventListener('input', function () { state.reps = reps.value === '' ? '' : Number(reps.value); });
      if (showLoad) {
        var load = el('input'); load.type = 'number'; load.value = state.load; load.inputMode = 'decimal'; load.setAttribute('aria-label', 'lb');
        load.addEventListener('input', function () { state.load = load.value === '' ? '' : Number(load.value); });
        chip.appendChild(reps); chip.appendChild(el('span', null, ' reps × ')); chip.appendChild(load); chip.appendChild(el('span', null, ' lb'));
      } else { chip.appendChild(reps); chip.appendChild(el('span', null, ' reps')); }
      reps.focus();
    });
    return chip;
  }

  function setRow(slot, ex, t, slotTimer, slotState, interval, isASide) {
    var isDur = !!t.duration_s, isAcc = ex.mode === 'accessory';
    var row = el('div', 'set' + (t.kind === 'warmup' ? ' warmup' : ''));
    var head = el('div', 'set-ex');
    head.appendChild(el('span', null, (ex.display_name || ex.exercise) + (ex.level ? ' · L' + ex.level : '') + ' · set ' + t.set_no));
    if (t.kind === 'warmup') head.appendChild(el('span', 'set-warm', 'warm-up'));
    row.appendChild(head);

    var controls = el('div', 'set-controls');
    var prefill = isAcc ? ((ex.load_prefill === '' || ex.load_prefill == null) ? '' : ex.load_prefill) : t.target_load;
    var state = { load: prefill, reps: t.target_reps };
    var showLoad = isAcc || (t.target_load !== '' && t.target_load != null);
    var labelText = isDur ? durLabel(t, ex) : (isAcc ? accLabel(t, ex) : targetLabel(t));
    if (isDur) controls.appendChild(el('span', 'set-target', labelText));
    else controls.appendChild(editChip(labelText, state, showLoad));

    function markDone(side, btn) {
      logRows([mkLog(slot, ex, t, side, state)]);
      btn.classList.add('done'); btn.textContent = (side ? side + ' ' : '') + '✓';
      var bs = row.querySelectorAll('button.tap'), all = true;
      for (var i = 0; i < bs.length; i++) if (!bs[i].classList.contains('done')) all = false;
      if (all) row.classList.add('done');
      // A-side drives the complex timer, once per round — R side and paired exercise don't reset it.
      if (isASide && t.set_no !== slotState.lastRound) { slotState.lastRound = t.set_no; startTimer(slotTimer, interval); }
    }
    function startHold(side, btn) {
      var rem = t.duration_s; btn.disabled = true; btn.classList.add('holding');
      btn.textContent = (side ? side + ' ' : '') + rem + 's';
      var iv = setInterval(function () {
        rem--; btn.textContent = (side ? side + ' ' : '') + rem + 's';
        if (rem <= 0) { clearInterval(iv); btn.disabled = false; btn.classList.remove('holding'); markDone(side, btn); }
      }, 1000);
    }
    (ex.each_side ? ['L', 'R'] : ['']).forEach(function (side) {
      var lbl = isDur ? ((side ? side + ' ' : 'Start ') + t.duration_s + 's') : (side || 'Done');
      var btn = el('button', 'tap' + (side ? ' side' : ''), lbl); btn.type = 'button';
      btn.addEventListener('click', function () {
        if (btn.classList.contains('done') || btn.disabled) return;
        if (isDur) startHold(side, btn); else markDone(side, btn);
      });
      controls.appendChild(btn);
    });
    row.appendChild(controls);
    return row;
  }

  function render(s) {
    SESSION = s;
    meta.textContent = (s.is_next_planned ? 'Next session · ' : '') + s.date + ' · ' + s.theme + ' · ' + athlete;
    app.innerHTML = '';
    s.slots.forEach(function (slot) {
      var card = el('section', 'slot');
      var head = el('h2', 'slot-title', slot.slot + ' · ' + slot.complex_name);
      var slotTimer = el('span', 'timer'); head.appendChild(slotTimer);   // ONE timer per complex
      card.appendChild(head);
      var body = el('div', 'sets');
      var slotState = { lastRound: null };
      var interval = slot.interval_s || 300;
      var aSide = slot.exercises[0];
      var maxSets = 0;
      slot.exercises.forEach(function (ex) { if (ex.sets.length > maxSets) maxSets = ex.sets.length; });
      for (var r = 0; r < maxSets; r++) {                                 // interleave the superset by round
        slot.exercises.forEach(function (ex) {
          if (r < ex.sets.length) body.appendChild(setRow(slot, ex, ex.sets[r], slotTimer, slotState, interval, ex === aSide));
        });
      }
      card.appendChild(body);
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
