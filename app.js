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
  // R601 TOKEN INDIRECTION (Phil's R600 ruling: rotations must touch zero athletes). The bookmark's
  // URL token is now the ENROLLMENT credential; every call authenticates with a DEVICE token the
  // server minted for this install. Order matters: device token first (survives link rotation),
  // URL/stored link token as the fallback that can always re-enroll.
  var urlToken = params.get('token') || localStorage.getItem('bp_token') || '';
  var deviceToken = '';
  try { deviceToken = localStorage.getItem('bp_devtok_' + athlete) || ''; } catch (eDt) {}
  var token = deviceToken || urlToken;
  if (params.get('athlete')) localStorage.setItem('bp_athlete', athlete);
  if (params.get('token')) localStorage.setItem('bp_token', params.get('token'));
  // One-time invisible enrollment: fire-and-forget on boot when this install has no device token.
  // On success every SUBSEQUENT request rides the device token (the closure var flips); failure of
  // any kind changes nothing — the link token keeps working exactly as before this build.
  function enrollDevice() {
    if (deviceToken || !urlToken || !athlete || !(cfg.WEBAPP_URL)) return;
    try {
      fetch(cfg.WEBAPP_URL + '?action=enroll&athlete=' + encodeURIComponent(athlete) +
            '&token=' + encodeURIComponent(urlToken) +
            '&ua=' + encodeURIComponent(String(navigator.userAgent || '').slice(0, 40)))
        .then(function (r) { return r.json(); })
        .then(function (d) {
          if (d && d.ok && d.device_token) {
            deviceToken = String(d.device_token);
            try { localStorage.setItem('bp_devtok_' + athlete, deviceToken); } catch (eS) {}
            token = deviceToken;
          }
        }).catch(function () {});
    } catch (eEn) {}
  }
  // Revocation self-heal: a device token the server no longer lists gets 'forbidden' — drop it and
  // fall back to the bookmark's link token (which re-enrolls on the next boot). Without this, a
  // revoked device would stay dead even though its bookmark is still valid.
  function tokenRejected() {
    if (!deviceToken) return false;
    try { localStorage.removeItem('bp_devtok_' + athlete); } catch (eR) {}
    deviceToken = '';
    if (urlToken) { token = urlToken; return true; }   // caller may retry with the link token
    return false;
  }

  var app = document.getElementById('app');
  var meta = document.getElementById('meta');
  var syncEl = document.getElementById('sync');
  // CLIENT CACHE VERSION. Every cached payload is keyed by it, so a build that changes payload shape
  // ignores what the device already has instead of painting it. Without this, a server-side fix
  // reached nobody: the phone instant-paints the OLD session from localStorage and Phil sees the bug
  // he already reported, days after it was fixed. Bump this whenever the payload shape changes —
  // same discipline as sw.js's CACHE and the server's _PAYLOAD_SCHEMA_V.
  var CACHE_V = 'c8';   // R685: session payloads gained switch_s @626 with NO bump — a cached c7 session read switchS 0 and Phil's whole 08-29 session ran trailing-rest-only. (c7 was R661: merit levels.)
  // CACHE-VERSION HANDSHAKE (Phil P0 2026-08-12, the FOURTH stale-phone bite — permanent fix).
  // APP_BUILD is this bundle's stamp; the week payload carries the server's expected build
  // (pwa_ver). Mismatch => force the service worker to update and reload ONCE per version.
  // The payload fetch fires at every open — the one channel that reaches a warm-recalled
  // standalone PWA, which never cold-relaunches and so never re-checks sw.js on its own.
  var APP_BUILD = '20260905-r884days';  // R884: 📅 Fewer days now rebuilds the week (pick 0-6 → confirm → server re-lays remaining days); prev: 20260904-r704msg (Tell coach button)
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
      // R631 test seam: the localhost guard below rightly keeps harness noise out of ErrorLog, but
      // j34 must still SEE that a failure reported itself — record the attempt where a journey can read it.
      try { (window.__bpErrLog = window.__bpErrLog || []).push(kind); } catch (eSeam) {}
      if (!cfg.WEBAPP_URL || cfg.WEBAPP_URL.indexOf('REPLACE_') === 0) return;
      // A localhost app is NEVER a kid's phone (errorhygiene, 2026-08-18): the QA harness renders
      // real athletes' boards at 127.0.0.1 for screenshots, and every harness reload was landing in
      // ErrorLog under the real athlete's name — 15 rows polluting Mason's and Grace's error history
      // in one day. The harness sees its own errors in its own console; the ErrorLog is for devices.
      if (/^(127\.0\.0\.1|localhost|\[::1\])$/.test(location.hostname)) return;
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
          var tag = '';
          try { if (localStorage.getItem('bp_journey') === '1') tag = '[source=journey] '; } catch (eJ) {}   // R875: a journey's row is never a kid's
          return (tag + String(extra || '') + ctx).slice(0, 900);
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
  // j33 needs the queue's COORDINATES, not just its depth. The round Update deliberately commits
  // every row, including sets that were never logged, so a depth delta cannot tell a lawful new set
  // from the re-fire of one already committed — and the first cut of that journey read the delta and
  // called a legitimate set-4 commit a duplicate.
  try {
    window.BP_qRows = function () {
      return qAll().then(function (r) {
        return (r || []).map(function (x) {
          return { sid: x.session_id, ex: x.exercise, set: x.set_no, side: x.side,
                   load: x.actual_load, reps: x.actual_reps, flag: x.flag };
        });
      });
    };
  } catch (e) {}
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
  // R669 — which queued log_ids did the server explicitly REFUSE (L161 impossible load, D8
  // side-disagree)? `ackLogs` can only answer "present"; the POST is opaque no-cors, so a refusal
  // ack never reaches the client. Without this read-back a refused row stayed queued FOREVER —
  // retried every 15s, a permanent pending chip, sync_unconfirmed spam every 4th try.
  function refusedLogs(ids) {
    var url = cfg.WEBAPP_URL + '?action=logrefused&athlete=' + encodeURIComponent(athlete) +
      '&token=' + encodeURIComponent(token) + '&ids=' + encodeURIComponent(ids.join(','));
    return fetch(url).then(function (r) { return r.json(); })
      .then(function (d) { return (d && d.ok && d.refused) ? d.refused : []; })
      .catch(function () { return []; });
  }
  // L131 — a refused set is ANNOUNCED, never silently dropped. Fixed banner on body, not app, so a
  // screen repaint cannot tear it out; the athlete dismisses it. Plain English, no mechanism: a typo
  // is re-logged, anything else is "tell your coach" — the coach already has the ErrorLog row.
  function showRefusedCard(refused) {
    try {
      var old = document.querySelector('.refused-card'); if (old) old.remove();
      var card = el('div', 'refused-card');
      refused.slice(0, 3).forEach(function (x) {
        var who = x.ex ? ('A set of ' + x.ex) : 'A set';
        card.appendChild(el('div', 'refused-line', x.reason === 'impossible_load'
          ? who + ' couldn’t be saved — the weight looks like a typo. Log it again with the right number.'
          : who + ' couldn’t be saved. Tell your coach.'));
      });
      var ok = el('button', 'refused-ok', 'OK'); ok.type = 'button';
      ok.addEventListener('click', function () { card.remove(); });
      card.appendChild(ok);
      document.body.appendChild(card);
    } catch (e) {}
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
        // R669: before parking leftovers for the next drain, ask whether the server REFUSED any of
        // them. A refused id is EVICTED (qDel) and announced on a card; only rows neither appended
        // nor refused stay queued and report sync_unconfirmed — so one bad row can no longer hold a
        // permanent pending chip or spam the ErrorLog every 4th retry.
        function giveUp(present) {
          var left = ids.filter(function (id) { return present.indexOf(id) < 0; });
          if (!left.length) { done(); return updateBadge(); }
          return refusedLogs(left).then(function (refused) {
            var rIds = refused.map(function (x) { return x.id; });
            var park = left.filter(function (id) { return rIds.indexOf(id) < 0; });
            var fin = function () {
              if (park.length) reportError('sync_unconfirmed', 'logs sent but not confirmed by the server', '',
                'ids=' + park.length + ' queued=' + park.join(','));
              done(); return updateBadge();                                   // parked rows retry next drain
            };
            if (!rIds.length) return fin();
            return qDel(rIds).then(function () { showRefusedCard(refused); return fin(); });
          });
        }
        function confirm() {
          tries += 1;
          return ackLogs(ids).then(function (present) {
            if (present.length) {
              return qDel(present).then(function () {
                if (present.length === ids.length) { done(); return updateBadge(); }
                if (tries >= 4) return giveUp(present);
                return new Promise(function (r) { setTimeout(r, 2000); }).then(confirm);
              });
            }
            if (tries >= 4) return giveUp([]);
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
    // THE CUE IS A MEDIA ELEMENT FIRST, WEBAUDIO ONLY AS A FALLBACK — REINSTATED BY DEVICE
    // MEASUREMENT (Phil 2026-08-26, R606 slice 1 REVERT). The r606a oscillator+'transient' build was
    // measured SILENT on his real device in BOTH silent-switch states — the spec's own acceptance
    // failed, and his ruling reverted it the same morning: "the beep is the product (a kid mid-set
    // must hear the expiry, silent switch or not); interrupting music is an ACCEPTED cost, my word,
    // recorded." The 08-1x reasoning below proved itself on his phone and supersedes back. A
    // music-ducking cue gets ONE bounded offline retry later, below the fold, only if it can be
    // proven on HIS device without ever risking the beep — otherwise it dies as a nicety.
    // Two things make the cue audible, both needed:
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
          // L194 — PRIMING MUST NEVER BE AUDIBLE (Phil 2026-08-16: "It did a beep when I choose the
          // workout. Thought we got rid of that. The audio was only for the timer.") — the revert
          // KEEPS this fix, by Phil's explicit instruction ("that class must not resurrect").
          // The element STAYS MUTED here forever; `beep()` sets `muted = false` itself at the moment
          // a real cue fires — the unlock gesture is what priming is for, not sound.
          _cueEl.muted = true;
          var pr = _cueEl.play();
          var settle = function () { try { _cueEl.pause(); _cueEl.currentTime = 0; } catch (e2) {} _cuePrimed = true; };
          if (pr && pr.then) pr.then(settle, function () { _cuePrimed = true; });
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
      TBAR._s.addEventListener('click', function () {
        // R850: a running between-complex transition owns the ⏭ — ACTIVE_TIMER during a transition
        // is the FINISHED previous complex (held for its "complex done" cue), whose skip() no-ops.
        if (TRANS_SKIP) { TRANS_SKIP(); return; }
        if (ACTIVE_TIMER) ACTIVE_TIMER.skip();
      });
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

  // R606 slices 2-3 — THE WORKOUT CHAIN (Phil's corrected UI ruling 2026-08-28). One "Begin
  // Workout" tap runs the whole session unattended: each slot's own timer, then a transition
  // countdown between complexes (the R606-s5 law: gap = MAX(Thresholds complex_switch, trailing
  // rest of the outgoing complex's final set) — the trailing rest has already elapsed inside the
  // outgoing timer, so the transition adds only the EXCESS; warm-up slots never take one). Chain
  // state survives re-renders (module scope, session-checked); render() rebuilds the slot list.
  // A manual "Start Complex" mid-chain never breaks it: advance keys off whichever timer finishes
  // while the chain is on, and a manual start only cancels the pending transition it supersedes.
  var CHAIN = { on: false, sid: null, list: [], switchS: 0, transT: null };
  // R850 (Phil 2026-09-03, Grace 09-02): EVERY TRANSITION IS SKIPPABLE — the 2:30 between-complex
  // countdown fired correctly but could not be skipped to keep moving (the bar's ⏭ was wired only
  // to ACTIVE_TIMER, which during a transition is the FINISHED previous timer whose skip() no-ops).
  // TRANS_SKIP is the transition's own skip hook: armed while a transition counts, cleared with it.
  var TRANS_SKIP = null;
  function chainCancelTransition() { if (CHAIN.transT) { clearTimeout(CHAIN.transT); CHAIN.transT = null; } TRANS_SKIP = null; }
  function chainStop() { CHAIN.on = false; chainCancelTransition(); releaseWake(); chainForget(); }
  // R685 (Phil's 2026-08-29 session): CHAIN.on was in-memory only, so an iOS memory-kill reload
  // silently ended the chain and every gap became trailing-rest-only with no tell. The running
  // chain now persists (localStorage — sessionStorage dies with the killed process, the exact
  // event this survives) and render() re-adopts it for the same session within 3 hours. Only the
  // ON/OFF state persists: the running slot timer is honestly gone after a reload; the athlete
  // restarts the current complex and every advance chains again from there.
  var CHAIN_PERSIST_MS = 3 * 60 * 60 * 1000;
  function chainRemember() { try { localStorage.setItem('bp_chain_on', CHAIN.sid + '|' + Date.now()); } catch (e) {} }
  function chainForget() { try { localStorage.removeItem('bp_chain_on'); } catch (e) {} }
  function chainRecall(sid) {
    try {
      var v = localStorage.getItem('bp_chain_on'); if (!v) return false;
      var p = v.split('|');
      if (p[0] !== String(sid)) return false;
      if (Date.now() - Number(p[1] || 0) > CHAIN_PERSIST_MS) { chainForget(); return false; }
      return true;
    } catch (e) { return false; }
  }
  // Screen Wake Lock while the chain runs: an unattended chain on a locked phone would suspend its
  // timers (they self-correct on wake — st.end is wall-clock — but the cue would fire late, which
  // is the one thing a rest timer must not do). Progressive: absent API = silently none.
  var WAKE = null;
  function requestWake() { try { if (navigator.wakeLock && !WAKE) navigator.wakeLock.request('screen').then(function (w) { WAKE = w; w.addEventListener('release', function () { WAKE = null; }); }).catch(function () {}); } catch (e) {} }
  function releaseWake() { try { if (WAKE) { WAKE.release().catch(function () {}); WAKE = null; } } catch (e) {} }
  document.addEventListener('visibilitychange', function () { if (!document.hidden && CHAIN.on) requestWake(); });
  function chainTransition(gapS, next) {
    chainCancelTransition();
    var end = Date.now() + gapS * 1000;
    // R850: arm the skip AFTER the cancel above (which clears any prior hook). Skipping cancels the
    // pending tick first, so the transition can never re-fire behind the started block.
    TRANS_SKIP = function () {
      if (!CHAIN.transT) return;                     // stale hook (superseded/stopped): never double-start
      chainCancelTransition();
      beep(); timerAlert('Next complex', 'go', '', true);
      next.start();
    };
    (function tickT() {
      if (!CHAIN.on) { TRANS_SKIP = null; return; }
      var left = Math.max(0, Math.round((end - Date.now()) / 1000));
      var b = tbar(); b.hidden = false; document.body.classList.add('has-tbar');
      b._l.textContent = 'Next complex'; b._v.textContent = 'in ' + fmt(left); b._p.hidden = true;
      b._s.hidden = false;                           // R850: the same ⏭ affordance the rest timer has
      if (left <= 0) { CHAIN.transT = null; TRANS_SKIP = null; beep(); timerAlert('Next complex', 'go', '', true); next.start(); return; }
      CHAIN.transT = setTimeout(tickT, 250);
    })();
  }
  function chainAdvance(key) {
    if (!CHAIN.on) return;
    if (!SESSION || CHAIN.sid !== (SESSION.session_id || SESSION.date)) return;
    var i = -1;
    for (var x = 0; x < CHAIN.list.length; x++) if (CHAIN.list[x].key === key) { i = x; break; }
    if (i < 0) return;                                            // a timer outside the chain's list
    var next = CHAIN.list[i + 1];
    if (!next) { chainStop(); timerAlert('Workout done', 'all complexes run', '', true); return; }
    // L301 (Phil 2026-08-29): the transition is the FULL complex_switch_min cell, ADDED per
    // boundary — the excess-over-trailing reading is DEAD (the server's own reversing-line note
    // names the old expression here as the thing that must never return). L311 (Phil 2026-08-30,
    // "5 blocks = 4 transitions"): every rendered block takes one, warm-up blocks included — the
    // isComp gate was the same dead 08-28 reading. Phil's 08-31 session convicted all three faces
    // live: WUp1→Comp1 nothing, Comp1→Comp2 15s (150−135 excess), Comp2→Comp3 nothing (150−150).
    var gap = (CHAIN.switchS || 0);

    if (gap > 0) chainTransition(gap, next); else next.start();
  }
  function makeTimer(node, pauseBtn, intervals, label, roundsOf, key) {
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
          if (typeof chainAdvance === 'function') chainAdvance(key);   // R606: the chain rolls on
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
        if (typeof chainAdvance === 'function') chainAdvance(key);   // R606: a skipped-out complex still chains
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
      // R589 — WHICH SLOT THIS TIMER BELONGS TO, so a re-render can find it again. The label is not
      // an identity: complexes are RENUMBERED as the athlete meets them (:2386), so "Complex 2" can
      // name a different slot after a re-lay. The Plan's own slot id is stable.
      key: function () { return key; },
      // R589 — A RE-RENDER MUST RE-ADOPT THIS TIMER, NOT ORPHAN IT. render() rebuilds every slot
      // header on every post-log refresh while clearTimerBar deliberately keeps a running timer
      // alive (:533) — so the live countdown kept counting into a DETACHED node and the very same
      // complex re-offered "Begin complex". One tap and the athlete was back at SET 1 with her place
      // gone. Phil, watching Grace 2026-08-25: "forward tap killed the running complex timer."
      // Adoption rebinds the two nodes this closure paints and leaves seq/idx/end untouched — the
      // countdown never restarts, because nothing about the COUNT is rebuilt.
      adopt: function (newNode, newPause) {
        node = newNode; pauseBtn = newPause;
        newPause.addEventListener('click', toggle);
        newPause.hidden = !st.running;
        newPause.textContent = st.paused ? '▶' : '⏸';
        // Paint the state NOW rather than waiting up to 250ms for the next tick: a header that reads
        // blank after every logged set is the same "did my timer die?" the orphan itself caused.
        if (st.paused) node.textContent = 'paused ' + fmt(st.rem);
        else if (st.running) node.textContent = 'next ' + fmt(Math.max(0, Math.round((st.end - Date.now()) / 1000)));
        pub(node.textContent);
        return api;
      },
      stop: function () { clearTimeout(st.t); st.t = null; st.running = false; st.paused = false; node.textContent = ''; pauseBtn.hidden = true; },
      start: function () {
        if (st.running) return;
        // one timer at a time — this is what lets the pinned bar be unambiguous
        if (ACTIVE_TIMER && ACTIVE_TIMER !== api) ACTIVE_TIMER.stop();
        cancelUnpub();                     // a restart cancels any pending "give the space back"
        // R606: a manual start supersedes any pending between-complex transition — the chain then
        // continues from THIS slot (advance keys off whichever timer finishes), never broken.
        if (typeof chainCancelTransition === 'function') chainCancelTransition();
        if (typeof CHAIN === 'object' && CHAIN.on) requestWake();
        ACTIVE_TIMER = api; TIMER_SID = SESSION && (SESSION.session_id || SESSION.date);
        primeAudio(); st.running = true; st.end = Date.now() + interval * 1000; pauseBtn.hidden = false; tick();
      }
    };
    return api;
  }
  // R589 — ONE PREDICATE for "is this slot's timer already counting?", called by the render path and
  // driven verbatim by its check (`qa/harness/complex-timer.mjs`). A caller that re-derives the rule
  // drifts from the test that proves it — that is the marker-vocabulary lesson (five readers, five
  // hand-rolled lists) applied at birth instead of learned again.
  // BOTH clauses are load-bearing: the slot key alone would re-adopt a timer belonging to a DIFFERENT
  // session (clearTimerBar only spares the timer when the session matches, :533), and the session
  // alone would hand complex 3's header the countdown running in complex 2.
  function liveTimerFor(key, sid) {
    if (!ACTIVE_TIMER || !ACTIVE_TIMER.running()) return null;
    if (!ACTIVE_TIMER.key || ACTIVE_TIMER.key() !== key) return null;
    if (!TIMER_SID || TIMER_SID !== sid) return null;
    return ACTIVE_TIMER;
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
      // U6/L171 (Mason 2026-08-15, "spurious beep"): the beep used to sit OUTSIDE this guard, so the
      // banner obeyed the rule above and the SOUND did not — an early stop chimed on the athlete's own
      // tap. Sound and banner now answer to the same condition.
      if (held >= secs) { beep(); timerAlert('Done', 'hold complete'); }
      done(held);
    }
    function stopEarly(ev) { ev.stopPropagation(); finish(); }
    btn.addEventListener('click', stopEarly);
  }

  function mkLog(slot, exName, t, state, variant) {   // exName may be a swapped-in alternate; variant = the SERVED variant (blank for swaps — D-P3 stamp)
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
        actual_load: state.load, actual_reps: state.reps, flag: 'recovered', variant_name: variant || '' };
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
      actual_load: state.load, actual_reps: state.reps, flag: '', variant_name: variant || '' };
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
  // R375 (Phil's pick (a), 2026-08-19): a workout's NAME is its first two anchor lifts — "Deadlift +
  // Bench" — never two tiles both reading "Full Body" (Mason started the wrong one on 8/18 because
  // the names couldn't tell him apart). top_ex is the server's A-sides of the first complexes; the
  // friendly theme name is the fallback when anchors are unknown (held previews).
  function woTitle(s) {
    if (s && s.top_ex && s.top_ex.length) return s.top_ex.slice(0, 2).map(titleName).join(' + ');
    return titlePhrase((s && (s.name || s.theme)) || 'session');
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
  // R563 (Phil 2026-08-25): `setNo` scopes the skip to ONE exercise in ONE set — "if you skip one
  // exercise in set 1, that exercise is not automatically skipped in set 2". Passing setNo === null
  // keeps the old whole-exercise sweep, which is what a LEGACY blank-set marker still means.
  function skipRows(exName, setNo) {
    return (ROW_REG[exName] || []).filter(function (en) {
      return setNo == null || String(en.t && en.t.set_no) === String(setNo);
    });
  }
  // THE ONE TAPPABLE SKIP LABEL. Both paths that can render a skipped row use this — the live tap
  // AND the reload render — because until R563 the reload path appended a PLAIN label with no
  // handler, so after a refresh the row said "tap to undo" and nothing happened. That is the second
  // half of Phil's complaint, reported twice ("could not unskip which is needed" 08-17; "it was very
  // hard to find a way to un-skip it" 08-19) and never actually fixed on the reload path.
  function attachSkipLabel(row, exName, reason, slot, setNo) {
    if (row.querySelector('.skiplab')) return;
    var words = (reason === 'coach' || reason === 'coach said to') ? 'coach said to'
              : (reason === 'pain') ? 'pain'
              : (reason === 'mine') ? 'your choice' : reason;
    var lab = el('div', 'skiplab', 'skipped — ' + words + ' · tap to undo');
    // UNSKIP (Phil 2026-08-17 URGENT: a stray skip killed his whole complex's logging with no way
    // back). Tapping the label appends an uncheck marker at the skip's OWN coordinates (the R016
    // void, same law) and re-arms exactly the rows that skip covered.
    lab.addEventListener('click', function (ev) {
      ev.stopPropagation();
      var uSid2 = SESSION ? SESSION.session_id : '';
      if (!uSid2) { try { uSid2 = sessionStorage.getItem('bp_open_session') || ''; } catch (eU2) {} }
      if (uSid2) {
        // The void must land on the SKIP'S OWN coordinates or it voids nothing: the server matches
        // uncheck to skip on (exercise, session, set_no, side), so a per-set skip needs a per-set
        // uncheck. Legacy blank-set skips keep voiding with a blank set_no, same as before.
        logRows([{ log_id: uuid(), session_id: uSid2, complex_name: (slot && slot.complex_name) || '',
          exercise: exName, set_no: (setNo == null ? '' : setNo), side: '', target_load: '', target_reps: '',
          actual_load: '', actual_reps: '', flag: 'uncheck', variant_name: '' }]);
      }
      skipRows(exName, setNo).forEach(function (en2) {
        en2.row.classList.remove('skipped');
        var l2 = en2.row.querySelector('.skiplab'); if (l2) l2.remove();
      });
      if (!skipRows(exName, setNo).length) {   // reload render: the row may not be in ROW_REG yet
        row.classList.remove('skipped');
        var lSelf = row.querySelector('.skiplab'); if (lSelf) lSelf.remove();
      }
      refocus();
    });
    row.appendChild(lab);
  }
  function markRowsSkipped(exName, reason, slot, setNo) {
    skipRows(exName, setNo).forEach(function (en) {
      en.row.classList.add('skipped');
      attachSkipLabel(en.row, exName, reason, slot, setNo);
    });
  }
  function postSkip(slot, exName, reason, setNo) {
    var marker = { log_id: uuid(), session_id: SESSION ? SESSION.session_id : '', complex_name: slot.complex_name,
      exercise: exName, set_no: (setNo == null ? '' : setNo), side: '', target_load: '', target_reps: '',
      actual_load: '', actual_reps: '', flag: 'skip:' + reason };
    qAdd(marker).then(function () { drain(); }).catch(function () {});
    markRowsSkipped(exName, reason, slot, setNo);
  }
  function toggleSkip(row, ex, slot, setNo) {
    var old = row.querySelector('.skip-panel');
    if (old) { old.remove(); return; }
    var p = el('div', 'skip-panel');
    p.appendChild(el('div', 'skip-h', 'Skip — why?'));
    [['coach', 'Coach said to'], ['mine', 'My choice'], ['pain', 'Pain 🚩']].forEach(function (o) {
      var b = el('button', 'skip-opt' + (o[0] === 'pain' ? ' pain' : '')); b.type = 'button'; b.textContent = o[1];
      // R632 (Grace 2026-08-26, the FOURTH skip report): the skip's identity is the PRESCRIBED
      // exercise, always. A swapped row's `ex` is the alternate; skipping under ITS name missed
      // ROW_REG (keyed by original — nothing grayed, the tap looked dead) and wrote a marker the
      // payload's skipped_sets (keyed by prescribed name) could never match, so the skip vanished
      // on every reload. Her 02:18Z uncheck/skip thrash is this exact seam.
      b.addEventListener('click', function () { p.remove(); postSkip(slot, (ex._alt_of || ex).exercise, o[0], setNo); });
      p.appendChild(b);
    });
    // The whole-complex skip button is GONE (Phil 2026-08-17 URGENT, after it ate his Bent Row +
    // Front Press logging: "skip is by exercise, not by set and certainly not by whole complex").
    // R563 (2026-08-25) then defined the unit he meant all along: ONE exercise in ONE set. Skipping
    // Bent Row in set 1 leaves Front Press in set 1 alone AND leaves Bent Row's set 2 serving. All
    // three of his reports describe the same trigger — a skip tapped on one row eating more than it.
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
    // R618 CLOSED AS NOT-A-DEFECT (2026-08-26): this function is DEAD since 5ff164f ("reverse
    // S17") — LEG_REG is never seeded, so no legend ever renders and this gate can hide nothing
    // from an athlete. Left as-is for the R529 dead-code sweep; the live law (every rendered
    // exercise row carries ⇄) is pinned by swap.mjs arm 4.
    if ((ex.alternates && ex.alternates.length) || ex._alt_of) {
      var sw = el('button', 'swapbtn'); sw.type = 'button'; sw.innerHTML = '⇄ Swap';
      sw.addEventListener('click', function () { toggleSwap(lr, ex); });
      lr.appendChild(sw);
    }
    return lr;
  }
  // ONE-LINE COACH NOTE (#35), under the exercise name and only on its FIRST row (SHOWN_NOTE guards
  // it, since an exercise repeats across set-rounds). Phil types it in the Exercise Videos `note`
  // column; it WRAPS and never clips (L40 / PRINCIPLES #3 — the ellipsis clamp this comment used to
  // describe was removed, and j29 reds if it ever returns). Empty note or already-shown -> nothing.
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
  // R686 (Phil's Band Walks -> 90-90 SW swap, 2026-08-29): does this alternate arrive with NO rep
  // prescription of its own? swapTarget's blank-reps branch falls back to the OUTGOING lift's reps
  // (his 90-90 SW field read Band Walks' 15 against its own 5) — his law: a swap inherits the
  // INCOMING exercise's full prescription. When this is true, the tap handler asks exscheme for the
  // athlete's real prescription and reconciles, exactly like the searched path. Pure for the harness.
  function altNeedsScheme(a) {
    if (!a || a.main || altIsSame(a) || isMaxVal(a.reps)) return false;
    if (a.duration_s != null) return false;                       // duration IS the prescription (L39)
    return a.reps === '' || a.reps == null || isNaN(a.reps);
  }
  function swapTarget(a, oEx, oT) {
    if (a.main) return { ex: oEx, t: oT };
    var same = altIsSame(a);
    // A "max" alternate (Alternates `reps` = max) must carry 'max' THROUGH the swap. The old code ran
    // isNaN('max') -> numReps null -> target_reps fell back to the ORIGINAL exercise's reps, which is
    // Phil's "single-leg calf raise bodyweight gave me 10 reps instead of max" (#29).
    var altMax = isMaxVal(a.reps);
    var numReps = (!altMax && a.reps !== '' && a.reps != null && !isNaN(a.reps)) ? Number(a.reps) : null;
    // R687 PREVENTION (Phil's 08-23 variant-identity law; the 08-24 mislabel forensics): a swap to
    // a sibling VARIANT restamps variant_name and keeps the ROOT as the exercise identity — never
    // forking the variant into a new exercise name, which orphans its history/PRs from the variant
    // grain AND its sets from the parent's weekly-cap fold. The search payload carries `root` for
    // Exercise Videos variants only; alternates (genuinely different movements) have none and keep
    // their own name with the blank variant stamp (the D-P3 rule, unchanged for them).
    var vRoot = String(a.root || '').trim();
    var isVariant = !!(vRoot && vRoot.toLowerCase() !== String(a.name || '').trim().toLowerCase());
    return {
      ex: { exercise: isVariant ? vRoot : a.name, display_name: a.name, athlete_name: a.name,
        variant_name: isVariant ? a.name : '',
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
        // D8: the alternate's OWN sidedness wins when the payload states it (the server stamps
        // each_side on searched swaps and, since @625, on slot alternates with an exact Exercise
        // Library row). Inheriting the original's flag split a bilateral swap-in into phantom L/R
        // rows and logged a two-sided swap-in as ONE row — half its evidence.
        rest_s: oEx.rest_s, each_side: (a.each_side != null ? !!a.each_side : oEx.each_side),
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
  // THE SWAP RECORD (R533, Phil 2026-08-24 verbatim): "swaps must leave a server-side event — who,
  // when, from→to; 'swaps leave none by design' is the gap that made the dips dispute possible; the
  // eyewitness must never be the only record." Grace's Assisted Dips dispute was unresolvable
  // precisely because nothing on the server knew a swap had happened — the only account was Phil's
  // memory of watching her. This rides the same durable IndexedDB queue as sets and skips, so it
  // survives offline exactly as a logged set does, and it is a MARKER row (blank actuals, flag
  // `swap:<from> -> <to>`) so `_isMarkerFlag_` keeps it out of evidence at every reader.
  function postSwapEvent(slot, fromEx, toEx) {
    if (!fromEx || !toEx || fromEx === toEx) return;          // a no-op swap is not an event
    var sid = SESSION ? SESSION.session_id : '';
    if (!sid) { try { sid = sessionStorage.getItem('bp_open_session') || ''; } catch (eS) {} }
    if (!sid) return;
    try {
      qAdd({ log_id: uuid(), session_id: sid, complex_name: (slot && slot.complex_name) || '',
        exercise: fromEx, set_no: '', side: '', target_load: '', target_reps: '',
        actual_load: '', actual_reps: '', flag: 'swap:' + fromEx + ' -> ' + toEx, variant_name: '' })
        .then(function () { drain(); }).catch(function () {});
    } catch (eQ) {}
  }
  function applySwapAll(key, a) {
    try { setTimeout(function () { document.querySelectorAll('.round').forEach(function (rb) { syncRound(rb); }); }, 400); } catch (eSR) {}
    var entries = (ROW_REG[key] || []).slice();
    try {
      var e0 = entries[0];
      if (e0) {
        // FROM is what is on screen NOW, not the prescribed original — otherwise a revert
        // ("Keep original") reads from==to and no event is written, losing exactly the half of the
        // record that says an athlete changed their mind back.
        var fromN = e0.ex.exercise;
        var toN = (a && a.main) ? ((e0.ex._alt_of || e0.ex).exercise) : (a && (a.name || a.exercise));
        postSwapEvent(e0.slot, fromN, toN || '');
      }
    } catch (eSw) {}
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
    // R584 — THE LOAD CARRIES ITS UNIT, per DESIGN.md rule 3's own vocabulary ("Log Set 5 · 105 lb ×
    // 4"): load first WITH "lb", reps after the ×. The bare "5×15" chip was read right-to-left by the
    // coach as "15 lbs" on Grace's Side Raise (she lifts 5 per hand) — a number with no unit invites
    // whichever convention the reader brings, and Everfit's was reps×weight. Bodyweight sets keep the
    // bare rep count; that is the established convention everywhere else on the profile.
    if (s.load != null && s.load !== '') return s.load + ' lb × ' + (s.reps != null ? s.reps : '—');
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
    var body = el('div', 'hist-body');
    panel.appendChild(body);
    row.appendChild(panel);
    // BY DATE (Phil, 2026-07-25): a row per day — the date on the left, then that day's sets in
    // order. No source tag; the date carries recency. Set counts vary because his Everfit logging
    // did (some days he did not log every set) — Phil accepts that; Blueprint days are consistent.
    // Nothing here is bold — history is reference; the only bold on screen is what he logs today.
    function paint(days) {
      body.innerHTML = '';
      // VARIANT GRAIN (Phil 2026-08-23, his 12" Box Cossack): variants are different exercises, so
      // the panel shows the SERVED variant's own days — a day labeled with a different variant is
      // another exercise's history (his 18" days rendered under a "12"" header he had never done).
      // Unlabeled legacy days (pre-variant logging) stay visible for any variant.
      var vGrain = String(ex.variant_name || '').trim().toLowerCase();
      if (vGrain) days = days.filter(function (day) {
        // STRICT (Phil 2026-08-23 L124 proof): "if my one real 12\" session is all that exists,
        // one row is the correct render" — unlabeled legacy days are nobody's history.
        var dv = String(day.variant || '').trim().toLowerCase();
        return dv === vGrain;
      });
      if (!days.length) { body.appendChild(el('div', 'hist-note', 'No history yet — first time.')); return; }
      days.forEach(function (day) {
        var line = el('div', 'hist-row');
        line.appendChild(el('span', 'hist-date', fmtHistDate(day.date)));
        var sets = el('div', 'hist-sets');
        (day.sets || []).forEach(function (s) { sets.appendChild(el('span', 'hist-set', fmtHistSet(s))); });
        line.appendChild(sets);
        body.appendChild(line);
      });
    }
    // U4(a) — THE PANEL OPENS FROM LOCAL STATE, AT 0s (Phil 2026-08-15 ruling). The session payload
    // now carries `history` keyed by exercise (server-side L186), so the most-used feature in the app
    // costs no round trip at all mid-set. The fetch below is the FALLBACK, not the path: it runs for a
    // swapped-in alternate, for a bundle the server time-boxed, and for an older build's payload.
    var local = SESSION && SESSION.history && SESSION.history[ex.exercise];
    if (local) { paint(local); return; }
    body.appendChild(el('div', 'hist-note', 'Loading…'));
    // F1(a) — RETRY, AND AN HONEST FAILURE THE ATHLETE CAN ACT ON. This was a bare `fetch` whose only
    // catch said "Could not load history." — no retry, no distinction between a throttled Apps Script
    // (an HTML error page, which r.json() throws on) and being genuinely offline, and nothing to tap.
    // Phil and Grace both hit it and force-closed the app for what was a hiccup. `fetchJson` already
    // rides out the hiccup with two retries and classifies the failure; the panel now uses it and
    // offers the tap, exactly as the profile detail panel has since 2026-08-05.
    fetchJson(cfg.WEBAPP_URL + '?action=history&athlete=' + encodeURIComponent(athlete) +
              '&token=' + encodeURIComponent(token) + '&exercise=' + encodeURIComponent(ex.exercise))
      .then(function (d) {
        if (d && d.ok && d.days) { paint(d.days); return; }
        body.innerHTML = '';
        body.appendChild(el('div', 'hist-note', (d && d.error === 'server') ? SERVER_HICCUP : 'Offline — reconnect to see history.'));
        var again = el('button', 'hist-retry', 'Try again'); again.type = 'button';
        again.addEventListener('click', function (evt) {
          evt.stopPropagation();
          panel.remove();            // toggleHistory rebuilds the panel from scratch — one code path, not two
          toggleHistory(row, ex);
        });
        body.appendChild(again);
      });
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
      b.addEventListener('click', function () {
        applySwapAll(origEx.exercise, a);
        // R686: a curated alternate with a blank reps cell applies instantly (above) but must not
        // STAY on the outgoing lift's reps — fetch the incoming lift's own prescription and
        // reconcile untouched rows, the searched path's proven pattern (R633/R634).
        if (altNeedsScheme(a)) {
          fetch(cfg.WEBAPP_URL + '?action=exscheme&athlete=' + encodeURIComponent(athlete) +
                '&token=' + encodeURIComponent(token) + '&exercise=' + encodeURIComponent(a.name) + '&sets=3')
            .then(function (r) { return r.json(); })
            .then(function (d) {
              if (!d || !d.ok || d.reps == null) return;          // nothing better than what stands
              var ents = ROW_REG[origEx.exercise] || [];
              var touched = ents.some(function (en) {
                return en.row.classList.contains('done') || en.row.querySelector('.stepper.confirmed');
              });
              if (touched) return;                                // the athlete's screen wins (R533)
              applySwapAll(origEx.exercise, {
                name: a.name, video_url: a.video_url || '', note: a.note || '', reason: a.reason,
                best_reps: (d.best_reps != null ? d.best_reps : a.best_reps),
                reps: d.reps,
                wants_load: (a.wants_load === true) || !!d.wants_load,
                prefill_load: (d.load != null ? d.load : (a.prefill_load != null ? a.prefill_load : null)),
                level_goal: null,                                 // "no alternates have level goal" (Phil 2026-07-28)
                duration_s: (d.duration_s != null ? d.duration_s : null),
                each_side: a.each_side
              });
            })
            .catch(function () {});
        }
      });
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
          var fallback = { name: x.exercise, root: x.root || '', video_url: x.video_url || '', reps: x.default_reps,
                           wants_load: x.wants_load === true, reason: 'searched' };
          // R633 (Grace's ~15s dips swap, on a cold just-deployed backend): the swap applies NOW,
          // from the library row the panel already holds — in-workout actions are <2s perceived.
          // The exscheme answer (the athlete's real prescription, 5-13s cold) RECONCILES the rows
          // in the background, and only while they are untouched: once a set is logged or a
          // stepper confirmed, the athlete's screen wins (the R533 mid-set discipline).
          applySwapAll(origEx.exercise, fallback);
          fetch(cfg.WEBAPP_URL + '?action=exscheme&athlete=' + encodeURIComponent(athlete) +
                '&token=' + encodeURIComponent(token) + '&exercise=' + encodeURIComponent(x.exercise) + '&sets=3')
            .then(function (r) { return r.json(); })
            .then(function (d) {
              if (!d || !d.ok) return;                       // the fallback already serves
              var ents = ROW_REG[origEx.exercise] || [];
              var touched = ents.some(function (en) {
                return en.row.classList.contains('done') || en.row.querySelector('.stepper.confirmed');
              });
              if (touched) return;
              applySwapAll(origEx.exercise, {
                name: x.exercise, root: x.root || '', video_url: x.video_url || '', reason: 'searched',
                best_reps: (d.best_reps != null ? d.best_reps : null),   // R634: the athlete's own variant basis rides the swap
                reps: (d.reps != null ? d.reps : x.default_reps),
                wants_load: (x.wants_load === true) || !!d.wants_load,   // weighted column OR Level Standards
                prefill_load: (d.load != null ? d.load : null),
                level_goal: d.level_goal || null,
                duration_s: (d.duration_s != null ? d.duration_s : null)
              });
            })
            .catch(function () {});
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
  // `silent` = this phase begins on the athlete's own tap, so the tap IS the cue (U6/L171). Every
  // LATER phase flip is a real expiry and still sounds — that is the half you cannot watch a button for.
  function cuePhase(p, silent) {
    if (!silent) beep();
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
    cuePhase(seq[0].p, true);                              // banner only — the starting tap already told them (L171)
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
      var l = mkLog(slot, ex.exercise, t, { load: '', reps: doneReps }, ex.variant_name);
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
    if (Number(t.set_no) > 1) row.classList.add('set-n');   // R638-2: lets CSS scope icon labels to set 1
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
    // R638-2 (Phil 2026-08-27): the icons carry small TEXT LABELS. His eyewitness rejected the old
    // "no room" claim — correctly: that claim was reasoned from layout code and never rendered
    // (L292 now makes that class unlawful — feasibility claims need a rendered screenshot).
    var sw = el('button', 'swapbtn'); sw.type = 'button'; sw.innerHTML = '⇄';
    sw.title = 'Change exercise';
    sw.appendChild(el('span', 'btn-lbl', 'Swap'));
    sw.addEventListener('click', function () { toggleSwap(row, ex); });
    l1.appendChild(sw);
    // HISTORY — "what did I do last time?" the most-used Everfit feature (Phil 2026-07-25). Beside the
    // swap icon; taps open a panel of past days (Blueprint sessions + Everfit legacy).
    var hb = el('button', 'histbtn'); hb.type = 'button'; hb.innerHTML = '🕐';
    hb.title = 'History — what you did last time';
    hb.appendChild(el('span', 'btn-lbl', 'History'));
    hb.addEventListener('click', function () { toggleHistory(row, ex); });
    l1.appendChild(hb);
    // SKIP (L162) — beside history, same idiom as swap: acts on the exercise, lives with its name.
    var skb = el('button', 'skipbtn'); skb.type = 'button'; skb.innerHTML = '⏭';
    skb.title = 'Skip this set';
    skb.appendChild(el('span', 'btn-lbl', 'Skip'));
    skb.addEventListener('click', function () { toggleSkip(row, ex, slot, t.set_no); });
    l1.appendChild(skb);
    row.appendChild(l1);   // the ✓ is appended to l1 further down, once it exists
    // R563: this row is skipped if THIS SET carries a skip marker, or if a LEGACY blank-set marker
    // skipped the whole exercise before the per-set law existed.
    // R632: read the skip state from the PRESCRIBED exercise — a swapped row's `ex` is the
    // alternate, whose object never carries the payload's skipped/skipped_sets.
    var skBase = ex._alt_of || ex;
    var skReason = (skBase.skipped_sets && skBase.skipped_sets[String(t.set_no)]) || skBase.skipped;
    if (skReason) {
      row.classList.add('skipped');
      // A LEGACY whole-exercise skip voids with a blank set_no; a per-set skip voids at its own set.
      attachSkipLabel(row, skBase.exercise, skReason, slot,
                      (skBase.skipped_sets && skBase.skipped_sets[String(t.set_no)]) ? t.set_no : null);
    }
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
    // R533 — A SET THIS DEVICE ALREADY LOGGED MUST NOT RE-RENDER SHOWING THE PRESCRIPTION.
    //
    // The restore above only works when the SERVER already holds the row (`ex.logged`). Log a set
    // OFFLINE and the queue has not drained, so `ex.logged` is empty: `wasLogged` still goes true via
    // LOCAL_DONE and the row correctly reads done — but `state` was never restored, so it is still
    // sitting at `t.target_reps` from :1658. The round's Update button then re-commits EVERY row when
    // none are pending (:2395, deliberately, so a mis-entered set can be corrected), and what it
    // commits for that row is THE PRESCRIPTION. A fresh log_id rides it, the signature differs from
    // the real one so the R381 guard lawfully lets it through, and it lands LATER — so L167's
    // latest-per-set collapse serves the target instead of the athlete.
    //
    // MEASURED, not theorised (2026-08-24, demo_targetEcho @530 over all five athletes): 12 set
    // coordinates are serving an echo right now. Grace's 08-22 'Assisted Dips 40 lb' set 2 is Phil's
    // — he watched 3x12, the sheet holds x12 beside x4, and the Coach View reads 4. Her whole session
    // drained in one 24ms burst, i.e. she was offline throughout, which is exactly the state this
    // hole needs. Mason's RDL 85x5 serves as its 80x5 target; his Step Down 55x8 as 50x8.
    //
    // COMMIT_SIG already holds what this device last committed for this set, in this shape, in
    // sessionStorage (R381's durable half) — the value was there all along and nothing read it back.
    // Seeded ONLY where the server has no answer, so a genuine server correction still wins, and a
    // never-committed row is untouched: an unlogged set must keep showing its prescription.
    if (wasLogged) {
      var _sk = doneKey(SESSION && SESSION.session_id, slot, cur.exercise, t.set_no);
      var _cs = COMMIT_SIG[_sk];
      if (_cs != null) {
        var _p = String(_cs).split('|');
        if ((!lgd || lgd.load === '' || lgd.load == null) && _p[0] !== '' && _p[0] !== 'undefined') state.load = isNaN(Number(_p[0])) ? _p[0] : Number(_p[0]);
        if ((!lgd || lgd.reps === '' || lgd.reps == null) && _p[1] !== '' && _p[1] !== 'undefined') state.reps = isNaN(Number(_p[1])) ? _p[1] : Number(_p[1]);
      }
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
    // L181 — A WEIGHT FIELD CAN NEVER BLOCK LOGGING (Phil 2026-08-15, mid-workout).
    // "90-90 Switch Weighted" serves wants_load:true with NO prescribed load and NO prefill, so it
    // rendered an empty weight field; the round button then refused the whole round (:2193) and its
    // Comp3 partner Roller Leg Curl — an unweighted lift, `weighted` cell AY22 correctly BLANK —
    // could not be logged either. Phil read the demand as coming from the lift he was trying to log,
    // because the button names the first unconfirmed row's need (:1914).
    // The law: zero or blank load is a REAL answer (an unweighted movement, or a set carrying no
    // added weight). Only REPS may ever block — a set of zero reps is not evidence (rule 40), while
    // a set at zero load is an ordinary bodyweight set. "A kid unable to log is the worst class we
    // have." Guarded by j28.
    row._blocks = (critical === 'reps');
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
    var lastSig = null;   // L167 writer guard: what this row last appended, so an identical re-fire is a no-op
    function commit(heldS) {   // checking = "already did it" — the timer is its own Start button, not tied to this
      // R381 — THE WRITER GUARD USED TO DIE WITH THE RENDER. `lastSig` is a per-row CLOSURE, so every
      // re-render (back to the calendar and reopen, a swap, a session refresh) rebuilt the rows with
      // lastSig = null and re-armed a re-commit that changes nothing. Reproduced deterministically in
      // qa/harness/dup-logid.mjs: log a round, leave and reopen the session, tap Update — 2 queued rows
      // become 4 under FRESH log_ids for the SAME 2 set-keys, inside ONE undrained batch. That is the
      // exact shape of Grace's 08-15 18:08:49 batch (10 dup keys, incl. a conflicting 45-vs-50) and
      // Mason's 08-18 identical batches 45s apart. Idempotency (hard rule 4) is keyed on log_id and
      // structurally cannot collapse them, so the guard is the only thing standing here.
      // The remembered signature now lives per SET-KEY, in the same shape the server buckets sets by
      // (`demo_setDupes`, LoggerApi.gs — session · exercise · set · side), and survives a reload of the
      // same tab. A CORRECTION still appends: only a byte-identical re-fire is dropped. That direction
      // is deliberate (rule 40) — an extra append is lawful debris, a suppressed correction is lost work.
      var sigK = doneKey(SESSION && SESSION.session_id, slot, cur.exercise, t.set_no);
      if (lastSig === null && COMMIT_SIG[sigK] != null) lastSig = COMMIT_SIG[sigK];
      // L167 — NO PHANTOM APPENDS (Phil 2026-08-15, rider 2). The round Log button re-commits EVERY
      // row when none are pending (:2192) so an "Update" can correct a mis-entered set — legitimate.
      // But nothing stopped a re-fire that changes NOTHING from appending another row, and each one
      // carries a fresh log_id so idempotency (hard rule 4) cannot collapse it. Mason's 08-13 session
      // took 48 rows for 26 sets that way, and a burst inside ONE second wrote 55x10 then 55x0 twice
      // for a set he had performed. A correction still appends — an identical re-commit does not.
      var sig = String(state.load) + '|' + String(state.reps) + '|' + (isDur ? String(heldS == null ? '' : heldS) : '');
      if (lastSig !== null && sig === lastSig) { row.classList.add('done'); check.classList.add('done'); check.textContent = '✓'; return; }
      var log = mkLog(slot, cur.exercise, t, state, (cur.exercise === ex.exercise ? ex.variant_name : ''));
      // mkLog returns null once the athlete has left the workout (SESSION is gone). A timed hold can
      // finish AFTER that — the whole reason the guard exists — so every caller has to check, not just
      // logRows. Dereferencing it threw here and took the rest of the commit with it.
      if (!log) return;
      // Log what was actually HELD, not what was prescribed — a carry stopped at 40s is a 40s carry.
      if (isDur) log.duration_s = (heldS != null && heldS > 0) ? heldS : t.duration_s;
      if (isDur && arguments.length > 1 && arguments[1] != null && arguments[1] > 0) log.duration_s2 = arguments[1];
      lastLogId = log.log_id;
      lastSig = sig;
      COMMIT_SIG[sigK] = sig; saveCommitSig();   // R381: outlives this render
      LOCAL_DONE[doneKey(SESSION && SESSION.session_id, slot, cur.exercise, t.set_no)] = true;
      logRows(splitSides(log, cur.each_side));
      row.classList.add('done'); check.classList.add('done'); check.textContent = '✓';
      refocus();   // rule 1: finishing a set advances what's in focus
    }
    function uncheck() {   // undo an accidental check — and the undo must REACH THE SHEET (R016, j30)
      if (lastLogId) qDel([lastLogId]).then(updateBadge).catch(function () {});
      // Sessions is append-only (hard rule 1): once the row has drained, pulling it back is
      // impossible — the undo is a CORRECTION APPEND. A marker row (flag 'uncheck', same set, blank
      // actuals) voids the set at every server intake, newest-wins, so a genuine re-log wins the set
      // back. Before this, the undo only ever emptied the local queue: any set that had already
      // drained stayed on the sheet, fed the engine, and re-marked itself done on the next reload.
      // Sent whenever the sheet may know the set — it was server-logged at render (wasLogged), or
      // this pageload logged it and the queue may have drained already. A marker for a set the sheet
      // never received is a harmless record: it voids nothing.
      if (wasLogged || lastLogId) {
        var uSid = SESSION ? SESSION.session_id : '';
        if (!uSid) { try { uSid = sessionStorage.getItem('bp_open_session') || ''; } catch (eU) {} }
        if (uSid) {
          // R373 (Mason 8/18 CSR pile-up): the void must reach the rows the SHEET holds, whatever
          // shape they were logged in — a swap or re-render that changes sidedness must not strand
          // old-shape rows immune to undo. So the undo voids ALL THREE shapes of this set; a marker
          // for a shape the sheet never received voids nothing (harmless by construction).
          var mkUn = function (side) { return { log_id: uuid(), session_id: uSid, complex_name: slot.complex_name,
            exercise: cur.exercise, set_no: t.set_no, side: side, target_load: '', target_reps: '',
            actual_load: '', actual_reps: '', flag: 'uncheck', variant_name: '' }; };
          logRows([mkUn(''), mkUn('L'), mkUn('R')]);
        }
      }
      delete LOCAL_DONE[doneKey(SESSION && SESSION.session_id, slot, cur.exercise, t.set_no)];
      lastLogId = null; lastSig = null;   // L167: undo re-arms the row, so a genuine re-log still appends
      // R381: the durable half has to re-arm too, or an undo followed by re-logging the SAME numbers
      // would be swallowed by the remembered signature and the set would stay voided.
      delete COMMIT_SIG[doneKey(SESSION && SESSION.session_id, slot, cur.exercise, t.set_no)]; saveCommitSig();
      row.classList.remove('done'); check.classList.remove('done');
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
      // R372 (Mason 8/18): a skipped row's ✓ stayed live and logged a set the athlete never did —
      // Roller Leg Curl reps-8 survived its own skip. A skipped row never logs; the label un-skips.
      if (row.classList.contains('skipped')) { miniToast('Skipped — tap the skip label to undo'); return; }
      if (check.classList.contains('done')) { uncheck(); return; }   // tap a done set again to undo
      // A LOCKED button must never be a DEAD tap (Phil 2026-08-05, right after a swap: "I couldn't
      // log my first set"). A real weight on screen: this tap ACCEPTS it and proceeds — it is
      // editable either way. Blank or zero: say what's needed and keep the 0-lb guard.
      if (check.classList.contains('locked')) {
        // the guard speaks the row's own critical value (2026-08-06: a searched BODYWEIGHT swap
        // could never log — the guard demanded a weight the row doesn't have)
        var critVal = critical === 'reps' ? state.reps : state.load;
        // L181: a weight never blocks here either — a loaded carry with no prescribed load is the
        // same trap one level down. Only reps can hold a tap.
        if (critical !== 'reps' || (critVal != null && critVal !== '' && Number(critVal) > 0)) confirmActual();
        else {
          miniToast('Enter your reps first');
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
    // L290: a set with a STANDING skip never renders a checkmark — the skip wins the render even
    // when an older logged state survives locally (LOCAL_DONE); the server's evidence readers
    // already refuse to count it.
    if (wasLogged && !skReason) { row.classList.add('done'); check.classList.add('done'); check.textContent = '✓'; }   // show as logged; tap to edit
    regRow({ row: row, slot: slot, ex: ex, t: t, timer: timer, isASide: isASide });   // so a swap can reach every set (QA-05)
    return row;
  }

  function renderSummary(n, d) {
    // D-P1 (measured 2026-08-14: profile warm 2.1s, cold 13.2s — and finishing is what makes it
    // cold, because the Finish bumps the plan version that keys the profile cache). Pre-warm it in
    // the background while the athlete reads this screen: by the time they tap Profile, the server
    // has rebuilt and cached it. Fire-and-forget — a failure costs nothing but the old cold path.
    try { fetch(cfg.WEBAPP_URL + '?action=profile&athlete=' + encodeURIComponent(athlete) + '&token=' + encodeURIComponent(token)).catch(function () {}); } catch (eW) {}
    app.innerHTML = '';
    // Phil: "You've got a massive 'Back to Calendar' button. You can take out that button. Make it
    // really small. Put that at the bottom. At the top should be the AI summary, and then any sort of
    // specific lifts that improved." The finish screen's job is to tell you what the session DID; a
    // full-width navigation control at the top was the loudest thing on a page about achievement.
    app.appendChild(el('h2', 'sum-h', 'Workout complete 💪'));
    app.appendChild(el('p', 'sum-sub', n + ' set' + (n === 1 ? '' : 's') + ' logged'));
    // Something is ALWAYS shown as the day's best (Phil 2026-08-05) — the server picks the first
    // true thing: level-up > tonnage PR > best session > strongest set > session count.
    // PROGRESS TO THE NEXT RUNG (Phil 2026-08-23 design order): computed from the session the
    // athlete just finished — the nearest strength lift to its own level goal.
    function rungProgress() {
      try {
        var best = null;
        ((SESSION && SESSION.slots) || []).forEach(function (sl) {
          (sl.exercises || []).forEach(function (e2) {
            if (!e2 || !e2.level_goal || e2.level_goal.load == null || !e2.level) return;
            var top = null;
            (e2.setPlan || []).forEach(function (st) { if (st.kind === 'work' && st.load != null && (top == null || st.load > top)) top = st.load; });
            if (top == null && e2.today && e2.today.load != null) top = e2.today.load;
            if (top == null) return;
            var gap = Number(e2.level_goal.load) - Number(top);
            if (gap > 0 && (!best || gap < best.gap)) best = { name: exLabel(e2), gap: gap, level: e2.level };
          });
        });
        if (best) return Math.round(best.gap * 2) / 2 + ' lb from L' + best.level + ' on ' + titleName(best.name);
      } catch (eRP) {}
      return null;
    }
    if (d && d.highlight) app.appendChild(el('p', 'sum-highlight', d.highlight));
    else if (d && d.ok) {
      // No PR today — the filler is a streak + the distance to the next rung, never a deficit.
      var rp0 = rungProgress();
      app.appendChild(el('p', 'sum-highlight', '\u2705 Session #' + (d.sessions_n || '?') + ' in the books' + (rp0 ? ' \u2014 ' + rp0 : '')));
    }
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
      // R112 (Phil 2026-07-24): a way BACK INTO the finished workout to edit — reopening serves the
      // session with every logged set restored, and opened rounds offer the per-row ✓ undo (the
      // R016 two-mode law). Same quiet styling as the calendar link; navigation stays at the bottom.
      var sid = (SESSION && SESSION.session_id) || (function () { try { return sessionStorage.getItem('bp_open_session') || ''; } catch (e) { return ''; } })();
      if (sid) {
        var edit = el('button', 'sum-back', '← Back into workout to edit'); edit.type = 'button';
        edit.addEventListener('click', function () { openSession(sid); });
        app.appendChild(edit);
      }
      var back = el('button', 'sum-back', '← Back to calendar'); back.type = 'button';
      back.addEventListener('click', function () { loadHome(); });
      app.appendChild(back);
    }
    if (!d || !d.ok || !d.logged) { app.appendChild(el('p', 'empty', 'Nice work.')); backLink(); return; }
    // ══ THE FOUR-SECTION SHAPE (Phil 2026-08-29 redesign — his spec verbatim) ══════════════════
    // HEADLINE (above) — trophy hierarchy, never repeated below (d.highlight_ex is the dedupe key).
    // LEVELS — one line per hinge trained today: performed · verdict vs asked · distance to next
    //   rung. Green when cleared/closed distance, amber with the gap when short. "This IS did-well
    //   AND didn't-do-well, and it mirrors the profile's clocks."
    // BEST WORK — non-hinge load/rep PRs only (server-filtered; volume-% on stability is banned).
    // FOOTER — streak + "see your levels → Profile": the profile is the destination, this screen
    //   is its front door (the theme, structural).
    // NO GARBAGE STRINGS (his #3 defect 2): performed prints load×reps or reps; a null half drops;
    // the verdict is +N over / met / −N short — never a bare fraction.
    function performedStr(m) {
      return m.loaded
        ? (m.load != null && m.reps != null ? m.load + '×' + m.reps
           : m.load != null ? m.load + ' lb' : m.reps != null ? m.reps + ' reps' : '')
        : (m.reps != null ? m.reps + ' reps' : '');
    }
    function verdictStr(m) {
      var v = m.verdict;
      if (!v) return '';
      if (v.kind === 'beat' && m.beat) {
        var asked = (m.beat.tl != null ? m.beat.tl + '×' + (m.beat.tr != null ? m.beat.tr : m.beat.reps)
                     : (m.beat.tr != null ? m.beat.tr + ' reps' : ''));
        var by = (m.beat.tl != null && m.beat.load != null && m.beat.load > m.beat.tl) ? (m.beat.load - m.beat.tl)
               : (m.beat.tr != null && m.beat.reps != null ? (m.beat.reps - m.beat.tr) : null);
        return 'beat ' + asked + (by != null ? ' by ' + by : '') + ' 🔥';
      }
      if (v.kind === 'met') return 'met ✅';
      if (v.kind === 'short') return '−' + v.n + ' ' + v.unit + (v.n === 1 ? '' : 's') + ' short';
      return '';
    }
    // distance to the next rung, per exercise, from the session the athlete just finished — the
    // same level_goal source rungProgress reads, keyed so each LEVELS line carries its own.
    function rungGapOf(exName) {
      try {
        var hit = null;
        ((SESSION && SESSION.slots) || []).forEach(function (sl) {
          (sl.exercises || []).forEach(function (e2) {
            if (!e2 || hit) return;
            var names = [e2.exercise, e2.athlete_name, exLabel(e2)].map(function (s) { return String(s || '').toLowerCase(); });
            if (names.indexOf(String(exName || '').toLowerCase()) < 0) return;
            if (!e2.level_goal || e2.level_goal.load == null || !e2.level) return;
            var top = null;
            (e2.setPlan || []).forEach(function (st) { if (st.kind === 'work' && st.load != null && (top == null || st.load > top)) top = st.load; });
            if (top == null && e2.today && e2.today.load != null) top = e2.today.load;
            if (top == null) return;
            hit = { gap: Math.round((Number(e2.level_goal.load) - Number(top)) * 2) / 2, level: e2.level };
          });
        });
        return hit;
      } catch (eRG) { return null; }
    }
    var hinges = (d.mains || []).filter(function (m) { return m.hinge !== false; });   // absent flag (old payload) = keep all
    var others = (d.mains || []).filter(function (m) { return m.hinge === false; });
    if (hinges.length) {
      app.appendChild(el('h3', 'sum-t main', 'Levels 📊'));
      hinges.forEach(function (m) {
        var parts = [performedStr(m)].filter(Boolean);
        var vs = verdictStr(m); if (vs) parts.push(vs);
        if (m.leveled) parts.push('leveled up → L' + m.level + ' 🎉');
        else {
          var rg = rungGapOf(m.exercise) || rungGapOf(m.name);
          if (rg && rg.gap > 0) parts.push(rg.gap + ' lb from L' + rg.level);
          else if (rg) parts.push('L' + rg.level + ' cleared ✅');
        }
        var cls2 = (m.verdict && m.verdict.kind === 'short') ? 'sum-row main lvl-amber' : 'sum-row main lvl-green';
        app.appendChild(el('div', cls2, titleName(m.name || m.exercise) + ' — ' + parts.join(' · ')));
      });
    }
    if (d.level_ups && d.level_ups.length) {
      d.level_ups.forEach(function (u) {
        if (hinges.some(function (m) { return m.exercise === u.canonical || m.exercise === u.exercise; })) return;
        app.appendChild(el('div', 'sum-row up levelup', titleName(u.exercise) + ' → level ' + u.level + ' 🎉'));
      });
    }
    var bestRows = [];
    (d.secondary != null ? d.secondary : []).forEach(function (c) {
      if (d.highlight_ex && titleName(c.exercise) === d.highlight_ex) return;   // never repeat the headline
      if (c.rep_pr) bestRows.push(titleName(c.exercise) + ' — ' + c.rep_pr.reps + ' reps (prev ' + c.rep_pr.prior + ') 🔺');
      else if (c.intensity_pct != null && c.intensity_pct > 0) bestRows.push(titleName(c.exercise) + ' — load PR ▲ +' + c.intensity_pct + '%');
      else if (c.first) bestRows.push(titleName(c.exercise) + ' — first time 🎉');
    });
    // a tested non-hinge lift still shows what was performed (the 2026-07-27 never-crowded-out law
    // survives the redesign — verdict format, no PR required, riding under BEST WORK)
    others.forEach(function (m) {
      // the headline lift never repeats below (his rule) — its performance already leads the page
      if (d.highlight_ex && (titleName(m.name || m.exercise) === d.highlight_ex || m.name === d.highlight_ex)) return;
      var parts = [performedStr(m)].filter(Boolean); var vs = verdictStr(m); if (vs) parts.push(vs);
      if (parts.length) bestRows.push(titleName(m.name || m.exercise) + ' — ' + parts.join(' · '));
    });
    if (bestRows.length) {
      app.appendChild(el('h3', 'sum-t up', 'Best work 🔺'));
      bestRows.forEach(function (t2) { app.appendChild(el('div', 'sum-row up', t2)); });
    }
    // FOOTER — the door to the profile FIRST (the theme, structural — and the pixels' lesson from
    // the 08-29 bless pass: last-element placement put the door half-under the fixed nav, making
    // the destination the easiest thing on the page to miss), then the streak.
    var prof = el('button', 'sum-profile', 'See your levels → Profile 📈'); prof.type = 'button';
    prof.addEventListener('click', function () { loadProfile(); });
    app.appendChild(prof);
    if (d.sessions_n) app.appendChild(el('div', 'sum-row', '\u2705 Session #' + d.sessions_n + ' in the books'));
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
      // set", j6 red). The button stays TAPPABLE; the tap itself accepts any row whose number is
      // really on screen and only blocks on a truly empty one — same law as the row-level ▶.
      // L185 (Phil 2026-08-15): THE LABEL NAMES THE SET AND NOTHING ELSE. It used to append
      // "· tap your <need>", which named a NEED without naming the ROW — so a partner's weight demand
      // read as the row he was logging, and that misattribution is what cost him the 08-15 round.
      // The 07-27 ruling already settled what this button may say: "It should just say 'Log Set
      // whatever number it is.'" Phil reaffirmed it 2026-08-15 when ruling this fix. The attribution
      // now lives in the toast, which may name the row because it is answering "why did nothing
      // happen?" rather than labelling a control.
      btn.disabled = false;
      btn.textContent = 'Log ' + setLabel;
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
      card.classList.toggle('slot-last', i === info.length - 1);   // R589(b): the last complex's summary shows Begin
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
    meta.textContent = woTitle(s) + ' · ' + s.date;   // R375: the header matches the tile they tapped
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
    // R606 slices 2-3: the chain belongs to ONE session; opening a different one ends it. The slot
    // list is rebuilt every render (fresh start closures over fresh cards); on/sid survive, so a
    // post-log refresh never kills a running chain (the R589 adoption keeps the live timer too).
    if (CHAIN.on && CHAIN.sid !== (s.session_id || s.date)) chainStop();
    CHAIN.list = [];
    CHAIN.switchS = Number(s.switch_s || 0);   // older cached payloads: 0 = advance on the trailing rest
    // R685: a reload killed the chain silently — re-adopt a remembered running chain for THIS
    // session (bounded 3h; the athlete restarts the current complex, advances chain from there).
    if (!CHAIN.on && chainRecall(s.session_id || s.date)) {
      CHAIN.on = true; CHAIN.sid = s.session_id || s.date; requestWake();
    }
    var beginWo = el('button', 'begin-wo', 'Begin Workout'); beginWo.type = 'button';
    // R685 tell (staged): an armed chain used to render as NOTHING (the button just hid), so
    // "running" and "never started" looked identical — the exact ambiguity behind Phil's
    // trailing-rest-only report. The button now becomes a quiet running strip instead of
    // vanishing; when the chain dies (expiry, other session), the tappable button returns.
    function chainTell() {
      if (CHAIN.on && CHAIN.sid === (s.session_id || s.date)) {
        beginWo.textContent = 'Workout running'; beginWo.classList.add('chain-on'); beginWo.disabled = true;
      } else {
        beginWo.textContent = 'Begin Workout'; beginWo.classList.remove('chain-on'); beginWo.disabled = false;
      }
    }
    beginWo.addEventListener('click', function () {
      if (!CHAIN.list.length) return;
      CHAIN.on = true; CHAIN.sid = s.session_id || s.date; requestWake(); chainRemember();
      // start at the first slot with unlogged work, so a resumed workout begins where the athlete is
      var target = null;
      for (var ci = 0; ci < CHAIN.list.length; ci++) if (!CHAIN.list[ci].doneAll()) { target = CHAIN.list[ci]; break; }
      (target || CHAIN.list[0]).start();
      chainTell();
    });
    chainTell();
    app.appendChild(beginWo);
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
      // R606 (Phil 2026-08-28): "Begin" alone is ambiguous next to Begin Workout — every complex's
      // independent start is labeled "Start Complex"; a warm-up slot says what IT is.
      var isComp = /^Comp\s*\d/i.test(String(slot.slot || ''));
      var startWord = isComp ? 'Start Complex' : (/^W\s*U\s*p?\s*\d/i.test(String(slot.slot || '')) ? 'Start Warm Up' : 'Start');
      var startBtn = el('button', 'tstart', startWord + ' · ' + fmt(ivs[0])); startBtn.type = 'button';
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
      // R589 — RE-ADOPT, NEVER RE-OFFER. If this slot's timer is the one already counting, the new
      // header takes over the LIVE timer and hides its own "Begin complex": tapping that button
      // restarted the complex at set 1, which is how a post-log refresh cost Grace her place
      // mid-complex. Identity is the Plan's slot id, not the displayed label (labels renumber).
      var slotKey = String(slot.slot || sLabel);
      var live = liveTimerFor(slotKey, s.session_id || s.date);
      var timer = live ? live.adopt(timerNode, pauseBtn)
                       : makeTimer(timerNode, pauseBtn, ivs, sLabel, roundTitles, slotKey);
      if (live) startBtn.hidden = true;
      startBtn.addEventListener('click', function () { timer.start(); startBtn.hidden = true; });

      // Collapsed form of a complex you haven't reached (or have finished) — rule 1. Tap to open it
      // anyway, because a plan is not an order: you may want to jump ahead.
      var slotSum = el('div', 'slot-sum');
      slotSum.appendChild(el('span', 'ss-t', slot.exercises.map(function (e) { return exLabel(e); }).join(' + ')));
      slotSum.appendChild(el('span', 'slot-state', ''));
      // R589(b) → R606 (Phil 2026-08-28, supersedes last-complex-only): EVERY collapsed later
      // complex carries its own start, labeled "Start Complex" (the last-complex-only "Begin" chip
      // was the interim oddity; "Begin" alone is ambiguous next to Begin Workout). It opens the
      // slot and starts through the SAME startBtn path — never a second timer authority.
      var sumBegin = el('button', 'sum-begin', startWord);
      sumBegin.type = 'button';
      sumBegin.addEventListener('click', function (ev) {
        ev.stopPropagation();
        card.classList.add('open');
        if (!startBtn.hidden) startBtn.click();
      });
      slotSum.appendChild(sumBegin);
      slotSum.addEventListener('click', function () { card.classList.toggle('open'); });
      card.appendChild(slotSum);
      // R606: this slot's seat in the workout chain — start through the startBtn path (one timer
      // authority), trailing = its final set's own rest (already elapsed when the chain advances,
      // so the transition adds only the excess over it).
      CHAIN.list.push({
        key: slotKey, isComp: isComp, trailing: Number(ivs[ivs.length - 1] || 0),
        start: function () { card.classList.add('open'); if (!startBtn.hidden) startBtn.click(); },
        doneAll: function () {
          var rows = card.querySelectorAll('.ex-row');
          return rows.length > 0 && card.querySelectorAll('.ex-row:not(.done)').length === 0;
        }
      });

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
                // L181: only a REPS row may block. A weight row's blank/0 is a real answer and logs
                // as it stands — one unweighted lift must never strand its partners in the round.
                if (r._blocks === false || (v != null && v !== '' && Number(v) > 0)) { if (r._confirmActual) r._confirmActual(); else r._confirmed = true; }
                else blocked = r;
              });
              if (blocked) {
                // L185 — THE TOAST NAMES THE ROW THAT IS ACTUALLY DEMANDING (Phil 2026-08-15):
                // "90-90 Switch Weighted needs a weight", not a bare "Enter your weight first" that
                // the athlete attributes to whichever row they were looking at. Naming the exercise
                // here does NOT breach the 07-27 button ruling — that governs the control's LABEL;
                // this is the answer to "why did nothing happen?", and it is useless without the name.
                var bn = ((blocked.querySelector('.ex-name') || {}).textContent || '').trim();
                var need = blocked._needs || 'number';
                miniToast(bn ? (bn + ' needs ' + (need === 'weight' ? 'a weight' : 'its reps'))
                             : ('Enter your ' + need + ' first'));
                var bf = blocked.querySelector('.stepper.editable') || blocked.querySelector('.stepper');
                if (bf) { bf.classList.add('flash'); setTimeout(function () { bf.classList.remove('flash'); }, 1200); }
                // AND SCROLL IT INTO VIEW (his (a) half). A flash on a row below the fold is a flash
                // nobody sees — which is the same failure as not naming it.
                try { blocked.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch (eS) {}
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
      // R635 (Grace 2026-08-26): completion renders IMMEDIATELY from what the phone already knows,
      // and the server's richer summary UPGRADES it in place when it lands. The old shape —
      // 'Loading summary…' + a fetch with an empty catch — sat frozen for the summary's own
      // cold-build seconds and FOREVER on a failed fetch (the R631 stall class on the exit door).
      var sumScreen = newScreen();
      renderSummary(n, null);
      var url = cfg.WEBAPP_URL + '?action=summary&athlete=' + encodeURIComponent(athlete) +
        '&session_id=' + encodeURIComponent(SESSION.session_id) + '&token=' + encodeURIComponent(token);
      // R798(b) — completion_slow (Phil 2026-08-31: "add completion_slow and route it to the
      // readiness row"). These are DETECTION thresholds, not the budget: completion_screen_max_s
      // (Thresholds cell) is graded server-side by the speed gate (L326). The client's job is to
      // report the athlete-felt fact — a summary upgrade that lands late (measured seconds in the
      // message, so the report can grade it against the cell) or never lands at all (the 20-30s
      // eyewitness class). Reports fire even if the athlete navigated away: leaving a slow screen
      // IS the signal.
      var COMPLETION_SLOW_MS = 10000, COMPLETION_WATCHDOG_MS = 20000;
      var sumT0 = Date.now(), sumSettled = false, sumReported = false;
      setTimeout(function () {
        if (sumSettled || sumReported) return;
        sumReported = true;
        reportError('completion_slow', 'summary still pending after ' + COMPLETION_WATCHDOG_MS + 'ms', SESSION.session_id, '');
      }, COMPLETION_WATCHDOG_MS);
      setTimeout(function () {
        fetchJson(url).then(function (d) {
          sumSettled = true;
          var sumMs = Date.now() - sumT0;
          if (sumMs > COMPLETION_SLOW_MS && !sumReported) {
            sumReported = true;
            reportError('completion_slow', 'summary landed after ' + (Math.round(sumMs / 100) / 10) + 's', SESSION.session_id, '');
          }
          if (!isCurrent(sumScreen)) return;             // the athlete moved on; leave their screen alone
          if (d && d.ok) renderSummary(n, d);            // any failure: the local completion stands
        });
      }, 1200);
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
    enrollDevice();   // R601: one-time invisible device enrollment; a no-op once enrolled
    var open = null; try { open = sessionStorage.getItem('bp_open_session'); } catch (e) {}
    if (open) return openSession(open);   // restore the workout a reload interrupted
    loadHome();
  }

  // ---- Home = calendar of the athlete's sessions; tap a day to open that workout ----
  function mondayOf(s) { var x = new Date(s + 'T00:00:00'); x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); return x; }
  function ymd(d) { return d.toLocaleDateString('en-CA'); }
  // R564: the server ACK is the truth about a move, so the cached week adopts it immediately.
  // loadHome instant-paints that cache, and its refresh path deliberately keeps the paint on a
  // server hiccup — which, right after a move (the server just wrote the Plan and rebuilt Coach
  // View), is the likeliest moment for one. Without this patch the pre-move cache repaints and the
  // athlete watches a date the server has already changed.
  function patchWeekCacheDate(sessionId, toDate) {
    try {
      var k = 'bp_week_' + CACHE_V + '_' + athlete;
      var raw = localStorage.getItem(k); if (!raw) return;
      var obj = JSON.parse(raw);
      (obj.sessions || []).forEach(function (s) {
        if (String(s.session_id) === String(sessionId)) s.date = String(toDate);
      });
      localStorage.setItem(k, JSON.stringify(obj));
    } catch (e) {}
  }
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
        // R601 self-heal: a REVOKED device token gets ok:false here — drop it, fall back to the
        // bookmark's link token, and retry ONCE. A genuinely dead link still shows the denial.
        if (!data.ok && tokenRejected()) { loadHome(); return; }
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
          // BW card renders on the pre-start screen TOO (found before it bit: Ryan opening his
          // invite link SUNDAY would have hit this early return and never seen the card; the setup
          // is one tap whenever he first opens, not gated on sessions existing).
          if (data.bw_missing) renderBwIntake(data);
          return;
        }
        renderCalendar(data.sessions, data.next_round_preview, data.round_pending);
        // BW SELF-ENTRY (Phil 2026-08-29 launch ruling: the athlete types their own body weight;
        // the server writes BLANK cells only, so a coach-typed value is never touched). One quiet
        // card above the calendar; it disappears on success and never returns (planver bump drops
        // the flag from the next week payload).
        if (data.bw_missing) renderBwIntake(data);
      });
  }
  // R796 HALF 2 (2026-09-02): the THREE-FIELD intake screen — Phil's spec verbatim: BW (required,
  // the overwrite door lives server-side and only while intake is incomplete) + Sex (M/F, blank-only
  // server-side — a coach-typed value renders LOCKED here, never as an editable field whose entry
  // would be discarded) + Sport/Position (picker; option list = Position Plan col A, riding the week
  // payload — rule 16, never hardcoded). Falls back to the original one-field BW card when the
  // payload predates the intake fields (older server), so no client/server deploy order can strand it.
  function renderBwIntake(data) {
    if (document.querySelector('.bw-intake')) return;
    data = data || {};
    var pf = data.intake_prefill || {};
    var sports = data.intake_sports || null;
    var threeField = !!(data.intake_missing && sports);
    var card = el('section', 'slot open bw-intake');
    card.appendChild(el('h2', 'slot-title', 'One-time setup'));
    var body = el('div', 'sets');
    body.appendChild(el('div', 'ex-note', 'Your body weight (lb) — your levels are computed from it:'));
    var inp = document.createElement('input');
    inp.type = 'number'; inp.inputMode = 'decimal'; inp.className = 'bw-in'; inp.min = 60; inp.max = 400; inp.placeholder = 'lb';
    if (threeField && pf.bw) inp.value = String(pf.bw);
    body.appendChild(inp);   // the BW field sits under its own label, ahead of the sex/sport fields
    var sexSel = null, sportSel = null;
    if (threeField) {
      body.appendChild(el('div', 'ex-note', 'Sex:'));
      if (pf.sex) {
        body.appendChild(el('div', 'ex-note', pf.sex === 'M' ? 'Male — set by your coach' : 'Female — set by your coach'));
      } else {
        sexSel = document.createElement('select'); sexSel.className = 'bw-in';
        [['', 'Choose…'], ['M', 'Male'], ['F', 'Female']].forEach(function (o) {
          var op = document.createElement('option'); op.value = o[0]; op.textContent = o[1]; sexSel.appendChild(op);
        });
        body.appendChild(sexSel);
      }
      body.appendChild(el('div', 'ex-note', 'Sport & position:'));
      if (pf.sport) {
        body.appendChild(el('div', 'ex-note', pf.sport + ' — set by your coach'));
      } else {
        sportSel = document.createElement('select'); sportSel.className = 'bw-in';
        var op0 = document.createElement('option'); op0.value = ''; op0.textContent = 'Choose…'; sportSel.appendChild(op0);
        sports.forEach(function (s9) {
          var op9 = document.createElement('option'); op9.value = s9; op9.textContent = s9; sportSel.appendChild(op9);
        });
        body.appendChild(sportSel);
      }
    }
    var save = el('button', 'roundlog', 'Save'); save.type = 'button';
    var note = el('div', 'ex-note', '');
    save.addEventListener('click', function () {
      var v2 = Number(inp.value);
      if (!v2 || v2 < 60 || v2 > 400) { note.textContent = 'Enter your weight in pounds (60–400).'; return; }
      var sexV = pf.sex || (sexSel ? sexSel.value : '');
      if (threeField && !sexV) { note.textContent = 'Choose Male or Female.'; return; }
      var sportV = pf.sport ? '' : (sportSel ? sportSel.value : '');   // a coach-set sport is never re-sent
      if (threeField && !pf.sport && !sportV) { note.textContent = 'Choose your sport & position.'; return; }
      save.disabled = true; note.textContent = 'Saving…';
      var url = threeField
        ? cfg.WEBAPP_URL + '?action=setintake&athlete=' + encodeURIComponent(athlete) +
          '&token=' + encodeURIComponent(token) + '&bw=' + encodeURIComponent(v2) +
          '&sex=' + encodeURIComponent(sexV) + '&sport=' + encodeURIComponent(sportV)
        : cfg.WEBAPP_URL + '?action=setbw&athlete=' + encodeURIComponent(athlete) +
          '&token=' + encodeURIComponent(token) + '&bw=' + encodeURIComponent(v2);
      fetchJson(url)
        .then(function (r2) {
          if (r2 && r2.ok) { card.remove(); loadHome(); }
          else { save.disabled = false; note.textContent = 'Could not save — try again.'; }
        })
        .catch(function () { save.disabled = false; note.textContent = 'Could not save — try again.'; });
    });
    body.appendChild(save); body.appendChild(note);
    card.appendChild(body);
    app.insertBefore(card, app.firstChild);
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
      b.appendChild(el('div', 'wo-name', woTitle(s)));
      var bits = [];
      // R376 (Phil 2026-08-19): FOUR statuses, as WORDS — "a status rather than a color, or both".
      // completed (faint) · started (no "resume" — his words: "you don't need resume") · missed
      // (still tappable inside the round's 7-day window) · not started.
      if (tappable) bits.push(s.status === 'done' ? 'completed' : s.status === 'started' ? 'started'
        : s.status === 'missed' ? 'missed' : 'not started');
      // R375: the anchors moved UP into the title; the theme word ("Full Body") lives here so the
      // held-tile unlock phrasing below still shares its vocabulary with something on screen.
      if (s.top_ex && s.top_ex.length) bits.push(titlePhrase(s.name || s.theme || ''));
      if (s.est_min) bits.push('~' + s.est_min + ' min');
      // R347 (Phil 2026-08-18): under the NEXT ROUND banner, a dangling "— this round" suffix read
      // as a label ON the tile ("this round" on two of three sessions). The phrase belongs to the
      // PREREQUISITE: it unlocks after the current round finishes that theme.
      if (!tappable) bits = ['unlocks after this round’s ' + titlePhrase(s.name || s.theme || 'its theme')];   // friendly name, never the theme code (leak fix)
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
    // F2 (Phil 2026-08-13): ONE workout is ONE card. A started-unfinished session renders on TODAY and
    // nowhere else — the 2026-08-12 ruling put it on today's row *as well as* its own date, which gave
    // one workout two tiles, two places to look and two things to tap. The card carries its resume
    // label below. DONE rows never move: their date is the record (L123, dates are for logged work).
    function effDate(s) { return (s.status === 'started' && s.date !== todayStr) ? todayStr : s.date; }
    var allDates = [];
    dated.forEach(function (s) { var ed = effDate(s); if (allDates.indexOf(ed) < 0) allDates.push(ed); });
    allDates.sort();   // a resumed session lands today, which may be later than every logged date
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
    var nextMarked = false;   // R376 (Phil's pick (a)): exactly ONE highlighted card — the next workout up
    dated.forEach(function (s) {
      var ed = effDate(s), resumed = (ed !== s.date);
      var row = rowsByDate[ed] || dayRowFor(ed, grid, rowsByDate);
      if (resumed && !todayRow) { row.classList.add('today'); todayRow = row; }
      var t = tile(s, true);
      // R376: the ONE accent marks the next workout UP — a missed session keeps its word and stays
      // quietly tappable (Phil: still doable inside the round's 7-day window), never the highlight.
      if (!nextMarked && s.open_round && s.status !== 'done' && s.status !== 'missed') { t.classList.add('wo-next'); nextMarked = true; }
      // R376: no "resume" wording (Phil 2026-08-19: "you don't need resume — just put started");
      // the one-card-on-today placement itself (F2) is unchanged.
      if (s.open_round && s.status !== 'done') {
        attachDrag(t, s);   // move/swap: the athlete's right
        // ⇄ TAP BUTTON RESTORED (Phil 2026-08-21, ruling (a)). It was deleted on 2026-08-12 inside a
        // CHECKPOINT auto-snapshot (8317a03) when the calendar rewrite made hold-drag the move
        // gesture — but the original code kept it deliberately ("the ⇄ button stays for tap users"),
        // and a 350ms hold-and-drag is a discoverability problem for a kid mid-session. Nothing else
        // had to be rebuilt: `.ag-move`, `.wo-wrap` and `.wo-line` were all still in styles.css and
        // `toggleMove` was still here — only this wiring was missing, which is why the whole
        // `.move-panel` block had become unreachable code.
        var wrap = el('div', 'wo-wrap');
        var line = el('div', 'wo-line');
        line.appendChild(t);
        var mv = el('button', 'ag-move', '\u21C4'); mv.type = 'button'; mv.title = 'Move to another day';
        mv.setAttribute('aria-label', 'Move this workout to another day');
        mv.addEventListener('click', function (ev) { ev.stopPropagation(); toggleMove(wrap, s); });
        line.appendChild(mv);
        wrap.appendChild(line);          // the panel appends to `wrap`, BELOW this line, full width
        row._slot.appendChild(wrap);
      } else {
        row._slot.appendChild(t);
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
    tile.classList.add('can-move');   // invisible contract marker: the harness asserts move-ability without faking a 350ms hold
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
          if (res && res.ok) { patchWeekCacheDate(s.session_id, to); loadHome(); return; }
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
        if (res && res.ok) { patchWeekCacheDate(s.session_id, iso); loadHome(); return; }
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
  // R704 (Phil's spec): ONE button reachable from ANY screen — athlete taps, types one free line,
  // sends. The nav persists on every screen (it is appended to body once), so the button lives
  // there; no categories, no forms — a single prompt, verbatim words to the coach. The screen it
  // was sent from and the open session ride the request so the Coach View can tie it to the day.
  function tellCoachNote() {
    var words = window.prompt('Tell coach — one line, anything:');
    if (!words || !words.trim()) return;
    var scr = 'app';
    try { var onB = NAV && NAV.querySelector('.nav-b.on'); if (onB && onB.dataset.k) scr = { cal: 'calendar', wo: 'workout', prof: 'profile' }[onB.dataset.k] || onB.dataset.k; } catch (e) {}
    try { if (document.querySelector('.summary')) scr = 'completion'; } catch (e) {}
    fetch(cfg.WEBAPP_URL + '?action=report&athlete=' + encodeURIComponent(athlete) +
          '&token=' + encodeURIComponent(token) + '&kind=note&screen=' + encodeURIComponent(scr) +
          '&detail=' + encodeURIComponent(words.trim()))
      .then(function (r) { return r.json(); })
      .then(function (d) { toast(d && d.ok ? 'Sent to coach 👍' : 'Could not send — try again'); })
      .catch(function () { toast('Offline — try again when connected'); });
  }
  function toast(msg) {
    // never show(): that replaces the whole screen mid-workout. A small self-removing chip.
    var t = el('div', 'mini-toast', msg);   // the existing chip style — no new theme values (UI-gov rule 3)
    document.body.appendChild(t);
    setTimeout(function () { try { t.remove(); } catch (e) {} }, 2500);
  }
  function renderNav(active) {
    if (!NAV) {
      NAV = el('nav', 'nav');
      [['cal', '📅', 'Calendar', function () { loadHome(); }],
       ['wo', '🏋️', 'Workout', function () { openToday(); }],
       ['prof', '📈', 'Profile', function () { loadProfile(); }],
       ['msg', '💬', 'Tell coach', function () { tellCoachNote(); }]].forEach(function (d) {
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
  // R381 — THE L167 WRITER GUARD'S DURABLE HALF. `lastSig` (the per-row closure at the commit site)
  // only ever remembered what THIS render appended; a re-render re-armed every row and the round's
  // Update button re-committed the lot under fresh log_ids. Same key shape as `doneKey` — one entry
  // per SET, which is what the server buckets on too — and held in sessionStorage so a reload of the
  // same tab (the iOS memory-kill class, all over ErrorLog) does not re-arm it either. Deliberately
  // NOT seeded from the server's logged map: an extra append is lawful debris under hard rule 1,
  // while suppressing a real correction loses work the athlete performed (rule 40's direction).
  var SIG_STORE = 'bp_commit_sig';
  var COMMIT_SIG = (function () {
    try { return JSON.parse(sessionStorage.getItem(SIG_STORE) || '{}') || {}; } catch (e) { return {}; }
  })();
  function saveCommitSig() {
    try { sessionStorage.setItem(SIG_STORE, JSON.stringify(COMMIT_SIG)); } catch (e) {}
  }
  // THE MARKER VOCABULARY, CLIENT SIDE — byte-identical to `_isMarkerFlag_` on the server
  // (LoggerApi.gs :10948-10956). R533 slice 1 collapsed FIVE hand-rolled copies of this list into one
  // predicate precisely because a sixth copy that drifts counts a swap or a skip RECORD as a kid's
  // logged set, at that record's own coordinates. This is the sixth copy, so it is pinned:
  // `qa/harness/marker-flags.mjs` extracts BOTH lists and reds if they differ by one word.
  // NOTE `recovered` is deliberately absent — an L131 crumb-recovered row IS a performed set.
  var MARKER_FLAG_PREFIXES = ['skip:', 'report:', 'climb|', 'swap:'];
  var MARKER_FLAG_WORDS = ['uncheck', 'history'];
  function isMarkerFlag(f) {
    var s = String(f == null ? '' : f).trim().toLowerCase();
    if (!s) return false;
    for (var i = 0; i < MARKER_FLAG_WORDS.length; i++) if (s === MARKER_FLAG_WORDS[i]) return true;
    for (var j = 0; j < MARKER_FLAG_PREFIXES.length; j++) if (s.slice(0, MARKER_FLAG_PREFIXES[j].length) === MARKER_FLAG_PREFIXES[j]) return true;
    return false;
  }
  // R533 SLICE 3 — THE DEVICE'S OWN QUEUE IS THE ONLY MEMORY THAT SURVIVES A RELAUNCH.
  //
  // Slice 2 (:1746) seeds a re-rendered row from COMMIT_SIG, and that closes the SOFT re-render —
  // leave the workout tab, come back, same tab (j32). It cannot close the HARD one: COMMIT_SIG lives
  // in sessionStorage and LOCAL_DONE is a bare object, so an iOS memory kill or a home-screen
  // relaunch starts BOTH EMPTY while the IndexedDB queue — persistent storage, which is the entire
  // reason the queue is in IndexedDB — still holds the undrained sets. The row then re-renders with
  // no server answer, no local answer and no signature: it shows its PRESCRIPTION, `wasLogged` is
  // false, and the round's Update button (:1872, deliberately re-commits every row) writes that
  // prescription as an actual under a fresh log_id. Two rows, one set-key, ONE UNDRAINED BATCH —
  // Grace's 'Assisted Dips 40 lb' shape, and it walks past BOTH standing guards, because hard rule 4
  // keys idempotency on log_id and the L167 signature guard can only drop a re-fire it remembers.
  //
  // THE ANSWER WAS IN THE QUEUE THE WHOLE TIME, exactly as slice 2's was in COMMIT_SIG: the queued
  // row carries the actuals the athlete typed. So NOTHING IS DEDUPED AWAY and no "which of these two
  // rows wins" judgment is ever made — the device simply remembers what it already committed, the
  // re-commit becomes byte-identical, and L167 drops it. That direction is the point (rule 40): a
  // real correction still appends, because a corrected value makes a DIFFERENT signature. A queue
  // dedupe that dropped the loser would have had to choose, and in Grace's case latest-wins picks
  // the ECHO — the fix would have kept the wrong row.
  //
  // WHY THIS IS NOT THE SEEDING :2955 REFUSES: that refusal is about the SERVER's logged map — other
  // devices, other sessions, coach entries. This is THIS device's OWN uncommitted writes. An existing
  // COMMIT_SIG entry is never overwritten, so a live signature always wins over a recovered one.
  //
  // HONEST LIMIT: for a DURATION row stopped with no held time the commit signature carries '' while
  // the queued row stores the prescribed duration, so the reconstruction differs and L167 will not
  // drop that re-fire — an extra append, which hard rule 1 makes lawful debris. The display restore
  // still works. Never the other way round: a mismatch can only fail to suppress, never suppress
  // something real.
  function seedFromQueue() {
    return qAll().then(function (rows) {
      var seeded = 0;
      (rows || []).forEach(function (r) {
        if (!r || isMarkerFlag(r.flag)) return;         // a marker RECORDS something; it is not a set
        var k = [String(r.session_id || ''), String(r.complex_name || ''), String(r.exercise || ''), r.set_no].join('|');
        LOCAL_DONE[k] = true;   // ":1739 — a queued-but-unconfirmed set is still a set the athlete did"
        if (COMMIT_SIG[k] == null) {
          COMMIT_SIG[k] = String(r.actual_load) + '|' + String(r.actual_reps) + '|' +
                          (r.duration_s == null ? '' : String(r.duration_s));
          seeded += 1;
        }
      });
      if (seeded) saveCommitSig();
      return seeded;
    });
  }
  try { window.BP_seedFromQueue = seedFromQueue; } catch (e) {}   // observable from a journey/console
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
        // R639 D3 ROOT (reproduced deterministically 2026-08-27, and it is not a retry problem):
        // this repaint used to land unconditionally ~10-20s after the cached paint — exactly when an
        // athlete had just tapped "See progress" — rebuilding every card COLLAPSED and tearing the
        // open panel with its in-flight history fetch out of the DOM. That is the whole eyewitness:
        // "~10-20s load, panel collapses empty, renders on second tap." Same law as the workout
        // render (screenTouched): a late refresh only repaints while the screen is UNTOUCHED. The
        // cache above still updated, so the next profile open paints fresh instantly.
        var engaged = false;
        try { engaged = [].slice.call(document.querySelectorAll('.p-detail')).some(function (d2) { return d2.style.display !== 'none'; }); } catch (eEg) {}
        if (!engaged) renderProfile(data.exercises || [], data.summary || '', data.categories || [], data.clocks || [], data);
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
    }
    // C20 (Phil 2026-08-27): the best-set/best-volume CHIPS are gone from card faces too — C1
    // deleted them from the open page and they survived here because the sweep only covered the
    // page that happened to be open. The records live as marks in the session list; every exercise
    // renders ONE shape (title · graph · goal · collapsed sessions), no exceptions, no chips.

    // Level: where you are on the climb and how far to go. L242 (Phil 2026-08-18): a LEVEL is hinge
    // vocabulary — non-hinge strength lifts rotate with the region and their cards show the current
    // GOAL (scheme + load) only, never a level of their own. The progress bar stays: proximity to
    // the goal is real information either way.
    if (x.level && !x.maxed && x.to_go != null) {
      var lv = el('div', 'p-level');
      if (x.hinge === false) {
        lv.appendChild(el('span', 'p-level-l', 'Goal'));
        lv.appendChild(el('span', 'p-level-g',
          x.goal ? (x.goal.load != null ? x.goal.load + ' lb × ' + x.goal.reps : x.goal.reps + ' reps' + (x.goal.variant ? ' — ' + x.goal.variant : '')) : '—'));
      } else {
        // R023: a variant-jump rung counts from zero on ITS OWN movement — say whose reps they are.
        var toGoTxt = x.goal.load != null ? (x.to_go + ' lb to next level')
          : (x.goal.variant ? (x.to_go + (x.to_go === 1 ? ' rep' : ' reps') + ' of ' + x.goal.variant + ' to next level')
                            : (x.to_go + (x.to_go === 1 ? ' rep to next level' : ' reps to next level')));
        lv.appendChild(el('span', 'p-level-l', 'Level ' + x.level));
        lv.appendChild(el('span', 'p-level-g', x.to_go === 0 ? 'ready to level up' : toGoTxt));
      }
      card.appendChild(lv);
      var bar = el('div', 'p-bar'); var fill = el('div', 'p-fill');
      fill.style.width = Math.round((x.progress || 0) * 100) + '%'; bar.appendChild(fill); card.appendChild(bar);
    } else if (x.maxed && x.hinge !== false) {
      card.appendChild(el('div', 'p-level', 'Top of the ladder 🏆'));
    }

    // R639 D4 (Phil 2026-08-27): ONE graph per exercise. The card sparkline is gone — the detail's
    // round-volume graph (under Goal, spec-shaped) is the graph. sparkline() itself stays for now;
    // nothing calls it until a surface earns it back.

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
    // R591 — `s.vmult` IS THE SERVER'S OWN `_volMult_`, carried across the display merge. The merge
    // drops `side` (L170/U5: one line per set), so this function cannot see that two limbs did the
    // work and has no exercise flags to consult — it scored every each-side day at HALF the "Best
    // volume" tile printed directly above it. Measured on Grace's real 2026-08-25 Side Raise: tile
    // 300 lb, day card 150 lb, same sets, same screen. Defaulting to 1 keeps an older cached payload
    // rendering exactly as it always did.
    var v = 0; (sets || []).forEach(function (s) {
      var l = Number(s.load), rp = Number(s.reps), m = Number(s.vmult) > 0 ? Number(s.vmult) : 1;
      if (l > 0) v += l * (rp || 0) * m; else if (rp > 0) v += rp * m;
    }); return Math.round(v);
  }
  function _sess1rm(sets) {   // best est-1RM in a session (reps for bodyweight) — used only to flag PRs
    var best = null; (sets || []).forEach(function (s) {
      var l = Number(s.load), rp = Number(s.reps);
      var e = (l > 0 && rp > 0) ? _est1rm(l, rp) : (rp > 0 ? rp : null);
      if (e != null && (best == null || e > best)) best = e;
    }); return best;
  }
  // R639: one session card — date, server-computed volume, optional highlight badges, and the
  // set-by-set table (the breakdown every graph point and Show Progress row opens; the numbers are
  // verifiable against the logged sets because they ARE the logged sets).
  function sessionCard(day, unit, opts) {
    var sets = day.sets || [];
    // TWO MARKS EXIST (C18f): the star on the set row that produced the best e1RM, the shade box on
    // the best-volume session. Nothing else — no badges, no PR text. C18a: the header is the DATE
    // ONLY (the variant lives in the title and its dropdown). C13: a short session renders greyed
    // and visible — history is evidence; only the claim was cleaned.
    var c = el('div', 'p-sess' + ((opts && opts.shade) ? ' pr' : ''));
    var head = el('div', 'p-sess-h');
    head.appendChild(el('span', 'p-sess-d', fmtHistDate(day.date)));
    var st = el('span', 'p-sess-s');
    // C26 (withdrawing C23): NO labels — 'short session' was an internal rule name and 'imported'
    // a provenance detail; excluded days no longer render at all, and legacy days carry no marker.
    var loaded = (day.vol_unit || unit) === 'lb';
    // C5: a computed volume is never labelled with a raw unit it is not; C9: the volume is the
    // TAP-THROUGH into its arithmetic (below) — tap the number, see the math.
    var volEl = null;
    if (Number(day.vol) > 0) { volEl = el('span', 'p-sess-vol', 'volume ' + day.vol + (loaded ? ' lb' : '')); st.appendChild(volEl); }
    head.appendChild(st);
    c.appendChild(head);
    var tbl = el('table', 'p-sess-tbl');
    var htr = el('tr', 'p-sess-thr');
    htr.appendChild(el('th', '', 'Set'));
    if (loaded) htr.appendChild(el('th', '', 'lb'));
    htr.appendChild(el('th', '', 'reps'));
    tbl.appendChild(htr);
    // C10: on the star day, the row holding the best e1RM wears the star (server-computed set.e1
    // against the day's best_e1 — first matching row on a within-day tie, the earliest set).
    var starRow = -1;
    if (opts && opts.star && day.best_e1 != null) {
      for (var si = 0; si < sets.length; si++) {
        if (sets[si].e1 != null && Number(sets[si].e1) === Number(day.best_e1)) { starRow = si; break; }
      }
    }
    sets.forEach(function (s2, i) {
      var l = Number(s2.load), rp = Number(s2.reps);
      var tr = el('tr', i === starRow ? 'set-star' : '');
      tr.appendChild(el('td', '', (i === starRow ? '★ ' : '') + String(s2.set || (i + 1)) + (s2.side ? ' ' + s2.side : '')));
      if (loaded) tr.appendChild(el('td', '', (s2.load !== '' && s2.load != null && !isNaN(l)) ? String(l) : '—'));
      tr.appendChild(el('td', '', (s2.reps !== '' && s2.reps != null && !isNaN(rp)) ? String(rp) : '—'));
      tbl.appendChild(tr);
    });
    c.appendChild(tbl);
    // D11 (R639, Phil's spec): a variant regression is VISIBLE — demotion, coach substitution and
    // logging error no longer render identically. Server-stamped on the FIRST day of a
    // below-earlier-best run (episode start), with the date the better variant was first reached.
    // One muted line; C18f's no-badges law governs marks/PR text, D11 is the spec's own ordered
    // addition. Placement staged for Phil's look (C29).
    if (day.regress && day.regress.best) {
      c.appendChild(el('div', 'p-sess-regress',
        '↓ below earlier best: ' + titleName(day.regress.best) + ' · ' + fmtHistDate(day.regress.best_date)));
    }
    // C9 (Phil): the arithmetic comes OFF the card face — no athlete reads sheet column letters.
    // It lives UNCHANGED behind the tap-through: tap the volume, see the math. Decomposable by
    // tapping was always the requirement; printing internals never was.
    if (day.coeff && Number(day.vol) > 0 && volEl) {
      var raw = 0;
      sets.forEach(function (s2) {
        var l = Number(s2.load), rp = Number(s2.reps) || 0;
        raw += loaded ? (l > 0 ? l * rp : 0) : rp;
      });
      var mathLine = el('div', 'p-sess-math',
        (loaded ? 'Σ lb×reps ' : 'Σ reps ') + Math.round(raw * 10) / 10 +
        ' × O' + day.coeff.o + ' × Q' + day.coeff.q + ' = ' + day.vol + (loaded ? ' lb' : ''));
      mathLine.style.display = 'none';
      volEl.classList.add('tappable');
      volEl.addEventListener('click', function () {
        mathLine.style.display = mathLine.style.display === 'none' ? 'block' : 'none';
      });
      c.appendChild(mathLine);
    }
    return c;
  }
  function loadProfileDetail(x, panel) {
    // R661 item 1 (Phil 2026-08-28: "bar tap → detail takes ~10s; near-instant, same
    // optimistic/cache pattern as swaps"): the last payload for this exercise paints INSTANTLY
    // from localStorage; the fresh fetch lands in the background and repaints only while the
    // panel is UNTOUCHED (the D3 law — a late repaint must never tear an open panel out from
    // under the athlete). The key carries CACHE_V so client cache bumps invalidate history too.
    var hkey = 'bp_hist_' + CACHE_V + '_' + athlete + '_' + x.exercise;
    var cachedStr = null;
    try { var rawH = localStorage.getItem(hkey); if (rawH) cachedStr = JSON.stringify(JSON.parse(rawH).data); } catch (eC0) { cachedStr = null; }
    var painted = false;
    panel._touched = false;
    panel.addEventListener('click', function () { panel._touched = true; }, true);
    function renderPayload(d) {
        panel.innerHTML = '';
        var all = (d && d.ok && d.days) || [];   // newest-first; server already dropped flagged outliers
        // F-E (Phil 2026-08-12): ZERO-REP rows are not history.
        all = all.map(function (day) {
          var sets = (day.sets || []).filter(function (s) { return Number(s.reps) > 0; });
          return Object.assign({}, day, { sets: sets });
        }).filter(function (day) { return (day.sets || []).length > 0; });
        if (!all.length) { panel.appendChild(el('div', 'p-detail-note', 'No history yet.')); return; }
        // C19 — THE PAGE, fixed order, nothing else: 1 title (variant + level, with the variant
        // dropdown) · 2 line graph (volume per round, DATES on the axis, tappable) · 3 goal bar ·
        // 4 session history, collapsed by default. C18 deleted everything that restated any of it.
        var variants = [];
        all.forEach(function (day) {
          var v2 = String(day.variant || '').trim();
          if (v2 && variants.indexOf(v2) < 0) variants.push(v2);
        });
        function renderSeries(series) {
          panel.innerHTML = '';
          var sKey = series.toLowerCase();
          // C27: the DROPDOWN IS THE TITLE — variant in the control, level beside it, one line,
          // one statement of the variant (the H1 doubled it and wrapped into a column).
          var head = el('div', 'p-dt-head');
          var sel = document.createElement('select'); sel.className = 'p-dt-var';
          (variants.length ? variants : [series || x.name]).forEach(function (v2) {
            var o = document.createElement('option'); o.value = v2; o.textContent = titleName(v2);
            if (String(v2).toLowerCase() === sKey) o.selected = true;
            sel.appendChild(o);
          });
          sel.addEventListener('change', function () { renderSeries(sel.value); });
          head.appendChild(sel);
          if (x.level) head.appendChild(el('span', 'p-dt-lvl', 'L' + x.level));
          panel.appendChild(head);
          var days = all.filter(function (day) {
            var dv = String(day.variant || '').trim().toLowerCase();
            return !dv || dv === sKey;   // generic/parent-named Blueprint logs count as the series
          });
          if (!days.length) days = all;
          // C26 (withdrawing C23): an excluded day is BAD DATA, not a short workout — it does not
          // render at all. The soft-delete overlay keeps every row; the restore list is an ADMIN
          // surface (the shortlist diag), never the profile.
          days = days.filter(function (day) { return !day.short; });
          if (!days.length) { panel.appendChild(el('div', 'p-detail-note', 'No history yet.')); return; }
          var unit = null;
          days.forEach(function (day) { if (!unit && day.vol_unit) unit = day.vol_unit; });
          unit = unit || 'lb';
          var mk = (d && d.marks && d.marks[sKey]) || {};
          var live = days.filter(function (day) { return !day.short; });   // C13: shorts hold no records
          // 2. THE GRAPH — ONE POINT PER SESSION at that session's own volume (R661 item 3, Phil
          // 2026-08-28, superseding C19's "volume per round": on his own device Aug 22 (6,600) and
          // Aug 24 (6,200) shared a round and rendered as one 12,800 point — "No summing, ever").
          // Points chronological by date, short sessions excluded, dates on the axis, no caption,
          // no glyphs (marks live in the list), every point tappable to its own session card.
          var rpts = live.filter(function (day) { return Number(day.vol) > 0; })
            .map(function (day) { return { date: day.date, v: Number(day.vol), days: [day] }; })
            .sort(function (a, b) { return String(a.date) < String(b.date) ? -1 : 1; })
            .slice(-12);
          var breakdown = el('div', 'p-dt-break');
          function showRound(pp) {
            breakdown.innerHTML = '';
            pp.days.forEach(function (day) { breakdown.appendChild(sessionCard(day, unit, seriesOpts(day))); });
          }
          if (days.length >= 2 && rpts.length >= 2) {
            panel.appendChild(bigChart(
              rpts.map(function (pp) { return { date: pp.date, v: pp.v, lbl: fmtHistDate(pp.date) }; }),
              unit === 'lb' ? 'lb' : '', null, { onTap: function (i2) { showRound(rpts[i2]); } }));
            panel.appendChild(breakdown);
          }
          // 3. THE GOAL BAR — the one forward-looking thing on the page (from the profile row the
          // athlete tapped; the served rung's own numbers, D1's resolver).
          if (days.length >= 2 && x.goal && (x.goal.load != null || x.goal.reps != null)) {
            var gwrap = el('div', 'p-dt-goal');
            var gtxt = x.goal.load != null ? ('goal: ' + x.goal.load + ' lb × ' + x.goal.reps)
                                           : ('goal: ' + x.goal.reps + ' reps');
            gwrap.appendChild(el('div', 'p-dt-goaltxt', gtxt));
            // C28: the bar reads the athlete's BEST FOR THIS VARIANT against the goal, raw units,
            // computed from the sets on this page — the profile row's progress nulls under the
            // R023 variant-jump guard, and a bar reading empty when the athlete has beaten the
            // number is worse than no bar. Goal source: the CURRENT serving rung's pass standard.
            var bestRaw = 0, goalRaw = null;
            if (x.goal.load != null) {
              goalRaw = Number(x.goal.load) * (1 + (Number(x.goal.reps) || 0) / 30);
              days.forEach(function (day) { (day.sets || []).forEach(function (s2) {
                var l = Number(s2.load), rp = Number(s2.reps) || 0;
                if (l > 0 && rp > 0) bestRaw = Math.max(bestRaw, l * (1 + rp / 30));
              }); });
            } else {
              goalRaw = Number(x.goal.reps) || null;
              days.forEach(function (day) { (day.sets || []).forEach(function (s2) {
                bestRaw = Math.max(bestRaw, Number(s2.reps) || 0);
              }); });
            }
            if (goalRaw > 0) {
              var bar = el('div', 'p-dt-bar');
              var fill = el('div', 'p-dt-fill');
              fill.style.width = Math.round(Math.max(0, Math.min(1, bestRaw / goalRaw)) * 100) + '%';
              bar.appendChild(fill); gwrap.appendChild(bar);
            }
            panel.appendChild(gwrap);
          }
          // 4. SESSION HISTORY — collapsed by default; every session for the selected variant,
          // short sessions greyed and visible (C13: history is evidence, the graph is a claim).
          function seriesOpts(day) {
            var d10 = String(day.date).slice(0, 10);
            return { shade: mk.shade_date === d10 && !day.short, star: mk.star_date === d10 && !day.short, short: !!day.short };
          }
          var hwrap = el('div', 'p-dt-hist'); hwrap.style.display = 'none';
          var htog = el('button', 'p-more'); htog.type = 'button';
          htog.textContent = 'Sessions (' + days.length + ') ▾';
          htog.addEventListener('click', function () {
            var open2 = hwrap.style.display !== 'none';
            hwrap.style.display = open2 ? 'none' : 'block';
            htog.textContent = 'Sessions (' + days.length + ') ' + (open2 ? '▾' : '▴');
          });
          days.forEach(function (day) { hwrap.appendChild(sessionCard(day, unit, seriesOpts(day))); });
          if (days.length === 1) { hwrap.style.display = 'block'; htog.style.display = 'none'; }   // C20: one session = just that session
          panel.appendChild(htog);
          panel.appendChild(hwrap);
          // C8 — OTHER VARIANTS GO AT THE BOTTOM (his spec verbatim; placement is the spec's own:
          // "Below the session list, add an 'Other work' section: every other variant of this parent
          // the athlete has performed, each with its last-performed date and its own best set and
          // best session volume, each tappable to its own series with its own graph. No cross-variant
          // math, no merged line, ever."). Each row is computed ONLY from its own variant's days;
          // shorts hold no records (C13) and excluded days never reached the payload (C26). Volume
          // prints bare per C5. Tap = renderSeries(v), the dropdown's own path — one mechanism.
          var others = variants.filter(function (v2) { return String(v2).toLowerCase() !== sKey; });
          if (others.length) {
            var osec = el('div', 'p-dt-others');
            osec.appendChild(el('div', 'p-dt-others-h', 'Other work'));
            var oN = 0;
            others.forEach(function (v2) {
              var vKey = String(v2).toLowerCase();
              var vdays = all.filter(function (day) {
                return String(day.variant || '').trim().toLowerCase() === vKey && !day.short;
              });
              if (!vdays.length) return;   // all-short variants stay reachable via the dropdown, never a record row
              var last = vdays[0].date;    // `all` is newest-first; the filter preserves order
              var bestSet = null, bestE = 0, bestVol = 0;
              vdays.forEach(function (day) {
                bestVol = Math.max(bestVol, Number(day.vol) || 0);
                (day.sets || []).forEach(function (s2) {
                  var l = Number(s2.load), rp = Number(s2.reps) || 0;
                  if (rp <= 0) return;
                  var e9 = l > 0 ? l * (1 + rp / 30) : rp;   // loaded by Epley, reps-only by reps — never mixed
                  if (e9 > bestE) { bestE = e9; bestSet = s2; }
                });
              });
              var bs = bestSet ? (Number(bestSet.load) > 0 ? (bestSet.load + ' lb × ' + bestSet.reps) : (bestSet.reps + ' reps')) : '—';
              var row = el('button', 'p-dt-other'); row.type = 'button';
              row.appendChild(el('span', 'p-dt-other-n', titleName(v2)));
              row.appendChild(el('span', 'p-dt-other-d',
                fmtHistDate(last) + ' · best ' + bs + (bestVol > 0 ? ' · vol ' + Math.round(bestVol) : '')));
              row.addEventListener('click', function () { renderSeries(v2); });
              osec.appendChild(row); oN++;
            });
            if (oN) panel.appendChild(osec);
          }
        }
        renderSeries(String((d && d.series_variant) || x.variant || '').trim());
    }
    if (cachedStr) { try { renderPayload(JSON.parse(cachedStr)); painted = true; } catch (eC1) { painted = false; } }
    if (!painted) { panel.innerHTML = ''; panel.appendChild(el('div', 'p-detail-note', 'Loading…')); }
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
          if (painted) return;   // the cached render stands; the athlete lost nothing
          panel.innerHTML = '';
          panel.appendChild(el('div', 'p-detail-note', d.error === 'server' ? SERVER_HICCUP : 'Offline — reconnect to see history.'));
          // R674 (L187's profile half, 2026-08-28): the note says "Tap again." but _loaded was set
          // before the fetch and never reset, so no tap ever refetched — one transient hiccup killed
          // this exercise's detail until a full profile reload. Failure-without-paint re-arms the row.
          panel._loaded = false;
          return;
        }
        var freshStr = null; try { freshStr = JSON.stringify(d); } catch (eS) {}
        try { if (freshStr) localStorage.setItem(hkey, JSON.stringify({ at: Date.now(), data: d })); }
        catch (eW) {
          // quota: shed only OUR history entries, then try once more — never touch other keys
          try {
            for (var iH = localStorage.length - 1; iH >= 0; iH--) {
              var kH = localStorage.key(iH);
              if (kH && kH.indexOf('bp_hist_') === 0) localStorage.removeItem(kH);
            }
            if (freshStr) localStorage.setItem(hkey, JSON.stringify({ at: Date.now(), data: d }));
          } catch (eW2) {}
        }
        if (painted && (panel._touched || (freshStr && freshStr === cachedStr))) return;   // untouched-only repaint; identical payload repaints nothing
        renderPayload(d);
      })
      .catch(function () {
        if (painted) return;
        panel.innerHTML = ''; panel.appendChild(el('div', 'p-detail-note', 'Could not load history.'));
        panel._loaded = false;   // R674: same law as the server branch — a failed panel re-arms
      });
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
  function bigChart(pts, unit, metric, opts) {
    opts = opts || {};
    // C5: '' means a computed volume with no honest raw unit — print the number bare.
    var u = unit === 'lb' ? ' lb' : (/rep/i.test(String(unit || '')) ? ' reps' : '');
    var vs = pts.map(function (p) { return p.v; });
    var lo = Math.min.apply(null, vs), hi = Math.max.apply(null, vs);
    if (hi === lo) hi = lo + 1;
    var W = 300, H = 150, PADX = 12, PADT = 24, PADB = 30, n = pts.length, NS = 'http://www.w3.org/2000/svg';
    var xy = pts.map(function (p, i) {
      return [PADX + (n === 1 ? 0 : (i * (W - PADX * 2) / (n - 1))), (H - PADB) - ((p.v - lo) / (hi - lo)) * (H - PADT - PADB)];
    });
    var d = xy.map(function (c, i) { return (i ? 'L' : 'M') + c[0].toFixed(1) + ' ' + c[1].toFixed(1); }).join(' ');
    var svg = document.createElementNS(NS, 'svg'); svg.setAttribute('class', 'bigchart'); svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
    function add(tag, attrs, txt) { var e = document.createElementNS(NS, tag); Object.keys(attrs).forEach(function (k) { e.setAttribute(k, attrs[k]); }); if (txt != null) e.textContent = txt; svg.appendChild(e); return e; }
    add('path', { class: 'bc-area', d: d + ' L' + xy[n - 1][0].toFixed(1) + ' ' + (H - PADB) + ' L' + xy[0][0].toFixed(1) + ' ' + (H - PADB) + ' Z' });
    add('path', { class: 'bc-line', d: d });
    xy.forEach(function (c, i) {
      var p = pts[i];
      // C18f/C21: the graph carries NO record glyphs — the star belongs to a set row and the shade
      // to a session card; the graph is a clean line whose points decompose by tap.
      add('circle', { class: i === n - 1 ? 'bc-dot bc-now' : 'bc-dot', cx: c[0].toFixed(1), cy: c[1].toFixed(1), r: i === n - 1 ? 4 : 2.6 });
      if (p.lbl && (n <= 6 || i === 0 || i === n - 1 || i % 2 === (n - 1) % 2)) add('text', { class: 'bc-xlbl', x: c[0].toFixed(1), y: (H - 4).toFixed(1), 'text-anchor': 'middle' }, p.lbl);
      // EVERY point is tappable (spec: no number that can't be decomposed) — a wide invisible hit
      // target over each dot, because a 2.6px circle is not a tap target on a phone.
      if (opts.onTap) {
        var hit = add('circle', { class: 'bc-hit', cx: c[0].toFixed(1), cy: c[1].toFixed(1), r: 13, fill: 'transparent' });
        (function (idx) { hit.addEventListener('click', function () { opts.onTap(idx); }); })(i);
      }
    });
    add('text', { class: 'bc-val', x: (xy[n - 1][0] > W - 46 ? xy[n - 1][0] - 6 : xy[n - 1][0] + 6).toFixed(1),
      y: Math.max(13, xy[n - 1][1] - 7).toFixed(1), 'text-anchor': xy[n - 1][0] > W - 46 ? 'end' : 'start' }, vs[n - 1] + u);
    var wrap = el('div', 'bc-wrap'); wrap.appendChild(svg);
    // C18c/d: NO caption — dates live on the axis; the line shows its own direction.
    if (metric) wrap.appendChild(el('div', 'bc-cap', metric));
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
    // R027/I3 (Phil 2026-08-16): title only — the worst-first explainer is dropped; the bars are
    // already ordered worst-first and the ▾ chevron carries the tap affordance.
    card.appendChild(el('div', 'ladder-h', 'Where you stand'));
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
        // C31/C40: the drill-down shows the column C parent + level per lift via the ONE row
        // component — same row, same tap, same detail page as Strongest/Needs. The leveling clocks
        // moved to their OWN section below Tell Coach (C42) — no clock renders in any drill-down.
        // R661 item 4 (Phil 2026-08-28): drill rows carry NO bars (category bars are the only bars)
        // and every exercise opens ALREADY EXPANDED to its line graph the moment the category opens.
        var drillWraps = [];
        lifts.forEach(function (lift, i) {
          var pr2 = profileRow(lift, { drill: true });
          if (i === 0) pr2.insertBefore(el('div', 'pc-sets', 'sets your level'), pr2.firstChild);   // weakest = the floor
          panel.appendChild(pr2); drillWraps.push(pr2);
        });
        card.appendChild(panel);
        panels.push({ row: row, panel: panel });
        row.setAttribute('role', 'button'); row.setAttribute('tabindex', '0'); row.setAttribute('aria-expanded', 'false');
        var toggle = function () {
          var willOpen = panel.hidden;
          panels.forEach(function (p) { p.panel.hidden = true; p.row.classList.remove('open'); p.row.setAttribute('aria-expanded', 'false'); });
          if (willOpen) {
            panel.hidden = false; row.classList.add('open'); row.setAttribute('aria-expanded', 'true');
            // R661 item 4: exercises open already expanded to their graphs (lazy — only on open)
            drillWraps.forEach(function (w) { if (w._openDetail) w._openDetail(); });
            
          }
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
      // R360 (Phil 2026-08-18): this rebuild preferred round/of/level over the server's english, so
      // a topped side printed "Round 4 of 3" — the tick lawfully outruns the window when no minus
      // can fire at the ladder top. At a top (or any round>of state) the server's english IS the
      // honest line ("top of the ladder (3.3)"); shorthand still maps to full words per ruling 3b.
      var line = (!c.at_top && side && c.round != null && c.of != null && c.level != null && Number(c.round) <= Number(c.of))
        ? side + ': Round ' + c.round + ' of ' + c.of + ' at ' + c.level
        : (c.english ? String(c.english).replace(/^LE:/, 'Lower body:').replace(/^UE:/, 'Upper body:') : c.english);
      r.appendChild(el('div', 'p-clk-v', line));
      // THE MINUS COPY WAS FALSE AS OF L172 (Phil 2026-08-15: "the profile's minus tooltip says
      // 'nothing in your program changes' — WRONG since L172: the minus serves the next rung's
      // schemes"). It was true under L137, which L172 overturned: a promote-with-minus IS a real
      // served level and the whole hinge group serves the next sub-level's schemes AND loads.
      // A copy line that contradicts the law is worse than no line — it teaches the athlete to
      // distrust the number. Behind an icon, per Phil's 2026-08-14 ruling for the volume formula
      // ("an information icon you click if you want to see it") — same `p-info` control, no new
      // vocabulary. The eye glyph was his earlier pick; REVERSED by Phil 2026-08-17 ("I meant the
      // letter I... just like we have on the weekly volume") — one icon vocabulary, the circled i.
      if (c.minus) {
        var mrow = el('div', 'p-clk-inforow');
        var mb = el('button', 'p-info'); mb.type = 'button'; mb.textContent = 'ⓘ';
        mb.title = 'What the “−” means';
        var mnote = el('div', 'p-clk-n', 'the “−” means the clock moved you up before you cleared it — ' +
          'your program does move: this region now serves the next sub-level’s schemes and loads.');
        mnote.hidden = true;
        mb.addEventListener('click', function () { mnote.hidden = !mnote.hidden; });
        mrow.appendChild(mb);
        r.appendChild(mrow);
        r.appendChild(mnote);
      }
      card.appendChild(r);
    });
    return card;
  }

  // PROFILE V2 CARDS (the mock Phil approved 2026-08-14 — B7 + S20 + D-P2 + ruling 4). Each card
  // fail-softs to nothing when its payload block is absent (an old cached payload must still render).
  function volumeCard(roundsIn, wksIn) {
    // BY COMPLETED ROUND, NOT CALENDAR WEEK (Phil 2026-08-17: a week slices a round arbitrarily, so
    // one round split across two weeks graphed as a collapse — "I have a hard time believing Mason's
    // went down"). An unfinished round does not plot at all. Weeks remain ONLY as the fail-soft for
    // a stale cached payload without volume_rounds.
    var byRound = !!(roundsIn && roundsIn.length);
    var wks;
    if (byRound) {
      wks = roundsIn.filter(function (w) { return w && w.lb != null; });
    } else {
      wks = (wksIn || []).filter(function (w) { return w && w.wk; });
      // AXIS = THE DATA'S OWN SPAN (Phil 2026-08-14): 12 weeks only when 12 weeks exist — a 3-week
      // athlete gets a 3-week axis starting at their first data, not 9 weeks of flatline preamble.
      var first = -1; wks.forEach(function (w, i) { if (first < 0 && w.lb > 0) first = i; });
      if (first > 0) wks = wks.slice(first);
    }
    if (!wks.length || !wks.some(function (w) { return w.lb > 0; })) return null;
    var c = el('div', 'p-ai');
    c.appendChild(el('div', 'p-ai-h', byRound
      ? 'Volume — last ' + wks.length + ' completed round' + (wks.length === 1 ? '' : 's')
      : 'Weekly volume — last ' + wks.length + ' week' + (wks.length === 1 ? '' : 's')));
    var W = 360, H = 120, PAD = 10;
    // Y AXIS = THE DATA'S OWN SPAN TOO (R021, Phil 08-16: "Y scale is wrong" — extends his own
    // 08-14 X-axis ruling above). Zero-anchored Y left the line floating over a dead zone (his data
    // never dips below ~2/3 of max) with ONE unreadable label. Floor/ceil to whole thousands, label
    // BOTH ends. A real zero week keeps the floor at 0 — low points are real feedback, never smoothed.
    var dmax = Math.max.apply(null, wks.map(function (w) { return w.lb; }));
    var dmin = Math.min.apply(null, wks.map(function (w) { return w.lb; }));
    var min = Math.max(0, Math.floor(dmin / 1000) * 1000);
    var max = Math.ceil(dmax / 1000) * 1000; if (max <= min) max = min + 1000;
    var bestI = 0; wks.forEach(function (w, i) { if (w.lb > wks[bestI].lb) bestI = i; });
    function xy(i, lb) { var x = PAD + i * ((W - 2 * PAD) / Math.max(1, wks.length - 1));
      var y = H - 14 - (max > min ? ((lb - min) / (max - min)) * (H - 34) : 0); return [Math.round(x), Math.round(y)]; }
    var pts = wks.map(function (w, i) { return xy(i, w.lb).join(','); }).join(' ');
    var bp = xy(bestI, wks[bestI].lb);
    var svgNS = 'http://www.w3.org/2000/svg', svg = document.createElementNS(svgNS, 'svg');
    svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H); svg.setAttribute('width', '100%'); svg.setAttribute('height', H);
    function sEl(tag, at, txt) { var n = document.createElementNS(svgNS, tag); Object.keys(at).forEach(function (k) { n.setAttribute(k, at[k]); }); if (txt) n.textContent = txt; return n; }
    svg.appendChild(sEl('polyline', { points: pts, fill: 'none', stroke: '#2e6bd6', 'stroke-width': 2.2 }));
    // R331 (Phil 2026-08-18): a DOT at every point with ITS OWN NUMBER — "I don't need a y-axis
    // listing of the numbers. You can take those off for everybody. Just put what the number is."
    // The best point keeps its green; the axis end-labels are gone.
    wks.forEach(function (w, i) {
      var p2 = xy(i, w.lb);
      svg.appendChild(sEl('circle', { cx: p2[0], cy: p2[1], r: 3.5, fill: i === bestI ? '#0a7d4f' : '#2e6bd6' }));
      var anch2 = p2[0] > W - 34 ? 'end' : (p2[0] < 34 ? 'start' : 'middle');
      var lbl = w.lb >= 1000 ? (Math.round(w.lb / 100) / 10) + 'k' : String(Math.round(w.lb));
      svg.appendChild(sEl('text', { x: p2[0], y: Math.max(10, p2[1] - 8), 'text-anchor': anch2, 'font-size': 9,
        'font-weight': i === bestI ? 700 : 400, fill: i === bestI ? '#0a7d4f' : '#5b7290' }, lbl + ' lb'));
    });
    // R022: a round that closed SHORT says so at its own point — "2 of 3" = sessions logged of
    // planned. Full rounds stay silent (#5); this is why a dip dips, not decoration.
    if (byRound) wks.forEach(function (w, i) {
      if (!(w.p > 0 && w.w < w.p)) return;
      var lp = xy(i, w.lb);
      var anch = lp[0] > W - 30 ? 'end' : (lp[0] < 30 ? 'start' : 'middle');
      svg.appendChild(sEl('text', { x: lp[0], y: Math.min(H - 4, lp[1] + 16), 'text-anchor': anch, 'font-size': 9, fill: '#b0763a' }, w.w + ' of ' + w.p));
    });
    c.appendChild(svg);
    // The formula hides behind an ⓘ (Phil 2026-08-14: "shouldn't be written out — an information
    // icon you click if you want to see it").
    var infoRow = el('div', 'p-vol-inforow');
    var ib = el('button', 'p-info'); ib.type = 'button'; ib.textContent = 'ⓘ'; ib.title = 'How volume is counted';
    var foot = el('div', 'p-vol-foot', 'Volume = every set’s load × reps, summed. Dumbbell (per-hand) lifts count ×2 — both hands work.');
    foot.hidden = true;
    ib.addEventListener('click', function () { foot.hidden = !foot.hidden; });
    infoRow.appendChild(ib);
    c.appendChild(infoRow);
    c.appendChild(foot);
    // Milo on two lines, Phil's phrasing (2026-08-14).
    var milo = el('div', 'p-milo');
    milo.appendChild(el('div', '', 'Add a little every week.'));
    milo.appendChild(el('div', '', 'Milo carried the calf every day — one day it was a bull.'));
    c.appendChild(milo);
    return c;
  }
  // ONE LAW, ONE PREDICATE (L207) — "which lift is strongest" is answered HERE and nowhere else.
  // The server asked the same question with a DIFFERENT rule (level alone) until 2026-08-17, and the
  // two agreed on every athlete we happened to look at, which is why it survived. They part company
  // the instant a non-maxed 3.3 meets a maxed 3.1. Phil's rule for a conflict: the newer one is
  // right — this one, from Profile V2 (2026-08-14) — and it is also the correct reading, since top
  // of the ladder beats a higher unfinished rung. `apps-script/LoggerApi.gs` declares this function
  // byte-identically; `qa/harness/bestlift-parity.mjs` extracts BOTH and reds if they ever differ.
  function _bestLiftCmp_(a, b) {
    if (!!b.maxed !== !!a.maxed) return b.maxed ? 1 : -1;
    var d = (parseFloat(b.level) || 0) - (parseFloat(a.level) || 0); if (d) return d;
    return (b.progress || 0) - (a.progress || 0);
  }
  function topCards(list) {
    var lev = list.filter(function (x) { return x.level != null; });
    if (!lev.length) return [];
    var best = lev.slice().sort(_bestLiftCmp_).slice(0, 3);
    var needs = lev.filter(function (x) { return !x.maxed; }).sort(function (a, b) {
      var d = (parseFloat(a.level) || 9) - (parseFloat(b.level) || 9); if (d) return d;
      return (a.progress || 0) - (b.progress || 0); }).slice(0, 3);
    function row(x, right) { var r = el('div', 'p-pt'); r.appendChild(el('span', 'p-pt-k', x.name + (x.variant ? ' · ' + x.variant : '')));
      var b = el('span', 'p-pt-b'); b.appendChild(el('span', 'p-pt-v', right)); r.appendChild(b); return r; }
    var out = [];
    var cB = el('div', 'p-ai'); cB.appendChild(el('div', 'p-ai-h', 'Strongest right now'));
    // Levels are new vocabulary — each level carries the REAL set that earned it (Phil 2026-08-14).
    best.forEach(function (x) {
      var did = x.best_pair ? (x.best_pair.load != null ? ' · ' + x.best_pair.load + ' lb × ' + x.best_pair.reps : ' · ' + x.best_pair.reps + ' reps') : '';
      // L242: non-hinge rows carry the real set only — the level is hinge vocabulary.
      cB.appendChild(row(x, x.hinge === false ? (did ? did.slice(3) : '—')
                                              : (x.maxed ? 'top of its ladder' : 'L' + x.level) + did));
    });
    out.push(cB);
    if (needs.length) {
      var cN = el('div', 'p-ai'); cN.appendChild(el('div', 'p-ai-h', 'Biggest needs'));
      // THE PASS STANDARD, NEVER AN INVENTED RUNG (Phil 2026-08-14: "Cossack 1 lb to 1.4 — there is
      // no 1.4"). The old text computed next-level by +0.1 arithmetic, which fabricates rungs the
      // ladder doesn't have (x.3 + 0.1 = x.4 instead of the next whole level). The line now states
      // the CURRENT rung's own pass requirement — weight × reps out of the level — read from goal,
      // which came from the Level Standards cell. No arithmetic, no invented labels.
      // R023: a rung on a DIFFERENT variant names that variant (verbatim Level Standards col D) —
      // "pass 2.1: 6 reps — Roller Leg Curl - 2 Leg up, 1 Leg back", never a bare rep count that
      // reads as the variant the athlete already does. The server only sends goal.variant when it
      // differs from the athlete's current one, so the common case stays one clean line (#5).
      needs.forEach(function (x) {
        var gv = (x.goal && x.goal.variant) ? ' — ' + x.goal.variant : '';
        // L242: a non-hinge need states its GOAL without a level label.
        var lbl = (x.hinge === false) ? 'goal: ' : ('pass ' + x.level + ': ');
        var gap = (x.goal) ? (lbl + (x.goal.load != null ? x.goal.load + ' lb × ' + x.goal.reps : x.goal.reps + ' reps') + gv)
                           : (x.hinge === false ? '—' : 'L' + x.level);
        cN.appendChild(row(x, gap)); });
      var up = lev.filter(function (x) { return !x.maxed && x.to_go > 0; }).sort(function (a, b) { return (b.progress || 0) - (a.progress || 0); })[0];
      if (up && up.goal) cN.appendChild(row(up, (up.hinge === false ? 'next goal: ' : 'next level up: ') + (up.goal.load != null ? up.goal.load + ' lb × ' + up.goal.reps + ' needed' : up.goal.reps + ' reps needed') + (up.goal.variant ? ' — ' + up.goal.variant : '')));
      out.push(cN);
    }
    return out;
  }
  // R412 (Phil's ruling, executed 2026-08-24): 'Recent wins' is DELETED — it contradicted the
  // R109 feed and the recency law says the deletion wins. The PR star on the tonnage graph and the
  // finish-screen highlight are the wins surfaces; payload.wins is no longer read by anything.
  // R639 BLOCKS REBUILD (Phil's spec, design/PROFILE-SPEC-R639.md): FOUR blocks, top to bottom,
  // NOTHING else — 0 Tell Coach · 1 Where You Stand · 2 Strongest Right Now · 3 Biggest Needs.
  // Blocks 1-3 are ONE component (profileRow) sorted three ways over the same data: same row, same
  // numbers, same click target, same detail page — built as three components they would disagree,
  // which is the defect class the rebuild exists to kill. DELETED: the aggregate volume graph and
  // Recent Wins ("the graphs are the wins"); no aggregate number anywhere; the quality-ladder bars
  // and the standalone clock card fold away — each region header now carries its own clock line.
  // Row format (D6): VARIANT — L<level>, variant only, never the parent, never both.
  // "2.2" -> rung order 5. The ladder vocabulary is 3 sub-levels per level, so the mapping is
  // arithmetic — the same one the server's _levelOrder_ applies (rule 16: derived, not re-invented).
  function levelOrderOf(lv) {
    var m = String(lv == null ? '' : lv).match(/^(\d+)\.(\d)/);
    return m ? (Number(m[1]) - 1) * 3 + Number(m[2]) : null;
  }
  function profileRow(x, opts) {
    var wrap = el('div', 'p-rowwrap');
    var row = el('button', 'p-row'); row.type = 'button';
    var l1 = el('div', 'p-row-1');
    // C40: the first layer is the Level Standards COLUMN C PARENT, sheet-spelled — x.exercise IS
    // that string verbatim (the band match is exact and case-sensitive), so a laddered row renders
    // it as-is; the live variant is one tap in (the detail's dropdown title). Non-laddered rows
    // have no column C parent and keep their own display name (C32b dash strip stays there).
    var ladRow = x.level != null && x.level !== '';
    l1.appendChild(el('span', 'p-row-n', ladRow ? String(x.exercise || x.name)
                                                : String(titleName(x.variant || x.name)).replace(/^\s*-\s*/, '')));
    // C38: every laddered row carries its OWN ladder bar — the Where You Stand track one level down.
    // Scale = this exercise's full ladder (top_level, never an assumed 9); ticks per rung, heavier at
    // level boundaries; fill = rung + clearance fraction, the same math the category bars use.
    // R661 item 4 (Phil 2026-08-28): "Bars exist at category level only — never inside the drill,
    // so category-bars and exercise-bars can't be confused." A drill row renders NO bar; the C38
    // bars on Strongest/Needs stand (his sentence scopes the drill). Reversing line: drop `!drill`.
    var drill = !!(opts && opts.drill);
    var ordR = levelOrderOf(x.level);
    if (ordR != null && !drill) {
      var topR = levelOrderOf(x.top_level); if (topR == null || topR < ordR) topR = Math.max(ordR, 9);
      var trk = el('div', 'p-row-track');
      for (var ti = 1; ti < topR; ti++) {
        var tk2 = el('div', 'p-row-tick' + (ti % 3 === 0 ? ' block' : ''));
        tk2.style.left = (ti / topR * 100) + '%'; trk.appendChild(tk2);
      }
      var posR = x.maxed ? topR : Math.min(topR, ordR + (Number(x.progress) || 0));
      var fl = el('div', 'p-row-fill'); fl.style.width = (posR / topR * 100) + '%';
      trk.appendChild(fl);
      l1.classList.add('bar');
      l1.appendChild(trk);
    }
    if (x.level != null && x.level !== '') {
      var bd = el('span', 'p-row-l', 'L' + x.level);
      bd.appendChild(el('span', 'p-row-chev', '▾'));
      l1.appendChild(bd);
    } else {
      l1.appendChild(el('span', 'p-row-chev', '▾'));
    }
    row.appendChild(l1);
    // BIGGEST NEEDS rows carry the target in ONE format, every row — "goal:" and nothing else.
    if (opts && opts.goal && x.goal && (x.goal.load != null || x.goal.reps != null)) {
      row.appendChild(el('div', 'p-row-goal', x.goal.load != null
        ? 'goal: ' + x.goal.load + ' lb × ' + x.goal.reps
        : 'goal: ' + x.goal.reps + ' reps'));
    }
    var det = el('div', 'p-detail'); det.style.display = 'none'; det._loaded = false;
    row.addEventListener('click', function () {
      var open = det.style.display !== 'none';
      det.style.display = open ? 'none' : 'block';
      if (!open && !det._loaded) { det._loaded = true; loadProfileDetail(x, det); }
    });
    // R661 item 4: inside the category drill an exercise opens ALREADY EXPANDED to its line graph
    // (session lists stay collapsed — the detail's own default). The drill calls this on category
    // open, so nothing fetches for categories never opened; item 1's cache makes re-opens instant.
    wrap._openDetail = function () {
      if (det.style.display !== 'none') return;
      det.style.display = 'block';
      if (!det._loaded) { det._loaded = true; loadProfileDetail(x, det); }
    };
    wrap.appendChild(row); wrap.appendChild(det);
    return wrap;
  }
  function renderProfile(list, summary, categories, clocks, payload) {
    SESSION = null; app.innerHTML = '';
    meta.textContent = athlete + ' · your progress';
    if (!list.length) { app.appendChild(el('p', 'empty', 'No exercises yet.')); return; }

    // ── 0. TELL COACH — it writes to the coach, so it leads (R085; spec block 0).
    var tc = el('div', 'tellcoach');
    tc.appendChild(el('div', 'p-block-h', 'Tell coach'));
    var tcRow = el('div', 'tc-row');
    function tcSend(kind, detail) {
      fetch(cfg.WEBAPP_URL + '?action=report&athlete=' + encodeURIComponent(athlete) +
            '&token=' + encodeURIComponent(token) + '&kind=' + kind + '&detail=' + encodeURIComponent(detail))
        .then(function (r) { return r.json(); })
        .then(function (d) { show(d && d.ok ? 'Sent to coach 👍' : 'Could not send — try again'); })
        .catch(function () { show('Offline — try again when connected'); });
    }
    var tb1 = el('button', 'tc-btn', '🚑 New pain or injury'); tb1.type = 'button';
    tb1.addEventListener('click', function () {
      var w = window.prompt('Where does it hurt? (e.g. left knee)');
      if (w && w.trim()) tcSend('injury', w.trim());
    });
    var tb2 = el('button', 'tc-btn', '📅 Fewer days this week'); tb2.type = 'button';
    tb2.addEventListener('click', function () {
      // R884 LIFE HAPPENS (Phil's ruled L319 exception — the athlete's own tap is the human word):
      // this used to only send a note; it now REBUILDS the rest of the round at the new count on
      // the server's judged path (done sessions untouched; a refused rebuild changes nothing and
      // says so). Same prompt idiom as the rest of Tell Coach; the confirm carries Phil's own
      // sheet wording.
      var n = window.prompt('How many days can you train this week? (0 ends this round early)');
      if (n == null || n.trim() === '') return;
      var nd = parseInt(n.trim(), 10);
      if (isNaN(nd) || nd < 0 || nd > 6) { show('Enter a number of days, 0-6.'); return; }
      if (!window.confirm('Train ' + nd + ' day(s) this week? This rebuilds your remaining sessions. Workouts you already finished don’t change.')) return;
      show('Rebuilding your week…');
      fetch(cfg.WEBAPP_URL, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify({ action: 'lifehappens', athlete: athlete, token: token, new_days: nd }) })
        .then(function (r) { return r.json(); })
        .then(function (d) {
          if (d && d.ok) { show('Done — your week is updated 👍'); setTimeout(function () { try { location.reload(); } catch (e) {} }, 900); }
          else if (d && d.result && /REFUSED/.test(d.result)) { show('Could not rebuild — nothing was changed. Your coach can see why.'); tcSend('days', 'asked for ' + nd + ' day(s); the rebuild refused'); }
          else { show('Could not send — try again'); }
        })
        .catch(function () { show('Offline — try again when connected'); });
    });
    tcRow.appendChild(tb1); tcRow.appendChild(tb2);
    tc.appendChild(tcRow);
    app.appendChild(tc);

    // ONE dataset, three sorts (+ the quality grouping the ladder bars read).
    var laddered = [], other = [];
    list.forEach(function (x) {
      if (x.level != null && x.level !== '') laddered.push(x); else other.push(x);
    });
    var lvlAsc = function (a, b) {
      var la = parseFloat(a.level), lb = parseFloat(b.level);
      if (la !== lb) return la - lb;
      return (a.progress || 0) - (b.progress || 0);
    };
    var QKEYS = ['Upper Body Max', 'Lower Body Max', 'Upper Body Relative', 'Lower Body Relative',
                 'Upper Body Str Endurance', 'Lower Body Str Endurance'];
    var byQuality = {};
    list.forEach(function (x) {
      if (x.quality && QKEYS.indexOf(x.quality) >= 0) (byQuality[x.quality] || (byQuality[x.quality] = [])).push(x);
    });
    Object.keys(byQuality).forEach(function (k) { byQuality[k].sort(lvlAsc); });

    // C32c: the minus renders as words, with the rewritten copy behind the ⓘ (the spec's LEVELING
    // CLOCK language). C42 (superseding C37's in-drill placement): the clock is per-SIDE machinery
    // (two clocks, L137) — inside any one category it reads as missing from the other two, so it is
    // its OWN section, two rows, directly below Tell Coach. The gating lift names itself in the
    // tooltip, never on the row.
    var MINUS_COPY = 'you moved up without passing yet — pass at this level and it sticks; three rounds without a pass returns you to the previous sub-level.';
    function clockRowFor(c) {
      if (!c) return null;
      var sideWord = c.side === 'LE' ? 'Lower body' : c.side === 'UE' ? 'Upper body' : String(c.side || '');
      var base = (!c.at_top && c.round != null && c.of != null && c.level != null && Number(c.round) <= Number(c.of))
        ? 'Round ' + c.round + ' of ' + c.of + ' at ' + String(c.level).replace(/-$/, '')
        : (c.english ? String(c.english).replace(/^LE:\s*/, '').replace(/^UE:\s*/, '').replace(/-$/, '') : null);
      if (!base) return null;
      var row = el('div', 'p-clkrow');
      row.appendChild(el('span', 'p-clkrow-side', sideWord));
      row.appendChild(el('span', 'p-clkrow-txt', base + (c.minus ? ' · not passed yet' : '')));
      var tip = (c.gate ? 'Gating lift: ' + c.gate + '.' : '') + (c.minus ? (c.gate ? ' ' : '') + MINUS_COPY : '');
      if (tip) {
        var mb = el('button', 'p-info'); mb.type = 'button'; mb.textContent = 'ⓘ';
        var note = el('div', 'p-clk-n', tip); note.hidden = true;
        mb.addEventListener('click', function (ev) { ev.stopPropagation(); note.hidden = !note.hidden; });
        row.appendChild(mb); row.appendChild(note);
      }
      return row;
    }
    var ckSec = el('section', 'p-block clocks');
    (clocks || []).forEach(function (c) { var r = clockRowFor(c); if (r) ckSec.appendChild(r); });
    if (ckSec.children.length) app.appendChild(ckSec);

    // ── 2. WHERE YOU STAND — the quality-ladder BARS, restored exactly (C30: they were never on
    // the delete list; unnamed is unbuilt applies to deletions too). The bars are the whole block;
    // the lift lists live one tap down (C31), clocks with them.
    var laddered2 = categories && categories.length >= 3;
    if (laddered2) {
      app.appendChild(ladderCard(categories, byQuality));
    }

    // ── 3. STRONGEST RIGHT NOW — the top of the same list.
    var strongest = laddered.slice().sort(lvlAsc).slice(-3).reverse();
    if (strongest.length) {
      var b2 = el('section', 'p-block strong');
      b2.appendChild(el('div', 'p-block-h', 'Strongest right now'));
      strongest.forEach(function (x) { b2.appendChild(profileRow(x)); });
      app.appendChild(b2);
    }

    // ── 4. BIGGEST NEEDS — the bottom of the same list, each with its goal.
    var needs = laddered.slice().sort(lvlAsc).slice(0, 3);
    if (needs.length) {
      var b3 = el('section', 'p-block needs');
      b3.appendChild(el('div', 'p-block-h', 'Biggest needs'));
      needs.forEach(function (x) { b3.appendChild(profileRow(x, { goal: true })); });
      app.appendChild(b3);
    }

    // Lifts outside the six qualities + non-laddered work — kept, never hidden (only the aggregate
    // graph and Recent Wins were ever on the delete list). Collapsed, same row, same detail.
    var inQuality = {};
    Object.keys(byQuality).forEach(function (k) { byQuality[k].forEach(function (x) { inQuality[x.exercise] = 1; }); });
    var rest = list.filter(function (x) { return !inQuality[x.exercise]; }).sort(lvlAsc);
    if (!laddered2) rest = list.slice().sort(lvlAsc);   // no bars renderable: nothing may strand
    if (rest.length) {
      var togg = el('button', 'p-more', 'Other work (' + rest.length + ') ▾'); togg.type = 'button';
      var wrap2 = el('div', 'p-rest'); wrap2.hidden = true;
      rest.forEach(function (x) { wrap2.appendChild(profileRow(x)); });
      togg.addEventListener('click', function () {
        wrap2.hidden = !wrap2.hidden;
        togg.textContent = wrap2.hidden ? 'Other work (' + rest.length + ') ▾' : 'Other work (' + rest.length + ') ▴';
      });
      app.appendChild(togg); app.appendChild(wrap2);
    }

    // R607: the build this device runs, one muted line — the debug footer survives the rebuild.
    app.appendChild(el('div', 'build-id', 'build ' + APP_BUILD));
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

  // R631 (Grace 2026-08-26, defect 1 — "worst defect this system has produced"): calendar → workout
  // tap → BLANK, three times, force-closed, and her phone reported NOTHING. Two stranding paths,
  // both closed here, both journey-proven (j34):
  //   1. no cached session + a HUNG backend (a freshly-deployed cold Apps Script): 'Loading…' sat
  //      forever with no timeout, no retry control, no error report — invisible to ErrorLog.
  //   2. a cached session whose render() THROWS (corrupt/interrupted cache write): the screen was
  //      cleared, the exception killed the paint, and nothing ever drew again.
  // The law: a workout tap ALWAYS ends in either the workout or an actionable retry card, and the
  // failure reports itself. Retry discards the cached copy first, so a corrupt cache self-heals.
  function showRetryCard(sessionId, msg) {
    app.innerHTML = '';
    // 'slowload', NOT 'err': journey helpers (and any future code) treat '.err' as a terminal
    // screen; this card is a live state with a pending fetch that may still repaint the workout.
    app.appendChild(el('p', 'slowload', msg));
    var b = el('button', 'retry-open', 'Try again'); b.type = 'button';
    b.addEventListener('click', function () {
      try { localStorage.removeItem(sessCacheKey(sessionId)); } catch (e) {}
      openSession(sessionId);
    });
    app.appendChild(b);
  }
  function safeRender(s, sessionId) {
    try { render(s); return true; }
    catch (e) {
      reportError('render_crash', (e && e.message) || String(e), 'openSession ' + sessionId, e && e.stack);
      showRetryCard(sessionId, 'Something went wrong showing this workout.');
      return false;
    }
  }
  // 20s, not 8: a COLD session build legitimately takes ~11.2s (measured, the INSTANT OPEN note
  // below) — an 8s watchdog showed the card on every cold open. 20s clears the honest cold path
  // and still bounds the minutes-long hang Grace hit. The pending fetch stays alive under the card:
  // a late success repaints the workout (screenTouched is false on the card).
  var OPEN_WATCHDOG_MS = 20000;
  function openSession(sessionId) {
    var _screen = newScreen();   // claims the screen: a pending calendar/profile draw must not win
    primeAudio();                // the session-start TAP is the gesture iOS unlocks audio on (L124)
    try { sessionStorage.setItem('bp_open_session', sessionId); } catch (e) {}
    var cached = cachedSession(sessionId);
    var painted = cached ? safeRender(cached, sessionId) : false;
    if (!cached) show('Loading…');
    var settled = false;
    if (!painted) {
      setTimeout(function () {
        if (settled || !isCurrent(_screen)) return;
        reportError('workout_open_slow', 'session fetch still pending after ' + OPEN_WATCHDOG_MS + 'ms', sessionId, '');
        showRetryCard(sessionId, 'Your workout is taking too long to load.');
      }, OPEN_WATCHDOG_MS);
    }
    fetchJson(cfg.WEBAPP_URL + '?action=session&athlete=' + encodeURIComponent(athlete) + '&session_id=' + encodeURIComponent(sessionId) + '&token=' + encodeURIComponent(token))
      .then(function (data) {
        settled = true;
        if (data && data.ok && data.session) cacheSession(sessionId, data.session);
        if (!isCurrent(_screen)) return;   // athlete moved on; the cache above still updated
        if (data && (data.error === 'offline' || data.error === 'server')) {
          if (!painted) show(data.error === 'server' ? SERVER_HICCUP : 'Offline — reconnect to open this workout.', 'err');
          return;
        }
        if (!data.ok || !data.session) { if (!painted) show('No workout that day.'); return; }
        // Re-render unless the athlete is actively logging over a cached paint. BUT a reopened session
        // the SERVER already has logged sets for must always show its review state — the stale cached
        // paint (from before those sets landed) is why 7/27 opened blank after logging (Phil, 2026-07-27).
        // The render merges LOCAL_DONE, so in-progress local work is not lost by repainting.
        var srvLogged = (data.session.slots || []).some(function (sl) {
          return (sl.exercises || []).some(function (e) { return e.logged && Object.keys(e.logged).length; });
        });
        if (!painted || !screenTouched() || srvLogged) safeRender(data.session, sessionId);
        else if (typeof CHAIN === 'object') {
          // R685 (Phil's 2026-08-29 session): when the athlete is already logging over a cached
          // paint, the fresh render is lawfully skipped — but the SCALARS the chain reads must not
          // stay stale. His pre-@626 cached payload had no switch_s, so CHAIN.switchS held 0 for
          // the whole session and every between-complex gap ran trailing-rest-only. Adopting the
          // scalar is safe without a repaint: nothing rendered depends on it.
          CHAIN.switchS = Number(data.session.switch_s || 0);
        }
      });
  }

  // R533 slice 3 — RECOVER BEFORE THE FIRST PAINT, not after. `load()` (:2553) restores an
  // interrupted workout SYNCHRONOUSLY from cache, so a seed that lands afterwards would arrive at a
  // row that has already re-rendered at its prescription. `.then(load, load)` runs load on either
  // outcome: a broken or slow IndexedDB delays the paint by one small read and can never block it.
  seedFromQueue().then(load, load);
  updateBadge().then(drain);
})();
