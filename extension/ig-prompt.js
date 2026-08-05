// Runs on instagram.com. Once you're logged in, offers to connect that
// account to QuickAds — this is the popup that appears after login.

(function () {
  'use strict';

  if (window.top !== window) return;          // skip iframes
  if (document.getElementById('quickads-connect-card')) return;

  // Same MV3 wake-up retry as the app bridge: the service worker may be asleep.
  const ask = (message, attempt = 0) => new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    try {
      chrome.runtime.sendMessage(message, (r) => {
        const err = chrome.runtime.lastError;
        if (err) {
          const msg = err.message || '';
          if (/context invalidated|Extension context/i.test(msg)) return done({ ok: false, error: 'EXT_RELOADED' });
          if (attempt < 3 && /Receiving end does not exist|message port closed/i.test(msg)) {
            return setTimeout(() => ask(message, attempt + 1).then(done), 150 * (attempt + 1));
          }
          return done({ ok: false, error: msg });
        }
        done(r || { ok: false });
      });
    } catch (err) { done({ ok: false, error: err.message }); }
    setTimeout(() => done({ ok: false, error: 'timeout' }), 8000);
  });

  function card() {
    const el = document.createElement('div');
    el.id = 'quickads-connect-card';
    el.style.cssText = [
      'position:fixed', 'right:20px', 'bottom:20px', 'z-index:2147483647',
      'width:330px', 'padding:16px 18px', 'border-radius:14px',
      'background:#12141a', 'color:#e7ebf0', 'border:1px solid #2a2f3a',
      'box-shadow:0 12px 40px rgba(0,0,0,.45)',
      'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif',
      'font-size:14px', 'line-height:1.5',
    ].join(';');

    el.innerHTML = `
      <div style="display:flex;align-items:center;gap:9px;font-weight:700;margin-bottom:6px;">
        <span style="width:9px;height:9px;border-radius:50%;background:#c3f53c;display:inline-block;"></span>
        QuickAds
      </div>
      <div id="qa-msg" style="color:#aab2c0;margin-bottom:14px;">
        You're logged into Instagram. Connect this account so QuickAds can send your DMs.
      </div>
      <div style="display:flex;gap:8px;">
        <button id="qa-connect" style="flex:1;padding:9px 12px;border:0;border-radius:9px;
          background:#c3f53c;color:#0f1115;font-weight:700;font-size:13px;cursor:pointer;">
          Connect Instagram
        </button>
        <button id="qa-later" style="padding:9px 12px;border:1px solid #2a2f3a;border-radius:9px;
          background:transparent;color:#aab2c0;font-size:13px;cursor:pointer;">
          Not now
        </button>
      </div>`;
    return el;
  }

  async function maybeShow() {
    const status = await ask({ type: 'GET_STATUS' });
    if (!status.ok || !status.loggedIn) return;      // not logged in yet
    if (status.connectedAt) return;                  // already connected
    if (!status.appOrigin) return;                   // app never opened, nothing to connect to

    const { promptDismissedAt } = await chrome.storage.local.get('promptDismissedAt');
    // Respect "Not now" for an hour.
    if (promptDismissedAt && Date.now() - promptDismissedAt < 60 * 60 * 1000) return;

    const el = card();
    document.body.appendChild(el);

    el.querySelector('#qa-later').addEventListener('click', async () => {
      await ask({ type: 'DISMISS_PROMPT' });
      el.remove();
    });

    el.querySelector('#qa-connect').addEventListener('click', async () => {
      const btn = el.querySelector('#qa-connect');
      btn.disabled = true;
      btn.textContent = 'Connecting…';
      const res = await ask({ type: 'CONNECT_FROM_INSTAGRAM' });
      if (res.ok) {
        el.querySelector('#qa-msg').textContent = 'Opening QuickAds to finish connecting…';
        setTimeout(() => el.remove(), 2500);
      } else {
        el.querySelector('#qa-msg').textContent = res.error || 'Could not connect.';
        btn.disabled = false;
        btn.textContent = 'Try again';
      }
    });
  }

  // Instagram is a single-page app, so the session can appear well after load.
  maybeShow();

  // Poll for a while (covers the usual "log in, land on the feed" flow)…
  let tries = 0;
  const timer = setInterval(() => {
    if (++tries > 20 || document.getElementById('quickads-connect-card')) return clearInterval(timer);
    maybeShow();
  }, 3000);

  // …and, more reliably, react the moment the background sees the session
  // cookie appear. This catches logins that finish long after page load.
  try {
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      if (msg && msg.type === 'IG_LOGGED_IN') {
        maybeShow();
        sendResponse({ ok: true });
      }
      return true;
    });
  } catch (_) {}

  // Coming back to the tab is another good moment to check.
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) maybeShow();
  });
})();
