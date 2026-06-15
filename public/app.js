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

  let currentResults = [];

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
      const followers = item['Followers Count'] || item['followersCount'] || item['followers_count'] || 0;
      const er = item['Median ER'] || item['engagement_rate'] || item['engagementRate'] || '';
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
      tr.innerHTML = `
        <td>${i + 1}</td>
        <td>
          <div class="profile-cell">
            <div class="avatar">${initials}</div>
            <a href="${profileUrl}" target="_blank" rel="noopener">@${username || '—'}</a>
          </div>
        </td>
        <td>${fullName || '—'}</td>
        <td>${formatNumber(followers)}</td>
        <td>${er || '—'}</td>
        <td><span class="badge ${qualityClass}">${quality || 'N/A'}</span></td>
        <td>${email || '—'}</td>
        <td>${category || '—'}</td>
        <td><div class="bio-cell" title="${(bio || '').replace(/"/g, '&quot;')}">${bio || '—'}</div></td>
        <td>
          <button class="${dmBtnClass}"
            data-username="${username}"
            data-fullname="${fullName}"
            data-followers="${formatNumber(followers)}"
            data-category="${category}"
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
    return items.map(item => ({
      Profile: item['Account'] || item['account'] || '',
      'Full Name': item['Full Name'] || item['fullName'] || '',
      Followers: item['Followers Count'] || item['followersCount'] || '',
      Following: item['Following Count'] || item['followingCount'] || '',
      'Engagement Rate': item['Median ER'] || item['engagement_rate'] || '',
      Quality: item['Quality'] || item['quality'] || '',
      Email: item['Email'] || item['email'] || '',
      Phone: item['Phone'] || item['phone'] || '',
      Website: item['External URL'] || item['externalUrl'] || '',
      Category: item['Category'] || item['category'] || '',
      Bio: item['Biography'] || item['biography'] || '',
      Language: item['Detected Language'] || item['detectedLanguage'] || '',
    }));
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
    const d = document.createElement('span');
    d.textContent = String(s);
    return d.innerHTML;
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
