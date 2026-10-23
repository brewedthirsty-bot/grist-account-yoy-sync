/* Event Sync: source validation and key-based Grist writes. No credentials here. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.EventSync = factory();
})(typeof globalThis === 'object' ? globalThis : this, function () {
  'use strict';
  const REPO = 'brewedthirsty-bot/fdr-event-calendar';
  const EVENT_FIELDS = 'Event_Key Venue_Key Venue Event_Name Event_Date Start_Time Start_ISO End_ISO Event_Type Event_Status Source_Status Source_Key Source_Event_ID Source_URL First_Seen_UTC Last_Seen_UTC Currently_Listed Review_Required Review_Note'.split(' ');
  const VENUE_FIELDS = 'Venue_Key Venue Website Source_Key Source_URL'.split(' ');
  const CHECK_FIELDS = 'Source_Key Venue Last_Checked_UTC Events_Returned Excluded_Offers Pages_Checked Earliest_Returned_Date Latest_Returned_Date Coverage Source_URL Last_Attempt_UTC Latest_Check_Status Latest_Error'.split(' ');
  const SPECS = [
    {table: 'Venues', key: 'Venue_Key', fields: VENUE_FIELDS},
    {table: 'Events', key: 'Event_Key', fields: EVENT_FIELDS.filter(f => f !== 'Review_Note').concat('Source_Review_Note')},
    {table: 'Source_Checks', key: 'Source_Key', fields: CHECK_FIELDS, optional: true}
  ];
  const DATE_FIELDS = new Set(['Event_Date', 'Earliest_Returned_Date', 'Latest_Returned_Date']);
  const STAMP_FIELDS = new Set(['Start_ISO', 'End_ISO', 'First_Seen_UTC', 'Last_Seen_UTC', 'Last_Checked_UTC', 'Last_Attempt_UTC']);
  const BOOL_FIELDS = new Set(['Currently_Listed', 'Review_Required']);
  const INT_FIELDS = new Set(['Events_Returned', 'Excluded_Offers', 'Pages_Checked']);
  const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
  function assert(ok, message) { if (!ok) throw new Error(message); }

  function parseCSV(input, expected) {
    assert(typeof input === 'string', 'Expected CSV text.');
    const s = input.replace(/^\uFEFF/, '');
    const rows = []; let row = [], cell = '', quoted = false, closed = false;
    function pushCell() { row.push(cell); cell = ''; closed = false; }
    function pushRow() { pushCell(); rows.push(row); row = []; }
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (quoted) {
        if (c === '"') { if (s[i + 1] === '"') { cell += '"'; i++; } else { quoted = false; closed = true; } }
        else cell += c;
      } else if (c === '"') {
        assert(!cell && !closed, 'Invalid quote in CSV.'); quoted = true;
      } else if (c === ',') pushCell();
      else if (c === '\n' || c === '\r') { if (c === '\r' && s[i + 1] === '\n') i++; pushRow(); }
      else { assert(!closed, 'Unexpected characters after a CSV quote.'); cell += c; }
    }
    assert(!quoted, 'Unclosed CSV quote.');
    if (cell || row.length || closed) pushRow();
    const header = rows.shift() || [];
    assert(header.length === expected.length && header.every((v, i) => v === expected[i]), 'The collector CSV columns changed. Update this widget before syncing.');
    return rows.filter(values => !(values.length === 1 && values[0] === '')).map((values, i) => {
      assert(values.length === header.length, `CSV row ${i + 2} has the wrong number of fields.`);
      return Object.fromEntries(header.map((h, j) => [h, values[j]]));
    });
  }

  function dateSeconds(s) {
    assert(/^\d{4}-\d{2}-\d{2}$/.test(s), `Invalid date: ${s}`);
    const n = Date.parse(s + 'T00:00:00Z');
    assert(Number.isFinite(n) && new Date(n).toISOString().slice(0, 10) === s, `Invalid date: ${s}`);
    return n / 1000;
  }
  function stampSeconds(s) {
    assert(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/.test(s), 'A source timestamp has no valid timezone.');
    dateSeconds(s.slice(0, 10));
    const n = Date.parse(s);
    assert(Number.isFinite(n) && Number(s.slice(11, 13)) < 24 && Number(s.slice(14, 16)) < 60 && (!s.slice(16).startsWith(':') || Number(s.slice(17, 19)) < 60), 'Invalid source timestamp.');
    return n / 1000;
  }
  function unique(rows, field, label) {
    const map = new Map();
    for (const row of rows) {
      const key = row[field];
      assert(typeof key === 'string' && key.trim() === key && key.length > 0, `${label} has a blank or invalid ${field}.`);
      assert(!map.has(key), `${label} has duplicate ${field}: ${key}. Review duplicates before syncing.`);
      map.set(key, row);
    }
    return map;
  }
  function validateSnapshot(files, sha, now = Date.now()) {
    assert(/^[a-f0-9]{40}$/.test(sha), 'Invalid GitHub snapshot ID.');
    const venues = parseCSV(files['Venues.csv'], VENUE_FIELDS);
    const events = parseCSV(files['Events.csv'], EVENT_FIELDS);
    const checks = parseCSV(files['Source_Checks.csv'], CHECK_FIELDS);
    let report; try { report = JSON.parse(files['run_report.json']); } catch { throw new Error('Invalid collector report.'); }
    const venueMap = unique(venues, 'Venue_Key', 'GitHub Venues');
    const eventMap = unique(events, 'Event_Key', 'GitHub Events');
    const checkMap = unique(checks, 'Source_Key', 'GitHub Source_Checks');
    assert(venues.length === 3 && checks.length >= 3, 'The event snapshot is missing venues or source checks.');
    assert(Number.isSafeInteger(report.history_events) && report.history_events === events.length, 'The event count does not match the collector report.');
    assert(Array.isArray(report.sources) && report.sources.length === checks.length && typeof report.success === 'boolean', 'Incomplete collector report.');
    unique(report.sources, 'source_key', 'Collector report');
    const checked = stampSeconds(report.checked_utc) * 1000;
    assert(checked <= now + 300000, 'The collector report is dated in the future.');
    let failed = 0;
    for (const s of report.sources) {
      assert(typeof s.success === 'boolean' && checkMap.has(s.source_key), 'Source report and checks do not match.');
      const check = checkMap.get(s.source_key);
      assert((check.Latest_Check_Status === 'Success') === s.success && (s.success || check.Latest_Check_Status === 'Failed'), 'Source status does not match the collector report.');
      assert(stampSeconds(check.Last_Attempt_UTC) * 1000 === checked, 'Source attempts are from a different collector run.');
      if (!s.success) failed++;
    }
    assert(report.failed_sources === failed && report.success === (failed === 0), 'Inconsistent collector success status.');
    for (const v of venues) {
      assert(v.Venue_Key.startsWith('venue:') && v.Venue && checkMap.has(v.Source_Key), 'Invalid venue record.');
    }
    for (const e of events) {
      assert(e.Event_Key.startsWith('event:') && venueMap.has(e.Venue_Key) && checkMap.has(e.Source_Key) && e.Source_Event_ID.startsWith('source-id:') && e.Event_Name, 'An event has an unknown venue, source, or ID.');
      dateSeconds(e.Event_Date);
      assert(!e.Start_Time || /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(e.Start_Time), 'Invalid event start time.');
      for (const f of STAMP_FIELDS) if (own(e, f) && e[f]) stampSeconds(e[f]);
      for (const f of BOOL_FIELDS) assert(e[f] === 'True' || e[f] === 'False', `Invalid event ${f}.`);
      // Imported Review_Note is preserved for local edits; refresh source notes separately.
      e.Source_Review_Note = e.Review_Note;
    }
    for (const c of checks) {
      for (const f of INT_FIELDS) assert(/^\d+$/.test(c[f]) && Number.isSafeInteger(Number(c[f])), 'Invalid source count.');
      for (const f of ['Earliest_Returned_Date', 'Latest_Returned_Date']) if (c[f]) dateSeconds(c[f]);
      if (c.Last_Checked_UTC) assert(stampSeconds(c.Last_Checked_UTC) * 1000 <= checked, 'Source success is newer than its attempt.');
    }
    // A failed source retains its last known Currently_Listed flags. Only successful
    // sources contribute to current_events; retained flags do not prove freshness.
    assert(Number.isSafeInteger(report.current_events) && report.sources.filter(s => s.success).reduce((n, s) => n + s.included, 0) === report.current_events, 'The returned event count does not match the report.');
    const warnings = [];
    if (now - checked > 36 * 3600000) warnings.push('The collector snapshot is over 36 hours old.');
    for (const c of checks) if (c.Latest_Check_Status !== 'Success') warnings.push(`${c.Venue}: ${c.Latest_Error || 'source check failed'}. Last successful check: ${c.Last_Checked_UTC || 'never'}.`);
    return {sha, checkedUTC: report.checked_utc, venues, events, checks, report, warnings, eventMap};
  }

  async function loadSnapshot(token, fetcher = fetch, now = Date.now()) {
    assert(typeof token === 'string' && token.trim(), 'Enter a GitHub read token in Connection settings.');
    const base = `https://api.github.com/repos/${REPO}`;
    async function get(path, raw = false) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 30000);
      try {
        const r = await fetcher(base + path, {method: 'GET', mode: 'cors', cache: 'no-store', credentials: 'omit', redirect: 'error', signal: controller.signal,
          headers: {Authorization: `Bearer ${token.trim()}`, Accept: raw ? 'application/vnd.github.raw+json' : 'application/vnd.github+json', 'X-GitHub-Api-Version': '2026-03-10'}});
        if (!r.ok) {
          const messages = {401: 'The GitHub token is invalid or expired.', 403: 'GitHub denied access or the API limit was reached. Check Contents: read access for fdr-event-calendar.', 404: 'GitHub could not read the private event repository. Check the selected repository and Contents: read permission.'};
          throw new Error(messages[r.status] || `GitHub returned HTTP ${r.status}.`);
        }
        const text = await r.text();
        assert(text.length < 12000000, 'The event snapshot exceeds this widget’s size limit.');
        return raw ? text : JSON.parse(text);
      } catch (err) {
        if (err.name === 'AbortError') throw new Error('GitHub timed out. Try again.');
        if (err instanceof TypeError) throw new Error('Could not connect to GitHub. Check your internet connection.');
        throw err;
      } finally { clearTimeout(timer); }
    }
    const branch = await get('/branches/main');
    const sha = branch.commit?.sha;
    assert(typeof sha === 'string' && /^[a-f0-9]{40}$/.test(sha), 'GitHub did not return a valid commit.');
    const names = ['Venues.csv', 'Events.csv', 'Source_Checks.csv', 'run_report.json'];
    const data = await Promise.all(names.map(name => get(`/contents/data/${name}?ref=${sha}`, true)));
    return validateSnapshot(Object.fromEntries(names.map((n, i) => [n, data[i]])), sha, now);
  }

  function tableRows(table) {
    assert(table && Array.isArray(table.id), 'Grist returned an invalid table.');
    const fields = Object.keys(table);
    assert(fields.every(f => Array.isArray(table[f]) && table[f].length === table.id.length), 'Grist returned incomplete table data.');
    return table.id.map((_, i) => Object.fromEntries(fields.map(f => [f, table[f][i]])));
  }
  async function readDocument(api) {
    const tables = await api.listTables();
    for (const s of SPECS.filter(s => !s.optional)) assert(tables.includes(s.table), `Missing table ${s.table}. Add this widget to FDR Restaurant Sales with Events and Venues imported.`);
    const names = ['_grist_Tables', '_grist_Tables_column', ...SPECS.filter(s => tables.includes(s.table)).map(s => s.table)];
    if (tables.includes('Calendar')) names.push('Calendar');
    const values = await Promise.all(names.map(n => api.fetchTable(n)));
    return {tables, data: Object.fromEntries(names.map((n, i) => [n, tableRows(values[i])]))};
  }
  function allowedTypes(field) {
    if (DATE_FIELDS.has(field)) return ['Date', 'Text'];
    if (STAMP_FIELDS.has(field)) return ['Text', 'DateTime'];
    if (BOOL_FIELDS.has(field)) return ['Bool', 'Text'];
    if (INT_FIELDS.has(field)) return ['Int', 'Numeric', 'Text'];
    return ['Text'];
  }
  function convert(value, field, type) {
    if (type === 'Text') return value;
    if (!value) return type === 'Bool' ? false : null;
    if (type === 'Date') return dateSeconds(value);
    if (type.startsWith('DateTime')) return stampSeconds(value);
    if (type === 'Bool') return value === 'True';
    if (type === 'Int' || type === 'Numeric') return Number(value);
    throw new Error(`Unsupported type for ${field}.`);
  }
  function canonical(value, type) {
    if (Array.isArray(value) && ['d', 'D'].includes(value[0])) value = value[1];
    if (value instanceof Date) value = value.getTime() / 1000;
    if (value == null && type === 'Text') return '';
    return value;
  }
  function planSync(snapshot, doc) {
    const actions = [], tables = [], warnings = [...snapshot.warnings];
    const sourceData = {Venues: snapshot.venues, Events: snapshot.events, Source_Checks: snapshot.checks};
    for (const spec of SPECS) {
      if (!doc.tables.includes(spec.table) && spec.optional) continue;
      const tableMeta = doc.data._grist_Tables.find(t => t.tableId === spec.table);
      assert(tableMeta && !tableMeta.summarySourceTable, `${spec.table} must be a regular data table.`);
      const columns = new Map(doc.data._grist_Tables_column.filter(c => c.parentId === tableMeta.id).map(c => [c.colId, c]));
      if (spec.table === 'Events' && !columns.has('Source_Review_Note')) {
        columns.set('Source_Review_Note', {colId: 'Source_Review_Note', type: 'Text', isFormula: false, formula: ''});
        actions.push(['AddColumn', 'Events', 'Source_Review_Note', {type: 'Text', isFormula: false, label: 'Source Review Note'}]);
      }
      for (const f of spec.fields) {
        const col = columns.get(f);
        assert(col, `Missing column ${spec.table}.${f}. Restore the original column ID before syncing.`);
        assert(!col.isFormula && !col.formula, `${spec.table}.${f} contains a formula. Sync paused to protect it.`);
        assert(allowedTypes(f).includes(col.type.split(':')[0]), `${spec.table}.${f} is ${col.type}. Change it to ${allowedTypes(f).join(' or ')} before syncing.`);
        if (f === 'Event_Date' && col.type === 'Text') warnings.push('Events.Event_Date is Text. Convert it to Date to link events to Calendar.');
      }
      const existing = unique(doc.data[spec.table], spec.key, `Grist ${spec.table}`);
      let added = 0, updated = 0, unchanged = 0, retained = 0;
      const newKeys = new Set();
      for (const row of sourceData[spec.table]) {
        const key = row[spec.key]; newKeys.add(key);
        const previous = existing.get(key), values = {};
        let changed = !previous;
        for (const f of spec.fields) {
          const type = columns.get(f).type;
          values[f] = convert(row[f], f, type);
          if (previous && canonical(previous[f], type) !== values[f]) changed = true;
        }
        if (!changed) { unchanged++; continue; }
        if (previous) updated++; else added++;
        delete values[spec.key];
        // Matching happens inside Grist's transaction, protecting against concurrent adds.
        // Never update an arbitrary row if another client created duplicate keys.
        actions.push(['AddOrUpdateRecord', spec.table, {[spec.key]: key}, values, {on_many: 'none'}]);
      }
      for (const k of existing.keys()) if (!newKeys.has(k)) retained++;
      if (retained) warnings.push(`${spec.table}: ${retained} local rows are absent from this snapshot and will be retained.`);
      tables.push({table: spec.table, added, updated, unchanged, retained, total: sourceData[spec.table].length});
    }
    const calendar = doc.data.Calendar;
    if (calendar && calendar.length && own(calendar[0], 'Date')) {
      const dates = new Set(calendar.map(r => {
        const d = canonical(r.Date, 'Date');
        if (typeof d === 'number') return new Date(d * 1000).toISOString().slice(0, 10);
        return typeof d === 'string' ? d : '';
      }));
      const missing = snapshot.events.filter(e => !dates.has(e.Event_Date)).length;
      if (missing) warnings.push(`${missing} event listings fall outside the dates in Calendar. Extend Calendar before comparing their sales.`);
    }
    return {actions, tables, warnings, addsReviewColumn: actions.some(a => a[0] === 'AddColumn')};
  }
  async function syncSnapshot(api, snapshot) {
    // Read again at write time; a preview is never used as a write plan.
    const before = planSync(snapshot, await readDocument(api));
    if (before.actions.length) await api.applyUserActions(before.actions);
    const after = planSync(snapshot, await readDocument(api));
    assert(!after.actions.length, 'Grist verification did not match the snapshot. Refresh the preview before retrying.');
    return {before, after};
  }
  return {REPO, SPECS, EVENT_FIELDS, VENUE_FIELDS, CHECK_FIELDS, parseCSV, dateSeconds, stampSeconds, unique, validateSnapshot, loadSnapshot, readDocument, planSync, syncSnapshot};
});
