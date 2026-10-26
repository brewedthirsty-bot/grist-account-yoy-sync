'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const core = require('../events/core.js');
const {SHA, NOW, fixture, csv, documentFixture, mockAPI} = require('./fixtures.js');
const snapshot = () => core.validateSnapshot(fixture().files, SHA, NOW);
test('CSV handles BOM, CRLF, escaped quotes and embedded newlines', () => {
  const f = fixture(); const rows = core.parseCSV(f.files['Events.csv'], core.EVENT_FIELDS);
  assert.equal(rows[0].Event_Name, 'A show, with "quotes"'); assert.match(rows[1].Review_Note, /\n/);
  assert.throws(() => core.parseCSV('A\n"unfinished', ['A']), /Unclosed/);
  assert.throws(() => core.parseCSV('A\n"a"x', ['A']), /Unexpected/);
});
test('partial collector failure is valid and stays visible', () => {
  const s = snapshot(); assert.equal(s.events.length, 2); assert.equal(s.report.success, false); assert.match(s.warnings.join(), /403/);
});
test('invalid dates, duplicate keys, unknown venues and inconsistent reports are rejected', () => {
  for (const mutate of [f => {f.events[0].Event_Date = '2026-02-30';}, f => {f.events[1].Event_Key = f.events[0].Event_Key;}, f => {f.events[0].Venue_Key = 'venue:missing';}]) {
    const f = fixture(); mutate(f); f.files['Events.csv'] = csv(core.EVENT_FIELDS, f.events);
    assert.throws(() => core.validateSnapshot(f.files, SHA, NOW));
  }
  const f = fixture(); f.report.history_events++; f.files['run_report.json'] = JSON.stringify(f.report); assert.throws(() => core.validateSnapshot(f.files, SHA, NOW), /count/);
});
test('sync preserves row IDs, manual notes, extra reference/formula fields, Calendar and sales', async () => {
  const s = snapshot(), doc = documentFixture(s);
  doc.data.Events[0].Review_Note = 'My own event note'; doc.data.Events[0].Local_Notes = 'Keep me'; doc.data.Events[0].Calendar_Day = 99;
  const calendar = structuredClone(doc.data.Calendar), sales = structuredClone(doc.data.Daily_Sales);
  const api = mockAPI(doc); const result = await core.syncSnapshot(api, s);
  assert.equal(result.after.actions.length, 0); assert.equal(api.state.data.Events[0].id, 1);
  assert.equal(api.state.data.Events[0].Review_Note, 'My own event note'); assert.equal(api.state.data.Events[0].Local_Notes, 'Keep me'); assert.equal(api.state.data.Events[0].Calendar_Day, 99);
  assert.equal(api.state.data.Events[1].Source_Review_Note, s.events[1].Review_Note);
  assert.deepEqual(api.state.data.Calendar, calendar); assert.deepEqual(api.state.data.Daily_Sales, sales);
  assert.equal(api.writes.length, 2); // Schema setup and row updates use separate transactions.
  assert(api.writes[0].every(a => ['AddColumn','AddTable'].includes(a[0])));
  assert(api.writes[1].every(a => a[0] === 'AddOrUpdateRecord'));
  await core.syncSnapshot(api, s); assert.equal(api.writes.length, 2); // No-op second sync.
});
test('adds missing keys and updates rescheduled events without deleting local rows', async () => {
  const s = snapshot(), doc = documentFixture(s, {empty: true}); const api = mockAPI(doc);
  await core.syncSnapshot(api, s); assert.equal(api.state.data.Events.length, 2);
  api.state.data.Events[0].Event_Name = 'Old title'; api.state.data.Events.push({...api.state.data.Events[1], id: 100, Event_Key: 'event:local'});
  await core.syncSnapshot(api, s); assert.equal(api.state.data.Events[0].Event_Name, s.events[0].Event_Name); assert.equal(api.state.data.Events.length, 3);
  assert.equal(api.state.data.Events[2].Event_Key, 'event:local');
});
test('duplicate Grist keys, missing columns, references in raw keys and formulas block all writes', async () => {
  for (const mutate of [d => d.data.Events.push({...d.data.Events[0], id: 5}), d => {d.data._grist_Tables_column = d.data._grist_Tables_column.filter(c => c.colId !== 'Event_Date');}, d => {d.data._grist_Tables_column.find(c => c.colId === 'Event_Key').type = 'Ref:Events';}, d => {d.data._grist_Tables_column.find(c => c.colId === 'Event_Name').isFormula = true;}]) {
    const s = snapshot(), doc = documentFixture(s); mutate(doc); const api = mockAPI(doc);
    await assert.rejects(core.syncSnapshot(api, s)); assert.equal(api.writes.length, 0);
  }
});
test('Date, DateTime, Bool and Text imports compare correctly and converge', async () => {
  for (const cfg of [{stampType: 'DateTime:America/Indiana/Indianapolis'}, {dateType: 'Text', boolType: 'Text'}]) {
    const s = snapshot(), api = mockAPI(documentFixture(s, cfg)); await core.syncSnapshot(api, s);
    assert.equal(core.planSync(s, await core.readDocument(api)).actions.length, 0);
  }
});
test('optional Source_Checks is updated when present', async () => {
  const s = snapshot(), doc = documentFixture(s, {sourceChecks: true}); doc.data.Source_Checks[0].Events_Returned = 999;
  const api = mockAPI(doc); await core.syncSnapshot(api, s); assert.equal(api.state.data.Source_Checks[0].Events_Returned, 1);
});
test('server key matching avoids duplicate adds after a stale preview', async () => {
  const s = snapshot(), api = mockAPI(documentFixture(s, {empty: true})); const original = api.applyUserActions;
  let inserted = false;
  api.applyUserActions = async actions => {
    if (!inserted && actions.some(a => a[0] === 'AddOrUpdateRecord')) {
      inserted = true; api.state.data.Events.push({id: 777, Event_Key: s.events[0].Event_Key, Review_Note: 'Added by another client'});
    }
    await original(actions);
  };
  await core.syncSnapshot(api, s); assert.equal(api.state.data.Events.filter(e => e.Event_Key === s.events[0].Event_Key).length, 1); assert.equal(api.state.data.Events[0].id, 777);
});
test('a failed write or mismatched verification cannot report success', async () => {
  const s = snapshot(), api = mockAPI(documentFixture(s)), original = api.applyUserActions;
  api.applyUserActions = async () => {throw new Error('Denied');};
  await assert.rejects(core.syncSnapshot(api, s), /Denied/);
  api.applyUserActions = async actions => {if (actions.some(a => a[0] === 'AddColumn')) await original(actions);};
  await assert.rejects(core.syncSnapshot(api, s), /verification/);
});
test('mixed schema and upsert bundles reproduce the Grist rejection without saving rows', async () => {
  const api = mockAPI(documentFixture(snapshot())), previous = structuredClone(api.state);
  await assert.rejects(api.applyUserActions([
    ['AddColumn','Events','Source_Review_Note',{type:'Text',isFormula:false}],
    ['AddOrUpdateRecord','Events',{Event_Key:'event:1'},{Event_Name:'Should not save'},{on_many:'none'}]
  ]), /Can only combine AddOrUpdateRecord/);
  assert.deepEqual(api.state,previous);assert.equal(api.writes.length,0);
});
test('failed row write after setup can retry without repeating schema creation or duplicating events', async () => {
  const s = snapshot(), api = mockAPI(documentFixture(s)), original = api.applyUserActions;
  let rejectData = true;
  api.applyUserActions = async actions => {
    if (rejectData && actions.some(a => a[0] === 'AddOrUpdateRecord')) throw new Error('Data write interrupted');
    await original(actions);
  };
  await assert.rejects(core.syncSnapshot(api,s), /Data write interrupted/);
  assert.equal(api.writes.length,1);assert(api.writes[0].every(a => a[0] === 'AddColumn'));
  rejectData = false;await core.syncSnapshot(api,s);
  assert.equal(api.writes.length,2);assert.equal(api.state.data.Events.length,s.events.length);
  assert.equal(api.writes.flat().filter(a => a[0] === 'AddColumn').length,1);
});
test('sync revalidates live keys after schema setup before any row writes', async () => {
  const s = snapshot(), api = mockAPI(documentFixture(s)), original = api.applyUserActions;
  api.applyUserActions = async actions => {
    await original(actions);
    if (actions.some(a => a[0] === 'AddColumn')) api.state.data.Events.push({...api.state.data.Events[0],id:999});
  };
  await assert.rejects(core.syncSnapshot(api,s), /duplicate Event_Key/);
  assert.equal(api.writes.length,1);assert(api.writes[0].every(a => a[0] === 'AddColumn'));
});
test('network reads one commit snapshot and never sends credentials to another host', async () => {
  const f = fixture(), calls = [];
  const fetcher = async (url, options) => {
    calls.push({url, options});
    const body = url.endsWith('/branches/main') ? JSON.stringify({commit: {sha: SHA}}) : f.files[decodeURIComponent(url.match(/data\/(.*?)\?/)[1])];
    return {ok: true, text: async () => body};
  };
  const s = await core.loadSnapshot('FAKE_READ_ONLY_TEST_TOKEN', fetcher, NOW); assert.equal(s.sha, SHA); assert.equal(calls.length, 5);
  for (const c of calls) { assert.equal(new URL(c.url).origin, 'https://api.github.com'); assert.equal(c.options.method, 'GET'); assert.equal(c.options.redirect, 'error'); }
  assert(calls.slice(1).every(c => c.url.endsWith('?ref=' + SHA)));
  await assert.rejects(core.loadSnapshot('FAKE', async () => ({ok: false, status: 401})), /invalid or expired/);
  await assert.rejects(core.loadSnapshot('FAKE', async () => ({ok: false, status: 404})), /private event repository/);
});
test('stale snapshots and missing Calendar dates produce warnings without creating closures', () => {
  const s = core.validateSnapshot(fixture().files, SHA, NOW + 48 * 3600000), d = documentFixture(s);
  d.data.Calendar[0].Date = ['d', core.dateSeconds('2026-01-01')]; const p = core.planSync(s, d);
  assert.match(p.warnings.join(), /36 hours/); assert.match(p.warnings.join(), /outside/);
  assert(p.actions.every(a => !['Calendar', 'Daily_Sales'].includes(a[1])));
});
