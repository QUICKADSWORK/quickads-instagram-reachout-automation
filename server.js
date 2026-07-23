require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const XLSX = require('xlsx');

const app = express();
const PORT = process.env.PORT || 3000;

const APIFY_TOKEN = process.env.APIFY_TOKEN || '';
const CLAUDE_API_KEY = process.env.CLAUDE_API_KEY || '';

// Single source of truth for the Claude model so negotiation + brand-fit
// scoring stay in sync. Override with CLAUDE_MODEL if needed.
// (claude-sonnet-4-20250514 was retired; claude-sonnet-5 is its replacement.)
const CLAUDE_MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-5';

// DATA_DIR is configurable so it can point at a persistent disk mount
// (e.g. a Render Disk) — the default ./data folder is ephemeral on most
// PaaS free tiers and gets wiped on every redeploy / cold start.
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
try {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
} catch (err) {
  console.error('Could not create DATA_DIR:', DATA_DIR, err.message);
}

app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Optional password gate. OFF by default (no behavior change). If you set
// the APP_PASSWORD env var, the whole app (UI + API) requires HTTP Basic
// auth with that password. Strongly recommended before exposing a
// deployment publicly, since whoever can reach this app can send DMs from
// the configured Instagram account.
const APP_PASSWORD = process.env.APP_PASSWORD || '';
if (APP_PASSWORD) {
  app.use((req, res, next) => {
    // The browser-extension cookie import is authenticated by a one-time
    // pairing token (minted by an already-authenticated in-app action), so
    // it is exempt from Basic auth — the extension can't send a password.
    if (req.path === '/api/settings/cookies/import') return next();
    const hdr = req.headers.authorization || '';
    const [scheme, encoded] = hdr.split(' ');
    if (scheme === 'Basic' && encoded) {
      const decoded = Buffer.from(encoded, 'base64').toString();
      const pass = decoded.slice(decoded.indexOf(':') + 1);
      if (pass === APP_PASSWORD) return next();
    }
    res.set('WWW-Authenticate', 'Basic realm="QuickAds"');
    return res.status(401).send('Authentication required.');
  });
}

app.use(express.static(path.join(__dirname, 'public')));

// ═══════════════════════════════════════════════════════════
//  Simple JSON file database (crash-resilient + atomic writes)
// ═══════════════════════════════════════════════════════════

// Resilient read: never throws. A missing, empty, whitespace-only, or
// corrupt file returns the fallback ([]) instead of 500-ing the whole
// endpoint forever. A corrupt file is backed up once for forensics.
function readDB(file, fallback = []) {
  const p = path.join(DATA_DIR, file);
  try {
    if (!fs.existsSync(p)) return fallback;
    const raw = fs.readFileSync(p, 'utf8');
    if (!raw || !raw.trim()) return fallback;
    return JSON.parse(raw);
  } catch (err) {
    console.error(`readDB(${file}) failed: ${err.message}. Returning fallback.`);
    try {
      const bad = path.join(DATA_DIR, `${file}.corrupt-${Date.now()}.bak`);
      fs.copyFileSync(p, bad);
      console.error(`Backed up corrupt ${file} -> ${path.basename(bad)}`);
    } catch (_) {}
    return fallback;
  }
}

// Atomic write: write to a temp file then rename. A crash or disk-full
// mid-write leaves the previous good file intact instead of corrupting it.
function writeDB(file, data) {
  const p = path.join(DATA_DIR, file);
  const tmp = `${p}.tmp-${process.pid}-${Date.now()}`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, p);
  } catch (err) {
    console.error(`writeDB(${file}) failed: ${err.message}`);
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch (_) {}
    throw err;
  }
}

function genId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// Health/diagnostics: confirms where data is being stored and whether that
// location is actually writable + persistent. Open /api/health to verify
// the Render disk is wired up correctly (dataDir should be /var/data and
// persistent should be true).
app.get('/api/health', (req, res) => {
  const usingEnv = !!process.env.DATA_DIR;
  let writable = false;
  try {
    const probe = path.join(DATA_DIR, '.health-probe');
    fs.writeFileSync(probe, String(Date.now()));
    fs.unlinkSync(probe);
    writable = true;
  } catch (_) {}

  const counts = {};
  for (const f of ['campaigns.json', 'negotiations.json', 'ready_influencers.json']) {
    try { counts[f] = readDB(f).length; } catch (_) { counts[f] = 'error'; }
  }

  res.json({
    ok: true,
    dataDir: DATA_DIR,
    dataDirFromEnv: usingEnv,
    // Heuristic: a mounted persistent disk lives outside the app folder.
    persistent: usingEnv && !DATA_DIR.startsWith(__dirname),
    writable,
    counts,
    time: new Date().toISOString(),
  });
});

// ═══════════════════════════════════════════════════════════
//  Anti-spam helpers: prevent duplicate DMs and enforce
//  at-most 2 consecutive "you" messages per creator.
// ═══════════════════════════════════════════════════════════

const MAX_CONSECUTIVE_YOU = 2;
const DUPLICATE_SIMILARITY_THRESHOLD = 0.85;

// In-flight locks keyed by negotiation id. Prevents two concurrent
// send requests (double-click, overlapping autopilot ticks, etc.)
// from both sending the same DM.
const sendLocks = new Map();

function acquireSendLock(negId) {
  if (sendLocks.has(negId)) return false;
  sendLocks.set(negId, Date.now());
  return true;
}

function releaseSendLock(negId) {
  sendLocks.delete(negId);
}

function normalizeForCompare(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Lightweight similarity: Dice coefficient on word bigrams.
// Good enough to catch "INR 8,500 for this collaboration" vs
// "INR 8,500 for the deliverable" as near-duplicates.
function textSimilarity(a, b) {
  const na = normalizeForCompare(a);
  const nb = normalizeForCompare(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;

  const bigrams = s => {
    const words = s.split(' ');
    if (words.length < 2) return new Set([s]);
    const out = new Set();
    for (let i = 0; i < words.length - 1; i++) out.add(words[i] + ' ' + words[i + 1]);
    return out;
  };

  const A = bigrams(na);
  const B = bigrams(nb);
  let inter = 0;
  for (const g of A) if (B.has(g)) inter++;
  const total = A.size + B.size;
  return total === 0 ? 0 : (2 * inter) / total;
}

function countConsecutiveYou(messages) {
  let count = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'you') count++;
    else break;
  }
  return count;
}

// Return the most similar prior "you" message (anywhere in the
// thread) along with its similarity score. If we're about to send
// something too close to what we already said, that's a spam signal.
function findDuplicateYouMessage(messages, candidate) {
  let best = { score: 0, message: null };
  for (const m of messages) {
    if (m.role !== 'you') continue;
    const score = textSimilarity(m.content, candidate);
    if (score > best.score) best = { score, message: m };
  }
  return best;
}

// ═══════════════════════════════════════════════════════════
//  Existing Scraper Routes
// ═══════════════════════════════════════════════════════════

const SCRAPER_ACTOR_ID = 'afanasenko~instagram-profile-scraper';

const LOCATION_TO_LANGUAGE = {
  US: 'English', UK: 'English', CA: 'English', AU: 'English',
  IN: 'English', SG: 'English', AE: 'English',
  DE: 'German', FR: 'French', BR: 'Portuguese', ES: 'Spanish',
};

function parseKeywordList(raw) {
  if (!raw) return [];
  return String(raw)
    .split(/[,;\n]+/)
    .map(s => s.trim())
    .filter(Boolean)
    .slice(0, 8);
}

// Scrub characters that aren't valid in Instagram hashtags
function toHashtag(s) {
  return String(s)
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '')
    .slice(0, 30);
}

// IMPORTANT: keep this input MINIMAL — exactly the original shape that was
// working before. Every extra filter (keywords, category, language, etc.)
// tightens results and is the reason searches were returning 0.
// Niche + location are NOT applied here on purpose — they're used in the
// keyword-discovery fallback where they belong.
function buildNetworkExpansionInput({ seedAccounts, minFollowers, maxFollowers, maxProfiles }) {
  const input = {
    operationMode: 'networkExpansion',
    startUsernames: seedAccounts,
    maxProfilesToAnalyze: Number(maxProfiles) || 100,
    searchDepth: '1',
    extractEmail: true,
    analyzeQuality: true,
  };
  if (minFollowers) input.minFollowers = Number(minFollowers);
  if (maxFollowers) input.maxFollowers = Number(maxFollowers);
  return input;
}

// Fallback discovery: only fires after network expansion returns 0.
// Keep this LIGHT too — same lesson as above.
function buildKeywordDiscoveryInput({ niches, minFollowers, maxFollowers, maxProfiles }) {
  const queries = niches.slice(0, 5);
  const hashtags = niches.map(toHashtag).filter(t => t.length >= 3).slice(0, 5);
  const input = {
    operationMode: 'keywordDiscovery',
    searchQueries: queries,
    searchHashtags: hashtags,
    maxSearchPagesPerQuery: 5,
    maxCountDiscovery: Math.max(50, Number(maxProfiles) || 100),
    extractEmail: true,
    analyzeQuality: true,
  };
  if (minFollowers) input.minFollowers = Number(minFollowers);
  if (maxFollowers) input.maxFollowers = Number(maxFollowers);
  return input;
}

