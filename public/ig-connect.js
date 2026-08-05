// Shared Instagram-connect bridge client.
//
// Loaded on every app page so the browser helper can connect from wherever the
// user happens to be — not just the Negotiate page. Pages that want to render
// their own UI set `QuickAdsIG.onChange`.
(function () {
  'use strict';

  const ORIGIN = window.location.origin;

  const state = {
    installed: false,
    version: null,
    loggedIn: false,
    connected: false,
    busy: false,
    lastError: null,
  };

  function notify() {
    if (typeof QuickAdsIG.onChange === 'function') {
      try { QuickAdsIG.onChange(state); } catch (_) {}
    }
  }

  // Use whichever toast the current page happens to have.
  function toast(msg, ms = 4000) {
    const box = document.getElementById('toast') || document.getElementById('dmToast');
    const text = document.getElementById('toastMessage') || document.getElementById('dmToastMessage');
    if (!box || !text) return;
    text.textContent = msg;
    box.classList.add('show');
    setTimeout(() => box.classList.remove('show'), ms);
  }

  function toExtension(payload) {
    window.postMessage({ source: 'quickads-page', ...payload }, ORIGIN);
  }

  function finishBusy(err) {
    state.busy = false;
    state.lastError = err || null;
    notify();
  }

  // Ask the server whether a usable session is already stored.
  async function refreshServerState() {
    try {
      const r = await fetch('/api/settings/cookies');
      const d = await r.json();
      state.connected = !!(d.hasCookies && d.valid);
    } catch (_) { /* leave as-is */ }
    notify();
    return state.connected;
  }

  window.addEventListener('message', async (event) => {
    if (event.source !== window || event.origin !== ORIGIN) return;
    const data = event.data;
    if (!data || data.source !== 'quickads-extension') return;

    if (data.type === 'QUICKADS_EXT_STATUS') {
      state.installed = true;
      state.version = data.version || null;
      state.loggedIn = !!data.loggedIn;
      refreshServerState();
    }

    if (data.type === 'QUICKADS_EXT_AUTOCONNECT') {
      state.busy = true;
      notify();
      toast('Connecting your Instagram…');
      if (typeof QuickAdsIG.onAutoConnect === 'function') {
        try { QuickAdsIG.onAutoConnect(); } catch (_) {}
      }
    }

    if (data.type === 'QUICKADS_EXT_ERROR') {
      if (data.needsLogin) state.loggedIn = false;
      if (data.needsReload) {
        toast('The helper was updated — please refresh this page.', 8000);
      } else {
        toast(data.error || 'The helper could not connect.', 7000);
      }
      finishBusy(data.error || 'Connection failed.');
    }

    // Cookies arrived — save them with a normal same-origin request.
    if (data.type === 'QUICKADS_EXT_COOKIES' && Array.isArray(data.cookies)) {
      try {
        const res = await fetch('/api/settings/cookies', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ cookies: data.cookies }),
        });
        const out = await res.json().catch(() => ({}));
        if (res.ok) {
          state.connected = true;
          state.loggedIn = true;   // we just read a live session out of this browser
          toExtension({ type: 'QUICKADS_CONNECTED' });
          // Re-ask the helper too, so the checklist reflects the browser rather
          // than whatever was true when the page first loaded.
          toExtension({ type: 'QUICKADS_REQUEST_STATUS' });
          toast('✓ Instagram connected — ready for outreach', 5000);
          finishBusy(null);
          refreshServerState();
        } else {
          toast(out.error || 'Could not save the Instagram session.', 7000);
          finishBusy(out.error || 'Save failed.');
        }
      } catch (err) {
        toast('Could not save the session: ' + err.message, 7000);
        finishBusy(err.message);
      }
    }
  });

  const QuickAdsIG = {
    state,
    onChange: null,
    onAutoConnect: null,
    refreshServerState,

    // Forget the last failure, so a fresh attempt isn't judged by an old one.
    clearError() { state.lastError = null; },

    requestStatus() {
      toExtension({ type: 'QUICKADS_REQUEST_STATUS' });
      refreshServerState();
      // If the helper never answers, it isn't installed on this page.
      setTimeout(() => { if (!state.installed) notify(); }, 1200);
    },

    connect() {
      if (state.busy) return;
      state.busy = true;
      state.lastError = null;
      notify();
      toExtension({ type: 'QUICKADS_REQUEST_CONNECT' });
      // Never leave the UI spinning forever if the helper goes quiet.
      setTimeout(() => {
        if (state.busy) {
          toast('The helper did not respond. Refresh the page and try again.', 7000);
          finishBusy('No response from the helper.');
        }
      }, 20000);
    },
  };

  window.QuickAdsIG = QuickAdsIG;

  // Kick off detection as soon as the page is ready.
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => QuickAdsIG.requestStatus());
  } else {
    QuickAdsIG.requestStatus();
  }
})();
