'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {createHash} = require('node:crypto');
const core = require('../events/core.js'), desktop = require('../events/desktop.js');
const {fixture,csv,documentFixture,mockAPI,SHA,NOW,STAMP} = require('./fixtures.js');

const {source,files,desktopFixture,raw,fetchCity} = require('./desktop-fixtures.js');
test('desktop delegation is explicit and is never presented as a GitHub source success', () => {
  const f = desktopFixture(), s = core.validateSnapshot(files(f),SHA,NOW);
  assert.equal(s.report.success,true); assert(s.skipSources.has(source.source_key));
  f.report.sources[2].success = true;
  assert.throws(() => core.validateSnapshot(files(f),SHA,NOW), /incorrectly reported/);
});
test('fourth venue adds Riverview rows and report catches a missing venue', async () => {
  const f = desktopFixture();
  const v = {Venue_Key:'venue:riverview_health_arena',Venue:'Riverview Health Arena at Innovation Mile',Website:'https://www.arenainnovationmile.com/arenaevents',Source_Key:'source:riverview_ticketmaster',Source_URL:'https://app.ticketmaster.com/discovery/v2/events.json'};
  f.venues.push(v);f.checks.push({...f.checks[0],Source_Key:v.Source_Key,Venue:v.Venue});f.report.sources.push({source_key:v.Source_Key,venue:v.Venue,success:true,included:1});
  f.events.push({...f.events[0],Event_Key:'event:riverview-game',Venue_Key:v.Venue_Key,Venue:v.Venue,Source_Key:v.Source_Key,Source_Event_ID:'source-id:riverview-game',Event_Type:'SportsEvent'});
  f.report.venue_keys.push(v.Venue_Key);f.report.history_events++;f.report.current_events++;
  const s = core.validateSnapshot(files(f),SHA,NOW), doc = documentFixture(s);
  doc.data.Venues = doc.data.Venues.filter(r => r.Venue_Key !== v.Venue_Key);doc.data.Events = doc.data.Events.filter(r => r.Venue_Key !== v.Venue_Key);
  const api = mockAPI(doc);await core.syncSnapshot(api,s);
  assert.equal(api.state.data.Venues.filter(r => r.Venue_Key === v.Venue_Key).length,1);
  assert.equal(api.state.data.Events.filter(r => r.Venue_Key === v.Venue_Key).length,1);
  f.venues.pop();assert.throws(() => core.validateSnapshot(files(f),SHA,NOW), /venue list/);
});
test('city browser requests carry no GitHub credentials and stable keys match the collector format', async () => {
  const calls = [], result = await desktop.loadCity(source,'2025-01-01','2028-12-31',fetchCity([raw(42),raw(43)],calls));
  assert.equal(result.rows[0].Event_Key,source.event_key_aliases['42']);
  assert.equal(result.rows[1].Event_Key,'event:'+createHash('sha256').update(source.source_key+'\0'+'43').digest('hex').slice(0,32));
  assert.equal(result.rows[0].Start_ISO,'2026-10-23T19:30:00-04:00');
  assert(calls.every(c => new URL(c.url).origin === 'https://fishersin.gov' && !c.options.headers.Authorization && c.options.credentials === 'omit' && c.options.redirect === 'error'));
});
test('AMP sync creates source checks, preserves manual notes, retains local new rows and first-seen times across old GitHub snapshots', async () => {
  const s = core.validateSnapshot(files(desktopFixture()),SHA,NOW), doc = documentFixture(s);
  doc.data.Events[2].Review_Note = 'My own note'; const api = mockAPI(doc);
  let next = await desktop.refreshDesktopSources(s,await core.readDocument(api),fetchCity([raw(),raw(43)]),NOW);
  await core.syncSnapshot(api,next);
  assert.equal(api.writes.length,2);
  assert(api.writes[0].some(a => a[0] === 'AddTable'));
  assert(api.writes[0].every(a => ['AddTable','AddColumn'].includes(a[0])));
  assert(api.writes[1].every(a => a[0] === 'AddOrUpdateRecord'));
  const newKey = await desktop.stableKey(source,'43'), firstSeen = api.state.data.Events.find(r => r.Event_Key === newKey).First_Seen_UTC;
  assert(api.state.tables.includes('Source_Checks'));assert.equal(api.state.data.Events[2].Review_Note,'My own note');
  assert.equal(api.state.data.Source_Checks.find(c => c.Source_Key === source.source_key).Latest_Check_Status,'Success');
  const changed = raw(42,{start_date:'2026-10-24 20:30:00',utc_start_date:'2026-10-25 00:30:00',end_date:'2026-10-24 22:00:00',utc_end_date:'2026-10-25 02:00:00'});
  next = await desktop.refreshDesktopSources(s,await core.readDocument(api),fetchCity([changed,raw(43)]),NOW+3600000);
  await core.syncSnapshot(api,next);
  assert.equal(api.state.data.Events.find(r => r.Event_Key === newKey).First_Seen_UTC,firstSeen);
  assert.equal(api.state.data.Events.find(r => r.Event_Key === source.event_key_aliases['42']).Event_Date,core.dateSeconds('2026-10-24'));
  assert.equal(api.state.data.Events.find(r => r.Event_Key === source.event_key_aliases['42']).Review_Required,true);
});
test('failed direct check cannot overwrite Grist AMP data with old GitHub rows', async () => {
  const s = core.validateSnapshot(files(desktopFixture()),SHA,NOW), api = mockAPI(documentFixture(s));
  let next = await desktop.refreshDesktopSources(s,await core.readDocument(api),fetchCity([raw(42),raw(43)]),NOW);
  await core.syncSnapshot(api,next);const prior = structuredClone(api.state.data.Events);
  const previousSuccess = api.state.data.Source_Checks.find(c => c.Source_Key === source.source_key).Last_Checked_UTC;
  next = await desktop.refreshDesktopSources(s,await core.readDocument(api),async () => ({ok:false,status:403}),NOW+3600000);
  assert(next.skipSources.has(source.source_key));assert.match(next.warnings.join(),/403/);
  assert(!core.planSync(next,await core.readDocument(api)).actions.some(a => a[0] === 'AddOrUpdateRecord' && a[1] === 'Events' && a[3].Source_Key === source.source_key));
  await core.syncSnapshot(api,next);assert.deepEqual(api.state.data.Events,prior);
  const check = api.state.data.Source_Checks.find(c => c.Source_Key === source.source_key);
  assert.equal(check.Latest_Check_Status,'Failed');assert.equal(check.Last_Checked_UTC,previousSuccess);
});
test('duplicate pages, wrong venues and invalid times reject the entire city refresh', async () => {
  const many = Array.from({length:51},(_,i)=>raw(i+100));many[50].id = many[0].id;
  await assert.rejects(desktop.loadCity(source,'2025-01-01','2028-12-31',fetchCity(many)),/duplicate/);
  await assert.rejects(desktop.loadCity(source,'2025-01-01','2028-12-31',fetchCity([raw(42,{venue:{id:999}})])),/venue/);
  await assert.rejects(desktop.loadCity(source,'2025-01-01','2028-12-31',fetchCity([raw(42,{utc_start_date:'2026-10-23 22:30:00'})])),/disagree/);
});
