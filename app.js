/* Blueprint Logger PWA.
 * Compact logging: a complex is an interleaved superset; each round is a box titled "Set N"
 * holding the paired exercises. Per exercise: tappable name (opens video when set), inline
 * compact weight (±2.5) and reps (±1) steppers, Goal→Aim inline, one check.
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
  // Mark this session done on Finish so reopening advances to the next planned session.
  function sendComplete(sessionId) {
    return fetch(cfg.WEBAPP_URL, { method: 'POST', mode: 'no-cors', headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ action: 'complete', athlete: athlete, token: token, session_id: sessionId }) }).catch(function () {});
  }
  // Move an unlogged session to another day (reschedule).
  function sendMove(sessionId, toDate) {
    return fetch(cfg.WEBAPP_URL, { method: 'POST', mode: 'no-cors', headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ action: 'move', athlete: athlete, token: token, session_id: sessionId, to_date: toDate }) }).catch(function () {});
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
    // --- rest-timer alert: a beep + vibrate + a half-screen banner when the interval rolls over ---
    var _ac = null;
    function primeAudio() { try { _ac = _ac || new (window.AudioContext || window.webkitAudioContext)(); if (_ac.state === 'suspended') _ac.resume(); } catch (e) {} }
    function beep() {
      try {
        primeAudio(); if (!_ac) return;
        var o = _ac.createOscillator(), g = _ac.createGain();
        o.type = 'sine'; o.frequency.value = 880; o.connect(g); g.connect(_ac.destination);
        g.gain.setValueAtTime(0.0001, _ac.currentTime);
        g.gain.exponentialRampToValueAtTime(0.35, _ac.currentTime + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, _ac.currentTime + 0.45);
        o.start(); o.stop(_ac.currentTime + 0.45);
      } catch (e) {}
      if (navigator.vibrate) { try { navigator.vibrate([200, 80, 200]); } catch (e) {} }
    }
    // Half-screen banner. Used by every timer that ends or changes phase — the complex roll-over,
    // conditioning WORK<->REST changes, and hold completion. `cls` tints it (rest = amber).
    function timerAlert(big, sub, cls) {
      var ov = el('div', 'talert' + (cls ? ' ' + cls : ''));
      ov.appendChild(el('div', 'talert-big', big || 'Rest done'));
      ov.appendChild(el('div', 'talert-sub', sub || 'next set — go'));
      document.body.appendChild(ov);
      requestAnimationFrame(function () { ov.classList.add('show'); });
      setTimeout(function () { ov.classList.remove('show'); setTimeout(function () { ov.remove(); }, 300); }, 1700);
    }
  function makeTimer(node, pauseBtn, interval) {
    var st = { running: false, paused: false, end: 0, rem: interval, t: null };
    function tick() {
      var left = Math.max(0, Math.round((st.end - Date.now()) / 1000));
      if (left <= 0) { st.end = Date.now() + interval * 1000; left = interval; node.classList.add('flash'); setTimeout(function () { node.classList.remove('flash'); }, 900); beep(); timerAlert('Next round', 'go'); }
      node.textContent = 'next ' + fmt(left);
      st.t = setTimeout(tick, 250);
    }
    pauseBtn.addEventListener('click', function () {
      if (!st.running) return;
      if (st.paused) { st.paused = false; st.end = Date.now() + st.rem * 1000; pauseBtn.textContent = '⏸'; tick(); }
      else { st.paused = true; clearTimeout(st.t); st.rem = Math.max(0, Math.round((st.end - Date.now()) / 1000)); pauseBtn.textContent = '▶'; node.textContent = 'paused ' + fmt(st.rem); }
    });
    return { start: function () { if (st.running) return; primeAudio(); st.running = true; st.end = Date.now() + interval * 1000; pauseBtn.hidden = false; tick(); } };
  }
  function startHold(btn, secs, done) {                    // duration items: countdown then log
    primeAudio();                                          // unlock audio on the tap that starts it (iOS)
    var rem = secs; btn.disabled = true; btn.classList.add('holding'); btn.textContent = rem + 's';
    var iv = setInterval(function () {
      rem--; btn.textContent = rem + 's';
      if (rem <= 0) {
        clearInterval(iv); btn.disabled = false; btn.classList.remove('holding');
        beep(); timerAlert('Done', 'hold complete');       // was silent — you'd have to watch the button
        done();
      }
    }, 1000);
  }

  function mkLog(slot, exName, t, state) {   // exName may be a swapped-in alternate
    return { log_id: uuid(), session_id: SESSION.session_id, complex_name: slot.complex_name, exercise: exName,
      set_no: t.set_no, side: '', target_load: t.target_load, target_reps: t.target_reps,
      actual_load: state.load, actual_reps: state.reps, flag: '' };
  }
  // LEVEL GOAL (rung pass standard), muted, on line 1 next to the name. ONE value only — the weight, or
  // the reps for bodyweight. Returns null (nothing shown) for warm-up sets and for non-leveled exercises
  // (accessories/stability not in Level Standards) so they never show a bogus goal.
  function goalTarget(ex, t) {
    if (t.kind === 'warmup') return null;
    var lg = ex.level_goal;
    if (!lg || (lg.load == null && lg.reps == null)) return null;
    var span = el('span', 'goaltag');
    span.appendChild(el('span', 'lbl', 'goal '));
    span.appendChild(el('span', 'gv', lg.load != null ? (lg.load + ' lb') : (lg.reps + ' reps')));
    return span;
  }
  function slotLabel(s) {                              // "WUp1" -> "Warm Up 1"; "Comp1" -> "Complex 1"
    s = String(s || '');
    var m = s.match(/^W\s*U\s*p?\s*(\d+)/i); if (m) return 'Warm Up ' + m[1];
    var c = s.match(/^Comp\s*(\d+)/i); if (c) return 'Complex ' + c[1];
    return s;
  }

  // Compact −/+ stepper bound to state[key] (single increment; − left, value, + right).
  // extraCls (e.g. 'mini') styles a secondary/subtle stepper.
  function stepper(state, key, delta, unit, extraCls) {
    var f = el('div', 'stepper' + (extraCls ? ' ' + extraCls : ''));
    var val = el('span', 'val');
    function draw() { var v = state[key]; val.textContent = (v === '' || v == null) ? '—' : v; }
    function btn(sign) {
      var b = el('button', 'step', sign > 0 ? '+' : '−'); b.type = 'button';
      b.addEventListener('click', function () { var c = Number(state[key] || 0), nv = Math.round((c + sign * delta) * 10) / 10; if (nv < 0) nv = 0; state[key] = nv; draw(); });
      return b;
    }
    f.appendChild(btn(-1)); f.appendChild(val); if (unit) f.appendChild(el('span', 'unit', unit)); f.appendChild(btn(1));
    draw();
    return f;
  }

  // ATHLETE-FACING name: server sends athlete_name = shown_name override (Exercise Videos tab) ||
  // variant (Level Standards col D) || display_name. The level (3.1) is internal and hidden here.
  function exLabel(ex) {
    return ex.athlete_name || ex.variant_name || ex.display_name || ex.exercise || '';
  }

  // ---- In-app video: play in an overlay dismissed with one ✕ (no leaving the app) ----
  function videoEmbed(url) {
    var yt = url.match(/(?:youtube\.com\/(?:watch\?v=|embed\/)|youtu\.be\/)([\w-]{11})/);
    if (yt) return { type: 'iframe', src: 'https://www.youtube.com/embed/' + yt[1] };
    var vm = url.match(/vimeo\.com\/(?:video\/)?(\d+)/);
    if (vm) return { type: 'iframe', src: 'https://player.vimeo.com/video/' + vm[1] };
    if (/\.mp4(\?|$)/i.test(url)) return { type: 'video', src: url };
    return null;   // unknown host -> offer a normal open
  }
  function openVideo(url) {
    if (!url) return;
    var e = videoEmbed(url);
    var ov = el('div', 'vov'), box = el('div', 'vbox');
    var close = el('button', 'vclose', '✕'); close.type = 'button';
    close.addEventListener('click', function () { ov.remove(); });
    ov.addEventListener('click', function (ev) { if (ev.target === ov) ov.remove(); });
    box.appendChild(close);
    if (e && e.type === 'iframe') {
      var f = el('iframe'); f.className = 'vframe';
      f.src = e.src + (e.src.indexOf('?') < 0 ? '?' : '&') + 'autoplay=1';
      f.setAttribute('allow', 'autoplay; fullscreen; encrypted-media; picture-in-picture');
      f.setAttribute('allowfullscreen', ''); box.appendChild(f);
    } else if (e && e.type === 'video') {
      var v = el('video'); v.className = 'vframe'; v.src = e.src; v.controls = true; v.autoplay = true; v.playsInline = true; box.appendChild(v);
    } else {
      var a = el('a', 'vfallback', 'Open video ↗'); a.href = url; a.target = '_blank'; a.rel = 'noopener'; box.appendChild(a);
    }
    // QA-04: some sources block embedding ("Video unavailable"), and we can't detect that across
    // origins — so ALWAYS offer a way out rather than leaving a dead player.
    if (e) { var esc = el('a', 'vopen', "Video won't play? Open it ↗"); esc.href = url; esc.target = '_blank'; esc.rel = 'noopener'; box.appendChild(esc); }
    ov.appendChild(box); document.body.appendChild(ov);
  }
  // Registry of rendered rows, keyed by the ORIGINAL exercise, so a swap can reach every set of that
  // exercise (QA-05), not just the row it was tapped from. Reset per render(); rebuilt rows re-register.
  var ROW_REG = {};
  function regRow(entry) {
    var k = (entry.ex._alt_of || entry.ex).exercise;
    (ROW_REG[k] = ROW_REG[k] || []).push(entry);
  }

  // ---- Say it once (S17) ----
  // A coach writes a complex as "A1. Chest Supported Row 3×8 @80 / A2. Incline Bench 3×8 @135" —
  // each fact stated ONCE, and the rounds are understood. We were doing the opposite: because the
  // layout is round-major (round 1: row, bench / round 2: row, bench / …), every round redrew the
  // name, the level goal AND the Swap button — 3 rounds × 2 lifts × 3 facts = 18 restatements of 6.
  // The legend below states each exercise once; the rounds under it are pure logging.
  var LEG_REG = {};
  function legendRow(slot, ex, timer) {
    var lr = el('div', 'lg-row');
    var nm = el('button', 'ex-name lg-name', exLabel(ex)); nm.type = 'button';
    if (ex.video_url) nm.classList.add('has-video');
    nm.addEventListener('click', function () { openVideo(ex.video_url); });
    lr.appendChild(nm);
    // The level goal is a property of the exercise's rung, identical on every work set — so read it
    // off the first work set and show it here, not once per round.
    var firstWork = null;
    (ex.sets || []).forEach(function (t) { if (!firstWork && t.kind !== 'warmup') firstWork = t; });
    var gt = firstWork ? goalTarget(ex, firstWork) : null;
    if (gt) lr.appendChild(gt);
    if ((ex.alternates && ex.alternates.length) || ex._alt_of) {
      var sw = el('button', 'swapbtn'); sw.type = 'button'; sw.innerHTML = '⇄ Swap';
      sw.addEventListener('click', function () { toggleSwap(lr, ex); });
      lr.appendChild(sw);
    }
    return lr;
  }
  // Build the row descriptor for one choice — either the original exercise, or an alternate carrying
  // its OWN dosing (Alternates-tab reps, no external load).
  function swapTarget(a, oEx, oT) {
    if (a.main) return { ex: oEx, t: oT };
    var numReps = (a.reps !== '' && a.reps != null && !isNaN(a.reps)) ? Number(a.reps) : null;
    return {
      ex: { exercise: a.name, display_name: a.name, athlete_name: a.name, variant_name: '', video_url: a.video_url || '',
        alternates: oEx.alternates, level_goal: null, mode: 'accessory', rest_s: oEx.rest_s, each_side: oEx.each_side,
        _alt_of: oEx, _alt_t: oT },
      t: { set_no: oT.set_no, kind: oT.kind, target_load: '', target_reps: (numReps == null ? '' : numReps), duration_s: null }
    };
  }
  // QA-05: apply the choice to EVERY set of that exercise in the session.
  function applySwapAll(key, a) {
    var entries = (ROW_REG[key] || []).slice();
    ROW_REG[key] = [];                      // the rebuilt rows re-register themselves
    entries.forEach(function (en) {
      var oEx = en.ex._alt_of || en.ex, oT = en.ex._alt_t || en.t;   // each set keeps its own set_no
      var tgt = swapTarget(a, oEx, oT);
      var newRow = exerciseRow(en.slot, tgt.ex, tgt.t, en.timer, en.isASide);
      if (en.row.parentNode) en.row.replaceWith(newRow);
    });
    // The legend now owns the name/goal/Swap, so a swap has to redraw it too — otherwise the header
    // would still name the exercise you just swapped away from.
    var lg = LEG_REG[key];
    if (lg) {
      var lEx = lg.ex._alt_of || lg.ex;
      var tgt2 = swapTarget(a, lEx, (lEx.sets && lEx.sets[0]) || {});
      tgt2.ex.sets = lEx.sets;              // alternates carry no sets[]; the goal lookup needs them
      var newLeg = legendRow(lg.slot, tgt2.ex, lg.timer);
      if (lg.node.parentNode) lg.node.replaceWith(newLeg);
      LEG_REG[key] = { node: newLeg, ex: tgt2.ex, slot: lg.slot, timer: lg.timer };
    }
  }
  // Swap panel: pick a reason-tagged alternate → every set of that exercise becomes it, with the
  // alternate's own dosing. "Keep original" reverts. Works from an alternate row too (_alt_of).
  // PRINCIPLES 1+2: the reason is shown as-is (Phil edits the Alternates 'reason' column to plain
  // words), and the list shows only the reason + movement — never the dosing.
  function toggleSwap(row, ex) {
    var open = row.querySelector('.swap-panel');
    if (open) { open.remove(); return; }
    var origEx = ex._alt_of || ex;
    var panel = el('div', 'swap-panel');
    panel.appendChild(el('div', 'swap-h', 'Change exercise'));
    var opts = [{ main: true }].concat(origEx.alternates || []);
    opts.forEach(function (a) {
      var text = a.main ? ('↩ ' + exLabel(origEx)) : (a.reason + ': ' + a.name);
      var b = el('button', 'swap-opt', text); b.type = 'button';
      b.addEventListener('click', function () { applySwapAll(origEx.exercise, a); });
      panel.appendChild(b);
    });
    row.appendChild(panel);
  }

  // Conditioning: rolling work/rest timer runs all reps hands-free, then log distance.
  // This is the one place where TIME IS THE EXERCISE (30s on / 60s off), so every phase change
  // gets a sound + vibration + banner — you can't be expected to watch a button in the gym.
  function cuePhase(p) {
    beep();
    if (p === 'WORK') timerAlert('GO', 'work');
    else timerAlert('REST', 'recover', 'rest');
  }
  function startIntervals(btn, reps, work, rest, done) {
    primeAudio();                                          // unlock audio on the starting tap (iOS)
    btn.disabled = true; btn.classList.add('holding');
    var seq = [];
    for (var i = 0; i < reps; i++) { seq.push({ p: 'WORK', s: work || 0 }); if (i < reps - 1 && rest > 0) seq.push({ p: 'REST', s: rest }); }
    if (!seq.length) { btn.disabled = false; btn.classList.remove('holding'); done(0); return; }
    var idx = 0, rem = seq[0].s, totalWork = 0;
    cuePhase(seq[0].p);                                    // cue the first phase immediately
    var iv = setInterval(function () {
      var cur = seq[idx];
      btn.textContent = cur.p + ' ' + Math.max(0, rem) + 's';
      if (cur.p === 'WORK') totalWork++;
      rem--;
      if (rem < 0) {
        idx++;
        if (idx >= seq.length) {                           // all intervals done
          clearInterval(iv); btn.disabled = false; btn.classList.remove('holding');
          beep(); timerAlert('Done', 'intervals complete');
          done(totalWork); return;
        }
        rem = seq[idx].s;
        cuePhase(seq[idx].p);                              // sound + banner on every WORK<->REST change
      }
    }, 1000);
  }
  function conditioningRow(slot, ex, t) {
    var row = el('div', 'ex-row cond');
    if (slot.exercises && slot.exercises.length > 1) row.appendChild(el('span', 'ex-name sub', exLabel(ex)));
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

  // Exactly two lines: [name .......... ⇄ Swap] / [goal·aim | one control | ✓].
  // Control rule (Phil 2026-07-15): WEIGHTED lifts adjust weight only (reps are the fixed goal);
  // BODYWEIGHT/stability lifts adjust reps; loaded carries (wants_load) get a weight field beside the hold.
  function exerciseRow(slot, ex, t, timer, isASide) {
    if (ex.mode === 'conditioning') return conditioningRow(slot, ex, t);
    var isDur = !!t.duration_s, isAcc = ex.mode === 'accessory';
    var row = el('div', 'ex-row' + (t.kind === 'warmup' ? ' warmup' : ''));
    var cur = { exercise: ex.exercise, video: ex.video_url };   // swap target

    // --- line 1: the name, ONLY when the round needs it to tell two lifts apart ---
    // Name, level goal and Swap now live once in the slot legend (S17). In a complex you still need
    // to know which lift this row is, so the name stays — demoted. In a single-exercise slot the
    // legend already said it, and repeating it on every set is pure noise: the row drops to one line.
    var multi = !!(slot.exercises && slot.exercises.length > 1);
    if (multi) {
      var l1 = el('div', 'l1');
      // Deliberately NOT a video link: the legend above owns that. A blue underlined name on every
      // set made the most repeated fact the loudest thing on screen. Here it's a quiet label.
      var name = el('span', 'ex-name sub', exLabel(ex));
      l1.appendChild(name);
      row.appendChild(l1);
    }

    var prefill = isAcc ? ((ex.load_prefill === '' || ex.load_prefill == null) ? '' : ex.load_prefill) : t.target_load;
    var state = { load: prefill, reps: t.target_reps };
    // Weighted = has a prescribed load, a loaded accessory with a prefill, or a flagged loaded carry.
    var weighted = (t.target_load !== '' && t.target_load != null) || (isAcc && prefill !== '') || !!ex.wants_load;
    if (weighted && (state.load === '' || state.load == null)) state.load = 0;   // carries/blank start at 0 to bump up
    // EDIT: if this set was already logged (opening a completed day), show the LOGGED actuals and start
    // it checked. Uncheck → adjust → re-check appends a correction row (server keeps the latest).
    var lgd = ex.logged && ex.logged[String(t.set_no) + '|'];
    var wasLogged = !!lgd;
    if (lgd) {
      if (lgd.load !== '' && lgd.load != null) state.load = Number(lgd.load);
      if (lgd.reps !== '' && lgd.reps != null) state.reps = Number(lgd.reps);
    }

    // --- line 2: [hold hint] · [subtle reps] · primary weight/reps stepper · ✓ (right-aligned lanes) ---
    var l2 = el('div', 'l2');
    if (isDur) {
      l2.appendChild(el('span', 'gt', t.duration_s + 's hold'));
      if (weighted) l2.appendChild(stepper(state, 'load', 2.5, 'lb'));   // loaded carry gets a weight field
    } else if (weighted) {
      if (t.target_reps !== '' && t.target_reps != null) l2.appendChild(stepper(state, 'reps', 1, 'reps', 'mini'));  // secondary/subtle reps
      l2.appendChild(stepper(state, 'load', 2.5, ''));                   // primary weight adjuster
    } else {
      l2.appendChild(stepper(state, 'reps', 1, ''));                     // bodyweight/stability — adjust reps (primary)
    }

    var lastLogId = null;
    function commit() {   // checking = "already did it" — the timer is its own Start button, not tied to this
      var log = mkLog(slot, cur.exercise, t, state); if (isDur) log.duration_s = t.duration_s;
      lastLogId = log.log_id;
      logRows([log]);
      row.classList.add('done'); check.classList.add('done'); check.textContent = '✓';
    }
    function uncheck() {   // undo an accidental check (pulls the log back if not yet sent)
      if (lastLogId) qDel([lastLogId]).then(updateBadge).catch(function () {});
      lastLogId = null; row.classList.remove('done'); check.classList.remove('done');
      check.textContent = isDur ? '▶' : '✓';
    }
    // Same-size control in the rightmost lane for every row: ✓ to log, ▶ to start a timed hold (the
    // duration is already shown as "Ns hold" in the goal cell), so it lines up with the checkmarks.
    var check = el('button', 'check', isDur ? '▶' : '✓'); check.type = 'button';
    check.addEventListener('click', function () {
      if (check.disabled) return;
      if (check.classList.contains('done')) { uncheck(); return; }   // tap a done set again to undo
      if (isDur) startHold(check, t.duration_s, commit); else commit();
    });
    l2.appendChild(check);
    row.appendChild(l2);
    if (wasLogged) { row.classList.add('done'); check.classList.add('done'); check.textContent = '✓'; }   // show as logged; tap to edit
    regRow({ row: row, slot: slot, ex: ex, t: t, timer: timer, isASide: isASide });   // so a swap can reach every set (QA-05)
    return row;
  }

  function renderSummary(n, d) {
    app.innerHTML = '';
    app.appendChild(el('h2', 'sum-h', 'Workout complete 💪'));
    app.appendChild(el('p', 'sum-sub', n + ' set' + (n === 1 ? '' : 's') + ' logged'));
    var home = el('button', 'finish', '← Back to calendar'); home.type = 'button';
    home.addEventListener('click', function () { loadHome(); }); app.appendChild(home);
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
    if (d.level_ups && d.level_ups.length) {   // celebrate any rung the athlete passed this session
      app.appendChild(el('h3', 'sum-t up', 'Leveled up! 🎉'));
      d.level_ups.forEach(function (u) {
        app.appendChild(el('div', 'sum-row up levelup', u.exercise + ' → level ' + u.level));
      });
    }
    block('Top gains 🔺', d.best, 'up');
    block('Keep an eye on 🔻', d.worst, 'down');
  }

  function render(s) {
    SESSION = s;
    ROW_REG = {}; LEG_REG = {};   // fresh registries per session render
    renderNav('wo');
    meta.textContent = (s.name || s.theme) + ' · ' + s.date;
    app.innerHTML = '';
    var back = el('button', 'back', '← Calendar'); back.type = 'button';
    back.addEventListener('click', function () { loadHome(); });
    app.appendChild(back);
    // Move an unlogged workout to another day
    var movable = s.slots.every(function (sl) { return sl.status === 'planned' || sl.status === 'missed'; });
    if (movable) {
      var mv = el('div', 'move-wrap');
      var mBtn = el('button', 'movebtn', '⇄ Move to another day'); mBtn.type = 'button';
      var dIn = el('input', 'move-date'); dIn.type = 'date'; dIn.hidden = true;
      var gBtn = el('button', 'move-go', 'Move'); gBtn.type = 'button'; gBtn.hidden = true;
      mBtn.addEventListener('click', function () { mBtn.hidden = true; dIn.hidden = false; gBtn.hidden = false; });
      gBtn.addEventListener('click', function () { if (!dIn.value) return; gBtn.textContent = 'Moving…'; sendMove(s.session_id, dIn.value); setTimeout(loadHome, 1300); });
      mv.appendChild(mBtn); mv.appendChild(dIn); mv.appendChild(gBtn); app.appendChild(mv);
    }
    s.slots.forEach(function (slot) {
      var card = el('section', 'slot');
      var head = el('div', 'slot-head');
      head.appendChild(el('h2', 'slot-title', slotLabel(slot.slot)));   // "Warm Up 1" / "Complex 1"
      var timerNode = el('span', 'timer');
      // "Begin complex · 3:00" — a check means "I already did that set", so the timer can't
      // auto-start off one; it needs an explicit "I'm starting now". The label says what it does
      // and how long the complex runs, so it reads without a coach standing there.
      var startBtn = el('button', 'tstart', 'Begin complex · ' + fmt(slot.interval_s || 300)); startBtn.type = 'button';
      var pauseBtn = el('button', 'pause', '⏸'); pauseBtn.type = 'button'; pauseBtn.hidden = true;
      head.appendChild(startBtn); head.appendChild(timerNode); head.appendChild(pauseBtn);
      card.appendChild(head);
      var timer = makeTimer(timerNode, pauseBtn, slot.interval_s || 300);
      startBtn.addEventListener('click', function () { timer.start(); startBtn.hidden = true; });

      // The prescription, stated once — the way a coach writes it on paper.
      var legend = el('div', 'ex-legend');
      slot.exercises.forEach(function (ex) {
        var lr = legendRow(slot, ex, timer);
        LEG_REG[(ex._alt_of || ex).exercise] = { node: lr, ex: ex, slot: slot, timer: timer };
        legend.appendChild(lr);
      });
      card.appendChild(legend);

      var body = el('div', 'sets');
      var aSide = slot.exercises[0];
      var maxSets = 0;
      slot.exercises.forEach(function (ex) { if (ex.sets.length > maxSets) maxSets = ex.sets.length; });
      // QA-06: ordinals match the athlete's real count — warm-ups are sets too, so the work sets
      // continue from them (3 warm-ups -> the work sets read Set 4, 5, 6), never restarting at 1.
      var warmNo = 0;
      for (var r = 0; r < maxSets; r++) {
        var roundBox = el('div', 'round');
        var aSet = aSide && aSide.sets[r];
        var isWarmRound = aSet && aSet.kind === 'warmup';
        var title = isWarmRound ? ('Warm-up ' + (++warmNo)) : ('Set ' + (r + 1));
        roundBox.appendChild(el('div', 'round-title', title));
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
      var total = document.querySelectorAll('.ex-row').length, n = document.querySelectorAll('.ex-row.done').length;
      if (n < total && !window.confirm((total - n) + ' of ' + total + ' sets aren’t checked off yet. Finish anyway?')) return;
      drain();   // flush the queue so the summary sees this session's sets
      sendComplete(SESSION.session_id);   // mark done → reopening advances to the next session
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
    loadHome();
  }

  // ---- Home = calendar of the athlete's sessions; tap a day to open that workout ----
  function mondayOf(s) { var x = new Date(s + 'T00:00:00'); x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); return x; }
  function ymd(d) { return d.toLocaleDateString('en-CA'); }
  function loadHome() {
    show('Loading your plan…');
    fetch(cfg.WEBAPP_URL + '?action=week&athlete=' + encodeURIComponent(athlete) + '&token=' + encodeURIComponent(token))
      .then(function (r) { return r.json(); }).then(function (data) {
        if (!data.ok) return show('Access denied — check your link.', 'err');
        if (!data.sessions || !data.sessions.length) return show('No workouts scheduled yet.');
        renderCalendar(data.sessions);
      }).catch(function () { show('Offline — reconnect to see your plan.', 'err'); });
  }
  function renderCalendar(sessions) {
    SESSION = null; app.innerHTML = ''; renderNav('cal');
    meta.textContent = athlete + ' · pick a workout';
    var byDate = {}; sessions.forEach(function (s) { (byDate[s.date] = byDate[s.date] || []).push(s); });   // a day can hold >1
    var ds = sessions.map(function (s) { return s.date; }).sort();
    var today = todayISO(), first = ds[0], last = ds[ds.length - 1];
    var cal = el('div', 'cal');
    var head = el('div', 'cal-row cal-head'); ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].forEach(function (d) { head.appendChild(el('div', 'cal-dow', d)); }); cal.appendChild(head);
    var mon = mondayOf(first), guard = 0;
    while (ymd(mon) <= last && guard < 10) {
      var row = el('div', 'cal-row');
      for (var i = 0; i < 7; i++) {
        var d = new Date(mon); d.setDate(d.getDate() + i); var key = ymd(d);
        var cell = el('div', 'cal-cell'); if (key === today) cell.classList.add('today');
        cell.appendChild(el('div', 'cal-num', String(d.getDate())));
        var list = byDate[key] || [];
        if (!list.length) cell.classList.add('empty');
        // A 390px phone gives each of 7 columns ~40px. "Lower Body" cannot fit in 40px, so it was
        // being shattered mid-word ("Low er Body", "Conditi oning"). The grid answers "which days do
        // I train, and did I?" — a status bar answers that in 40px. The NAME is answered by the list
        // below, where there's room to read it.
        list.forEach(function (s) {
          var chip = el('button', 'cal-chip st-' + s.status); chip.type = 'button';
          chip.title = s.name || s.theme || 'session';
          chip.appendChild(el('span', 'chip-tick', s.status === 'done' ? '✓' : s.status === 'missed' ? '–' : ''));
          (function (sid) { chip.addEventListener('click', function () { openSession(sid); }); })(s.session_id);
          cell.appendChild(chip);
        });
        row.appendChild(cell);
      }
      cal.appendChild(row); mon.setDate(mon.getDate() + 7); guard++;
    }
    app.appendChild(cal);

    // ---- Up next: the workout names, where they actually fit ----
    // This is also what fills the screen. Phil: "the calendar fills up about 10% of the screen" — the
    // grid is only ~3 rows tall on a short plan, and the rest of an 844px phone was blank.
    var upcoming = sessions.filter(function (s) { return s.date >= today || s.status === 'started' || s.status === 'missed'; });
    if (!upcoming.length) upcoming = sessions.slice(-4);
    var lst = el('div', 'agenda');
    lst.appendChild(el('div', 'agenda-h', 'Up next'));
    upcoming.slice(0, 8).forEach(function (s) {
      var wrap = el('div', 'ag-row st-' + s.status);
      var b = el('button', 'ag-open'); b.type = 'button';       // a <button> can't nest a <button>
      var when = el('span', 'ag-when', s.date === today ? 'Today' : dowLabel(s.date));
      if (s.date === today) when.classList.add('is-today');
      b.appendChild(when);
      b.appendChild(el('span', 'ag-name', s.name || s.theme || 'session'));
      b.appendChild(el('span', 'ag-st', s.status === 'done' ? '✓ done' : s.status === 'missed' ? 'missed' : s.status === 'started' ? 'started' : ''));
      b.addEventListener('click', function () { openSession(s.session_id); });
      wrap.appendChild(b);

      // S16: move a workout from the calendar — "if u miss one, you can move it forward".
      // Only offered where it can actually succeed: the server freezes any session that has logged
      // sets, and sendMove is a no-cors POST whose response we CANNOT read — so an offer we can't
      // honour would fail silently and look like the app ignored the tap. done/started have logs.
      if (s.status === 'planned' || s.status === 'missed') {
        var mv = el('button', 'ag-move', '⇄'); mv.type = 'button';
        mv.title = 'Move to another day';
        mv.addEventListener('click', function () { toggleMove(wrap, s); });
        wrap.appendChild(mv);
      }
      lst.appendChild(wrap);
    });
    app.appendChild(lst);
  }
  // Move panel, opened from an agenda row. Two ways to land a date: the quick chips (what an athlete
  // actually wants — "push it to tomorrow"), or a date field for anything else.
  function toggleMove(wrap, s) {
    var open = wrap.querySelector('.move-panel');
    if (open) { open.remove(); return; }
    var p = el('div', 'move-panel');
    p.appendChild(el('div', 'move-h', 'Move “' + (s.name || s.theme || 'workout') + '” to'));
    function go(iso) {
      p.innerHTML = ''; p.appendChild(el('div', 'move-h', 'Moving to ' + dowLabel(iso) + '…'));
      sendMove(s.session_id, iso);
      setTimeout(loadHome, 1300);   // re-read the week; the server bumped the plan version
    }
    // A MISSED workout is moved FORWARD from today ("if u miss one, you can move it forward") — its
    // own date is in the past, so "tomorrow" relative to THAT is still in the past. A workout still
    // ahead of you is pushed back from where it sits. Same button, two honest meanings.
    var today2 = todayISO(), past = s.date < today2;
    var quick = el('div', 'move-quick');
    var opts = past ? [['Today', 0], ['Tomorrow', 1], ['Next week', 7]]
                    : [['+1 day', 1], ['+2 days', 2], ['+1 week', 7]];
    opts.forEach(function (q) {
      var b = el('button', 'move-opt', q[0]); b.type = 'button';
      b.addEventListener('click', function () { go(addDays(past ? today2 : s.date, q[1])); });
      quick.appendChild(b);
    });
    p.appendChild(quick);
    var row = el('div', 'move-any');
    var dIn = el('input', 'move-date'); dIn.type = 'date';
    dIn.value = past ? today2 : s.date;      // never open the picker on a date that's already gone
    dIn.min = today2;                        // and never let one be chosen
    var gBtn = el('button', 'move-go', 'Move'); gBtn.type = 'button';
    gBtn.addEventListener('click', function () { if (dIn.value) go(dIn.value); });
    row.appendChild(dIn); row.appendChild(gBtn); p.appendChild(row);
    wrap.appendChild(p);
  }
  function addDays(iso, n) {
    var p = String(iso).split('-');
    var d = new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
    d.setDate(d.getDate() + n);
    return ymd(d);
  }
  // "2026-07-20" -> "Mon 20" — parsed as local, not UTC (new Date("YYYY-MM-DD") is UTC and can slip a day).
  function dowLabel(iso) {
    var p = String(iso).split('-');
    var d = new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
    return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getDay()] + ' ' + d.getDate();
  }
  // ---- bottom nav: Calendar / Workout / Profile, reachable from any screen (S18 AC1) ----
  var NAV = null;
  function renderNav(active) {
    if (!NAV) {
      NAV = el('nav', 'nav');
      [['cal', '📅', 'Calendar', function () { loadHome(); }],
       ['wo', '🏋️', 'Workout', function () { openToday(); }],
       ['prof', '📈', 'Profile', function () { loadProfile(); }]].forEach(function (d) {
        var b = el('button', 'nav-b'); b.type = 'button'; b.dataset.k = d[0];
        b.appendChild(el('span', 'nav-i', d[1])); b.appendChild(el('span', 'nav-t', d[2]));
        b.addEventListener('click', d[3]);
        NAV.appendChild(b);
      });
      document.body.appendChild(NAV);
    }
    Array.prototype.forEach.call(NAV.querySelectorAll('.nav-b'), function (b) { b.classList.toggle('on', b.dataset.k === active); });
  }
  // "Workout" = today's session, else the next planned one (the legacy advance endpoint does this).
  function openToday() {
    show('Loading…'); renderNav('wo');
    fetch(planUrl()).then(function (r) { return r.json(); }).then(function (data) {
      if (!data.ok) return show('Access denied — check your link.', 'err');
      if (!data.session) return show('All caught up — no upcoming session.');
      render(data.session);
    }).catch(function () { show('Offline — reconnect to open your workout.', 'err'); });
  }

  // ---- Profile: distance-to-next-rung first; bests are the record, not the headline ----
  function loadProfile() {
    show('Loading your progress…'); renderNav('prof');
    fetch(cfg.WEBAPP_URL + '?action=profile&athlete=' + encodeURIComponent(athlete) + '&token=' + encodeURIComponent(token))
      .then(function (r) { return r.json(); }).then(function (data) {
        if (!data.ok) return show('Access denied — check your link.', 'err');
        renderProfile(data.exercises || []);
      }).catch(function () { show('Offline — reconnect to see your progress.', 'err'); });
  }
  function renderProfile(list) {
    SESSION = null; app.innerHTML = '';
    meta.textContent = athlete + ' · your progress';
    if (!list.length) { app.appendChild(el('p', 'empty', 'No exercises yet.')); return; }
    list.forEach(function (x) {
      var card = el('section', 'pcard');
      var top = el('div', 'p-top');
      top.appendChild(el('div', 'p-name', x.name));
      if (x.level) top.appendChild(el('div', 'p-lvl' + (x.maxed ? ' maxed' : ''), x.maxed ? 'TOP' : ('L' + x.level)));
      card.appendChild(top);

      if (x.level && !x.maxed && x.to_go != null) {          // the motivating unit
        var goalTxt = x.goal.load != null ? (x.goal.load + ' lb × ' + x.goal.reps) : (x.goal.reps + ' reps');
        var toGoTxt = x.goal.load != null ? (x.to_go + ' lb to go') : (x.to_go + (x.to_go === 1 ? ' rep to go' : ' reps to go'));
        card.appendChild(el('div', 'p-togo', x.to_go === 0 ? 'Ready to level up' : toGoTxt));
        var bar = el('div', 'p-bar'); var fill = el('div', 'p-fill');
        fill.style.width = Math.round((x.progress || 0) * 100) + '%'; bar.appendChild(fill); card.appendChild(bar);
        card.appendChild(el('div', 'p-goal', 'next level: ' + goalTxt));
      } else if (x.maxed) {
        card.appendChild(el('div', 'p-togo maxed', 'Top of the ladder 🏆'));
      }

      if (!x.has_data) {                                     // AC5: explicit empty state, never a blank/zero
        card.appendChild(el('div', 'p-empty', 'No sets logged yet — log one and your bests show up here.'));
      } else {
        // Only render a stat that actually applies — a bodyweight lift has no 1RM, and an em-dash
        // in a stat tile is a blank pretending to be data (AC5).
        var st = el('div', 'p-stats'), n = 0;
        function stat(lbl, val) { var d = el('div', 'p-stat'); d.appendChild(el('div', 'p-sv', val)); d.appendChild(el('div', 'p-sl', lbl)); return d; }
        if (x.best_1rm != null) { st.appendChild(stat('best est. 1RM', x.best_1rm + ' lb')); n++; }
        if (x.best_volume != null) { st.appendChild(stat('best volume', x.best_volume + (x.volume_unit === 'reps' ? ' reps' : ' lb'))); n++; }
        if (n === 1) st.style.gridTemplateColumns = '1fr';
        if (n) card.appendChild(st);
      }
      app.appendChild(card);
    });
  }

  function openSession(sessionId) {
    show('Loading…');
    fetch(cfg.WEBAPP_URL + '?action=session&athlete=' + encodeURIComponent(athlete) + '&session_id=' + encodeURIComponent(sessionId) + '&token=' + encodeURIComponent(token))
      .then(function (r) { return r.json(); }).then(function (data) {
        if (!data.ok || !data.session) return show('No workout that day.');
        render(data.session);
      }).catch(function () { show('Offline — reconnect to open this workout.', 'err'); });
  }

  load();
  updateBadge().then(drain);
})();
