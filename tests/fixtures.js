'use strict';
const core = require('../events/core.js');
const SHA = 'a'.repeat(40);
const NOW = Date.parse('2026-10-23T20:00:00Z');
const STAMP = '2026-10-23T19:35:33+00:00';
function csv(fields, rows) {
  const quote = v => /[",\r\n]/.test(String(v ?? '')) ? '"' + String(v).replaceAll('"', '""') + '"' : String(v ?? '');
  return '\uFEFF' + [fields, ...rows.map(r => fields.map(f => r[f] ?? ''))].map(r => r.map(quote).join(',')).join('\r\n') + '\r\n';
}
function fixture() {
  const venues = ['one', 'two', 'three'].map(n => ({Venue_Key: `venue:${n}`, Venue: n, Website: 'https://example.org', Source_Key: `source:${n}`, Source_URL: 'https://example.org/events'}));
  const events = venues.slice(0, 2).map((v, i) => ({...Object.fromEntries(core.EVENT_FIELDS.map(f => [f, ''])),
    Event_Key: `event:${i + 1}`, Venue_Key: v.Venue_Key, Venue: v.Venue, Event_Name: i ? 'Show Two' : 'A show, with "quotes"', Event_Date: '2026-10-23',
    Start_Time: '19:30', Start_ISO: '2026-10-23T19:30:00-04:00', Event_Type: 'Music', Event_Status: 'Listed', Source_Status: 'Published', Source_Key: v.Source_Key,
    Source_Event_ID: `source-id:${i + 1}`, Source_URL: 'https://example.org/events/' + i,
    First_Seen_UTC: STAMP, Last_Seen_UTC: STAMP, Currently_Listed: 'True', Review_Required: i ? 'True' : 'False', Review_Note: i ? 'Changed date.\nCheck listing.' : ''}));
  const checks = venues.map((v, i) => ({...Object.fromEntries(core.CHECK_FIELDS.map(f => [f, ''])), Source_Key: v.Source_Key, Venue: v.Venue, Last_Checked_UTC: i === 2 ? '2026-10-22T19:35:33+00:00' : STAMP,
    Events_Returned: i === 2 ? '0' : '1', Excluded_Offers: '0', Pages_Checked: '1', Earliest_Returned_Date: i === 2 ? '' : '2026-10-23', Latest_Returned_Date: i === 2 ? '' : '2026-10-23', Coverage: 'Published listings only.', Source_URL: 'https://example.org', Last_Attempt_UTC: STAMP, Latest_Check_Status: i === 2 ? 'Failed' : 'Success', Latest_Error: i === 2 ? 'HTTP 403' : ''}));
  const report = {checked_utc: STAMP, sources: venues.map((v, i) => ({source_key: v.Source_Key, venue: v.Venue, success: i !== 2, ...(i === 2 ? {error: 'HTTP 403'} : {included: 1})})), success: false, history_events: 2, current_events: 2, failed_sources: 1};
  const files = {'Venues.csv': csv(core.VENUE_FIELDS, venues), 'Events.csv': csv(core.EVENT_FIELDS, events), 'Source_Checks.csv': csv(core.CHECK_FIELDS, checks), 'run_report.json': JSON.stringify(report)};
  return {files, venues, events, checks, report};
}
function documentFixture(snapshot, {sourceChecks = false, empty = false, dateType = 'Date', stampType = 'Text', boolType = 'Bool'} = {}) {
  const tableNames = ['Venues', 'Events', ...(sourceChecks ? ['Source_Checks'] : []), 'Calendar', 'Daily_Sales'];
  const data = {_grist_Tables: tableNames.map((tableId, i) => ({id: i + 1, tableId, summarySourceTable: 0})), _grist_Tables_column: []};
  const fields = {Venues: core.VENUE_FIELDS, Events: core.EVENT_FIELDS, Source_Checks: core.CHECK_FIELDS, Calendar: ['Date', 'Open_Day', 'Daily_Notes'], Daily_Sales: ['Sales']};
  const source = {Venues: snapshot.venues, Events: snapshot.events, Source_Checks: snapshot.checks, Calendar: [{Date: '2026-10-23', Open_Day: true, Daily_Notes: 'Unusual day'}], Daily_Sales: [{Sales: 321}]};
  let cid = 1;
  for (const [i, name] of tableNames.entries()) {
    for (const f of fields[name]) {
      let type = 'Text';
      if (['Event_Date', 'Date', 'Earliest_Returned_Date', 'Latest_Returned_Date'].includes(f)) type = dateType;
      if (['Start_ISO', 'End_ISO', 'First_Seen_UTC', 'Last_Seen_UTC', 'Last_Checked_UTC', 'Last_Attempt_UTC'].includes(f)) type = stampType;
      if (['Currently_Listed', 'Review_Required', 'Open_Day'].includes(f)) type = boolType;
      if (['Events_Returned', 'Excluded_Offers', 'Pages_Checked', 'Sales'].includes(f)) type = 'Int';
      data._grist_Tables_column.push({id: cid++, parentId: i + 1, colId: f, type, isFormula: false, formula: ''});
    }
    data[name] = (empty && ['Venues', 'Events', 'Source_Checks'].includes(name) ? [] : source[name]).map((r, j) => {
      const out = {id: j + 1};
      for (const col of data._grist_Tables_column.filter(c => c.parentId === i + 1)) {
        const value = r[col.colId] ?? '';
        out[col.colId] = col.type === 'Date' ? (value ? ['d', core.dateSeconds(value)] : null)
          : col.type.startsWith('DateTime') ? (value ? ['D', core.stampSeconds(value), 'UTC'] : null)
          : col.type === 'Bool' ? (value === true || value === 'True')
          : col.type === 'Int' ? Number(value) : value;
      }
      return out;
    });
  }
  return {tables: tableNames, data};
}
function columns(rows, fields = []) {
  return Object.fromEntries([...new Set(['id', ...fields, ...rows.flatMap(Object.keys)])].map(k => [k, rows.map(r => r[k] ?? null)]));
}
function mockAPI(doc) {
  let state = structuredClone(doc), writes = [];
  return {
    get state() {return state;}, writes,
    getDocName: async () => 'test-restaurant-doc',
    listTables: async () => [...state.tables],
    fetchTable: async name => structuredClone(columns(state.data[name] || [], state.data._grist_Tables_column.filter(c => c.parentId === state.data._grist_Tables.find(t => t.tableId === name)?.id).map(c => c.colId))),
    applyUserActions: async actions => {
      const upserts = new Set(['AddOrUpdateRecord','BulkAddOrUpdateRecord']);
      const dataActions = new Set([...upserts,'AddRecord','BulkAddRecord','UpdateRecord','BulkUpdateRecord','RemoveRecord','BulkRemoveRecord']);
      if (actions.some(a => upserts.has(a[0])) && actions.some(a => !dataActions.has(a[0]))) {
        throw new Error('Can only combine AddOrUpdateRecord and BulkAddOrUpdateRecord with simple data changes');
      }
      const next = structuredClone(state);
      for (const [action, table, keyOrName, values] of actions) {
        if (action === 'AddTable') {
          if (next.tables.includes(table)) throw new Error('Table exists');
          const ref = Math.max(0,...next.data._grist_Tables.map(t => t.id)) + 1;
          next.tables.push(table); next.data[table] = [];
          next.data._grist_Tables.push({id:ref,tableId:table,summarySourceTable:0});
          for (const col of keyOrName) next.data._grist_Tables_column.push({id:next.data._grist_Tables_column.length + 1,parentId:ref,colId:col.id,formula:'',...col});
        } else if (action === 'AddColumn') {
          if (next.data._grist_Tables_column.some(c => c.parentId === next.data._grist_Tables.find(t => t.tableId === table).id && c.colId === keyOrName)) throw new Error('Column exists');
          next.data._grist_Tables_column.push({id: 999, parentId: next.data._grist_Tables.find(t => t.tableId === table).id, colId: keyOrName, formula: '', ...values});
          for (const row of next.data[table]) row[keyOrName] = '';
        } else if (action === 'AddOrUpdateRecord') {
          const matches = next.data[table].filter(r => Object.entries(keyOrName).every(([k, v]) => r[k] === v));
          if (matches.length === 1) Object.assign(matches[0], values);
          else if (!matches.length) next.data[table].push({id: Math.max(0, ...next.data[table].map(r => r.id)) + 1, ...keyOrName, ...values});
        } else throw new Error('Unsupported mock action');
      }
      state = next; writes.push(structuredClone(actions));
    }
  };
}
module.exports = {SHA, NOW, STAMP, csv, fixture, documentFixture, mockAPI};
