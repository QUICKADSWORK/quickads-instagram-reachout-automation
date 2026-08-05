// Runs on the QuickAds app page. Lets the page know the helper is installed
// and hands over the Instagram cookies when the user asks to connect.
//
// The page then saves them with a normal same-origin request, which is why
// there's no pairing code and no app URL to type in.

(function () {
  'use strict';

  // Only act on a real QuickAds page.
  if (!document.querySelector('meta[name="quickads-app"]')) return;

  const ORIGIN = window.location.origin;

  function toPage(payload) {
    window.postMessage({ source: 'quickads-extension', ...payload }, ORIGIN);
  }

  // MV3 service workers are shut down when idle. The first message after that
  // can come back "Receiving end does not exist" while Chrome is still waking
  // it, so retry briefly. A hard timeout guarantees we never hang the UI.
  function ask(message, attempt = 0) {
    return new Promise((resolve) => {
      let settled = false;
      const done = (v) => { if (!settled) { settled = true; resolve(v); } };

      try {
        chrome.runtime.sendMessage(message, (r) => {
          const err = chrome.runtime.lastError;
          if (err) {
            const msg = err.message || '';
            // The extension was reloaded/updated — this script is orphaned.
            if (/context invalidated|Extension context/i.test(msg)) {
              return done({ ok: false, error: 'EXT_RELOADED' });
            }
            if (attempt < 3 && /Receiving end does not exist|message port closed/i.test(msg)) {
              return setTimeout(
                () => ask(message, attempt + 1).then(done),
                150 * (attempt + 1)
              );
            }
            return done({ ok: false, error: msg });
          }
          done(r || { ok: false, error: 'No response from the helper.' });
        });
      } catch (err) {
        if (/context invalidated|Extension context/i.test(err.message || '')) {
          return done({ ok: false, error: 'EXT_RELOADED' });
        }
        return done({ ok: false, error: err.message });
      }

      setTimeout(() => done({ ok: false, error: 'The helper did not respond in time.' }), 8000);
    });
  }

  function reportError(res, fallback) {
    if (res && res.error === 'EXT_RELOADED') {
      toPage({ type: 'QUICKADS_EXT_ERROR', error: 'The helper was updated. Refresh this page.', needsReload: true });
      return true;
    }
    toPage({ type: 'QUICKADS_EXT_ERROR', error: (res && res.error) || fallback });
    return false;
  }

  async function announce() {
    const res = await ask({ type: 'REGISTER_APP', origin: ORIGIN });
    // Even if the worker hiccuped, the helper *is* present on this page — say
    // so, and report the login as unknown rather than silently doing nothing.
    toPage({
      type: 'QUICKADS_EXT_STATUS',
      installed: true,
      version: res.version || null,
      loggedIn: !!res.loggedIn,
      missing: res.missing || [],
      approved: !!res.approved,
    });
    return res;
  }

  // The actual connect: approve this site once, fetch cookies, hand to page.
  async function connect() {
    const status = await ask({ type: 'GET_STATUS' });
    if (!status.ok) {
      reportError(status, 'Helper not responding.');
      return;
    }
    if (!status.loggedIn) {
      toPage({
        type: 'QUICKADS_EXT_ERROR',
        error: 'You are not logged into Instagram in this browser. Open instagram.com, log in, then try again.',
        needsLogin: true,
      });
      return;
    }

    // One-time approval per site, so a random page can't grab the cookies.
    const reg = await ask({ type: 'REGISTER_APP', origin: ORIGIN });
    if (!reg.approved) {
      const ok = window.confirm(
        `Allow the QuickAds helper to send your Instagram login to:\n\n${ORIGIN}\n\n` +
        `Only approve this if it's your own QuickAds app.`
      );
      if (!ok) {
        toPage({ type: 'QUICKADS_EXT_ERROR', error: 'Connection cancelled.' });
        return;
      }
      await ask({ type: 'APPROVE_ORIGIN', origin: ORIGIN });
    }

    const res = await ask({ type: 'GET_COOKIES', origin: ORIGIN });
    if (!res.ok || !Array.isArray(res.cookies) || !res.cookies.length) {
      reportError(res, 'Could not read the Instagram session.');
      return;
    }
    toPage({ type: 'QUICKADS_EXT_COOKIES', cookies: res.cookies });
  }

  // Background → bridge: the user pressed Connect over on Instagram and this
  // tab is already open, so connect right here without reloading the page.
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg && msg.type === 'DO_CONNECT') {
      toPage({ type: 'QUICKADS_EXT_AUTOCONNECT' });
      connect();
      sendResponse({ ok: true });
    }
    return true;
  });

  // Page → extension
  window.addEventListener('message', async (event) => {
    if (event.source !== window || event.origin !== ORIGIN) return;
    const data = event.data;
    if (!data || data.source !== 'quickads-page') return;

    if (data.type === 'QUICKADS_REQUEST_STATUS') announce();
    if (data.type === 'QUICKADS_REQUEST_CONNECT') connect();
    if (data.type === 'QUICKADS_CONNECTED') {
      ask({ type: 'MARK_CONNECTED', account: data.account || null });
    }
    // The app deleted its stored session, so we're not connected any more.
    if (data.type === 'QUICKADS_DISCONNECTED') {
      ask({ type: 'MARK_DISCONNECTED' });
    }
  });

  // Announce on load, then auto-connect if the user pressed Connect over on
  // Instagram (that flow parks a flag and sends them here).
  (async function init() {
    await announce();
    const pending = await ask({ type: 'TAKE_PENDING' });
    if (pending && pending.pending) {
      toPage({ type: 'QUICKADS_EXT_AUTOCONNECT' });
      connect();
    }
  })();
})();
