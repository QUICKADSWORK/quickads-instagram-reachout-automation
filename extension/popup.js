// QuickAds — Instagram Connect extension popup.
// Reads only the 3 required Instagram cookies and POSTs them to the app's
// /api/settings/cookies/import endpoint together with a one-time pairing code.

const REQUIRED = ['sessionid', 'ds_user_id', 'csrftoken'];
const IG_URL = 'https://www.instagram.com';

const $ = (id) => document.getElementById(id);
const appUrlInput = $('appUrl');
const codeInput = $('code');
const connectBtn = $('connect');
const statusEl = $('status');
const igDot = $('igDot');

function setStatus(msg, kind) {
  statusEl.textContent = msg;
  statusEl.className = 'status show ' + (kind || 'info');
}

// Restore last-used app URL.
chrome.storage.local.get(['appUrl'], (r) => {
  if (r.appUrl) appUrlInput.value = r.appUrl;
});

// Read a single cookie by name from the Instagram domain.
function getCookie(name) {
  return new Promise((resolve) => {
    chrome.cookies.get({ url: IG_URL, name }, (c) => resolve(c || null));
  });
}

// Live indicator: is the user logged into Instagram right now?
(async () => {
  const sid = await getCookie('sessionid');
  igDot.className = sid && sid.value ? 'dot on' : 'dot';
})();

function normalizeUrl(raw) {
  let u = (raw || '').trim().replace(/\/+$/, '');
  if (u && !/^https?:\/\//i.test(u)) u = 'https://' + u;
  return u;
}

async function ensureHostPermission(appUrl) {
  try {
    const origin = new URL(appUrl).origin + '/*';
    const has = await chrome.permissions.contains({ origins: [origin] });
    if (has) return true;
    return await chrome.permissions.request({ origins: [origin] });
  } catch (_) {
    return false;
  }
}

connectBtn.addEventListener('click', async () => {
  const appUrl = normalizeUrl(appUrlInput.value);
  const code = codeInput.value.trim();

  if (!appUrl) return setStatus('Enter your app URL.', 'err');
  if (!code) return setStatus('Enter the pairing code from the app.', 'err');

  connectBtn.disabled = true;
  setStatus('Reading Instagram session…', 'info');

  try {
    chrome.storage.local.set({ appUrl });

    const granted = await ensureHostPermission(appUrl);
    if (!granted) {
      setStatus('Permission to reach your app was denied.', 'err');
      connectBtn.disabled = false;
      return;
    }

    // Collect only the required cookies.
    const cookies = [];
    for (const name of REQUIRED) {
      const c = await getCookie(name);
      if (c && c.value) {
        cookies.push({
          name: c.name,
          value: c.value,
          domain: c.domain || '.instagram.com',
          path: c.path || '/',
          secure: c.secure !== false,
          httpOnly: !!c.httpOnly,
          sameSite: c.sameSite || 'Lax',
          ...(c.expirationDate ? { expirationDate: c.expirationDate } : {}),
        });
      }
    }

    const missing = REQUIRED.filter((n) => !cookies.some((c) => c.name === n));
    if (missing.length) {
      setStatus(`Not logged into Instagram (missing: ${missing.join(', ')}). Open instagram.com, log in, then retry.`, 'err');
      connectBtn.disabled = false;
      return;
    }

    setStatus('Sending to your app…', 'info');
    const res = await fetch(`${appUrl}/api/settings/cookies/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, cookies }),
    });
    const data = await res.json().catch(() => ({}));

    if (!res.ok) {
      setStatus(data.error || `Failed (HTTP ${res.status}).`, 'err');
    } else {
      setStatus('✓ Instagram connected! You can close this and start sending DMs.', 'ok');
      codeInput.value = '';
    }
  } catch (err) {
    setStatus('Error: ' + err.message + ' — check the app URL is reachable.', 'err');
  } finally {
    connectBtn.disabled = false;
  }
});
