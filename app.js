/* Blueprint Logger PWA.
 * Compact logging: a complex is an interleaved superset; each round is a box titled "Set N"
 * holding the paired exercises. Per exercise: tappable name (opens video when set), inline
 * weight (−5 −2.5 / +2.5 +5) and reps (− / +) steppers, and one check (both sides assumed).
 * ONE timer per round, started by the A-side only, once per round. Offline queue drains itself.
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

  // ---- offline queue (IndexedDB): fire-and-forget idempotent POST + retry; badge never sticks ----
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
        .then(function () { return qDel(rows.map(function (x) { return x.log_id; })); })
        .then(function () { draining = false; return updateBadge(); })
        .catch(function () { draining = false; });
    }).catch(function () { draining = false; });
  }
  function logRows(rows) { Promise.all(rows.map(qAdd)).then(updateBadge).then(drain); }
  window.addEventListener('online', drain);
  document.addEventListener('visibilitychange', function () { if (!document.hidden) drain(); });
  setInterval(function () { if (navigator.onLine) drain(); }, 15000);

  // ---- one ROLLING timer per complex: starts on the first A-side set, auto-restarts each round
  //      (rolls through all sets in succession), until the athlete pauses. ----
  function fmt(s) { return Math.floor(s / 60) + ':' + ('0' + (s % 60)).slice(-2); }
  function makeTimer(node, pauseBtn, interval) {
    var st = { running: false, paused: false, end: 0, rem: interval, t: null };
    function tick() {
      var left = Math.max(0, Math.round((st.end - Date.now()) / 1000));
      if (left <= 0) { st.end = Date.now() + interval * 1000; left = interval; node.classList.add('flash'); setTimeout(function () { node.classList.remove('flash'); }, 900); }
      node.textContent = 'next ' + fmt(left);
      st.t = setTimeout(tick, 250);
    }
    pauseBtn.addEventListener('click', function () {
      if (!st.running) return;
      if (st.paused) { st.paused = false; st.end = Date.now() + st.rem * 1000; pauseBtn.textContent = '⏸'; tick(); }
      else { st.paused = true; clearTimeout(st.t); st.rem = Math.max(0, Math.round((st.end - Date.now()) / 1000)); pauseBtn.textContent = '▶'; node.textContent = 'paused ' + fmt(st.rem); }
    });
    return { start: function () { if (st.running) return; st.running = true; st.end = Date.now() + interval * 1000; pauseBtn.hidden = false; tick(); } };
  }
  function startHold(btn, secs, done) {                    // duration items: countdown then log
    var rem = secs; btn.disabled = true; btn.classList.add('holding'); btn.textContent = rem + 's';
    var iv = setInterval(function () {
      rem--; btn.textContent = rem + 's';
      if (rem <= 0) { clearInterval(iv); btn.disabled = false; btn.classList.remove('holding'); done(); }
    }, 1000);
  }

  function mkLog(slot, exName, t, state) {   // exName may be a swapped-in alternate
    return { log_id: uuid(), session_id: SESSION.session_id, complex_name: slot.complex_name, exercise: exName,
      set_no: t.set_no, side: '', target_load: t.target_load, target_reps: t.target_reps,
      actual_load: state.load, actual_reps: state.reps, flag: '' };
  }
  // Goal (pass standard = prescription) + this-week Target (all-time best + bump) side by side.
  function goalTarget(ex, t) {
    var d = el('div', 'gt' + (t.kind === 'warmup' ? ' warm' : ''));
    var loaded = (t.target_load !== '' && t.target_load != null);
    d.appendChild(el('span', 'goal', 'goal ' + (loaded ? (t.target_reps + '×' + t.target_load + 'lb') : (t.target_reps + ' reps'))));
    if (t.kind !== 'warmup') {
      var wt = ex.week_target || {}, aim = wt.load != null ? (t.target_reps + '×' + wt.load + 'lb') : (wt.reps != null ? (wt.reps + ' reps') : '—');
      d.appendChild(el('span', 'aim', 'aim ' + aim));
    }
    return d;
  }

  // Inline +/- stepper bound to state[key]. deltas negatives render left, positives right.
  function stepper(state, key, deltas, unit) {
    var f = el('div', 'stepper');
    var val = el('span', 'val');
    function draw() { var v = state[key]; val.textContent = (v === '' || v == null) ? '—' : v; }
    function stepBtn(d) {
      var b = el('button', 'step', (d > 0 ? '+' : '') + d); b.type = 'button';
      b.addEventListener('click', function () {
        var cur = Number(state[key] || 0), nv = Math.round((cur + d) * 10) / 10;
        if (nv < 0) nv = 0; state[key] = nv; draw();
      });
      return b;
    }
    deltas.filter(function (d) { return d < 0; }).forEach(function (d) { f.appendChild(stepBtn(d)); });
    f.appendChild(val); if (unit) f.appendChild(el('span', 'unit', unit));
    deltas.filter(function (d) { return d > 0; }).forEach(function (d) { f.appendChild(stepBtn(d)); });
    draw();
    return f;
  }

  // Show the athlete's actual variant (Level Standards col D), de-duplicated against the base name.
  function exLabel(ex) {
    var base = ex.display_name || ex.exercise || '', v = ex.variant_name || '', lvl = ex.level ? ' · L' + ex.level : '';
    if (!v) return base + lvl;
    var lv = v.toLowerCase();
    if (lv.indexOf((ex.exercise || '').toLowerCase()) >= 0 || lv.indexOf(base.toLowerCase()) >= 0) return v + lvl;
    return base + ' — ' + v + lvl;
  }
  // Swap panel: pick a reason-tagged alternate; it becomes this row (name, video, its own reps).
  function toggleSwap(row, ex, cur, name, state) {
    var open = row.querySelector('.swap-panel');
    if (open) { open.remove(); return; }
    var panel = el('div', 'swap-panel');
    var lbl = { pain: 'Pain', noequip: 'No-equip', ue_pain: 'UE pain', equip: 'Equip' };
    var opts = [{ main: true, name: ex.exercise }].concat(ex.alternates);
    opts.forEach(function (a) {
      var text = a.main ? ('↩ ' + (ex.display_name || ex.exercise)) : ((lbl[a.reason] || a.reason) + ': ' + a.name + (a.reps ? ' · ' + a.reps : ''));
      var b = el('button', 'swap-opt', text); b.type = 'button';
      b.addEventListener('click', function () {
        cur.exercise = a.main ? ex.exercise : a.name;
        cur.video = a.main ? ex.video_url : (a.video_url || '');
        if (!a.main && a.reps && !isNaN(a.reps)) state.reps = Number(a.reps);
        name.textContent = a.main ? exLabel(ex) : a.name;
        name.classList.toggle('has-video', !!cur.video);
        panel.remove();
      });
      panel.appendChild(b);
    });
    row.appendChild(panel);
  }

  // Conditioning: rolling work/rest timer runs all reps hands-free, then log distance.
  function startIntervals(btn, reps, work, rest, done) {
    btn.disabled = true; btn.classList.add('holding');
    var seq = [];
    for (var i = 0; i < reps; i++) { seq.push({ p: 'WORK', s: work || 0 }); if (i < reps - 1 && rest > 0) seq.push({ p: 'REST', s: rest }); }
    var idx = 0, rem = seq.length ? seq[0].s : 0, totalWork = 0;
    var iv = setInterval(function () {
      if (idx >= seq.length) { clearInterval(iv); btn.disabled = false; btn.classList.remove('holding'); done(totalWork); return; }
      var cur = seq[idx];
      btn.textContent = cur.p + ' ' + rem + 's';
      if (cur.p === 'WORK') totalWork++;
      rem--;
      if (rem < 0) { idx++; rem = idx < seq.length ? seq[idx].s : 0; }
    }, 1000);
  }
  function conditioningRow(slot, ex, t) {
    var row = el('div', 'ex-row cond');
    var name = el('button', 'ex-name', exLabel(ex)); name.type = 'button';
    if (ex.video_url) { name.classList.add('has-video'); name.addEventListener('click', function () { window.open(ex.video_url, '_blank'); }); }
    row.appendChild(name);
    var scheme = t.duration_s ? (Math.round(t.duration_s / 60) + ' min')
      : ((t.target_reps || 1) + (t.work_s ? (' × ' + t.work_s + 's work / ' + (t.rest_s || 0) + 's rest') : ' reps'));
    row.appendChild(el('div', 'gt', 'Set ' + t.set_no + ' · ' + scheme));
    var dist = { v: '' };
    var fields = el('div', 'fields');
    var di = el('input', 'dist-in'); di.type = 'number'; di.placeholder = 'distance'; di.inputMode = 'decimal';
    di.addEventListener('input', function () { dist.v = di.value; });
    fields.appendChild(di); fields.appendChild(el('span', 'unit', 'after each set'));
    row.appendChild(fields);
    var check = el('button', 'check', t.work_s ? 'Start' : (t.duration_s ? ('Start ' + Math.round(t.duration_s / 60) + 'm') : '✓')); check.type = 'button';
    function logIt(dur) {
      var l = mkLog(slot, ex.exercise, t, { load: '', reps: t.target_reps }); l.duration_s = dur || ''; l.distance = dist.v || '';
      logRows([l]); row.classList.add('done'); check.classList.add('done'); check.textContent = '✓';
    }
    check.addEventListener('click', function () {
      if (check.classList.contains('done') || check.disabled) return;
      if (t.work_s) startIntervals(check, t.target_reps || 1, t.work_s, t.rest_s || 0, logIt);
      else if (t.duration_s) startHold(check, t.duration_s, function () { logIt(t.duration_s); });
      else logIt('');
    });
    row.appendChild(check);
    return row;
  }

  function exerciseRow(slot, ex, t, timer, isASide) {
    if (ex.mode === 'conditioning') return conditioningRow(slot, ex, t);
    var isDur = !!t.duration_s, isAcc = ex.mode === 'accessory';
    var row = el('div', 'ex-row' + (t.kind === 'warmup' ? ' warmup' : ''));
    var cur = { exercise: ex.exercise, video: ex.video_url };   // swap target

    var name = el('button', 'ex-name', exLabel(ex)); name.type = 'button';
    if (ex.video_url) name.classList.add('has-video');
    name.addEventListener('click', function () { if (cur.video) window.open(cur.video, '_blank'); });
    if (t.kind === 'warmup') name.appendChild(el('span', 'set-warm', 'warm-up'));
    row.appendChild(name);
    if (!isDur) row.appendChild(goalTarget(ex, t));

    var prefill = isAcc ? ((ex.load_prefill === '' || ex.load_prefill == null) ? '' : ex.load_prefill) : t.target_load;
    var state = { load: prefill, reps: t.target_reps };
    var showLoad = (t.target_load !== '' && t.target_load != null) || (isAcc && prefill !== '');

    var fields = el('div', 'fields');
    if (!isDur) {
      if (showLoad) fields.appendChild(stepper(state, 'load', [-5, -2.5, 2.5, 5], 'lb'));
      fields.appendChild(stepper(state, 'reps', [-1, 1], 'reps'));
    } else {
      fields.appendChild(el('span', 'hint', t.duration_s + 's hold'));
      if (showLoad) fields.appendChild(stepper(state, 'load', [-5, -2.5, 2.5, 5], 'lb'));
    }
    if (ex.alternates && ex.alternates.length) {
      var sw = el('button', 'swap', '⇄'); sw.type = 'button';
      sw.addEventListener('click', function () { toggleSwap(row, ex, cur, name, state); });
      fields.appendChild(sw);
    }
    row.appendChild(fields);

    function commit() {
      logRows([mkLog(slot, cur.exercise, t, state)]);
      row.classList.add('done'); check.classList.add('done'); check.textContent = '✓';
      if (isASide) timer.start();   // rolling complex timer starts on the first A-side set
    }
    var check = el('button', 'check', isDur ? ('Start ' + t.duration_s + 's') : '✓'); check.type = 'button';
    check.addEventListener('click', function () {
      if (check.classList.contains('done') || check.disabled) return;
      if (isDur) startHold(check, t.duration_s, commit); else commit();
    });
    row.appendChild(check);
    return row;
  }

  function renderSummary(n, d) {
    app.innerHTML = '';
    app.appendChild(el('h2', 'sum-h', 'Workout complete 💪'));
    app.appendChild(el('p', 'sum-sub', n + ' set' + (n === 1 ? '' : 's') + ' logged'));
    function block(title, items, cls) {
      if (!items || !items.length) return;
      app.appendChild(el('h3', 'sum-t ' + cls, title));
      items.forEach(function (c) {
        var txt;
        if (c.first) txt = c.exercise + ' — first time 🎉';
        else {
          var parts = [];
          if (c.intensity_pct != null) parts.push((c.intensity_pct >= 0 ? '+' : '') + c.intensity_pct + '% 1RM');
          if (c.volume_pct != null) parts.push((c.volume_pct >= 0 ? '+' : '') + c.volume_pct + '% vol');
          txt = c.exercise + ' — ' + (parts.join(' · ') || 'logged');
        }
        app.appendChild(el('div', 'sum-row ' + cls, txt));
      });
    }
    if (!d || !d.ok || !d.logged) { app.appendChild(el('p', 'empty', 'Nice work.')); return; }
    block('Top gains 🔺', d.best, 'up');
    block('Keep an eye on 🔻', d.worst, 'down');
  }

  function render(s) {
    SESSION = s;
    meta.textContent = (s.is_next_planned ? 'Next session · ' : '') + s.date + ' · ' + s.theme + ' · ' + athlete;
    app.innerHTML = '';
    s.slots.forEach(function (slot) {
      var card = el('section', 'slot');
      var head = el('div', 'slot-head');
      head.appendChild(el('h2', 'slot-title', slot.slot + ' · ' + slot.complex_name));
      var timerNode = el('span', 'timer');
      var pauseBtn = el('button', 'pause', '⏸'); pauseBtn.type = 'button'; pauseBtn.hidden = true;
      head.appendChild(timerNode); head.appendChild(pauseBtn);
      card.appendChild(head);
      var timer = makeTimer(timerNode, pauseBtn, slot.interval_s || 300);
      var body = el('div', 'sets');
      var aSide = slot.exercises[0];
      var maxSets = 0;
      slot.exercises.forEach(function (ex) { if (ex.sets.length > maxSets) maxSets = ex.sets.length; });
      for (var r = 0; r < maxSets; r++) {
        var roundBox = el('div', 'round');
        roundBox.appendChild(el('div', 'round-title', 'Set ' + (r + 1)));
        var count = 0;
        slot.exercises.forEach(function (ex) {
          if (r < ex.sets.length) { roundBox.appendChild(exerciseRow(slot, ex, ex.sets[r], timer, ex === aSide)); count++; }
        });
        if (count > 1) roundBox.classList.add('paired');
        body.appendChild(roundBox);
      }
      card.appendChild(body);
      app.appendChild(card);
    });
    var finish = el('button', 'finish', 'Finish workout');
    finish.addEventListener('click', function () {
      var n = document.querySelectorAll('.ex-row.done').length;
      drain();   // flush the queue so the summary sees this session's sets
      show('Workout complete — ' + n + ' logged. Loading summary…');
      var url = cfg.WEBAPP_URL + '?action=summary&athlete=' + encodeURIComponent(athlete) +
        '&session_id=' + encodeURIComponent(SESSION.session_id) + '&token=' + encodeURIComponent(token);
      setTimeout(function () {
        fetch(url).then(function (r) { return r.json(); }).then(function (d) { renderSummary(n, d); }).catch(function () {});
      }, 1800);
    });
    app.appendChild(finish);
  }

  function load() {
    if (!cfg.WEBAPP_URL || cfg.WEBAPP_URL.indexOf('REPLACE_') === 0) return show('App not configured yet (WEBAPP_URL).', 'err');
    if (!athlete || !token) return show('Missing athlete or token — open your personal link.', 'err');
    fetch(planUrl()).then(function (r) { return r.json(); }).then(function (data) {
      if (!data.ok) return show('Access denied — check your link.', 'err');
      if (!data.session) return show('All caught up — no upcoming session.');
      render(data.session);
    }).catch(function () { show('Offline and no cached session yet.', 'err'); });
  }

  load();
  updateBadge().then(drain);
})();