async function startApifyRun(actorInput) {
  const startRes = await fetch(
    `https://api.apify.com/v2/acts/${SCRAPER_ACTOR_ID}/runs?token=${APIFY_TOKEN}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(actorInput),
    }
  );
  if (!startRes.ok) {
    const errBody = await startRes.text();
    const err = new Error(`Apify error (${startRes.status}): ${errBody.slice(0, 400)}`);
    err.status = startRes.status;
    throw err;
  }
  return startRes.json();
}

async function fetchRunStatus(runId) {
  const statusRes = await fetch(`https://api.apify.com/v2/actor-runs/${runId}?token=${APIFY_TOKEN}`);
  if (!statusRes.ok) throw new Error('Failed to fetch run status.');
  return statusRes.json();
}

async function fetchDatasetItems(datasetId) {
  const resultsRes = await fetch(
    `https://api.apify.com/v2/datasets/${datasetId}/items?token=${APIFY_TOKEN}&format=json&clean=true`
  );
  if (!resultsRes.ok) throw new Error('Failed to fetch results.');
  return resultsRes.json();
}

async function waitForRunCompletion(runId, { onTick } = {}) {
  while (true) {
    await new Promise(r => setTimeout(r, 4000));
    const data = await fetchRunStatus(runId);
    const status = data.data?.status;
    if (onTick) onTick(data.data);
    if (status === 'SUCCEEDED') return data.data;
    if (['FAILED', 'ABORTED', 'TIMED-OUT'].includes(status)) {
      const err = new Error(`Scraper ${status.toLowerCase()}: ${data.data?.statusMessage || 'Unknown error.'}`);
      err.status = status;
      throw err;
    }
  }
}

// ═══════════════════════════════════════════════════════════
//  Influencer Analytics
//  Derives avg views, avg likes, engagement rate, follower ratio
//  and posting frequency from whatever the Apify actor returns.
//  Actors vary wildly in field casing and whether they include a
//  recent-posts array, so every getter is defensive with fallbacks
//  and returns null (never a fake 0) when the signal is absent.
// ═══════════════════════════════════════════════════════════

// Pull the first present key from an object, trying many name variants.
function pick(obj, keys) {
  if (!obj || typeof obj !== 'object') return undefined;
  for (const k of keys) {
    if (obj[k] !== undefined && obj[k] !== null && obj[k] !== '') return obj[k];
  }
  return undefined;
}

// Parse "12.3K", "1,234", "2.5%", 1234 -> Number (or null if unparseable).
function toNum(v) {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  let s = String(v).trim().replace(/%/g, '').replace(/,/g, '');
  const mult = /k$/i.test(s) ? 1e3 : /m$/i.test(s) ? 1e6 : /b$/i.test(s) ? 1e9 : 1;
  s = s.replace(/[kmb]$/i, '');
  const n = parseFloat(s);
  return Number.isFinite(n) ? n * mult : null;
}

function avg(nums) {
  const valid = nums.filter(n => typeof n === 'number' && Number.isFinite(n));
  if (!valid.length) return null;
  return valid.reduce((a, b) => a + b, 0) / valid.length;
}

// Find the recent-posts array under any of the common key names.
function extractPosts(item) {
  const candidates = ['latestPosts', 'posts', 'recentPosts', 'topPosts', 'latestIgtvVideos', 'timeline', 'media'];
  for (const key of candidates) {
    const v = item[key];
    if (Array.isArray(v) && v.length) return v;
  }
  return [];
}

function postLikes(p) { return toNum(pick(p, ['likesCount', 'likes', 'likeCount', 'like_count', 'likesCountNumber'])); }
function postComments(p) { return toNum(pick(p, ['commentsCount', 'comments', 'commentCount', 'comment_count'])); }
function postViews(p) {
  return toNum(pick(p, ['videoViewCount', 'videoPlayCount', 'playCount', 'views', 'videoViews', 'view_count', 'play_count', 'igPlayCount', 'reelPlayCount']));
}
function postTimestamp(p) {
  const raw = pick(p, ['timestamp', 'takenAt', 'taken_at', 'taken_at_timestamp', 'date', 'createdAt']);
  if (raw === undefined) return null;
  // Unix seconds vs ISO string vs ms.
  if (typeof raw === 'number') return raw < 1e12 ? raw * 1000 : raw;
  const t = Date.parse(raw);
  return Number.isFinite(t) ? t : null;
}

// Compute the analytics block for a single scraped profile.
function computeAnalytics(item) {
  const followers = toNum(pick(item, ['Followers Count', 'followersCount', 'followers_count', 'followers']));
  const following = toNum(pick(item, ['Following Count', 'followingCount', 'following_count', 'follows', 'followsCount']));
  const posts = extractPosts(item);

  // Prefer explicit aggregate fields the actor may already provide.
  let avgLikes = toNum(pick(item, ['avgLikes', 'averageLikes', 'avg_likes', 'meanLikes']));
  let avgComments = toNum(pick(item, ['avgComments', 'averageComments', 'avg_comments', 'meanComments']));
  let avgViews = toNum(pick(item, ['avgViews', 'averageViews', 'avgVideoViews', 'avg_video_views', 'avgPlays', 'averagePlays', 'avgReelViews']));

  // Otherwise derive from the recent-posts array.
  if (posts.length) {
    if (avgLikes === null) avgLikes = avg(posts.map(postLikes));
    if (avgComments === null) avgComments = avg(posts.map(postComments));
    if (avgViews === null) {
      const views = posts.map(postViews).filter(v => typeof v === 'number' && v > 0);
      if (views.length) avgViews = avg(views);
    }
  }

  // Engagement rate: trust the actor's value if present, else compute.
  let engagementRate = toNum(pick(item, ['Median ER', 'engagement_rate', 'engagementRate', 'medianEngagementRate', 'engagement']));
  if (engagementRate === null && followers && (avgLikes !== null || avgComments !== null)) {
    engagementRate = ((avgLikes || 0) + (avgComments || 0)) / followers * 100;
  }

  // Posting frequency (posts/week) from timestamp span.
  let postsPerWeek = null;
  const times = posts.map(postTimestamp).filter(Boolean).sort((a, b) => a - b);
  if (times.length >= 2) {
    const spanDays = (times[times.length - 1] - times[0]) / 86400000;
    if (spanDays >= 1) postsPerWeek = (times.length - 1) / spanDays * 7;
    else postsPerWeek = times.length; // all within a day
  }

  const followerRatio = followers && following ? followers / following : null;

  const round = (n, d = 2) => (n === null ? null : Math.round(n * 10 ** d) / 10 ** d);

  return {
    followers: followers,
    following: following,
    avgViews: round(avgViews, 0),
    avgLikes: round(avgLikes, 0),
    avgComments: round(avgComments, 0),
    engagementRate: round(engagementRate, 2),
    followerRatio: round(followerRatio, 2),
    postsPerWeek: round(postsPerWeek, 1),
    sampleSize: posts.length,
  };
}

app.post('/api/scrape', async (req, res) => {
  try {
    const { seedAccounts, minFollowers, maxFollowers, maxProfiles, niche, location } = req.body;

    if (!seedAccounts || seedAccounts.length === 0) {
      return res.status(400).json({ error: 'At least one seed account is required.' });
    }

    const cleanSeeds = seedAccounts
      .map(s => String(s || '').trim().replace(/^@/, '').replace(/\/$/, ''))
      .filter(Boolean);
    if (!cleanSeeds.length) {
      return res.status(400).json({ error: 'Seed accounts list was empty after cleanup.' });
    }

    const niches = parseKeywordList(niche);

    // Network expansion is intentionally minimal — extra filters here have
    // historically caused 0-result runs. Niche/location are reserved for the
    // keyword-discovery fallback if this comes back empty.
    const actorInput = buildNetworkExpansionInput({
      seedAccounts: cleanSeeds,
      minFollowers,
      maxFollowers,
      maxProfiles,
    });

    const runData = await startApifyRun(actorInput);
    return res.json({
      runId: runData.data?.id,
      datasetId: runData.data?.defaultDatasetId,
      status: runData.data?.status,
      mode: 'networkExpansion',
      params: { seedAccounts: cleanSeeds, niches, location, minFollowers, maxFollowers, maxProfiles },
    });
  } catch (err) {
    console.error('scrape start error:', err);
    return res.status(err.status && Number.isInteger(err.status) ? err.status : 500).json({ error: err.message });
  }
});

// Fallback: keyword/hashtag discovery when network expansion returned nothing.
// Frontend calls this automatically after a 0-result first pass.
app.post('/api/scrape/fallback', async (req, res) => {
  try {
    const { niches, location, minFollowers, maxFollowers, maxProfiles, seedAccounts } = req.body || {};

    let keywords = parseKeywordList(Array.isArray(niches) ? niches.join(',') : niches);
    // If user gave no niche keywords, fall back to using the seed handles themselves
    if (!keywords.length && Array.isArray(seedAccounts)) {
      keywords = seedAccounts
        .map(s => String(s || '').replace(/[._\-0-9@]/g, ' ').trim())
        .flatMap(s => s.split(/\s+/))
        .filter(w => w.length >= 3)
        .slice(0, 5);
    }
    if (!keywords.length) {
      return res.status(400).json({ error: 'No niche keywords or usable seed handles to run keyword discovery.' });
    }

    const actorInput = buildKeywordDiscoveryInput({
      niches: keywords,
      minFollowers,
      maxFollowers,
      maxProfiles,
    });

    const runData = await startApifyRun(actorInput);
    return res.json({
      runId: runData.data?.id,
      datasetId: runData.data?.defaultDatasetId,
      status: runData.data?.status,
      mode: 'keywordDiscovery',
      keywords,
    });
  } catch (err) {
    console.error('scrape fallback error:', err);
    return res.status(err.status && Number.isInteger(err.status) ? err.status : 500).json({ error: err.message });
  }
});

app.get('/api/status/:runId', async (req, res) => {
  try {
    const data = await fetchRunStatus(req.params.runId);
    return res.json({
      status: data.data?.status,
      statusMessage: data.data?.statusMessage,
      datasetId: data.data?.defaultDatasetId,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.get('/api/results/:datasetId', async (req, res) => {
  try {
    const items = await fetchDatasetItems(req.params.datasetId);
    // Attach a computed analytics block to each profile so the frontend
    // gets avg views / ER / posting cadence without re-deriving it.
    const enriched = Array.isArray(items)
      ? items.map(it => {
          if (!it || typeof it !== 'object') return it;
          try { return { ...it, analytics: computeAnalytics(it) }; }
          catch (_) { return it; }
        })
      : items;
    return res.json(enriched);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.post('/api/export/excel', (req, res) => {
  try {
    const { data } = req.body;
    if (!data || !Array.isArray(data) || data.length === 0) {
      return res.status(400).json({ error: 'No data to export.' });
    }
    const ws = XLSX.utils.json_to_sheet(data);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Influencers');
    const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename=influencers.xlsx');
    return res.send(buffer);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════
//  Brand Profile + AI Brand-Fit Scoring
//  Store one brand profile describing what the user sells and who
//  they want to reach, then let Claude score each influencer 0-100
//  for how good a fit they are — with short reasoning + red flags.
// ═══════════════════════════════════════════════════════════

function normalizeBrandProfile(raw) {
  raw = raw || {};
  return {
    brandName: String(raw.brandName || '').trim(),
    website: String(raw.website || '').trim(),
    description: String(raw.description || '').trim(),
    productType: String(raw.productType || '').trim(),
    targetAudience: String(raw.targetAudience || '').trim(),
    values: String(raw.values || '').trim(),
    idealCreator: String(raw.idealCreator || '').trim(),
    updatedAt: new Date().toISOString(),
  };
}

app.get('/api/brand-profile', (req, res) => {
  const stored = readDB('brand_profile.json', {});
  res.json(stored && !Array.isArray(stored) ? stored : {});
});

app.post('/api/brand-profile', (req, res) => {
  const profile = normalizeBrandProfile(req.body);
  if (!profile.brandName && !profile.description) {
    return res.status(400).json({ error: 'Provide at least a brand name or description.' });
  }
  writeDB('brand_profile.json', profile);
  res.json({ ok: true, profile });
});

function buildBrandFitPrompt(brand) {
  return `You are an expert influencer-marketing strategist. Score how well each Instagram influencer fits the brand below for a PAID collaboration.

BRAND:
- Name: ${brand.brandName || 'N/A'}
- What they sell: ${brand.productType || brand.description || 'N/A'}
- Description: ${brand.description || 'N/A'}
- Target audience: ${brand.targetAudience || 'N/A'}
- Brand values: ${brand.values || 'N/A'}
- Ideal creator: ${brand.idealCreator || 'N/A'}

For EACH influencer, judge audience match, content/niche alignment, brand-safety, and whether their engagement looks healthy for their size. Weigh real audience fit over raw follower count.

Return ONLY a JSON array, no prose, no markdown fences. One object per influencer, same order as given:
[{"username":"<handle>","score":<0-100 integer>,"verdict":"<3-6 word summary>","reasons":["<short reason>","<short reason>"],"redFlags":["<short flag or omit if none>"]}]

Scoring guide: 80-100 excellent fit, 60-79 good, 40-59 marginal, 0-39 poor.`;
}

app.post('/api/brand-fit/score', async (req, res) => {
  try {
    if (!CLAUDE_API_KEY) {
      return res.status(400).json({ error: 'CLAUDE_API_KEY is not set on the server.' });
    }
    let { brand, influencers } = req.body || {};
    if (!brand || typeof brand !== 'object' || (!brand.brandName && !brand.description)) {
      const stored = readDB('brand_profile.json', {});
      if (stored && !Array.isArray(stored) && (stored.brandName || stored.description)) brand = stored;
    }
    if (!brand || (!brand.brandName && !brand.description)) {
      return res.status(400).json({ error: 'No brand profile provided. Fill in the Brand Profile first.' });
    }
    if (!Array.isArray(influencers) || !influencers.length) {
      return res.status(400).json({ error: 'Provide a non-empty influencers array.' });
    }

    // Cap per request to keep the Claude call fast + within token limits.
    const batch = influencers.slice(0, 25).map(i => ({
      username: String(i.username || '').replace(/^@/, ''),
      fullName: i.fullName || '',
      category: i.category || '',
      bio: (i.bio || '').slice(0, 300),
      followers: i.followers ?? null,
      engagementRate: i.engagementRate ?? null,
      avgViews: i.avgViews ?? null,
      avgLikes: i.avgLikes ?? null,
    }));

    const userContent = `Influencers to score (JSON):\n${JSON.stringify(batch, null, 2)}`;

    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': CLAUDE_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: CLAUDE_MODEL,
        max_tokens: 3000,
        // Disable thinking so it doesn't consume the token budget (Sonnet 5+
        // enables adaptive thinking by default). Harmlessly ignored by models
        // that don't support the field.
        thinking: { type: 'disabled' },
        system: buildBrandFitPrompt(brand),
        messages: [{ role: 'user', content: userContent }],
      }),
    });

    if (!claudeRes.ok) {
      const errBody = await claudeRes.text();
      return res.status(500).json({ error: `Claude API error: ${errBody.slice(0, 500)}` });
    }

    const claudeData = await claudeRes.json();
    let text = (claudeData.content?.[0]?.text || '').trim();
    // Strip accidental markdown fences.
    text = text.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
    // Grab the outermost JSON array if the model added stray text.
    const start = text.indexOf('[');
    const end = text.lastIndexOf(']');
    if (start !== -1 && end !== -1) text = text.slice(start, end + 1);

    let scores;
    try {
      scores = JSON.parse(text);
    } catch (err) {
      return res.status(502).json({ error: 'Could not parse AI scoring response.', raw: text.slice(0, 500) });
    }
    if (!Array.isArray(scores)) scores = [];

    // Normalize + key by username so the frontend can merge easily.
    const byUser = {};
    for (const s of scores) {
      if (!s || !s.username) continue;
      const uname = String(s.username).replace(/^@/, '').toLowerCase();
      const scoreNum = Math.max(0, Math.min(100, Math.round(Number(s.score) || 0)));
      byUser[uname] = {
        username: uname,
        score: scoreNum,
        verdict: String(s.verdict || '').trim(),
        reasons: Array.isArray(s.reasons) ? s.reasons.map(r => String(r)).slice(0, 4) : [],
        redFlags: Array.isArray(s.redFlags) ? s.redFlags.map(r => String(r)).filter(Boolean).slice(0, 4) : [],
      };
    }

    res.json({ ok: true, scored: Object.keys(byUser).length, scores: byUser });
  } catch (err) {
    console.error('brand-fit score error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════
//  Ready-to-Go Influencer Roster
//  A saved list of known-good creators you can DM instantly,
//  no scraping needed. Persisted to ready_influencers.json.
// ═══════════════════════════════════════════════════════════

function normalizeReadyInfluencer(raw) {
  if (!raw) return null;
  const username = String(raw.username || raw.handle || '')
    .trim().replace(/^@/, '').replace(/\/$/, '')
    .replace('https://instagram.com/', '').replace('https://www.instagram.com/', '');
  if (!username) return null;
  // Carry through analytics + brand-fit if the caller passed them (from the
  // Discovery table). Kept flat + optional so old records stay valid.
  const a = raw.analytics && typeof raw.analytics === 'object' ? raw.analytics : {};
  const num = v => (v === undefined || v === null || v === '' ? null : (Number.isFinite(Number(v)) ? Number(v) : null));
  return {
    username,
    fullName: String(raw.fullName || raw.name || '').trim(),
    followers: Number(raw.followers) || num(a.followers) || 0,
    category: String(raw.category || '').trim(),
    email: String(raw.email || '').trim(),
    notes: String(raw.notes || '').trim(),
    avgViews: num(raw.avgViews) ?? num(a.avgViews),
    avgLikes: num(raw.avgLikes) ?? num(a.avgLikes),
    engagementRate: num(raw.engagementRate) ?? num(a.engagementRate),
    followerRatio: num(raw.followerRatio) ?? num(a.followerRatio),
    postsPerWeek: num(raw.postsPerWeek) ?? num(a.postsPerWeek),
    fitScore: num(raw.fitScore),
    fitVerdict: raw.fitVerdict ? String(raw.fitVerdict).trim() : undefined,
    addedAt: raw.addedAt || new Date().toISOString(),
  };
}

app.get('/api/ready-influencers', (req, res) => {
  res.json(readDB('ready_influencers.json'));
});

app.post('/api/ready-influencers', (req, res) => {
  const incoming = Array.isArray(req.body?.influencers)
    ? req.body.influencers
    : (req.body?.username ? [req.body] : []);

  const cleaned = incoming.map(normalizeReadyInfluencer).filter(Boolean);
  if (!cleaned.length) {
    return res.status(400).json({ error: 'At least one valid username is required.' });
  }

  const existing = readDB('ready_influencers.json');
  const byName = new Map(existing.map(i => [i.username.toLowerCase(), i]));
  let added = 0;
  let updated = 0;

  for (const inf of cleaned) {
    const key = inf.username.toLowerCase();
    if (byName.has(key)) {
      // Merge: fill blanks, keep original addedAt
      const prev = byName.get(key);
      byName.set(key, {
        ...prev,
        fullName: inf.fullName || prev.fullName,
        followers: inf.followers || prev.followers,
        category: inf.category || prev.category,
        email: inf.email || prev.email,
        notes: inf.notes || prev.notes,
      });
      updated++;
    } else {
      byName.set(key, inf);
      added++;
    }
  }

  const all = Array.from(byName.values());
  writeDB('ready_influencers.json', all);
  res.json({ ok: true, added, updated, total: all.length, influencers: all });
});

app.delete('/api/ready-influencers/:username', (req, res) => {
  const uname = String(req.params.username || '').toLowerCase().replace(/^@/, '');
  let all = readDB('ready_influencers.json');
  const before = all.length;
  all = all.filter(i => i.username.toLowerCase() !== uname);
  writeDB('ready_influencers.json', all);
  res.json({ ok: true, removed: before - all.length, total: all.length });
});

// ═══════════════════════════════════════════════════════════
//  Campaign Routes
// ═══════════════════════════════════════════════════════════

app.get('/api/campaigns', (req, res) => {
  res.json(readDB('campaigns.json'));
});

app.get('/api/campaigns/:id', (req, res) => {
  const campaigns = readDB('campaigns.json');
  const campaign = campaigns.find(c => c.id === req.params.id);
  if (!campaign) return res.status(404).json({ error: 'Campaign not found.' });
  res.json(campaign);
});

app.post('/api/campaigns', (req, res) => {
  const { brandName, productName, collabType, brief, budgetMin, budgetMax, currency, totalBudget } = req.body;

  if (!brandName || !String(brandName).trim() || budgetMin === undefined || budgetMax === undefined) {
    return res.status(400).json({ error: 'Brand name, min budget, and max budget are required.' });
  }

  const min = Number(budgetMin);
  const max = Number(budgetMax);
  if (!Number.isFinite(min) || !Number.isFinite(max) || min < 0 || max < 0) {
    return res.status(400).json({ error: 'Min and max budget must be valid non-negative numbers.' });
  }
  if (min > max) {
    return res.status(400).json({ error: 'Min budget cannot be greater than max budget.' });
  }

  const totalNum = Number(totalBudget);
  const campaign = {
    id: genId(),
    brandName: String(brandName).trim(),
    productName: productName || '',
    collabType: collabType || 'Paid Reel',
    brief: brief || '',
    budgetMin: min,
    budgetMax: max,
    currency: currency || 'INR',
    totalBudget: Number.isFinite(totalNum) && totalNum > 0 ? totalNum : 0,
    totalSpent: 0,
    createdAt: new Date().toISOString(),
  };

  const campaigns = readDB('campaigns.json');
  campaigns.push(campaign);
  writeDB('campaigns.json', campaigns);
  res.json(campaign);
});

app.delete('/api/campaigns/:id', (req, res) => {
  let campaigns = readDB('campaigns.json');
  campaigns = campaigns.filter(c => c.id !== req.params.id);
  writeDB('campaigns.json', campaigns);

  let negotiations = readDB('negotiations.json');
  negotiations = negotiations.filter(n => n.campaignId !== req.params.id);
  writeDB('negotiations.json', negotiations);

  res.json({ ok: true });
});

// ═══════════════════════════════════════════════════════════
//  Mass Outreach: template rendering + bulk-send job runner
// ═══════════════════════════════════════════════════════════

function extractFirstName(fullName, username) {
  const base = (fullName || '').trim();
  if (base) {
    const clean = base.replace(/[🔥✨⭐️•·|\\/()\[\]]+/g, ' ').trim();
    const first = clean.split(/\s+/)[0];
    if (first && first.length >= 2) {
      return first.charAt(0).toUpperCase() + first.slice(1).toLowerCase();
    }
  }
  // Fallback: try to humanize the username (e.g. "aryan_fitness" → "Aryan")
  const uname = (username || '').split(/[._\-0-9]/)[0];
  if (uname && uname.length >= 2) {
    return uname.charAt(0).toUpperCase() + uname.slice(1).toLowerCase();
  }
  return 'there';
}

function renderTemplate(template, ctx) {
  if (!template) return '';
  return String(template).replace(/\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g, (_, key) => {
    const v = ctx[key];
    return v === undefined || v === null ? '' : String(v);
  });
}

function buildTemplateContext(creator, campaign) {
  const firstName = extractFirstName(creator.fullName, creator.username);
  return {
    first_name: firstName,
    firstname: firstName,
    name: creator.fullName || firstName,
    full_name: creator.fullName || firstName,
    username: creator.username || '',
    handle: '@' + (creator.username || ''),
    followers: creator.followers != null ? Number(creator.followers).toLocaleString() : '',
    category: creator.category || '',
    email: creator.email || '',
    brand: campaign.brandName || '',
    product: campaign.productName || '',
    collab_type: campaign.collabType || '',
    budget_min: `${campaign.currency || ''} ${campaign.budgetMin ?? ''}`.trim(),
    budget_max: `${campaign.currency || ''} ${campaign.budgetMax ?? ''}`.trim(),
    currency: campaign.currency || '',
  };
}

// In-memory bulk-job registry. Jobs are also mirrored to bulk_jobs.json
// so progress survives a brief restart.
const bulkJobs = new Map();
const BULK_JOB_RETENTION_MS = 1000 * 60 * 60 * 24; // 24h

function persistBulkJob(job) {
  bulkJobs.set(job.id, job);
  try {
    const all = readDB('bulk_jobs.json');
    const idx = all.findIndex(j => j.id === job.id);
    const snapshot = { ...job, log: (job.log || []).slice(-200) };
    if (idx === -1) all.push(snapshot); else all[idx] = snapshot;
    const trimmed = all.filter(j => Date.now() - new Date(j.createdAt).getTime() < BULK_JOB_RETENTION_MS);
    writeDB('bulk_jobs.json', trimmed);
  } catch (err) {
    console.error('persistBulkJob error:', err.message);
  }
}

function jobLog(job, type, msg, meta) {
  const entry = { at: new Date().toISOString(), type, msg, ...(meta ? { meta } : {}) };
  job.log = job.log || [];
  job.log.push(entry);
  if (job.log.length > 500) job.log = job.log.slice(-500);
}

async function runBulkJob(jobId) {
  const job = bulkJobs.get(jobId);
  if (!job) return;

  try {
    const campaigns = readDB('campaigns.json');
    const campaign = campaigns.find(c => c.id === job.campaignId);
    if (!campaign) {
      job.status = 'failed';
      jobLog(job, 'error', 'Campaign not found.');
      persistBulkJob(job);
      return;
    }

    const cookies = loadCookies();
    const check = validateCookies(cookies);
    if (!check.ok) {
      job.status = 'failed';
      jobLog(job, 'error', check.error);
      persistBulkJob(job);
      return;
    }

    for (let i = 0; i < job.creators.length; i++) {
      if (job.status === 'stopped') break;
      job.currentIndex = i;
      const creator = job.creators[i];
      const uname = String(creator.username || '').replace(/^@/, '').trim();

      if (!uname) {
        job.skipped++;
        jobLog(job, 'skipped', 'Empty username');
        persistBulkJob(job);
        continue;
      }

      const ctx = buildTemplateContext({ ...creator, username: uname }, campaign);
      const message = renderTemplate(job.template, ctx).trim();

      if (!message) {
        job.skipped++;
        jobLog(job, 'skipped', `@${uname}: template rendered empty`);
        persistBulkJob(job);
        continue;
      }

      // Skip if we already have a negotiation with this creator in this campaign
      const negotiations = readDB('negotiations.json');
      const existing = negotiations.find(n =>
        n.campaignId === campaign.id && n.username.toLowerCase() === uname.toLowerCase()
      );
      if (existing && !job.options?.reDmExisting) {
        job.skipped++;
        jobLog(job, 'skipped', `@${uname}: already contacted in this campaign`);
        persistBulkJob(job);
        continue;
      }

      if (!acquireSendLock(`bulk:${campaign.id}:${uname}`)) {
        job.skipped++;
        jobLog(job, 'skipped', `@${uname}: another send in flight`);
        persistBulkJob(job);
        continue;
      }

      try {
        jobLog(job, 'info', `→ @${uname}: ${message.slice(0, 80)}${message.length > 80 ? '…' : ''}`);
        const result = await sendDMviaApify(cookies, uname, message);
        if (!result.ok) {
          job.failed++;
          jobLog(job, 'error', `@${uname}: ${result.error}`);
        } else {
          job.sent++;
          jobLog(job, 'success', `@${uname}: DM delivered`);

          // Upsert the negotiation so it shows up in the campaign view
          const fresh = readDB('negotiations.json');
          const already = fresh.find(n =>
            n.campaignId === campaign.id && n.username.toLowerCase() === uname.toLowerCase()
          );
          if (already) {
            already.messages.push({
              role: 'you',
              content: message,
              timestamp: new Date().toISOString(),
              sentViaApify: true,
              bulkJobId: job.id,
            });
            already.updatedAt = new Date().toISOString();
          } else {
            fresh.push({
              id: genId(),
              campaignId: campaign.id,
              username: uname,
              fullName: creator.fullName || '',
              followers: creator.followers || 0,
              category: creator.category || '',
              email: creator.email || '',
              status: 'contacted',
              agreedPrice: null,
              messages: [{
                role: 'you',
                content: message,
                timestamp: new Date().toISOString(),
                sentViaApify: true,
                bulkJobId: job.id,
              }],
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            });
          }
          writeDB('negotiations.json', fresh);
        }
      } catch (err) {
        job.failed++;
        jobLog(job, 'error', `@${uname}: ${err.message}`);
      } finally {
        releaseSendLock(`bulk:${campaign.id}:${uname}`);
      }

      persistBulkJob(job);

      // Respect the user's configured delay between DMs
      if (i < job.creators.length - 1 && job.status !== 'stopped') {
        const delayMs = Math.max(0, Number(job.delaySeconds) || 45) * 1000;
        const endsAt = Date.now() + delayMs;
        while (Date.now() < endsAt) {
          if (job.status === 'stopped') break;
          await new Promise(r => setTimeout(r, Math.min(1000, endsAt - Date.now())));
        }
      }
    }

    job.status = job.status === 'stopped' ? 'stopped' : 'completed';
    job.finishedAt = new Date().toISOString();
    jobLog(job, 'info', `Job ${job.status}. Sent=${job.sent} Failed=${job.failed} Skipped=${job.skipped}`);
    persistBulkJob(job);
  } catch (err) {
    console.error('Bulk job fatal error:', err);
    job.status = 'failed';
    jobLog(job, 'error', `Fatal: ${err.message}`);
    persistBulkJob(job);
  }
}

app.post('/api/campaigns/:id/bulk-send', (req, res) => {
  const campaigns = readDB('campaigns.json');
  const campaign = campaigns.find(c => c.id === req.params.id);
  if (!campaign) return res.status(404).json({ error: 'Campaign not found.' });

  const { template, creators, delaySeconds, maxPerRun, reDmExisting } = req.body || {};
  if (!template || !template.trim()) {
    return res.status(400).json({ error: 'Message template is required.' });
  }
  if (!Array.isArray(creators) || creators.length === 0) {
    return res.status(400).json({ error: 'At least one creator is required.' });
  }

  // Early validation: require cookies to be configured before accepting the job
  const cookies = loadCookies();
  const check = validateCookies(cookies);
  if (!check.ok) return res.status(400).json({ error: check.error });

  const cap = Math.max(1, Math.min(500, Number(maxPerRun) || 30));
  const trimmedCreators = creators
    .map(c => (typeof c === 'string' ? { username: c } : c))
    .filter(c => c && c.username)
    .map(c => ({
      username: String(c.username).replace(/^@/, '').trim(),
      fullName: c.fullName || '',
      followers: c.followers || 0,
      category: c.category || '',
      email: c.email || '',
    }))
    .filter(c => c.username)
    .slice(0, cap);

  if (!trimmedCreators.length) {
    return res.status(400).json({ error: 'No valid usernames in the list.' });
  }

  const job = {
    id: genId(),
    campaignId: campaign.id,
    template,
    creators: trimmedCreators,
    delaySeconds: Math.max(5, Math.min(600, Number(delaySeconds) || 45)),
    options: { reDmExisting: !!reDmExisting },
    status: 'running',
    sent: 0,
    failed: 0,
    skipped: 0,
    currentIndex: 0,
    total: trimmedCreators.length,
    log: [],
    createdAt: new Date().toISOString(),
  };

  persistBulkJob(job);
  jobLog(job, 'info', `Bulk outreach started — ${job.total} creators, ${job.delaySeconds}s delay.`);
  persistBulkJob(job);

  // Fire-and-forget; polled via /api/bulk-jobs/:id
  runBulkJob(job.id).catch(err => {
    console.error('runBulkJob unhandled:', err);
  });

  res.json({ jobId: job.id, total: job.total });
});

app.get('/api/bulk-jobs/:id', (req, res) => {
  const inMem = bulkJobs.get(req.params.id);
  if (inMem) return res.json(inMem);
  const all = readDB('bulk_jobs.json');
  const job = all.find(j => j.id === req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found.' });
  res.json(job);
});

app.post('/api/bulk-jobs/:id/stop', (req, res) => {
  const job = bulkJobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found or already completed.' });
  if (job.status === 'running') {
    job.status = 'stopped';
    jobLog(job, 'info', 'Stop requested by user.');
    persistBulkJob(job);
  }
  res.json({ ok: true, status: job.status });
});

app.post('/api/templates/preview', (req, res) => {
  const { template, creators, campaignId } = req.body || {};
  if (!template) return res.status(400).json({ error: 'template required' });
  const campaigns = readDB('campaigns.json');
  const campaign = campaigns.find(c => c.id === campaignId) || {};
  const sample = (Array.isArray(creators) ? creators : []).slice(0, 3);
  const previews = sample.map(c => {
    const ctx = buildTemplateContext({
      username: c.username || '',
      fullName: c.fullName || '',
      followers: c.followers,
      category: c.category,
      email: c.email,
    }, campaign);
    return { ...c, rendered: renderTemplate(template, ctx) };
  });
  res.json({ previews });
});

// ═══════════════════════════════════════════════════════════
//  Negotiation Routes
// ═══════════════════════════════════════════════════════════

app.get('/api/negotiations', (req, res) => {
  let negotiations = readDB('negotiations.json');
  if (req.query.campaignId) {
    negotiations = negotiations.filter(n => n.campaignId === req.query.campaignId);
  }
  res.json(negotiations);
});

app.get('/api/negotiations/:id', (req, res) => {
  const negotiations = readDB('negotiations.json');
  const neg = negotiations.find(n => n.id === req.params.id);
  if (!neg) return res.status(404).json({ error: 'Negotiation not found.' });
  res.json(neg);
});

app.post('/api/negotiations', (req, res) => {
  const { campaignId, influencers } = req.body;
  if (!campaignId || !influencers || !influencers.length) {
    return res.status(400).json({ error: 'Campaign ID and influencers list required.' });
  }

  const campaigns = readDB('campaigns.json');
  const campaign = campaigns.find(c => c.id === campaignId);
  if (!campaign) return res.status(404).json({ error: 'Campaign not found.' });

  const negotiations = readDB('negotiations.json');
  const created = [];

  for (const inf of influencers) {
    const existing = negotiations.find(
      n => n.campaignId === campaignId && n.username === inf.username
    );
    if (existing) continue;

    const neg = {
      id: genId(),
      campaignId,
      username: inf.username || '',
      fullName: inf.fullName || '',
      followers: inf.followers || 0,
      category: inf.category || '',
      email: inf.email || '',
      status: 'contacted',
      agreedPrice: null,
      messages: [{
        role: 'you',
        content: inf.firstMessage || 'Initial DM sent via InfluencerFind',
        timestamp: new Date().toISOString(),
      }],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    negotiations.push(neg);
    created.push(neg);
  }

  writeDB('negotiations.json', negotiations);
  res.json(created);
});

// User submits a creator's reply
app.post('/api/negotiations/:id/reply', (req, res) => {
  const { message } = req.body;
  if (!message || !message.trim()) {
    return res.status(400).json({ error: 'Message is required.' });
  }

  const negotiations = readDB('negotiations.json');
  const neg = negotiations.find(n => n.id === req.params.id);
  if (!neg) return res.status(404).json({ error: 'Negotiation not found.' });

  neg.messages.push({
    role: 'creator',
    content: message.trim(),
    timestamp: new Date().toISOString(),
  });

  if (neg.status === 'contacted') neg.status = 'replied';
  if (neg.status !== 'closed' && neg.status !== 'rejected') neg.status = 'negotiating';
  neg.updatedAt = new Date().toISOString();

  writeDB('negotiations.json', negotiations);
  res.json(neg);
});

// AI generates the next negotiation response
app.post('/api/negotiations/:id/generate', async (req, res) => {
  try {
    const negotiations = readDB('negotiations.json');
    const neg = negotiations.find(n => n.id === req.params.id);
    if (!neg) return res.status(404).json({ error: 'Negotiation not found.' });

    const consecutiveYou = countConsecutiveYou(neg.messages);
    if (consecutiveYou >= MAX_CONSECUTIVE_YOU) {
      return res.status(400).json({
        error: `Already sent ${consecutiveYou} messages in a row. Wait for the creator to reply before sending more — sending more would look spammy.`,
      });
    }

    const campaigns = readDB('campaigns.json');
    const campaign = campaigns.find(c => c.id === neg.campaignId);
    if (!campaign) return res.status(404).json({ error: 'Campaign not found.' });

    const conversationHistory = neg.messages.map(m => ({
      role: m.role === 'creator' ? 'user' : 'assistant',
      content: m.content,
    }));

    const systemPrompt = buildNegotiationPrompt(campaign, neg);

    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': CLAUDE_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: CLAUDE_MODEL,
        max_tokens: 500,
        thinking: { type: 'disabled' },
        system: systemPrompt,
        messages: conversationHistory,
      }),
    });

    if (!claudeRes.ok) {
      const errBody = await claudeRes.text();
      return res.status(500).json({ error: `Claude API error: ${errBody}` });
    }

    const claudeData = await claudeRes.json();
    const aiMessage = (claudeData.content?.[0]?.text || '').trim();

    if (/^wait\b/i.test(aiMessage) || aiMessage.toUpperCase() === 'WAIT') {
      return res.status(400).json({
        error: 'The AI decided not to send another message right now — the creator needs to reply first to avoid looking spammy.',
        code: 'AI_SUGGESTS_WAIT',
      });
    }

    res.json({ message: aiMessage });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// Send AI response via Apify DM actor
app.post('/api/negotiations/:id/send', async (req, res) => {
  const negId = req.params.id;
  const { message, force } = req.body || {};
  if (!message) return res.status(400).json({ error: 'Message is required.' });

  if (!acquireSendLock(negId)) {
    return res.status(409).json({
      error: 'A DM to this creator is already being sent. Please wait a moment before trying again.',
    });
  }

  try {
    const negotiations = readDB('negotiations.json');
    const neg = negotiations.find(n => n.id === negId);
    if (!neg) return res.status(404).json({ error: 'Negotiation not found.' });

    const consecutiveYou = countConsecutiveYou(neg.messages);
    if (consecutiveYou >= MAX_CONSECUTIVE_YOU) {
      return res.status(400).json({
        error: `You've already sent ${consecutiveYou} messages in a row to @${neg.username}. Wait for them to reply — sending another would look spammy.`,
      });
    }

    // Duplicate / near-duplicate guard across the whole thread.
    // "force: true" can override (e.g. user edits and explicitly re-sends).
    if (!force) {
      const dup = findDuplicateYouMessage(neg.messages, message);
      if (dup.score >= DUPLICATE_SIMILARITY_THRESHOLD) {
        return res.status(400).json({
          error: `This message is ${(dup.score * 100).toFixed(0)}% similar to one you already sent. Sending near-duplicates makes the outreach look like spam. Edit the message or click "Regenerate" to rewrite it.`,
          duplicateOf: dup.message?.content,
          similarity: dup.score,
          code: 'DUPLICATE_MESSAGE',
        });
      }
    }

    const cookies = loadCookies();
    const cookieCheck = validateCookies(cookies);
    if (!cookieCheck.ok) {
      return res.status(400).json({ error: cookieCheck.error });
    }

    const sendResult = await sendDMviaApify(cookies, neg.username, message);
    if (!sendResult.ok) {
      return res.status(500).json({
        error: sendResult.error,
        details: sendResult.details,
        rawResult: sendResult.raw,
      });
    }

    // Re-read in case something else touched the file during the send.
    const freshDb = readDB('negotiations.json');
    const fresh = freshDb.find(n => n.id === negId) || neg;
    fresh.messages = fresh.messages || [];
    fresh.messages.push({
      role: 'you',
      content: message,
      timestamp: new Date().toISOString(),
      sentViaApify: true,
    });
    fresh.updatedAt = new Date().toISOString();
    const idx = freshDb.findIndex(n => n.id === negId);
    if (idx !== -1) freshDb[idx] = fresh; else freshDb.push(fresh);
    writeDB('negotiations.json', freshDb);

    res.json({ ok: true, result: sendResult.raw, negotiation: fresh });
  } catch (err) {
    console.error('DM send error:', err);
    return res.status(500).json({ error: err.message });
  } finally {
    releaseSendLock(negId);
  }
});

// Manually add your own message (without sending via Apify)
app.post('/api/negotiations/:id/manual-send', (req, res) => {
  const { message } = req.body;
  if (!message) return res.status(400).json({ error: 'Message is required.' });

  const negotiations = readDB('negotiations.json');
  const neg = negotiations.find(n => n.id === req.params.id);
  if (!neg) return res.status(404).json({ error: 'Negotiation not found.' });

  neg.messages.push({
    role: 'you',
    content: message,
    timestamp: new Date().toISOString(),
    sentViaApify: false,
  });
  neg.updatedAt = new Date().toISOString();
  writeDB('negotiations.json', negotiations);

  res.json(neg);
});

// Update negotiation status or agreed price
app.patch('/api/negotiations/:id', (req, res) => {
  const { status, agreedPrice } = req.body;

  const negotiations = readDB('negotiations.json');
  const neg = negotiations.find(n => n.id === req.params.id);
  if (!neg) return res.status(404).json({ error: 'Negotiation not found.' });

  if (status) neg.status = status;
  if (agreedPrice !== undefined) neg.agreedPrice = Number(agreedPrice);

  if (status === 'closed' && neg.agreedPrice) {
    const campaigns = readDB('campaigns.json');
    const campaign = campaigns.find(c => c.id === neg.campaignId);
    if (campaign) {
      campaign.totalSpent = (campaign.totalSpent || 0) + neg.agreedPrice;
      writeDB('campaigns.json', campaigns);
    }
  }

  neg.updatedAt = new Date().toISOString();
  writeDB('negotiations.json', negotiations);
  res.json(neg);
});

// ═══════════════════════════════════════════════════════════
//  Instagram Cookies Management
// ═══════════════════════════════════════════════════════════

const REQUIRED_COOKIE_NAMES = ['sessionid', 'ds_user_id', 'csrftoken'];

// One-time pairing codes for the browser extension. A code is minted by an
// authenticated in-app action, shown to the user, entered into the extension,
// and consumed on first use. Short TTL, in-memory only.
const PAIR_TTL_MS = 10 * 60 * 1000;
const pairingCodes = new Map(); // code -> expiresAt

function mintPairingCode() {
  // 6-digit human-typable code.
  const code = String(100000 + Math.floor(genId().split('').reduce((a, c) => a + c.charCodeAt(0), 0) * 7919 % 900000));
  const expiresAt = Date.now() + PAIR_TTL_MS;
  pairingCodes.set(code, expiresAt);
  // Sweep expired codes.
  for (const [c, exp] of pairingCodes) if (exp < Date.now()) pairingCodes.delete(c);
  return { code, expiresAt };
}

function consumePairingCode(code) {
  const exp = pairingCodes.get(String(code || ''));
  if (!exp) return false;
  pairingCodes.delete(String(code));
  return exp >= Date.now();
}

// Keep only the cookies the app actually needs, normalized to the standard
// {name, value, domain, path, ...} shape Instagram cookie exporters produce.
function filterRequiredCookies(cookies) {
  if (!Array.isArray(cookies)) return [];
  const wanted = new Set(REQUIRED_COOKIE_NAMES);
  return cookies
    .filter(c => c && wanted.has(c.name))
    .map(c => ({
      name: c.name,
      value: String(c.value ?? ''),
      domain: c.domain || '.instagram.com',
      path: c.path || '/',
      secure: c.secure !== false,
      httpOnly: !!c.httpOnly,
      sameSite: c.sameSite || 'Lax',
      ...(c.expirationDate ? { expirationDate: c.expirationDate } : {}),
    }));
}

// Parse a "sessionid=x; csrftoken=y; ds_user_id=z" cookie string into objects.
function cookiesFromString(str) {
  return String(str).split(/;\s*/).map(pair => {
    const i = pair.indexOf('=');
    if (i === -1) return null;
    const name = pair.slice(0, i).trim();
    const value = pair.slice(i + 1).trim();
    if (!name) return null;
    return { name, value, domain: '.instagram.com', path: '/' };
  }).filter(Boolean);
}

// Turn a flat { sessionid: '..', csrftoken: '..' } object into cookie objects.
function objToCookies(obj) {
  const out = [];
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === 'string' || typeof v === 'number') {
      out.push({ name: k, value: String(v), domain: '.instagram.com', path: '/' });
    }
  }
  return out;
}

// Cookie-returning Apify actors are inconsistent — cookies may come back as an
// array of {name,value}, a "a=b; c=d" string, a flat object keyed by cookie
// name, or nested under cookies/session/data. Dig them out of any of these.
function extractCookiesDeep(node, depth = 0) {
  if (!node || depth > 5) return null;

  if (Array.isArray(node)) {
    if (node.some(x => x && typeof x === 'object' && x.name && ('value' in x))) {
      return node.filter(x => x && x.name);
    }
    for (const el of node) {
      const r = extractCookiesDeep(el, depth + 1);
      if (r) return r;
    }
    return null;
  }

  if (typeof node === 'string') {
    if (/sessionid=/.test(node)) {
      const c = cookiesFromString(node);
      if (c.length) return c;
    }
    return null;
  }

  if (typeof node === 'object') {
    // Flat object keyed directly by cookie names.
    if (REQUIRED_COOKIE_NAMES.some(n => n in node)) return objToCookies(node);
    // Common container keys.
    for (const key of ['cookies', 'sessionCookies', 'session', 'cookie', 'data', 'result', 'output']) {
      if (node[key] !== undefined) {
        if (typeof node[key] === 'string') {
          const c = cookiesFromString(node[key]);
          if (c.length) return c;
        }
        const r = extractCookiesDeep(node[key], depth + 1);
        if (r) return r;
      }
    }
    // Any string value that looks like a cookie string.
    for (const v of Object.values(node)) {
      if (typeof v === 'string' && /sessionid=/.test(v)) {
        const c = cookiesFromString(v);
        if (c.length) return c;
      }
    }
    // Recurse into nested objects/arrays.
    for (const v of Object.values(node)) {
      if (v && typeof v === 'object') {
        const r = extractCookiesDeep(v, depth + 1);
        if (r) return r;
      }
    }
  }
  return null;
}

// Load cookies from disk, falling back to INSTAGRAM_COOKIES env var
// (env var is useful on ephemeral hosts like Render free tier where
//  the data/ folder is wiped on every cold start / redeploy).
function loadCookies() {
  try {
    const onDisk = readDB('instagram_cookies.json');
    if (Array.isArray(onDisk) && onDisk.length) return onDisk;
  } catch (_) {}

  const envRaw = process.env.INSTAGRAM_COOKIES;
  if (envRaw) {
    try {
      const parsed = JSON.parse(envRaw);
      if (Array.isArray(parsed) && parsed.length) return parsed;
    } catch (err) {
      console.error('INSTAGRAM_COOKIES env var is set but not valid JSON:', err.message);
    }
  }
  return [];
}

function validateCookies(cookies) {
  if (!Array.isArray(cookies) || !cookies.length) {
    return { ok: false, error: 'Instagram cookies not configured. Go to Settings to add them.' };
  }
  const names = new Set(cookies.map(c => (c && c.name) || '').filter(Boolean));
  const missing = REQUIRED_COOKIE_NAMES.filter(n => !names.has(n));
  if (missing.length) {
    return {
      ok: false,
      error: `Cookies are missing required keys: ${missing.join(', ')}. Re-export cookies from Instagram while logged in and paste the full JSON array.`,
    };
  }
  return { ok: true };
}

// Send a single DM via the Apify actor and carefully parse the result so
// we actually report failures instead of always returning success.
async function sendDMviaApify(cookies, username, message) {
  const actorId = 'am_production~instagram-direct-messages-dms-automation';
  const actorInput = {
    INSTAGRAM_COOKIES: cookies,
    influencers: [username],
    messages: [message],
  };

  let startRes;
  try {
    startRes = await fetch(
      `https://api.apify.com/v2/acts/${actorId}/run-sync-get-dataset-items?token=${APIFY_TOKEN}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(actorInput),
        signal: AbortSignal.timeout(180000),
      }
    );
  } catch (err) {
    return { ok: false, error: `Could not reach Apify: ${err.message}` };
  }

  const rawText = await startRes.text();
  let parsed;
  try { parsed = JSON.parse(rawText); } catch (_) { parsed = rawText; }

  if (!startRes.ok) {
    const msg = (parsed && parsed.error && (parsed.error.message || parsed.error)) || rawText.slice(0, 400);
    return {
      ok: false,
      error: `Apify API error (${startRes.status}): ${msg}`,
      raw: parsed,
    };
  }

  // run-sync-get-dataset-items returns an array of dataset items.
  // The actor pushes one item per influencer with success/failure info.
  const items = Array.isArray(parsed) ? parsed : [];
  if (!items.length) {
    return {
      ok: false,
      error: 'Apify actor returned no dataset items. The actor may not have pushed results (subscription expired, timeout, or cookies rejected by Instagram).',
      raw: parsed,
    };
  }

  // Try to find an item for this username, else use the first.
  const item = items.find(it =>
    it && typeof it === 'object' &&
    [it.username, it.influencer, it.user, it.handle]
      .filter(Boolean)
      .some(v => String(v).toLowerCase() === username.toLowerCase())
  ) || items[0];

  const success = detectActorSuccess(item);
  if (!success.ok) {
    return {
      ok: false,
      error: `Instagram DM not delivered: ${success.reason}`,
      details: item,
      raw: parsed,
    };
  }

  return { ok: true, raw: parsed, details: item };
}

// The actor's output schema isn't strict — it returns free-form messages.
// Look at common fields to decide if the send succeeded.
function detectActorSuccess(item) {
  if (!item || typeof item !== 'object') {
    return { ok: false, reason: 'Actor returned no structured result.' };
  }

  if (typeof item.success === 'boolean') {
    return item.success
      ? { ok: true }
      : { ok: false, reason: item.error || item.message || item.reason || 'Actor reported success=false.' };
  }
  if (item.status) {
    const s = String(item.status).toLowerCase();
    if (['sent', 'success', 'ok', 'delivered'].some(k => s.includes(k))) return { ok: true };
    if (['fail', 'error', 'blocked', 'invalid', 'expired', 'unauthorized', 'rate'].some(k => s.includes(k))) {
      return { ok: false, reason: item.error || item.message || item.status };
    }
  }
  if (item.error || item.errorMessage) {
    return { ok: false, reason: item.error || item.errorMessage };
  }
  const msg = String(item.message || item.result || '').toLowerCase();
  if (msg && /(fail|error|not sent|could not|invalid|expired|unauthorized|block)/.test(msg)) {
    return { ok: false, reason: item.message || item.result };
  }
  // If nothing indicates failure, assume success.
  return { ok: true };
}

app.get('/api/settings/cookies', (req, res) => {
  const cookies = loadCookies();
  const check = validateCookies(cookies);
  res.json({
    hasCookies: cookies.length > 0,
    count: cookies.length,
    valid: check.ok,
    error: check.ok ? null : check.error,
    source: cookies.length
      ? (fs.existsSync(path.join(DATA_DIR, 'instagram_cookies.json')) && readDB('instagram_cookies.json').length
          ? 'disk'
          : 'env')
      : null,
  });
});

app.post('/api/settings/cookies', (req, res) => {
  const { cookies } = req.body;
  if (!cookies || !Array.isArray(cookies)) {
    return res.status(400).json({ error: 'Cookies must be a JSON array.' });
  }
  const check = validateCookies(cookies);
  if (!check.ok) {
    return res.status(400).json({ error: check.error });
  }
  writeDB('instagram_cookies.json', cookies);
  res.json({ ok: true, count: cookies.length });
});

// Diagnostic: verify cookies actually work against Instagram right now
app.post('/api/settings/cookies/test', async (req, res) => {
  const cookies = loadCookies();
  const check = validateCookies(cookies);
  if (!check.ok) return res.status(400).json({ ok: false, error: check.error });

  try {
    const inbox = await fetchInstagramInbox(cookies);
    const threadCount = inbox?.inbox?.threads?.length ?? 0;
    const viewer = inbox?.viewer || inbox?.inbox?.viewer || null;
    res.json({
      ok: true,
      threadCount,
      username: viewer?.username || null,
      message: `Instagram reachable. Found ${threadCount} threads in inbox.`,
    });
  } catch (err) {
    res.status(400).json({
      ok: false,
      error: `Instagram rejected these cookies: ${err.message}. They are likely expired — log out and log back in on Instagram, then re-export.`,
    });
  }
});

// Diagnostic: send a test DM to any username without touching negotiations
app.post('/api/settings/test-dm', async (req, res) => {
  const { username, message } = req.body || {};
  if (!username || !message) {
    return res.status(400).json({ error: 'username and message are required' });
  }

  const cookies = loadCookies();
  const check = validateCookies(cookies);
  if (!check.ok) return res.status(400).json({ error: check.error });

  if (!APIFY_TOKEN) {
    return res.status(400).json({ error: 'APIFY_TOKEN is not set on the server.' });
  }

  const result = await sendDMviaApify(cookies, String(username).replace(/^@/, ''), message);
  if (!result.ok) return res.status(500).json(result);
  res.json(result);
});

// ── Auto-import: browser extension ─────────────────────────
// Mint a one-time pairing code (this endpoint is behind the app's normal
// auth). The user types the code into the extension.
app.get('/api/settings/pair', (req, res) => {
  const { code, expiresAt } = mintPairingCode();
  res.json({ code, expiresAt, ttlSeconds: Math.round(PAIR_TTL_MS / 1000) });
});

// ── Download the browser extension as a .zip ───────────────
// Packaged on the fly from the extension/ folder so it's always in sync with
// the code. Zero-dependency, store-mode (uncompressed) ZIP — small enough that
// no compression is needed and it avoids pulling in an archiver library.

// Standard CRC-32 (used by the ZIP format).
const CRC32_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC32_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// Build a store-mode ZIP from [{ name, data:Buffer }].
function buildZip(files) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const f of files) {
    const nameBuf = Buffer.from(f.name, 'utf8');
    const crc = crc32(f.data);
    const size = f.data.length;

    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); // local file header sig
    lh.writeUInt16LE(20, 4);         // version needed
    lh.writeUInt16LE(0, 6);          // flags
    lh.writeUInt16LE(0, 8);          // method 0 = store
    lh.writeUInt16LE(0, 10);         // mod time
    lh.writeUInt16LE(0x21, 12);      // mod date (arbitrary fixed date)
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(size, 18);
    lh.writeUInt32LE(size, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    lh.writeUInt16LE(0, 28);
    locals.push(lh, nameBuf, f.data);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0); // central dir header sig
    cd.writeUInt16LE(20, 4);         // version made by
    cd.writeUInt16LE(20, 6);         // version needed
    cd.writeUInt16LE(0, 8);          // flags
    cd.writeUInt16LE(0, 10);         // method
    cd.writeUInt16LE(0, 12);         // mod time
    cd.writeUInt16LE(0x21, 14);      // mod date
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(size, 20);
    cd.writeUInt32LE(size, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt32LE(offset, 42);    // local header offset
    central.push(cd, nameBuf);

    offset += lh.length + nameBuf.length + size;
  }
  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); // end of central dir sig
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);    // central dir offset
  return Buffer.concat([...locals, centralBuf, eocd]);
}

app.get('/api/extension/download', (req, res) => {
  try {
    const extDir = path.join(__dirname, 'extension');
    if (!fs.existsSync(extDir)) {
      return res.status(404).json({ error: 'Extension folder not found on the server.' });
    }
    // Only ship the files the extension actually needs.
    const wanted = ['manifest.json', 'popup.html', 'popup.js', 'README.md'];
    const files = [];
    for (const name of wanted) {
      const p = path.join(extDir, name);
      if (fs.existsSync(p)) files.push({ name, data: fs.readFileSync(p) });
    }
    if (!files.length) {
      return res.status(404).json({ error: 'No extension files available to package.' });
    }
    const zip = buildZip(files);
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', 'attachment; filename=quickads-instagram-connect.zip');
    res.setHeader('Content-Length', zip.length);
    return res.send(zip);
  } catch (err) {
    console.error('extension download error:', err);
    return res.status(500).json({ error: err.message });
  }
});

// The extension POSTs the 3 required Instagram cookies here with the code.
// Exempt from Basic auth (see middleware) — the code is the credential.
app.post('/api/settings/cookies/import', (req, res) => {
  const { code, cookies } = req.body || {};
  if (!consumePairingCode(code)) {
    return res.status(401).json({ error: 'Invalid or expired pairing code. Generate a new one in the app.' });
  }
  const filtered = filterRequiredCookies(cookies);
  const check = validateCookies(filtered);
  if (!check.ok) {
    return res.status(400).json({ error: check.error });
  }
  writeDB('instagram_cookies.json', filtered);
  res.json({ ok: true, count: filtered.length, message: 'Instagram connected via extension.' });
});

// Resolve a Chromium executable. Prefers CHROMIUM_PATH, then whatever
// Playwright shipped/pre-installed under PLAYWRIGHT_BROWSERS_PATH (the build
// number often differs from what the pinned Playwright expects, so we probe
// for any chrome/chrome-headless-shell binary rather than trust the default).
let _chromiumPathCache;
function resolveChromiumPath() {
  if (_chromiumPathCache !== undefined) return _chromiumPathCache;
  const os = require('os');
  if (process.env.CHROMIUM_PATH && fs.existsSync(process.env.CHROMIUM_PATH)) {
    return (_chromiumPathCache = process.env.CHROMIUM_PATH);
  }
  // Scan every place a Playwright/Chromium build might live — the pinned
  // Playwright often expects a build number that differs from what's actually
  // downloaded, so we probe rather than trust the default path.
  const roots = [
    process.env.PLAYWRIGHT_BROWSERS_PATH,
    path.join(os.homedir() || '', '.cache', 'ms-playwright'), // Linux default (incl. Render)
    '/opt/render/.cache/ms-playwright',
    path.join(__dirname, 'node_modules', 'playwright-core', '.local-browsers'),
  ].filter(Boolean);
  const subpaths = [
    ['chrome-linux', 'chrome'],
    ['chrome-linux', 'headless_shell'],
    ['chrome-linux', 'chrome-headless-shell'],
    ['chrome-headless-shell-linux64', 'chrome-headless-shell'],
  ];
  const candidates = [];
  for (const root of roots) {
    try {
      if (!fs.existsSync(root)) continue;
      for (const dir of fs.readdirSync(root)) {
        if (!/^chromium/i.test(dir)) continue;
        for (const sp of subpaths) candidates.push(path.join(root, dir, ...sp));
      }
    } catch (_) {}
  }
  const found = candidates.find(p => { try { return fs.existsSync(p); } catch { return false; } });
  return (_chromiumPathCache = found || null);
}

// ── Auto-import: headless login ────────────────────────────
// Logs into Instagram with a real headless Chromium (Playwright) and
// captures the session cookies. Playwright is an optional dependency and
// lazy-required, so the app still runs everywhere without it.
app.post('/api/settings/cookies/login', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: 'username and password are required.' });
  }

  let chromium;
  try {
    ({ chromium } = require('playwright'));
  } catch (_) {
    return res.status(501).json({
      error: 'Headless login is not available on this server (the "playwright" package is not installed). Use the browser extension or paste cookies instead.',
      code: 'PLAYWRIGHT_MISSING',
    });
  }

  let browser;
  try {
    browser = await chromium.launch({
      headless: true,
      ...(resolveChromiumPath() ? { executablePath: resolveChromiumPath() } : {}),
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled'],
    });
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      viewport: { width: 1280, height: 800 },
    });
    const page = await context.newPage();
    await page.goto('https://www.instagram.com/accounts/login/', { waitUntil: 'domcontentloaded', timeout: 45000 });

    // Dismiss cookie-consent banner if present (EU).
    try {
      await page.click('button:has-text("Allow all cookies"), button:has-text("Accept")', { timeout: 4000 });
    } catch (_) {}

    await page.fill('input[name="username"]', String(username), { timeout: 20000 });
    await page.fill('input[name="password"]', String(password));
    await page.click('button[type="submit"]');

    // Give Instagram a moment to respond (redirect, error, or challenge).
    await page.waitForTimeout(6000);

    const url = page.url();
    const bodyText = (await page.textContent('body').catch(() => '')) || '';

    // Detect 2FA / checkpoint / bad password before reading cookies.
    if (/two-factor|verificationCode|security code|challenge|checkpoint/i.test(url + bodyText)) {
      await browser.close();
      return res.status(422).json({
        error: 'Instagram requires 2FA or a security checkpoint for this login. Complete it in a normal browser, then use the extension or paste cookies. Headless login only works for accounts without a login challenge.',
        code: 'CHALLENGE_REQUIRED',
      });
    }
    if (/incorrect|wasn.t right|try again|find your account/i.test(bodyText) && !/[?&]/.test(url.replace('accounts/login', ''))) {
      // Heuristic: still on login page with an error message.
      const allCookies = await context.cookies();
      if (!allCookies.some(c => c.name === 'sessionid' && c.value)) {
        await browser.close();
        return res.status(401).json({ error: 'Instagram rejected the username or password.' });
      }
    }

    const raw = await context.cookies();
    await browser.close();

    const igCookies = raw.filter(c => /instagram\.com$/.test(c.domain) || c.domain.includes('instagram'));
    const filtered = filterRequiredCookies(igCookies);
    const check = validateCookies(filtered);
    if (!check.ok) {
      return res.status(401).json({
        error: 'Login did not produce a valid Instagram session (no sessionid). The account may need a login challenge — use the extension or paste cookies instead.',
      });
    }

    writeDB('instagram_cookies.json', filtered);
    res.json({ ok: true, count: filtered.length, message: 'Instagram connected via headless login.' });
  } catch (err) {
    try { if (browser) await browser.close(); } catch (_) {}
    console.error('headless login error:', err);
    const m = String((err && err.message) || '');
    // Browser binary not downloaded on the server.
    if (/Executable doesn'?t exist|playwright install|Failed to launch the browser process|spawn .*ENOENT/i.test(m)) {
      return res.status(501).json({
        error: 'Chromium is not installed on this server, so headless login can\'t run here. Use the browser extension or paste-cookies method instead. (To enable headless login, the deploy build must run "npx playwright install chromium".)',
        code: 'BROWSER_NOT_INSTALLED',
      });
    }
    // Browser present but the OS is missing shared libraries it needs.
    if (/error while loading shared librar|cannot open shared object|lib(nss3|atk|gbm|asound|xkbcommon)/i.test(m)) {
      return res.status(501).json({
        error: 'The server is missing system libraries Chromium needs, so headless login can\'t run here (common on non-Docker hosts). Use the browser extension or paste-cookies method instead.',
        code: 'BROWSER_DEPS_MISSING',
      });
    }
    res.status(500).json({ error: `Headless login failed: ${m}` });
  }
});

// ── Auto-connect: login via an Apify actor ─────────────────
// Runs an Apify actor that logs into Instagram (on Apify's infrastructure,
// with proxies) and returns the session cookies — no browser needed on this
// server. Actor id + input field names are env-configurable so you can point
// it at a different actor without code changes.
const IG_LOGIN_ACTOR_ID = process.env.IG_LOGIN_ACTOR_ID || 'shareze001~instagram-cookies';
const IG_LOGIN_USER_FIELD = process.env.IG_LOGIN_USER_FIELD || 'username';
const IG_LOGIN_PASS_FIELD = process.env.IG_LOGIN_PASS_FIELD || 'password';
const IG_LOGIN_CODE_FIELD = process.env.IG_LOGIN_CODE_FIELD || 'code';

app.post('/api/settings/cookies/apify-login', async (req, res) => {
  const { username, password, code } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: 'username and password are required.' });
  }
  if (!APIFY_TOKEN) {
    return res.status(400).json({ error: 'APIFY_TOKEN is not set on the server.' });
  }

  const input = {
    [IG_LOGIN_USER_FIELD]: String(username).replace(/^@/, ''),
    [IG_LOGIN_PASS_FIELD]: String(password),
    ...(code ? { [IG_LOGIN_CODE_FIELD]: String(code) } : {}),
  };

  let apiRes, rawText;
  try {
    apiRes = await fetch(
      `https://api.apify.com/v2/acts/${IG_LOGIN_ACTOR_ID}/run-sync-get-dataset-items?token=${APIFY_TOKEN}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
        signal: AbortSignal.timeout(180000),
      }
    );
    rawText = await apiRes.text();
  } catch (err) {
    return res.status(504).json({ error: `Could not reach Apify: ${err.message}` });
  }

  let parsed;
  try { parsed = JSON.parse(rawText); } catch (_) { parsed = rawText; }

  if (!apiRes.ok) {
    const msg = (parsed && parsed.error && (parsed.error.message || parsed.error)) || String(rawText).slice(0, 400);
    return res.status(502).json({
      error: `Apify actor error (${apiRes.status}): ${msg}. If it's an input-schema error, set IG_LOGIN_USER_FIELD / IG_LOGIN_PASS_FIELD / IG_LOGIN_CODE_FIELD to match the actor.`,
    });
  }

  const found = extractCookiesDeep(parsed);
  const filtered = filterRequiredCookies(found || []);
  const check = validateCookies(filtered);
  if (!check.ok) {
    return res.status(422).json({
      error: `Logged in via Apify but couldn't find the required cookies in the actor output. ${check.error}`,
      hint: 'The actor may return a different shape or need 2FA. Check the raw sample, or switch IG_LOGIN_ACTOR_ID to another login actor.',
      rawSample: (typeof parsed === 'string' ? parsed : JSON.stringify(parsed)).slice(0, 600),
    });
  }

  writeDB('instagram_cookies.json', filtered);
  res.json({ ok: true, count: filtered.length, actor: IG_LOGIN_ACTOR_ID, message: 'Instagram connected via Apify login.' });
});

// ═══════════════════════════════════════════════════════════
//  AI Negotiation System Prompt Builder
// ═══════════════════════════════════════════════════════════

function buildNegotiationPrompt(campaign, negotiation) {
  return `You are an expert social media manager and influencer marketing specialist negotiating a paid collaboration on behalf of a brand. You are chatting via Instagram DMs.

BRAND INFO:
- Brand: ${campaign.brandName}
- Product: ${campaign.productName || 'Not specified'}
- Collaboration Type: ${campaign.collabType || 'Paid Reel'}
- Campaign Brief: ${campaign.brief || 'Paid Instagram Reel collaboration'}
- Currency: ${campaign.currency || 'INR'}

BUDGET:
- Your budget range for this creator: ${campaign.currency} ${campaign.budgetMin} to ${campaign.currency} ${campaign.budgetMax}
- Always start by offering near the LOWER end of the budget
- You can negotiate up to the MAX budget but treat it as a hard ceiling
- If they ask for more than the max budget, politely decline or try to negotiate down

CREATOR INFO:
- Username: @${negotiation.username}
- Name: ${negotiation.fullName || negotiation.username}
- Followers: ${negotiation.followers || 'Unknown'}
- Category: ${negotiation.category || 'Unknown'}

NEGOTIATION RULES:
1. Keep messages SHORT — 2-3 sentences max. This is DM not email
2. Be friendly and casual like a real person. 1 emoji per message max
3. NEVER reveal your maximum budget. Start near the lower end
4. If they counter above your max, say "that's a bit beyond our budget" and offer your max as a final stretch
5. When a deal is agreed, confirm deliverables and price in ONE concise message — don't repeat yourself
6. If they decline, be graceful and leave the door open
7. NEVER mention you are an AI. You handle partnerships for ${campaign.brandName}
8. ONE MESSAGE PER CREATOR REPLY — never send a follow-up DM until the creator writes back. Multiple rapid-fire DMs look like spam and get flagged by Instagram.
9. NEVER repeat a price, offer, or phrasing you have already used. If the creator has gone quiet, do NOT re-pitch the same number — either ask a new question, offer something different, or stay silent.
10. If the last 2 messages in the history are already from you ("assistant"), STOP. Output exactly the word: WAIT
11. If you already confirmed the deal once, do NOT confirm again. Move to next steps (brief, timeline)
12. Vary your wording. Never start two messages with the same opener (e.g. don't say "Great to hear from you!" twice)
13. CRITICAL: Cover everything in as few messages as possible. One clear, confident message is better than three

RESPOND WITH ONLY THE DM MESSAGE. No explanations, no metadata, just the message to send. If rule 10 applies, output exactly: WAIT`;
}

// ═══════════════════════════════════════════════════════════
//  Instagram Inbox Polling & Auto-Reply
// ═══════════════════════════════════════════════════════════

const IG_APP_ID = '936619743392459';

function buildCookieString(cookies) {
  if (!Array.isArray(cookies)) return '';
  return cookies.map(c => `${c.name}=${c.value}`).join('; ');
}

function getCsrfToken(cookies) {
  const c = cookies.find(c => c.name === 'csrftoken');
  return c ? c.value : '';
}

async function fetchInstagramInbox(cookies) {
  const cookieStr = buildCookieString(cookies);
  const csrf = getCsrfToken(cookies);

  const res = await fetch('https://www.instagram.com/api/v1/direct_v2/inbox/?persistentBadging=true&folder=&limit=20&thread_message_limit=10', {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'X-CSRFToken': csrf,
      'X-IG-App-ID': IG_APP_ID,
      'X-Requested-With': 'XMLHttpRequest',
      'Cookie': cookieStr,
      'Referer': 'https://www.instagram.com/direct/inbox/',
      'Accept': '*/*',
    },
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Instagram inbox fetch failed (${res.status}): ${errText.slice(0, 200)}`);
  }

  return res.json();
}

async function fetchInstagramThread(cookies, threadId) {
  const cookieStr = buildCookieString(cookies);
  const csrf = getCsrfToken(cookies);

  const res = await fetch(`https://www.instagram.com/api/v1/direct_v2/threads/${threadId}/?limit=20`, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'X-CSRFToken': csrf,
      'X-IG-App-ID': IG_APP_ID,
      'X-Requested-With': 'XMLHttpRequest',
      'Cookie': cookieStr,
      'Referer': 'https://www.instagram.com/direct/inbox/',
      'Accept': '*/*',
    },
  });

  if (!res.ok) throw new Error(`Thread fetch failed (${res.status})`);
  return res.json();
}

// Poll inbox, find new replies, auto-generate & send AI responses
app.post('/api/autopilot/poll', async (req, res) => {
  try {
    const cookies = loadCookies();
    const check = validateCookies(cookies);
    if (!check.ok) return res.status(400).json({ error: check.error });

    const negotiations = readDB('negotiations.json');
    const activeNegs = negotiations.filter(n =>
      n.status !== 'closed' && n.status !== 'rejected'
    );

    if (!activeNegs.length) {
      return res.json({ message: 'No active negotiations.', actions: [] });
    }

    const activeUsernames = new Set(activeNegs.map(n => n.username.toLowerCase()));

    const inboxData = await fetchInstagramInbox(cookies);
    const threads = inboxData.inbox?.threads || [];

    // Find our own user ID from cookies
    const dsUserCookie = cookies.find(c => c.name === 'ds_user_id');
    const myUserId = dsUserCookie ? dsUserCookie.value : null;

    const actions = [];

    for (const thread of threads) {
      const otherUsers = (thread.users || []);
      const otherUser = otherUsers[0];
      if (!otherUser) continue;

      const threadUsername = (otherUser.username || '').toLowerCase();
      if (!activeUsernames.has(threadUsername)) continue;

      const neg = activeNegs.find(n => n.username.toLowerCase() === threadUsername);
      if (!neg) continue;

      // Get latest messages in this thread
      const items = thread.items || [];
      if (!items.length) continue;

      // Items are newest-first. Find messages from the creator that we haven't seen
      const lastKnownCreatorMsg = neg.messages
        .filter(m => m.role === 'creator')
        .pop();
      const lastKnownTime = lastKnownCreatorMsg
        ? new Date(lastKnownCreatorMsg.timestamp).getTime()
        : 0;

      // Collect new creator messages (they come newest-first, reverse for chronological)
      const newCreatorMessages = [];
      for (const item of items) {
        if (!item.item_type || item.item_type !== 'text') continue;

        const senderId = String(item.user_id);
        const isFromCreator = myUserId ? senderId !== myUserId : senderId !== String(thread.viewer_id);

        if (!isFromCreator) continue;

        const msgTime = item.timestamp ? Number(item.timestamp) / 1000 : Date.now();
        if (msgTime <= lastKnownTime) continue;

        newCreatorMessages.push({
          text: item.text || '',
          timestamp: new Date(msgTime).toISOString(),
        });
      }

      if (!newCreatorMessages.length) continue;

      // Add new messages to negotiation (oldest first)
      newCreatorMessages.reverse();
      const combinedReply = newCreatorMessages.map(m => m.text).join('\n');

      neg.messages.push({
        role: 'creator',
        content: combinedReply,
        timestamp: newCreatorMessages[newCreatorMessages.length - 1].timestamp,
        autoDetected: true,
      });

      if (neg.status === 'contacted') neg.status = 'replied';
      if (neg.status !== 'closed' && neg.status !== 'rejected') neg.status = 'negotiating';
      neg.updatedAt = new Date().toISOString();

      actions.push({
        type: 'new_reply',
        username: neg.username,
        negId: neg.id,
        message: combinedReply,
      });
    }

    writeDB('negotiations.json', negotiations);
    res.json({ actions });
  } catch (err) {
    console.error('Autopilot poll error:', err);
    return res.status(500).json({ error: err.message });
  }
});

// Full autopilot: poll → detect replies → generate AI response → send DM
app.post('/api/autopilot/run', async (req, res) => {
  try {
    const cookies = loadCookies();
    const check = validateCookies(cookies);
    if (!check.ok) return res.status(400).json({ error: check.error });

    // Step 1: Poll for new replies
    const negotiations = readDB('negotiations.json');
    const activeNegs = negotiations.filter(n =>
      n.status !== 'closed' && n.status !== 'rejected'
    );

    if (!activeNegs.length) {
      return res.json({ message: 'No active negotiations.', results: [] });
    }

    const activeUsernames = new Set(activeNegs.map(n => n.username.toLowerCase()));
    let inboxData;
    try {
      inboxData = await fetchInstagramInbox(cookies);
    } catch (err) {
      return res.status(500).json({ error: `Failed to read inbox: ${err.message}` });
    }

    const threads = inboxData.inbox?.threads || [];
    const dsUserCookie = cookies.find(c => c.name === 'ds_user_id');
    const myUserId = dsUserCookie ? dsUserCookie.value : null;

    const results = [];

    for (const thread of threads) {
      const otherUser = (thread.users || [])[0];
      if (!otherUser) continue;

      const threadUsername = (otherUser.username || '').toLowerCase();
      if (!activeUsernames.has(threadUsername)) continue;

      const neg = activeNegs.find(n => n.username.toLowerCase() === threadUsername);
      if (!neg) continue;

      const items = thread.items || [];
      if (!items.length) continue;

      // Cooldown: if we just sent a DM less than 90 seconds ago, skip this
      // creator. Instagram's inbox can lag, and without this we could race
      // with our own last send and generate yet another follow-up.
      const lastYou = [...neg.messages].reverse().find(m => m.role === 'you');
      if (lastYou && Date.now() - new Date(lastYou.timestamp).getTime() < 90 * 1000) {
        results.push({ username: neg.username, status: 'skipped', reason: 'Cooldown — sent a DM <90s ago.' });
        continue;
      }

      const lastKnownCreatorMsg = neg.messages.filter(m => m.role === 'creator').pop();
      const lastKnownTime = lastKnownCreatorMsg
        ? new Date(lastKnownCreatorMsg.timestamp).getTime()
        : 0;

      const newCreatorMessages = [];
      for (const item of items) {
        if (!item.item_type || item.item_type !== 'text') continue;
        const senderId = String(item.user_id);
        const isFromCreator = myUserId ? senderId !== myUserId : senderId !== String(thread.viewer_id);
        if (!isFromCreator) continue;
        const msgTime = item.timestamp ? Number(item.timestamp) / 1000 : Date.now();
        if (msgTime <= lastKnownTime) continue;
        newCreatorMessages.push({ text: item.text || '', timestamp: new Date(msgTime).toISOString() });
      }

      if (!newCreatorMessages.length) continue;

      newCreatorMessages.reverse();
      const combinedReply = newCreatorMessages.map(m => m.text).join('\n');

      // Add creator reply
      neg.messages.push({
        role: 'creator',
        content: combinedReply,
        timestamp: newCreatorMessages[newCreatorMessages.length - 1].timestamp,
        autoDetected: true,
      });
      if (neg.status === 'contacted') neg.status = 'replied';
      if (neg.status !== 'closed' && neg.status !== 'rejected') neg.status = 'negotiating';
      neg.updatedAt = new Date().toISOString();
      writeDB('negotiations.json', negotiations);

      const msgsBeforeThisReply = neg.messages.slice(0, -1);
      const consecutiveYou = countConsecutiveYou(msgsBeforeThisReply);
      if (consecutiveYou >= MAX_CONSECUTIVE_YOU) {
        results.push({
          username: neg.username,
          status: 'skipped',
          reason: `Already sent ${consecutiveYou} messages in a row — waiting for the creator to re-engage.`,
        });
        continue;
      }

      if (!acquireSendLock(neg.id)) {
        results.push({ username: neg.username, status: 'skipped', reason: 'A send is already in flight for this creator.' });
        continue;
      }

      // Step 2: Generate AI response
      const campaigns = readDB('campaigns.json');
      const campaign = campaigns.find(c => c.id === neg.campaignId);
      if (!campaign) continue;

      const conversationHistory = neg.messages.map(m => ({
        role: m.role === 'creator' ? 'user' : 'assistant',
        content: m.content,
      }));

      let aiMessage = '';
      try {
        const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': CLAUDE_API_KEY,
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify({
            model: CLAUDE_MODEL,
            max_tokens: 500,
            thinking: { type: 'disabled' },
            system: buildNegotiationPrompt(campaign, neg),
            messages: conversationHistory,
          }),
        });

        if (!claudeRes.ok) {
          const errBody = await claudeRes.text();
          results.push({ username: neg.username, status: 'ai_failed', error: errBody });
          continue;
        }

        const claudeData = await claudeRes.json();
        aiMessage = (claudeData.content?.[0]?.text || '').trim();
      } catch (err) {
        releaseSendLock(neg.id);
        results.push({ username: neg.username, status: 'ai_failed', error: err.message });
        continue;
      }

      if (!aiMessage) {
        releaseSendLock(neg.id);
        continue;
      }

      if (/^wait\b/i.test(aiMessage) || aiMessage.toUpperCase() === 'WAIT') {
        releaseSendLock(neg.id);
        results.push({
          username: neg.username,
          status: 'skipped',
          reason: 'AI chose to wait — sending another message now would look spammy.',
        });
        continue;
      }

      // Anti-spam: don't send a DM that's near-identical to one we
      // already sent in this thread.
      const dup = findDuplicateYouMessage(neg.messages, aiMessage);
      if (dup.score >= DUPLICATE_SIMILARITY_THRESHOLD) {
        releaseSendLock(neg.id);
        results.push({
          username: neg.username,
          status: 'skipped',
          reason: `AI draft is ${(dup.score * 100).toFixed(0)}% similar to a message already sent. Skipping to avoid spammy duplicates.`,
          aiMessage,
        });
        continue;
      }

      try {
        const sendResult = await sendDMviaApify(cookies, neg.username, aiMessage);
        if (!sendResult.ok) {
          results.push({
            username: neg.username,
            status: 'send_failed',
            error: sendResult.error,
            details: sendResult.details,
            aiMessage,
          });
          continue;
        }

        neg.messages.push({
          role: 'you',
          content: aiMessage,
          timestamp: new Date().toISOString(),
          sentViaApify: true,
          autoGenerated: true,
        });
        neg.updatedAt = new Date().toISOString();
        writeDB('negotiations.json', negotiations);

        results.push({
          username: neg.username,
          status: 'replied',
          creatorSaid: combinedReply,
          aiReplied: aiMessage,
        });
      } catch (err) {
        results.push({ username: neg.username, status: 'send_failed', error: err.message, aiMessage });
      } finally {
        releaseSendLock(neg.id);
      }

      await new Promise(r => setTimeout(r, 3000));
    }

    res.json({ results });
  } catch (err) {
    console.error('Autopilot run error:', err);
    return res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════
//  Page Routes
// ═══════════════════════════════════════════════════════════

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/negotiate', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'negotiate.html'));
});

// Catch-all: API routes return JSON 404, other routes serve index.html
app.use((req, res) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ error: 'Endpoint not found.' });
  }
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`\n  InfluencerFind running at http://localhost:${PORT}\n`);
});
