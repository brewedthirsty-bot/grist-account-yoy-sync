(function () {
  'use strict';
  const core = window.EventSync;
  const ids = 'listings newEvents changedEvents reviewCount sync preview auto status lastSync snapshotTime sources connection token remember connect forget reviewList reviewTitle'.split(' ');
  const el = Object.fromEntries(ids.map(id => [id, document.getElementById(id)]));
  const TOKEN_KEY = 'fdr-event-sync:github-read-token:v1';
  const INTERVAL = 30 * 60 * 1000;
  let busy = false, initialized = false, access = false, preview = null;
  let options = {}, lastAttempt = 0, preferencesKey = '';
  let token = '';
  try { token = localStorage.getItem(TOKEN_KEY) || ''; } catch (_) { /* Storage may be disabled. */ }
  el.token.value = token; el.remember.checked = Boolean(token);
  function status(message, kind = '') { el.status.textContent = message; el.status.className = `status ${kind}`; }
  function localTime(s) {
    if (!s) return 'Never';
    return new Intl.DateTimeFormat('en-US', {timeZone: 'America/Indiana/Indianapolis', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short'}).format(new Date(s));
  }
  function buttons() {
    el.sync.disabled = busy || !access || !preview || !token;
    el.preview.disabled = busy || !access || !token;
    el.connect.disabled = busy || !access;
    el.forget.disabled = busy;
    el.auto.disabled = busy;
    el.token.disabled = busy; el.remember.disabled = busy;
  }
  function lastSyncLabel() {
    el.lastSync.textContent = options.lastVerifiedSyncUTC ? `Last verified Grist sync: ${localTime(options.lastVerifiedSyncUTC)} · Collector snapshot: ${localTime(options.lastSnapshotCheckedUTC)}` : 'No verified sync yet. Connect, review the preview, then click Sync events.';
  }
  async function saveOptions(patch) {
    options = {...options, ...patch};
    // Per-document device preferences persist without Grist's separate Save-options click.
    // The token has its own opt-in storage key and is never placed in this object.
    if (!preferencesKey) throw new Error('Document preferences are not ready.');
    localStorage.setItem(preferencesKey, JSON.stringify(options));
  }
  function paint(snapshot, plan) {
    preview = {snapshot, plan};
    const events = plan.tables.find(t => t.table === 'Events');
    el.listings.textContent = snapshot.events.length.toLocaleString();
    el.newEvents.textContent = events.added.toLocaleString();
    el.changedEvents.textContent = events.updated.toLocaleString();
    const review = snapshot.events.filter(e => e.Review_Required === 'True');
    el.reviewCount.textContent = review.length.toLocaleString();
    el.snapshotTime.textContent = `Collector snapshot: ${localTime(snapshot.checkedUTC)}`;
    el.sources.replaceChildren();
    const labels = {'source:fishers_city_amp': 'AMP · City calendar', 'source:amp_ticketmaster': 'AMP · Ticketmaster', 'source:fec_ticketmaster': 'Fishers Event Center', 'source:ruoff_official': 'Ruoff Music Center'};
    for (const source of snapshot.checks) {
      const row = document.createElement('tr');
      const old = !source.Last_Checked_UTC || Date.now() - Date.parse(source.Last_Checked_UTC) > 36 * 3600000;
      const failed = source.Latest_Check_Status !== 'Success';
      const state = failed ? 'Failed · older data' : old ? 'Stale' : 'Success';
      const values = [labels[source.Source_Key] || source.Venue, state, source.Events_Returned, localTime(source.Last_Checked_UTC)];
      values.forEach((v, i) => {
        const td = document.createElement('td'); td.textContent = v;
        if (i === 1) td.className = failed || old ? 'failed' : 'success';
        if (i === 0) { const sub = document.createElement('small'); sub.textContent = source.Coverage; td.append(sub); }
        row.append(td);
      });
      el.sources.append(row);
    }
    el.reviewTitle.textContent = `Listings needing review (${review.length})`;
    el.reviewList.replaceChildren();
    for (const event of review) {
      const li = document.createElement('li');
      li.textContent = `${event.Event_Date} · ${event.Venue} · ${event.Event_Name}: ${event.Source_Review_Note || 'Check this listing.'}`;
      el.reviewList.append(li);
    }
    buttons();
  }
  function previewText(plan) {
    const lines = plan.tables.map(t => `${t.table}: ${t.added} new, ${t.updated} changed, ${t.unchanged} already match.`);
    if (plan.addsReviewColumn) lines.push('First sync adds Source_Review_Note for refreshed collector notes. Your existing Review_Note is preserved.');
    return lines.join('\n');
  }
  async function run(write) {
    if (busy || !access) return;
    if (!token) { el.connection.open = true; status('Paste your GitHub read token in Connection settings.', 'warn'); return; }
    busy = true; lastAttempt = Date.now(); buttons();
    status(write ? 'Checking GitHub and Grist before syncing…' : 'Loading the latest GitHub snapshot…');
    try {
      const work = async () => {
        const snapshot = await core.loadSnapshot(token);
        const plan = core.planSync(snapshot, await core.readDocument(grist.docApi));
        paint(snapshot, plan);
        if (!write) {
          status([previewText(plan), ...plan.warnings].join('\n\n'), plan.warnings.length ? 'warn' : 'ok');
          return;
        }
        status('Saving event updates and verifying Grist…');
        const result = await core.syncSnapshot(grist.docApi, snapshot);
        paint(snapshot, result.after);
        const totalNew = result.before.tables.reduce((n, t) => n + t.added, 0);
        const totalChanged = result.before.tables.reduce((n, t) => n + t.updated, 0);
        let settingsWarning = '';
        try { await saveOptions({enabled: true, auto: el.auto.checked, lastVerifiedSyncUTC: new Date().toISOString(), lastSnapshotCheckedUTC: snapshot.checkedUTC, lastSnapshotSHA: snapshot.sha}); }
        catch (_) { settingsWarning = 'Grist verified the data, but this browser could not remember auto-sync preferences.'; }
        lastSyncLabel();
        status([`Grist verified the snapshot: ${totalNew} rows added, ${totalChanged} updated.`, ...result.after.warnings, settingsWarning].filter(Boolean).join('\n\n'), result.after.warnings.length || settingsWarning ? 'warn' : 'ok');
      };
      // Same-origin tabs serialize their syncs. Grist matches each key inside its
      // transaction as well, so a concurrent tab cannot blindly add it again.
      if (navigator.locks) await navigator.locks.request('fdr-event-sync-v1', work);
      else await work();
    } catch (err) {
      preview = null;
      status(`${write ? 'Sync stopped' : 'Could not prepare sync'}: ${err.message || String(err)}\nRefresh the preview before retrying.`, 'error');
    } finally { busy = false; buttons(); }
  }
  el.connect.addEventListener('click', async () => {
    token = el.token.value.trim(); preview = null;
    if (!token) { status('Paste a GitHub read token first.', 'warn'); buttons(); return; }
    let storageWarning = '';
    try { if (el.remember.checked) localStorage.setItem(TOKEN_KEY, token); else localStorage.removeItem(TOKEN_KEY); }
    catch (_) { storageWarning = 'This browser could not remember the token. It is available for this session.'; }
    await run(false);
    if (preview) el.connection.open = false;
    if (storageWarning) status(el.status.textContent + '\n\n' + storageWarning, 'warn');
  });
  el.forget.addEventListener('click', () => {
    token = ''; el.token.value = ''; el.remember.checked = false; preview = null;
    try { localStorage.removeItem(TOKEN_KEY); } catch (_) { /* No saved token. */ }
    el.connection.open = true; status('Token forgotten. Add a read token to reconnect.', 'warn'); buttons();
  });
  el.auto.addEventListener('change', async () => {
    try { await saveOptions({auto: el.auto.checked}); }
    catch (_) { status('This browser could not remember the auto-sync setting.', 'error'); }
  });
  el.preview.addEventListener('click', () => run(false));
  el.sync.addEventListener('click', () => run(true));
  function autoCheck() {
    if (initialized && options.enabled && el.auto.checked && access && token && !document.hidden && Date.now() - lastAttempt >= INTERVAL) run(true);
  }
  setInterval(autoCheck, 60000);
  document.addEventListener('visibilitychange', autoCheck);
  window.addEventListener('focus', autoCheck);
  if (!window.grist) { status('The Grist plugin API could not load. Check your internet connection and reload this page.', 'error'); buttons(); return; }
  grist.onOptions((saved, interaction) => {
    access = (interaction?.access_level || interaction?.accessLevel) === 'full';
    lastSyncLabel(); buttons();
    if (!access) { status('In the Grist widget settings, grant Full document access to connect Events and Venues.', 'warn'); return; }
    if (!initialized) {
      initialized = true;
      (async () => {
        preferencesKey = `fdr-event-sync:prefs:v1:${await grist.docApi.getDocName()}`;
        try { options = JSON.parse(localStorage.getItem(preferencesKey) || '{}') || {}; } catch (_) { options = {}; }
        if (typeof options !== 'object' || Array.isArray(options)) options = {};
        for (const k of ['lastVerifiedSyncUTC', 'lastSnapshotCheckedUTC']) if (options[k] && !Number.isFinite(Date.parse(options[k]))) delete options[k];
        el.auto.checked = options.auto !== false; lastSyncLabel(); buttons();
        if (token) { el.connection.open = false; run(Boolean(options.enabled && el.auto.checked && !document.hidden)); }
        else status('Connect to GitHub below, review the preview, then click Sync events.', 'warn');
      })().catch(() => { initialized = false; status('Could not identify the Grist document. Reload this widget after granting Full document access.', 'error'); });
    }
  });
  grist.ready({requiredAccess: 'full'});
  buttons();
  if (window.parent === window) status('Add this URL as a Custom widget in FDR Restaurant Sales, then grant Full document access.', 'warn');
})();
