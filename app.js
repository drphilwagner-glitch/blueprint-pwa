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
  // CLIENT CACHE VERSION. Every cached payload is keyed by it, so a build that changes payload shape
  // ignores what the device already has instead of painting it. Without this, a server-side fix
  // reached nobody: the phone instant-paints the OLD session from localStorage and Phil sees the bug
  // he already reported, days after it was fixed. Bump this whenever the payload shape changes —
  // same discipline as sw.js's CACHE and the server's _PAYLOAD_SCHEMA_V.
  var CACHE_V = 'c6';   // day-grid build   // bumped: cache-version handshake build; old cached weeks predate pwa_ver
  // CACHE-VERSION HANDSHAKE (Phil P0 2026-08-12, the FOURTH stale-phone bite — permanent fix).
  // APP_BUILD is this bundle's stamp; the week payload carries the server's expected build
  // (pwa_ver). Mismatch => force the service worker to update and reload ONCE per version.
  // The payload fetch fires at every open — the one channel that reaches a warm-recalled
  // standalone PWA, which never cold-relaunches and so never re-checks sw.js on its own.
  var APP_BUILD = '20260814-profile2-1';
  function versionHandshake(pwaVer) {
    try {
      if (!pwaVer || String(pwaVer) === APP_BUILD) return;
      // L132 NO RELOAD MID-WORKOUT (Phil 2026-08-13, born with the F1 fix). The one-shot reload
      // tearing down a LIVE workout is how Grace's 8/12 ECC lost 28 sets: everything confirmed but
      // not yet queued died with the page, and the null-SESSION guard discarded the rest in silence.
      // A reload defers while any session is active and fires at the next calendar open instead.
      var inWorkout = false;
      try { inWorkout = !!(SESSION || sessionStorage.getItem('bp_open_session')); } catch (eW) {}
      if (inWorkout) { try { sessionStorage.setItem('bp_pending_reload', String(pwaVer)); } catch (eP) {} return; }
      if (navigator.serviceWorker && navigator.serviceWorker.getRegistration) {
        navigator.serviceWorker.getRegistration().then(function (r) { if (r) r.update(); }).catch(function () {});
      }
      var mark = 'bp_reloaded_' + pwaVer;
      if (sessionStorage.getItem(mark)) return;      // one reload per version: no loops, ever
      sessionStorage.setItem(mark, '1');
      setTimeout(function () { location.reload(); }, 400);   // let the SW update kick off first
    } catch (e) {}
  }
  try { window.BP_handshake = versionHandshake; } catch (e) {}   // j25 drives the defer law (BP_qCount precedent)
  try { window.BP_killSession = function () { SESSION = null; }; } catch (e) {}   // j25 simulates the torn-down-SESSION path (L131 red-proof)
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
  //
  // COMPLETES RIDE AN ACK'D QUEUE (F1 root A, Phil 2026-08-13). The old form was ONE opaque no-cors
  // POST with an empty catch — no queue, no ack, no retry. Phil finished his 8/10 Full Body and that
  // single fragile write died silently: no done, round never closed, no next-round mint. Logs have
  // survived every network hiccup since the IndexedDB queue landed; completes now get the same
  // discipline — a GET the client can READ (the move lesson: an opaque write is indistinguishable
  // from a broken app), retried from a pending list until the server actually says ok.
  function sendComplete(sessionId) {
    try {
      var pend = JSON.parse(localStorage.getItem('bp_pending_completes') || '[]');
      if (pend.indexOf(sessionId) < 0) { pend.push(sessionId); localStorage.setItem('bp_pending_completes', JSON.stringify(pend)); }
    } catch (e) {}
    return drainCompletes();
  }
  var drainingC = false;
  function drainCompletes() {
    if (drainingC || !navigator.onLine) return Promise.resolve();
    var pend = [];
    try { pend = JSON.parse(localStorage.getItem('bp_pending_completes') || '[]'); } catch (e) {}
    if (!pend.length) return Promise.resolve();
    drainingC = true;
    var sid = pend[0];
    var url = cfg.WEBAPP_URL + '?action=complete&athlete=' + encodeURIComponent(athlete) +
      '&token=' + encodeURIComponent(token) + '&session_id=' + encodeURIComponent(sid);
    return fetchJson(url).then(function (d) {
      drainingC = false;
      if (d && d.ok) {
        try {
          var p2 = JSON.parse(localStorage.getItem('bp_pending_completes') || '[]');
          localStorage.setItem('bp_pending_completes', JSON.stringify(p2.filter(function (x) { return x !== sid; })));
        } catch (e) {}
        return drainCompletes();               // clear any others waiting
      }
      // Not ok: stays pending; the drain ticks below retry it. The athlete is told ONCE per attempt
      // wave, not spammed — the badge machinery already shows pending state for logs.
      return null;
    }).catch(function () { drainingC = false; });
  }
  window.addEventListener('online', drainCompletes);
  setInterval(function () { if (navigator.onLine) drainCompletes(); }, 20000);
  // Move an unlogged session to another day (reschedule). GET, not the no-cors POST the rest of the
  // writes use: a no-cors response is opaque, so the old version could not tell success from failure
  // and just reloaded on a timer. A move that silently does nothing is indistinguishable from a
  // broken app — resolves to the server's actual answer so the caller can report it.
  function sendMove(sessionId, toDate) {
    var url = cfg.WEBAPP_URL + '?action=move&athlete=' + encodeURIComponent(athlete) +
      '&token=' + encodeURIComponent(token) + '&session_id=' + encodeURIComponent(sessionId) +
      '&to_date=' + encodeURIComponent(toDate);
    return fetch(url).then(function (r) { return r.json(); })
      .catch(function () { return { ok: false, error: 'offline' }; });
  }
  var MOVE_ERR = {
    logged_cannot_move: 'That workout already has logged sets, so it stays put.',
    not_found: 'Could not find that workout to move.',
    forbidden: 'Access denied — check your link.',
    offline: 'No connection — reconnect and try again.',
    bad_args: 'Something was missing. Try again.'
  };
  // JSON fetch with RETRY + an honest failure class. A throttled Apps Script answers with an HTML
  // error page; r.json() threw and every caller's catch said "Offline" — Phil and Grace force-closed
  // the app for what was a server hiccup (2026-08-05). Retries ride out the hiccup; 'server' vs
  // 'offline' is decided by whether the network answered at all.
  function fetchJson(url, tries) {
    tries = (tries == null) ? 2 : tries;
    return fetch(url).then(function (r) {
      return r.text().then(function (txt) {
        try { return JSON.parse(txt); } catch (e) { var er = new Error('server'); er._server = true; throw er; }
      });
    }).catch(function (err) {
      if (tries > 0) return new Promise(function (res) { setTimeout(res, 1200); }).then(function () { return fetchJson(url, tries - 1); });
      return { ok: false, error: (err && err._server) ? 'server' : 'offline' };
    });
  }
  var SERVER_HICCUP = 'The server hiccuped — it usually clears in a moment. Tap again.';
  // ---- S18 NERVES: the device reports its own failures ----
  // Phil: "Phil should never be the sensor for something a tool could sense." Three cycles were spent
  // on "Back squat still crashed" that I could not reproduce on any engine — because the only
  // instrument was him describing it. window.onerror, unhandled rejections and failed syncs now post
  // themselves to an ErrorLog tab with enough context to place the fault: which build, which device,
  // which screen. Best-effort and silent — a reporter that can break the app is worse than no
  // reporter, so every path is wrapped and failures are swallowed.
  // Every real crash report so far arrived as build "sw-unknown", because the version was fetched
  // asynchronously and the app died before it resolved — so I could not tell WHICH BUILD crashed,
  // which is the first thing you need after an upload. Cache it on disk: the value is read
  // synchronously on the next launch, and refreshed in the background for the launch after that.
  var APP_VERSION = 'sw-unknown';
  try { APP_VERSION = localStorage.getItem('bp_ver') || 'sw-unknown'; } catch (e) {}
  try { fetch('./sw.js', { cache: 'no-store' }).then(function (r) { return r.text(); })
    .then(function (t) {
      var m = t.match(/bp-shell-v\d+/);
      if (m) { APP_VERSION = m[0]; try { localStorage.setItem('bp_ver', m[0]); } catch (e) {} }
    }).catch(function () {}); } catch (e) {}
  var _errSent = {};
  function reportError(kind, message, source, extra) {
    try {
      var key = kind + '|' + String(message).slice(0, 120);
      if (_errSent[key]) return; _errSent[key] = 1;       // one report per distinct fault per session
      if (!cfg.WEBAPP_URL || cfg.WEBAPP_URL.indexOf('REPLACE_') === 0) return;
      var body = {
        action: 'clienterror', athlete: athlete || '(none)', kind: kind,
        message: String(message || '').slice(0, 900), source: String(source || '').slice(0, 300),
        device: navigator.userAgent, app_version: APP_VERSION,
        screen: (window.innerWidth + 'x' + window.innerHeight +
                 (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches ? ' standalone' : ' browser')),
        url: location.href.replace(/token=[^&]*/, 'token=***'),   // never log a token
        // ALWAYS attach what was on screen. Phil's real crash reported `"Script error."` with no
        // message, no file and no line — the browser withholds detail for cross-origin scripts. That
        // is useless on its own, but "Script error. WHILE: opening a video, host=player.vimeo.com" is
        // actionable. The breadcrumb we already keep for crash detection is exactly that context.
        extra: (function () {
          var ctx = '';
          try {
            var c = localStorage.getItem('bp_crumb');
            if (c) { var o = JSON.parse(c); ctx = ' WHILE: ' + (o.state || '') + ' ' + (o.extra || ''); }
          } catch (e) {}
          return (String(extra || '') + ctx).slice(0, 900);
        })()
      };
      fetch(cfg.WEBAPP_URL, { method: 'POST', mode: 'no-cors',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(body) }).catch(function () {});
    } catch (e) {}
  }
  window.addEventListener('error', function (e) {
    reportError('onerror', e && e.message, (e && e.filename ? e.filename + ':' + e.lineno + ':' + e.colno : ''),
      e && e.error && e.error.stack);
  });
  window.addEventListener('unhandledrejection', function (e) {
    var r = e && e.reason;
    reportError('unhandledrejection', (r && (r.message || r)) || 'unknown', '', r && r.stack);
  });
  // ---- CRASH BREADCRUMB ----
  // An iOS memory kill takes the tab INSTANTLY: no error fires, no report can be sent, and the
  // reload-detector only helps if Safari auto-reloads rather than Phil reopening by hand. So the app
  // leaves a note on disk BEFORE doing anything risky and clears it on a clean exit. A note still
  // there at next launch means the previous run died — and it names what was on screen when it did.
  // Phil: videos "work 90% of the time... Figure out why some work and some don't." This is how we
  // learn WHICH clip was open at the moment it died, which no test on this Mac can tell us.
  var CRUMB = 'bp_crumb';
  function crumb(state, extra) {
    try { localStorage.setItem(CRUMB, JSON.stringify({ t: Date.now(), state: state, extra: extra || '' })); } catch (e) {}
  }
  function crumbClear() { try { localStorage.removeItem(CRUMB); } catch (e) {} }
  // A crumb is only evidence of a CRASH if the athlete came back to a dead tab quickly. iOS reclaims a
  // backgrounded tab hours later without firing pagehide, which leaves exactly the same crumb — and the
  // morning report then announced "previous run ended without a clean exit while: opening a video,
  // secondsAgo=7906". That is a phone doing normal phone things, reported as a crash two hours after a
  // video that played fine. Rule 14: Phil should never be the sensor, but a sensor that cries wolf is
  // worse than none, because the one real crash arrives in a column he has learned to skip.
  var CRUMB_FRESH_S = 180;
  function crumbActionable(agoS) { return agoS != null && agoS >= 0 && agoS <= CRUMB_FRESH_S; }
  var lastCrumb = null;   // what the app was doing before this load — the reload report needs it too
  try {
    var prev = localStorage.getItem(CRUMB);
    if (prev) {
      var p0 = {}; try { p0 = JSON.parse(prev); } catch (e) {}
      lastCrumb = p0;
      var agoS = p0.t ? Math.round((Date.now() - p0.t) / 1000) : null;
      if (crumbActionable(agoS)) {
        reportError('unclean_exit', 'previous run ended without a clean exit while: ' + (p0.state || 'unknown'),
          '', 'context=' + (p0.extra || '') + ' secondsAgo=' + agoS);
      }
      crumbClear();
    }
  } catch (e) {}
  try { window.BP_crumbActionable = crumbActionable; } catch (e) {}   // j5 asserts the age rule directly
  // A clean close, a backgrounded tab, or a normal navigation are all fine — clear the note.
  window.addEventListener('pagehide', crumbClear);
  window.addEventListener('beforeunload', crumbClear);
  var nav0 = null;
  try {
    nav0 = performance.getEntriesByType && performance.getEntriesByType('navigation')[0];
    // Include WHAT THE APP WAS DOING (the crash breadcrumb) — Phil's 07-29 pair of reloads arrived
    // with no context ('type=reload' and nothing else), so a memory kill was a shrug instead of a
    // diagnosis. With the crumb, the report reads 'while: opening a video', which is a lead.
    if (nav0 && nav0.type === 'reload') {
      var rCtx = lastCrumb ? (' while=' + (lastCrumb.state || 'unknown') + (lastCrumb.extra ? ' ' + lastCrumb.extra : '')) : '';
      reportError('reload', 'app reloaded (possible iOS memory kill)', '', 'type=' + nav0.type + rCtx);
    }
  } catch (e) {}

  // iOS evicts IndexedDB for sites it considers idle (roughly 7 days without a visit), and this
  // database holds SETS THE ATHLETE HAS LOGGED BUT NOT YET SYNCED. A kid who trains Friday with no
  // signal and reopens the app the following week could lose that session. Asking for persistent
  // storage is the documented mitigation; iOS grants it for home-screen installs. Best-effort — if
  // it is refused we are no worse off, and the queue still drains on every launch.
  try {
    if (navigator.storage && navigator.storage.persist) {
      navigator.storage.persisted().then(function (already) {
        if (!already) return navigator.storage.persist();
      }).catch(function () {});
    }
  } catch (e) {}
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
  try { window.BP_qCount = function () { return qAll().then(function (r) { return r.length; }); }; } catch (e) {}   // j20 asserts a tap really queued
  function qDel(ids) { return qStore('readwrite').then(function (s) { ids.forEach(function (id) { s['delete'](id); }); return new Promise(function (res) { s.transaction.oncomplete = res; }); }); }
  function updateBadge() {
    return qAll().then(function (rows) {
      if (rows.length) { syncEl.hidden = false; syncEl.className = 'sync pending'; syncEl.textContent = rows.length + ' pending'; }
      else { syncEl.className = 'sync synced'; syncEl.textContent = 'synced'; setTimeout(function () { if (syncEl.textContent === 'synced') syncEl.hidden = true; }, 1500); }
    }).catch(function () {});
  }
  // Confirm which log_ids the Workbook actually has. The POST goes out `mode:'no-cors'`, so its
  // promise resolves whether or not a row was written — the old drain then deleted the queue entry
  // regardless, which silently lost sets (the durability journey logged 2 and the Workbook gained 1).
  // A set is only forgotten once the server says it has it.
  function ackLogs(ids) {
    var url = cfg.WEBAPP_URL + '?action=logack&athlete=' + encodeURIComponent(athlete) +
      '&token=' + encodeURIComponent(token) + '&ids=' + encodeURIComponent(ids.join(','));
    return fetch(url).then(function (r) { return r.json(); })
      .then(function (d) { return (d && d.ok && d.present) ? d.present : []; })
      .catch(function () { return []; });
  }
  var draining = false;
  function drain() {
    if (draining || !navigator.onLine) return Promise.resolve();
    draining = true;
    var done = function () { draining = false; };
    return qAll().then(function (rows) {
      if (!rows.length) { done(); return; }
      var ids = rows.map(function (x) { return x.log_id; });
      return sendLog(rows).then(function () {
        // Apps Script may still be writing when the opaque POST resolves, so poll the read-back a
        // few times before giving up. Anything unconfirmed STAYS QUEUED and is retried — at worst a
        // set is sent twice, which hard rule 4 makes safe (idempotent via client log_id); losing one
        // is not recoverable.
        var tries = 0;
        function confirm() {
          tries += 1;
          return ackLogs(ids).then(function (present) {
            if (present.length) {
              return qDel(present).then(function () {
                if (present.length === ids.length || tries >= 4) { done(); return updateBadge(); }
                return new Promise(function (r) { setTimeout(r, 2000); }).then(confirm);
              });
            }
            if (tries >= 4) {
              reportError('sync_unconfirmed', 'logs sent but not confirmed by the server', '',
                'ids=' + ids.length + ' queued=' + ids.join(','));
              done(); return updateBadge();                                   // keep them queued; retry next drain
            }
            return new Promise(function (r) { setTimeout(r, 2000); }).then(confirm);
          });
        }
        return confirm();
      }).catch(function () { done(); });
    }).catch(function () { done(); });
  }
  // mkLog returns null once the athlete has left the workout; a null must never reach the queue.
  function logRows(rows) { rows = (rows || []).filter(Boolean); if (!rows.length) return; Promise.all(rows.map(qAdd)).then(updateBadge).then(drain); }
  window.addEventListener('online', drain);
  document.addEventListener('visibilitychange', function () { if (!document.hidden) drain(); });
  setInterval(function () { if (navigator.onLine) drain(); }, 15000);

  // ---- one ROLLING timer per complex: starts on the first A-side set, auto-restarts each round
  //      (rolls through all sets in succession), until the athlete pauses. ----
  function fmt(s) { return Math.floor(s / 60) + ':' + ('0' + (s % 60)).slice(-2); }
    // --- rest-timer alert: a chime + vibrate + a half-screen banner when the interval rolls over ---
    //
    // THE CUE IS A MEDIA ELEMENT FIRST, WEBAUDIO ONLY AS A FALLBACK (Phil, raised repeatedly; Mason
    // runs Apple's stopwatch beside the app, which is the product failing). A bare WebAudio oscillator
    // is silenced by the iOS ringer switch — a gym phone lives on silent, so the athlete heard
    // NOTHING and the app's timer became decorative. Two things fix that, both needed:
    //   1. `navigator.audioSession.type = 'playback'` (Safari 16.4+) — declares this page's audio as
    //      playback rather than ambient, so it sounds with the ringer off.
    //   2. an <audio> element carrying a real clip — media playback, not synthesis, is what the audio
    //      session category applies to.
    // The clip is generated here as a WAV rather than shipped as a file: no second upload to forget
    // (rule 11), and nothing to 404 on a phone that cached an older build.
    var _ac = null, _cueEl = null, _cueUrl = null, _cuePrimed = false;
    function _cueWavUrl() {
      // three rising notes, ~0.48s total — under the 700ms repeat below, so pulses never overlap
      var sr = 22050, notes = [[880, 0.13], [1174.7, 0.13], [1568, 0.22]], total = 0, i;
      for (i = 0; i < notes.length; i++) total += Math.round(notes[i][1] * sr);
      var buf = new ArrayBuffer(44 + total * 2), v = new DataView(buf), o = 0;
      function s(str) { for (var k = 0; k < str.length; k++) v.setUint8(o++, str.charCodeAt(k)); }
      function u32(n) { v.setUint32(o, n, true); o += 4; }
      function u16(n) { v.setUint16(o, n, true); o += 2; }
      s('RIFF'); u32(36 + total * 2); s('WAVE'); s('fmt '); u32(16); u16(1); u16(1);
      u32(sr); u32(sr * 2); u16(2); u16(16); s('data'); u32(total * 2);
      var t = 0;
      for (i = 0; i < notes.length; i++) {
        var f = notes[i][0], n = Math.round(notes[i][1] * sr);
        for (var j = 0; j < n; j++) {
          var env = Math.min(1, j / 200) * Math.pow(1 - j / n, 1.6);   // fast attack, decaying tail
          var samp = Math.sin(2 * Math.PI * f * (j / sr)) * env * 0.9;
          v.setInt16(44 + (t++) * 2, Math.max(-1, Math.min(1, samp)) * 32767, true);
        }
      }
      return URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
    }
    // Called from the taps that begin work — opening the session, starting a timer, starting a hold.
    // iOS only unlocks audio inside a gesture, and the interval that needs the cue expires minutes
    // later with no gesture anywhere near it.
    function primeAudio() {
      try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch (e) {}
      try { _ac = _ac || new (window.AudioContext || window.webkitAudioContext)(); if (_ac.state === 'suspended') _ac.resume(); } catch (e) {}
      try {
        if (!_cueEl) {
          _cueEl = document.createElement('audio');
          _cueEl.preload = 'auto';
          _cueEl.setAttribute('playsinline', '');
          _cueEl.src = _cueUrl || (_cueUrl = _cueWavUrl());
          _cueEl.load();
        }
        if (!_cuePrimed) {                     // unlock it under the gesture: play muted, then rewind
          _cueEl.muted = true;
          var pr = _cueEl.play();
          var settle = function () { try { _cueEl.pause(); _cueEl.currentTime = 0; } catch (e2) {} _cueEl.muted = false; _cuePrimed = true; };
          if (pr && pr.then) pr.then(settle, function () { _cueEl.muted = false; });
          else settle();
        }
      } catch (e) {}
    }
    function beep() {
      var fired = false;
      try {
        if (!_cueEl) primeAudio();
        if (_cueEl) {
          try { _cueEl.currentTime = 0; } catch (eT) {}
          _cueEl.muted = false;
          var pr = _cueEl.play();
          fired = true;
          if (pr && pr.catch) pr.catch(function () { _waBeep(); });   // blocked -> synth, never silence
        }
      } catch (e) {}
      if (!fired) _waBeep();
      if (navigator.vibrate) { try { navigator.vibrate([200, 80, 200]); } catch (e) {} }
    }
    function _waBeep() {
      try {
        if (!_ac) primeAudio();
        if (!_ac) return;
        if (_ac.state === 'suspended') { try { _ac.resume().then(function () { _tone(); }); } catch (eR) { _tone(); } }
        else _tone();
      } catch (e) {}
    }
    function _tone() {
      try {
        var o = _ac.createOscillator(), g = _ac.createGain();
        o.type = 'sine'; o.frequency.value = 880; o.connect(g); g.connect(_ac.destination);
        g.gain.setValueAtTime(0.0001, _ac.currentTime);
        g.gain.exponentialRampToValueAtTime(0.35, _ac.currentTime + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, _ac.currentTime + 0.45);
        o.start(); o.stop(_ac.currentTime + 0.45);
      } catch (e) {}
    }
    // Phase banner. `sticky` = stays until the athlete taps it (the cue of last resort: the chime
    // above now survives the iOS ringer switch, but nothing survives a phone in a pocket). A
    // banner that vanishes in 1.7s is missed if you glanced away; a persistent one can't be. Auto
    // (non-sticky) is kept for fast conditioning WORK<->REST flips where a tap-to-clear would nag.
    var _talert = null;
    // MINI TOAST — for cues the athlete is already looking at (the button re-armed, the field
    // flashed). Phil 2026-08-05 on the banner version: "giant blocks that take up the whole
    // screen... way too big." A pill near the top, gone in ~2s; the chime/vibrate still fires.
    var _mini = null;
    function miniToast(text) {
      try {
        if (_mini) _mini.remove();
        _mini = el('div', 'mini-toast', text);
        document.body.appendChild(_mini);
        setTimeout(function () { if (_mini) { _mini.remove(); _mini = null; } }, 2000);
      } catch (e) {}
    }
    // Phil 2026-07-18, on a real phone: "I can't get rid of it. When I click on Go, tap to dismiss, or
    // go to the next step, or anywhere, it just stays frozen. Unless that goes, the app won't go away."
    //
    // The cause: `.talert` carried `pointer-events: none` so the whole overlay ignored taps — the
    // sticky variant's own click handler could never fire, and sticky means no timeout, so it sat
    // there permanently over the workout. Now the cue is a real BUTTON that takes the tap, plus a
    // hard auto-dismiss so this can never wedge the app again whatever else breaks.
    // Phil: "Next set and go: all you need is a button. I don't know why we have tap to dismiss."
    function timerAlert(big, sub, cls, sticky) {
      if (_talert) { _talert.remove(); _talert = null; }
      var ov = el('div', 'talert' + (cls ? ' ' + cls : '') + (sticky ? ' sticky' : ''));
      var btn = sticky ? el('button', 'talert-big') : el('div', 'talert-big');
      if (sticky) btn.type = 'button';
      btn.textContent = big || 'Rest done';
      ov.appendChild(btn);
      if (!sticky) ov.appendChild(el('div', 'talert-sub', sub || 'next set — go'));
      document.body.appendChild(ov);
      requestAnimationFrame(function () { ov.classList.add('show'); });
      var gone = false;
      function clear() {
        if (gone) return; gone = true;
        ov.classList.remove('show');
        setTimeout(function () { if (ov.parentNode) ov.remove(); }, 300);
        if (_talert === ov) _talert = null;
      }
      if (sticky) {
        _talert = ov;
        btn.addEventListener('click', clear);
        ov.addEventListener('click', clear);          // tapping anywhere on the cue also clears it
        setTimeout(clear, 12000);                     // BACKSTOP: a cue must never outlive the set
        var pulses = 0, pv = setInterval(function () { if (++pulses >= 3 || !ov.parentNode) { clearInterval(pv); return; } beep(); }, 700);
      } else {
        setTimeout(clear, 1700);
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
      TBAR._p = el('button', 'tb-p', '⏸'); TBAR._p.type = 'button'; TBAR._p.title = 'Pause';
      TBAR._s = el('button', 'tb-s', '⏭'); TBAR._s.type = 'button'; TBAR._s.title = 'Skip to the next set';
      TBAR.appendChild(TBAR._l); TBAR.appendChild(TBAR._v); TBAR.appendChild(TBAR._p); TBAR.appendChild(TBAR._s);
      TBAR._p.addEventListener('click', function () { if (ACTIVE_TIMER) ACTIVE_TIMER.toggle(); });
      TBAR._s.addEventListener('click', function () { if (ACTIVE_TIMER) ACTIVE_TIMER.skip(); });
      document.body.appendChild(TBAR);
    }
    return TBAR;
  }
  var TIMER_SID = null;        // which session the running timer belongs to
  // A re-render must not kill a RUNNING rest timer. render() runs again on every post-log refresh, so
  // the old unconditional stop meant: start a 3:00 rest, log the round, and the refresh silently
  // stopped the countdown and hid the bar mid-count — the athlete stands there waiting on a timer that
  // died 2 seconds in. Rule 5 says the timer stays in view; it also has to stay ALIVE. Switching to a
  // different session still clears it, because that rest belongs to the workout you left.
  function clearTimerBar(sid) {
    if (ACTIVE_TIMER && ACTIVE_TIMER.running() && sid && sid === TIMER_SID) return;
    if (ACTIVE_TIMER) ACTIVE_TIMER.stop();
    ACTIVE_TIMER = null; TIMER_SID = null;
    if (TBAR) TBAR.hidden = true;
    document.body.classList.remove('has-tbar');
  }

  function makeTimer(node, pauseBtn, intervals, label, roundsOf) {
    var seq = (intervals && intervals.length) ? intervals.slice() : [120];
    var idx = 0;
    // Which round's rest is currently running — idx walks the interval sequence, and the round titles
    // are in the same order, so the label follows the countdown without extra bookkeeping.
    var roundLabel = (roundsOf && roundsOf[0]) || '';
    var interval = seq[0];
    var st = { running: false, paused: false, end: 0, rem: interval, t: null };
    var api;
    function pub(txt) {            // mirror this timer into the pinned bar (rule 5)
      if (ACTIVE_TIMER !== api) return;
      var b = tbar(); b.hidden = false;
      // Phil: "The timer shows complex one. It should show complex one in the set it's on, also in
      // that bottom footer." The countdown is between-set rest, so the set is the half that tells you
      // where you are; the complex alone does not.
      b._l.textContent = (label || 'Complex') + (roundLabel ? ' · ' + roundLabel : '');
      b._v.textContent = txt;
      b._p.hidden = !st.running;
      b._p.textContent = st.paused ? '▶' : '⏸';
      document.body.classList.add('has-tbar');
    }
    // A finished complex holds its last cue then gives the space back — but that "give it back" is a
    // DELAYED unpub, and a timer restarted inside that window used to be killed by the stale one:
    // the bar went hidden while a countdown was still running, breaking rule 5 (the timer stays in
    // view). Found by j1, not by Phil. The pending unpub is now cancellable, and unpub refuses to
    // hide a bar whose timer is live.
    var unpubT = null;
    function cancelUnpub() { if (unpubT) { clearTimeout(unpubT); unpubT = null; } }
    function laterUnpub(ms) { cancelUnpub(); unpubT = setTimeout(function () { unpubT = null; unpub(); }, ms); }
    function unpub() {
      if (ACTIVE_TIMER !== api) return;
      if (st.running) return;              // never blank the bar out from under a live countdown
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
          pub('complex done'); laterUnpub(8000);          // hold the last cue, then give the space back
          beep(); timerAlert('Complex done', 'move on', '', true);   // sticky — the last cue must not be missed
          return;
        }
        idx += 1;
        interval = seq[idx];
        roundLabel = (roundsOf && roundsOf[idx]) || roundLabel;
        st.end = Date.now() + interval * 1000; left = interval; node.classList.add('flash'); setTimeout(function () { node.classList.remove('flash'); }, 900); beep(); timerAlert('Next set', 'go', '', true); }
      node.textContent = 'next ' + fmt(left);
      pub('next ' + fmt(left));
      st.t = setTimeout(tick, 250);
    }
    // Phil: "If I start the complex, set one, and I finish it early and I want to start the time for
    // set two, is there a fast-forward button to go to the next complex?" There wasn't. A rolling
    // timer that can only be waited out is wrong for an athlete who finished early — and it is also
    // how he was trying to check that the interval drops when a paired lift runs out of sets.
    function skip() {
      if (!st.running) return;
      if (idx >= seq.length - 1) {                 // last round: end the complex rather than roll on
        clearTimeout(st.t); st.running = false; st.t = null;
        node.textContent = 'complex done'; pauseBtn.hidden = true;
        pub('complex done'); laterUnpub(4000);
        return;
      }
      idx += 1;
      interval = seq[idx];
      roundLabel = (roundsOf && roundsOf[idx]) || roundLabel;
      st.paused = false;
      st.end = Date.now() + interval * 1000;
      clearTimeout(st.t);
      tick();
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
      skip: skip,
      running: function () { return st.running; },
      stop: function () { clearTimeout(st.t); st.t = null; st.running = false; st.paused = false; node.textContent = ''; pauseBtn.hidden = true; },
      start: function () {
        if (st.running) return;
        // one timer at a time — this is what lets the pinned bar be unambiguous
        if (ACTIVE_TIMER && ACTIVE_TIMER !== api) ACTIVE_TIMER.stop();
        cancelUnpub();                     // a restart cancels any pending "give the space back"
        ACTIVE_TIMER = api; TIMER_SID = SESSION && (SESSION.session_id || SESSION.date);
        primeAudio(); st.running = true; st.end = Date.now() + interval * 1000; pauseBtn.hidden = false; tick();
      }
    };
    return api;
  }
  // How many timed holds are counting right now. A re-render mid-hold detaches the row the athlete is
  // holding, so the countdown finishes against a node that is no longer on screen and the set silently
  // never logs — Phil: "I couldn't log sets 1 through 6." Same shape as the late calendar render that
  // killed a rest timer and the late workout fetch that stole the profile: an old response overwriting
  // a screen the athlete is actively using.
  var HOLDS_RUNNING = 0;
  function startHold(btn, secs, done) {                    // duration items: countdown then log
    // Phil, after a full session: "There's no way to stop the exercise timer... I should be able to
    // tap and stop it because I should be able to log it without the timer. It forced me to do the
    // whole 60 seconds." A carry that is over at 40s should log at 40s — the athlete decides when the
    // set ended, not a countdown. Tapping again STOPS it and logs what was actually held.
    primeAudio();                                          // unlock audio on the tap that starts it (iOS)
    var rem = secs, held = 0;
    HOLDS_RUNNING++;
    btn.classList.add('holding'); btn.textContent = rem + 's';
    var iv = setInterval(function () {
      rem--; held++; btn.textContent = rem + 's';
      if (rem <= 0) { finish(); }
    }, 1000);
    function finish() {
      if (!iv) return;
      clearInterval(iv); iv = null;
      HOLDS_RUNNING = Math.max(0, HOLDS_RUNNING - 1);
      btn.classList.remove('holding');
      btn.removeEventListener('click', stopEarly);
      // Only announce a COMPLETED hold. Stopping early is a deliberate act — the athlete already knows
      // they stopped, and "Done" for a hold they cut short reads as the timer firing on its own.
      beep();
      if (held >= secs) timerAlert('Done', 'hold complete');
      done(held);
    }
    function stopEarly(ev) { ev.stopPropagation(); finish(); }
    btn.addEventListener('click', stopEarly);
  }

  function mkLog(slot, exName, t, state) {   // exName may be a swapped-in alternate
    // A hold that finishes AFTER the athlete has left the workout used to crash here with
    // "null is not an object (evaluating 'SESSION.session_id')", and the throw took the whole log
    // batch with it - the sets never reached the Workbook. Caught by j1 + the device error reporter.
    //
    // L131 NO SILENT DISCARDS (Phil 2026-08-13, born with the F1 fix). The null-guard above's old
    // form returned null in SILENCE — and silence is how Grace's 8/12 squat sets vanished: a torn-
    // down SESSION made every subsequent set a discarded null while the app looked fine. A set the
    // athlete performed is EVIDENCE (rule 40): recover the session id from the open-session crumb
    // and queue it anyway; only when even the crumb is gone does it park in a local orphan store —
    // and either way the athlete SEES it and the coach gets an ErrorLog row.
    if (!SESSION) {
      var sid = ''; try { sid = sessionStorage.getItem('bp_open_session') || ''; } catch (e) {}
      var row = { log_id: uuid(), session_id: sid, complex_name: slot.complex_name, exercise: exName,
        set_no: t.set_no, side: '', target_load: t.target_load, target_reps: t.target_reps,
        actual_load: state.load, actual_reps: state.reps, flag: 'recovered' };
      if (sid) {
        miniToast('Connection to this workout hiccuped — your set was saved.');
        reportError('discard_averted', 'set logged with no live SESSION — queued via crumb', '',
          'ex=' + exName + ' set=' + t.set_no + ' sid=' + sid);
        return row;   // queueable: rides the normal IndexedDB queue like any set
      }
      try {
        var orph = JSON.parse(localStorage.getItem('bp_orphan_sets') || '[]');
        orph.push(row); localStorage.setItem('bp_orphan_sets', JSON.stringify(orph));
      } catch (e2) {}
      miniToast('This set could not be attached to a workout — it is saved on this phone. Tell your coach.');
      reportError('orphan_set', 'set performed with no session and no crumb — parked locally', '',
        'ex=' + exName + ' set=' + t.set_no);
      return null;
    }
    return { log_id: uuid(), session_id: SESSION.session_id, complex_name: slot.complex_name, exercise: exName,
      set_no: t.set_no, side: '', target_load: t.target_load, target_reps: t.target_reps,
      actual_load: state.load, actual_reps: state.reps, flag: '' };
  }
  // EACH-SIDE: one tile, two rows. Phil 2026-07-22: "single input logging two rows (L and R) meaning
  // log reps and or weight in 1 tile rather than separating them for L versus R logging of the same
  // set." The athlete enters the set ONCE — the UI does not change — but the record keeps both limbs.
  //
  // This is here because `side` was hardcoded '' at the mkLog site, so since the grouped-card rewrite
  // every each-side lift wrote ONE row instead of two and the engine saw half the volume for exactly
  // the lifts where left and right are separate work. evidence/S9.md had "proved" L/R by POSTing
  // crafted rows at the server; nothing drove the client, so the regression was invisible. j10 drives it.
  function splitSides(row, eachSide) {
    if (!row) return [];
    if (!eachSide) return [row];
    var R = {}; for (var k in row) if (Object.prototype.hasOwnProperty.call(row, k)) R[k] = row[k];
    row.side = 'L'; R.side = 'R';
    if (row.duration_s2 != null) { R.duration_s = row.duration_s2; delete row.duration_s2; delete R.duration_s2; }
    // A SEPARATE log_id. Idempotency is keyed on log_id (HARD rule 4), so sharing one would make the
    // server ack the R row as a duplicate and drop it — a silent half-log with no error anywhere.
    R.log_id = uuid();
    return [row, R];
  }
  // LEVEL GOAL (rung pass standard), muted, on line 1 next to the name. ONE value only — the weight, or
  // the reps for bodyweight. Returns null (nothing shown) for warm-up sets and for non-leveled exercises
  // (accessories/stability not in Level Standards) so they never show a bogus goal.
  function goalValue(ex, t) {
    if (t.kind === 'warmup') return null;
    var lg = ex.level_goal;
    if (!lg || (lg.load == null && lg.reps == null)) return null;
    return lg.load != null ? (lg.load + ' lb') : (lg.reps + ' reps');
  }
  // A lane = a small uppercase header + the control under it. Phil 2026-07-18: "reps and lb so
  // small, better place as header or someehre else" — the units used to be an 8px scrap wedged
  // between the number and the + button. As a lane header they're legible, they say what the number
  // IS, and they cost no width. The stepper below shows the bare number.
  function lane(cls, label, node) {
    var d = el('div', cls);
    d.appendChild(el('span', 'lane-l', label || ''));
    if (node) d.appendChild(node);
    return d;
  }
  function slotLabel(s) {                              // "WUp1" -> "Warm Up 1"; "Comp1" -> "Complex 1"
    s = String(s || '');
    var m = s.match(/^W\s*U\s*p?\s*(\d+)/i); if (m) return 'Warm Up ' + m[1];
    var c = s.match(/^Comp\s*(\d+)/i); if (c) return 'Complex ' + c[1];
    return s;
  }

  // Compact −/+ stepper bound to state[key] (single increment; − left, value, + right).
  // extraCls (e.g. 'mini') styles a secondary/subtle stepper.
  // "MAX" IS A REAL PRESCRIPTION, NOT A MISSING NUMBER. Phil 2026-07-22: "single-leg calf raise, when
  // I chose that as a swap out, it gave me 10 reps instead of max. Can we have max show up, and then
  // when you click it, you can scale up or down, plus or minus?"
  //
  // So the stepper carries the word until the athlete touches it, then becomes the count they actually
  // did — starting from their own best rather than from 1, because the first tap after a max set is a
  // correction, not a fresh count. The value only reaches the Workbook once it is a number; logging
  // the string "max" would record a set nobody can compare to anything.
  function isMaxVal(v) { return typeof v === 'string' && v.trim().toLowerCase() === 'max'; }
  function stepper(state, key, delta, unit, extraCls, onTouch, maxBase, editable) {
    var f = el('div', 'stepper' + (extraCls ? ' ' + extraCls : '') + (editable ? ' editable' : ''));
    // EDITABLE: the value itself is a tap-to-type field, so a weight is ENTERED, not bumped up from 0
    // one press at a time. Phil, B2 2026-07-25: "74 taps to reach 185 from 0." The ± buttons stay for
    // fine ±2.5 tweaks once they are near their weight — this is "both", not one or the other. A cold
    // value (0, never done) shows an EMPTY field with a placeholder so they just type the number; a
    // known value shows the number to nudge. Editable is for the LOAD only (numeric); reps/"max" keep
    // the plain readout.
    var val;
    if (editable) {
      val = document.createElement('input');
      val.className = 'val'; val.type = 'text'; val.inputMode = 'decimal';
      val.autocomplete = 'off'; val.setAttribute('aria-label', 'weight'); val.placeholder = '0';
    } else {
      val = el('span', 'val');
    }
    function draw() {
      var v = state[key];
      f.classList.toggle('is-max', isMaxVal(v));
      if (editable) {
        // Leave the field alone while it is focused (typing), or the redraw fights the keystroke.
        if (document.activeElement !== val) val.value = (v == null || v === '' || Number(v) === 0) ? '' : v;
      } else {
        val.textContent = (v === '' || v == null) ? '—' : v;
      }
    }
    // Touching the number in any way is the athlete asserting it's what they actually did — adjusting
    // it, typing it, or tapping to confirm the prescribed value stands. All count (rule 2b).
    // `.confirmed` marks a stepper the athlete ACTUALLY touched — distinct from a warm-up stepper,
    // which is born without `.unconfirmed` and so looked "confirmed" to screenTouched() even though
    // nobody touched it (#38).
    function touched() { f.classList.remove('unconfirmed'); f.classList.add('confirmed'); if (onTouch) onTouch(); }
    function btn(sign) {
      var b = el('button', 'step', sign > 0 ? '+' : '−'); b.type = 'button';
      b.addEventListener('click', function () {
        // Leaving "max": start from the athlete's own best for this lift, so + means "one more than
        // last time" rather than "1".
        var c = isMaxVal(state[key]) ? (Number(maxBase) > 0 ? Number(maxBase) : 0) : Number(state[key] || 0);
        var nv = Math.round((c + sign * delta) * 10) / 10; if (nv < 0) nv = 0;
        state[key] = nv; draw(); touched();
      });
      return b;
    }
    f.appendChild(btn(-1)); f.appendChild(val); if (unit) f.appendChild(el('span', 'unit', unit)); f.appendChild(btn(1));
    if (editable) {
      val.addEventListener('input', function () {
        var raw = val.value.replace(/[^0-9.]/g, '');
        // keep only the first dot
        raw = raw.replace(/(\..*)\./g, '$1');
        state[key] = raw === '' ? '' : (Math.round(Number(raw) * 10) / 10);
        touched();
      });
      // TAP-TO-TYPE MUST REPLACE, NOT INSERT (Phil: he corrected a set to 185, the field showed 811,
      // and nothing was written). `select()` on focus is not enough on a phone: the tap that focused
      // the field then places its own caret, collapsing the selection, so each digit is INSERTED at
      // the caret. On a field showing 182, typing 1-8-5 walks 1182 -> 11882 -> 118582 — j24 reproduces
      // exactly that, and it is where the six-digit loads on the QA clone came from.
      // `beforeinput` fires BEFORE the text lands, and the first insertion of a fresh edit is TAKEN
      // OVER rather than nudged: cancel it and set the field to exactly what was typed. Two weaker
      // versions were measured against j24 first — blanking `.value` there cancels the browser's
      // pending insertion outright (WebKit dropped the seeding step), and re-selecting the value
      // does not divert a real keystroke (the caret insert came straight back as 118582). Owning the
      // insertion is the only form that holds for BOTH a thumb and a programmatic one.
      // Armed by the TAP, not only by focus: tapping a field that already holds focus fires no focus
      // event, it just moves the caret — which is how the concatenation survived a `select()` on
      // focus and how j24 reproduced it (seed focuses, thumb taps again, digits insert).
      var freshEdit = false;
      function armEdit() { freshEdit = true; try { val.select(); } catch (e) {} }
      val.addEventListener('focus', armEdit);
      val.addEventListener('click', armEdit);
      val.addEventListener('beforeinput', function (ev) {
        if (!freshEdit) return;
        if (!ev || typeof ev.inputType !== 'string' || ev.inputType.indexOf('insert') !== 0) { freshEdit = false; return; }  // a delete edits what's there
        if (ev.data == null) return;                       // composition/dictation — leave it to the browser
        freshEdit = false;
        ev.preventDefault();
        val.value = ev.data;
        val.dispatchEvent(new Event('input', { bubbles: true }));   // keeps state[key] and `touched` honest
      });
      val.addEventListener('blur', function () { freshEdit = false; draw(); });
    } else {
      val.addEventListener('click', touched);
    }
    draw();
    return f;
  }

  // Capitalise a name the Workbook left all-lowercase ("front press" -> "Front Press"), but NEVER touch
  // one it already capitalised — "SingleLeg Calf Raise", "1 Leg Front Squat to Bench" carry the sheet's
  // intended casing (including a deliberate lowercase "to"), so a name with ANY uppercase is shown
  // verbatim. Phil 2026-07-27: "It should be capitalized too. Front press, just like it is in the
  // workbook." Only the fully-lowercase case is a data-entry slip worth fixing on the way out.
  function titleName(s) {
    s = String(s || '');
    if (/[A-Z]/.test(s)) return s;                                   // sheet chose the casing — respect it
    return s.replace(/\b([a-z])/g, function (_, c) { return c.toUpperCase(); });
  }
  // A COMPOSED header/tile string ("Upper Body · front press + Deadlift · 2026-07-06") title-cased
  // per segment, so only a fully-lowercase piece ("front press") is lifted; "Upper Body", "Deadlift"
  // and the date are each already capitalised (or have no letters) and pass through untouched.
  function titlePhrase(s) {
    return String(s || '').split(' · ').map(function (seg) {
      return seg.split(' + ').map(titleName).join(' + ');
    }).join(' · ');
  }
  // ATHLETE-FACING name: server sends athlete_name = shown_name override (Exercise Videos tab) ||
  // variant (Level Standards col D) || display_name. The level (3.1) is internal and hidden here.
  function exLabel(ex) {
    // If the athlete logged a SWAP into this slot, show what they actually DID, not the prescribed
    // name — reopening a done session should read back the real workout (Phil, 2026-07-27).
    if (ex.logged_as) return titleName(ex.logged_as);
    return titleName(ex.athlete_name || ex.variant_name || ex.display_name || ex.exercise || '');
  }

  // ---- In-app video: play in an overlay dismissed with one ✕ (no leaving the app) ----
  // Phil 2026-07-18: "some videos autoplay (side lying hip, suitcase) and some dont (4" box single
  // leg calf raise, band pull apart)". The split is exactly Vimeo vs YouTube: the two that play are
  // Vimeo, the two that don't are YouTube. A browser will not autoplay a clip that could make NOISE,
  // and YouTube's embed honours that strictly — so autoplay=1 alone is silently ignored. mute=1 is
  // what actually makes it start. These are silent demo loops, so muting costs nothing.
  // playsinline stops iOS hijacking the whole screen into its native fullscreen player.
  // COLD-LOAD GUARD (Phil chose option A). The device report is unambiguous: the app dies ONE SECOND
  // AFTER THE IFRAME IS CREATED — "while: BUILDING the player" — and only on a clip's FIRST view.
  // Phil: "It's usually some sort of first pass that crashes it." Once the player's assets are cached
  // the same clip plays fine. Autoplay makes that cold load fetch, decode and start in one burst, so
  // the first view of a clip now loads PAUSED and every later view autoplays as before. This does not
  // claim to know why the burst is fatal — it removes the burst.
  function seenBefore(url) {
    try {
      var k = 'bp_seen_vid';
      var seen = JSON.parse(localStorage.getItem(k) || '[]');
      var id = String(url).slice(0, 120);
      if (seen.indexOf(id) >= 0) return true;
      seen.push(id);
      if (seen.length > 200) seen = seen.slice(-200);
      localStorage.setItem(k, JSON.stringify(seen));
      return false;
    } catch (e) { return true; }        // storage blocked: behave as before rather than never autoplay
  }
  function videoEmbed(url) {
    var warm = seenBefore(url);
    var auto = warm ? '1' : '0';
    // `shorts/` included deliberately: Phil's Workbook uses youtube.com/shorts/<id> URLs (Chest
    // Supported Row, Seated External Rotation). A Shorts id is a normal 11-char YouTube id and plays
    // through the standard /embed/ path, but without this the URL fell through to a plain link and the
    // clip would not play inline. Found 2026-07-23 when Phil swapped three dead links and one landed as
    // a Short.
    var yt = url.match(/(?:youtube\.com\/(?:watch\?v=|embed\/|shorts\/)|youtu\.be\/)([\w-]{11})/);
    if (yt) return { type: 'iframe', warm: warm, src: 'https://www.youtube.com/embed/' + yt[1] + '?autoplay=' + auto + '&mute=1&playsinline=1&rel=0' };
    var vm = url.match(/vimeo\.com\/(?:video\/)?(\d+)/);
    if (vm) return { type: 'iframe', warm: warm, src: 'https://player.vimeo.com/video/' + vm[1] + '?autoplay=' + auto + '&muted=1&playsinline=1' };
    if (/\.mp4(\?|$)/i.test(url)) return { type: 'video', src: url };
    // A vimeo.com/share/<uuid> link carries NO video id, so there is nothing to embed. That is
    // Phil's "walking lunge" — the name is tappable, the overlay opens, and the player is empty.
    // It's a data shape, not a code bug: those rows need a plain vimeo.com/<number> URL.
    return { type: 'link', share: /vimeo\.com\/share\//i.test(url) };
  }
  // Phil: "I click on the front squat video, and it crashes and reloads. That's happened a few times
  // with other videos too."
  //
  // Cause, reproduced in qa/harness/audit.mjs: openVideo appended a NEW overlay every time and never
  // removed the previous one. Five taps left five live Vimeo players in the DOM, and closing removed
  // only the top one — the other four kept decoding. Each embed is a whole video player; on an iPhone
  // that is an out-of-memory kill, which iOS shows as the tab "crashing and reloading".
  // Two rules now: at most ONE player can exist, and closing TEARS IT DOWN rather than just
  // detaching it (a detached iframe can keep its media session alive).
  function closeVideo() {
    crumbClear();
    document.querySelectorAll('.vov').forEach(function (o) {
      o.querySelectorAll('iframe').forEach(function (f) { f.src = 'about:blank'; f.remove(); });
      o.querySelectorAll('video').forEach(function (v) { try { v.pause(); } catch (e) {} v.removeAttribute('src'); try { v.load(); } catch (e) {} v.remove(); });
      o.remove();
    });
    document.removeEventListener('keydown', _vEsc);
  }
  function _vEsc(ev) { if (ev.key === 'Escape') closeVideo(); }
  function openVideo(url) {
    if (!url) return;
    // Breadcrumb BEFORE the player exists. If the tab dies here, the next launch reports which clip
    // and which host was being opened — the only way to tell a crashing video from a working one.
    closeVideo();                    // never stack players — this is the crash
    var e = videoEmbed(url);
    // CRUMB NAMES THE EMBED HOST, not the cell's (2026-08-08): "host=vimeo.com" in a crash row led a
    // whole morning down a "the full site was embedded" theory, when the player was player.vimeo.com
    // all along — the crumb was reporting the Workbook cell, not what the app actually loaded.
    var host = (String((e && e.src) || url).match(/https?:\/\/([^\/]+)/) || [])[1] || 'unknown';
    // AFTER closeVideo, not before: closeVideo clears the crumb, so writing it first wiped the note
    // on every single open. Caught by j5 on its first run — the breadcrumb was silently never set.
    crumb('opening a video', 'host=' + host + ' cell=' + String(url).slice(0, 120));
    var ov = el('div', 'vov'), box = el('div', 'vbox');
    var close = el('button', 'vclose', '✕'); close.type = 'button';
    close.addEventListener('click', closeVideo);
    ov.addEventListener('click', function (ev) { if (ev.target === ov) closeVideo(); });
    document.addEventListener('keydown', _vEsc);
    box.appendChild(close);
    // NO PLAYER UNTIL ASKED (Phil chose option A). His app died two seconds after a player was built
    // for Back Squat — and that clip is unremarkable: 426x240, 31s, same upload batch as clips that
    // play fine, per Vimeo's own oEmbed. So the cause is still UNKNOWN, and my "iOS memory budget"
    // explanation was a guess Phil rightly rejected, since other Vimeo clips play in standalone.
    // This does not pretend to know the cause: it stops walking into it. Tapping a name opens an
    // empty overlay with a Play button; the embed is created only on that second, deliberate tap.
    var stage = el('div', 'vstage');
    function buildPlayer() {
      // A SEPARATE crumb state. The previous one said "opening a video" for both the name tap and the
      // player build, so a crash at secondsAgo=1 could have been either — and with play-on-demand
      // those are completely different suspects. Phil's Snatch Grip RDL crashed once and played fine
      // the next time, so the cause is environmental, not the clip; knowing WHICH moment dies is the
      // difference between "the overlay is fatal" and "the embed is fatal".
      crumb('BUILDING the player', 'host=' + host + ' url=' + String(url).slice(0, 120));
      stage.innerHTML = '';
      if (e && e.type === 'iframe') {
        // A player that never appears looks identical to a broken app. Phil: Bulgarian Split Squat
        // "crashed to show the video", then showed on the second tap — and no crash was reported, so
        // the app did NOT die: the embed simply failed to render first time and worked once cached.
        // Say so, and offer the retry he was performing manually.
        var wait = el('div', 'vwait', 'Loading…');
        stage.appendChild(wait);
        var f = el('iframe'); f.className = 'vframe'; f.style.opacity = '0';
        var settled = false;
        f.addEventListener('load', function () {
          settled = true;
          f.style.opacity = ''; if (wait.parentNode) wait.remove();
        });
        setTimeout(function () {
          if (settled || !stage.contains(f)) return;
          wait.innerHTML = '';
          var again = el('button', 'vretry', 'Still loading — tap to try again'); again.type = 'button';
          again.addEventListener('click', buildPlayer);
          wait.appendChild(again);
          reportError('video_slow', 'embed did not load within 6s', '', 'host=' + host + ' url=' + String(url).slice(0, 120));
        }, 6000);
        f.src = e.src;                                 // autoplay/mute params are set in videoEmbed
        f.setAttribute('allow', 'autoplay; fullscreen; encrypted-media; picture-in-picture');
        f.setAttribute('allowfullscreen', ''); stage.appendChild(f);
      } else if (e && e.type === 'video') {
        // muted is REQUIRED for autoplay — an unmuted <video> is blocked exactly like the YouTube
        // embed was, which is why some clips sat on a black frame.
        var v = el('video'); v.className = 'vframe'; v.src = e.src;
        v.controls = true; v.autoplay = true; v.muted = true; v.playsInline = true; v.loop = true;
        stage.appendChild(v);
      }
      // Survived building the player: the risky moment has passed.
      setTimeout(function () { crumb('video playing', 'host=' + host); }, 3000);
    }
    if (e && (e.type === 'iframe' || e.type === 'video')) {
      var play = el('button', 'vplay'); play.type = 'button';
      play.appendChild(el('span', 'vplay-icon', '▶'));
      play.appendChild(el('span', 'vplay-t', 'Play video'));
      if (e && e.warm === false) play.appendChild(el('span', 'vplay-n', 'first time — tap play in the player too'));
      play.addEventListener('click', buildPlayer);
      stage.appendChild(play);
    } else {
      if (e && e.share) stage.appendChild(el('div', 'vnote', 'This clip is a Vimeo “share” link, which can’t play inside the app.'));
      var a = el('a', 'vfallback', 'Open video ↗'); a.href = url; a.target = '_blank'; a.rel = 'noopener'; stage.appendChild(a);
    }
    box.appendChild(stage);
    // QA-04: some sources block embedding ("Video unavailable"), and we can't detect that across
    // origins — so ALWAYS offer a way out rather than leaving a dead player.
    if (e) { var esc = el('a', 'vopen', "Video won't play? Open it ↗"); esc.href = url; esc.target = '_blank'; esc.rel = 'noopener'; box.appendChild(esc); }
    ov.appendChild(box); document.body.appendChild(ov);
  }
  // ---- SKIP (L162, Phil's L149b ruling): a skipped exercise/complex writes a MARKER row — flag
  // skip:coach / skip:mine / skip:pain, blank load and reps, NEVER a zero-rep row. Markers ride the
  // same IndexedDB queue as sets (durable), are excluded from evidence server-side by construction,
  // and pain skips surface to the coach's FLAGGED list. The rows grey out and stop prompting. ----
  function markRowsSkipped(exName, reason) {
    (ROW_REG[exName] || []).forEach(function (en) {
      en.row.classList.add('skipped');
      if (!en.row.querySelector('.skiplab')) {
        en.row.appendChild(el('div', 'skiplab', 'skipped — ' + (reason === 'coach' ? 'coach said to' : reason === 'pain' ? 'pain' : 'your choice')));
      }
    });
  }
  function postSkip(slot, exName, reason) {
    var marker = { log_id: uuid(), session_id: SESSION ? SESSION.session_id : '', complex_name: slot.complex_name,
      exercise: exName, set_no: '', side: '', target_load: '', target_reps: '',
      actual_load: '', actual_reps: '', flag: 'skip:' + reason };
    qAdd(marker).then(function () { drain(); }).catch(function () {});
    markRowsSkipped(exName, reason);
  }
  function toggleSkip(row, ex, slot) {
    var old = row.querySelector('.skip-panel');
    if (old) { old.remove(); return; }
    var p = el('div', 'skip-panel');
    p.appendChild(el('div', 'skip-h', 'Skip — why?'));
    [['coach', 'Coach said to'], ['mine', 'My choice'], ['pain', 'Pain 🚩']].forEach(function (o) {
      var b = el('button', 'skip-opt' + (o[0] === 'pain' ? ' pain' : '')); b.type = 'button'; b.textContent = o[1];
      b.addEventListener('click', function () { p.remove(); postSkip(slot, ex.exercise, o[0]); });
      p.appendChild(b);
    });
    var all = el('button', 'skip-opt whole'); all.type = 'button'; all.textContent = 'Skip the whole complex (coach said to)';
    all.addEventListener('click', function () {
      p.remove();
      (slot.exercises || []).forEach(function (e2) { postSkip(slot, e2.exercise, 'coach'); });
    });
    p.appendChild(all);
    row.appendChild(p);
  }
  // Registry of rendered rows, keyed by the ORIGINAL exercise, so a swap can reach every set of that
  // exercise (QA-05), not just the row it was tapped from. Reset per render(); rebuilt rows re-register.
  var ROW_REG = {};
  var SHOWN_NOTE = {};   // per-render: the one-line note (#35) shows under an exercise's FIRST row only
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
  // ONE-LINE COACH NOTE (#35), under the exercise name and only on its FIRST row (SHOWN_NOTE guards
  // it, since an exercise repeats across set-rounds). Phil types it in the Exercise Videos `note`
  // column; CSS clamps it to a single line with an ellipsis so length can never push it to two lines.
  // Empty note or already-shown -> nothing rendered.
  function noteUnder(row, ex, isMax) {
    // A max-reps movement (Accordion Squat, any 'max' alternate) has no rep target — it reads "0" until
    // the athlete fills it in, which alone looks broken. Show the instruction so it's obvious what to do.
    // Phil types a note in the Exercise Videos `note` column; that wins. Otherwise a max lift gets the
    // AMRAP instruction automatically. Phil raised this twice (2026-07-28).
    var note = ex.note || (isMax ? 'Do as many as you can' : '');
    if (!note || SHOWN_NOTE[ex.exercise]) return;
    SHOWN_NOTE[ex.exercise] = true;
    row.appendChild(el('div', 'ex-note', note));
  }
  // Build the row descriptor for one choice — either the original exercise, or an alternate carrying
  // its OWN dosing (Alternates-tab reps, no external load).
  // The Alternates tab's `reps` column is either a number (12), the word `max`, or the word `same`.
  // Phil 2026-07-18: "alternatives sometimes say same in workbook so should inherit same set #s and
  // reps and %s (back squat to front squat should be same)".
  //
  // `same` means this is the SAME LIFT done differently — Back Squat -> Front Squat — so it keeps the
  // whole prescription: load, reps, level goal and mode. The old code blanked target_load and set
  // level_goal to null for EVERY alternate, so swapping to Front Squat dropped the weight and the
  // goal on the floor and demoted it to an accessory. Anything else really is a different movement
  // with its own rep scheme, and keeps the old behaviour.
  function altIsSame(a) { return String(a && a.reps || '').trim().toLowerCase() === 'same'; }
  function swapTarget(a, oEx, oT) {
    if (a.main) return { ex: oEx, t: oT };
    var same = altIsSame(a);
    // A "max" alternate (Alternates `reps` = max) must carry 'max' THROUGH the swap. The old code ran
    // isNaN('max') -> numReps null -> target_reps fell back to the ORIGINAL exercise's reps, which is
    // Phil's "single-leg calf raise bodyweight gave me 10 reps instead of max" (#29).
    var altMax = isMaxVal(a.reps);
    var numReps = (!altMax && a.reps !== '' && a.reps != null && !isNaN(a.reps)) ? Number(a.reps) : null;
    return {
      ex: { exercise: a.name, display_name: a.name, athlete_name: a.name, variant_name: '',
        video_url: a.video_url || '', note: a.note || '', best_reps: a.best_reps,   // best_reps -> "Max" last+1 (#29)
        alternates: oEx.alternates,
        // NO ALTERNATE carries a level goal (Phil, 2026-07-28: "no alternates have level goal"). A
        // "same" alt keeps the set count, reps & %s, but not the original's level-goal weight — DB
        // Bulgarian Split Squat / 1-leg Step Down were showing BSS's / Step Down's goal, which is wrong.
        // A SEARCHED swap still carries its OWN prescription (a.level_goal from exscheme) when there is one.
        level_goal: (a.level_goal || null),
        mode: same ? oEx.mode : 'accessory',
        // A SEARCHED swap carries its own answer: Level Standards says whether that exercise is
        // loaded. Forcing false gave a reps-only Bent Row with nowhere to record the weight — a set
        // logged as "16 reps of Bent Row" is not a record of anything.
        // A `same` alt of a weighted lift stays weighted even though we blank the inherited load below:
        // `weighted` is otherwise inferred from target_load, so without this the blanked Front Squat
        // would read as a bodyweight lift and show reps where the load stepper belongs.
        wants_load: same ? (oEx.wants_load || (oT.target_load !== '' && oT.target_load != null))
                         : (a.wants_load === true),
        load_prefill: same ? oEx.load_prefill : (a.prefill_load != null ? a.prefill_load : undefined),
        rest_s: oEx.rest_s, each_side: oEx.each_side,
        _alt_of: oEx, _alt_t: oT },
      t: { set_no: oT.set_no, kind: oT.kind,
        // A `same` alternate serves the CURRENT RUNG'S DOSE VERBATIM — reps, %BW load, ramp — per set
        // (design/EQUIPMENT-FLOOR.md, Phil 2026-08-05: "same = dose follows the athlete's current rung").
        // oT is that rung's serve-time computation, so copying it per set IS the live rung read, warm-ups
        // included. This SUPERSEDES the 2026-07-24 "own best + 5" rule that blanked the load: under the
        // clearing law a same-swap (Back Squat for an SSB rung, Hex Bar for a barbell rung) must carry
        // the rung's exact numbers — the sanctioned path clears with them, the mercy path just doses.
        target_load: same ? oT.target_load
                          : (a.prefill_load != null ? a.prefill_load : ''),
        // L39 (Phil 2026-08-08, Resisted Drag): a duration-prescribed alternate ('60s') must never
        // fall back to the ORIGINAL exercise's reps — duration is the prescription.
        target_reps: altMax ? 'max' : (a.duration_s != null ? '' : (numReps == null ? oT.target_reps : numReps)),
        duration_s: same ? oT.duration_s : (a.duration_s != null ? a.duration_s : null),
        rest_s: oT.rest_s }
    };
  }
  // QA-05: apply the choice to EVERY set of that exercise in the session.
  function applySwapAll(key, a) {
    try { setTimeout(function () { document.querySelectorAll('.round').forEach(function (rb) { syncRound(rb); }); }, 400); } catch (eSR) {}
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
  // PRINCIPLES 1: never show an internal code to an athlete. The Alternates `reason` column is a
  // MATCHING key with a fixed small vocabulary (equip / noequip / le_pain / ue_pain / none), so it
  // stays as codes for the engine — but the athlete must read plain words. Humanise the known codes;
  // pass anything else through unchanged, so Phil can still type a custom phrase in the sheet and it
  // shows as-is (that is the rule-1 escape hatch). `none` shows nothing — it is "just an alternative",
  // not a scenario. This lives in code, not the sheet, because Phil's sheet edits kept getting reverted
  // when the Alternates tab was regenerated and "le_pain" came back (feedback #28, more than once).
  var REASON_LABELS = { le_pain: 'Lower body pain', ue_pain: 'Upper body pain',
                        equip: 'Have equipment', noequip: 'No equipment', none: '', searched: '' };
  function reasonLabel(code) {
    var k = String(code == null ? '' : code).trim();
    return Object.prototype.hasOwnProperty.call(REASON_LABELS, k.toLowerCase()) ? REASON_LABELS[k.toLowerCase()] : k;
  }
  // HISTORY panel: "what did I do last time?" — the most-used Everfit feature (Phil 2026-07-25). Fetches
  // this exercise's past days on tap (Blueprint sessions + Everfit legacy, newest first) so a kid can
  // check "wait, what did I do last time" without leaving the workout.
  function fmtHistDate(d) {
    var m = String(d).match(/(\d{4})-(\d{2})-(\d{2})/); if (!m) return String(d || '');
    return ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][Number(m[2]) - 1] + ' ' + Number(m[3]);
  }
  function fmtHistSet(s) {
    if (s.load != null && s.load !== '') return s.load + '×' + (s.reps != null ? s.reps : '—');
    return (s.reps != null ? s.reps : '—');
  }
  function toggleHistory(row, ex) {
    var open = row.querySelector('.hist-panel');
    if (open) { open.remove(); return; }
    var sp = row.querySelector('.swap-panel'); if (sp) sp.remove();   // one panel at a time
    // History is for the exercise ON THE ROW RIGHT NOW — the swapped-in one, not the original. Phil,
    // 2026-07-28: swapped in a calf machine, history showed the 4" calf raise. `ex` is the current
    // exercise; `ex._alt_of` is the thing it replaced (used by the swap panel, NOT here).
    var panel = el('div', 'hist-panel');
    panel.appendChild(el('div', 'hist-h', 'History · ' + exLabel(ex)));
    var body = el('div', 'hist-body'); body.appendChild(el('div', 'hist-note', 'Loading…'));
    panel.appendChild(body);
    row.appendChild(panel);
    fetch(cfg.WEBAPP_URL + '?action=history&athlete=' + encodeURIComponent(athlete) +
          '&token=' + encodeURIComponent(token) + '&exercise=' + encodeURIComponent(ex.exercise))
      .then(function (r) { return r.json(); })
      .then(function (d) {
        body.innerHTML = '';
        var days = (d && d.ok && d.days) || [];
        if (!days.length) { body.appendChild(el('div', 'hist-note', 'No history yet — first time.')); return; }
        // BY DATE (Phil, 2026-07-25): a row per day — the date on the left, then that day's sets in
        // order. No source tag; the date carries recency. Set counts vary because his Everfit logging
        // did (some days he did not log every set) — Phil accepts that; Blueprint days are consistent.
        // Nothing here is bold — history is reference; the only bold on screen is what he logs today.
        days.forEach(function (day) {
          var line = el('div', 'hist-row');
          line.appendChild(el('span', 'hist-date', fmtHistDate(day.date)));
          var sets = el('div', 'hist-sets');
          (day.sets || []).forEach(function (s) { sets.appendChild(el('span', 'hist-set', fmtHistSet(s))); });
          line.appendChild(sets);
          body.appendChild(line);
        });
      })
      .catch(function () { body.innerHTML = ''; body.appendChild(el('div', 'hist-note', 'Could not load history.')); });
  }
  // Swap panel: pick a reason-tagged alternate → every set of that exercise becomes it, with the
  // alternate's own dosing. "Keep original" reverts. Works from an alternate row too (_alt_of).
  // PRINCIPLES 2: the list shows only the reason + movement — never the dosing.
  function toggleSwap(row, ex) {
    var open = row.querySelector('.swap-panel');
    if (open) { open.remove(); return; }
    var origEx = ex._alt_of || ex;
    var panel = el('div', 'swap-panel');
    panel.appendChild(el('div', 'swap-h', 'Change exercise'));
    var opts = [{ main: true }].concat(origEx.alternates || []);
    opts.forEach(function (a) {
      var b = el('button', 'swap-opt'); b.type = 'button';
      if (a.main) {
        b.appendChild(el('span', 'swap-name', '↩ ' + exLabel(origEx)));
      } else {
        // Phil: "alternatives have catgories (i.e. equip) which should all be cpas w diff font to
        // differentiate exercise name after it." The reason and the movement were one run-on string
        // ("Upper-body pain: blackburns"), so the category read as part of the name.
        var rl = reasonLabel(a.reason);
        if (rl) b.appendChild(el('span', 'swap-cat', rl));
        b.appendChild(el('span', 'swap-name', a.name));
        // A `same` alternate keeps the whole prescription — worth saying, because it's the difference
        // between "swap and keep your working weight" and "swap into an accessory".
        if (altIsSame(a)) b.appendChild(el('span', 'swap-same', 'same sets & reps'));
      }
      b.addEventListener('click', function () { applySwapAll(origEx.exercise, a); });
      panel.appendChild(b);
    });

    // SEARCH ANY EXERCISE — DONE.md #19. Phil's reason-tagged alternates stay first, because "my knee
    // hurts" should surface the right movement without the athlete having to know one. But a curated
    // list cannot cover a gym missing a rack, so this is the way out when it does not.
    var find = el('div', 'swap-find');
    var inp = document.createElement('input');
    inp.type = 'search'; inp.className = 'swap-q'; inp.placeholder = 'Search any exercise…';
    inp.setAttribute('aria-label', 'Search any exercise');
    inp.autocomplete = 'off'; inp.autocapitalize = 'none'; inp.spellcheck = false;
    var hits = el('div', 'swap-hits');
    find.appendChild(inp); find.appendChild(hits);
    panel.appendChild(find);

    var already = {};
    (origEx.alternates || []).forEach(function (a) { already[String(a.name || '').toLowerCase()] = 1; });
    already[String(origEx.exercise || '').toLowerCase()] = 1;

    function paint(list, note) {
      hits.innerHTML = '';
      if (note) { hits.appendChild(el('div', 'swap-note', note)); return; }
      // Keep the last result clear of the fixed bottom nav. Without this the final match sits behind
      // it and reads as "no more results" — the athlete simply never sees the one they wanted.
      list.slice(0, 12).forEach(function (x) {
        var hb = el('button', 'swap-opt'); hb.type = 'button';
        if (x.region || x.tier_class) hb.appendChild(el('span', 'swap-cat', x.region || x.tier_class));
        hb.appendChild(el('span', 'swap-name', x.display_name || x.exercise));
        hb.addEventListener('click', function () {
          // INHERIT THE REAL PRESCRIPTION. Phil: "that exercise I choose should inherit the reps...
          // single-leg calf raise gave me 10 reps instead of max." Carrying only the ORIGINAL row's
          // numbers meant swapping a duration carry into Bent Row produced a load box and NO reps box,
          // and the set logged with reps blank. Ask the server what this athlete's prescription for
          // that lift actually is — the same getScheme that prescribes everything else — rather than
          // inventing a default here.
          hb.disabled = true;
          // The exscheme fetch is slow (5-13s). Without a visible cue the disabled button reads as
          // "didn't register", so Mason kept tapping (Phil, 2026-07-28). Show a spinner on the chosen
          // row and block the rest, so it plainly reads as "working".
          hb.classList.add('loading');
          hb.appendChild(el('span', 'swap-spin'));
          hits.querySelectorAll('.swap-opt').forEach(function (b) { if (b !== hb) b.disabled = true; });
          // Whether a searched swap gets a weight field is DATA, not a guess: the Alternates 'weighted'
          // (Y/N) column and a variant's loaded root drive x.wants_load from the server (Phil, 2026-07-27:
          // "add a column G under Alternates for weighted exercises").
          var fallback = { name: x.exercise, video_url: x.video_url || '', reps: x.default_reps,
                           wants_load: x.wants_load === true, reason: 'searched' };
          fetch(cfg.WEBAPP_URL + '?action=exscheme&athlete=' + encodeURIComponent(athlete) +
                '&token=' + encodeURIComponent(token) + '&exercise=' + encodeURIComponent(x.exercise) + '&sets=3')
            .then(function (r) { return r.json(); })
            .then(function (d) {
              if (!d || !d.ok) return applySwapAll(origEx.exercise, fallback);
              applySwapAll(origEx.exercise, {
                name: x.exercise, video_url: x.video_url || '', reason: 'searched',
                reps: (d.reps != null ? d.reps : x.default_reps),
                wants_load: (x.wants_load === true) || !!d.wants_load,   // weighted column OR Level Standards
                prefill_load: (d.load != null ? d.load : null),
                level_goal: d.level_goal || null,
                duration_s: (d.duration_s != null ? d.duration_s : null)
              });
            })
            .catch(function () { applySwapAll(origEx.exercise, fallback); });
        });
        hits.appendChild(hb);
      });
      if (!list.length) hits.appendChild(el('div', 'swap-note', 'No exercise matches that.'));
      try { hits.scrollTop = 0; find.scrollIntoView({ block: 'nearest' }); } catch (e) {}
    }

    var typing = null;
    // Number words and digits are the same to a searching athlete. The library carries BOTH "1 Leg
    // Squat" and "Single Leg RDL", so "one leg", "single leg" and "1 leg" must all find both (Phil,
    // 2026-07-27: "If I put in one leg, will one leg squat come up?"). Normalise every form to a digit.
    function normEx(s) {
      return String(s || '').toLowerCase()
        .replace(/\bsingle\b/g, '1').replace(/\bone\b/g, '1').replace(/\btwo\b/g, '2')
        .replace(/\bthree\b/g, '3').replace(/\bfour\b/g, '4');
    }
    inp.addEventListener('input', function () {
      var q = inp.value.trim().toLowerCase();
      clearTimeout(typing);
      if (q.length < 2) { hits.innerHTML = ''; return; }
      var nq = normEx(q);
      typing = setTimeout(function () {
        exerciseList(function (all, err) {
          if (err) return paint([], 'Offline — search needs a connection.');
          paint(all.filter(function (x) {
            if (already[String(x.exercise || '').toLowerCase()]) return false;   // already offered above
            return normEx(String(x.display_name || '') + ' ' + String(x.exercise || '')).indexOf(nq) >= 0;
          }));
        });
      }, 120);
    });

    row.appendChild(panel);
    return panel;
  }

  // The library, fetched once and cached. ~95 rows, so it costs one request per athlete per device and
  // then nothing — and a cached copy means search still works in a gym with no signal.
  var EXLIST = null;
  function exerciseList(cb) {
    if (EXLIST) return cb(EXLIST, null);
    try {
      var raw = localStorage.getItem('bp_exlist_' + CACHE_V + '_' + athlete);
      if (raw) { EXLIST = JSON.parse(raw).list; if (EXLIST && EXLIST.length) cb(EXLIST, null); }
    } catch (e) {}
    fetch(cfg.WEBAPP_URL + '?action=exercises&athlete=' + encodeURIComponent(athlete) + '&token=' + encodeURIComponent(token))
      .then(function (r) { return r.json(); }).then(function (d) {
        if (!d.ok || !d.exercises) { if (!EXLIST) cb([], 'bad'); return; }
        EXLIST = d.exercises;
        try { localStorage.setItem('bp_exlist_' + CACHE_V + '_' + athlete, JSON.stringify({ at: Date.now(), list: EXLIST })); } catch (e) {}
        cb(EXLIST, null);
      }).catch(function () { if (!EXLIST) cb([], 'offline'); });
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
  function conditioningRow(slot, ex, t, timer) {
    // Same two lines and the same four columns as a lifting row (rule 6). Running's actual is the
    // DISTANCE, its secondary is the time — so it lands in column b under every other lift's weight.
    var row = el('div', 'ex-row cond');
    var l1 = el('div', 'l1');
    l1.appendChild(el('span', 'ex-name', exLabel(ex)));
    // A conditioning row is swappable too — Depth Jump had no swap icon at all (Phil 2026-07-27:
    // "Depth jump has no swap option ... every exercise needs that swap icon"). The row registers below
    // so a swap replaces every set of it, exactly like a lifting row (QA-05).
    var sw = el('button', 'swapbtn'); sw.type = 'button'; sw.innerHTML = '⇄';
    sw.title = 'Change exercise';
    sw.addEventListener('click', function () { toggleSwap(row, ex); });
    l1.appendChild(sw);
    var hb = el('button', 'histbtn'); hb.type = 'button'; hb.innerHTML = '🕐';   // "what did I do last time" (#history)
    hb.title = 'History — what you did last time';
    hb.addEventListener('click', function () { toggleHistory(row, ex); });
    l1.appendChild(hb);
    row.appendChild(l1);
    noteUnder(row, ex, isMaxVal(t.target_reps));
    var scheme = t.duration_s ? (Math.round(t.duration_s / 60) + ' min')
      : ((t.target_reps || 1) + (t.work_s ? ('×' + t.work_s + 's') : ' reps'));
    var dist = { v: '' }, repsOut = { v: '' };
    var l2 = el('div', 'l2');
    // Only a DISTANCE prescription gets a distance box. Depth Jump ("4x") and Overhead Slam ("6x")
    // are rep counts — drawing a distance field for them asked the athlete for a number that does
    // not exist. Phil: "no distance, just reps you put in for overhead slam or depth jump."
    var wantsDist = !!t.wants_distance;
    // A PURE REP COUNT gets the same control as a stability row. Phil 2026-07-22: "The depth jump
    // overhead slam showed prescribed reps, and the reps box was really wide. There should just be one
    // box for reps, just like the stability exercises, like band pull apart or band walks. Just make
    // it the same way."
    //
    // A free-text number input was both wider and a different interaction from every other rep on the
    // screen, and it duplicated the number: "prescribed 4 reps" sat next to an empty box whose
    // placeholder was also 4. One stepper, pre-filled with the prescription, is the whole row — you
    // tap it to confirm 4, or +/- to say what you actually did (rule 2b, same as every other row).
    var isPureReps = !wantsDist && !t.duration_s && !t.work_s;
    if (isPureReps) {
      var tr = t.target_reps;
      // MAX reps (#29): the goal is literally "Max", and the input PRE-FILLS with one more than the
      // athlete did last time (best logged reps + 1), or 0 if they have never done it — so a teenager
      // sees a concrete number to beat, not the word "max" they have to interpret and tap.
      var isMaxLift = isMaxVal(tr);
      var lastReps = Number(ex.best_reps) || 0;
      var repState = { reps: isMaxLift ? (lastReps ? lastReps + 1 : 0)
                                       : ((tr != null && tr !== '') ? Number(tr) : '') };
      var st = stepper(repState, 'reps', 1, '', 'unconfirmed',
        function () { repsOut.v = repState.reps; }, (ex.best_reps || t.target_reps));
      l2.appendChild(lane('c-goal', '', isMaxLift ? el('span', 'goal-max', 'Max') : null));
      l2.appendChild(lane('c-actual', 'reps', st));
    } else {
    var di = el('input', wantsDist ? 'dist-in' : 'reps-in'); di.type = 'number';
    di.placeholder = wantsDist ? '—' : String(t.target_reps || '');
    di.inputMode = wantsDist ? 'decimal' : 'numeric';
    di.addEventListener('input', function () { if (wantsDist) dist.v = di.value; else repsOut.v = di.value; });
    l2.appendChild(lane('c-goal', 'prescribed', el('span', 'cv goal-v', scheme)));
    l2.appendChild(lane('c-actual', wantsDist ? 'distance' : 'reps', di));
    }
    l2.appendChild(lane('c-second', t.duration_s ? 'time' : (t.work_s ? 'work' : ''),
      t.duration_s ? el('span', 'cv', Math.round(t.duration_s / 60) + ' min')
        : (t.work_s ? el('span', 'cv', t.work_s + 's') : null)));
    row.appendChild(l2);
    var check = el('button', 'check cond-go', t.work_s ? 'Start' : (t.duration_s ? ('Start ' + Math.round(t.duration_s / 60) + 'm') : '✓')); check.type = 'button';
    if (isPureReps) {
      // Phil: "it still doesn't let me save the set like on the others. When you tap the boxes, it
      // puts log set." A pure rep count has no timer to start, so it is an ordinary row — the round's
      // one Log button should record it along with everything else in that round (rule 2b). Timed and
      // interval rows keep their own Start control, because there the timer IS the exercise.
      row._commit = function () { if (!row.classList.contains('done')) logIt(0); };
      row._isDur = false;
      // The round button names the field it is waiting on ("Tap Woodchop's reps"). Without _needs it
      // read "Tap Depth Jump's undefined" — Phil, 2026-07-22 — because a conditioning row was given
      // everything the round button consults EXCEPT the word for what it wants.
      row._needs = 'reps';
      // The round's Log button stays disabled until every row in it is CONFIRMED (rule 2b — you
      // cannot record a lift you did not do without passing through the number). A conditioning row
      // never set this flag, so the button was permanently disabled and Phil had to hunt for the
      // row's own control: "it still doesn't let me save the set like on the others."
      row._confirmed = false;
      st.addEventListener('click', function () { row._confirmed = true; syncRound(row.closest('.round')); });
      row._sum = function () {
        var v = repState.reps;
        return { name: (ex.athlete_name || ex.display_name || ex.exercise), val: (v === '' || v == null ? '—' : v) + ' reps' };
      };
    }
    function logIt(dur) {
      // log the reps the athlete actually did (falling back to the prescription), and a distance ONLY
      // when the prescription was a distance
      var rawReps = (!wantsDist && repsOut.v !== '' && repsOut.v != null) ? repsOut.v : t.target_reps;
      // Never log the word. An untouched "max" means the athlete did not tell us the count, so the
      // reps go blank rather than as a string no report can read.
      var doneReps = isMaxVal(rawReps) ? '' : Number(rawReps);
      var l = mkLog(slot, ex.exercise, t, { load: '', reps: doneReps });
      if (!l) return;                         // athlete left the workout mid-interval; nothing to log
      l.duration_s = dur || ''; l.distance = wantsDist ? (dist.v || '') : '';
      if (arguments.length > 1 && arguments[1] != null && arguments[1] > 0) l.duration_s2 = arguments[1];
      LOCAL_DONE[doneKey(SESSION && SESSION.session_id, slot, ex.exercise, t.set_no)] = true;
      logRows(splitSides(l, ex.each_side)); row.classList.add('done'); check.classList.add('done'); check.textContent = '✓';
      // COLLAPSE. refocus() is what recomputes a round and folds it away once every row in it is done,
      // and the lifting commit() has always called it — this one never did. So a complex collapsed and
      // a warm-up containing a carry or a Depth Jump did not, which is exactly the split Phil saw:
      // "complex 3 and complex 2 collapsed, it just didn't do that for the warm-up sets."
      refocus();
    }
    check.addEventListener('click', function () {
      if (check.classList.contains('done') || check.disabled) return;
      if (check.classList.contains('holding')) return;   // same orphan-timer guard as the lifting row
      if (check._side2arm) return;                     // armed for side 2 (each-side carry)
      if (t.work_s) startIntervals(check, t.target_reps || 1, t.work_s, t.rest_s || 0, logIt);
      else if (t.duration_s) {
        if (ex.each_side) {
          startHold(check, t.duration_s, function (h1) {
            miniToast('Side 1 done — ▶ other side');
            check.textContent = '▶2'; check._side2arm = true;
            var second = function (ev) {
              ev.stopPropagation();
              if (check.classList.contains('holding') || check.classList.contains('done')) return;
              check._side2arm = false; check.removeEventListener('click', second);
              startHold(check, t.duration_s, function (h2) { logIt(h1, h2); });
            };
            check.addEventListener('click', second);
          });
        } else startHold(check, t.duration_s, function (h1) { logIt(h1); });
      }
      else logIt('');
    });
    l1.appendChild(check);   // same as a lifting row: the action rides with the name
    regRow({ row: row, slot: slot, ex: ex, t: t, timer: timer, isASide: false });   // so a swap reaches it (QA-05)
    return row;
  }

  // Exactly two lines: [name .......... ⇄ Swap] / [goal·aim | one control | ✓].
  // Control rule (Phil 2026-07-15): WEIGHTED lifts adjust weight only (reps are the fixed goal);
  // BODYWEIGHT/stability lifts adjust reps; loaded carries (wants_load) get a weight field beside the hold.
  function exerciseRow(slot, ex, t, timer, isASide) {
    if (ex.mode === 'conditioning') return conditioningRow(slot, ex, t, timer);
    var isDur = !!t.duration_s, isAcc = ex.mode === 'accessory';
    var row = el('div', 'ex-row' + (t.kind === 'warmup' ? ' warmup' : ''));
    // swap target. `each_side` rides along because the LOG needs it (splitSides) and because it must
    // follow the SWAP: swapping Bulgarian Split Squat for a two-legged alternate has to stop writing
    // L/R rows, and the swap handler already carries the flag onto the new `ex` (see the alternates
    // branch above). Rebuilt from `ex` on every render, so there is nothing to keep in sync by hand.
    var cur = { exercise: ex.exercise, video: ex.video_url, each_side: ex.each_side, per_hand: ex.per_hand };

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
    // the one-line coach note goes under the name, once per exercise (added after l1 below)
    // d. SWAP — against the name, left-aligned and centred on it. Phil: "left aligned swap icon,
    // need tile? not vertical align with name" — it acts on the exercise, so it belongs beside it,
    // and it loses the boxed tile that made it read as a third control.
    // EVERY exercise is swappable — even with zero curated alternates you can search any exercise.
    // Phil 2026-07-27: "every exercise needs that swap icon ... if there are no alternates you can pick
    // any exercise through that search box." The icon used to hide when a lift had no alternates.
    var sw = el('button', 'swapbtn'); sw.type = 'button'; sw.innerHTML = '⇄';
    sw.title = 'Change exercise';
    sw.addEventListener('click', function () { toggleSwap(row, ex); });
    l1.appendChild(sw);
    // HISTORY — "what did I do last time?" the most-used Everfit feature (Phil 2026-07-25). Beside the
    // swap icon; taps open a panel of past days (Blueprint sessions + Everfit legacy).
    var hb = el('button', 'histbtn'); hb.type = 'button'; hb.innerHTML = '🕐';
    hb.title = 'History — what you did last time';
    hb.addEventListener('click', function () { toggleHistory(row, ex); });
    l1.appendChild(hb);
    // SKIP (L162) — beside history, same idiom as swap: acts on the exercise, lives with its name.
    var skb = el('button', 'skipbtn'); skb.type = 'button'; skb.innerHTML = '⏭';
    skb.title = 'Skip this exercise';
    skb.addEventListener('click', function () { toggleSkip(row, ex, slot); });
    l1.appendChild(skb);
    row.appendChild(l1);   // the ✓ is appended to l1 further down, once it exists
    if (ex.skipped) { row.classList.add('skipped'); row.appendChild(el('div', 'skiplab', 'skipped — ' + ex.skipped)); }
    noteUnder(row, ex, isMaxVal(t.target_reps));

    var prefill = isAcc ? ((ex.load_prefill === '' || ex.load_prefill == null) ? '' : ex.load_prefill) : t.target_load;
    // MAX reps (#29): the goal is literally "Max"; the input pre-fills with the athlete's best logged
    // reps for THIS movement + 1 (best_reps, keyed by name across sessions), or 0 if never done — a
    // concrete number to beat, not the word "max". Carried through a swap by swapTarget.
    var isMaxReps = isMaxVal(t.target_reps);
    var maxPrefill = (Number(ex.best_reps) || 0) ? Number(ex.best_reps) + 1 : 0;
    var state = { load: prefill, reps: isMaxReps ? maxPrefill : t.target_reps };
    // Weighted = has a prescribed load, a loaded accessory with a prefill, or a flagged loaded carry.
    var weighted = (t.target_load !== '' && t.target_load != null) || (isAcc && prefill !== '') || !!ex.wants_load;
    if (weighted && (state.load === '' || state.load == null)) state.load = 0;   // carries/blank start at 0 to bump up
    // EDIT: if this set was already logged (opening a completed day), show the LOGGED actuals and start
    // it checked. Uncheck → adjust → re-check appends a correction row (server keeps the latest).
    // Match a logged set by set number REGARDLESS of side. An each-side exercise logs TWO rows for one
    // tile (L and R), so the server keys them "<set>|L" / "<set>|R", not "<set>|". The old empty-side
    // lookup missed them, so after a reload an each-side set failed to re-show as done (#38, an
    // interaction with the S9 each-side split — one such row broke the whole round's restore).
    var lgd = null;
    if (ex.logged) {
      var _pfx = String(t.set_no) + '|';
      lgd = ex.logged[_pfx];                                                   // normal set (empty side)
      if (!lgd) for (var _k in ex.logged) { if (_k.indexOf(_pfx) === 0) { lgd = ex.logged[_k]; break; } }  // |L or |R
    }
    // The server's map OR this device's own record — whichever knows. A queued-but-unconfirmed set is
    // still a set the athlete did.
    var wasLogged = !!lgd || !!LOCAL_DONE[doneKey(SESSION && SESSION.session_id, slot, ex.exercise, t.set_no)];
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
      var s = stepper(state, 'reps', 1, '', '', critical === 'reps' ? confirmActual : null);
      if (needsConfirm && critical === 'reps') s.classList.add('unconfirmed');
      return s;
    }
    // a. GOAL — first lane. Phil: "level goal not goal" (the label keeps the word LEVEL) and "why
    // number bolded?" — it is coach-facing context, so it is NOT bold and never competes with the
    // actual (rule 8).
    var gv = goalValue(ex, t);
    if (!gv && !isMaxReps) row.classList.add('no-goal');   // "collapse set to be shorter if no goal"
    l2.appendChild(lane('c-goal', 'level goal',
      isMaxReps ? el('span', 'cv goal-max', 'Max') : (gv ? el('span', 'cv goal-v', gv) : null)));

    // b. THE ACTUAL — always this lane, whatever kind of number it is.
    // c. THE SECONDARY — the lane still exists when empty, so every row is the same shape (rule 6).
    var aLabel = 'reps', bLabel = '', aNode = null, bNode = null;
    if (weighted) {
      var wStep = stepper(state, 'load', 2.5, '', '', critical === 'load' ? confirmActual : null, null, true);   // editable: tap-to-type the weight (B2)
      if (needsConfirm && critical === 'load') wStep.classList.add('unconfirmed');
      aLabel = (cur.per_hand || ex.per_hand) ? 'lb per hand' : 'lb';   // a DB pair logs ONE hand's weight (Phil 2026-08-05)
      aNode = wStep;
      if (isDur) { bLabel = 'time'; bNode = el('span', 'cv', t.duration_s + 's'); }   // carry: time is secondary
      else if (hasReps) { bLabel = 'reps'; bNode = repsStepper(); }
    } else if (isDur) {
      aLabel = 'time'; aNode = el('span', 'cv', t.duration_s + 's');                  // a hold: time IS the actual
    } else if (hasReps) {
      aLabel = 'reps'; aNode = repsStepper();                                         // bodyweight: reps ARE the actual
    }
    l2.appendChild(lane('c-actual', aLabel, aNode));
    l2.appendChild(lane('c-second', bLabel, bNode));

    var lastLogId = null;
    function commit(heldS) {   // checking = "already did it" — the timer is its own Start button, not tied to this
      var log = mkLog(slot, cur.exercise, t, state);
      // mkLog returns null once the athlete has left the workout (SESSION is gone). A timed hold can
      // finish AFTER that — the whole reason the guard exists — so every caller has to check, not just
      // logRows. Dereferencing it threw here and took the rest of the commit with it.
      if (!log) return;
      // Log what was actually HELD, not what was prescribed — a carry stopped at 40s is a 40s carry.
      if (isDur) log.duration_s = (heldS != null && heldS > 0) ? heldS : t.duration_s;
      if (isDur && arguments.length > 1 && arguments[1] != null && arguments[1] > 0) log.duration_s2 = arguments[1];
      lastLogId = log.log_id;
      LOCAL_DONE[doneKey(SESSION && SESSION.session_id, slot, cur.exercise, t.set_no)] = true;
      logRows(splitSides(log, cur.each_side));
      row.classList.add('done'); check.classList.add('done'); check.textContent = '✓';
      refocus();   // rule 1: finishing a set advances what's in focus
    }
    function uncheck() {   // undo an accidental check (pulls the log back if not yet sent)
      if (lastLogId) qDel([lastLogId]).then(updateBadge).catch(function () {});
      delete LOCAL_DONE[doneKey(SESSION && SESSION.session_id, slot, cur.exercise, t.set_no)];
      lastLogId = null; row.classList.remove('done'); check.classList.remove('done');
      check.textContent = isDur ? '▶' : '✓';
      refocus();
    }
    // What the collapsed one-line form of this row says (rule 1). Reads live state, so a correction
    // shows the corrected numbers without a re-render.
    row._commit = commit; row._isDur = isDur;   // the round-level Log button drives these (rule 2b)
    row._critVal = function () { return critical === 'reps' ? state.reps : (critical === 'load' ? state.load : 1); };
    row._confirmActual = confirmActual;         // round-level accept-on-tap (2026-08-06)
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
      // A running hold registers its OWN stop-early listener, but THIS handler was registered first,
      // so a second tap ran here BEFORE the stop — starting a SECOND countdown. The first was stopped
      // and logged; the orphan kept running and fired "Done" minutes later, after the athlete had
      // moved on. Phil: "I get a message of done when the timer's done, even though I already checked
      // it off... then I get a timer that it's done later. That shouldn't come up."
      if (check.classList.contains('holding')) return;   // the hold's own handler owns this tap
      if (check.classList.contains('done')) { uncheck(); return; }   // tap a done set again to undo
      // A LOCKED button must never be a DEAD tap (Phil 2026-08-05, right after a swap: "I couldn't
      // log my first set"). A real weight on screen: this tap ACCEPTS it and proceeds — it is
      // editable either way. Blank or zero: say what's needed and keep the 0-lb guard.
      if (check.classList.contains('locked')) {
        // the guard speaks the row's own critical value (2026-08-06: a searched BODYWEIGHT swap
        // could never log — the guard demanded a weight the row doesn't have)
        var critVal = critical === 'reps' ? state.reps : state.load;
        if (critVal != null && critVal !== '' && Number(critVal) > 0) confirmActual();
        else {
          miniToast(critical === 'reps' ? 'Enter your reps first' : 'Enter the weight first');
          var wf = row.querySelector('.stepper.editable') || row.querySelector('.stepper');
          if (wf) { wf.classList.add('flash'); setTimeout(function () { wf.classList.remove('flash'); }, 1200);
            var wi = wf.querySelector('input'); if (wi) { try { wi.focus(); } catch (eF) {} } }
          return;
        }
      }
      if (check._side2arm) return;                     // armed for side 2: its own listener owns this tap
      if (isDur) {
        if (cur.each_side) {
          // TIMER OPTION 1 (Phil 2026-08-05): each side gets its OWN timer — the chime fires, the
          // SAME button re-arms for the other side, and the set logs once with each side's real
          // held seconds. Rest stays at the round level, so each side keeps its full rest.
          startHold(check, t.duration_s, function (h1) {
            miniToast('Side 1 done — ▶ other side');
            check.textContent = '▶2'; check._side2arm = true;
            var second = function (ev) {
              ev.stopPropagation();
              if (check.classList.contains('holding') || check.classList.contains('done')) return;
              check._side2arm = false; check.removeEventListener('click', second);
              startHold(check, t.duration_s, function (h2) { commit(h1, h2); });
            };
            check.addEventListener('click', second);
          });
        } else startHold(check, t.duration_s, function (heldS) { commit(heldS); });
      } else commit();
    });
    if (needsConfirm && isDur) { check.classList.add('locked'); }   // visual lock only — a tap now answers instead of dying
    // Phil: "4 tiles is too much per row (goal, actual, reps, and checkmark) so maybe move checkmark
    // to be same row as exercise name and swap icon". So line 1 carries name + swap + ✓, and the
    // value line is down to three lanes.
    l1.appendChild(check);
    row.appendChild(l2);
    if (wasLogged) { row.classList.add('done'); check.classList.add('done'); check.textContent = '✓'; }   // show as logged; tap to edit
    regRow({ row: row, slot: slot, ex: ex, t: t, timer: timer, isASide: isASide });   // so a swap can reach every set (QA-05)
    return row;
  }

  function renderSummary(n, d) {
    app.innerHTML = '';
    // Phil: "You've got a massive 'Back to Calendar' button. You can take out that button. Make it
    // really small. Put that at the bottom. At the top should be the AI summary, and then any sort of
    // specific lifts that improved." The finish screen's job is to tell you what the session DID; a
    // full-width navigation control at the top was the loudest thing on a page about achievement.
    app.appendChild(el('h2', 'sum-h', 'Workout complete 💪'));
    app.appendChild(el('p', 'sum-sub', n + ' set' + (n === 1 ? '' : 's') + ' logged'));
    // Something is ALWAYS shown as the day's best (Phil 2026-08-05) — the server picks the first
    // true thing: level-up > tonnage PR > best session > strongest set > session count.
    if (d && d.highlight) app.appendChild(el('p', 'sum-highlight', d.highlight));
    function block(title, items, cls) {
      if (!items || !items.length) return;
      app.appendChild(el('h3', 'sum-t ' + cls, title));
      items.forEach(function (c) {
        var txt;
        if (c.first) txt = titleName(c.exercise) + ' — first time 🎉';
        else {
          var parts = [];
          if (c.intensity_pct != null) parts.push((c.intensity_pct >= 0 ? '+' : '') + c.intensity_pct + '% 1RM');
          if (c.volume_pct != null) parts.push((c.volume_pct >= 0 ? '+' : '') + c.volume_pct + '% vol');
          txt = titleName(c.exercise) + ' — ' + (parts.join(' · ') || 'logged');
        }
        app.appendChild(el('div', 'sum-row ' + cls, txt));
      });
    }
    function backLink() {
      var back = el('button', 'sum-back', '← Back to calendar'); back.type = 'button';
      back.addEventListener('click', function () { loadHome(); });
      app.appendChild(back);
    }
    if (!d || !d.ok || !d.logged) { app.appendChild(el('p', 'empty', 'Nice work.')); backLink(); return; }
    // MAIN LIFTS FIRST — the coach's headline. Every tested lift logged today shows what he did, so a
    // main lift (Front Press 75×5) is never crowded out of the synopsis by a first-time accessory
    // (Phil 2026-07-27). The highlight lists below stay a curated few; this one is complete.
    if (d.mains && d.mains.length) {
      app.appendChild(el('h3', 'sum-t main', 'Main lifts 🏋️'));
      d.mains.forEach(function (m) {
        var result = m.loaded ? ((m.load != null ? m.load : '?') + ' lb × ' + (m.reps != null ? m.reps : '?'))
                              : ((m.reps != null ? m.reps : '?') + ' reps');
        var tail = m.leveled ? ' · leveled up 🎉'
          : (m.delta_pct != null && m.delta_pct > 0) ? ' · ▲ +' + m.delta_pct + '%' : '';
        // HIT / SHORT vs today's prescription (Phil: the summary told him "nothing insightful" — this
        // is the one feedback the rows already contain). Hit everything = a quiet check; short = the
        // honest count, not a judgment.
        if (m.of) tail += (m.hit === m.of) ? ' · target ' + m.hit + '/' + m.of + ' ✅'
                                           : ' · short on ' + (m.of - m.hit) + ' of ' + m.of;
        app.appendChild(el('div', 'sum-row main', titleName(m.name || m.exercise) + ' — ' + result + tail));
      });
    }
    if (d.level_ups && d.level_ups.length) {   // celebrate any rung the athlete passed this session
      app.appendChild(el('h3', 'sum-t up', 'Leveled up! 🎉'));
      d.level_ups.forEach(function (u) {
        app.appendChild(el('div', 'sum-row up levelup', titleName(u.exercise) + ' → level ' + u.level));
      });
    }
    block('Top gains 🔺', d.best, 'up');
    block('Keep an eye on 🔻', d.worst, 'down');
    backLink();                                  // small, and last — it is navigation, not the point
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
    } else if (rb.classList.contains('is-next') || rb.classList.contains('is-later')) {
      // Phil, on a real phone: "There are only sets one and two. There are no work sets for squat and
      // for split squat... so that's a pretty massive problem." The work sets existed — rule 1 was
      // HIDING every round past the next one, so a session he couldn't advance through looked like a
      // session with no work in it. Collapsing what's ahead is right; erasing it is not. Every
      // upcoming set now shows one line, so the shape of the session is always visible.
      var isNext = rb.classList.contains('is-next');
      var names = rows.map(function (r) { var s = r._sum && r._sum(); return s ? s.name : ''; }).filter(Boolean).join(' + ');
      var line = el('div', 'up-line');
      line.appendChild(el('span', 'dl-t', (isNext ? 'Next · ' : '') + title + (isNext ? ' — ' + names : '')));
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
    if (!rows.length) { btn.hidden = true; return; }
    btn.hidden = false;
    var title = rb.getAttribute('data-title') || 'set';
    var pending = rows.filter(function (r) { return !r.classList.contains('done'); });
    if (!pending.length) {
      // Phil: "some of them have checkboxes, and some of them have logs... it's totally unpredictable
      // how you log workouts." So there is now exactly ONE control for a round in every state. A round
      // you already logged offers Update, which appends a correction (the server keeps the latest).
      btn.disabled = false;
      btn.classList.add('logged');
      btn.textContent = 'Update ' + title;
      return;
    }
    btn.classList.remove('logged');
    var unconfirmed = pending.filter(function (r) { return !r._confirmed; });
    // The button names the SET, never the exercise. Phil, 2026-07-27: after swapping he saw
    // "…90-90 Lift" in the button — "It should just say 'Log Set whatever number it is.'" So both the
    // prompt and the log label lead with the set number ("Set 1"), dropping the "(warm-up)" clutter.
    var setLabel = String(title || 'set').replace(/\s*\(.*\)\s*$/, '');   // "Set 1 (warm-up)" -> "Set 1"
    if (unconfirmed.length) {
      // NEVER a dead grey button (2026-08-06, the searched-swap round: Mason "couldn't log my first
      // set", j6 red). The button stays TAPPABLE with its hint; the tap itself accepts any row whose
      // number is really on screen and only blocks on a truly empty one — same law as the row-level ▶.
      btn.disabled = false;
      btn.textContent = setLabel + ' · tap your ' + unconfirmed[0]._needs;
    } else {
      btn.disabled = false;
      btn.textContent = 'Log ' + setLabel;
    }
  }

  function refocus() {
    var cards = [].slice.call(app.querySelectorAll('.slot'));
    // First pass: per-slot done state. anyDone lets us tell a slot the athlete MOVED PAST (a later slot
    // has logged sets) from the one they're actually on now.
    var info = cards.map(function (card) {
      var rounds = [].slice.call(card.querySelectorAll('.round'));
      var doneCount = 0;
      rounds.forEach(function (rb) {
        var rows = [].slice.call(rb.querySelectorAll('.ex-row'));
        if (rows.length > 0 && rows.every(function (r) { return r.classList.contains('done'); })) doneCount++;
      });
      return { card: card, rounds: rounds, done: doneCount, total: rounds.length,
               allDone: rounds.length > 0 && doneCount === rounds.length, anyDone: doneCount > 0 };
    });
    // A collapsed, not-fully-logged complex: "X of Y done" if some sets landed (partial), else "not done"
    // (Phil, 2026-07-27: "five of the six were done… it shouldn't say not done").
    var partialLabel = function (x) { return x.done > 0 ? (x.done + ' of ' + x.total + ' done') : 'not done'; };
    var lastActiveIdx = -1;
    info.forEach(function (x, i) { if (x.anyDone) lastActiveIdx = i; });   // last slot with any logged round
    var seenCurrent = false;
    info.forEach(function (x, i) {
      var card = x.card, rounds = x.rounds, nowIdx = -1;
      rounds.forEach(function (rb, ri) {
        var rows = [].slice.call(rb.querySelectorAll('.ex-row'));
        var done = rows.length > 0 && rows.every(function (r) { return r.classList.contains('done'); });
        rb.classList.toggle('is-done', done);
        if (!done && nowIdx < 0) nowIdx = ri;
      });
      rounds.forEach(function (rb, ri) {
        rb.classList.remove('is-now', 'is-next', 'is-later');
        if (ri === nowIdx) rb.classList.add('is-now');
        else if (nowIdx >= 0 && ri === nowIdx + 1) rb.classList.add('is-next');
        else if (nowIdx >= 0 && ri > nowIdx + 1) rb.classList.add('is-later');
        roundSummary(rb); syncRound(rb);
      });
      card.classList.remove('slot-done', 'slot-now', 'slot-later');
      var st = card.querySelector('.slot-state');
      if (x.allDone) {
        card.classList.add('slot-done');                 // fully logged -> collapsed, "done"
        if (st) st.textContent = 'done';
      } else if (i < lastActiveIdx) {
        // a LATER slot has logged sets, so the athlete moved past this one. Collapse it: "X of Y done"
        // if partial, else "not done" — never "not started" (Phil, 2026-07-27).
        card.classList.add('slot-later');
        if (st) st.textContent = partialLabel(x);
      } else if (!seenCurrent) {
        seenCurrent = true; card.classList.add('slot-now');   // the slot the athlete is actually on -> expanded
        if (st) st.textContent = '';
      } else {
        card.classList.add('slot-later');                 // not reached -> collapsed; partial-aware label
        if (st) st.textContent = partialLabel(x);
      }
    });
  }

  // ---- FIRST-TIME ESTIMATION INTAKE (design/EQUIPMENT-FLOOR.md; Phil 2026-08-05 #2) ---------------
  // Phil, on seeing the attempt-by-attempt climb: "The individual knows already what they can do, so
  // there shouldn't be a goal. It's like the opening screen, and that's it." So the baseline is ONE
  // screen, once: for each zero-data ladder lift, "how many can you do?" at their floor variant — no
  // goals shown, no attempt protocol, one Save. Each number is queued as a normal append-only log row
  // with flag='climb|<variant>|<level>' — the same variant-attributed evidence channel the engine
  // levels from — so the server needed no change when the screen did. One estimation clears at most
  // the floor variant's rungs (+1 serve, or +2 on a 1.5x overshoot); the rungs above are earned by
  // training. Reversal to the attempt-climb: restore this function from commit 0659006.
  // DESIGN.md: rules 1-4 (one primary action = the single Save; reps is THE actual, touched before
  // save — tapping the number asserts a real 0). Tokens vocabulary only.
  function renderBaseline(s) {
    clearTimerBar(s.session_id);
    SESSION = s;
    renderNav('wo');
    meta.textContent = 'First time setup · ' + s.date;
    app.innerHTML = '';
    app.appendChild(el('div', 'ex-note', 'One-time setup — how many can you do?'));
    var entries = [];
    (s.climbs || []).forEach(function (c) {
      var r = c.ladder[c.start_idx || 0] || c.ladder[0];
      var card = el('section', 'slot open');
      var head = el('div', 'slot-head');
      head.appendChild(el('h2', 'slot-title', c.display_name || c.exercise));
      card.appendChild(head);
      var body = el('div', 'sets');
      var row = el('div', 'ex-row');
      row.appendChild(el('div', 'ex-name', r.variant));
      if (r.video_url) {
        var vid = el('a', 'ex-note', 'watch: ' + r.variant); vid.href = r.video_url; vid.target = '_blank';
        row.appendChild(vid);
      }
      var lane = el('div', 'climb-lane');
      var stepper = el('div', 'stepper');
      var minus = el('button', 'step', '\u2212'); minus.type = 'button';
      var count = el('span', 'val', '0');
      var plus = el('button', 'step', '+'); plus.type = 'button';
      stepper.appendChild(minus); stepper.appendChild(count); stepper.appendChild(plus);
      var entry = { c: c, r: r, reps: 0, touched: false, stepper: stepper };
      function bump(d) {
        entry.reps = Math.max(0, entry.reps + d);
        count.textContent = String(entry.reps);
        entry.touched = true; stepper.classList.add('confirmed'); refresh();
      }
      minus.addEventListener('click', function () { bump(-1); });
      plus.addEventListener('click', function () { bump(+1); });
      count.addEventListener('click', function () { entry.touched = true; stepper.classList.add('confirmed'); refresh(); });   // a deliberate 0
      lane.appendChild(stepper);
      row.appendChild(lane);
      body.appendChild(row);
      card.appendChild(body);
      app.appendChild(card);
      entries.push(entry);
    });
    var save = el('button', 'roundlog', 'Save'); save.type = 'button';
    save.disabled = true;
    app.appendChild(save);
    var hint = el('div', 'ex-note', 'Tap each number (0 is fine) to confirm.');
    app.appendChild(hint);
    function refresh() {
      var ready = entries.length && entries.every(function (e) { return e.touched; });
      save.disabled = !ready;
      save.textContent = ready ? 'Save' : 'Save (' + entries.filter(function (e) { return e.touched; }).length + '/' + entries.length + ')';
    }
    refresh();
    save.addEventListener('click', function () {
      if (save.disabled) return;
      logRows(entries.map(function (e) {
        return { log_id: uuid(), session_id: s.session_id, complex_name: 'Baseline',
          exercise: e.c.exercise, set_no: 1, side: '', target_load: '', target_reps: '',
          actual_load: '', actual_reps: e.reps, flag: 'climb|' + e.r.variant + '|' + e.r.level };
      }));
      app.innerHTML = '';
      app.appendChild(el('div', 'ex-note', '\u2713 All set \u2014 your program is built from these.'));
      var back2 = el('button', 'back', '\u2190 Calendar'); back2.type = 'button';
      back2.addEventListener('click', function () { loadHome(); });
      app.appendChild(back2);
    });
  }

  function render(s) {
    if (s && s.baseline) return renderBaseline(s);
    clearTimerBar(s && (s.session_id || s.date));   // same session re-rendering keeps its live timer
    SESSION = s;
    ROW_REG = {}; LEG_REG = {}; SHOWN_NOTE = {};   // fresh registries per session render
    renderNav('wo');
    // PREFETCH the swap search library (and warm the backend) the instant a workout opens, so tapping
    // Swap and searching is immediate instead of the ~10s cold wait Mason hit mid-set (Phil, 2026-07-27).
    // exerciseList() caches in memory + localStorage, so this fetches once and every later call is free.
    try { setTimeout(function () { exerciseList(function () {}); }, 0); } catch (e) {}
    // S19 AC2: the athlete sees what they're signing up for before they start.
    // Duration gets its OWN LINE. Phil: "the title's cut off. The number of time for the workout is a
    // really key thing for the athlete, so that 34 minutes should be on a new line in the header, its
    // own line." Appending it to the title meant the long session name truncated and took the
    // duration with it — the one number the athlete plans their evening around.
    meta.textContent = titlePhrase(s.name || s.theme) + ' · ' + s.date;
    // REMOVE THE OLD ONE FIRST. This line lives in the HEADER, outside #app, so `app.innerHTML = ''`
    // below never cleared it — and render() runs again on every post-log refresh, so each logged set
    // stacked another "~46 min" under the title. Phil saw three, then five.
    if (meta.parentNode) {
      Array.prototype.forEach.call(meta.parentNode.querySelectorAll('.hdr-dur'), function (n) { n.remove(); });
    }
    if (s.est_min && meta.parentNode) {
      meta.parentNode.insertBefore(el('div', 'hdr-dur', '~' + s.est_min + ' min'), meta.nextSibling);
    }
    app.innerHTML = '';
    var back = el('button', 'back', '← Calendar'); back.type = 'button';
    back.addEventListener('click', function () { loadHome(); });
    app.appendChild(back);
    // Moving a workout lives on the CALENDAR (S16), not here. Phil: "We don't need to move to
    // another day on the workout that's shown. I would remove it." You decide what to shuffle while
    // looking at the week, not while standing in the gym with the session open.
    // COMPLEXES ARE NUMBERED AS THE ATHLETE MEETS THEM. P3 leaves gaps when a slot goes unfilled, so
    // Mason's 07-28 read "Complex 1" then "Complex 3" with no Complex 2 — Phil: "2 comes after 1."
    // The Plan keeps P3's slot id (Comp3) as the identity; only the LABEL is renumbered, so nothing
    // downstream that matches on slot name is affected.
    var compSeen = 0;
    s.slots.forEach(function (slot) {
      var card = el('section', 'slot');
      var head = el('div', 'slot-head');
      var sLabel = slotLabel(slot.slot);
      if (/^Comp\s*\d/i.test(String(slot.slot || ''))) { compSeen += 1; sLabel = 'Complex ' + compSeen; }
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
      // Round titles in interval order, so the pinned bar can say "Complex 1 · Set 3".
      var roundTitles = [];
      (function () {
        var aSideX = slot.exercises[0], maxX = 0;
        slot.exercises.forEach(function (ex) { if (ex.sets.length > maxX) maxX = ex.sets.length; });
        for (var q = 0; q < maxX; q++) {
          var aS = aSideX && aSideX.sets[q];
          roundTitles.push('Set ' + (q + 1) + (aS && aS.kind === 'warmup' ? ' (warm-up)' : ''));
        }
      })();
      var timer = makeTimer(timerNode, pauseBtn, ivs, sLabel, roundTitles);
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
      // round_offset deals the B-sides into CONSECUTIVE rounds so a complex is never a trio — see the
      // note in LoggerApi buildSession. Older payloads have no offset; `|| 0` keeps them rendering as
      // they always did, so a stale cached session degrades to the old layout rather than vanishing.
      var maxSets = 0;
      slot.exercises.forEach(function (ex) {
        var end = (ex.round_offset || 0) + ex.sets.length;
        if (end > maxSets) maxSets = end;
      });
      // QA-06: ordinals match the athlete's real count — warm-ups are sets too, so the work sets
      // continue from them (3 warm-ups -> the work sets read Set 4, 5, 6), never restarting at 1.
      for (var r = 0; r < maxSets; r++) {
        var roundBox = el('div', 'round');
        var aSet = aSide && aSide.sets[r];
        var isWarmRound = aSet && aSet.kind === 'warmup';
        // Phil: "'warm-up 2' as set header should be 'set 2 (warm-up)' to not confuse with complex
        // naming of warm up 1 or warm up 2". The SLOT is called "Warm Up 1"; a ROUND inside it being
        // called "Warm-up 2" read as a second warm-up slot. Now every round counts on one sequence
        // and the ramp sets are annotated, which also keeps QA-06 (ordinals match the real count).
        var title = 'Set ' + (r + 1) + (isWarmRound ? ' (warm-up)' : '');
        roundBox.setAttribute('data-title', title);   // the NOW tag and the collapsed lines both read this
        roundBox.appendChild(el('div', 'round-title', title));
        var count = 0;
        slot.exercises.forEach(function (ex) {
          var o = ex.round_offset || 0;
          if (r >= o && r - o < ex.sets.length) {
            roundBox.appendChild(exerciseRow(slot, ex, ex.sets[r - o], timer, ex === aSide)); count++;
          }
        });
        if (count > 1) roundBox.classList.add('paired');
        // "collapse set to be shorter if no goal" — but the goal lane is dropped for the ROUND, never
        // for a single row. A warm-up row (no goal) sitting beside a work row (goal) with different
        // lane counts would put their weights at different x, which is exactly the raggedness the
        // symmetry pass fixed. Collapse only when nothing in the round has a goal.
        var rr = [].slice.call(roundBox.querySelectorAll('.ex-row'));
        if (rr.length && rr.every(function (row) { return row.classList.contains('no-goal'); })) roundBox.classList.add('no-goal');
        // One Log button per round (rule 2). Rounds made entirely of timed holds don't get one — the
        // hold's own ▶ IS the action, and you can't log a 45s hold you haven't stood through.
        var loggable = [].slice.call(roundBox.querySelectorAll('.ex-row')).some(function (r) { return r._commit && !r._isDur; });
        // ALWAYS create the button (2026-08-06, j6): a round born all-timed-holds rendered no Log
        // control, so swapping a carry into a loggable lift left the round unloggable. The button
        // now always exists — hidden until syncRound (which already manages visibility) needs it.
        if (true) {
          var act = el('button', 'roundlog'); act.type = 'button'; act.disabled = true;
          act.hidden = !loggable;
          // `var act` is FUNCTION-scoped, and this runs inside the round loop — so every round's
          // handler closed over the SAME variable, which by click time held the LAST round's button.
          // Later rounds are normally disabled (their actuals aren't confirmed yet), so every button
          // read `disabled === true` and returned early: Phil's "It won't let me tap it, so I can't
          // log it" on a button that was visibly blue and enabled.
          // Capture THIS button explicitly, and read state off the event target as well.
          act.addEventListener('click', (function (rb, btn) {
            return function () {
              if (btn.disabled) return;
              var all = [].slice.call(rb.querySelectorAll('.ex-row')).filter(function (r) { return r._commit && !r._isDur; });
              var pending = all.filter(function (r) { return !r.classList.contains('done'); });
              // ACCEPT-ON-TAP (2026-08-06): a shown value IS the athlete's answer. Only a truly
              // empty critical value blocks — with a toast naming it and a flash showing where.
              var blocked = null;
              (pending.length ? pending : all).forEach(function (r) {
                if (r._confirmed || blocked) return;
                var v = r._critVal ? r._critVal() : 1;
                if (v != null && v !== '' && Number(v) > 0) { if (r._confirmActual) r._confirmActual(); else r._confirmed = true; }
                else blocked = r;
              });
              if (blocked) {
                miniToast('Enter your ' + (blocked._needs || 'number') + ' first');
                var bf = blocked.querySelector('.stepper.editable') || blocked.querySelector('.stepper');
                if (bf) { bf.classList.add('flash'); setTimeout(function () { bf.classList.remove('flash'); }, 1200); }
                return;
              }
              // UPDATE vs LOG. Skipping rows that are already `.done` made the "Update" button a
              // no-op: an already-logged round has no pending rows, so nothing was committed and the
              // correction never reached the server. Since the per-row checkmark is gone, that button
              // is now the ONLY way to fix a set you mis-entered — it has to re-commit everything.
              // Re-committing appends a fresh log_id; the server keeps the latest per set (hard rule 1:
              // Sessions is append-only, corrections append).
              (pending.length ? pending : all).forEach(function (r) { r._commit(); });
              // COLLAPSE ON UPDATE, like a first-time log (#23). Reaching this round to edit it added
              // `.open` (round-sum click), and CSS only folds a done round when `is-done:not(.open)`.
              // A fresh log never had `.open`, so it collapsed; an edit left it set and the round stayed
              // expanded after Update. Committing is "I'm done with this round" either way — drop `.open`.
              rb.classList.remove('open');
            };
          })(roundBox, act));
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
      // Phil, after a full session: "i logged the workout, but complex 1 timer still going so that
      // should end if workout is ended". A rest timer counting down for a workout that is over is
      // just noise that follows you out of the gym.
      clearTimerBar();
      // Mark done → reopening advances to the next session. On the server's ACK, drop the locally
      // cached week and silently re-warm it with post-complete truth — otherwise the calendar's
      // instant-paint shows the workout un-done "for a while" (Phil 2026-08-08: same race as the
      // drag-move; the cache repainted pre-complete state until a later fetch corrected it).
      sendComplete(SESSION.session_id).then(function () {
        try { localStorage.removeItem('bp_week_' + CACHE_V + '_' + athlete); } catch (e) {}
        fetchJson(cfg.WEBAPP_URL + '?action=week&athlete=' + encodeURIComponent(athlete) + '&token=' + encodeURIComponent(token))
          .then(function (d) {
            if (d && d.ok && d.sessions && d.sessions.length) {
              try { localStorage.setItem('bp_week_' + CACHE_V + '_' + athlete, JSON.stringify({ at: Date.now(), sessions: d.sessions })); } catch (e) {}
            }
          });
      });
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

  // Sweep payloads written by an older build. localStorage is small on iOS and a stale session that
  // can never be read again is pure cost.
  try {
    var kill = [];
    for (var ki = 0; ki < localStorage.length; ki++) {
      var k = localStorage.key(ki);
      if (/^bp_(sess|week|prof|exlist)_/.test(k) && k.indexOf('_' + CACHE_V + '_') < 0) kill.push(k);
    }
    kill.forEach(function (k) { try { localStorage.removeItem(k); } catch (e) {} });
  } catch (e) {}

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
    // Takes a screen ticket like every other loader. Without one, a slow week fetch resolving AFTER the
    // athlete opened a workout ran renderCalendar over the top of it — and renderCalendar sets
    // SESSION = null, so the very next set they logged silently did nothing (mkLog has no session to
    // attach it to). That is Phil's "I couldn't log sets 1 through 6" and "couldn't even update and
    // log set 3": the set was not rejected, it was dropped by a screen the athlete had already left.
    var mine = newScreen();
    // Same instant-paint as openSession: the calendar is the FIRST thing an athlete sees, so it must
    // never sit on a spinner waiting for a cold backend build.
    var cachedWk = null;
    try { var raw = localStorage.getItem('bp_week_' + CACHE_V + '_' + athlete); cachedWk = raw ? JSON.parse(raw).sessions : null; } catch (e) {}
    if (cachedWk && cachedWk.length) renderCalendar(cachedWk); else show('Loading your plan…');
    fetchJson(cfg.WEBAPP_URL + '?action=week&athlete=' + encodeURIComponent(athlete) + '&token=' + encodeURIComponent(token))
      .then(function (data) {
        if (data && data.pwa_ver) versionHandshake(data.pwa_ver);   // stale-client self-heal (P0 2026-08-12)
        if (data && (data.error === 'offline' || data.error === 'server')) {
          if (!cachedWk && isCurrent(mine)) show(data.error === 'server' ? SERVER_HICCUP : 'Offline — reconnect to see your plan.', 'err');
          return;
        }
        // Cache the week regardless — it is good data. Only DRAW if the athlete is still here.
        if (data.ok && data.sessions && data.sessions.length) {
          try { localStorage.setItem('bp_week_' + CACHE_V + '_' + athlete, JSON.stringify({ at: Date.now(), sessions: data.sessions })); } catch (e) {}
        }
        if (!isCurrent(mine)) return;
        if (!data.ok) { if (!cachedWk) show('Access denied — check your link.', 'err'); return; }
        if (!data.sessions || !data.sessions.length) {
          if (!cachedWk) {
            // A not-yet-started athlete (Grace, June) has no program until their start date — tell them
            // WHEN it begins instead of a bare "no workouts" (Phil 2026-07-28). Past/absent start -> generic.
            var sd = data.start_date, today2 = todayISO();
            if (sd && sd > today2) {
              var p2 = String(sd).split('-'), dd = new Date(+p2[0], +p2[1] - 1, +p2[2]);
              var mon = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][dd.getMonth()];
              var dow = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][dd.getDay()];
              show('Your program starts ' + dow + ', ' + mon + ' ' + dd.getDate() + '. See you then! 💪');
            } else if (data.round_pending) {
              // L120 FAIL SOFT (Phil 2026-08-11): a round generation refused by the lawfulness gate
              // must never read as "you have nothing". The kid did everything right — he finished his
              // round. The refusal is ours and it pages the morning report, not him.
              show('Nice work — you finished the round! 💪 Your next one is being built. Check back soon.');
            } else { show('No workouts scheduled yet.'); }
          }
          return;
        }
        renderCalendar(data.sessions, data.next_round_preview, data.round_pending);
      });
  }
  // Calendar = a CURRENT-WEEK strip + a day list. Phil, after using the month grid: "the list is
  // probably better than the calendar above. I don't know why we have the calendar above." He was
  // right — 7 columns on a 390px phone gives each day ~40px, which is why workout names had to move
  // out of it in the first place. The strip keeps the week at a glance; the list does the work.
  //
  // The DATE is its own column, not part of the tile: "some days might be zero workouts and some
  // days might have 2". A tile-per-day can't express either.
  function renderCalendar(sessions, nextPreview, roundPending) {
    // DUMB CALENDAR (Phil 2026-08-12, the mandated fallback): one screen, page too short to hide the
    // truth. Top: OPEN sessions, flat list, tap to start. Below: LOGGED history, newest first. No
    // date grid, no empty future rows, no scroll anchor — the clever version rendered a desert of
    // empty day rows and loaded scrolled into it, so the phone read as an empty app while the menu
    // sat 1000px above the fold. Boring and true beats clever and empty.
    try { sessionStorage.removeItem('bp_open_session'); } catch (e) {}
    SESSION = null; app.innerHTML = ''; renderNav('cal');
    // L132: a reload deferred mid-workout (versionHandshake) fires HERE — the calendar, with no live
    // session, is the safe point. The mark machinery below it still guarantees once-per-version.
    var pendR = null; try { pendR = sessionStorage.getItem('bp_pending_reload'); } catch (e) {}
    if (pendR) { try { sessionStorage.removeItem('bp_pending_reload'); } catch (e) {} versionHandshake(pendR); }
    meta.textContent = athlete + ' · pick a workout';
    var open = [], nextOpen = [], held = [], logged = [];
    (sessions || []).forEach(function (s) {
      if (s.held || s.status === 'held') held.push(s);
      else if (s.next_round && s.open_round && s.status !== 'done') nextOpen.push(s);   // rolling-law unlock: tappable, next-round section
      else if (s.open_round && s.status !== 'done') open.push(s);
      else if (s.status === 'done' || s.status === 'started') logged.push(s);
      // closed-round unlogged debris renders nowhere: not actionable, not logged (board items 9/11)
    });
    function tile(s, tappable) {
      var b = el(tappable ? 'button' : 'div', 'wo st-' + (tappable ? (s.status === 'missed' ? 'planned' : s.status) : 'held'));
      if (tappable) { b.type = 'button'; b.dataset.session = s.session_id; }
      b.appendChild(el('div', 'wo-name', titlePhrase(s.name || s.theme || 'session')));
      var bits = [];
      if (s.top_ex && s.top_ex.length) bits.push(s.top_ex.map(titleName).join(' + '));
      if (s.est_min) bits.push('~' + s.est_min + ' min');
      if (s.status === 'started') bits.unshift('started');
      if (!tappable) bits = ['unlocks after ' + titlePhrase(s.name || s.theme || 'its theme') + ' — this round'];   // friendly name, never the theme code (leak fix)
      b.appendChild(el('div', 'wo-sub', bits.join(' · ')));
      if (tappable) b.addEventListener('click', function () { openSession(s.session_id); });
      return b;
    }
    // DAY-GRID (Phil's calendar ruling 2026-08-12, restoring the original presentation): workouts
    // render ON their assigned dates — the engine dates them at mint (ECC -> UE -> TOTAL spacing)
    // and rolls any unlogged current-round session forward to today server-side, so nothing
    // strands, nothing reads "missed", and today is never empty mid-round. Hold-drag moves a
    // workout to another day (the athlete's right, as the old calendar allowed). History scrolls
    // back above; the view anchors with today at the top; next round renders below.
    function dayRowFor(ds, grid, rowsByDate) {
      if (rowsByDate[ds]) return rowsByDate[ds];
      var row = el('div', 'day-row'); row.dataset.date = ds;
      var g = el('div', 'day-g');
      var d = null; try { var pp = String(ds).split('-'); d = new Date(+pp[0], +pp[1] - 1, +pp[2]); } catch (e) {}
      g.appendChild(el('div', 'day-dow', d ? dowName(d) : ''));
      g.appendChild(el('div', 'day-date', d ? ((d.getMonth() + 1) + '/' + d.getDate()) : String(ds)));
      row.appendChild(g);
      var slot = el('div', 'day-wos'); row.appendChild(slot);
      row._slot = slot; rowsByDate[ds] = row; grid.appendChild(row);
      return row;
    }
    var grid = el('div', 'days'), rowsByDate = {}, todayStr = ymd(new Date()), todayRow = null;
    var dated = logged.concat(open).filter(function (s) { return s.date; });
    dated.sort(function (a, b) { return String(a.date) < String(b.date) ? -1 : 1; });   // oldest first: history above, today at anchor
    var allDates = [];
    dated.forEach(function (s) { if (allDates.indexOf(s.date) < 0) allDates.push(s.date); });
    // slim rest rows only inside the round's future span (bounded — no desert, no phantom weeks)
    var lastOpenDate = open.length ? open.map(function (s) { return s.date; }).sort().pop() : null;
    if (lastOpenDate && todayStr < lastOpenDate) {
      var cur = new Date(); cur.setHours(0, 0, 0, 0);
      for (var gi = 0; gi < 14; gi++) {
        var dsG = ymd(cur);
        if (dsG > lastOpenDate) break;
        if (allDates.indexOf(dsG) < 0) allDates.push(dsG);
        cur.setDate(cur.getDate() + 1);
      }
      allDates.sort();
    }
    allDates.forEach(function (ds) {
      var row = dayRowFor(ds, grid, rowsByDate);
      if (ds === todayStr) { row.classList.add('today'); todayRow = row; }
    });
    dated.forEach(function (s) {
      var row = rowsByDate[s.date];
      var t = tile(s, true);
      if (s.open_round && s.status !== 'done') attachDrag(t, s);   // move/swap: the athlete's right
      row._slot.appendChild(t);
      // STARTED-RESUME ON TODAY (Phil's ruling 2026-08-12, his 8/4 Full Body as acceptance): a
      // started-unfinished session ALSO surfaces on today's row marked "started · resume"; the
      // historical row keeps its logged date (L123 — dates are for logged work).
      if (s.status === 'started' && s.date !== todayStr) {
        var rowT = dayRowFor(todayStr, grid, rowsByDate);
        if (!todayRow) { rowT.classList.add('today'); todayRow = rowT; }
        var t2 = tile(s, true);
        var sub2 = t2.querySelector('.wo-sub');
        if (sub2) sub2.textContent = 'started · resume — ' + sub2.textContent.replace(/^started · /, '');
        rowT._slot.appendChild(t2);
      }
    });
    Object.keys(rowsByDate).forEach(function (ds) {
      if (!rowsByDate[ds]._slot.childNodes.length) rowsByDate[ds]._slot.appendChild(el('div', 'wo-sub', 'rest'));
    });
    if (!dated.length) {
      grid.appendChild(el('div', 'wo-sub', roundPending
        ? 'Your next round is being built — check back soon 💪'
        : 'Nothing scheduled right now.'));
    }
    app.appendChild(grid);
    var menu = el('div', 'open-round');
    if (nextOpen.length || held.length) menu.appendChild(el('div', 'day-dow', 'NEXT ROUND'));
    nextOpen.forEach(function (s) { menu.appendChild(tile(s, true)); });   // unlocked per the rolling law: tappable
    held.forEach(function (s) { menu.appendChild(tile(s, false)); });
    if (held.length) {
      // F6 (Phil 2026-08-14, with L154): the press exists ONLY for a genuinely mid-round early
      // start — at round close the next round opens itself, no press. "early" read as a warning.
      var go = el('button', 'wo st-pull', 'Start next round'); go.type = 'button';
      go.addEventListener('click', function () {
        go.disabled = true; go.textContent = 'Unlocking your next round…';
        fetchJson(cfg.WEBAPP_URL + '?action=pullforward&athlete=' + encodeURIComponent(athlete) + '&token=' + encodeURIComponent(token))
          .then(function (r) {
            if (r && (r.minted || r.unlocked)) { location.reload(); }
            else { go.textContent = 'Next round is being built — check back soon 💪'; }
          })
          .catch(function () { go.disabled = false; go.textContent = 'Start next round'; });
      });
      menu.appendChild(go);
    }
    app.appendChild(menu);
    // ANCHOR (the ruling's clause): open at the current week, today visible at top, history
    // reachable by scrolling back above. requestAnimationFrame so layout exists before the scroll.
    // HARDENED (Phil 2026-08-14, Mason opening at 7/27): when every dated row is history — no today
    // row, no future row — the anchor previously never fired and the view sat at the OLDEST row.
    // The anchor law has no exception: with nothing current, anchor at the newest content instead.
    var anchorEl = todayRow || (menu.childNodes.length ? menu : grid.lastElementChild);
    if (anchorEl) requestAnimationFrame(function () { try { anchorEl.scrollIntoView({ block: 'start' }); } catch (e) {} });
  }
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
        // Reload only once the server has ANSWERED — the fixed 1300ms timer raced an Apps Script
        // cold start, re-fetched the PRE-move week and cached it, so the move "didn't show until
        // reopen" (Phil 2026-08-08). The move panel got this fix earlier; the drag path kept the
        // race. Same rule now: ack, then reload.
        sendMove(s.session_id, to).then(function (res) {
          if (res && res.ok) { loadHome(); return; }
          show(MOVE_ERR[res && res.error] || 'Move failed — try again.', 'err');
          setTimeout(loadHome, 1600);
        });
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
      // Reload only once the server has ANSWERED. The old code reloaded after a fixed 1300ms, which
      // is often shorter than an Apps Script cold start \u2014 so the calendar re-read the cache before
      // the move had landed and showed the old day.
      sendMove(s.session_id, iso).then(function (res) {
        if (res && res.ok) { loadHome(); return; }
        p.innerHTML = '';
        p.appendChild(el('div', 'move-h err', MOVE_ERR[res && res.error] || 'Move failed \u2014 try again.'));
        var again = el('button', 'move-opt', 'Back'); again.type = 'button';
        again.addEventListener('click', function () { p.remove(); toggleMove(wrap, s); });
        p.appendChild(again);
      });
    }
    // Phil 2026-07-27: "you probably only need two buttons: the date and move to today. Since we don't
    // have drag and drop, that's all that really matters." So: one TODAY button (pull a session to
    // now \u2014 the common case, e.g. getting a jump on next week early) and a date picker for any other
    // day. The old -2/-1/+1/+2 relative row is gone; a specific date is clearer than counting offsets.
    var today2 = todayISO();
    var rowEl = el('div', 'move-any');
    var todayBtn = el('button', 'move-opt', 'Today'); todayBtn.type = 'button';
    todayBtn.addEventListener('click', function () { go(today2); });
    var dIn = el('input', 'move-date'); dIn.type = 'date';
    dIn.value = (s.date < today2) ? today2 : s.date;
    dIn.min = today2;                                    // nothing moves into the past
    var gBtn = el('button', 'move-go', 'Move'); gBtn.type = 'button';
    gBtn.addEventListener('click', function () { if (dIn.value) go(dIn.value); });
    rowEl.appendChild(todayBtn); rowEl.appendChild(dIn); rowEl.appendChild(gBtn);
    p.appendChild(rowEl);
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
    // RETURN TO THE SESSION THE ATHLETE IS IN — not "advance to today". Mason, day 1: he opened Monday
    // from the calendar, logged sets, tapped Profile, then tapped Workout — and this used to re-fetch
    // action=plan (which ADVANCES / re-derives a session), so it handed back a fresh program from set 1
    // and his logged sets appeared gone. bp_open_session is the exact session he opened; go back to it
    // (openSession re-fetches it and restores every logged set). Only fall back to "today" when there is
    // no session open. (Phil, 2026-07-27 — worst bug of the launch.)
    var open = null; try { open = sessionStorage.getItem('bp_open_session'); } catch (e) {}
    if (open) return openSession(open);
    var mine = newScreen();
    show('Loading…'); renderNav('wo');
    fetch(planUrl()).then(function (r) { return r.json(); }).then(function (data) {
      if (!isCurrent(mine)) return;                 // do not yank the athlete back from a newer screen
      if (!data.ok) return show('Access denied — check your link.', 'err');
      if (!data.session) return show('All caught up — no upcoming session.');
      render(data.session);
    }).catch(function () { show('Offline — reconnect to open your workout.', 'err'); });
  }

  // ---- Profile: distance-to-next-rung first; bests are the record, not the headline ----
  // SCREEN GENERATION. Every screen load takes a ticket; a response may only draw if its ticket is
  // still current. Guarding on the nav's "on" class does NOT work — whichever loader finishes last
  // rewrites it, so a slow workout fetch resolving after the athlete opened the profile stole the tab
  // back and the profile then refused to draw at all. Same class of bug as the late calendar render
  // that killed a running rest timer: an old response overwriting a newer screen.
  // WHAT THIS DEVICE HAS LOGGED, regardless of whether the server has confirmed it yet.
  //
  // A row decided it was logged purely from `ex.logged`, which comes from the server. But logging is a
  // QUEUE: the set is recorded locally and confirmed seconds later, and a session refresh landing in
  // between rebuilds the row as UNLOGGED. The athlete sees the set they just did come back empty.
  // Phil: "I couldn't log sets 1 through 6", "I couldn't even update and log set 3". The set was
  // usually IN the queue — the screen just said otherwise, which is worse than losing it, because he
  // logged it again.
  // Cleared per session render only when the server's own logged-map has caught up.
  var LOCAL_DONE = {};
  function doneKey(sid, slot, exName, setNo) {
    return [sid, slot && slot.complex_name, exName, setNo].join('|');
  }
  var SCREEN_SEQ = 0;
  function newScreen() { return ++SCREEN_SEQ; }
  function isCurrent(t) { return t === SCREEN_SEQ; }
  function profCacheKey() { return 'bp_prof_' + CACHE_V + '_' + athlete; }
  function cachedProfile() {
    try { var raw = localStorage.getItem(profCacheKey()); return raw ? JSON.parse(raw).data : null; } catch (e) { return null; }
  }
  // INSTANT PAINT, same as the workout screen already does. Phil reported the profile as slow three
  // separate times ("the profile takes about five seconds"); j8 measured it at 1.8-2.5s warm and 8.7s
  // cold, because it was the one screen that always waited for the network before drawing anything.
  // Now the last profile is painted immediately and the fresh one replaces it when it lands — so a
  // cold fetch costs the athlete nothing but a slightly stale number for a second.
  function loadProfile() {
    var mine = newScreen();
    renderNav('prof');
    var cached = cachedProfile();
    var painted = false;
    if (cached && cached.exercises) {
      renderProfile(cached.exercises || [], cached.summary || '', cached.categories || [], cached.clocks || [], cached);
      painted = true;
    } else {
      show('Loading your progress…');
    }
    fetch(cfg.WEBAPP_URL + '?action=profile&athlete=' + encodeURIComponent(athlete) + '&token=' + encodeURIComponent(token))
      .then(function (r) { return r.json(); }).then(function (data) {
        if (!isCurrent(mine)) return;                 // the athlete has moved on; do not yank them back
        if (!data.ok) { if (!painted) show('Access denied — check your link.', 'err'); return; }
        try { localStorage.setItem(profCacheKey(), JSON.stringify({ at: Date.now(), data: data })); } catch (e) {}
        renderProfile(data.exercises || [], data.summary || '', data.categories || [], data.clocks || [], data);
      }).catch(function () { if (!painted && isCurrent(mine)) show('Offline — reconnect to see your progress.', 'err'); });
  }
  // S21 profile (Phil): the two things that matter per exercise are "is my best one-set up or down"
  // and "is my volume up or down" — 7-day and 30-day. Those are the HEADLINE. Where you sit on the
  // level ladder is a demoted, non-bold third line. No 1RM on a bodyweight lift; no reps stat on a
  // trendChip/statBlock removed: they rendered the 7- and 30-day arrows. Phil 2026-07-18:
  // "no trends need history" — the profile now shows the actual sets, session by session.

  function profileCard(x) {
    var card = el('section', 'pcard');
    card.appendChild(el('div', 'p-name', x.name));
    if (x.variant && x.variant !== x.name) card.appendChild(el('div', 'p-var', 'currently: ' + x.variant));

    if (!x.has_data) {
      // Two different empty states. A lift with imported history is NOT a blank slate — saying "no
      // sets logged yet" above a "587 sets" legacy line read as a contradiction. When legacy exists,
      // point the athlete at their history instead of implying they have none.
      card.appendChild(el('div', 'p-empty', (x.legacy && x.legacy.sets)
        ? 'No sets logged in Blueprint yet.'
        : 'No sets logged yet — log one and your bests show up here.'));
    } else {
      // Phil: "best volume and one set font not so big same as exercise" — these were the loudest
      // thing on the card. They're facts about the past; the level and the gap are what's actionable.
      var stats = el('div', 'p-stats');
      if (x.best_one != null) {
        var s1 = el('div', 'p-stat');
        s1.appendChild(el('span', 'p-stat-l', 'Best one set'));
        s1.appendChild(el('span', 'p-stat-v', x.best_one + ' ' + (x.best_one_unit || '')));
        stats.appendChild(s1);
      }
      if (x.best_volume != null) {
        var s2 = el('div', 'p-stat');
        s2.appendChild(el('span', 'p-stat-l', 'Best volume'));
        s2.appendChild(el('span', 'p-stat-v', x.best_volume + ' ' + (x.volume_unit || 'lb')));
        stats.appendChild(s2);
      }
      card.appendChild(stats);
    }

    // Level: where you are on the climb and how far to go.
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

    // The compact sparkline stays as the at-a-glance "am I going up?".
    if (x.spark && x.spark.length >= 2) card.appendChild(sparkline(x.spark, x.best_one_unit));

    // TAP TO OPEN THE FULL HISTORY — Phil 2026-07-28, from Everfit: "tap an exercise, it shows the 1RM
    // improvement in a graph, the 1RM, and the volume." The point of this screen is to make progress
    // OBVIOUS with no interpretation. So a tap opens a bigger 1RM chart and a card per session (est 1RM,
    // volume, the sets). Lazy-loaded so the profile list stays instant; the full per-set data comes from
    // action=history (Blueprint + imported Everfit days both).
    if (x.has_data || (x.legacy && x.legacy.sets)) {
      var toggle = el('button', 'p-more'); toggle.type = 'button';
      toggle.textContent = 'See progress ▾';
      var detail = el('div', 'p-detail'); detail.style.display = 'none'; detail._loaded = false;
      toggle.addEventListener('click', function () {
        var open = detail.style.display !== 'none';
        detail.style.display = open ? 'none' : 'block';
        toggle.textContent = open ? 'See progress ▾' : 'Hide progress ▴';
        if (!open && !detail._loaded) { detail._loaded = true; loadProfileDetail(x, detail); }
      });
      card.appendChild(toggle);
      card.appendChild(detail);
    }
    return card;
  }

  var _est1rm = function (load, reps) { return (load > 0 && reps > 0) ? Math.round(load * (1 + reps / 30)) : null; };
  // The tap-to-open history: a VOLUME (tonnage) chart + one card per session. Phil 2026-07-28: "it's
  // best to graph tonnage rather than 1RM, and then bold and star the row where it's a 1RM in the
  // history. The graph should not be a 1RM. It should be the volume." Volume is the honest progress
  // signal across variant changes (a harder Dip variant lowers reps but the 1RM chart read as
  // "getting worse"); the PR star still marks where a new best 1RM landed.
  function _sessVol(sets) {   // tonnage: load×reps for loaded sets, reps for bodyweight (warm-ups included)
    var v = 0; (sets || []).forEach(function (s) {
      var l = Number(s.load), rp = Number(s.reps);
      if (l > 0) v += l * (rp || 0); else if (rp > 0) v += rp;
    }); return Math.round(v);
  }
  function _sess1rm(sets) {   // best est-1RM in a session (reps for bodyweight) — used only to flag PRs
    var best = null; (sets || []).forEach(function (s) {
      var l = Number(s.load), rp = Number(s.reps);
      var e = (l > 0 && rp > 0) ? _est1rm(l, rp) : (rp > 0 ? rp : null);
      if (e != null && (best == null || e > best)) best = e;
    }); return best;
  }
  function loadProfileDetail(x, panel) {
    panel.innerHTML = ''; panel.appendChild(el('div', 'p-detail-note', 'Loading…'));
    // HISTORY P0 (Phil 2026-08-14, display lane item 0): this was a RAW single-attempt fetch — one
    // Apps Script hiccup and the panel read "Could not load history" with no retry, which is the
    // failure Phil and Grace both hit. fetchJson retries twice and classes server vs offline; the
    // load-time stamp feeds the 2-second budget check (measured, never guessed).
    var tH0 = Date.now();
    fetchJson(cfg.WEBAPP_URL + '?action=history&athlete=' + encodeURIComponent(athlete) +
          '&token=' + encodeURIComponent(token) + '&exercise=' + encodeURIComponent(x.exercise))
      .then(function (d) {
        try { window.BP_lastHistMs = Date.now() - tH0; } catch (eT) {}
        if (d && (d.error === 'server' || d.error === 'offline')) {
          panel.innerHTML = '';
          panel.appendChild(el('div', 'p-detail-note', d.error === 'server' ? SERVER_HICCUP : 'Offline — reconnect to see history.'));
          return;
        }
        panel.innerHTML = '';
        var all = (d && d.ok && d.days) || [];   // newest-first; server already dropped flagged outliers
        // F-E (Phil 2026-08-12): ZERO-REP rows are not history — a tapped-but-untrained set (Grace's
        // OHP 42.5x0 pair) is noise in the athlete's own trajectory. The serve/evidence side already
        // excludes them (@193-195); the VIEW now matches. A day left with no real sets drops entirely.
        all = all.map(function (day) {
          var sets = (day.sets || []).filter(function (s) { return Number(s.reps) > 0; });
          return Object.assign({}, day, { sets: sets });
        }).filter(function (day) { return (day.sets || []).length > 0; });
        if (!all.length) { panel.appendChild(el('div', 'p-detail-note', 'No history yet.')); return; }
        // WINDOW: last 2 months if the lift was trained recently (Phil: "the last two months is fine"),
        // otherwise fall back to the most recent sessions — a lift not done in months (Bent Row) must
        // still show its trajectory, not an empty "no sets in two months".
        var cut = new Date(); cut.setDate(cut.getDate() - 62); var cutStr = ymd(cut);
        var recent = all.filter(function (day) { return String(day.date).slice(0, 10) >= cutStr; });
        var stale = recent.length === 0;
        var days = recent.length ? recent : all.slice(0, 14);
        // CURRENT VARIANT ONLY (Phil 2026-07-28: "elevator dips not dips"). A harder variant means fewer
        // reps, which reads as regression when every variant is mashed together. The server now resolves
        // each day's variant to the canonical Workbook name (workbook_name), so this is an EXACT match to
        // the current variant — no keywords. Generic/parent-named days (Blueprint logs) count as current.
        var cur = String(x.variant || '').trim().toLowerCase();
        var pname = String(x.name || '').trim().toLowerCase();
        if (cur) {
          var sameVar = days.filter(function (day) {
            var dv = String(day.variant || '').trim().toLowerCase();
            return !dv || dv === cur || dv === pname;
          });
          if (sameVar.length >= 2 && sameVar.length < days.length) days = sameVar;
        }
        // Loaded or bodyweight? Infer from the DATA (Dips is reps-only — never show it in lb).
        var loaded = days.some(function (day) { return (day.sets || []).some(function (s) { return Number(s.load) > 0; }); });
        var vunit = loaded ? 'lb' : 'reps';
        // the improvement line is VOLUME per session, oldest -> newest
        var pts = days.map(function (day) { return { date: day.date, v: _sessVol(day.sets) }; })
          .filter(function (p) { return p.v > 0; }).reverse();
        if (pts.length >= 2) panel.appendChild(bigChart(pts, vunit, 'Volume'));
        if (stale) panel.appendChild(el('div', 'p-detail-note', 'Not trained in the last two months — showing your most recent sessions.'));
        // Star ONLY the all-time best session — not every intermediate record. Phil 2026-07-28: "It's
        // only best if it's the all-time best 1RM, so it shouldn't be 99 and 66 for RDL. It should just
        // be 99." Newest-first + strict > marks the most recent day that holds the top est-1RM.
        var pr = {}, bestVal = -Infinity, bestDate = null;
        days.forEach(function (day) {
          var o = _sess1rm(day.sets);
          if (o != null && o > bestVal) { bestVal = o; bestDate = String(day.date).slice(0, 10); }
        });
        if (bestDate != null) pr[bestDate] = bestVal;
        // one card per session (days come newest-first from the server)
        days.forEach(function (day) {
          var sets = day.sets || [], isPR = !!pr[String(day.date).slice(0, 10)];
          var c = el('div', 'p-sess' + (isPR ? ' pr' : ''));
          var head = el('div', 'p-sess-h');
          var dcell = el('span', 'p-sess-d', (isPR ? '⭐ ' : '') + fmtHistDate(day.date));
          head.appendChild(dcell);
          var st = el('span', 'p-sess-s');
          if (isPR) st.appendChild(el('span', 'p-sess-1rm', (loaded ? pr[String(day.date).slice(0, 10)] + ' lb' : pr[String(day.date).slice(0, 10)] + ' reps') + ' best'));
          st.appendChild(el('span', 'p-sess-vol', 'Vol ' + _sessVol(sets) + (loaded ? ' lb' : ' reps')));
          head.appendChild(st);
          c.appendChild(head);
          // Set-by-set table (SET · LB · REPS for loaded; SET · REPS for bodyweight).
          var tbl = el('table', 'p-sess-tbl');
          var htr = el('tr', 'p-sess-thr');
          htr.appendChild(el('th', '', 'Set'));
          if (loaded) htr.appendChild(el('th', '', 'lb'));
          htr.appendChild(el('th', '', 'reps'));
          tbl.appendChild(htr);
          sets.forEach(function (s, i) {
            var l = Number(s.load), rp = Number(s.reps);
            var tr = el('tr', '');
            var setLbl = String(s.set || (i + 1)) + (s.side ? ' ' + s.side : '');
            tr.appendChild(el('td', '', setLbl));
            if (loaded) tr.appendChild(el('td', '', (s.load !== '' && s.load != null && !isNaN(l)) ? String(l) : '—'));
            tr.appendChild(el('td', '', (s.reps !== '' && s.reps != null && !isNaN(rp)) ? String(rp) : '—'));
            tbl.appendChild(tr);
          });
          c.appendChild(tbl);
          panel.appendChild(c);
        });
      })
      .catch(function () { panel.innerHTML = ''; panel.appendChild(el('div', 'p-detail-note', 'Could not load history.')); });
  }


  // A month of one lift, drawn small. Deliberately NOT a chart: no axes, no gridlines, no legend —
  // those are for reading values, and the values are listed right underneath. This answers one
  // question at a glance, "am I going up?", and shows how many times they showed up to do it.
  function sparkline(pts, unit) {
    // PAD has to clear the endpoint dot AND its halo stroke, or the last point - the one that matters
    // most - bleeds over the card's rounded edge. It did, on every loaded lift, in the first render.
    var W = 300, H = 52, PAD = 10;
    var vs = pts.map(function (p) { return p.v; });
    var lo = Math.min.apply(null, vs), hi = Math.max.apply(null, vs);
    // A flat month is real and must not render as a wandering line: give it a band so it draws level.
    if (hi - lo < 0.0001) { hi = lo + 1; lo = lo - 1; }
    var n = pts.length;
    var xy = pts.map(function (p, i) {
      return [PAD + (n === 1 ? 0 : (i * (W - PAD * 2) / (n - 1))),
              H - PAD - ((p.v - lo) / (hi - lo)) * (H - PAD * 2)];
    });
    var d = xy.map(function (c, i) { return (i ? 'L' : 'M') + c[0].toFixed(1) + ' ' + c[1].toFixed(1); }).join(' ');
    var NS = 'http://www.w3.org/2000/svg';
    var svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('class', 'spark'); svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
    svg.setAttribute('preserveAspectRatio', 'none'); svg.setAttribute('aria-hidden', 'true');
    function add(tag, attrs) {
      var e = document.createElementNS(NS, tag);
      Object.keys(attrs).forEach(function (k) { e.setAttribute(k, attrs[k]); });
      svg.appendChild(e); return e;
    }
    add('path', { class: 'spark-area', d: d + ' L' + xy[n - 1][0].toFixed(1) + ' ' + H + ' L' + xy[0][0].toFixed(1) + ' ' + H + ' Z' });
    add('path', { class: 'spark-line', d: d });
    // Every session is a dot: the repetition IS the message. The last one is emphasised because that
    // is where they are now.
    xy.forEach(function (c, i) {
      add('circle', { class: i === n - 1 ? 'spark-dot spark-now' : 'spark-dot', cx: c[0].toFixed(1), cy: c[1].toFixed(1), r: i === n - 1 ? 3.6 : 2 });
    });
    var wrap = el('div', 'spark-wrap');
    wrap.appendChild(svg);
    // NAME THE UNIT. "up 17.5" on a deadlift card is estimated-1RM pounds, and unlabelled it could be
    // pounds, reps or percent - the same class of unlabelled number the goal columns got wrong.
    var up = Math.round((vs[n - 1] - vs[0]) * 10) / 10;
    var u = /lb/.test(String(unit || '')) ? ' lb' : (up === 1 ? ' rep' : ' reps');
    wrap.appendChild(el('div', 'spark-cap',
      n + ' session' + (n === 1 ? '' : 's') + ' this month' + (up > 0 ? ' · up ' + up + u : '')));
    return wrap;
  }

  // A LARGER, labelled 1RM chart for the tap-open detail (Everfit-style): area fill, dots, the latest
  // value called out, and a date span + total gain caption. The point is progress you can't miss.
  function bigChart(pts, unit, metric) {
    var isLb = !/rep/i.test(String(unit || 'lb'));
    var u = isLb ? ' lb' : ' reps';
    var vs = pts.map(function (p) { return p.v; });
    var lo = Math.min.apply(null, vs), hi = Math.max.apply(null, vs);
    if (hi === lo) hi = lo + 1;
    var W = 300, H = 150, PADX = 10, PADT = 24, PADB = 24, n = pts.length, NS = 'http://www.w3.org/2000/svg';
    var xy = pts.map(function (p, i) {
      return [PADX + (n === 1 ? 0 : (i * (W - PADX * 2) / (n - 1))), (H - PADB) - ((p.v - lo) / (hi - lo)) * (H - PADT - PADB)];
    });
    var d = xy.map(function (c, i) { return (i ? 'L' : 'M') + c[0].toFixed(1) + ' ' + c[1].toFixed(1); }).join(' ');
    var svg = document.createElementNS(NS, 'svg'); svg.setAttribute('class', 'bigchart'); svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
    function add(tag, attrs, txt) { var e = document.createElementNS(NS, tag); Object.keys(attrs).forEach(function (k) { e.setAttribute(k, attrs[k]); }); if (txt != null) e.textContent = txt; svg.appendChild(e); return e; }
    add('path', { class: 'bc-area', d: d + ' L' + xy[n - 1][0].toFixed(1) + ' ' + (H - PADB) + ' L' + xy[0][0].toFixed(1) + ' ' + (H - PADB) + ' Z' });
    add('path', { class: 'bc-line', d: d });
    xy.forEach(function (c, i) { add('circle', { class: i === n - 1 ? 'bc-dot bc-now' : 'bc-dot', cx: c[0].toFixed(1), cy: c[1].toFixed(1), r: i === n - 1 ? 4 : 2.4 }); });
    add('text', { class: 'bc-val', x: (xy[n - 1][0] > W - 46 ? xy[n - 1][0] - 6 : xy[n - 1][0] + 6).toFixed(1),
      y: Math.max(13, xy[n - 1][1] - 7).toFixed(1), 'text-anchor': xy[n - 1][0] > W - 46 ? 'end' : 'start' }, vs[n - 1] + u);
    var wrap = el('div', 'bc-wrap'); wrap.appendChild(svg);
    var up = Math.round((vs[n - 1] - vs[0]) * 10) / 10;
    var cap = el('div', 'bc-cap');
    cap.textContent = (metric ? metric + ' · ' : '') + fmtHistDate(pts[0].date) + ' → ' + fmtHistDate(pts[n - 1].date) + (up > 0 ? '   ▲ up ' + up + u : '');
    wrap.appendChild(cap);
    return wrap;
  }

  // ---- the LADDER: six training qualities as filled rungs ----
  // Phil 2026-07-28 replaced the radar with this: "the radar is not granular enough to show anything
  // because there are only nine options... people can't really identify if they're really that much
  // better in one area versus another." A radar plots each quality at one of 9 discrete rungs — two
  // athletes both on rung 4 draw the same shape. The ladder fills to the WEAKEST lift's exact position
  // (rung + how far it has climbed toward the next, the existing clearance math), so a bar at 4.1 and a
  // bar at 4.9 read differently. The label shown is that weakest lift's level, because a quality's
  // level is the MINIMUM of its member lifts — never an average (S20 spec, the rule that matters most).
  //
  // The six labels + their order are FIXED and spelled out (LE/UE is coach shorthand no athlete has
  // seen); the mapping to Workbook tier classes is the server's (_tierCategory_), read not hardcoded.
  // Conditioning qualities slot in later by adding to this list — no layout change.
  var LADDER_ORDER = [
    { key: 'Upper Body Max',            label: 'Upper body max strength' },
    { key: 'Lower Body Max',            label: 'Lower body max strength' },
    { key: 'Upper Body Relative',       label: 'Upper body relative strength' },
    { key: 'Lower Body Relative',       label: 'Lower body relative strength' },
    { key: 'Upper Body Str Endurance',  label: 'Upper body strength endurance' },
    { key: 'Lower Body Str Endurance',  label: 'Lower body strength endurance' }
  ];
  // TAP A BAR -> that quality's lifts (S20 drill-down, Phil 2026-07-28). The bars ARE the navigation:
  // tapping one opens its lifts inline (weakest first, badged "sets your level"), replacing the old flat
  // all-exercises scroll. `byQuality` is { qualityKey: [lift rows, weakest-first] }.
  function ladderCard(cats, byQuality) {
    var byKey = {};
    (cats || []).forEach(function (c) { byKey[c.category] = c; });
    // The ceiling is DATA (server sends orderMax = the highest rung Level Standards define). Hardcoding 9
    // meant an advanced kid pegged near full and extending the sheet would silently overflow the bar; now
    // the bars rescale the moment Phil adds level-4 rungs. Round to a multiple of 3 so every level is a
    // whole block of three steps.
    var OM = 9;
    (cats || []).forEach(function (c) { if (c && c.orderMax) OM = Math.max(OM, Number(c.orderMax)); });
    OM = Math.max(3, Math.round(OM / 3) * 3);
    var card = el('div', 'ladder');
    card.appendChild(el('div', 'ladder-h', 'Where you stand — worst first · tap a bar for the lifts'));
    var panels = [];
    // WORST FIRST (B7, approved mock): iterate qualities by their level ascending — the weakest
    // quality is the headline. LADDER_ORDER was a fixed display order; it survives only as the
    // tie-break and the no-data tail.
    var ORD = LADDER_ORDER.slice().sort(function (qa, qb) {
      var ca = byKey[qa.key], cb = byKey[qb.key];
      var la = ca ? parseFloat(ca.low != null ? ca.low : ca.span) : NaN, lb = cb ? parseFloat(cb.low != null ? cb.low : cb.span) : NaN;
      if (isNaN(la) && isNaN(lb)) return 0; if (isNaN(la)) return 1; if (isNaN(lb)) return -1;
      return la - lb;
    });
    ORD.forEach(function (q) {
      var c = byKey[q.key];
      var lifts = (byQuality && byQuality[q.key]) || [];
      var tappable = lifts.length > 0;
      var row = el('div', 'ldr-row' + (c ? '' : ' empty') + (tappable ? ' opens' : ''));
      // label (two lines: "Upper body" / "max strength" — fits a 390px phone without shrinking type)
      var lab = el('div', 'ldr-lab');
      var m = q.label.match(/^(upper body|lower body)\s+(.*)$/i);
      if (m) { lab.appendChild(el('span', 'ldr-lab-1', m[1])); lab.appendChild(el('span', 'ldr-lab-2', m[2])); }
      else { lab.appendChild(el('span', 'ldr-lab-2', q.label)); }
      row.appendChild(lab);
      // the track: OM rung ticks, continuous fill to the weakest lift's exact rung+fraction
      var track = el('div', 'ldr-track');
      for (var i = 1; i < OM; i++) {
        var tk = el('div', 'ldr-tick' + (i % 3 === 0 ? ' block' : ''));   // heavier at each level boundary
        tk.style.left = (i / OM * 100) + '%'; track.appendChild(tk);
      }
      if (c) {
        var pos = c.maxed && c.n === c.maxed ? OM : Math.min(OM, (Number(c.order) || 0) + (Number(c.frac) || 0));
        var fill = el('div', 'ldr-fill'); fill.style.width = (pos / OM * 100) + '%';
        track.appendChild(fill);
      }
      row.appendChild(track);
      // the level badge (the weakest lift's level) + a chevron when the bar opens lifts
      var badge = el('div', 'ldr-badge', c ? ('L' + c.low) : '—');
      if (tappable) badge.appendChild(el('span', 'ldr-chev', '▾'));
      row.appendChild(badge);
      card.appendChild(row);
      if (tappable) {
        var panel = el('div', 'ldr-drill'); panel.hidden = true;
        lifts.forEach(function (lift, i) {
          var pc = profileCard(lift);
          if (i === 0) pc.insertBefore(el('div', 'pc-sets', 'sets your level'), pc.firstChild);   // weakest = the floor
          panel.appendChild(pc);
        });
        card.appendChild(panel);
        panels.push({ row: row, panel: panel });
        row.setAttribute('role', 'button'); row.setAttribute('tabindex', '0'); row.setAttribute('aria-expanded', 'false');
        var toggle = function () {
          var willOpen = panel.hidden;
          panels.forEach(function (p) { p.panel.hidden = true; p.row.classList.remove('open'); p.row.setAttribute('aria-expanded', 'false'); });
          if (willOpen) { panel.hidden = false; row.classList.add('open'); row.setAttribute('aria-expanded', 'true'); }
        };
        row.addEventListener('click', toggle);
        row.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } });
      }
    });
    return card;
  }

  // L137 LEVELING CLOCK, athlete side. Two derived clocks — one per side (LE/UE) — printed in the
  // SAME English the coach reads in Coach View, verbatim from the server's `english` field. Nothing
  // here is served: the clock is a read on where the athlete sits in the promotion cycle, and the
  // lifetime round_id that drives it internally NEVER reaches this screen (board D1: `Mason-R4`
  // leaking into a coach surface was the defect this law closes — the same leak on the kid's screen
  // would be worse). A side with no closed round prints its own sentence from the server, so the
  // card never invents a state. Empty payload -> no card at all, not an empty shell.
  function clockCard(clocks) {
    var rows = (clocks || []).filter(function (c) { return c && c.english; });
    if (!rows.length) return null;
    var card = el('div', 'p-clk');
    card.appendChild(el('div', 'p-clk-h', 'Leveling clock'));
    rows.forEach(function (c) {
      var r = el('div', 'p-clk-r');
      // RULING 3b (Phil 2026-08-14): FULL WORDS on the athlete card — a kid has no glossary for
      // "LE"/"UE". Coach View keeps the shorthand; the payload's `side` code maps here, and the
      // server's english line is the fallback for a payload without one.
      var side = c.side === 'LE' ? 'Lower body' : c.side === 'UE' ? 'Upper body' : c.side;
      var line = (side && c.round != null && c.of != null && c.level != null)
        ? side + ': Round ' + c.round + ' of ' + c.of + ' at ' + c.level
        : c.english;
      r.appendChild(el('div', 'p-clk-v', line));
      // The minus is a marker, not a demotion: the athlete moved up on the clock without clearing the
      // standard, and NOTHING in the program changes until they do. Unexplained, a trailing "-" on a
      // kid's level reads as a punishment.
      if (c.minus) r.appendChild(el('div', 'p-clk-n', 'the “−” means the clock moved you up before you cleared it — nothing in your program changes'));
      card.appendChild(r);
    });
    return card;
  }

  // PROFILE V2 CARDS (the mock Phil approved 2026-08-14 — B7 + S20 + D-P2 + ruling 4). Each card
  // fail-softs to nothing when its payload block is absent (an old cached payload must still render).
  function volumeCard(wksIn) {
    var wks = (wksIn || []).filter(function (w) { return w && w.wk; });
    if (!wks.length || !wks.some(function (w) { return w.lb > 0; })) return null;
    var c = el('div', 'p-ai');
    c.appendChild(el('div', 'p-ai-h', 'Weekly volume — last 12 weeks'));
    var W = 360, H = 120, PAD = 10;
    var max = Math.max.apply(null, wks.map(function (w) { return w.lb; })), min = 0;
    var bestI = 0; wks.forEach(function (w, i) { if (w.lb > wks[bestI].lb) bestI = i; });
    function xy(i, lb) { var x = PAD + i * ((W - 2 * PAD) / Math.max(1, wks.length - 1));
      var y = H - 14 - (max > min ? ((lb - min) / (max - min)) * (H - 34) : 0); return [Math.round(x), Math.round(y)]; }
    var pts = wks.map(function (w, i) { return xy(i, w.lb).join(','); }).join(' ');
    var bp = xy(bestI, wks[bestI].lb);
    var svgNS = 'http://www.w3.org/2000/svg', svg = document.createElementNS(svgNS, 'svg');
    svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H); svg.setAttribute('width', '100%'); svg.setAttribute('height', H);
    function sEl(tag, at, txt) { var n = document.createElementNS(svgNS, tag); Object.keys(at).forEach(function (k) { n.setAttribute(k, at[k]); }); if (txt) n.textContent = txt; return n; }
    svg.appendChild(sEl('polyline', { points: pts, fill: 'none', stroke: '#2e6bd6', 'stroke-width': 2.2 }));
    svg.appendChild(sEl('circle', { cx: bp[0], cy: bp[1], r: 4.5, fill: '#0a7d4f' }));
    var bx = bp[0] > W - 46 ? { x: bp[0] - 8, 'text-anchor': 'end' } : { x: Math.max(4, bp[0] - 22) };
    svg.appendChild(sEl('text', { x: bx.x, 'text-anchor': bx['text-anchor'] || 'start', y: Math.max(10, bp[1] - 8), 'font-size': 9, fill: '#0a7d4f' }, 'best week'));
    svg.appendChild(sEl('text', { x: 2, y: 10, 'font-size': 9, fill: '#8ba0b6' }, Math.round(max / 1000) + 'k lb'));
    c.appendChild(svg);
    c.appendChild(el('div', 'p-vol-foot', 'Volume = every set’s load × reps, summed. Dumbbell (per-hand) lifts count ×2 — both hands work.'));
    c.appendChild(el('div', 'p-milo', 'Add a little every time — Milo carried the calf every day, and one day it was a bull.'));
    return c;
  }
  function topCards(list) {
    var lev = list.filter(function (x) { return x.level != null; });
    if (!lev.length) return [];
    var best = lev.slice().sort(function (a, b) {
      if (!!b.maxed !== !!a.maxed) return b.maxed ? 1 : -1;
      var d = (parseFloat(b.level) || 0) - (parseFloat(a.level) || 0); if (d) return d;
      return (b.progress || 0) - (a.progress || 0); }).slice(0, 3);
    var needs = lev.filter(function (x) { return !x.maxed; }).sort(function (a, b) {
      var d = (parseFloat(a.level) || 9) - (parseFloat(b.level) || 9); if (d) return d;
      return (a.progress || 0) - (b.progress || 0); }).slice(0, 3);
    function row(x, right) { var r = el('div', 'p-pt'); r.appendChild(el('span', 'p-pt-k', x.name + (x.variant ? ' · ' + x.variant : '')));
      var b = el('span', 'p-pt-b'); b.appendChild(el('span', 'p-pt-v', right)); r.appendChild(b); return r; }
    var out = [];
    var cB = el('div', 'p-ai'); cB.appendChild(el('div', 'p-ai-h', 'Strongest right now'));
    best.forEach(function (x) { cB.appendChild(row(x, x.maxed ? 'top of its ladder' : 'L' + x.level)); });
    out.push(cB);
    if (needs.length) {
      var cN = el('div', 'p-ai'); cN.appendChild(el('div', 'p-ai-h', 'Biggest needs'));
      needs.forEach(function (x) {
        var gap = (x.to_go != null && x.goal) ? (x.goal.load != null ? x.to_go + ' lb to ' + nextOf(x.level) : x.to_go + (x.to_go === 1 ? ' rep to ' : ' reps to ') + nextOf(x.level)) : 'L' + x.level;
        cN.appendChild(row(x, gap)); });
      var up = lev.filter(function (x) { return !x.maxed && x.to_go > 0; }).sort(function (a, b) { return (b.progress || 0) - (a.progress || 0); })[0];
      if (up && up.goal) cN.appendChild(row(up, 'next level up: ' + (up.goal.load != null ? up.goal.load + '×' + up.goal.reps + ' needed' : up.goal.reps + ' reps needed')));
      out.push(cN);
    }
    return out;
  }
  function nextOf(level) { var n = parseFloat(level); return isNaN(n) ? 'next' : (Math.round((n + 0.1) * 10) / 10).toFixed(1); }
  function winsCard(v2) {
    var wins = (v2 && v2.wins) || [], bc = v2 && v2.best_complex;
    if (!wins.length && !bc) return null;
    var c = el('div', 'p-ai');
    c.appendChild(el('div', 'p-ai-h', 'Recent wins'));
    if (bc) {
      var hl = el('div', 'p-win-hl');
      hl.appendChild(el('b', '', '🏆 Best volume — whole complex'));
      hl.appendChild(el('div', '', bc.complex + ' · ' + (bc.lifts || '') + ': ' + Number(bc.lb).toLocaleString() + ' lb across ' + bc.sets + ' sets — your biggest complex in 90 days.'));
      c.appendChild(hl);
    }
    wins.slice(0, 10).forEach(function (w) {
      var r = el('div', 'p-win');
      r.appendChild(el('span', 'p-win-tag ' + (w.t === 'set' ? 'p-t-set' : 'p-t-vol'), w.t === 'set' ? 'SET PR' : 'VOLUME'));
      r.appendChild(el('span', '', w.ex + ' ' + w.txt + ' · ' + w.date));
      c.appendChild(r);
    });
    return c;
  }
  function renderProfile(list, summary, categories, clocks, payload) {
    SESSION = null; app.innerHTML = '';
    meta.textContent = athlete + ' · your progress';
    if (!list.length) { app.appendChild(el('p', 'empty', 'No exercises yet.')); return; }

    // V2 ORDER (the approved mock): tonnage graph LEADS (ruling 4), then top-3 best / top-3 needs
    // (B7 — the tiles and the AI-summary lead are superseded by these), then the clock, then the
    // ladders worst-first, then wins. The summary points card is retired from the lead position.
    var vc = volumeCard(payload && payload.volume_weeks);
    if (vc) app.appendChild(vc);
    topCards(list).forEach(function (c) { app.appendChild(c); });

    // V2 (approved mock): the AI-summary points card no longer leads — "Strongest right now" +
    // "Biggest needs" above ARE the summary, per B7. Only the honest EMPTY state survives here.
    if (!((summary && summary.points) || []).length && summary && summary.text) {
      // NOTHING LOGGED YET. Phil saw "Log a few sessions and a read on your progress shows up here"
      // sitting above a populated "by quality" card — two contradictory statements on one screen.
      // If there is no read to give, that is the whole screen; the breakdown means nothing without it.
      var ai2 = el('div', 'p-ai');
      ai2.appendChild(el('div', 'p-ai-h', 'Where you stand'));
      ai2.appendChild(el('div', 'p-ai-b', summary.text));
      app.appendChild(ai2);
      categories = [];
    }

    // PLACEMENT (proposed DESIGN rule 10, awaiting Phil — DESIGN.md rule 9): the clock sits directly
    // under "Where you stand" and above the ladder, because it answers the same question at a coarser
    // resolution — where you stand in the promotion cycle, before where each lift stands. It is not
    // coach-only data (rule 8): it is the athlete's own clock.
    var clkCard = clockCard(clocks);
    if (clkCard) app.appendChild(clkCard);

    // BY QUALITY, as the LADDER — and now the navigation. Group every lift under its rolled-up quality
    // (server sends x.quality) so tapping a bar opens that quality's lifts, weakest first. This REPLACES
    // the old flat "needs work / strongest / everything else" scroll (S20 spec, Phil 2026-07-28).
    var QKEYS = ['Upper Body Max', 'Lower Body Max', 'Upper Body Relative', 'Lower Body Relative',
                 'Upper Body Str Endurance', 'Lower Body Str Endurance'];
    var byQuality = {}, other = [];
    list.forEach(function (x) {
      if (x.quality && QKEYS.indexOf(x.quality) >= 0) (byQuality[x.quality] || (byQuality[x.quality] = [])).push(x);
      else other.push(x);   // accessories / stability / carries — no strength-quality bar; kept, never hidden
    });
    var byLevel = function (a, b) {   // weakest first; tie-break on LEAST progress (the true floor, matching
      var la = parseFloat(a.level), lb = parseFloat(b.level);   // the ladder fill + server sets_level); un-levelled last
      if (isNaN(la) && isNaN(lb)) return 0; if (isNaN(la)) return 1; if (isNaN(lb)) return -1;
      if (la !== lb) return la - lb;
      return (a.progress || 0) - (b.progress || 0);
    };
    Object.keys(byQuality).forEach(function (k) { byQuality[k].sort(byLevel); });

    // WORST FIRST (B7): the ladder orders by the quality's level ascending — the weakest quality is
    // the headline, exactly as the approved mock reads ("Where you stand — worst first").
    if (categories && categories.length) {
      categories = categories.slice().sort(function (a, b) {
        var la = parseFloat(a.low != null ? a.low : (a.span || '')), lb = parseFloat(b.low != null ? b.low : (b.span || ''));
        if (isNaN(la) && isNaN(lb)) return 0; if (isNaN(la)) return 1; if (isNaN(lb)) return -1;
        return la - lb;
      });
    }
    if (categories && categories.length >= 3) {
      app.appendChild(ladderCard(categories, byQuality));
      var wc = winsCard(payload);
      if (wc) app.appendChild(wc);
    } else if (categories && categories.length) {
      var cw = el('div', 'p-cats');
      cw.appendChild(el('div', 'p-cats-h', 'By quality'));
      categories.forEach(function (c) {
        var r = el('div', 'p-cat');
        r.appendChild(el('span', 'p-cat-n', c.label));
        r.appendChild(el('span', 'p-cat-v', c.span));
        cw.appendChild(r);
      });
      app.appendChild(cw);
    }

    // If the ladder can't render (fewer than 3 qualities), fall back to a flat list so lifts are never
    // stranded. Otherwise every quality lift lives under its bar; only the non-quality "other work"
    // (accessories, carries, stability) needs its own home so nothing disappears.
    var laddered = categories && categories.length >= 3;
    if (!laddered) {
      list.slice().sort(byLevel).forEach(function (x) { app.appendChild(profileCard(x)); });
    } else if (other.length) {
      other.sort(byLevel);
      var togg = el('button', 'p-more', 'Other work (' + other.length + ')'); togg.type = 'button';
      var wrap = el('div', 'p-rest'); wrap.hidden = true;
      other.forEach(function (x) { wrap.appendChild(profileCard(x)); });
      togg.addEventListener('click', function () {
        wrap.hidden = !wrap.hidden;
        togg.textContent = (wrap.hidden ? 'Other work (' + other.length + ')' : 'Hide other work');
      });
      app.appendChild(togg); app.appendChild(wrap);
    }
  }

  // INSTANT OPEN. A cold session build measures 11.2s on the backend — 73% of it just reading ten
  // Sheets tabs, each costing ~600-1900ms of round-trip REGARDLESS of size. No amount of tuning the
  // build removes that. Phil raised the load time ten times: "it takes 15 to 20 seconds to load each
  // page, maybe more."
  //
  // So stop waiting for it. Paint the copy already on the phone, then replace it when the fresh one
  // lands. The athlete sees their workout immediately; the refresh is invisible.
  //
  // The one hazard is re-rendering UNDER someone mid-set, which would wipe what they had typed. So a
  // late refresh only repaints while the screen is still untouched — once a set is logged or a
  // stepper is touched, the rendered view wins and the fresh payload is only cached for next time.
  function sessCacheKey(sid) { return 'bp_sess_' + CACHE_V + '_' + athlete + '_' + sid; }
  function cacheSession(sid, session) {
    try { localStorage.setItem(sessCacheKey(sid), JSON.stringify({ at: Date.now(), session: session })); } catch (e) {}
  }
  function cachedSession(sid) {
    try { var raw = localStorage.getItem(sessCacheKey(sid)); return raw ? JSON.parse(raw).session : null; } catch (e) { return null; }
  }
  function screenTouched() {
    // "Is there in-progress work the fresh network render must not wipe?" — a logged row, or a stepper
    // the athlete actually touched. It used to test `.stepper:not(.unconfirmed)`, which a WARM-UP
    // stepper matches from birth (it never gets `.unconfirmed`). So instant-painting a cached session
    // whose first round is a warm-up (Curtsy) made this true before the athlete touched anything, and
    // the fresh render carrying the logged/done state was skipped — logged sets never re-showed as done
    // after a reload (#38). `.confirmed` is set only on a real touch.
    return !!document.querySelector('.ex-row.done') || !!document.querySelector('.stepper.confirmed');
  }

  function openSession(sessionId) {
    var _screen = newScreen();   // claims the screen: a pending calendar/profile draw must not win
    primeAudio();                // the session-start TAP is the gesture iOS unlocks audio on (L124)
    try { sessionStorage.setItem('bp_open_session', sessionId); } catch (e) {}
    var cached = cachedSession(sessionId);
    if (cached) { render(cached); } else { show('Loading…'); }
    fetchJson(cfg.WEBAPP_URL + '?action=session&athlete=' + encodeURIComponent(athlete) + '&session_id=' + encodeURIComponent(sessionId) + '&token=' + encodeURIComponent(token))
      .then(function (data) {
        if (data && (data.error === 'offline' || data.error === 'server')) {
          if (!cached) show(data.error === 'server' ? SERVER_HICCUP : 'Offline — reconnect to open this workout.', 'err');
          return;
        }
        if (!data.ok || !data.session) { if (!cached) show('No workout that day.'); return; }
        cacheSession(sessionId, data.session);
        // Re-render unless the athlete is actively logging over a cached paint. BUT a reopened session
        // the SERVER already has logged sets for must always show its review state — the stale cached
        // paint (from before those sets landed) is why 7/27 opened blank after logging (Phil, 2026-07-27).
        // The render merges LOCAL_DONE, so in-progress local work is not lost by repainting.
        var srvLogged = (data.session.slots || []).some(function (sl) {
          return (sl.exercises || []).some(function (e) { return e.logged && Object.keys(e.logged).length; });
        });
        if (!cached || !screenTouched() || srvLogged) render(data.session);
      });
  }

  load();
  updateBadge().then(drain);
})();
