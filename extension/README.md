# QuickAds — Instagram Connect (browser extension)

A tiny Chrome/Edge extension that auto-imports your Instagram session into the
QuickAds Reachout app, so you don't have to manually export and paste cookies.

It reads **only** the three cookies the app needs — `sessionid`, `ds_user_id`,
and `csrftoken` — and sends them to your app over a one-time pairing code.
Nothing else is read, stored, or transmitted.

## Install (load unpacked)

1. Open `chrome://extensions` (or `edge://extensions`).
2. Turn on **Developer mode** (top-right).
3. Click **Load unpacked** and select this `extension/` folder.
4. Pin the "QuickAds — Instagram Connect" extension for easy access.

## Use

1. Make sure you're **logged into Instagram** in the same browser.
2. In the QuickAds app, open **Settings → Connect Instagram** and click
   **Generate pairing code** — you'll get a 6-digit code (valid 10 minutes).
3. Click the extension icon. Enter:
   - **Your app URL** (e.g. `https://your-app.onrender.com`)
   - **The pairing code**
4. Click **Connect Instagram**. Done — the app now has your session.

## Why an extension?

Instagram's `sessionid` cookie is `httpOnly`, so no in-page script (or
bookmarklet) can read it. A browser extension with the `cookies` permission is
the only client-side way to read it securely — which is exactly what this does,
limited to the instagram.com domain.
