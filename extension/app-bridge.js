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

  function ask(message) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(message, (r) => {
          if (chrome.runtime.lastError) return resolve({ ok: false, error: chrome.runtime.lastError.message });
          resolve(r || { ok: false, error: 'No response from the helper.' });
        });
      } catch (err) {
        resolve({ ok: false, error: err.message });
      }
    });
  }

  async function announce() {
    const res = await ask({ type: 'REGISTER_APP', origin: ORIGIN });
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
      toPage({ type: 'QUICKADS_EXT_ERROR', error: status.error || 'Helper not responding.' });
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
    if (!res.ok) {
      toPage({ type: 'QUICKADS_EXT_ERROR', error: res.error || 'Could not read the Instagram session.' });
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
