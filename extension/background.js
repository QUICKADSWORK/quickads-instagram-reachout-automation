// QuickAds — Instagram Connect: background service worker.
//
// Owns everything that content scripts can't do themselves: reading cookies,
// remembering which site is the QuickAds app, and nudging the user to connect
// once they've logged into Instagram.

const REQUIRED = ['sessionid', 'ds_user_id', 'csrftoken'];
const IG_URL = 'https://www.instagram.com';

function getCookie(name) {
  return new Promise((resolve) => {
    chrome.cookies.get({ url: IG_URL, name }, (c) => resolve(c || null));
  });
}

// Chrome reports sameSite as no_restriction | lax | strict | unspecified, but
// the DM automation loads these cookies into Playwright, which only accepts
// Strict | Lax | None. Translate here so the app never sees Chrome's spelling.
function sameSiteFor(v) {
  const s = String(v || '').toLowerCase();
  if (s === 'strict') return 'Strict';
  if (s === 'none' || s === 'no_restriction') return 'None';
  return 'Lax';
}

// Read the 3 cookies the app needs, in the shape it expects.
async function readIgCookies() {
  const out = [];
  for (const name of REQUIRED) {
    const c = await getCookie(name);
    if (c && c.value) {
      out.push({
        name: c.name,
        value: c.value,
        domain: c.domain || '.instagram.com',
        path: c.path || '/',
        secure: c.secure !== false,
        httpOnly: !!c.httpOnly,
        sameSite: sameSiteFor(c.sameSite),
        ...(c.expirationDate ? { expires: Math.floor(c.expirationDate) } : {}),
      });
    }
  }
  const missing = REQUIRED.filter((n) => !out.some((c) => c.name === n));
  return { cookies: out, loggedIn: missing.length === 0, missing };
}

async function getState() {
  const { appOrigin, approvedOrigins = [], connectedAt, lastAccount } =
    await chrome.storage.local.get(['appOrigin', 'approvedOrigins', 'connectedAt', 'lastAccount']);
  return { appOrigin, approvedOrigins, connectedAt, lastAccount };
}

// A small badge so the toolbar icon reflects what's going on.
async function refreshBadge() {
  const { loggedIn } = await readIgCookies();
  const { connectedAt } = await getState();
  if (loggedIn && !connectedAt) {
    chrome.action.setBadgeText({ text: '!' });
    chrome.action.setBadgeBackgroundColor({ color: '#c3f53c' });
    chrome.action.setTitle({ title: 'QuickAds — Instagram is logged in. Click to connect.' });
  } else if (connectedAt) {
    chrome.action.setBadgeText({ text: '' });
    chrome.action.setTitle({ title: 'QuickAds — Instagram connected' });
  } else {
    chrome.action.setBadgeText({ text: '' });
    chrome.action.setTitle({ title: 'QuickAds — log into Instagram to connect' });
  }
}

// Watch for the Instagram session appearing (i.e. the user just logged in).
chrome.cookies.onChanged.addListener(async (info) => {
  if (!info.cookie || !String(info.cookie.domain || '').includes('instagram')) return;
  if (info.cookie.name !== 'sessionid') return;

  if (info.removed) {
    // Logged out — allow prompting again next time.
    await chrome.storage.local.remove(['connectedAt', 'promptDismissedAt']);
  }
  refreshBadge();
});

