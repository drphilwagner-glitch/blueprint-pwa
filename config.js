// Deployed Apps Script Web App exec URL. Filled in at deploy time (S8 enablement / rollout).
// Until set, the app shows a clear "not configured" message instead of failing silently.
window.BP_CONFIG = {
  WEBAPP_URL: 'https://script.google.com/macros/s/AKfycbxunaq6uMY3iFZ0ky3iArBHM2UZrwyY9JzD-dipFMsAbl_OAtWwTa_l4GO_WAax__T0Vg/exec',
  // R1720 (D68, 2026-10-30): the LOG DOOR — a second deployment of the same engine carrying only what a save can reach
  // (~196 KB against the kid's door's 1.62 MB), so the platform hop a kid pays on every logged set is the small
  // project's. ONLY the log POST goes here (pwa/app.js logUrl); every read and every other write keeps WEBAPP_URL.
  // Reversing line: delete this key — app.js falls back to WEBAPP_URL by construction.
  LOG_URL: 'https://script.google.com/macros/s/AKfycbwYLKGIulapnfRf9o1QJdlc5Ax2hSvu7mYms8l18I46aaegrqtaanAZ4WhMxUlfrqzFiA/exec'
};
