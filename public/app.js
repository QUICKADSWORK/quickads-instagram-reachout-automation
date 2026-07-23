(function () {
  'use strict';

  const $ = (s) => document.querySelector(s);
  const $$ = (s) => document.querySelectorAll(s);

  const form = $('#searchForm');
  const searchBtn = $('#searchBtn');
  const statusBar = $('#statusBar');
  const statusTitle = $('#statusTitle');
  const statusSub = $('#statusSub');
  const progressFill = $('#progressFill');
  const resultsCard = $('#resultsCard');
  const resultCount = $('#resultCount');
  const resultsBody = $('#resultsBody');
  const btnCSV = $('#btnCSV');
  const btnExcel = $('#btnExcel');
  const errorCard = $('#errorCard');
  const errorMessage = $('#errorMessage');
  const dismissError = $('#dismissError');
  const dmPanel = $('#dmPanel');
  const dmPanelToggle = $('#dmPanelToggle');
  const dmTemplate = $('#dmTemplate');
  const dmPreview = $('#dmPreview');
  const dmToast = $('#dmToast');
  const dmToastMessage = $('#dmToastMessage');
  const btnDmAll = $('#btnDmAll');
  const dmCounter = $('#dmCounter');
  const btnScoreFit = $('#btnScoreFit');
  const btnSaveBrand = $('#btnSaveBrand');
  const brandSaveStatus = $('#brandSaveStatus');
  const brandPanelToggle = $('#brandPanelToggle');
  const brandBody = $('#brandBody');

  let currentResults = [];
  let fitScores = {}; // username(lower) -> { score, verdict, reasons[], redFlags[] }

  // ─── DM Tracking via localStorage ───────────────────────
  const DM_STORAGE_KEY = 'influencerfind_dmd_users';

  function getDMdUsers() {
    try { return JSON.parse(localStorage.getItem(DM_STORAGE_KEY) || '{}'); }
    catch { return {}; }
  }

  function markAsDMd(username) {
    const users = getDMdUsers();
    users[username.toLowerCase()] = Date.now();
    localStorage.setItem(DM_STORAGE_KEY, JSON.stringify(users));
  }

  function isDMd(username) {
    return !!getDMdUsers()[username.toLowerCase()];
  }

  function updateDMCounter() {
    if (!currentResults.length) return;
    let sent = 0;
    currentResults.forEach(item => {
      const username = extractUsername(item['Account'] || item['account'] || item['username'] || '');
      if (isDMd(username)) sent++;
    });
    dmCounter.innerHTML = `${sent} / ${currentResults.length} contacted`;
  }

  // ─── Helpers ────────────────────────────────────────────
  function showError(msg) {
    errorMessage.textContent = msg;
    errorCard.style.display = 'block';
    statusBar.style.display = 'none';
  }

  dismissError.addEventListener('click', () => { errorCard.style.display = 'none'; });

  function setStatus(title, sub) {
    statusTitle.textContent = title;
    statusSub.textContent = sub || '';
  }

  function formatNumber(n) {
    if (!n && n !== 0) return '—';
    if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
    if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
    return n.toString();
  }

  function extractUsername(account) {
    if (!account) return '';
    return account
      .replace('https://instagram.com/', '')
      .replace('https://www.instagram.com/', '')
      .replace('@', '')
      .replace(/\/$/, '');
  }

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  async function runScraperJob(runId, datasetId, { startProgress = 15, label = 'Scraper is running…' } = {}) {
    let progress = startProgress;
    progressFill.style.width = progress + '%';

    while (true) {
      await sleep(4000);
      const statusRes = await fetch(`/api/status/${runId}`);
      const statusData = await statusRes.json();

      if (statusData.status === 'SUCCEEDED') {
        progressFill.style.width = '90%';
        setStatus('Scraping complete!', 'Fetching results…');
        break;
      } else if (['FAILED', 'ABORTED', 'TIMED-OUT'].includes(statusData.status)) {
        throw new Error(`Scraper ${statusData.status.toLowerCase()}: ${statusData.statusMessage || 'Unknown error.'}`);
      } else {
        progress = Math.min(progress + 3, 85);
        progressFill.style.width = progress + '%';
        setStatus(label, statusData.statusMessage || 'Analyzing profiles…');
      }
    }

    const resultsRes = await fetch(`/api/results/${datasetId}`);
    const items = await resultsRes.json();
    return Array.isArray(items) ? items : [];
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    errorCard.style.display = 'none';

    const seedRaw = $('#seedAccounts').value.trim();
    if (!seedRaw) { showError('Please enter at least one seed account.'); return; }

    const seedAccounts = seedRaw.split(',').map(s => s.trim().replace('@', '')).filter(Boolean);
    if (seedAccounts.length === 0) { showError('Please enter valid seed accounts.'); return; }

    const niche = $('#nicheKeywords') ? $('#nicheKeywords').value.trim() : '';
    const location = $('#location') ? $('#location').value : '';
    const minFollowers = $('#minFollowers').value || undefined;
    const maxFollowers = $('#maxFollowers').value || undefined;
    const maxProfiles = parseInt($('#maxProfiles').value) || 100;

    const payload = { seedAccounts, niche, location, minFollowers, maxFollowers, maxProfiles };

    searchBtn.disabled = true;
    searchBtn.innerHTML = `<span class="spinner" style="width:18px;height:18px;border-width:2px;"></span> Searching…`;
    resultsCard.style.display = 'none';
    statusBar.style.display = 'block';
    progressFill.style.width = '5%';
    setStatus('Starting the scraper…', 'Connecting to Apify and launching the Instagram actor.');

    try {
      const startRes = await fetch('/api/scrape', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const startData = await startRes.json();
      if (!startRes.ok) throw new Error(startData.error || 'Failed to start scraping.');

      progressFill.style.width = '15%';
      setStatus('Scraper is running…', 'Network expansion: discovering similar profiles to your seeds. This may take 5–15 minutes.');

      let items = await runScraperJob(startData.runId, startData.datasetId, {
        startProgress: 15,
        label: 'Scraper is running… (network expansion)',
      });

      // ── Fallback 1: try keyword/hashtag discovery if first pass empty ──
      if (items.length === 0) {
        const niches = niche
          ? niche.split(/[,;\n]+/).map(s => s.trim()).filter(Boolean)
          : [];
        if (niches.length || seedAccounts.length) {
          setStatus('No matches via network expansion — retrying…', 'Falling back to keyword + hashtag discovery using your niche.');
          progressFill.style.width = '20%';

          const fbRes = await fetch('/api/scrape/fallback', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              niches,
              seedAccounts,
              location,
              minFollowers,
              maxFollowers,
              maxProfiles,
            }),
          });
          const fbData = await fbRes.json();
          if (!fbRes.ok) throw new Error(fbData.error || 'Fallback discovery failed.');

          items = await runScraperJob(fbData.runId, fbData.datasetId, {
            startProgress: 25,
            label: 'Scraper is running… (keyword discovery)',
          });
        }
      }

      // ── Fallback 2: if STILL empty, retry once with widened follower range ──
      if (items.length === 0 && (minFollowers || maxFollowers)) {
        setStatus('Still nothing — widening follower range…', 'Removing min/max follower filters for one more attempt.');
        progressFill.style.width = '30%';

        const widenedRes = await fetch('/api/scrape', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ seedAccounts, niche, location, maxProfiles }),
        });
        const widenedData = await widenedRes.json();
        if (widenedRes.ok) {
          items = await runScraperJob(widenedData.runId, widenedData.datasetId, {
            startProgress: 30,
            label: 'Scraper is running… (widened filters)',
          });
        }
      }

      if (!items.length) {
        throw new Error(
          'No profiles found after 3 attempts (network expansion → keyword discovery → widened range). ' +
          'Try: (1) 3-5 seed accounts instead of one, (2) a wider follower range like 1K–500K, ' +
          '(3) more specific niche keywords, or (4) clear the location filter.'
        );
      }

      progressFill.style.width = '100%';
      currentResults = items;
      renderResults(items);

      setTimeout(() => { statusBar.style.display = 'none'; }, 800);
    } catch (err) {
      showError(err.message);
    } finally {
      searchBtn.disabled = false;
      searchBtn.innerHTML = `
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
        Find Influencers`;
    }
  });

  // ─── Render Results Table ───────────────────────────────
  function renderResults(items) {
    resultsBody.innerHTML = '';
    resultCount.textContent = items.length;
    resultsCard.style.display = 'block';
    dmPanel.style.display = 'block';

    items.forEach((item, i) => {
      const username = extractUsername(item['Account'] || item['account'] || item['username'] || '');
      const fullName = item['Full Name'] || item['fullName'] || item['full_name'] || '';
      const a = item.analytics || {};
      const followers = a.followers ?? (item['Followers Count'] || item['followersCount'] || item['followers_count'] || 0);
      const erRaw = a.engagementRate ?? item['Median ER'] ?? item['engagement_rate'] ?? item['engagementRate'] ?? '';
      const er = (typeof erRaw === 'number') ? erRaw.toFixed(2) + '%' : (erRaw || '');
      const avgViews = a.avgViews;
      const postsWk = a.postsPerWeek;
      const quality = item['Quality'] || item['quality'] || '';
      const email = item['Email'] || item['email'] || '';
      const category = item['Category'] || item['category'] || '';
      const bio = item['Biography'] || item['biography'] || item['bio'] || '';

      const qualityClass = (quality || '').toLowerCase() === 'good' ? 'badge-good'
        : (quality || '').toLowerCase() === 'poor' ? 'badge-poor'
        : 'badge-unknown';

      const initials = (fullName || username).slice(0, 2).toUpperCase();
      const profileUrl = username ? `https://instagram.com/${username}` : '#';
      const alreadyDMd = isDMd(username);
      const dmBtnClass = alreadyDMd ? 'btn-dm dm-sent' : 'btn-dm';
      const dmBtnLabel = alreadyDMd ? '&#10003; DM Sent' : '&#128172; Send DM';

      const tr = document.createElement('tr');
      tr.dataset.username = (username || '').toLowerCase();
      tr.innerHTML = `
        <td>${i + 1}</td>
        <td>
          <div class="profile-cell">
            <div class="avatar">${esc(initials)}</div>
            <a href="${esc(profileUrl)}" target="_blank" rel="noopener">@${esc(username) || '—'}</a>
          </div>
        </td>
        <td class="fit-cell">${renderFitCell(username)}</td>
        <td>${esc(fullName) || '—'}</td>
        <td>${formatNumber(followers)}</td>
        <td>${avgViews != null ? formatNumber(avgViews) : '—'}</td>
        <td>${esc(er) || '—'}</td>
        <td>${postsWk != null ? postsWk : '—'}</td>
        <td><span class="badge ${qualityClass}">${esc(quality) || 'N/A'}</span></td>
        <td>${esc(email) || '—'}</td>
        <td>${esc(category) || '—'}</td>
        <td><div class="bio-cell" title="${esc(bio)}">${esc(bio) || '—'}</div></td>
        <td>
          <button class="${dmBtnClass}"
            data-username="${esc(username)}"
            data-fullname="${esc(fullName)}"
            data-followers="${esc(formatNumber(followers))}"
            data-category="${esc(category)}"
            onclick="window.__sendDM(this)">
            ${dmBtnLabel}
          </button>
        </td>
      `;
      resultsBody.appendChild(tr);
    });

    updateDMCounter();
    updateDMPreview();
    resultsCard.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  // ─── DM Functions ──────────────────────────────────────
  function personalizeMessage(template, data) {
    return template
      .replace(/\{name\}/gi, data.name || 'there')
      .replace(/\{username\}/gi, data.username || '')
      .replace(/\{followers\}/gi, data.followers || '')
      .replace(/\{category\}/gi, data.category || '');
  }

  function showToast(msg, duration = 3000) {
    dmToastMessage.textContent = msg;
    dmToast.classList.add('show');
    setTimeout(() => dmToast.classList.remove('show'), duration);
  }

  function updateDMPreview() {
    const template = dmTemplate.value;
    const previewText = template
      .replace(/\{name\}/gi, 'Alex')
      .replace(/\{username\}/gi, '@alexcreator')
      .replace(/\{followers\}/gi, '50K')
      .replace(/\{category\}/gi, 'Fitness');
    dmPreview.textContent = previewText;
  }

  async function sendDMForUser(btn) {
    const username = btn.dataset.username;
    const fullName = btn.dataset.fullname;
    const followers = btn.dataset.followers;
    const category = btn.dataset.category;
    if (!username) return;

    const msg = personalizeMessage(dmTemplate.value, {
      name: fullName || username,
      username,
      followers,
      category,
    });

    try {
      await navigator.clipboard.writeText(msg);
      showToast('Message copied! Open the DM tab and paste to send.');
    } catch {
      const ta = document.createElement('textarea');
      ta.value = msg;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      showToast('Message copied! Open the DM tab and paste to send.');
    }

    window.open(`https://ig.me/m/${username}`, '_blank');

    markAsDMd(username);
    btn.classList.add('dm-sent');
    btn.innerHTML = '&#10003; DM Sent';
    updateDMCounter();
  }

  window.__sendDM = sendDMForUser;

  // ─── DM Panel Toggle ───────────────────────────────────
  dmPanelToggle.addEventListener('click', () => {
    dmPanel.classList.toggle('open');
  });

  dmTemplate.addEventListener('input', updateDMPreview);

  $$('.dm-tag').forEach(tag => {
    tag.addEventListener('click', () => {
      const placeholder = tag.dataset.placeholder;
      const ta = dmTemplate;
      const start = ta.selectionStart;
      const end = ta.selectionEnd;
      const text = ta.value;
      ta.value = text.substring(0, start) + placeholder + text.substring(end);
      ta.focus();
      ta.setSelectionRange(start + placeholder.length, start + placeholder.length);
      updateDMPreview();
    });
  });

  // ─── Brand Profile + AI Brand-Fit Scoring ──────────────
  const BRAND_FIELDS = {
    brandName: '#bfBrandName', productType: '#bfProductType', description: '#bfDescription',
    targetAudience: '#bfAudience', idealCreator: '#bfIdealCreator', values: '#bfValues',
  };

  function readBrandForm() {
    const out = {};
    for (const [k, sel] of Object.entries(BRAND_FIELDS)) out[k] = ($(sel)?.value || '').trim();
    return out;
  }

  async function loadBrandProfile() {
    try {
      const res = await fetch('/api/brand-profile');
      const p = await res.json();
      if (p && typeof p === 'object') {
        for (const [k, sel] of Object.entries(BRAND_FIELDS)) {
          if (p[k] && $(sel)) $(sel).value = p[k];
        }
      }
    } catch (_) {}
  }

  if (brandPanelToggle) {
    brandPanelToggle.addEventListener('click', () => brandBody.parentElement.classList.toggle('open'));
  }

  if (btnSaveBrand) {
    btnSaveBrand.addEventListener('click', async () => {
      const profile = readBrandForm();
      if (!profile.brandName && !profile.description) {
        brandSaveStatus.textContent = 'Add at least a brand name or description.';
        return;
      }
      btnSaveBrand.disabled = true;
      brandSaveStatus.textContent = 'Saving…';
      try {
        const res = await fetch('/api/brand-profile', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(profile),
        });
        const data = await res.json();
        brandSaveStatus.textContent = res.ok ? '✓ Saved' : (data.error || 'Save failed');
      } catch (err) {
        brandSaveStatus.textContent = 'Save failed: ' + err.message;
      } finally {
        btnSaveBrand.disabled = false;
      }
    });
  }

  function fitClass(score) {
    if (score >= 80) return 'badge-good';
    if (score >= 60) return 'badge-good';
    if (score >= 40) return 'badge-unknown';
    return 'badge-poor';
  }

  // Renders the Brand Fit cell for a username from the current fitScores map.
  function renderFitCell(username) {
    const s = fitScores[(username || '').toLowerCase()];
    if (!s) return '<span class="badge badge-unknown">—</span>';
    const tip = [s.verdict, ...(s.reasons || []), ...(s.redFlags || []).map(f => '⚠ ' + f)]
      .filter(Boolean).join(' • ');
    return `<span class="badge ${fitClass(s.score)}" title="${esc(tip)}">${s.score}</span>`;
  }

  function refreshFitCells() {
    $$('#resultsBody tr').forEach(tr => {
      const cell = tr.querySelector('.fit-cell');
      if (cell) cell.innerHTML = renderFitCell(tr.dataset.username);
    });
  }

  if (btnScoreFit) {
    btnScoreFit.addEventListener('click', async () => {
      if (!currentResults.length) { showToast('Find some influencers first.'); return; }
      const brand = readBrandForm();
      if (!brand.brandName && !brand.description) {
        showToast('Fill in your Brand Profile first (name or description).');
        brandBody.parentElement.classList.add('open');
        return;
      }

      const influencers = currentResults.slice(0, 25).map(item => {
        const a = item.analytics || {};
        return {
          username: extractUsername(item['Account'] || item['account'] || item['username'] || ''),
          fullName: item['Full Name'] || item['fullName'] || item['full_name'] || '',
          category: item['Category'] || item['category'] || '',
          bio: item['Biography'] || item['biography'] || item['bio'] || '',
          followers: a.followers ?? item['Followers Count'] ?? item['followersCount'] ?? null,
          engagementRate: a.engagementRate ?? null,
          avgViews: a.avgViews ?? null,
          avgLikes: a.avgLikes ?? null,
        };
      }).filter(i => i.username);

      const original = btnScoreFit.innerHTML;
      btnScoreFit.disabled = true;
      btnScoreFit.innerHTML = `<span class="spinner" style="width:14px;height:14px;border-width:2px;display:inline-block;vertical-align:middle;"></span> Scoring…`;
      try {
        const res = await fetch('/api/brand-fit/score', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ brand, influencers }),
        });
        const data = await res.json();
        if (!res.ok) { showError(data.error || 'Scoring failed.'); return; }
        fitScores = Object.assign(fitScores, data.scores || {});
        refreshFitCells();
        showToast(`Scored ${data.scored} influencers for brand fit.`);
      } catch (err) {
        showError('Scoring failed: ' + err.message);
      } finally {
        btnScoreFit.disabled = false;
        btnScoreFit.innerHTML = original;
      }
    });
  }

  loadBrandProfile();

  // ─── Batch DM All ──────────────────────────────────────
  btnDmAll.addEventListener('click', async () => {
    if (!currentResults.length) return;

    const uncontacted = [];
    currentResults.forEach(item => {
      const username = extractUsername(item['Account'] || item['account'] || item['username'] || '');
      if (username && !isDMd(username)) {
        const fullName = item['Full Name'] || item['fullName'] || item['full_name'] || '';
        const followers = item['Followers Count'] || item['followersCount'] || item['followers_count'] || 0;
        const category = item['Category'] || item['category'] || '';
        uncontacted.push({ username, fullName, followers: formatNumber(followers), category });
      }
    });

    if (uncontacted.length === 0) {
      showToast('All influencers have been contacted!');
      return;
    }

    if (!confirm(`This will open ${uncontacted.length} DM tabs (with 2s delay between each). Continue?`)) return;

    btnDmAll.disabled = true;
    btnDmAll.innerHTML = `<span class="spinner" style="width:14px;height:14px;border-width:2px;display:inline-block;vertical-align:middle;"></span> Opening DMs...`;

    for (let i = 0; i < uncontacted.length; i++) {
      const u = uncontacted[i];
      const msg = personalizeMessage(dmTemplate.value, {
        name: u.fullName || u.username,
        username: u.username,
        followers: u.followers,
        category: u.category,
      });

      try { await navigator.clipboard.writeText(msg); } catch {}
      window.open(`https://ig.me/m/${u.username}`, '_blank');
      markAsDMd(u.username);

      const btn = document.querySelector(`button[data-username="${u.username}"]`);
      if (btn) {
        btn.classList.add('dm-sent');
        btn.innerHTML = '&#10003; DM Sent';
      }

      showToast(`Opened DM ${i + 1}/${uncontacted.length}: @${u.username}`);

      if (i < uncontacted.length - 1) await sleep(2000);
    }

    btnDmAll.disabled = false;
    btnDmAll.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m22 2-7 20-4-9-9-4z"/><path d="M22 2 11 13"/></svg> DM All`;
    updateDMCounter();
    showToast(`Done! Opened ${uncontacted.length} DMs`, 4000);
  });

  // ─── CSV Export ─────────────────────────────────────────
  btnCSV.addEventListener('click', () => {
    if (!currentResults.length) return;
    const exportData = mapExportData(currentResults);
    const headers = Object.keys(exportData[0]);
    const rows = exportData.map(row =>
      headers.map(h => `"${String(row[h] || '').replace(/"/g, '""')}"`)
    );
    let csv = headers.map(h => `"${h}"`).join(',') + '\n';
    csv += rows.map(r => r.join(',')).join('\n');
    downloadBlob(csv, 'influencers.csv', 'text/csv');
  });

  // ─── Excel Export ───────────────────────────────────────
  btnExcel.addEventListener('click', async () => {
    if (!currentResults.length) return;
    const exportData = mapExportData(currentResults);

    try {
      const res = await fetch('/api/export/excel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ data: exportData }),
      });
      if (!res.ok) throw new Error('Excel export failed.');
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'influencers.xlsx';
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      showError(err.message);
    }
  });

  function mapExportData(items) {
    return items.map(item => {
      const a = item.analytics || {};
      const uname = extractUsername(item['Account'] || item['account'] || item['username'] || '');
      const fit = fitScores[(uname || '').toLowerCase()];
      return {
        Profile: item['Account'] || item['account'] || '',
        'Full Name': item['Full Name'] || item['fullName'] || '',
        Followers: a.followers ?? item['Followers Count'] ?? item['followersCount'] ?? '',
        Following: a.following ?? item['Following Count'] ?? item['followingCount'] ?? '',
        'Avg Views': a.avgViews ?? '',
        'Avg Likes': a.avgLikes ?? '',
        'Engagement Rate': a.engagementRate ?? item['Median ER'] ?? item['engagement_rate'] ?? '',
        'Follower Ratio': a.followerRatio ?? '',
        'Posts/Week': a.postsPerWeek ?? '',
        'Brand Fit Score': fit ? fit.score : '',
        'Brand Fit Verdict': fit ? fit.verdict : '',
        Quality: item['Quality'] || item['quality'] || '',
        Email: item['Email'] || item['email'] || '',
        Phone: item['Phone'] || item['phone'] || '',
        Website: item['External URL'] || item['externalUrl'] || '',
        Category: item['Category'] || item['category'] || '',
        Bio: item['Biography'] || item['biography'] || '',
        Language: item['Detected Language'] || item['detectedLanguage'] || '',
      };
    });
  }

  function downloadBlob(content, filename, type) {
    const blob = new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  function esc(s) {
    if (s == null) return '';
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // ═══════════════════════════════════════════════════════
  //  Mode Segments (Ready-to-Go / Discover / Barter)
  // ═══════════════════════════════════════════════════════
  const views = {
    ready: $('#viewReady'),
    discover: $('#viewDiscover'),
    barter: $('#viewBarter'),
  };

  function switchView(view) {
    Object.entries(views).forEach(([key, el]) => {
      if (el) el.style.display = key === view ? 'block' : 'none';
    });
    $$('.segment-btn').forEach(b => b.classList.toggle('active', b.dataset.view === view));
    if (view === 'ready') loadReadyInfluencers();
  }

  $$('.segment-btn').forEach(btn => {
    btn.addEventListener('click', () => switchView(btn.dataset.view));
  });

  // ═══════════════════════════════════════════════════════
  //  Ready-to-Go Influencers
  // ═══════════════════════════════════════════════════════
  let readyList = [];

  async function loadReadyInfluencers() {
    try {
      const res = await fetch('/api/ready-influencers');
      readyList = res.ok ? await res.json() : [];
    } catch { readyList = []; }
    renderReady();
  }

  function renderReady() {
    const tbody = $('#readyBody');
    $('#readyCount').textContent = readyList.length;

    if (!readyList.length) {
      $('#readyEmpty').style.display = 'block';
      $('#readyTableWrap').style.display = 'none';
      tbody.innerHTML = '';
      return;
    }
    $('#readyEmpty').style.display = 'none';
    $('#readyTableWrap').style.display = 'block';

    tbody.innerHTML = readyList.map((inf, i) => {
      const initials = (inf.fullName || inf.username).slice(0, 2).toUpperCase();
      const profileUrl = `https://instagram.com/${inf.username}`;
      const sent = isDMd(inf.username);
      return `
        <tr>
          <td>${i + 1}</td>
          <td>
            <div class="profile-cell">
              <div class="avatar">${esc(initials)}</div>
              <a href="${profileUrl}" target="_blank" rel="noopener">@${esc(inf.username)}</a>
            </div>
          </td>
          <td>${esc(inf.fullName) || '—'}</td>
          <td>${formatNumber(inf.followers)}</td>
          <td>${esc(inf.category) || '—'}</td>
          <td>${esc(inf.email) || '—'}</td>
          <td>
            <div style="display:flex;gap:6px;align-items:center;">
              <button class="${sent ? 'btn-dm dm-sent' : 'btn-dm'}" data-ready-dm="${esc(inf.username)}">${sent ? '&#10003; DM Sent' : '&#128172; Send DM'}</button>
              <button class="btn-delete-row" data-ready-del="${esc(inf.username)}" title="Remove">&times;</button>
            </div>
          </td>
        </tr>`;
    }).join('');

    tbody.querySelectorAll('[data-ready-dm]').forEach(b => {
      b.addEventListener('click', () => sendReadyDM(b.dataset.readyDm, b));
    });
    tbody.querySelectorAll('[data-ready-del]').forEach(b => {
      b.addEventListener('click', () => deleteReady(b.dataset.readyDel));
    });
  }

  async function addReady(payload) {
    const res = await fetch('/api/ready-influencers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!res.ok) { showToast(data.error || 'Failed to add'); return null; }
    readyList = data.influencers;
    renderReady();
    return data;
  }

  const btnAddReady = $('#btnAddReady');
  if (btnAddReady) {
    btnAddReady.addEventListener('click', async () => {
      const username = $('#rUsername').value.trim();
      if (!username) { showToast('Enter a username'); return; }
      const data = await addReady({
        username,
        fullName: $('#rFullName').value.trim(),
        followers: $('#rFollowers').value,
        category: $('#rCategory').value.trim(),
        email: $('#rEmail').value.trim(),
      });
      if (data) {
        ['rUsername', 'rFullName', 'rFollowers', 'rCategory', 'rEmail'].forEach(id => { $('#' + id).value = ''; });
        showToast('Added to ready list');
      }
    });
  }

  const btnBulkAddReady = $('#btnBulkAddReady');
  if (btnBulkAddReady) {
    btnBulkAddReady.addEventListener('click', async () => {
      const raw = $('#rBulk').value.trim();
      if (!raw) { showToast('Paste a list first'); return; }
      const influencers = raw.split('\n').map(line => {
        const parts = line.split(',').map(s => s.trim());
        if (!parts[0]) return null;
        return {
          username: parts[0].replace('@', ''),
          fullName: parts[1] || '',
          followers: parts[2] || 0,
          category: parts[3] || '',
          email: parts[4] || '',
        };
      }).filter(Boolean);
      if (!influencers.length) { showToast('No valid rows found'); return; }
      const data = await addReady({ influencers });
      if (data) {
        $('#rBulk').value = '';
        showToast(`Added ${data.added}, updated ${data.updated}`);
      }
    });
  }

  // ─── CSV Import for the Ready-to-Go list ───────────────
  // Full RFC-4180-ish parser: handles quoted fields, embedded commas,
  // escaped double-quotes ("") and newlines inside quotes.
  function parseCSV(text) {
    const rows = [];
    let row = [], field = '', inQuotes = false;
    text = text.replace(/^﻿/, ''); // strip BOM
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (inQuotes) {
        if (c === '"') {
          if (text[i + 1] === '"') { field += '"'; i++; }
          else inQuotes = false;
        } else field += c;
      } else if (c === '"') {
        inQuotes = true;
      } else if (c === ',') {
        row.push(field); field = '';
      } else if (c === '\n') {
        row.push(field); rows.push(row); row = []; field = '';
      } else if (c !== '\r') {
        field += c;
      }
    }
    if (field.length || row.length) { row.push(field); rows.push(row); }
    // Drop fully-empty rows.
    return rows.filter(r => r.some(cell => String(cell).trim() !== ''));
  }

  const CSV_HEADER_ALIASES = {
    username: ['username', 'user name', 'handle', 'account', 'profile', 'ig', 'instagram'],
    fullName: ['full name', 'fullname', 'name', 'display name'],
    followers: ['followers', 'followers count', 'follower', 'follower count'],
    category: ['category', 'niche', 'topic'],
    email: ['email', 'e-mail', 'mail'],
    avgViews: ['avg views', 'average views', 'views'],
    engagementRate: ['engagement rate', 'engagement', 'er', 'median er'],
    notes: ['notes', 'note'],
  };

  // Parse followers strings like "48K", "1,234", "1.2M".
  function parseFollowersLoose(v) {
    if (v === undefined || v === null || v === '') return 0;
    let s = String(v).trim().replace(/,/g, '');
    const mult = /k$/i.test(s) ? 1e3 : /m$/i.test(s) ? 1e6 : 1;
    s = s.replace(/[km]$/i, '');
    const n = parseFloat(s);
    return Number.isFinite(n) ? Math.round(n * mult) : 0;
  }

  // Map a header cell to a known field key, or null if unrecognized.
  function matchHeader(cell) {
    const norm = String(cell || '').trim().toLowerCase();
    for (const [key, aliases] of Object.entries(CSV_HEADER_ALIASES)) {
      if (aliases.includes(norm)) return key;
    }
    return null;
  }

  // Turn parsed CSV rows into influencer objects.
  function rowsToInfluencers(rows) {
    if (!rows.length) return [];
    const first = rows[0];
    const mapped = first.map(matchHeader);
    const hasHeader = mapped.filter(Boolean).length >= 1;

    const dataRows = hasHeader ? rows.slice(1) : rows;
    // Positional fallback matches the bulk-add / CSV-export column order.
    const positional = ['username', 'fullName', 'followers', 'category', 'email'];
    const colMap = hasHeader ? mapped : positional;

    return dataRows.map(cols => {
      const rec = {};
      cols.forEach((val, idx) => {
        const key = colMap[idx];
        if (key) rec[key] = String(val).trim();
      });
      const username = extractUsername(rec.username || '');
      if (!username) return null;
      return {
        username,
        fullName: rec.fullName || '',
        followers: parseFollowersLoose(rec.followers),
        category: rec.category || '',
        email: rec.email || '',
        notes: rec.notes || '',
        ...(rec.avgViews ? { avgViews: parseFollowersLoose(rec.avgViews) } : {}),
        ...(rec.engagementRate ? { engagementRate: parseFloat(String(rec.engagementRate).replace('%', '')) || null } : {}),
      };
    }).filter(Boolean);
  }

  const btnImportCsv = $('#btnImportCsv');
  const rCsvFile = $('#rCsvFile');
  if (btnImportCsv && rCsvFile) {
    btnImportCsv.addEventListener('click', () => rCsvFile.click());
    rCsvFile.addEventListener('change', async () => {
      const file = rCsvFile.files && rCsvFile.files[0];
      if (!file) return;
      try {
        const text = await file.text();
        const rows = parseCSV(text);
        const influencers = rowsToInfluencers(rows);
        if (!influencers.length) {
          showToast('No valid rows found in the CSV (need at least a username column).', 5000);
          return;
        }
        const data = await addReady({ influencers });
        if (data) {
          showToast(`Imported ${influencers.length} rows — added ${data.added}, updated ${data.updated}.`, 5000);
        }
      } catch (err) {
        showToast('Could not read CSV: ' + err.message, 6000);
      } finally {
        rCsvFile.value = ''; // allow re-importing the same file
      }
    });
  }

  async function deleteReady(username) {
    if (!confirm(`Remove @${username} from your ready list?`)) return;
    const res = await fetch(`/api/ready-influencers/${encodeURIComponent(username)}`, { method: 'DELETE' });
    if (res.ok) {
      readyList = readyList.filter(i => i.username.toLowerCase() !== username.toLowerCase());
      renderReady();
      showToast('Removed');
    }
  }

  function readyPersonalize(inf) {
    return personalizeMessage($('#readyDmTemplate').value, {
      name: inf.fullName || inf.username,
      username: inf.username,
      followers: formatNumber(inf.followers),
      category: inf.category,
    });
  }

  async function sendReadyDM(username, btn) {
    const inf = readyList.find(i => i.username.toLowerCase() === username.toLowerCase());
    if (!inf) return;
    const msg = readyPersonalize(inf);
    try {
      await navigator.clipboard.writeText(msg);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = msg;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    }
    window.open(`https://ig.me/m/${username}`, '_blank');
    markAsDMd(username);
    if (btn) { btn.classList.add('dm-sent'); btn.innerHTML = '&#10003; DM Sent'; }
    showToast('Message copied — paste & send in the DM tab');
  }

  $$('.ready-tag').forEach(tag => {
    tag.addEventListener('click', () => {
      const ta = $('#readyDmTemplate');
      const ph = tag.dataset.placeholder;
      const s = ta.selectionStart, e = ta.selectionEnd;
      ta.value = ta.value.slice(0, s) + ph + ta.value.slice(e);
      ta.focus();
      ta.setSelectionRange(s + ph.length, s + ph.length);
    });
  });

  const btnReadyDmAll = $('#btnReadyDmAll');
  if (btnReadyDmAll) {
    btnReadyDmAll.addEventListener('click', async () => {
      const uncontacted = readyList.filter(i => !isDMd(i.username));
      if (!uncontacted.length) { showToast('All saved influencers contacted!'); return; }
      if (!confirm(`This opens ${uncontacted.length} DM tabs (2s apart). Continue?`)) return;
      for (let i = 0; i < uncontacted.length; i++) {
        const inf = uncontacted[i];
        const msg = readyPersonalize(inf);
        try { await navigator.clipboard.writeText(msg); } catch {}
        window.open(`https://ig.me/m/${inf.username}`, '_blank');
        markAsDMd(inf.username);
        showToast(`Opened ${i + 1}/${uncontacted.length}: @${inf.username}`);
        if (i < uncontacted.length - 1) await sleep(2000);
      }
      renderReady();
    });
  }

  const btnReadyCSV = $('#btnReadyCSV');
  if (btnReadyCSV) {
    btnReadyCSV.addEventListener('click', () => {
      if (!readyList.length) return;
      const headers = ['Username', 'Full Name', 'Followers', 'Category', 'Email'];
      let csv = headers.map(h => `"${h}"`).join(',') + '\n';
      csv += readyList.map(i =>
        [i.username, i.fullName, i.followers, i.category, i.email]
          .map(v => `"${String(v || '').replace(/"/g, '""')}"`).join(',')
      ).join('\n');
      downloadBlob(csv, 'ready-influencers.csv', 'text/csv');
    });
  }
})();