chrome.runtime.onInstalled.addListener(refreshBadge);
chrome.runtime.onStartup.addListener(refreshBadge);

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    switch (msg && msg.type) {
      // A page identified itself as the QuickAds app.
      case 'REGISTER_APP': {
        const origin = msg.origin || (sender.origin || '');
        if (origin) await chrome.storage.local.set({ appOrigin: origin });
        const ig = await readIgCookies();
        const state = await getState();
        sendResponse({
          ok: true,
          version: chrome.runtime.getManifest().version,
          loggedIn: ig.loggedIn,
          missing: ig.missing,
          approved: (state.approvedOrigins || []).includes(origin),
          connectedAt: state.connectedAt || null,
        });
        refreshBadge();
        return;
      }

      case 'GET_STATUS': {
        const ig = await readIgCookies();
        const state = await getState();
        sendResponse({
          ok: true,
          version: chrome.runtime.getManifest().version,
          loggedIn: ig.loggedIn,
          missing: ig.missing,
          appOrigin: state.appOrigin || null,
          connectedAt: state.connectedAt || null,
        });
        return;
      }

      // Hand the cookies to an approved app page so it can save them
      // same-origin (this is why no pairing code is needed).
      case 'GET_COOKIES': {
        const origin = msg.origin || sender.origin || '';
        const state = await getState();
        if (!origin || !(state.approvedOrigins || []).includes(origin)) {
          sendResponse({ ok: false, error: 'This site is not approved yet.' });
          return;
        }
        const ig = await readIgCookies();
        if (!ig.loggedIn) {
          sendResponse({ ok: false, error: 'Not logged into Instagram.', missing: ig.missing });
          return;
        }
        sendResponse({ ok: true, cookies: ig.cookies });
        return;
      }

      case 'APPROVE_ORIGIN': {
        const origin = msg.origin || sender.origin || '';
        const state = await getState();
        const list = new Set(state.approvedOrigins || []);
        list.add(origin);
        await chrome.storage.local.set({ approvedOrigins: Array.from(list), appOrigin: origin });
        sendResponse({ ok: true });
        return;
      }

      case 'MARK_CONNECTED': {
        await chrome.storage.local.set({
          connectedAt: Date.now(),
          lastAccount: msg.account || null,
        });
        refreshBadge();
        sendResponse({ ok: true });
        return;
      }

      // From the Instagram banner: stash a "please connect" flag and send the
      // user to the app, where the bridge finishes the job.
      case 'CONNECT_FROM_INSTAGRAM': {
        const state = await getState();
        if (!state.appOrigin) {
          sendResponse({ ok: false, error: 'Open your QuickAds app once first so I know its address.' });
          return;
        }
        await chrome.storage.local.set({ pendingConnect: Date.now() });

        const tabs = await chrome.tabs.query({});
        const appTab = tabs.find((t) => t.url && t.url.startsWith(state.appOrigin));

        if (appTab) {
          await chrome.tabs.update(appTab.id, { active: true });
          try { await chrome.windows.update(appTab.windowId, { focused: true }); } catch (_) {}

          // Poke the bridge that's already running in that tab. Navigating to
          // the URL it's *already* on would not reload it, so the content
          // script would never re-run — message it directly instead.
          const delivered = await new Promise((resolve) => {
            chrome.tabs.sendMessage(appTab.id, { type: 'DO_CONNECT' }, () => {
              resolve(!chrome.runtime.lastError);
            });
          });

          // No bridge in that tab (e.g. it's on some other page) — load the app
          // fresh, where the bridge picks up the pending flag on startup.
          if (!delivered) {
            await chrome.tabs.update(appTab.id, { url: state.appOrigin + '/negotiate' });
          }
        } else {
          await chrome.tabs.create({ url: state.appOrigin + '/negotiate', active: true });
        }
        sendResponse({ ok: true, appOrigin: state.appOrigin });
        return;
      }

      case 'TAKE_PENDING': {
        const { pendingConnect } = await chrome.storage.local.get('pendingConnect');
        if (pendingConnect) await chrome.storage.local.remove('pendingConnect');
        sendResponse({ ok: true, pending: !!pendingConnect });
        return;
      }

      case 'DISMISS_PROMPT': {
        await chrome.storage.local.set({ promptDismissedAt: Date.now() });
        sendResponse({ ok: true });
        return;
      }

      default:
        sendResponse({ ok: false, error: 'Unknown request' });
    }
  })();
  return true; // keep the message channel open for the async work above
});
