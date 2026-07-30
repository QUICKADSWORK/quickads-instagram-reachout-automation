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
- **Email Outreach** — Upload a contact sheet (.xlsx/.csv), write one template, and send personalized emails from your own mailbox; every send is logged
- **Export** — CSV and Excel export of discovered influencers (incl. analytics + fit scores)
- **DM Tracking** — Tracks who you've contacted via localStorage

## Email Outreach

Open **Email Outreach** in the top nav. Four steps:

1. **Send From** — connect the mailbox your emails come from (Gmail, Outlook,
   Zoho, SendGrid, Brevo, Mailgun, or any custom SMTP). Gmail needs an
   [App Password](https://myaccount.google.com/apppasswords), not your normal
   password. Use **Test** to verify the login (and optionally send yourself a
   test email).
2. **Contacts** — two ways to load people in:
   - **Upload sheet** — an `.xlsx` or `.csv`. A column named **Email** is
     required; **Full Name** / **First Name** are used for personalization, and
     any other column (Company, City, …) becomes a `{{variable}}` you can use in
     your message.
   - **Use my saved influencers** — pulls your Ready-to-Go roster straight in,
     keeping only the creators that have an email saved (the rest are skipped
     and counted). Their handle, category and follower count come along as
     `{{username}}`, `{{category}}` and `{{followers}}` (formatted as "49.1K").

   Either way, re-importing merges by email instead of duplicating.
3. **Message** — write a subject + body, click a chip to insert a variable, and
   see a live preview rendered against a real contact.
4. **Send** — pick the sender, template, audience (*everyone* or *only people
   never emailed before*) and the delay between emails, then start. Live
   progress, and **Stop** takes effect immediately.

**Results** keeps every campaign and every individual send (status, subject,
error) with a CSV export. Everything is stored on disk in `DATA_DIR`:
`email_senders.json`, `email_contacts.json`, `email_templates.json`,
`email_campaigns.json`, `email_sends.json`.

> Passwords are write-only — they're never returned by the API. Mind your
> provider's daily limits (Gmail ≈ 500/day, Workspace ≈ 2,000) and keep a delay
> between emails so your account isn't flagged.

## Connecting Instagram

DM sending needs your Instagram session, which you connect with the free
**QuickAds helper** browser extension. Open **Negotiate → Settings → Connect
Instagram** and follow the 3 on-screen steps:

1. **Add the helper to your browser** — click **Download helper**, unzip it, and
   load it in Chrome/Edge (`chrome://extensions` → turn on Developer mode → Load
   unpacked → pick the folder). One time only.
2. **Log into Instagram** in the same browser.
3. **Get your code and connect** — click **Get my code**, then open the helper,
   enter your app address + the code, and press Connect.

The helper reads only the 3 required cookies (`sessionid`, `ds_user_id`,
`csrftoken`) from your logged-in session and sends them to the app. Use
**Check connection** to confirm it worked. (For a true one-click install with
auto-updates, the same `extension/` folder can be published to the Chrome Web
Store — one-time $5 developer fee.)

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

### Email Outreach
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/email/providers` | SMTP presets for common providers |
| GET/POST | `/api/email/senders` | List/save sending mailboxes (password write-only) |
| POST | `/api/email/senders/:id/test` | Verify SMTP login, optionally send a test email |
| GET | `/api/email/contacts` | List contacts |
| POST | `/api/email/contacts/import` | Import an .xlsx/.csv sheet (base64) |
| GET | `/api/email/contacts/roster-preview` | How many saved influencers have an email |
| POST | `/api/email/contacts/from-roster` | Import Ready-to-Go influencers that have emails |
| GET/POST | `/api/email/templates` | List/save templates |
| POST | `/api/email/templates/preview` | Render a template against a contact |
| GET/POST | `/api/email/campaigns` | List/create (and start) a campaign |
| POST | `/api/email/campaigns/:id/stop` | Stop a running campaign |
| GET | `/api/email/sends` | Every individual send result |
| GET | `/api/email/sends/export` | Download all results as CSV |
| GET | `/api/email/stats` | Contact/send/campaign totals |

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
