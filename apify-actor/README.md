# Instagram Cookie Login — custom Apify actor

Logs into Instagram with a username/password (and optional 2FA code) on Apify's
servers and returns the session cookies your QuickAds app needs
(`sessionid`, `ds_user_id`, `csrftoken`). Because it's **your own** actor there's
no rental fee, and it returns the cookies in the exact shape the app expects.

## Output

One dataset item:

```json
{
  "ok": true,
  "username": "yourhandle",
  "cookies": [
    { "name": "sessionid",  "value": "...", "domain": ".instagram.com", "path": "/" },
    { "name": "ds_user_id", "value": "...", "domain": ".instagram.com", "path": "/" },
    { "name": "csrftoken",  "value": "...", "domain": ".instagram.com", "path": "/" }
  ]
}
```

On failure: `{ "ok": false, "message": "...", "needs2fa"?: true }`.

## Deploy it (once)

### Option 1 — Apify CLI (fastest)
```bash
npm install -g apify-cli
apify login                 # paste your Apify API token
cd apify-actor
apify push                  # builds & uploads; note the actor id it prints
```

### Option 2 — Apify Console (no CLI)
1. [console.apify.com](https://console.apify.com) → **Actors → Develop → Create new**.
2. In the web editor, recreate these files (same paths): `src/main.js`,
   `package.json`, `Dockerfile`, `.actor/actor.json`, `.actor/input_schema.json`.
3. Click **Build**. When it succeeds, the actor is ready.

Your actor id will look like `yourusername~instagram-cookie-login`.

## Point the app at it

In Render → your service → **Environment**, set:

```
IG_LOGIN_ACTOR_ID = yourusername~instagram-cookie-login
```

and **remove** any `IG_LOGIN_USER_FIELD` / `IG_LOGIN_PASS_FIELD` overrides you added
earlier (this actor uses the default `username` / `password` / `code` fields).
Save — Render restarts — then use **Settings → Log in via Apify** exactly as before.

## Important: Instagram + datacenter IPs

Instagram frequently challenges logins that come from datacenter IPs. To make this
reliable:

- Turn on **Residential proxy** in the actor input (the `proxyConfiguration` field,
  group `RESIDENTIAL`). This is a **paid Apify add-on** — without it, logins will
  often hit a checkpoint and return `ok: false`.
- If the account has **2FA**, fill the 2FA code field in the app each time.

If you'd rather avoid the proxy cost and 2FA loop entirely, the **browser
extension** connect method reads the same cookies from your own logged-in
browser for free — but this actor is the way to do it fully server-side.
