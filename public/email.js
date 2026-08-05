(function () {
  'use strict';

  const $ = (s) => document.querySelector(s);
  const $$ = (s) => document.querySelectorAll(s);

  let providers = [];
  let senders = [];
  let contacts = [];
  let templates = [];
  let editingTemplateId = null;
  let editingSenderId = null;
  let pollTimer = null;
  let deals = [];
  let currentDeal = null;
  let dealAutopilotOn = false;
  let dealAutopilotTimer = null;
  const DEAL_AUTOPILOT_MS = 60000;

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function showToast(msg, ms = 3000) {
    $('#toastMessage').textContent = msg;
    $('#toast').classList.add('show');
    setTimeout(() => $('#toast').classList.remove('show'), ms);
  }

  async function api(url, opts) {
    const res = await fetch(url, opts);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    return data;
  }

  function when(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  // ─── Tabs ───────────────────────────────────────────────
  $$('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
      $$('.tab').forEach(t => t.classList.remove('active'));
      $$('.pane').forEach(p => p.classList.remove('active'));
      tab.classList.add('active');
      $('#' + tab.dataset.pane).classList.add('active');
      if (tab.dataset.pane === 'paneResults') loadResults();
      if (tab.dataset.pane === 'paneSend') fillCampaignSelects();
      if (tab.dataset.pane === 'paneTemplate') refreshPreview();
      if (tab.dataset.pane === 'paneDeals') loadDeals();
    });
  });

  // ─── Stats ──────────────────────────────────────────────
  async function loadStats() {
    try {
      const s = await api('/api/email/stats');
      $('#statContacts').textContent = s.contacts;
      $('#statSent').textContent = s.sent;
      $('#statFailed').textContent = s.failed;
      $('#statCampaigns').textContent = s.campaigns;
      $('#statDeals').textContent = s.negotiationsActive || 0;
      $('#tabContactCount').textContent = s.contacts;
      $('#tabDealCount').textContent = s.negotiations || 0;
    } catch (_) {}
  }

  // ─── 1. Senders ─────────────────────────────────────────
  async function loadProviders() {
    providers = await api('/api/email/providers');
    $('#sProvider').innerHTML = providers
      .map(p => `<option value="${esc(p.id)}">${esc(p.label)}</option>`).join('');
    applyProvider();
  }

  function applyProvider() {
    const p = providers.find(x => x.id === $('#sProvider').value);
    if (!p) return;
    $('#sProviderHint').textContent = p.hint || '';
    $('#sHost').value = p.host || '';
    $('#sPort').value = p.port || 587;
    $('#sImapHost').value = p.imapHost || '';
    $('#sImapPort').value = p.imapPort || 993;
    if (p.presetUser) $('#sUser').value = p.presetUser;
    // A custom provider has no preset host, so the user must fill it in —
    // don't leave that required field hidden behind "Advanced".
    if (!p.host) $('#advancedDetails').open = true;
  }

  $('#sProvider').addEventListener('change', applyProvider);

  async function loadSenders() {
    senders = await api('/api/email/senders');
    const el = $('#senderList');
    if (!senders.length) {
      el.innerHTML = '<p class="muted" style="margin-bottom:16px;">No email account connected yet — add one below.</p>';
    } else {
      el.innerHTML = senders.map(s => `
        <div class="row-item">
          <div class="row-item-main">
            <div class="row-item-title">${esc(s.fromName || s.fromEmail)}
              ${s.imapHost
                ? '<span class="badge badge-good" style="margin-left:8px;">Auto-negotiate ready</span>'
                : '<span class="badge badge-unknown" style="margin-left:8px;">Send-only</span>'}
            </div>
            <div class="row-item-sub">${esc(s.fromEmail)} · SMTP ${esc(s.host)}:${esc(s.port)}${s.imapHost ? ` · IMAP ${esc(s.imapHost)}:${esc(s.imapPort)}` : ''}</div>
          </div>
          <div style="display:flex;gap:8px;flex:none;">
            <button class="btn btn-outline btn-sm" data-test="${esc(s.id)}">Test</button>
            <button class="btn btn-outline btn-sm" data-edit-sender="${esc(s.id)}">Edit</button>
            <button class="btn btn-outline btn-sm" data-del-sender="${esc(s.id)}">Remove</button>
          </div>
        </div>`).join('');

      el.querySelectorAll('[data-test]').forEach(b =>
        b.addEventListener('click', () => testSender(b.dataset.test, b)));
      el.querySelectorAll('[data-edit-sender]').forEach(b =>
        b.addEventListener('click', () => editSender(b.dataset.editSender)));
      el.querySelectorAll('[data-del-sender]').forEach(b =>
        b.addEventListener('click', () => deleteSender(b.dataset.delSender)));
    }
    fillCampaignSelects();
  }

  function editSender(id) {
    const s = senders.find(x => x.id === id);
    if (!s) return;
    editingSenderId = id;
    $('#sFromEmail').value = s.fromEmail || '';
    $('#sFromName').value = s.fromName || '';
    $('#sHost').value = s.host || '';
    $('#sPort').value = s.port || 587;
    $('#sImapHost').value = s.imapHost || '';
    $('#sImapPort').value = s.imapPort || 993;
    $('#sUser').value = s.user || '';
    $('#sReplyTo').value = s.replyTo || '';
    $('#sPass').value = '';
    // IMAP fields live under Advanced — open it when editing one that uses them.
    if (s.imapHost) $('#advancedDetails').open = true;
    $('#senderMsg').textContent = 'Editing — leave password blank to keep the current one.';
    $('#sFromEmail').scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  async function deleteSender(id) {
    if (!confirm('Remove this email account?')) return;
    await api('/api/email/senders/' + encodeURIComponent(id), { method: 'DELETE' });
    showToast('Removed');
    loadSenders();
    loadStats();
  }

  async function testSender(id, btn) {
    const to = prompt('Send a test email to which address?\n(Leave blank to only check the login.)', '');
    if (to === null) return;
    const label = btn.textContent;
    btn.disabled = true; btn.textContent = 'Testing…';
    try {
      const data = await api('/api/email/senders/' + encodeURIComponent(id) + '/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ to: to.trim() }),
      });
      showToast('✓ ' + (data.message || 'Works!'), 5000);
    } catch (err) {
      showToast(err.message, 8000);
    } finally {
      btn.disabled = false; btn.textContent = label;
    }
  }

  $('#btnSaveSender').addEventListener('click', async () => {
    const imapPort = Number($('#sImapPort').value) || 993;
    const payload = {
      id: editingSenderId || undefined,
      fromEmail: $('#sFromEmail').value.trim(),
      fromName: $('#sFromName').value.trim(),
      host: $('#sHost').value.trim(),
      port: Number($('#sPort').value) || 587,
      secure: Number($('#sPort').value) === 465,
      user: $('#sUser').value.trim(),
      replyTo: $('#sReplyTo').value.trim(),
      pass: $('#sPass').value,
      imapHost: $('#sImapHost').value.trim(),
      imapPort,
      imapSecure: imapPort !== 143,
    };
    const btn = $('#btnSaveSender');
    btn.disabled = true;
    try {
      await api('/api/email/senders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      editingSenderId = null;
      $('#sPass').value = '';
      $('#senderMsg').textContent = '';
      showToast('Email account saved');
      loadSenders();
      loadStats();
    } catch (err) {
      $('#senderMsg').textContent = err.message;
    } finally {
      btn.disabled = false;
    }
  });

  // ─── 2. Contacts ────────────────────────────────────────
  async function loadContacts() {
    contacts = await api('/api/email/contacts');
    const body = $('#contactsBody');
    if (!contacts.length) {
      $('#contactsEmpty').style.display = 'block';
      $('#contactsWrap').style.display = 'none';
      $('#contactsMore').textContent = '';
      body.innerHTML = '';
    } else {
      $('#contactsEmpty').style.display = 'none';
      $('#contactsWrap').style.display = 'block';
      const shown = contacts.slice(0, 200);
      body.innerHTML = shown.map((c, i) => `
        <tr>
          <td>${i + 1}</td>
          <td>${esc(c.email)}</td>
          <td>${esc(c.firstName) || '—'}</td>
          <td>${esc(c.fullName) || '—'}</td>
          <td>${esc(c.company) || '—'}</td>
          <td>${c.unsubscribed
            ? '<span class="badge badge-poor">Opted out</span>'
            : '<span class="badge badge-good">Active</span>'}</td>
          <td><button class="btn-delete-row" data-del-contact="${esc(c.id)}" title="Remove">&times;</button></td>
        </tr>`).join('');
      $('#contactsMore').textContent = contacts.length > shown.length
        ? `Showing first ${shown.length} of ${contacts.length} contacts.` : '';
      body.querySelectorAll('[data-del-contact]').forEach(b =>
        b.addEventListener('click', async () => {
          await api('/api/email/contacts/' + encodeURIComponent(b.dataset.delContact), { method: 'DELETE' });
          loadContacts(); loadStats();
        }));
    }
    $('#tabContactCount').textContent = contacts.length;
    renderVarChips();
    refreshPreview();
    refreshRosterHint();
  }

  $('#btnUpload').addEventListener('click', () => $('#contactFile').click());

  $('#contactFile').addEventListener('change', async () => {
    const file = $('#contactFile').files && $('#contactFile').files[0];
    if (!file) return;
    $('#uploadMsg').textContent = 'Reading ' + file.name + '…';
    try {
      const dataBase64 = await new Promise((resolve, reject) => {
        const fr = new FileReader();
        fr.onload = () => resolve(String(fr.result).split(',')[1]);
        fr.onerror = () => reject(new Error('Could not read the file.'));
        fr.readAsDataURL(file);
      });
      const data = await api('/api/email/contacts/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename: file.name, dataBase64 }),
      });
      $('#uploadMsg').textContent =
        `Added ${data.added}, updated ${data.updated}${data.invalid ? `, skipped ${data.invalid} row(s) without a valid email` : ''}.`;
      showToast(`Imported ${data.added + data.updated} contacts`);
      loadContacts();
      loadStats();
    } catch (err) {
      $('#uploadMsg').textContent = err.message;
      showToast(err.message, 7000);
    } finally {
      $('#contactFile').value = '';
    }
  });

  // Pull in the Ready-to-Go influencer roster (only those with an email).
  async function refreshRosterHint() {
    const btn = $('#btnFromRoster');
    try {
      const p = await api('/api/email/contacts/roster-preview');
      if (!p.rosterTotal) {
        $('#rosterHint').textContent = 'Your Ready-to-Go influencer list is empty — add creators on the Discovery page and they can be imported here.';
        btn.disabled = true;
        return;
      }
      if (!p.withEmail) {
        $('#rosterHint').textContent = `You have ${p.rosterTotal} saved influencer(s), but none of them have an email address saved.`;
        btn.disabled = true;
        return;
      }
      btn.disabled = false;
      $('#rosterHint').textContent =
        `${p.withEmail} of your ${p.rosterTotal} saved influencers have an email address`
        + (p.newOnes ? ` — ${p.newOnes} not in your contacts yet.` : ' — all of them are already imported.');
    } catch (_) {
      $('#rosterHint').textContent = '';
    }
  }

  $('#btnFromRoster').addEventListener('click', async () => {
    const btn = $('#btnFromRoster');
    btn.disabled = true;
    const label = btn.textContent;
    btn.textContent = 'Importing…';
    try {
      const data = await api('/api/email/contacts/from-roster', { method: 'POST' });
      $('#uploadMsg').textContent =
        `From your saved influencers: added ${data.added}, updated ${data.updated}`
        + (data.skippedNoEmail ? `, skipped ${data.skippedNoEmail} without an email address` : '') + '.';
      showToast(`Imported ${data.added + data.updated} influencer contacts`);
      loadContacts();
      loadStats();
    } catch (err) {
      $('#uploadMsg').textContent = err.message;
      showToast(err.message, 7000);
    } finally {
      btn.textContent = label;
      btn.disabled = false;
      refreshRosterHint();
    }
  });

  $('#btnSampleCsv').addEventListener('click', () => {
    const csv = 'Email,First Name,Full Name,Company\n'
      + 'alex@example.com,Alex,Alex Morgan,Morgan Media\n'
      + 'priya@example.com,Priya,Priya Kapoor,Kapoor Studio\n';
    const blob = new Blob([csv], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'sample-contacts.csv';
    a.click();
    URL.revokeObjectURL(a.href);
  });

  $('#btnClearContacts').addEventListener('click', async () => {
    if (!contacts.length) return;
    if (!confirm(`Remove all ${contacts.length} contacts? This cannot be undone.`)) return;
    await api('/api/email/contacts', { method: 'DELETE' });
    showToast('All contacts removed');
    loadContacts(); loadStats();
  });

  // ─── 3. Templates ───────────────────────────────────────
  const BASE_VARS = ['first_name', 'full_name', 'last_name', 'email', 'company', 'username'];

  function renderVarChips() {
    const extra = new Set();
    contacts.slice(0, 50).forEach(c => Object.keys(c.custom || {}).forEach(k => extra.add(k)));
    const all = BASE_VARS.concat(Array.from(extra).filter(k => !BASE_VARS.includes(k)));
    $('#varChips').innerHTML = '<span class="muted">Insert:</span> ' +
      all.map(v => `<span class="var-chip" data-var="${esc(v)}">{{${esc(v)}}}</span>`).join('');
    $$('#varChips .var-chip').forEach(chip => {
      chip.addEventListener('click', () => {
        const ta = $('#tBody');
        const token = '{{' + chip.dataset.var + '}}';
        const s = ta.selectionStart, e = ta.selectionEnd;
        ta.value = ta.value.slice(0, s) + token + ta.value.slice(e);
        ta.focus();
        ta.setSelectionRange(s + token.length, s + token.length);
        refreshPreview();
      });
    });
  }

  async function loadTemplates() {
    templates = await api('/api/email/templates');
    const el = $('#templateList');
    if (!templates.length) {
      el.innerHTML = '<p class="muted" style="margin-bottom:16px;">No saved templates yet — write one below.</p>';
    } else {
      el.innerHTML = templates.map(t => `
        <div class="row-item">
          <div class="row-item-main">
            <div class="row-item-title">${esc(t.name)}</div>
            <div class="row-item-sub">${esc(t.subject)}</div>
          </div>
          <div style="display:flex;gap:8px;flex:none;">
            <button class="btn btn-outline btn-sm" data-edit-tpl="${esc(t.id)}">Edit</button>
            <button class="btn btn-outline btn-sm" data-del-tpl="${esc(t.id)}">Delete</button>
          </div>
        </div>`).join('');
      el.querySelectorAll('[data-edit-tpl]').forEach(b =>
        b.addEventListener('click', () => {
          const t = templates.find(x => x.id === b.dataset.editTpl);
          if (!t) return;
          editingTemplateId = t.id;
          $('#tName').value = t.name;
          $('#tSubject').value = t.subject;
          $('#tBody').value = t.body;
          $('#templateMsg').textContent = 'Editing "' + t.name + '"';
          refreshPreview();
        }));
      el.querySelectorAll('[data-del-tpl]').forEach(b =>
        b.addEventListener('click', async () => {
          if (!confirm('Delete this template?')) return;
          await api('/api/email/templates/' + encodeURIComponent(b.dataset.delTpl), { method: 'DELETE' });
          if (editingTemplateId === b.dataset.delTpl) editingTemplateId = null;
          loadTemplates(); loadStats();
        }));
    }
    fillCampaignSelects();
  }

  $('#btnSaveTemplate').addEventListener('click', async () => {
    try {
      const data = await api('/api/email/templates', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: editingTemplateId || undefined,
          name: $('#tName').value.trim(),
          subject: $('#tSubject').value.trim(),
          body: $('#tBody').value,
        }),
      });
      editingTemplateId = data.template.id;
      $('#templateMsg').textContent = 'Saved ✓';
      showToast('Template saved');
      loadTemplates(); loadStats();
    } catch (err) {
      $('#templateMsg').textContent = err.message;
    }
  });

  let previewTimer = null;
  async function refreshPreview() {
    clearTimeout(previewTimer);
    previewTimer = setTimeout(async () => {
      try {
        const data = await api('/api/email/templates/preview', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ subject: $('#tSubject').value, body: $('#tBody').value }),
        });
        $('#pvTo').textContent = data.to;
        $('#pvSubject').textContent = data.subject || '—';
        $('#pvBody').textContent = data.body || '—';
      } catch (_) {}
    }, 250);
  }

  $('#tSubject').addEventListener('input', refreshPreview);
  $('#tBody').addEventListener('input', refreshPreview);
  $('#btnPreview').addEventListener('click', refreshPreview);

  // ─── 4. Send ────────────────────────────────────────────
  function fillCampaignSelects() {
    const sSel = $('#cSender');
    if (sSel) {
      const cur = sSel.value;
      sSel.innerHTML = senders.length
        ? senders.map(s => `<option value="${esc(s.id)}">${esc(s.fromName ? s.fromName + ' — ' : '')}${esc(s.fromEmail)}</option>`).join('')
        : '<option value="">— add an email account in step 1 —</option>';
      if (cur) sSel.value = cur;
    }
    const tSel = $('#cTemplate');
    if (tSel) {
      const cur = tSel.value;
      tSel.innerHTML = templates.length
        ? templates.map(t => `<option value="${esc(t.id)}">${esc(t.name)}</option>`).join('')
        : '<option value="">— save a message in step 3 —</option>';
      if (cur) tSel.value = cur;
    }
  }

  // Show/hide the auto-negotiate fields with the checkbox.
  $('#cNegotiate').addEventListener('change', () => {
    $('#negotiateFields').style.display = $('#cNegotiate').checked ? 'block' : 'none';
  });

  function readNegotiateConfig() {
    if (!$('#cNegotiate').checked) return { enabled: false };
    return {
      enabled: true,
      brandName: $('#nBrand').value.trim(),
      productName: $('#nProduct').value.trim(),
      collabType: $('#nCollab').value.trim(),
      brief: $('#nBrief').value.trim(),
      currency: $('#nCurrency').value.trim() || 'USD',
      budgetMin: Number($('#nBudgetMin').value) || 0,
      budgetMax: Number($('#nBudgetMax').value) || 0,
    };
  }

  $('#btnStartCampaign').addEventListener('click', async () => {
    const senderId = $('#cSender').value;
    const templateId = $('#cTemplate').value;
    if (!senderId) { showToast('Add an email account in step 1 first.'); return; }
    if (!templateId) { showToast('Save a message in step 3 first.'); return; }
    if (!contacts.length) { showToast('Upload contacts in step 2 first.'); return; }

    const negotiate = readNegotiateConfig();
    if (negotiate.enabled) {
      if (!negotiate.brandName) { showToast('Add a brand name for auto-negotiate, or turn it off.'); return; }
      if (!(negotiate.budgetMax > 0)) { showToast('Set a maximum budget for auto-negotiate, or turn it off.'); return; }
      const sender = senders.find(s => s.id === senderId);
      if (sender && !sender.imapHost) {
        showToast('Heads up: this mailbox has no IMAP host, so autopilot can\'t read replies — assisted negotiation will still work.', 7000);
      }
    }

    const audience = $('#cAudience').value;
    const count = audience === 'all'
      ? contacts.filter(c => !c.unsubscribed).length
      : null;
    const msg = count === null
      ? 'Start sending to everyone who has not been emailed before?'
      : `Start sending to ${count} contact(s)?`;
    if (!confirm(msg)) return;

    const btn = $('#btnStartCampaign');
    btn.disabled = true;
    try {
      const data = await api('/api/email/campaigns', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: $('#cName').value.trim(),
          senderId, templateId, audience,
          delayMs: Number($('#cDelay').value),
          negotiate,
        }),
      });
      $('#sendMsg').textContent = '';
      showToast(negotiate.enabled ? 'Campaign started — deals will open on the Deals tab.' : 'Campaign started');
      watchCampaign(data.campaign.id);
    } catch (err) {
      $('#sendMsg').textContent = err.message;
      showToast(err.message, 7000);
    } finally {
      btn.disabled = false;
    }
  });

  let watchedId = null;

  function watchCampaign(id) {
    watchedId = id;
    $('#liveCard').style.display = 'block';
    $('#liveCard').scrollIntoView({ behavior: 'smooth', block: 'start' });
    clearInterval(pollTimer);
    pollTimer = setInterval(pollCampaign, 2000);
    pollCampaign();
  }

  async function pollCampaign() {
    if (!watchedId) return;
    let c;
    try {
      c = await api('/api/email/campaigns/' + encodeURIComponent(watchedId));
    } catch (_) { return; }

    const total = c.total || 0;
    const done = (c.sent || 0) + (c.failed || 0) + (c.skipped || 0);
    $('#liveSent').textContent = c.sent || 0;
    $('#liveFailed').textContent = c.failed || 0;
    $('#liveSkipped').textContent = c.skipped || 0;
    $('#liveTotal').textContent = total;
    $('#liveProgress').style.width = total ? Math.round((done / total) * 100) + '%' : '0%';

    const labels = { running: 'Sending…', completed: 'Finished', stopped: 'Stopped', failed: 'Failed', draft: 'Ready' };
    $('#liveTitle').textContent = labels[c.status] || c.status;
    $('#liveSub').textContent = `${c.name} · from ${c.senderEmail} · ${done} of ${total} processed`;

    $('#liveLog').innerHTML = (c.log || []).slice(-60).reverse().map(l =>
      `<div style="padding:3px 0;color:${l.type === 'error' ? '#ff6b6b' : l.type === 'sent' ? 'var(--accent)' : 'var(--text-muted)'};font-size:12px;">
        <span style="opacity:.6;">${esc(new Date(l.at).toLocaleTimeString())}</span> ${esc(l.msg)}
      </div>`).join('');

    $('#btnStopCampaign').style.display = c.status === 'running' ? '' : 'none';

    if (c.status !== 'running') {
      clearInterval(pollTimer);
      loadStats();
      loadResults();
    }
  }

  $('#btnStopCampaign').addEventListener('click', async () => {
    if (!watchedId) return;
    try {
      await api('/api/email/campaigns/' + encodeURIComponent(watchedId) + '/stop', { method: 'POST' });
      showToast('Stopping after the current email…');
    } catch (err) { showToast(err.message); }
  });

  // ─── 5. Results ─────────────────────────────────────────
  async function loadResults() {
    // Campaigns
    try {
      const list = await api('/api/email/campaigns');
      const el = $('#campaignList');
      if (!list.length) {
        el.innerHTML = '<p class="muted">No campaigns yet.</p>';
      } else {
        const color = { completed: 'badge-good', running: 'badge-unknown', failed: 'badge-poor', stopped: 'badge-unknown', draft: 'badge-unknown' };
        el.innerHTML = list.map(c => `
          <div class="row-item">
            <div class="row-item-main">
              <div class="row-item-title">${esc(c.name)}
                <span class="badge ${color[c.status] || 'badge-unknown'}" style="margin-left:8px;">${esc(c.status)}</span>
              </div>
              <div class="row-item-sub">
                ${when(c.createdAt)} · from ${esc(c.senderEmail || '—')} ·
                ${c.sent || 0} sent, ${c.failed || 0} failed, ${c.skipped || 0} skipped of ${c.total || 0}
              </div>
            </div>
            <div style="display:flex;gap:8px;flex:none;">
              <button class="btn btn-outline btn-sm" data-view-camp="${esc(c.id)}">View emails</button>
              ${c.status === 'running'
                ? `<button class="btn btn-outline btn-sm" data-watch-camp="${esc(c.id)}">Watch</button>`
                : `<button class="btn btn-outline btn-sm" data-del-camp="${esc(c.id)}">Delete</button>`}
            </div>
          </div>`).join('');

        el.querySelectorAll('[data-view-camp]').forEach(b =>
          b.addEventListener('click', () => loadSends(b.dataset.viewCamp)));
        el.querySelectorAll('[data-watch-camp]').forEach(b =>
          b.addEventListener('click', () => {
            $$('.tab').forEach(t => t.classList.remove('active'));
            $$('.pane').forEach(p => p.classList.remove('active'));
            document.querySelector('[data-pane="paneSend"]').classList.add('active');
            $('#paneSend').classList.add('active');
            watchCampaign(b.dataset.watchCamp);
          }));
        el.querySelectorAll('[data-del-camp]').forEach(b =>
          b.addEventListener('click', async () => {
            if (!confirm('Delete this campaign? (Sent-email records are kept.)')) return;
            await api('/api/email/campaigns/' + encodeURIComponent(b.dataset.delCamp), { method: 'DELETE' });
            loadResults(); loadStats();
          }));
      }
    } catch (_) {}

    loadSends();
  }

  let sendsCampaignFilter = '';

  async function loadSends(campaignId) {
    if (campaignId !== undefined) sendsCampaignFilter = campaignId || '';
    const params = new URLSearchParams();
    if (sendsCampaignFilter) params.set('campaignId', sendsCampaignFilter);
    if ($('#filterStatus').value) params.set('status', $('#filterStatus').value);

    try {
      const data = await api('/api/email/sends?' + params.toString());
      const body = $('#sendsBody');
      if (!data.sends.length) {
        $('#sendsEmpty').style.display = 'block';
        $('#sendsWrap').style.display = 'none';
        body.innerHTML = '';
      } else {
        $('#sendsEmpty').style.display = 'none';
        $('#sendsWrap').style.display = 'block';
        body.innerHTML = data.sends.map(s => `
          <tr>
            <td style="white-space:nowrap;">${esc(when(s.at))}</td>
            <td>${esc(s.email)}</td>
            <td>${esc(s.campaignName || '—')}</td>
            <td><div class="bio-cell" title="${esc(s.subject)}">${esc(s.subject)}</div></td>
            <td>${s.status === 'sent'
              ? '<span class="badge badge-good">Sent</span>'
              : '<span class="badge badge-poor">Failed</span>'}</td>
            <td><div class="bio-cell" title="${esc(s.error || '')}">${esc(s.error || '—')}</div></td>
          </tr>`).join('');
      }
      $('#sendsSub').textContent = sendsCampaignFilter
        ? `Showing ${data.sends.length} of ${data.total} for the selected campaign`
        : `${data.total} email(s) recorded`;
    } catch (_) {}
  }

  $('#filterStatus').addEventListener('change', () => loadSends());

  // ─── Deals (auto-negotiate) ─────────────────────────────
  function dealPreview(n) {
    const last = n.messages && n.messages.length ? n.messages[n.messages.length - 1] : null;
    if (!last) return '';
    const fromCreator = last.role === 'creator';
    const color = fromCreator ? 'var(--orange)' : 'var(--accent)';
    const arrow = fromCreator ? '← ' : '→ ';
    const text = (last.content || '').slice(0, 90);
    return `<span style="color:${color};">${arrow}</span>${esc(text)}${(last.content || '').length > 90 ? '…' : ''}`;
  }

  async function loadDeals() {
    try { deals = await api('/api/email/negotiations'); }
    catch (_) { deals = []; }
    $('#tabDealCount').textContent = deals.length;
    const el = $('#dealsList');
    if (!deals.length) {
      $('#dealsEmpty').style.display = 'block';
      el.innerHTML = '';
      return;
    }
    $('#dealsEmpty').style.display = 'none';
    el.innerHTML = deals.map(n => `
      <div class="row-item">
        <div class="row-item-main">
          <div class="row-item-title">
            ${esc(n.fullName || n.firstName || n.email)}
            <span class="neg-status neg-status-${esc(n.status)}" style="margin-left:8px;">${esc(n.status)}</span>
            ${n.agreedPrice ? `<span class="neg-price" style="margin-left:6px;">${esc(n.currency || '')} ${esc(n.agreedPrice)}</span>` : ''}
          </div>
          <div class="row-item-sub">${esc(n.email)}${n.brandName ? ' · ' + esc(n.brandName) : ''} · ${dealPreview(n)}</div>
        </div>
        <div style="display:flex;gap:8px;flex:none;">
          <button class="btn btn-outline btn-sm" data-open-deal="${esc(n.id)}">Open</button>
        </div>
      </div>`).join('');
    el.querySelectorAll('[data-open-deal]').forEach(b =>
      b.addEventListener('click', () => openDeal(b.dataset.openDeal)));
  }

  $('#btnRefreshDeals').addEventListener('click', () => loadDeals());

  async function openDeal(id) {
    try { currentDeal = await api('/api/email/negotiations/' + encodeURIComponent(id)); }
    catch (err) { showToast(err.message); return; }
    $('#dealsListPanel').style.display = 'none';
    $('#dealThreadPanel').style.display = 'block';
    $('#dealName').textContent = currentDeal.fullName || currentDeal.firstName || currentDeal.email;
    const meta = [];
    if (currentDeal.username) meta.push('@' + currentDeal.username);
    if (currentDeal.followers) meta.push(Number(currentDeal.followers).toLocaleString() + ' followers');
    meta.push(currentDeal.email);
    if (currentDeal.budgetMax) {
      meta.push(`budget ${currentDeal.currency || ''} ${currentDeal.budgetMin || 0}–${currentDeal.budgetMax}`);
    }
    $('#dealMeta').textContent = meta.join(' · ');
    $('#dealStatus').value = currentDeal.status;
    $('#dealDraft').value = '';
    $('#dealCreatorReply').value = '';
    $('#dealMsg').textContent = '';
    renderDealThread();
    $('#dealThreadPanel').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function renderDealThread() {
    const c = $('#dealMessages');
    c.innerHTML = (currentDeal.messages || []).map(m => {
      const isYou = m.role === 'you';
      const time = m.timestamp ? when(m.timestamp) : '';
      let tag = '';
      if (isYou) {
        if (m.autoGenerated) tag += ' · AI';
        if (m.sentViaEmail) tag += ' · sent';
      } else if (m.autoDetected) {
        tag += ' · auto-detected';
      }
      return `
        <div class="msg ${isYou ? 'msg-you' : 'msg-creator'}">
          <div class="msg-label">${isYou ? 'You' : 'Creator'}</div>
          ${esc(m.content)}
          <div class="msg-time">${esc(time)}${tag}</div>
        </div>`;
    }).join('');
    c.scrollTop = c.scrollHeight;
  }

  async function refreshCurrentDeal() {
    if (!currentDeal) return;
    try {
      currentDeal = await api('/api/email/negotiations/' + encodeURIComponent(currentDeal.id));
      $('#dealStatus').value = currentDeal.status;
      renderDealThread();
    } catch (_) {}
  }

  $('#btnBackToDeals').addEventListener('click', () => {
    $('#dealThreadPanel').style.display = 'none';
    $('#dealsListPanel').style.display = 'block';
    currentDeal = null;
    loadDeals();
  });

  $('#btnDealSubmitReply').addEventListener('click', async () => {
    if (!currentDeal) return;
    const msg = $('#dealCreatorReply').value.trim();
    if (!msg) { showToast("Paste the creator's reply first"); return; }
    try {
      currentDeal = await api('/api/email/negotiations/' + encodeURIComponent(currentDeal.id) + '/reply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: msg }),
      });
      $('#dealCreatorReply').value = '';
      $('#dealStatus').value = currentDeal.status;
      renderDealThread();
      showToast('Reply added — drafting a response…');
      generateDealDraft();
    } catch (err) { showToast(err.message, 6000); }
  });

  async function generateDealDraft() {
    if (!currentDeal) return;
    const btn = $('#btnDealGenerate');
    const label = btn.textContent;
    btn.disabled = true; btn.textContent = 'Drafting…';
    $('#dealMsg').textContent = '';
    try {
      const data = await api('/api/email/negotiations/' + encodeURIComponent(currentDeal.id) + '/generate', {
        method: 'POST',
      });
      $('#dealDraft').value = data.message || '';
      $('#dealMsg').textContent = 'AI draft ready — review, edit, then Send.';
    } catch (err) {
      $('#dealMsg').textContent = err.message;
    } finally {
      btn.disabled = false; btn.textContent = label;
    }
  }

  $('#btnDealGenerate').addEventListener('click', generateDealDraft);

  $('#btnDealSend').addEventListener('click', async () => {
    if (!currentDeal) return;
    const message = $('#dealDraft').value.trim();
    if (!message) { showToast('Write or generate an email first'); return; }
    const btn = $('#btnDealSend');
    const label = btn.textContent;
    btn.disabled = true; btn.textContent = 'Sending…';
    try {
      const data = await api('/api/email/negotiations/' + encodeURIComponent(currentDeal.id) + '/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message }),
      });
      currentDeal = data.negotiation;
      $('#dealDraft').value = '';
      $('#dealMsg').textContent = 'Sent ✓';
      renderDealThread();
      showToast('Email sent');
      loadStats();
    } catch (err) {
      $('#dealMsg').textContent = err.message;
      showToast(err.message, 7000);
    } finally {
      btn.disabled = false; btn.textContent = label;
    }
  });

  $('#dealStatus').addEventListener('change', async () => {
    if (!currentDeal) return;
    const status = $('#dealStatus').value;
    const body = { status };
    if (status === 'closed') {
      const p = prompt('Agreed price? (number)', currentDeal.agreedPrice || '');
      if (p === null) { $('#dealStatus').value = currentDeal.status; return; }
      body.agreedPrice = parseFloat(p) || 0;
    }
    try {
      currentDeal = await api('/api/email/negotiations/' + encodeURIComponent(currentDeal.id), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      showToast('Status: ' + status);
      loadStats();
    } catch (err) {
      showToast(err.message);
      $('#dealStatus').value = currentDeal.status;
    }
  });

  // ── Deal autopilot ──
  function logDealAuto(msg, type = 'info') {
    const el = $('#dealAutopilotLog');
    el.style.display = 'block';
    const time = new Date().toLocaleTimeString();
    const entry = document.createElement('div');
    entry.className = 'log-entry';
    entry.innerHTML = `<span class="log-time">[${time}]</span> <span class="log-${type}">${esc(msg)}</span>`;
    el.appendChild(entry);
    el.scrollTop = el.scrollHeight;
  }

  async function runDealAutopilotOnce() {
    logDealAuto('Checking inbox for replies…', 'info');
    $('#dealAutopilotStatus').textContent = 'Checking inbox…';
    try {
      const data = await api('/api/email/autopilot/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      (data.errors || []).forEach(e => logDealAuto(`Inbox read failed for ${e.sender}: ${e.error}`, 'error'));
      const results = data.results || [];
      const acts = data.actions || [];
      if (!acts.length && !results.length && !(data.errors || []).length) {
        logDealAuto('No new replies.', 'info');
      }
      results.forEach(r => {
        if (r.status === 'replied') {
          logDealAuto(`${r.email} said: "${(r.creatorSaid || '').slice(0, 60)}…"`, 'info');
          logDealAuto(`AI replied to ${r.email}`, 'action');
        } else if (r.status === 'ai_failed') {
          logDealAuto(`AI failed for ${r.email}: ${r.error}`, 'error');
        } else if (r.status === 'send_failed') {
          logDealAuto(`Send failed for ${r.email}: ${r.error || 'unknown'}`, 'error');
        } else if (r.status === 'skipped') {
          logDealAuto(`Skipped ${r.email}: ${r.reason || 'spam guard'}`, 'info');
        }
      });
      const replied = results.filter(r => r.status === 'replied').length;
      $('#dealAutopilotStatus').textContent = dealAutopilotOn
        ? `Handled ${replied} reply(s). Next check in ${DEAL_AUTOPILOT_MS / 1000}s…`
        : `Handled ${replied} reply(s).`;
      if (acts.length || replied) {
        loadDeals();
        loadStats();
        if (currentDeal) refreshCurrentDeal();
        if (replied) showToast(`Autopilot handled ${replied} reply(s)`);
      }
    } catch (err) {
      logDealAuto('Error: ' + err.message, 'error');
      $('#dealAutopilotStatus').textContent = 'Error: ' + err.message;
    }
  }

  function startDealAutopilot() {
    if (dealAutopilotOn) return;
    dealAutopilotOn = true;
    $('#dealAutopilotBar').classList.add('active');
    $('#dealAutopilotLabel').textContent = 'Autopilot ON';
    $('#btnDealAutopilotToggle').textContent = '⏸ Stop Autopilot';
    logDealAuto(`Autopilot started. Checking every ${DEAL_AUTOPILOT_MS / 1000}s…`, 'action');
    runDealAutopilotOnce();
    dealAutopilotTimer = setInterval(runDealAutopilotOnce, DEAL_AUTOPILOT_MS);
  }

  function stopDealAutopilot() {
    dealAutopilotOn = false;
    if (dealAutopilotTimer) clearInterval(dealAutopilotTimer);
    dealAutopilotTimer = null;
    $('#dealAutopilotBar').classList.remove('active');
    $('#dealAutopilotLabel').textContent = 'Autopilot Off';
    $('#btnDealAutopilotToggle').textContent = '▶ Start Autopilot';
    logDealAuto('Autopilot stopped.', 'info');
  }

  $('#btnDealAutopilotToggle').addEventListener('click', () =>
    dealAutopilotOn ? stopDealAutopilot() : startDealAutopilot());
  $('#btnDealAutopilotOnce').addEventListener('click', runDealAutopilotOnce);

  // ─── Init ───────────────────────────────────────────────
  (async function init() {
    try {
      await loadProviders();
      await loadSenders();
      await loadContacts();
      await loadTemplates();
      renderVarChips();
      await loadStats();
      fillCampaignSelects();
    } catch (err) {
      showToast('Could not load: ' + err.message, 6000);
    }
  })();
})();
