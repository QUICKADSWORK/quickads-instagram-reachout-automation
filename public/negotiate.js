(function () {
  'use strict';

  const $ = s => document.querySelector(s);
  const $$ = s => document.querySelectorAll(s);

  // ─── State ──────────────────────────────────────────
  let campaigns = [];
  let currentCampaign = null;
  let negotiations = [];
  let currentNeg = null;
  let aiDraft = '';

  // ─── DOM ────────────────────────────────────────────
  const campaignListEl = $('#campaignList');
  const emptyState = $('#emptyState');
  const negPanel = $('#negotiationPanel');
  const chatPanel = $('#chatPanel');
  const toast = $('#toast');
  const toastMsg = $('#toastMessage');

  // ─── Init ───────────────────────────────────────────
  loadCampaigns();
  checkCookies();

  // ─── Toast ──────────────────────────────────────────
  function showToast(msg, dur = 3000) {
    toastMsg.textContent = msg;
    toast.classList.add('show');
    setTimeout(() => toast.classList.remove('show'), dur);
  }

  // ═══════════════════════════════════════════════════════
  //  Campaign Management
  // ═══════════════════════════════════════════════════════

  async function loadCampaigns() {
    try {
      const res = await fetch('/api/campaigns');
      if (!res.ok) throw new Error('Failed to load campaigns');
      campaigns = await res.json();
    } catch {
      campaigns = [];
    }
    renderCampaigns();
  }

  function renderCampaigns() {
    if (!campaigns.length) {
      campaignListEl.innerHTML = '';
      emptyState.style.display = 'block';
      return;
    }
    emptyState.style.display = 'none';
    campaignListEl.innerHTML = campaigns.map(c => {
      const sym = currencySymbol(c.currency);
      return `
        <div class="campaign-card" data-id="${c.id}">
          <div class="campaign-card-left">
            <div class="campaign-icon">🚀</div>
            <div>
              <h3>${esc(c.brandName)}</h3>
              <div class="campaign-card-meta">${esc(c.collabType)} · ${sym}${c.budgetMin}–${sym}${c.budgetMax} per creator</div>
            </div>
          </div>
          <div class="campaign-card-right">
            <div class="campaign-stat">
              <span class="campaign-stat-value">${sym}${c.totalSpent || 0}</span>
              <span class="campaign-stat-label">Spent</span>
            </div>
            <button class="campaign-delete" data-id="${c.id}" title="Delete campaign">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
            </button>
          </div>
        </div>`;
    }).join('');

    $$('.campaign-card').forEach(card => {
      card.addEventListener('click', (e) => {
        if (e.target.closest('.campaign-delete')) return;
        openCampaign(card.dataset.id);
      });
    });

    $$('.campaign-delete').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (!confirm('Delete this campaign and all its negotiations?')) return;
        await fetch(`/api/campaigns/${btn.dataset.id}`, { method: 'DELETE' });
        loadCampaigns();
        showToast('Campaign deleted');
      });
    });
  }

  // New Campaign Modal
  $('#btnNewCampaign').addEventListener('click', () => {
    $('#modalOverlay').style.display = 'flex';
  });

  $('#modalClose').addEventListener('click', () => {
    $('#modalOverlay').style.display = 'none';
  });

  $('#campaignForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const payload = {
      brandName: $('#fBrandName').value.trim(),
      productName: $('#fProductName').value.trim(),
      collabType: $('#fCollabType').value,
      currency: $('#fCurrency').value,
      budgetMin: $('#fBudgetMin').value,
      budgetMax: $('#fBudgetMax').value,
      totalBudget: $('#fTotalBudget').value || 0,
      brief: $('#fBrief').value.trim(),
    };

    const res = await fetch('/api/campaigns', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const err = await res.json();
      showToast(err.error || 'Failed to create campaign');
      return;
    }

    $('#modalOverlay').style.display = 'none';
    $('#campaignForm').reset();
    showToast('Campaign created!');
    loadCampaigns();
  });

  // ═══════════════════════════════════════════════════════
  //  Negotiation Panel
  // ═══════════════════════════════════════════════════════

  async function openCampaign(id) {
    currentCampaign = campaigns.find(c => c.id === id);
    if (!currentCampaign) return;

    campaignListEl.style.display = 'none';
    emptyState.style.display = 'none';
    $('.page-header').style.display = 'none';
    chatPanel.style.display = 'none';
    negPanel.style.display = 'block';

    const sym = currencySymbol(currentCampaign.currency);
    $('#campaignInfo').innerHTML = `
      <h2>${esc(currentCampaign.brandName)}</h2>
      <p>${esc(currentCampaign.collabType)} · Budget: ${sym}${currentCampaign.budgetMin}–${sym}${currentCampaign.budgetMax}</p>`;

    await loadNegotiations();
  }

  async function loadNegotiations() {
    try {
      const res = await fetch(`/api/negotiations?campaignId=${currentCampaign.id}`);
      if (!res.ok) throw new Error('Failed');
      negotiations = await res.json();
    } catch {
      negotiations = [];
    }
    renderNegotiations();
  }

  function renderNegotiations() {
    const total = negotiations.length;
    const negotiating = negotiations.filter(n => n.status === 'negotiating' || n.status === 'replied').length;
    const closed = negotiations.filter(n => n.status === 'closed').length;
    const rejected = negotiations.filter(n => n.status === 'rejected').length;
    const spent = negotiations.reduce((sum, n) => sum + (n.agreedPrice || 0), 0);

    const sym = currencySymbol(currentCampaign.currency);
    $('#statTotal').textContent = total;
    $('#statNegotiating').textContent = negotiating;
    $('#statClosed').textContent = closed;
    $('#statRejected').textContent = rejected;
    $('#statSpent').textContent = sym + spent;

    if (!negotiations.length) {
      $('#negList').innerHTML = `
        <div class="empty-state" style="padding:40px;">
          <p>No influencers added yet. Click "Add Influencers" to import creators you've DMed.</p>
        </div>`;
      return;
    }

    $('#negList').innerHTML = negotiations.map(n => {
      const initials = (n.fullName || n.username).slice(0, 2).toUpperCase();
      const lastMsg = n.messages.length ? n.messages[n.messages.length - 1] : null;
      const lastMsgPreview = lastMsg
        ? `<span style="color:${lastMsg.role === 'creator' ? 'var(--orange)' : 'var(--accent)'};">${lastMsg.role === 'creator' ? '← ' : '→ '}</span>${esc(lastMsg.content.slice(0, 80))}${lastMsg.content.length > 80 ? '...' : ''}`
        : '';

      return `
        <div class="neg-item" data-id="${n.id}">
          <div class="neg-avatar">${initials}</div>
          <div class="neg-info">
            <h4>@${esc(n.username)}</h4>
            <div class="neg-info-meta">${esc(n.fullName || '')} · ${formatNum(n.followers)} followers${n.category ? ' · ' + esc(n.category) : ''}</div>
            ${lastMsgPreview ? `<div class="neg-last-msg">${lastMsgPreview}</div>` : ''}
          </div>
          <span class="neg-status neg-status-${n.status}">${n.status}</span>
          ${n.agreedPrice ? `<span class="neg-price">${sym}${n.agreedPrice}</span>` : ''}
        </div>`;
    }).join('');

    $$('.neg-item').forEach(item => {
      item.addEventListener('click', () => openChat(item.dataset.id));
    });
  }

  $('#btnBack').addEventListener('click', () => {
    negPanel.style.display = 'none';
    chatPanel.style.display = 'none';
    campaignListEl.style.display = 'grid';
    $('.page-header').style.display = 'flex';
    currentCampaign = null;
    loadCampaigns();
  });

  // ═══════════════════════════════════════════════════════
  //  Add Influencers — unified Track + Send flow
  // ═══════════════════════════════════════════════════════

  const ADD_VARS = [
    'first_name', 'username', 'full_name', 'followers', 'category',
    'brand', 'product', 'collab_type', 'budget_min', 'budget_max'
  ];
  let addMode = 'send';
  let addJobId = null;
  let addPollTimer = null;

  function parseCreatorList(raw) {
    const text = (raw || '').trim();
    if (!text) return [];

    if (text.startsWith('[')) {
      try {
        const arr = JSON.parse(text);
        if (Array.isArray(arr)) {
          return arr.map(c => typeof c === 'string'
            ? { username: c.replace(/^@/, '').trim() }
            : {
                username: String(c.username || c.handle || '').replace(/^@/, '').trim(),
                fullName: c.fullName || c.name || '',
                followers: c.followers || 0,
                category: c.category || '',
                email: c.email || '',
              }
          ).filter(c => c.username);
        }
      } catch {}
    }

    return text.split('\n').map(line => {
      const [unameRaw, ...rest] = line.split(',');
      const uname = (unameRaw || '').replace(/^@/, '').trim();
      if (!uname) return null;
      return { username: uname, fullName: rest.join(',').trim() };
    }).filter(Boolean);
  }

  function renderAddVarChips() {
    const host = $('#addVarChips');
    if (!host) return;
    host.innerHTML = ADD_VARS.map(v =>
      `<button type="button" class="btn btn-outline btn-sm" data-var="${v}" style="padding:4px 10px;font-size:12px;">{{${v}}}</button>`
    ).join('');
    host.querySelectorAll('button[data-var]').forEach(b => {
      b.addEventListener('click', () => {
        const ta = $('#fFirstMessage');
        const token = `{{${b.dataset.var}}}`;
        const start = ta.selectionStart || ta.value.length;
        const end = ta.selectionEnd || ta.value.length;
        ta.value = ta.value.slice(0, start) + token + ta.value.slice(end);
        ta.focus();
        ta.selectionStart = ta.selectionEnd = start + token.length;
      });
    });
  }

  function applyAddMode(mode) {
    addMode = mode;
    const sendBtn = $('#modeSend');
    const trackBtn = $('#modeTrack');
    sendBtn.classList.toggle('mode-btn-active', mode === 'send');
    trackBtn.classList.toggle('mode-btn-active', mode === 'track');
    sendBtn.style.color = mode === 'send' ? 'var(--text)' : 'var(--text-muted)';
    trackBtn.style.color = mode === 'track' ? 'var(--text)' : 'var(--text-muted)';

    $('#sendOptions').style.display = mode === 'send' ? 'block' : 'none';
    $('#addVarChips').style.display = mode === 'send' ? 'flex' : 'none';
    $('#btnAddPreview').style.display = mode === 'send' ? 'inline-flex' : 'none';

    $('#messageLabel').textContent = mode === 'send' ? 'Message Template' : 'First Message You Sent';
    $('#addPrimaryLabel').textContent = mode === 'send' ? '🚀 Send DMs Now' : '📋 Add to Campaign';
    $('#modeHint').textContent = mode === 'send'
      ? 'Send a personalized initial DM to this list right from here. No copy-pasting on Instagram.'
      : 'Just track creators you already messaged on Instagram manually. Replies from them will show up here.';

    $('#fFirstMessage').placeholder = mode === 'send'
      ? "Hey {{first_name}}! Loved your content 🙌 I'm from {{brand}} — we're lining up a {{collab_type}} around our {{product}}. Budget around {{budget_min}}. Interested?"
      : 'Hey! I came across your profile and love your content...';
  }

  $('#btnAddInfluencers').addEventListener('click', () => {
    $('#addInfluencerOverlay').style.display = 'flex';
    $('#addStep1').style.display = 'block';
    $('#addStep2').style.display = 'none';
    $('#addPreview').style.display = 'none';
    addJobId = null;
    if (addPollTimer) { clearInterval(addPollTimer); addPollTimer = null; }
    renderAddVarChips();
    applyAddMode('send');
  });

  $('#addInfluencerClose').addEventListener('click', () => {
    $('#addInfluencerOverlay').style.display = 'none';
    if (addPollTimer) { clearInterval(addPollTimer); addPollTimer = null; }
  });

  $('#modeSend').addEventListener('click', () => applyAddMode('send'));
  $('#modeTrack').addEventListener('click', () => applyAddMode('track'));

  $('#btnAddPreview').addEventListener('click', async () => {
    const template = $('#fFirstMessage').value;
    const creators = parseCreatorList($('#fInfluencerList').value).slice(0, 3);
    if (!template.trim()) { showToast('Write a message template first'); return; }
    if (!creators.length) { showToast('Add at least one creator'); return; }

    try {
      const res = await fetch('/api/templates/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ template, creators, campaignId: currentCampaign.id }),
      });
      const data = await res.json();
      if (!res.ok) { showToast(data.error || 'Preview failed'); return; }
      $('#addPreviewBody').innerHTML = data.previews.map(p => `
        <div style="padding:10px;border:1px solid rgba(255,255,255,0.08);border-radius:8px;margin-bottom:8px;">
          <div style="font-size:12px;color:var(--text-muted);margin-bottom:4px;">@${esc(p.username)}${p.fullName ? ' · ' + esc(p.fullName) : ''}</div>
          <div style="white-space:pre-wrap;">${esc(p.rendered)}</div>
        </div>
      `).join('');
      $('#addPreview').style.display = 'block';
    } catch (err) {
      showToast('Preview error: ' + err.message);
    }
  });

  $('#btnDoAddInfluencers').addEventListener('click', async () => {
    const creators = parseCreatorList($('#fInfluencerList').value);
    if (!creators.length) { showToast('Add at least one creator'); return; }

    if (addMode === 'track') {
      const firstMessage = $('#fFirstMessage').value.trim() || 'Initial DM sent';
      const payload = creators.map(c => ({
        username: c.username,
        fullName: c.fullName || '',
        firstMessage,
      }));
      const res = await fetch('/api/negotiations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ campaignId: currentCampaign.id, influencers: payload }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        showToast(err.error || 'Failed');
        return;
      }
      const created = await res.json();
      $('#addInfluencerOverlay').style.display = 'none';
      $('#fInfluencerList').value = '';
      $('#fFirstMessage').value = '';
      showToast(`Added ${created.length} influencer(s)`);
      loadNegotiations();
      return;
    }

    // Send mode — kick off bulk job
    const template = $('#fFirstMessage').value.trim();
    const delaySeconds = Number($('#fMassDelay').value) || 45;
    const maxPerRun = Number($('#fMassCap').value) || 30;
    const reDmExisting = $('#fMassRedm').checked;

    if (!template) { showToast('Write a message template first'); return; }
    if (delaySeconds < 15) {
      if (!confirm('A delay under 15s can trip Instagram spam detection. Continue?')) return;
    }

    const btn = $('#btnDoAddInfluencers');
    btn.disabled = true;
    const label = $('#addPrimaryLabel').textContent;
    $('#addPrimaryLabel').textContent = 'Starting…';
    try {
      const res = await fetch(`/api/campaigns/${currentCampaign.id}/bulk-send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ template, creators, delaySeconds, maxPerRun, reDmExisting }),
      });
      const data = await res.json();
      if (!res.ok) { showToast(data.error || 'Failed to start', 8000); return; }

      addJobId = data.jobId;
      $('#addStep1').style.display = 'none';
      $('#addStep2').style.display = 'block';
      $('#addTotal').textContent = data.total;
      $('#addSent').textContent = '0';
      $('#addFailed').textContent = '0';
      $('#addSkipped').textContent = '0';
      $('#addProgressBar').style.width = '0%';
      $('#addLog').innerHTML = '';
      startAddPolling();
      showToast(`Outreach started for ${data.total} creator(s)`);
    } catch (err) {
      showToast('Error: ' + err.message);
    } finally {
      btn.disabled = false;
      $('#addPrimaryLabel').textContent = label;
    }
  });

  function startAddPolling() {
    if (addPollTimer) clearInterval(addPollTimer);
    pollAddJob();
    addPollTimer = setInterval(pollAddJob, 3000);
  }

  async function pollAddJob() {
    if (!addJobId) return;
    try {
      const res = await fetch(`/api/bulk-jobs/${addJobId}`);
      if (!res.ok) return;
      const job = await res.json();

      $('#addSent').textContent = job.sent || 0;
      $('#addFailed').textContent = job.failed || 0;
      $('#addSkipped').textContent = job.skipped || 0;
      $('#addTotal').textContent = job.total || 0;

      const processed = (job.sent || 0) + (job.failed || 0) + (job.skipped || 0);
      const pct = job.total ? Math.round((processed / job.total) * 100) : 0;
      $('#addProgressBar').style.width = pct + '%';

      $('#addJobStatus').textContent = {
        running: `Running… ${processed}/${job.total}`,
        completed: `Completed · ${job.sent} sent, ${job.failed} failed, ${job.skipped} skipped`,
        stopped: 'Stopped by user',
        failed: 'Job failed',
      }[job.status] || job.status;

      const logEl = $('#addLog');
      logEl.innerHTML = (job.log || []).slice(-100).map(e => {
        const time = new Date(e.at).toLocaleTimeString();
        return `<div class="log-entry"><span class="log-time">[${time}]</span> <span class="log-${e.type === 'error' ? 'error' : e.type === 'success' ? 'action' : 'info'}">${esc(e.msg)}</span></div>`;
      }).join('');
      logEl.scrollTop = logEl.scrollHeight;

      if (job.status !== 'running') {
        clearInterval(addPollTimer);
        addPollTimer = null;
        loadNegotiations();
      }
    } catch (err) {
      console.error('Poll error:', err);
    }
  }

  $('#btnAddStop').addEventListener('click', async () => {
    if (!addJobId) return;
    if (!confirm('Stop the bulk outreach? Messages already sent will remain.')) return;
    try {
      await fetch(`/api/bulk-jobs/${addJobId}/stop`, { method: 'POST' });
      showToast('Stop requested');
    } catch (err) {
      showToast('Failed to stop: ' + err.message);
    }
  });

  $('#btnAddDone').addEventListener('click', () => {
    $('#addInfluencerOverlay').style.display = 'none';
    if (addPollTimer) { clearInterval(addPollTimer); addPollTimer = null; }
    loadNegotiations();
  });

  // ═══════════════════════════════════════════════════════
  //  Chat Panel
  // ═══════════════════════════════════════════════════════

  function openChat(negId) {
    currentNeg = negotiations.find(n => n.id === negId);
    if (!currentNeg) return;

    negPanel.style.display = 'none';
    chatPanel.style.display = 'block';
    aiDraft = '';
    $('#aiResponseArea').style.display = 'none';

    const initials = (currentNeg.fullName || currentNeg.username).slice(0, 2).toUpperCase();
    $('#chatAvatar').textContent = initials;
    $('#chatCreatorName').textContent = `@${currentNeg.username}`;
    $('#chatCreatorMeta').textContent = `${formatNum(currentNeg.followers)} followers${currentNeg.category ? ' · ' + currentNeg.category : ''}`;
    $('#chatStatus').value = currentNeg.status;

    renderChat();
  }

  function renderChat() {
    const container = $('#chatMessages');
    container.innerHTML = currentNeg.messages.map(m => {
      const isYou = m.role === 'you';
      const time = m.timestamp ? new Date(m.timestamp).toLocaleString() : '';
      return `
        <div class="msg ${isYou ? 'msg-you' : 'msg-creator'}">
          <div class="msg-label">${isYou ? 'You' : 'Creator'}</div>
          ${esc(m.content)}
          <div class="msg-time">${time}${m.sentViaApify ? ' · via DM' : ''}</div>
        </div>`;
    }).join('');
    container.scrollTop = container.scrollHeight;
  }

  $('#btnBackToNeg').addEventListener('click', () => {
    chatPanel.style.display = 'none';
    negPanel.style.display = 'block';
    currentNeg = null;
    loadNegotiations();
  });

  // Submit creator's reply
  $('#btnSubmitReply').addEventListener('click', async () => {
    const msg = $('#creatorReply').value.trim();
    if (!msg) { showToast('Paste the creator\'s reply first'); return; }

    const res = await fetch(`/api/negotiations/${currentNeg.id}/reply`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: msg }),
    });

    if (!res.ok) {
      const err = await res.json();
      showToast(err.error || 'Failed');
      return;
    }

    currentNeg = await res.json();
    $('#creatorReply').value = '';
    $('#chatStatus').value = currentNeg.status;
    renderChat();
    showToast('Reply added');

    generateAIResponse();
  });

  // Generate AI response
  async function generateAIResponse() {
    const btn = $('#btnGenerateAI');
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> Thinking...';

    try {
      const res = await fetch(`/api/negotiations/${currentNeg.id}/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });

      if (!res.ok) {
        const err = await res.json();
        showToast(err.error || 'AI generation failed');
        return;
      }

      const data = await res.json();
      aiDraft = data.message;

      const area = $('#aiResponseArea');
      area.style.display = 'block';
      $('#aiResponseText').textContent = aiDraft;
      $('#aiResponseText').contentEditable = 'false';
      area.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    } catch (err) {
      showToast('Error: ' + err.message);
    } finally {
      btn.disabled = false;
      btn.innerHTML = `
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a4 4 0 0 0-4 4v4h8V6a4 4 0 0 0-4-4z"/><rect x="3" y="10" width="18" height="12" rx="2"/><circle cx="12" cy="16" r="1"/></svg>
        Generate AI Response`;
    }
  }

  $('#btnGenerateAI').addEventListener('click', generateAIResponse);

  $('#btnRegenerateAI').addEventListener('click', generateAIResponse);

  $('#btnEditAI').addEventListener('click', () => {
    const el = $('#aiResponseText');
    if (el.contentEditable === 'true') {
      el.contentEditable = 'false';
      aiDraft = el.textContent;
      $('#btnEditAI').textContent = 'Edit';
    } else {
      el.contentEditable = 'true';
      el.focus();
      $('#btnEditAI').textContent = 'Done';
    }
  });

  $('#btnCopyAI').addEventListener('click', async () => {
    const text = $('#aiResponseText').textContent;
    try {
      await navigator.clipboard.writeText(text);
      showToast('Copied to clipboard!');
    } catch {
      showToast('Copy failed');
    }
  });

  async function doSendDM(message, { force = false } = {}) {
    const res = await fetch(`/api/negotiations/${currentNeg.id}/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message, force }),
    });
    const data = await res.json();
    return { res, data };
  }

  $('#btnSendAI').addEventListener('click', async () => {
    const message = $('#aiResponseText').textContent.trim();
    if (!message) { showToast('No message to send'); return; }

    const btn = $('#btnSendAI');
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> Sending...';

    try {
      let { res, data } = await doSendDM(message);

      if (!res.ok && data.code === 'DUPLICATE_MESSAGE') {
        const pct = Math.round((data.similarity || 0) * 100);
        const ok = confirm(
          `This message is ${pct}% similar to one you already sent@${currentNeg.username}:\n\n` +
          `"${(data.duplicateOf || '').slice(0, 200)}"\n\n` +
          `Sending near-duplicates looks like spam. Send anyway?`
        );
        if (!ok) {
          showToast('Send cancelled. Try "Regenerate" to get a different draft.', 6000);
          return;
        }
        ({ res, data } = await doSendDM(message, { force: true }));
      }

      if (!res.ok) {
        showToast(data.error || 'Failed to send DM', 8000);
        console.error('DM send failed:', data);
        return;
      }

      currentNeg = data.negotiation;
      renderChat();
      $('#aiResponseArea').style.display = 'none';
      aiDraft = '';
      showToast('DM sent successfully!');
    } catch (err) {
      showToast('Error: ' + err.message);
    } finally {
      btn.disabled = false;
      btn.innerHTML = `
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m22 2-7 20-4-9-9-4z"/><path d="M22 2 11 13"/></svg>
        Send via DM`;
    }
  });

  // Status change
  $('#chatStatus').addEventListener('change', async () => {
    const status = $('#chatStatus').value;
    let agreedPrice;

    if (status === 'closed') {
      const priceStr = prompt(`Deal closed! Enter the agreed price (${currencySymbol(currentCampaign.currency)}):`);
      if (priceStr === null) {
        $('#chatStatus').value = currentNeg.status;
        return;
      }
      agreedPrice = parseFloat(priceStr) || 0;
    }

    const body = { status };
    if (agreedPrice !== undefined) body.agreedPrice = agreedPrice;

    const res = await fetch(`/api/negotiations/${currentNeg.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (res.ok) {
      currentNeg = await res.json();
      // Update the negotiations array so stats reflect the change
      const idx = negotiations.findIndex(n => n.id === currentNeg.id);
      if (idx !== -1) negotiations[idx] = currentNeg;
      showToast(status === 'closed' ? `Deal closed at ${currencySymbol(currentCampaign.currency)}${currentNeg.agreedPrice}!` : `Status: ${status}`);
    }
  });

  // ═══════════════════════════════════════════════════════
  //  Settings (Cookies)
  // ═══════════════════════════════════════════════════════

  async function checkCookies() {
    let data = { hasCookies: false, count: 0, valid: false };
    try {
      const res = await fetch('/api/settings/cookies');
      if (res.ok) data = await res.json();
    } catch {}
    const el = $('#cookieStatus');
    if (data.hasCookies && data.valid) {
      el.className = 'cookie-status has-cookies';
      el.textContent = `Instagram cookies configured (${data.count} cookies, source: ${data.source || 'disk'})`;
    } else if (data.hasCookies && !data.valid) {
      el.className = 'cookie-status no-cookies';
      el.textContent = data.error || 'Cookies are incomplete. Re-export and paste again.';
    } else {
      el.className = 'cookie-status no-cookies';
      el.textContent = 'No Instagram cookies configured yet. DM sending will not work.';
    }
  }

  $('#btnSettings').addEventListener('click', () => {
    $('#settingsOverlay').style.display = 'flex';
    checkCookies();
  });

  $('#settingsClose').addEventListener('click', () => {
    $('#settingsOverlay').style.display = 'none';
  });

  $('#btnSaveCookies').addEventListener('click', async () => {
    const raw = $('#fCookies').value.trim();
    if (!raw) { showToast('Paste cookies JSON'); return; }

    let cookies;
    try {
      cookies = JSON.parse(raw);
      if (!Array.isArray(cookies)) throw new Error('Must be an array');
    } catch {
      showToast('Invalid JSON. Must be a JSON array of cookie objects.');
      return;
    }

    const res = await fetch('/api/settings/cookies', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cookies }),
    });

    const data = await res.json().catch(() => ({}));
    if (res.ok) {
      showToast('Cookies saved!');
      checkCookies();
      $('#fCookies').value = '';
    } else {
      showToast(data.error || 'Failed to save cookies', 6000);
    }
  });

  const btnTestCookies = $('#btnTestCookies');
  if (btnTestCookies) {
    btnTestCookies.addEventListener('click', async () => {
      btnTestCookies.disabled = true;
      btnTestCookies.textContent = 'Testing...';
      try {
        const res = await fetch('/api/settings/cookies/test', { method: 'POST' });
        const data = await res.json();
        if (res.ok && data.ok) {
          showToast(`Cookies work! ${data.username ? '@' + data.username + ' · ' : ''}${data.threadCount} threads.`, 5000);
        } else {
          showToast(data.error || 'Cookie test failed', 8000);
        }
      } catch (err) {
        showToast('Test failed: ' + err.message, 6000);
      } finally {
        btnTestCookies.disabled = false;
        btnTestCookies.textContent = 'Test Cookies (Inbox Check)';
      }
    });
  }

  const btnTestDM = $('#btnTestDM');
  if (btnTestDM) {
    btnTestDM.addEventListener('click', async () => {
      const username = $('#fTestUsername').value.trim().replace(/^@/, '');
      const message = $('#fTestMessage').value.trim();
      const out = $('#testDmResult');
      if (!username || !message) { showToast('Fill in username and message'); return; }

      btnTestDM.disabled = true;
      btnTestDM.textContent = 'Sending...';
      out.style.display = 'block';
      out.textContent = 'Sending test DM, please wait (can take up to 3 minutes)...';
      try {
        const res = await fetch('/api/settings/test-dm', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username, message }),
        });
        const data = await res.json();
        out.textContent = JSON.stringify(data, null, 2);
        if (res.ok && data.ok) {
          showToast('Test DM delivered!', 5000);
        } else {
          showToast(data.error || 'Test DM failed', 8000);
        }
      } catch (err) {
        out.textContent = 'Error: ' + err.message;
        showToast('Error: ' + err.message, 6000);
      } finally {
        btnTestDM.disabled = false;
        btnTestDM.textContent = 'Send Test DM';
      }
    });
  }

  // Close modals on overlay click
  $$('.modal-overlay').forEach(overlay => {
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) overlay.style.display = 'none';
    });
  });

  // ═══════════════════════════════════════════════════════
  //  Autopilot System
  // ═══════════════════════════════════════════════════════

  let autopilotInterval = null;
  let autopilotRunning = false;
  const AUTOPILOT_INTERVAL_MS = 45000; // Check every 45 seconds

  function logAutopilot(msg, type = 'info') {
    const logEl = $('#autopilotLog');
    logEl.style.display = 'block';
    const time = new Date().toLocaleTimeString();
    const entry = document.createElement('div');
    entry.className = 'log-entry';
    entry.innerHTML = `<span class="log-time">[${time}]</span> <span class="log-${type}">${msg}</span>`;
    logEl.appendChild(entry);
    logEl.scrollTop = logEl.scrollHeight;
  }

  async function runAutopilotOnce() {
    try {
      logAutopilot('Checking inbox for new replies...', 'info');
      $('#autopilotStatus').textContent = 'Checking inbox...';

      const res = await fetch('/api/autopilot/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });

      const data = await res.json();

      if (!res.ok) {
        logAutopilot(`Error: ${data.error}`, 'error');
        $('#autopilotStatus').textContent = `Error: ${data.error}`;
        return;
      }

      if (!data.results || data.results.length === 0) {
        logAutopilot('No new replies found.', 'info');
        $('#autopilotStatus').textContent = autopilotRunning
          ? `No new replies. Next check in ${AUTOPILOT_INTERVAL_MS / 1000}s...`
          : 'No new replies found.';
        return;
      }

      for (const r of data.results) {
        if (r.status === 'replied') {
          logAutopilot(`@${r.username} said: "${r.creatorSaid.slice(0, 60)}..."`, 'info');
          logAutopilot(`AI replied to @${r.username}: "${r.aiReplied.slice(0, 60)}..."`, 'action');
        } else if (r.status === 'ai_failed') {
          logAutopilot(`AI failed for @${r.username}: ${r.error}`, 'error');
        } else if (r.status === 'send_failed') {
          logAutopilot(`DM send failed for @${r.username}: ${r.error || 'Unknown error'}`, 'error');
        } else if (r.status === 'skipped') {
          logAutopilot(`Skipped @${r.username}: ${r.reason || 'spam guard'}`, 'info');
        }
      }

      const replied = data.results.filter(r => r.status === 'replied').length;
      $('#autopilotStatus').textContent = autopilotRunning
        ? `Handled ${replied} reply(s). Next check in ${AUTOPILOT_INTERVAL_MS / 1000}s...`
        : `Handled ${replied} reply(s).`;

      showToast(`Autopilot: ${replied} conversation(s) handled`);
      loadNegotiations();
    } catch (err) {
      logAutopilot(`Error: ${err.message}`, 'error');
      $('#autopilotStatus').textContent = `Error: ${err.message}`;
    }
  }

  function startAutopilot() {
    if (autopilotRunning) return;
    autopilotRunning = true;

    const bar = $('#autopilotBar');
    bar.classList.add('active');
    $('#autopilotLabel').textContent = 'Autopilot ON';
    $('#autopilotStatus').textContent = 'Monitoring inbox for replies...';
    $('#btnAutopilotToggle').innerHTML = `
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>
      Stop Autopilot`;
    $('#btnAutopilotToggle').style.background = 'rgba(239, 68, 68, 0.15)';
    $('#btnAutopilotToggle').style.borderColor = 'rgba(239, 68, 68, 0.3)';
    $('#btnAutopilotToggle').style.color = 'var(--red)';

    logAutopilot('Autopilot started. Monitoring every ' + (AUTOPILOT_INTERVAL_MS / 1000) + 's...', 'action');

    runAutopilotOnce();
    autopilotInterval = setInterval(runAutopilotOnce, AUTOPILOT_INTERVAL_MS);
  }

  function stopAutopilot() {
    autopilotRunning = false;
    if (autopilotInterval) clearInterval(autopilotInterval);
    autopilotInterval = null;

    const bar = $('#autopilotBar');
    bar.classList.remove('active');
    $('#autopilotLabel').textContent = 'Autopilot Off';
    $('#autopilotStatus').textContent = 'Click to start — AI will auto-read replies and respond';
    $('#btnAutopilotToggle').innerHTML = `
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"/></svg>
      Start Autopilot`;
    $('#btnAutopilotToggle').style.background = '';
    $('#btnAutopilotToggle').style.borderColor = '';
    $('#btnAutopilotToggle').style.color = '';

    logAutopilot('Autopilot stopped.', 'info');
  }

  $('#btnAutopilotToggle').addEventListener('click', () => {
    if (autopilotRunning) stopAutopilot();
    else startAutopilot();
  });

  $('#btnAutopilotOnce').addEventListener('click', () => {
    runAutopilotOnce();
  });

  // ─── Helpers ────────────────────────────────────────
  function esc(s) {
    if (!s) return '';
    const el = document.createElement('span');
    el.textContent = s;
    return el.innerHTML;
  }

  function formatNum(n) {
    if (!n && n !== 0) return '?';
    if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
    if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
    return n.toString();
  }

  function currencySymbol(code) {
    const map = { INR: '₹', USD: '$', GBP: '£', EUR: '€' };
    return map[code] || code + ' ';
  }
})();
