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

const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ═══════════════════════════════════════════════════════════
//  Simple JSON file database
// ═══════════════════════════════════════════════════════════

function readDB(file) {
  const p = path.join(DATA_DIR, file);
  if (!fs.existsSync(p)) fs.writeFileSync(p, '[]');
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function writeDB(file, data) {
  fs.writeFileSync(path.join(DATA_DIR, file), JSON.stringify(data, null, 2));
}

function genId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// ═══════════════════════════════════════════════════════════
//  Existing Scraper Routes
// ═══════════════════════════════════════════════════════════

app.post('/api/scrape', async (req, res) => {
  try {
    const { seedAccounts, minFollowers, maxFollowers, maxProfiles } = req.body;

    if (!seedAccounts || seedAccounts.length === 0) {
      return res.status(400).json({ error: 'At least one seed account is required.' });
    }

    const actorInput = {
      operationMode: 'networkExpansion',
      startUsernames: seedAccounts.map(s => s.trim()).filter(Boolean),
      maxProfilesToAnalyze: Number(maxProfiles) || 100,
      searchDepth: '1',
      extractEmail: true,
      analyzeQuality: true,
    };

    if (minFollowers) actorInput.minFollowers = Number(minFollowers);
    if (maxFollowers) actorInput.maxFollowers = Number(maxFollowers);

    const actorId = 'afanasenko~instagram-profile-scraper';
    const startUrl = `https://api.apify.com/v2/acts/${actorId}/runs?token=${APIFY_TOKEN}`;

    const startRes = await fetch(startUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(actorInput),
    });

    if (!startRes.ok) {
      const errBody = await startRes.text();
      return res.status(startRes.status).json({ error: `Apify error: ${errBody}` });
    }

    const runData = await startRes.json();
    return res.json({
      runId: runData.data?.id,
      datasetId: runData.data?.defaultDatasetId,
      status: runData.data?.status,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.get('/api/status/:runId', async (req, res) => {
  try {
    const { runId } = req.params;
    const statusRes = await fetch(
      `https://api.apify.com/v2/actor-runs/${runId}?token=${APIFY_TOKEN}`
    );
    if (!statusRes.ok) return res.status(statusRes.status).json({ error: 'Failed to fetch run status.' });
    const data = await statusRes.json();
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
    const { datasetId } = req.params;
    const resultsRes = await fetch(
      `https://api.apify.com/v2/datasets/${datasetId}/items?token=${APIFY_TOKEN}&format=json&clean=true`
    );
    if (!resultsRes.ok) return res.status(resultsRes.status).json({ error: 'Failed to fetch results.' });
    return res.json(await resultsRes.json());
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

  if (!brandName || !budgetMin || !budgetMax) {
    return res.status(400).json({ error: 'Brand name, min budget, and max budget are required.' });
  }

  const campaign = {
    id: genId(),
    brandName,
    productName: productName || '',
    collabType: collabType || 'Paid Reel',
    brief: brief || '',
    budgetMin: Number(budgetMin),
    budgetMax: Number(budgetMax),
    currency: currency || 'INR',
    totalBudget: Number(totalBudget) || 0,
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

    // Guard: max 3 consecutive sent messages without a creator reply
    let consecutiveYou = 0;
    for (let i = neg.messages.length - 1; i >= 0; i--) {
      if (neg.messages[i].role === 'you') consecutiveYou++;
      else break;
    }
    if (consecutiveYou >= 3) {
      return res.status(400).json({ error: 'Already sent 3 messages in a row. Wait for the creator to reply before sending more.' });
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
        model: 'claude-sonnet-4-20250514',
        max_tokens: 500,
        system: systemPrompt,
        messages: conversationHistory,
      }),
    });

    if (!claudeRes.ok) {
      const errBody = await claudeRes.text();
      return res.status(500).json({ error: `Claude API error: ${errBody}` });
    }

    const claudeData = await claudeRes.json();
    const aiMessage = claudeData.content?.[0]?.text || '';

    res.json({ message: aiMessage });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// Send AI response via Apify DM actor
app.post('/api/negotiations/:id/send', async (req, res) => {
  try {
    const { message } = req.body;
    if (!message) return res.status(400).json({ error: 'Message is required.' });

    const negotiations = readDB('negotiations.json');
    const neg = negotiations.find(n => n.id === req.params.id);
    if (!neg) return res.status(404).json({ error: 'Negotiation not found.' });

    const cookies = readDB('instagram_cookies.json');
    if (!cookies || !cookies.length) {
      return res.status(400).json({ error: 'Instagram cookies not configured. Go to Settings to add them.' });
    }

    const actorId = 'am_production~instagram-direct-messages-dms-automation';
    const actorInput = {
      INSTAGRAM_COOKIES: cookies,
      influencers: [neg.username],
      messages: [message],
    };

    const startRes = await fetch(
      `https://api.apify.com/v2/acts/${actorId}/run-sync-get-dataset-items?token=${APIFY_TOKEN}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(actorInput),
        signal: AbortSignal.timeout(120000),
      }
    );

    if (!startRes.ok) {
      const errBody = await startRes.text();
      return res.status(500).json({ error: `Apify DM error: ${errBody}` });
    }

    const result = await startRes.json();

    neg.messages.push({
      role: 'you',
      content: message,
      timestamp: new Date().toISOString(),
      sentViaApify: true,
    });
    neg.updatedAt = new Date().toISOString();
    writeDB('negotiations.json', negotiations);

    res.json({ ok: true, result, negotiation: neg });
  } catch (err) {
    return res.status(500).json({ error: err.message });
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

app.get('/api/settings/cookies', (req, res) => {
  const cookies = readDB('instagram_cookies.json');
  res.json({ hasCookies: cookies.length > 0, count: cookies.length });
});

app.post('/api/settings/cookies', (req, res) => {
  const { cookies } = req.body;
  if (!cookies || !Array.isArray(cookies)) {
    return res.status(400).json({ error: 'Cookies must be a JSON array.' });
  }
  writeDB('instagram_cookies.json', cookies);
  res.json({ ok: true, count: cookies.length });
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
8. Do NOT send multiple messages saying the same thing. Be concise and avoid redundancy
9. If you already confirmed the deal once, do NOT confirm again. Move to next steps (brief, timeline)
10. CRITICAL: Try to cover everything in as few messages as possible. Avoid being repetitive or desperate — one clear, confident message is better than three

RESPOND WITH ONLY THE DM MESSAGE. No explanations, no metadata, just the message to send.`;
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
    const cookies = readDB('instagram_cookies.json');
    if (!cookies || !cookies.length) {
      return res.status(400).json({ error: 'Instagram cookies not configured.' });
    }

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
    const cookies = readDB('instagram_cookies.json');
    if (!cookies || !cookies.length) {
      return res.status(400).json({ error: 'Instagram cookies not configured.' });
    }

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

      // Guard: max 3 consecutive "you" messages before this creator reply
      // Count how many "you" messages were sent before this new creator reply
      // (The creator just replied, so we're good to send ONE response — but
      //  check if we somehow already have 3+ unanswered messages before this)
      const msgsBeforeThisReply = neg.messages.slice(0, -1);
      let consecutiveYou = 0;
      for (let i = msgsBeforeThisReply.length - 1; i >= 0; i--) {
        if (msgsBeforeThisReply[i].role === 'you') consecutiveYou++;
        else break;
      }
      if (consecutiveYou >= 3) {
        results.push({ username: neg.username, status: 'skipped', reason: 'Already sent 3 messages, waiting for more input' });
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
            model: 'claude-sonnet-4-20250514',
            max_tokens: 500,
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
        aiMessage = claudeData.content?.[0]?.text || '';
      } catch (err) {
        results.push({ username: neg.username, status: 'ai_failed', error: err.message });
        continue;
      }

      if (!aiMessage) continue;

      // Step 3: Send DM via Apify
      try {
        const actorId = 'am_production~instagram-direct-messages-dms-automation';
        const sendRes = await fetch(
          `https://api.apify.com/v2/acts/${actorId}/run-sync-get-dataset-items?token=${APIFY_TOKEN}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              INSTAGRAM_COOKIES: cookies,
              influencers: [neg.username],
              messages: [aiMessage],
            }),
            signal: AbortSignal.timeout(120000),
          }
        );

        if (!sendRes.ok) {
          results.push({ username: neg.username, status: 'send_failed', aiMessage });
          continue;
        }

        // Record the sent message
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
      }

      // Rate limit: 3 second pause between DMs
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

app.listen(PORT, () => {
  console.log(`\n  InfluencerFind running at http://localhost:${PORT}\n`);
});
