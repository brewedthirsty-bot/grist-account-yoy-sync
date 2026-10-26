/* Public city-calendar collection from the Grist widget. No GitHub token is used here. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./core.js'));
  else root.EventDesktop = factory(root.EventSync);
})(typeof globalThis === 'object' ? globalThis : this, function (core) {
  'use strict';
  const assert = (ok, message) => {if (!ok) throw new Error(message);};
  const STAMPS = new Set(['Start_ISO','End_ISO','First_Seen_UTC','Last_Seen_UTC','Last_Checked_UTC','Last_Attempt_UTC']);
  const DATES = new Set(['Event_Date','Earliest_Returned_Date','Latest_Returned_Date']);
  const FLAGS = new Set(['Currently_Listed','Review_Required']);
  function scalar(value, field) {
    if (Array.isArray(value) && ['d','D'].includes(value[0])) value = value[1];
    if (value instanceof Date) value = value.getTime() / 1000;
    if (value == null) return '';
    if (typeof value === 'number' && (STAMPS.has(field) || DATES.has(field))) {
      const text = new Date(value * 1000).toISOString(); return DATES.has(field) ? text.slice(0,10) : text;
    }
    if (FLAGS.has(field) && typeof value === 'boolean') return value ? 'True' : 'False';
    assert(['string','number','boolean'].includes(typeof value), `Invalid existing ${field} value in Grist.`);
    return String(value);
  }
  function plainRow(row, fields) {return Object.fromEntries(fields.map(f => [f, scalar(row[f], f)]));}
  function clean(text) {
    const names = {amp:'&',quot:'"',apos:"'",lt:'<',gt:'>',nbsp:' ',ndash:'–',mdash:'—',rsquo:'’',lsquo:'‘',hellip:'…'};
    return String(text || '').replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, key) => {
      if (key[0] !== '#') return names[key.toLowerCase()] ?? all;
      const code = key[1].toLowerCase() === 'x' ? parseInt(key.slice(2),16) : Number(key.slice(1));
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : all;
    }).trim();
  }
  function localParts(ms, timezone) {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', {timeZone: timezone, year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).formatToParts(new Date(ms)).map(p => [p.type,p.value]));
    return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}`;
  }
  function localISO(local, utc, timezone) {
    assert(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(local || ''), 'The city calendar has an invalid local timestamp.');
    const naive = local.replace(' ','T'), seconds = core.stampSeconds(String(utc || '').replace(' ','T') + 'Z');
    assert(localParts(seconds * 1000, timezone) === naive, 'City local and UTC event times disagree.');
    const offset = (Date.parse(naive + 'Z') - seconds * 1000) / 60000;
    assert(Number.isInteger(offset) && Math.abs(offset) <= 14 * 60, 'Invalid city timezone offset.');
    const abs = Math.abs(offset);
    return naive + (offset < 0 ? '-' : '+') + String(Math.floor(abs / 60)).padStart(2,'0') + ':' + String(abs % 60).padStart(2,'0');
  }
  async function stableKey(source, id) {
    if (source.event_key_aliases?.[id]) return source.event_key_aliases[id];
    const bytes = new TextEncoder().encode(source.source_key + '\0' + id);
    const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
    return 'event:' + [...new Uint8Array(digest)].slice(0,16).map(n => n.toString(16).padStart(2,'0')).join('');
  }
  async function parseCityEvent(raw, source) {
    assert(raw && /^\d+$/.test(String(raw.id)) && clean(raw.title), 'The city calendar returned an event without a valid ID or title.');
    const venues = Array.isArray(raw.venue) ? raw.venue : [raw.venue];
    assert(venues.some(v => v && String(v.id) === source.venue_id), 'The city calendar ignored the requested AMP venue.');
    assert(raw.status === 'publish', 'The city calendar returned an unpublished listing.');
    assert(typeof raw.all_day === 'boolean', 'City event all-day status changed format.');
    const name = clean(raw.title), day = String(raw.start_date || '').slice(0,10);
    core.dateSeconds(day);
    const stamp = raw.all_day ? '' : localISO(raw.start_date, raw.utc_start_date, source.timezone);
    const end = raw.end_date ? localISO(raw.end_date, raw.utc_end_date, source.timezone) : '';
    const url = new URL(raw.url);
    assert(url.protocol === 'https:' && url.hostname === 'fishersin.gov' && url.pathname.startsWith('/event/'), 'Unexpected city event URL.');
    assert(Array.isArray(raw.categories), 'City event categories changed format.');
    const categories = raw.categories.map(c => clean(c.name));
    const status = /\bcancell?ed\b/i.test(name) ? 'Cancelled' : /\bpostponed\b/i.test(name) ? 'Postponed' : 'Listed';
    return {Event_Key:await stableKey(source,String(raw.id)),Venue_Key:source.key,Venue:source.name,Event_Name:name,
      Event_Date:day,Start_Time:stamp ? stamp.slice(11,16) : '',Start_ISO:stamp,End_ISO:end,
      Event_Type:categories.some(c => c.toLowerCase() === 'concert') ? 'Concert' : categories.join(' | '),
      Event_Status:status,Source_Status:'Publication status=' + raw.status,Source_Key:source.source_key,
      Source_Event_ID:'source-id:' + raw.id,Source_URL:url.href,First_Seen_UTC:'',Last_Seen_UTC:'',
      Currently_Listed:'True',Review_Required:status === 'Listed' ? 'False' : 'True',Review_Note:'',Source_Review_Note:''};
  }
  async function loadCity(source, start, end, fetcher = fetch) {
    core.dateSeconds(start); core.dateSeconds(end);
    assert(source.source_url === 'https://fishersin.gov/wp-json/tribe/events/v1/events/', 'Unsupported public calendar URL.');
    const rows = [], ids = new Set(); let expected = null, pages = null, page = 1;
    do {
      const url = new URL(source.source_url);
      url.search = new URLSearchParams({start_date:start,end_date:end,per_page:'50',page:String(page),venue:source.venue_id});
      const controller = new AbortController(), timer = setTimeout(() => controller.abort(),30000);
      let data;
      try {
        // This is the city's advertised public REST API and normal browser CORS.
        // No Authorization header, cookies, proxy or browser-identity override.
        const response = await fetcher(url.href, {method:'GET',mode:'cors',credentials:'omit',redirect:'error',cache:'no-store',signal:controller.signal,headers:{Accept:'application/json'}});
        assert(response.ok, `City calendar returned HTTP ${response.status} on this computer.`);
        const text = await response.text(); assert(text.length < 12000000, 'City calendar response exceeded the size limit.');
        data = JSON.parse(text);
      } catch (error) {
        if (error.name === 'AbortError') throw new Error('City calendar timed out on this computer.');
        if (error instanceof TypeError) throw new Error('City calendar could not be reached from this computer.');
        throw error;
      } finally {clearTimeout(timer);}
      assert(Array.isArray(data.events) && Number.isSafeInteger(data.total) && data.total >= 0 && data.total <= 5000 && Number.isSafeInteger(data.total_pages) && data.total_pages >= 0 && data.total_pages <= 100, 'City calendar pagination changed format.');
      if (expected === null) {expected = data.total; pages = data.total_pages;}
      assert(data.total === expected && data.total_pages === pages && data.events.length <= 50, 'City calendar totals changed during collection. Retry for a consistent snapshot.');
      for (const raw of data.events) {
        const id = String(raw.id); assert(!ids.has(id), 'City calendar returned a duplicate ID or repeated page.'); ids.add(id);
        const row = await parseCityEvent(raw,source);
        assert(row.Event_Date >= start && row.Event_Date <= end, 'City calendar ignored the requested dates.');
        rows.push(row);
      }
      page++;
    } while (page <= pages);
    assert(rows.length === expected, 'City calendar did not return all advertised records.');
    return {rows,pages:Math.max(1,pages)};
  }
  function flagDuplicates(rows) {
    const groups = new Map(), note = 'Possible duplicate: another listing has the same venue, date, time and title. Verify before counting events.';
    for (const r of rows) {
      const key = JSON.stringify([r.Venue_Key,r.Event_Date,r.Start_Time,clean(r.Event_Name).toLowerCase().replace(/\s+/g,' ')]);
      if (!groups.has(key)) groups.set(key,[]); groups.get(key).push(r);
    }
    for (const group of groups.values()) if (group.length > 1) for (const row of group) {
      row.Review_Required = 'True';
      if (!row.Source_Review_Note.includes(note)) row.Source_Review_Note = [row.Source_Review_Note,note].filter(Boolean).join(' ');
    }
    return rows;
  }
  function mergeCity(history, incoming, source, checked) {
    const merged = new Map(history.map(r => [r.Event_Key,{...r}])), current = new Set(incoming.map(r => r.Event_Key));
    const today = localParts(Date.parse(checked),source.timezone).slice(0,10);
    for (const row of merged.values()) if (!current.has(row.Event_Key)) {
      row.Currently_Listed = 'False';
      if (row.Event_Date >= today) {
        row.Review_Required = 'True'; row.Source_Review_Note = 'Previously listed future event is absent from the latest source snapshot. Verify its status.';
      }
    }
    for (const original of incoming) {
      const previous = merged.get(original.Event_Key), row = {...original};
      row.First_Seen_UTC = previous?.First_Seen_UTC || checked; row.Last_Seen_UTC = checked;
      if (previous && (row.Event_Date !== previous.Event_Date || row.Start_Time !== previous.Start_Time)) {
        row.Review_Required = 'True'; row.Source_Review_Note = 'Published date or time changed from ' + previous.Event_Date + ' ' + previous.Start_Time;
      } else if (previous?.Source_Review_Note?.startsWith('Published date or time changed')) {
        row.Review_Required = 'True'; row.Source_Review_Note = previous.Source_Review_Note;
      }
      merged.set(row.Event_Key,row);
    }
    return flagDuplicates([...merged.values()]);
  }
  async function refreshDesktopSources(snapshot, doc, fetcher = fetch, now = Date.now()) {
    if (!snapshot.desktopSources?.length) return snapshot;
    const next = {...snapshot,events:snapshot.events.map(r => ({...r})),checks:snapshot.checks.map(r => ({...r})),
      warnings:[...snapshot.warnings],skipSources:new Set(snapshot.skipSources),desktopResults:{}};
    const checked = new Date(now).toISOString();
    for (const source of snapshot.desktopSources) {
      const key = source.source_key;
      const repoRows = next.events.filter(r => r.Source_Key === key), history = new Map(repoRows.map(r => [r.Event_Key,r]));
      // Local city history is authoritative after the first direct check. The
      // older GitHub setup snapshot cannot overwrite locally refreshed records.
      const localRows = (doc.data.Events || []).filter(r => r.Source_Key === key);
      core.unique(localRows,'Event_Key','Grist city events');
      for (const raw of localRows) {
        const row = plainRow(raw,core.EVENT_FIELDS.filter(f => f !== 'Review_Note').concat('Source_Review_Note'));
        const prior = history.get(row.Event_Key);
        if (!Object.hasOwn(raw,'Source_Review_Note')) row.Source_Review_Note = prior?.Source_Review_Note || '';
        if (!prior || Date.parse(row.Last_Seen_UTC || 0) >= Date.parse(prior.Last_Seen_UTC || 0)) history.set(row.Event_Key,row);
      }
      const index = next.checks.findIndex(c => c.Source_Key === key), base = next.checks[index];
      assert(base, 'Missing city source check.');
      const localCheck = (doc.data.Source_Checks || []).find(r => r.Source_Key === key);
      const previousCheck = localCheck ? plainRow(localCheck,core.CHECK_FIELDS) : {...base};
      if (!localCheck) {
        const last = [...history.values()].map(r => r.Last_Seen_UTC).filter(Boolean).sort((a,b) => Date.parse(b)-Date.parse(a))[0];
        if (last && Date.parse(last) > Date.parse(previousCheck.Last_Checked_UTC || 0)) previousCheck.Last_Checked_UTC = last;
      }
      next.events = next.events.filter(r => r.Source_Key !== key).concat([...history.values()]);
      try {
        const result = await loadCity(source,snapshot.report.start,snapshot.report.end,fetcher);
        const merged = mergeCity([...history.values()],result.rows,source,checked);
        next.events = next.events.filter(r => r.Source_Key !== key).concat(merged);
        next.checks[index] = {...base,Last_Checked_UTC:checked,Last_Attempt_UTC:checked,Latest_Check_Status:'Success',Latest_Error:'',
          Events_Returned:String(result.rows.length),Excluded_Offers:'0',Pages_Checked:String(result.pages),
          Earliest_Returned_Date:result.rows.map(r => r.Event_Date).sort()[0] || '',Latest_Returned_Date:result.rows.map(r => r.Event_Date).sort().at(-1) || ''};
        next.skipSources.delete(key); next.desktopResults[key] = {success:true,checkedUTC:checked,events:result.rows.length};
      } catch (error) {
        next.checks[index] = {...previousCheck,Source_Key:key,Venue:source.name,Coverage:base.Coverage,Source_URL:base.Source_URL,
          Last_Attempt_UTC:checked,Latest_Check_Status:'Failed',Latest_Error:error.message || String(error)};
        for (const f of ['Events_Returned','Excluded_Offers','Pages_Checked']) if (!next.checks[index][f]) next.checks[index][f] = '0';
        next.desktopResults[key] = {success:false,checkedUTC:checked,error:next.checks[index].Latest_Error};
        next.warnings.push(`${source.name}: ${next.checks[index].Latest_Error} Existing Grist city events were retained. Last successful check: ${next.checks[index].Last_Checked_UTC || 'never'}.`);
      }
    }
    core.unique(next.events,'Event_Key','Combined event snapshot');
    return next;
  }
  return {clean,scalar,localISO,stableKey,parseCityEvent,loadCity,mergeCity,refreshDesktopSources};
});
