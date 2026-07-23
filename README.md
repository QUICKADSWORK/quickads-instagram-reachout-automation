# QuickAds — Instagram Reachout Automation

Discover Instagram influencers, send DMs, and let an AI agent negotiate paid collaborations on autopilot.

## Features

- **Influencer Discovery** — Find influencers by seed accounts, follower range, and niche using Apify
- **Influencer Analytics** — Avg views, avg likes, engagement rate, follower ratio, and posting frequency computed per creator
- **AI Brand-Fit Scoring** — Describe your brand once; Claude scores each influencer 0–100 for fit, with reasoning and red flags
- **Connect Instagram (auto)** — Import your Instagram session automatically via a **browser extension** or **headless login**, or paste cookies manually
- **Bulk DM Outreach** — Send personalized first DMs to all discovered creators
- **AI Negotiation Agent** — Claude AI handles the full deal negotiation via Instagram DMs
- **Autopilot Mode** — Automatically reads creator replies, generates smart responses, and sends them back
- **Campaign Management** — Set brand, budget range, and campaign brief per campaign
- **Deal Dashboard** — Track negotiation status, conversation history, and total spend
- **Export** — CSV and Excel export of discovered influencers (incl. analytics + fit scores)
- **DM Tracking** — Tracks who you've contacted via localStorage

## Connecting Instagram

DM sending needs your Instagram session cookies (`sessionid`, `ds_user_id`,
`csrftoken`). Open **Negotiate → Settings → Connect Instagram** and pick one:

1. **Browser extension (recommended)** — In Settings, click **Download
   Extension (.zip)** (served by the app from the `extension/` folder), unzip
   it, and load it unpacked in Chrome/Edge (`chrome://extensions` → Developer
   mode → Load unpacked). Then generate a pairing code in the app and connect
   in one click while logged into Instagram. Reads only the 3 required cookies.
   For a one-click install with auto-updates you can also publish it to the
   Chrome Web Store (one-time $5 developer fee) — the same folder is what you'd
   upload.
2. **Log in via Apify** (works on any host) — Enter your IG username/password
   (+ a 2FA code if asked). The app runs an Apify login actor
   (`shareze001/instagram-cookies` by default) that logs in on **Apify's**
   infrastructure with proxies and returns the session cookies — no browser on
   your server, and far less likely to hit Instagram's datacenter-IP
   challenges. Uses your Apify credits. Configure via `IG_LOGIN_ACTOR_ID` /
   `IG_LOGIN_USER_FIELD` / `IG_LOGIN_PASS_FIELD` / `IG_LOGIN_CODE_FIELD`.
3. **Local headless login** (advanced) — Enter your IG username/password; the
   server logs in via Playwright/Chromium **locally**. Needs Chromium + system
   libraries (the shipped `Dockerfile`), and only works for accounts **without**
   2FA. On hosts lacking those libs it reports `BROWSER_DEPS_MISSING` — use the
   Apify login or extension instead.
4. **Paste cookies manually** — Paste the cookie JSON array (from a cookie
   exporter extension) under "Paste cookies manually".

## How It Works

1. **Discover** influencers on the main page using seed accounts from your niche
2. **Send first DMs** via the "DM All" button
3. **Create a campaign** on the Negotiate page with your brand info and budget
4. **Add influencers** you've DMed to the campaign
5. **Start Autopilot** — the AI reads Instagram inbox, detects replies, negotiates the price, and sends DMs back automatically
6. **Close deals** — mark deals as closed and track your spend

## Setup

### Prerequisites

- Node.js 18+
- [Apify](https://apify.com) account with API token
- [Anthropic](https://anthropic.com) API key (Claude)
- Instagram account cookies (for DM automation)

### Install

```bash
git clone https://github.com/YOUR_USERNAME/quickads-instagram-reachout-automation.git
cd quickads-instagram-reachout-automation
npm install
```

### Configure

Copy the example env file and fill in your keys:

```bash
cp .env.example .env
```

Edit `.env`:

```
APIFY_TOKEN=your_apify_token
CLAUDE_API_KEY=your_claude_api_key
PORT=3000
```

### Run

```bash
npm start
```

Open **http://localhost:3000** in your browser.

## Pages

| Page | URL | Purpose |
|------|-----|---------|
| Discovery | `/` | Find influencers and send first DMs |
| Negotiate | `/negotiate` | AI negotiation dashboard with autopilot |

## API Endpoints

### Discovery
| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/scrape` | Start influencer discovery |
| GET | `/api/status/:runId` | Poll scraper status |
| GET | `/api/results/:datasetId` | Fetch discovered profiles (each with a computed `analytics` block) |
| POST | `/api/export/excel` | Export as Excel |

### Brand Fit
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET/POST | `/api/brand-profile` | Get/save your brand profile |
| POST | `/api/brand-fit/score` | AI-score a list of influencers for brand fit |

### Connect Instagram
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/settings/pair` | Mint a one-time pairing code for the extension |
| POST | `/api/settings/cookies/import` | Extension posts cookies here with the code |
| POST | `/api/settings/cookies/apify-login` | Log in via an Apify actor; stores returned cookies |
| POST | `/api/settings/cookies/login` | Local headless Playwright login (username/password) |
| GET/POST | `/api/settings/cookies` | Get/save cookies (manual paste) |

### Campaigns & Negotiations
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET/POST | `/api/campaigns` | List/create campaigns |
| DELETE | `/api/campaigns/:id` | Delete campaign |
| GET/POST | `/api/negotiations` | List/create negotiations |
| POST | `/api/negotiations/:id/reply` | Submit creator reply |
| POST | `/api/negotiations/:id/generate` | AI generates response |
| POST | `/api/negotiations/:id/send` | Send DM via Apify |
| PATCH | `/api/negotiations/:id` | Update status/price |

### Autopilot
| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/autopilot/poll` | Check inbox for replies |
| POST | `/api/autopilot/run` | Full cycle: read → AI → send |

## Tech Stack

- **Backend**: Node.js + Express
- **Frontend**: Vanilla HTML/CSS/JS (dark theme)
- **AI**: Claude (Anthropic API)
- **Scraping**: Apify (Instagram Profile Scraper)
- **DM Sending**: Apify (Instagram DM Automation)
- **Database**: JSON files (zero setup)

## License

MIT
