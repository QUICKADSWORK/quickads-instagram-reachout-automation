// Popup: shows what's connected and gets you to the app. Most people never
// need to open this — the app page and the Instagram prompt do the work.

const $ = (id) => document.getElementById(id);

const ask = (message) => new Promise((resolve) => {
  chrome.runtime.sendMessage(message, (r) => {
    if (chrome.runtime.lastError) return resolve({ ok: false, error: chrome.runtime.lastError.message });
    resolve(r || { ok: false });
  });
});

function setRow(dotId, labelId, subId, state, label, sub) {
  $(dotId).className = 'dot' + (state ? ' ' + state : '');
  $(labelId).textContent = label;
  $(subId).textContent = sub || '';
}

async function currentTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function render() {
  const status = await ask({ type: 'GET_STATUS' });

  // Instagram
  if (status.loggedIn) {
    setRow('dotIg', 'igLabel', 'igSub', 'ok', 'Instagram: logged in', 'Session found in this browser');
  } else {
    setRow('dotIg', 'igLabel', 'igSub', 'bad', 'Instagram: not logged in',
      'Open instagram.com and log in first');
  }

  // App
  if (status.appOrigin) {
    setRow('dotApp', 'appLabel', 'appSub', status.connectedAt ? 'ok' : '',
      status.connectedAt ? 'QuickAds: connected' : 'QuickAds app found', status.appOrigin);
  } else {
    setRow('dotApp', 'appLabel', 'appSub', 'bad', 'QuickAds app not found yet',
      'Open your QuickAds app once');
  }

  $('btnOpen').disabled = !status.appOrigin;
  $('btnOpen').textContent = status.connectedAt ? 'Open QuickAds' : 'Open QuickAds & connect';

  // Offer to enable the bridge on a custom domain the manifest doesn't cover.
  const tab = await currentTab();
  try {
    const origin = tab && tab.url ? new URL(tab.url).origin : '';
    const isIg = /instagram\.com$/.test(new URL(tab.url).hostname);
    const covered = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)
      || /\.onrender\.com$/.test(new URL(tab.url).hostname);
    if (origin && !isIg && !covered && origin !== status.appOrigin) {
      $('btnEnableSite').style.display = 'block';
      $('btnEnableSite').dataset.origin = origin;
    }
  } catch (_) {}

  if (status.loggedIn && status.appOrigin && !status.connectedAt) {
    $('msg').textContent = 'Ready to connect — press the button above.';
  } else if (status.connectedAt) {
    $('msg').textContent = 'Instagram is connected. You can close this.';
  }
}

$('btnOpen').addEventListener('click', async () => {
  const res = await ask({ type: 'CONNECT_FROM_INSTAGRAM' });
  if (res.ok) window.close();
  else $('msg').textContent = res.error || 'Could not open the app.';
});

// Custom domains: ask for permission and inject the bridge on the fly.
$('btnEnableSite').addEventListener('click', async () => {
  const origin = $('btnEnableSite').dataset.origin;
  if (!origin) return;
  const granted = await chrome.permissions.request({ origins: [origin + '/*'] });
  if (!granted) { $('msg').textContent = 'Permission denied.'; return; }

  const tab = await currentTab();
  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['app-bridge.js'] });
    await chrome.scripting.registerContentScripts([{
      id: 'app-bridge-' + btoa(origin).replace(/[^a-z0-9]/gi, ''),
      matches: [origin + '/*'],
      js: ['app-bridge.js'],
      runAt: 'document_idle',
    }]).catch(() => {});
    $('msg').textContent = 'Enabled. Reload your QuickAds page and press Connect Instagram.';
    $('btnEnableSite').style.display = 'none';
  } catch (err) {
    $('msg').textContent = 'Could not enable: ' + err.message;
  }
});

render();
