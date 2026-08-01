# QuickAds — Instagram Connect (browser helper)

A small Chrome/Edge extension that connects your logged-in Instagram session to
your QuickAds app. It reads **only** the three cookies the app needs —
`sessionid`, `ds_user_id`, `csrftoken` — and nothing else.

No pairing code. No app address to type. Once it's installed, the app detects
it and everything is one click.

## Get it

- **From the app:** Negotiate → Settings → **Download helper**, then unzip.
- **From source:** use this `extension/` folder directly.

## Install (one time)

1. Open `chrome://extensions` (or `edge://extensions`).
2. Turn on **Developer mode** (top-right).
3. Click **Load unpacked** and choose the unzipped folder.
4. Refresh your QuickAds page — Step 1 turns green automatically.

## How it works

The Settings screen shows a live 3-step checklist that updates itself:

| Step | What it detects |
|---|---|
| 1. Helper installed | The extension injects a bridge into the app page, which reports its version |
| 2. Instagram login | The extension checks for a live Instagram session in your browser |
| 3. Connect | One click — cookies are read and saved, then it shows "ready for outreach" |

**Two ways to connect, both automatic:**

- **From the app** — when both steps are green, press **Connect Instagram**.
- **From Instagram** — after you log into instagram.com, a small QuickAds card
  appears in the corner: *"Connect this account so QuickAds can send your DMs."*
  Press **Connect Instagram** and it switches to your app tab and finishes there.

The first time you connect, the browser asks you to approve the site
(`Allow the QuickAds helper to send your Instagram login to <your app>?`).
That's a safety check so a random website can't ask for your session — approve
it once and it never asks again for that site.

## Why no pairing code anymore

The bridge runs *inside* your app page, so it hands the cookies to the page and
the page saves them with a normal same-origin request. Nothing crosses an
untrusted boundary, so there's no code to copy and no URL to enter.

## Custom domains

The helper works out of the box on `localhost` and `*.onrender.com`. If your app
is on your own domain, open the helper's popup while on that page and press
**"Use this site as my QuickAds app"** — it will ask for permission and enable
itself there.

## Files

| File | Role |
|---|---|
| `manifest.json` | Permissions and content-script matches |
| `background.js` | Reads cookies, remembers your app address, drives the badge |
| `app-bridge.js` | Runs on the QuickAds page; reports status, hands over cookies |
| `ig-prompt.js` | Runs on instagram.com; shows the connect card after login |
| `popup.html/js` | Status panel and fallback connect button |

## Publishing (optional)

Zipping this folder is also what you'd upload to the Chrome Web Store
(one-time $5 developer fee) for one-click installs and auto-updates.
