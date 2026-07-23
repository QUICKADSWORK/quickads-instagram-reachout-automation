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

1. **Browser extension (recommended)** — Install the extension in `extension/`
   (see its README), generate a pairing code in the app, and connect in one
   click while logged into Instagram. Reads only the 3 required cookies.
2. **Headless login** — Enter your IG username/password; the server logs in via
   Playwright and captures the session. Only works for accounts **without** 2FA
   or a login checkpoint. Requires the optional `playwright` package + a
   Chromium binary (`npx playwright install chromium`).
3. **Paste cookies manually** — Paste the cookie JSON array (from a cookie
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
| POST | `/api/settings/cookies/login` | Headless Playwright login (username/password) |
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
