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
    // Phase banner. `sticky` = stays until the athlete taps it (the ROBUST cue: on iOS the ringer
    // switch mutes WebAudio, so a gym phone on silent gets NO beep — Phil got exactly this). A
    // banner that vanishes in 1.7s is missed if you glanced away; a persistent one can't be. Auto
    // (non-sticky) is kept for fast conditioning WORK<->REST flips where a tap-to-clear would nag.
    var _talert = null;
    function timerAlert(big, sub, cls, sticky) {
      if (_talert) { _talert.remove(); _talert = null; }
      var ov = el('div', 'talert' + (cls ? ' ' + cls : '') + (sticky ? ' sticky' : ''));
      ov.appendChild(el('div', 'talert-big', big || 'Rest done'));
      ov.appendChild(el('div', 'talert-sub', sub || 'next set — go'));
      if (sticky) ov.appendChild(el('div', 'talert-tap', 'tap to dismiss'));
      document.body.appendChild(ov);
      requestAnimationFrame(function () { ov.classList.add('show'); });
      if (sticky) {
        _talert = ov;
        var clear = function () { ov.classList.remove('show'); setTimeout(function () { ov.remove(); }, 300); if (_talert === ov) _talert = null; };
        ov.addEventListener('click', clear);
        // pulse the beep a few times while it's up — best-effort, in case the ringer IS on
        var pulses = 0, pv = setInterval(function () { if (++pulses >= 3 || !ov.parentNode) { clearInterval(pv); return; } beep(); }, 700);
      } else {
        setTimeout(function () { ov.classList.remove('show'); setTimeout(function () { ov.remove(); }, 300); }, 1700);
      }
    }
  // `intervals` is one rest per ROUND — a paired round costs more than a round with a single lift
  // (Deadlift + Step Down = 5:00, Deadlift alone = 3:00). The timer rolls THROUGH that sequence
  // rather than repeating one number, which is what made a solo work round charge paired rest.
  // ---- rule 5: the running timer holds ONE fixed position ----
  // The slot header scrolls away as soon as you're two sets down, so the countdown was only findable,
  // not glanceable. Phil: "ideally timer stays in view since user might need to scroll but still is in
  // same complex. one timer can only run at a time i guess though" — that last clause is what makes a
  // single pinned bar correct rather than ambiguous: starting a timer stops any other, so the bar
  // never has to answer "which complex is this?".
  var TBAR = null, ACTIVE_TIMER = null;
  function tbar() {
    if (!TBAR) {
      TBAR = el('div', 'tbar'); TBAR.hidden = true;
      TBAR._l = el('span', 'tb-l'); TBAR._v = el('span', 'tb-v');
      TBAR._p = el('button', 'tb-p', '⏸'); TBAR._p.type = 'button';
      TBAR.appendChild(TBAR._l); TBAR.appendChild(TBAR._v); TBAR.appendChild(TBAR._p);
      TBAR._p.addEventListener('click', function () { if (ACTIVE_TIMER) ACTIVE_TIMER.toggle(); });
      document.body.appendChild(TBAR);
    }
    return TBAR;
  }
  function clearTimerBar() {   // new session render — nothing is running
    if (ACTIVE_TIMER) ACTIVE_TIMER.stop();
    ACTIVE_TIMER = null;
    if (TBAR) TBAR.hidden = true;
    document.body.classList.remove('has-tbar');
  }

  function makeTimer(node, pauseBtn, intervals, label) {
    var seq = (intervals && intervals.length) ? intervals.slice() : [120];
    var idx = 0;
    var interval = seq[0];
    var st = { running: false, paused: false, end: 0, rem: interval, t: null };
    var api;
    function pub(txt) {            // mirror this timer into the pinned bar (rule 5)
      if (ACTIVE_TIMER !== api) return;
      var b = tbar(); b.hidden = false;
      b._l.textContent = label || 'Complex';
      b._v.textContent = txt;
      b._p.hidden = !st.running;
      b._p.textContent = st.paused ? '▶' : '⏸';
      document.body.classList.add('has-tbar');
    }
    function unpub() {
      if (ACTIVE_TIMER !== api) return;
      ACTIVE_TIMER = null;
      if (TBAR) TBAR.hidden = true;
      document.body.classList.remove('has-tbar');
    }
    function tick() {
      var left = Math.max(0, Math.round((st.end - Date.now()) / 1000));
      if (left <= 0) {
        // The complex is OVER once the last round's rest has elapsed. A 1-round slot (a single carry)
        // announcing "next round" is announcing a round that does not exist.
        if (idx >= seq.length - 1) {
          clearTimeout(st.t); st.running = false; st.t = null;
          node.textContent = 'complex done'; pauseBtn.hidden = true;
          pub('complex done'); setTimeout(unpub, 8000);   // hold the last cue, then give the space back
          beep(); timerAlert('Complex done', 'move on', '', true);   // sticky — the last cue must not be missed
          return;
        }
        idx += 1;
        interval = seq[idx];
        st.end = Date.now() + interval * 1000; left = interval; node.classList.add('flash'); setTimeout(function () { node.classList.remove('flash'); }, 900); beep(); timerAlert('Next set', 'go', '', true); }
      node.textContent = 'next ' + fmt(left);
      pub('next ' + fmt(left));
      st.t = setTimeout(tick, 250);
    }
    function toggle() {
      if (!st.running) return;
      if (st.paused) { st.paused = false; st.end = Date.now() + st.rem * 1000; pauseBtn.textContent = '⏸'; tick(); }
      else {
        st.paused = true; clearTimeout(st.t);
        st.rem = Math.max(0, Math.round((st.end - Date.now()) / 1000));
        pauseBtn.textContent = '▶'; node.textContent = 'paused ' + fmt(st.rem); pub('paused ' + fmt(st.rem));
      }
    }
    pauseBtn.addEventListener('click', toggle);
    api = {
      toggle: toggle,
      stop: function () { clearTimeout(st.t); st.t = null; st.running = false; st.paused = false; node.textContent = ''; pauseBtn.hidden = true; },
      start: function () {
        if (st.running) return;
        // one timer at a time — this is what lets the pinned bar be unambiguous
        if (ACTIVE_TIMER && ACTIVE_TIMER !== api) ACTIVE_TIMER.stop();
        ACTIVE_TIMER = api;
        primeAudio(); st.running = true; st.end = Date.now() + interval * 1000; pauseBtn.hidden = false; tick();
      }
    };
    return api;
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
    span.appendChild(el('span', 'lbl', 'level goal '));
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
  function stepper(state, key, delta, unit, extraCls, onTouch) {
    var f = el('div', 'stepper' + (extraCls ? ' ' + extraCls : ''));
    var val = el('span', 'val');
    function draw() { var v = state[key]; val.textContent = (v === '' || v == null) ? '—' : v; }
    // Touching the number in any way is the athlete asserting it's what they actually did — adjusting
    // it, or tapping it to confirm the prescribed value stands. Both count (rule 2b).
    function touched() { f.classList.remove('unconfirmed'); if (onTouch) onTouch(); }
    function btn(sign) {
      var b = el('button', 'step', sign > 0 ? '+' : '−'); b.type = 'button';
      b.addEventListener('click', function () { var c = Number(state[key] || 0), nv = Math.round((c + sign * delta) * 10) / 10; if (nv < 0) nv = 0; state[key] = nv; draw(); touched(); });
      return b;
    }
    f.appendChild(btn(-1)); f.appendChild(val); if (unit) f.appendChild(el('span', 'unit', unit)); f.appendChild(btn(1));
    val.addEventListener('click', touched);
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
      t: { set_no: oT.set_no, kind: oT.kind, target_load: '', target_reps: (numReps == null ? oT.target_reps : numReps), duration_s: null }
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
    // Same two lines and the same four columns as a lifting row (rule 6). Running's actual is the
    // DISTANCE, its secondary is the time — so it lands in column b under every other lift's weight.
    var row = el('div', 'ex-row cond');
    var l1 = el('div', 'l1');
    l1.appendChild(el('span', 'ex-name', exLabel(ex)));
    var scheme = t.duration_s ? (Math.round(t.duration_s / 60) + ' min')
      : ((t.target_reps || 1) + (t.work_s ? (' × ' + t.work_s + 's work / ' + (t.rest_s || 0) + 's rest') : ' reps'));
    l1.appendChild(el('span', 'goaltag', scheme));
    row.appendChild(l1);
    var dist = { v: '' };
    var l2 = el('div', 'l2');
    var aCell = el('div', 'c-actual');
    var di = el('input', 'dist-in'); di.type = 'number'; di.placeholder = 'distance'; di.inputMode = 'decimal';
    di.addEventListener('input', function () { dist.v = di.value; });
    aCell.appendChild(di);
    var bCell = el('div', 'c-second');
    if (t.duration_s) bCell.appendChild(el('span', 'cv', Math.round(t.duration_s / 60) + ' min'));
    else if (t.work_s) bCell.appendChild(el('span', 'cv', t.work_s + 's'));
    l2.appendChild(aCell); l2.appendChild(bCell); l2.appendChild(el('div', 'c-swap'));
    row.appendChild(l2);
    var check = el('button', 'check cond-go', t.work_s ? 'Start' : (t.duration_s ? ('Start ' + Math.round(t.duration_s / 60) + 'm') : '✓')); check.type = 'button';
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
    l2.appendChild(check);
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

    // --- line 1: name · level goal .......... ⇄ Swap ---
    var l1 = el('div', 'l1');
    // Only render a tappable name when there IS a clip (QA-03). Swapped-in alternates mostly have no
    // video in the Workbook, and a button that opens nothing reads as broken.
    var name;
    if (cur.video) {
      name = el('button', 'ex-name has-video', exLabel(ex)); name.type = 'button';
      name.addEventListener('click', function () { openVideo(cur.video); });
    } else {
      name = el('span', 'ex-name', exLabel(ex));
    }
    l1.appendChild(name);
    var gtag = goalTarget(ex, t); if (gtag) l1.appendChild(gtag);   // rule 8: quiet, pushed right
    row.appendChild(l1);

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

    // --- line 2: FIXED COLUMNS, identical for every row type ---
    // Phil 2026-07-18: "symmetry is crucial in UX horizontally. a. exercise name, b. actual (goal for
    // day) which could be weight/reps/distance run/time, c. secondary variable (usually reps if
    // weighted exercise) or distance if running, d. swap icon, e. timer etc."
    // The old layout kept weight and reps in dedicated lanes, so a bodyweight lift left the weight
    // lane empty and its reps sat where a weighted lift's REPS sat — the primary number moved
    // depending on the exercise, and nothing lined up down the card. Now column b is always THE
    // actual, whatever kind of number that is, and column c is always the secondary:
    //   weighted lift   ->  b = weight    c = reps (or the hold's duration for a loaded carry)
    //   bodyweight lift ->  b = reps      c = —
    //   timed hold      ->  b = duration  c = —
    //   running         ->  b = distance  c = time      (conditioningRow, same columns)
    var l2 = el('div', 'l2');

    // RULE 2b — the athlete must not be able to blind-tap "done", because the prescribed number is
    // usually NOT what happened, and the adaptive allocator eats whatever gets logged. Phil: "the
    // actual is most often deviated (so weight if weighted exercise, reps should NOT vary much if at
    // all, but for pullups no weight so reps could vary)". So exactly one number per lift is THE
    // actual, and it has to be touched before the round can be logged:
    //   weighted lift  -> the WEIGHT   (reps are prescribed and generally held)
    //   bodyweight lift -> the REPS    (there is no weight; reps are the whole result)
    // Warm-ups are exempt — they are a ramp, not merit data, and stay one tap.
    var critical = weighted ? 'load' : ((!isDur && t.target_reps !== '' && t.target_reps != null) ? 'reps' : null);
    var needsConfirm = !!critical && t.kind !== 'warmup' && !wasLogged;
    row._confirmed = !needsConfirm;
    row._needs = critical === 'load' ? 'weight' : 'reps';
    // A timed row logs through its own ▶, which the round button deliberately doesn't drive — so the
    // gate has to be applied to the ▶ as well, or a loaded carry records at 0 lb and the allocator
    // believes it.
    function confirmActual() {
      row._confirmed = true;
      if (check) { check.disabled = false; check.classList.remove('locked'); }
      syncRound(row.parentNode);
    }

    var hasReps = !isDur && (t.target_reps !== '' && t.target_reps != null);
    function repsStepper() {
      var s = stepper(state, 'reps', 1, 'reps', '', critical === 'reps' ? confirmActual : null);
      if (needsConfirm && critical === 'reps') s.classList.add('unconfirmed');
      return s;
    }
    // b. THE ACTUAL — always this column, whatever kind of number it is.
    var aCell = el('div', 'c-actual');
    // c. THE SECONDARY — empty cell when there isn't one, so the columns still line up (rule 6).
    var bCell = el('div', 'c-second');
    if (weighted) {
      var wStep = stepper(state, 'load', 2.5, 'lb', '', critical === 'load' ? confirmActual : null);
      if (needsConfirm && critical === 'load') wStep.classList.add('unconfirmed');
      aCell.appendChild(wStep);
      if (isDur) bCell.appendChild(el('span', 'cv', t.duration_s + 's'));   // loaded carry: time is secondary
      else if (hasReps) bCell.appendChild(repsStepper());
    } else if (isDur) {
      aCell.appendChild(el('span', 'cv', t.duration_s + 's'));              // a hold: the time IS the actual
    } else if (hasReps) {
      aCell.appendChild(repsStepper());                                     // bodyweight: reps ARE the actual
    }
    l2.appendChild(aCell); l2.appendChild(bCell);

    // d. SWAP — acts on the exercise, but sits in its own fixed lane so every row is the same shape.
    var swCell = el('div', 'c-swap');
    if ((ex.alternates && ex.alternates.length) || ex._alt_of) {
      var sw = el('button', 'swapbtn'); sw.type = 'button'; sw.innerHTML = '⇄';
      sw.title = 'Change exercise';
      sw.addEventListener('click', function () { toggleSwap(row, ex); });
      swCell.appendChild(sw);
    }
    l2.appendChild(swCell);

    var lastLogId = null;
    function commit() {   // checking = "already did it" — the timer is its own Start button, not tied to this
      var log = mkLog(slot, cur.exercise, t, state); if (isDur) log.duration_s = t.duration_s;
      lastLogId = log.log_id;
      logRows([log]);
      row.classList.add('done'); check.classList.add('done'); check.textContent = '✓';
      refocus();   // rule 1: finishing a set advances what's in focus
    }
    function uncheck() {   // undo an accidental check (pulls the log back if not yet sent)
      if (lastLogId) qDel([lastLogId]).then(updateBadge).catch(function () {});
      lastLogId = null; row.classList.remove('done'); check.classList.remove('done');
      check.textContent = isDur ? '▶' : '✓';
      refocus();
    }
    // What the collapsed one-line form of this row says (rule 1). Reads live state, so a correction
    // shows the corrected numbers without a re-render.
    row._commit = commit; row._isDur = isDur;   // the round-level Log button drives these (rule 2b)
    row._sum = function () {
      var v = isDur ? (t.duration_s + 's')
        : (weighted ? (state.load + ' lb × ' + state.reps) : (state.reps + ' reps'));
      return { name: name.textContent, val: v };   // reads the node, so a swap renames the summary too
    };
    // Same-size control in the rightmost lane for every row: ✓ to log, ▶ to start a timed hold (the
    // duration is already shown as "Ns hold" in the goal cell), so it lines up with the checkmarks.
    var check = el('button', 'check' + (isDur ? ' dur' : ''), isDur ? '▶' : '✓'); check.type = 'button';
    check.addEventListener('click', function () {
      if (check.disabled) return;
      if (check.classList.contains('done')) { uncheck(); return; }   // tap a done set again to undo
      if (isDur) startHold(check, t.duration_s, commit); else commit();
    });
    if (needsConfirm && isDur) { check.disabled = true; check.classList.add('locked'); }
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

  // ---- rule 1: vertical order = temporal order ----
  // Everything stays in the DOM (so logging, swap, correction and "Finish workout" are untouched) —
  // only its VISIBILITY changes. Completed rounds collapse to a one-line record of what was actually
  // lifted, the round you're on is boxed and labelled NOW, the next one is a grey preview, the rest
  // wait. Tapping any collapsed thing opens it, so nothing is unreachable (rule 7).
  function roundSummary(rb) {
    var sum = rb.querySelector('.round-sum');
    if (!sum) { sum = el('div', 'round-sum'); rb.appendChild(sum); sum.addEventListener('click', function () { rb.classList.toggle('open'); }); }
    sum.innerHTML = '';
    var title = rb.getAttribute('data-title') || '';
    var rows = [].slice.call(rb.querySelectorAll('.ex-row'));
    if (rb.classList.contains('is-done')) {
      rows.forEach(function (r) {
        var s = r._sum && r._sum(); if (!s) return;
        var line = el('div', 'done-line');
        line.appendChild(el('span', 'dl-t', '✓ ' + title + ' · ' + s.name));
        line.appendChild(el('span', 'dl-v', s.val));
        sum.appendChild(line);
      });
    } else if (rb.classList.contains('is-next')) {
      var names = rows.map(function (r) { var s = r._sum && r._sum(); return s ? s.name : ''; }).filter(Boolean).join(' + ');
      var line = el('div', 'up-line');
      line.appendChild(el('span', 'dl-t', 'Next · ' + title + ' — ' + names));
      var s0 = rows[0] && rows[0]._sum && rows[0]._sum();
      if (s0) line.appendChild(el('span', 'dl-v', s0.val));
      sum.appendChild(line);
    }
  }
  // RULE 2 — one primary action per screen state, and rule 1 is what makes it unambiguous: exactly one
  // round is current, so "Log" has exactly one referent. The button names the numbers it is about to
  // record rather than saying "done", and stays disabled until every actual in the round is confirmed
  // (rule 2b) — the athlete cannot record a lift they did not do without passing through the number.
  function syncRound(rb) {
    if (!rb || !rb.classList || !rb.classList.contains('round')) return;
    var btn = rb.querySelector('.roundlog'); if (!btn) return;
    var rows = [].slice.call(rb.querySelectorAll('.ex-row')).filter(function (r) { return r._commit && !r._isDur; });
    var pending = rows.filter(function (r) { return !r.classList.contains('done'); });
    if (!pending.length) { btn.hidden = true; return; }   // nothing left to log; the round is collapsing
    btn.hidden = false;
    var unconfirmed = pending.filter(function (r) { return !r._confirmed; });
    if (unconfirmed.length) {
      btn.disabled = true;
      btn.textContent = 'Enter ' + unconfirmed[0]._needs + ' to log';
    } else {
      btn.disabled = false;
      btn.textContent = 'Log ' + (rb.getAttribute('data-title') || 'set') + ' · ' +
        pending.map(function (r) { return r._sum().val; }).join(' · ');
    }
  }

  function refocus() {
    var cards = [].slice.call(app.querySelectorAll('.slot'));
    var seenCurrent = false;
    cards.forEach(function (card) {
      var rounds = [].slice.call(card.querySelectorAll('.round'));
      var nowIdx = -1;
      rounds.forEach(function (rb, i) {
        var rows = [].slice.call(rb.querySelectorAll('.ex-row'));
        var done = rows.length > 0 && rows.every(function (r) { return r.classList.contains('done'); });
        rb.classList.toggle('is-done', done);
        if (!done && nowIdx < 0) nowIdx = i;
      });
      rounds.forEach(function (rb, i) {
        rb.classList.remove('is-now', 'is-next', 'is-later');
        if (i === nowIdx) rb.classList.add('is-now');
        else if (nowIdx >= 0 && i === nowIdx + 1) rb.classList.add('is-next');
        else if (nowIdx >= 0 && i > nowIdx + 1) rb.classList.add('is-later');
        roundSummary(rb); syncRound(rb);
      });
      var slotDone = rounds.length > 0 && nowIdx < 0;
      card.classList.remove('slot-done', 'slot-now', 'slot-later');
      if (slotDone) card.classList.add('slot-done');
      else if (!seenCurrent) { seenCurrent = true; card.classList.add('slot-now'); }
      else card.classList.add('slot-later');
      var st = card.querySelector('.slot-state');
      if (st) st.textContent = slotDone ? 'done' : (card.classList.contains('slot-later') ? 'not started' : '');
    });
  }

  function render(s) {
    SESSION = s;
    clearTimerBar();
    ROW_REG = {}; LEG_REG = {};   // fresh registries per session render
    renderNav('wo');
    // S19 AC2: the athlete sees what they're signing up for before they start.
    meta.textContent = (s.name || s.theme) + ' · ' + s.date + (s.est_min ? ' · ~' + s.est_min + ' min' : '');
    app.innerHTML = '';
    var back = el('button', 'back', '← Calendar'); back.type = 'button';
    back.addEventListener('click', function () { loadHome(); });
    app.appendChild(back);
    // Moving a workout lives on the CALENDAR (S16), not here. Phil: "We don't need to move to
    // another day on the workout that's shown. I would remove it." You decide what to shuffle while
    // looking at the week, not while standing in the gym with the session open.
    s.slots.forEach(function (slot) {
      var card = el('section', 'slot');
      var head = el('div', 'slot-head');
      var sLabel = slotLabel(slot.slot);
      head.appendChild(el('h2', 'slot-title', sLabel));   // "Warm Up 1" / "Complex 1"
      var timerNode = el('span', 'timer');
      // "Begin complex · 3:00" — a check means "I already did that set", so the timer can't
      // auto-start off one; it needs an explicit "I'm starting now". The label says what it does
      // and how long the complex runs, so it reads without a coach standing there.
      var ivs = (slot.round_intervals_s && slot.round_intervals_s.length) ? slot.round_intervals_s : [slot.interval_s || 300];
      var startBtn = el('button', 'tstart', 'Begin complex · ' + fmt(ivs[0])); startBtn.type = 'button';
      var pauseBtn = el('button', 'pause', '⏸'); pauseBtn.type = 'button'; pauseBtn.hidden = true;
      head.appendChild(startBtn); head.appendChild(timerNode); head.appendChild(pauseBtn);
      card.appendChild(head);
      var timer = makeTimer(timerNode, pauseBtn, ivs, sLabel);
      startBtn.addEventListener('click', function () { timer.start(); startBtn.hidden = true; });

      // Collapsed form of a complex you haven't reached (or have finished) — rule 1. Tap to open it
      // anyway, because a plan is not an order: you may want to jump ahead.
      var slotSum = el('div', 'slot-sum');
      slotSum.appendChild(el('span', 'ss-t', slot.exercises.map(function (e) { return exLabel(e); }).join(' + ')));
      slotSum.appendChild(el('span', 'slot-state', ''));
      slotSum.addEventListener('click', function () { card.classList.toggle('open'); });
      card.appendChild(slotSum);

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
        roundBox.setAttribute('data-title', title);   // the NOW tag and the collapsed lines both read this
        roundBox.appendChild(el('div', 'round-title', title));
        var count = 0;
        slot.exercises.forEach(function (ex) {
          if (r < ex.sets.length) { roundBox.appendChild(exerciseRow(slot, ex, ex.sets[r], timer, ex === aSide)); count++; }
        });
        if (count > 1) roundBox.classList.add('paired');
        // One Log button per round (rule 2). Rounds made entirely of timed holds don't get one — the
        // hold's own ▶ IS the action, and you can't log a 45s hold you haven't stood through.
        var loggable = [].slice.call(roundBox.querySelectorAll('.ex-row')).some(function (r) { return r._commit && !r._isDur; });
        if (loggable) {
          var act = el('button', 'roundlog'); act.type = 'button'; act.disabled = true;
          act.addEventListener('click', (function (rb) {
            return function () {
              if (act.disabled) return;
              [].slice.call(rb.querySelectorAll('.ex-row')).forEach(function (r) {
                if (r._commit && !r._isDur && !r.classList.contains('done')) r._commit();
              });
            };
          })(roundBox));
          roundBox.appendChild(act);
        }
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
    refocus();   // rule 1: set the opening focus before the athlete sees anything
  }

  function load() {
    if (!cfg.WEBAPP_URL || cfg.WEBAPP_URL.indexOf('REPLACE_') === 0) return show('App not configured yet (WEBAPP_URL).', 'err');
    if (!athlete || !token) return show('Missing athlete or token — open your personal link.', 'err');
    var open = null; try { open = sessionStorage.getItem('bp_open_session'); } catch (e) {}
    if (open) return openSession(open);   // restore the workout a reload interrupted
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
  // Calendar = a CURRENT-WEEK strip + a day list. Phil, after using the month grid: "the list is
  // probably better than the calendar above. I don't know why we have the calendar above." He was
  // right — 7 columns on a 390px phone gives each day ~40px, which is why workout names had to move
  // out of it in the first place. The strip keeps the week at a glance; the list does the work.
  //
  // The DATE is its own column, not part of the tile: "some days might be zero workouts and some
  // days might have 2". A tile-per-day can't express either.
  function renderCalendar(sessions) {
    try { sessionStorage.removeItem('bp_open_session'); } catch (e) {}   // back on the calendar: forget it
    SESSION = null; app.innerHTML = ''; renderNav('cal');
    meta.textContent = athlete + ' · pick a workout';
    var byDate = {}; sessions.forEach(function (s) { (byDate[s.date] = byDate[s.date] || []).push(s); });
    var today = todayISO();

    // --- current week strip (this week only) ---
    var strip = el('div', 'wk');
    var mon = mondayOf(today);
    for (var i = 0; i < 7; i++) {
      var d = new Date(mon); d.setDate(d.getDate() + i);
      var key = ymd(d);
      var c = el('div', 'wk-d');
      c.appendChild(el('div', 'wk-dow', ['M', 'T', 'W', 'T', 'F', 'S', 'S'][i]));
      var num = el('div', 'wk-n', String(d.getDate()));
      if (key === today) num.classList.add('is-today');
      if ((byDate[key] || []).length) num.classList.add('has-wo');
      c.appendChild(num);
      strip.appendChild(c);
    }
    app.appendChild(strip);

    // --- day list: every day from the first session to the last, workouts or not ---
    var ds = sessions.map(function (s) { return s.date; }).sort();
    var list = el('div', 'days');
    var cur = mondayOf(ds[0] || today), last = ds[ds.length - 1] || today, guard = 0;
    while (ymd(cur) <= last && guard++ < 70) {
      var k = ymd(cur);
      var row = el('div', 'day-row'); row.dataset.date = k; if (k === today) row.classList.add('today');   // dataset.date: drop target
      var g = el('div', 'day-g');
      g.appendChild(el('div', 'day-dow', dowName(cur)));
      g.appendChild(el('div', 'day-date', (cur.getMonth() + 1) + '/' + cur.getDate()));   // "7/14", not "14"
      row.appendChild(g);
      var slot = el('div', 'day-wos');
      (byDate[k] || []).forEach(function (s) {
        var wrap = el('div', 'wo-wrap');
        var line = el('div', 'wo-line');
        var b = el('button', 'wo st-' + s.status); b.type = 'button';
        b.appendChild(el('div', 'wo-name', s.name || s.theme || 'session'));
        var sub = (s.n_ex ? s.n_ex + ' exercise' + (s.n_ex === 1 ? '' : 's') : '');
        if (s.status === 'done') sub = '✓ done' + (sub ? ' · ' + sub : '');
        else if (s.status === 'missed') sub = 'missed' + (sub ? ' · ' + sub : '');
        else if (s.status === 'started') sub = 'started' + (sub ? ' · ' + sub : '');
        b.appendChild(el('div', 'wo-sub', sub));
        b.addEventListener('click', function () { openSession(s.session_id); });
        line.appendChild(b);
        if (s.status === 'planned' || s.status === 'missed') {   // S16: move, from the calendar
          var mv = el('button', 'ag-move', '⇄'); mv.type = 'button'; mv.title = 'Move to another day';
          mv.addEventListener('click', function (ev) { ev.stopPropagation(); toggleMove(wrap, s); });
          line.appendChild(mv);
          attachDrag(b, s);   // long-press to drag onto another day (the ⇄ button stays for tap users)
        }
        wrap.appendChild(line);       // the panel is appended to `wrap`, BELOW this line, full width
        slot.appendChild(wrap);
      });
      row.appendChild(slot);
      list.appendChild(row);
      cur.setDate(cur.getDate() + 1);
    }
    app.appendChild(list);
  }
  // Long-press to pick up a workout, drag over a day, release to move it there (S22). Phil asked if
  // moving days could be "hold it down, ideally, and move the date". Pointer Events cover touch AND
  // mouse in one path. The ⇄ button stays for anyone who'd rather tap. Only planned/missed tiles are
  // draggable — the server freezes anything with logged sets, and sendMove is a no-cors POST we can't
  // read, so an un-honourable drag would fail silently.
  function attachDrag(tile, s) {
    var HOLD = 350, MOVE_CANCEL = 10;   // ms to arm; px of finger travel that counts as a scroll, not a hold
    var timer = null, armed = false, ghost = null, startX = 0, startY = 0, lastRow = null;

    function cleanup() {
      if (timer) { clearTimeout(timer); timer = null; }
      if (ghost) { ghost.remove(); ghost = null; }
      document.querySelectorAll('.day-row.drop-hi').forEach(function (r) { r.classList.remove('drop-hi'); });
      document.body.classList.remove('dragging');
      tile.classList.remove('lifted');
      armed = false; lastRow = null;
    }
    function rowUnder(x, y) {
      if (ghost) ghost.style.display = 'none';
      var el0 = document.elementFromPoint(x, y);
      if (ghost) ghost.style.display = '';
      return el0 && el0.closest ? el0.closest('.day-row') : null;
    }

    tile.addEventListener('pointerdown', function (e) {
      if (e.button != null && e.button !== 0) return;
      startX = e.clientX; startY = e.clientY;
      timer = setTimeout(function () {
        armed = true;
        document.body.classList.add('dragging');
        tile.classList.add('lifted');
        ghost = el('div', 'wo-ghost', s.name || s.theme || 'workout');
        document.body.appendChild(ghost);
        moveGhost(startX, startY);
        if (navigator.vibrate) { try { navigator.vibrate(15); } catch (e2) {} }
        try { tile.setPointerCapture(e.pointerId); } catch (e2) {}
      }, HOLD);
    });
    function moveGhost(x, y) { if (ghost) { ghost.style.left = x + 'px'; ghost.style.top = y + 'px'; } }
    tile.addEventListener('pointermove', function (e) {
      if (!armed) {
        // moved too far before the hold armed -> it's a scroll, not a drag; abort the pickup
        if (timer && (Math.abs(e.clientX - startX) > MOVE_CANCEL || Math.abs(e.clientY - startY) > MOVE_CANCEL)) { clearTimeout(timer); timer = null; }
        return;
      }
      e.preventDefault();
      moveGhost(e.clientX, e.clientY);
      var r = rowUnder(e.clientX, e.clientY);
      if (r !== lastRow) {
        if (lastRow) lastRow.classList.remove('drop-hi');
        if (r && r.dataset.date !== s.date) r.classList.add('drop-hi');   // don't highlight its own day
        lastRow = r;
      }
    });
    tile.addEventListener('pointerup', function (e) {
      if (!armed) { if (timer) { clearTimeout(timer); timer = null; } return; }   // was a tap/hold that never armed -> let click fire
      var r = rowUnder(e.clientX, e.clientY);
      var to = r && r.dataset.date;
      cleanup();
      if (to && to !== s.date) {
        e.preventDefault();
        show('Moving “' + (s.name || s.theme || 'workout') + '” to ' + dowLabel(to) + '…');
        sendMove(s.session_id, to);
        setTimeout(loadHome, 1300);
      }
    });
    tile.addEventListener('pointercancel', cleanup);
    // a drag must not also fire the tile's openSession click
    tile.addEventListener('click', function (e) { if (armed) { e.preventDefault(); e.stopPropagation(); } }, true);
  }
  function dowName(d) { return ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'][d.getDay()]; }
  function dowLabel(iso) { var p = String(iso).split('-'); var d = new Date(+p[0], +p[1] - 1, +p[2]); return dowName(d) + ' ' + (d.getMonth() + 1) + '/' + d.getDate(); }
  function addDays(iso, n) {
    var p = String(iso).split('-');
    var d = new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
    d.setDate(d.getDate() + n);
    return ymd(d);
  }

  // Move panel, opened from a day row. A MISSED workout moves FORWARD from today ("if u miss one,
  // you can move it forward") — "tomorrow" relative to its own past date is still in the past. One
  // still ahead of you is pushed back from where it sits.
  function toggleMove(wrap, s) {
    var open = wrap.querySelector('.move-panel');
    if (open) { open.remove(); return; }
    var p = el('div', 'move-panel');
    p.appendChild(el('div', 'move-h', 'Move \u201c' + (s.name || s.theme || 'workout') + '\u201d to'));
    function go(iso) {
      p.innerHTML = ''; p.appendChild(el('div', 'move-h', 'Moving to ' + dowLabel(iso) + '\u2026'));
      sendMove(s.session_id, iso);
      setTimeout(loadHome, 1300);
    }
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
    var rowEl = el('div', 'move-any');
    var dIn = el('input', 'move-date'); dIn.type = 'date';
    dIn.value = past ? today2 : s.date;
    dIn.min = today2;
    var gBtn = el('button', 'move-go', 'Move'); gBtn.type = 'button';
    gBtn.addEventListener('click', function () { if (dIn.value) go(dIn.value); });
    rowEl.appendChild(dIn); rowEl.appendChild(gBtn); p.appendChild(rowEl);
    wrap.appendChild(p);
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
        renderProfile(data.exercises || [], data.summary || '');
      }).catch(function () { show('Offline — reconnect to see your progress.', 'err'); });
  }
  // S21 profile (Phil): the two things that matter per exercise are "is my best one-set up or down"
  // and "is my volume up or down" — 7-day and 30-day. Those are the HEADLINE. Where you sit on the
  // level ladder is a demoted, non-bold third line. No 1RM on a bodyweight lift; no reps stat on a
  // weighted one.
  function trendChip(tr) {
    // tr: { dir:'up'|'down'|'flat', pct, from, to } or null (not enough history)
    if (!tr) { return el('span', 'p-tr none', '— not yet'); }
    var arrow = tr.dir === 'up' ? '▲' : tr.dir === 'down' ? '▼' : '▬';
    var txt = arrow + (tr.pct != null ? ' ' + (tr.pct > 0 ? '+' : '') + tr.pct + '%' : '');
    return el('span', 'p-tr ' + tr.dir, txt);
  }
  function statBlock(label, value, t7, t30) {
    var b = el('div', 'p-stat');
    b.appendChild(el('div', 'p-sl', label));
    b.appendChild(el('div', 'p-sv', value));
    var tr = el('div', 'p-trends');
    var w7 = el('div', 'p-trow'); w7.appendChild(el('span', 'p-tw', '7-day')); w7.appendChild(trendChip(t7)); tr.appendChild(w7);
    var w30 = el('div', 'p-trow'); w30.appendChild(el('span', 'p-tw', '30-day')); w30.appendChild(trendChip(t30)); tr.appendChild(w30);
    b.appendChild(tr);
    return b;
  }
  function renderProfile(list, summary) {
    SESSION = null; app.innerHTML = '';
    meta.textContent = athlete + ' · your progress';
    if (!list.length) { app.appendChild(el('p', 'empty', 'No exercises yet.')); return; }

    // Summary: a short coaching read on where the athlete is trending, from the server (deterministic
    // from the same trend data the cards show, so it can't contradict them).
    if (summary) {
      var ai = el('div', 'p-ai');
      ai.appendChild(el('div', 'p-ai-h', 'Summary'));
      ai.appendChild(el('div', 'p-ai-b', summary));
      app.appendChild(ai);
    }

    list.forEach(function (x) {
      var card = el('section', 'pcard');
      card.appendChild(el('div', 'p-name', x.name));
      if (x.variant && x.variant !== x.name) card.appendChild(el('div', 'p-var', 'currently: ' + x.variant));

      if (!x.has_data) {
        card.appendChild(el('div', 'p-empty', 'No sets logged yet — log one and your bests show up here.'));
      } else {
        var tr = x.trend || {};
        if (x.best_one != null) card.appendChild(statBlock('Best one set', x.best_one + ' ' + (x.best_one_unit || ''), tr.one_7, tr.one_30));
        if (x.best_volume != null) card.appendChild(statBlock('Best volume', x.best_volume + (x.volume_unit === 'reps' ? ' reps' : ' lb·reps'), tr.vol_7, tr.vol_30));
      }

      // Level: demoted, non-bold, third. Where you are on the climb and how far to go.
      if (x.level && !x.maxed && x.to_go != null) {
        var toGoTxt = x.goal.load != null ? (x.to_go + ' lb to next level') : (x.to_go + (x.to_go === 1 ? ' rep to next level' : ' reps to next level'));
        var lv = el('div', 'p-level');
        lv.appendChild(el('span', 'p-level-l', 'Level ' + x.level));
        lv.appendChild(el('span', 'p-level-g', x.to_go === 0 ? 'ready to level up' : toGoTxt));
        card.appendChild(lv);
        var bar = el('div', 'p-bar'); var fill = el('div', 'p-fill');
        fill.style.width = Math.round((x.progress || 0) * 100) + '%'; bar.appendChild(fill); card.appendChild(bar);
      } else if (x.maxed) {
        card.appendChild(el('div', 'p-level', 'Top of the ladder 🏆'));
      }
      app.appendChild(card);
    });
  }

  function openSession(sessionId) {
    try { sessionStorage.setItem('bp_open_session', sessionId); } catch (e) {}
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
