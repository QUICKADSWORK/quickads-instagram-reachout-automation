# QuickAds — Instagram Reachout Automation

Discover Instagram influencers, send DMs, and let an AI agent negotiate paid collaborations on autopilot.

## Features

- **Influencer Discovery** — Find influencers by seed accounts, follower range, and niche using Apify
- **Bulk DM Outreach** — Send personalized first DMs to all discovered creators
- **AI Negotiation Agent** — Claude AI handles the full deal negotiation via Instagram DMs
- **Autopilot Mode** — Automatically reads creator replies, generates smart responses, and sends them back
- **Campaign Management** — Set brand, budget range, and campaign brief per campaign
- **Deal Dashboard** — Track negotiation status, conversation history, and total spend
- **Export** — CSV and Excel export of discovered influencers
- **DM Tracking** — Tracks who you've contacted via localStorage

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
| GET | `/api/results/:datasetId` | Fetch discovered profiles |
| POST | `/api/export/excel` | Export as Excel |

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
