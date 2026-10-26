/* Run with Playwright installed: NODE_PATH=<node_modules> node tests/browser.test.js */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const {chromium} = require('playwright');
const core = require('../events/core.js');
const {SHA, NOW, fixture, documentFixture, mockAPI} = require('./fixtures.js');
const {desktopFixture,files:desktopFiles,raw:cityEvent} = require('./desktop-fixtures.js');
const root = path.resolve(__dirname, '..');
const server = http.createServer((req, res) => {
  if (req.url === '/test-host') {res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><iframe title="Event Sync" src="/events/" style="border:0;width:100%;height:1100px"></iframe>'); return;}
  const urlPath = req.url.split('?')[0];
  const file = path.resolve(root, '.' + urlPath + (urlPath.endsWith('/') ? 'index.html' : ''));
  if (!file.startsWith(root + path.sep) || !fs.existsSync(file)) {res.writeHead(404); res.end(); return;}
  res.setHeader('Content-Type', {'.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css'}[path.extname(file)] || 'text/plain');
  res.end(fs.readFileSync(file));
});
(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({headless: true, ...(process.env.SYNC_CHROMIUM_PATH ? {executablePath: process.env.SYNC_CHROMIUM_PATH} : {})});
  try {
    const desktopMode = process.env.SYNC_BROWSER_DESKTOP === '1';
    const f = desktopMode ? desktopFixture() : fixture();
    if (desktopMode) {
      const venue = {Venue_Key:'venue:riverview_health_arena',Venue:'Riverview Health Arena at Innovation Mile',Website:'https://www.arenainnovationmile.com/arenaevents',Source_Key:'source:riverview_ticketmaster',Source_URL:'https://app.ticketmaster.com/discovery/v2/events.json'};
      f.venues.push(venue);f.checks.push({...f.checks[0],Source_Key:venue.Source_Key,Venue:venue.Venue});
      f.report.sources.push({source_key:venue.Source_Key,venue:venue.Venue,success:true,included:1});
      f.events.push({...f.events[0],Event_Key:'event:riverview-game',Venue_Key:venue.Venue_Key,Venue:venue.Venue,Source_Key:venue.Source_Key,Source_Event_ID:'source-id:riverview-game',Event_Type:'SportsEvent'});
      f.report.venue_keys.push(venue.Venue_Key);f.report.history_events++;f.report.current_events++;f.files = desktopFiles(f);
    }
    const snapshot = core.validateSnapshot(f.files, SHA, NOW);
    const doc = documentFixture(snapshot); doc.data.Events[0].Review_Note = 'Keep my manual note';
    if (desktopMode) {
      doc.data.Venues = doc.data.Venues.filter(r => r.Venue_Key !== 'venue:riverview_health_arena');
      doc.data.Events = doc.data.Events.filter(r => r.Venue_Key !== 'venue:riverview_health_arena');
    }
    const api = mockAPI(doc), page = await browser.newPage({viewport: {width: 1050, height: 1000}}), errors = [], requests = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.exposeFunction('__docCall', async (method, args) => api[method](...args));
    await page.route('https://docs.getgrist.com/grist-plugin-api.js', route => route.fulfill({contentType: 'application/javascript', body: `window.grist={onOptions(cb){this.cb=cb},ready(){setTimeout(()=>this.cb(null,{accessLevel:'full'}),0)},docApi:Object.fromEntries(['getDocName','listTables','fetchTable','applyUserActions'].map(m=>[m,(...args)=>window.__docCall(m,args)]))};`}));
    await page.route('https://api.github.com/**', route => {
      const req = route.request();
      const headers = {'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Authorization,Accept,X-GitHub-Api-Version', 'Access-Control-Allow-Methods': 'GET, OPTIONS'};
      if (req.method() === 'OPTIONS') return route.fulfill({status: 204, headers});
      requests.push(req.url()); assert.equal(req.method(), 'GET');
      const body = req.url().endsWith('/branches/main') ? JSON.stringify({commit: {sha: SHA}}) : f.files[req.url().match(/data\/(.*?)\?/)[1]];
      return route.fulfill({status: 200, body, headers, contentType: 'text/plain'});
    });
    let cityFail = false, cityRequests = 0;
    if (desktopMode) await page.route('https://fishersin.gov/**', route => {
      cityRequests++; assert.equal(route.request().method(),'GET'); assert(!route.request().headers().authorization);
      const events = [cityEvent(),cityEvent(43,{title:'Another city show'})];
      return route.fulfill({status:cityFail ? 403 : 200,headers:{'Access-Control-Allow-Origin':'*'},contentType:'application/json',body:JSON.stringify({events,total:events.length,total_pages:1})});
    });
    const address = `http://127.0.0.1:${server.address().port}/test-host`;
    await page.goto(address);
    let widget = page.frameLocator('iframe');
    await widget.getByText('Connect to GitHub below, review the preview, then click Sync events.', {exact: true}).waitFor();
    await widget.locator('#token').fill('FAKE_READ_ONLY_TEST_TOKEN'); await widget.locator('#remember').check();
    await widget.locator('#connect').click();
    await widget.locator('#status').filter({hasText: 'First sync adds Source_Review_Note'}).waitFor();
    assert.equal(api.writes.length, 0); // Connect is a read-only preview.
    await widget.locator('#sync').click();
    await widget.locator('#status').filter({hasText: 'Grist verified the snapshot'}).waitFor();
    assert.equal(api.state.data.Events.length, desktopMode ? 5 : 2); assert.equal(api.state.data.Events[0].Review_Note, 'Keep my manual note');
    if (!desktopMode) assert.match(await widget.locator('#status').innerText(), /403/);
    assert.equal(await widget.locator('#changedEvents').innerText(), '0');
    assert.equal(await widget.locator('#sources tr').count(), desktopMode ? 4 : 3);
    if (desktopMode) {
      assert(cityRequests >= 2);assert(api.state.tables.includes('Source_Checks'));
      assert.equal(api.state.data.Venues.filter(r => r.Venue_Key === 'venue:riverview_health_arena').length,1);
      assert.equal(api.state.data.Events.filter(r => r.Venue_Key === 'venue:riverview_health_arena').length,1);
    }
    const firstWrites = api.writes.length, requestsBeforeReload = requests.length;
    await page.reload(); widget = page.frameLocator('iframe');
    await widget.locator('#status').filter({hasText: 'Grist verified the snapshot'}).waitFor();
    assert(requests.length > requestsBeforeReload);
    if (!desktopMode) assert.equal(api.writes.length, firstWrites); // GitHub-only reopen is a no-op.
    else {
      assert.equal(api.state.data.Events.length,5);const cityRows = structuredClone(api.state.data.Events.filter(r => r.Source_Key === 'source:fishers_city_amp'));
      cityFail = true;await widget.locator('#sync').click();await widget.locator('#status').filter({hasText:'Grist verified the snapshot'}).waitFor();
      assert.match(await widget.locator('#status').innerText(),/403/);
      assert.deepEqual(api.state.data.Events.filter(r => r.Source_Key === 'source:fishers_city_amp'),cityRows);
      assert.equal(api.state.data.Source_Checks.find(c => c.Source_Key === 'source:fishers_city_amp').Latest_Check_Status,'Failed');
    }
    // A secret is only in the opt-in token key, never in document preferences.
    const prefs = await page.evaluate(() => localStorage.getItem('fdr-event-sync:prefs:v1:test-restaurant-doc'));
    assert(prefs && !prefs.includes('FAKE_READ_ONLY_TEST_TOKEN'));
    await page.screenshot({path: process.env.SYNC_SCREENSHOT || '/tmp/fdr-event-sync-desktop.png', fullPage: true});
    await page.setViewportSize({width: 390, height: 900});
    assert(await widget.locator('body').evaluate(e => e.scrollWidth <= e.clientWidth));
    await widget.locator('#connection').evaluate(e => {e.open = true;});
    await widget.locator('#forget').click();
    assert.equal(await page.evaluate(() => localStorage.getItem('fdr-event-sync:github-read-token:v1')), null);
    assert(await widget.locator('#sync').isDisabled()); assert.deepEqual(errors, []);
    console.log(`Browser checks passed (${desktopMode ? 'four venues + direct city calendar' : 'legacy GitHub snapshot'}): connection preview, sync, failure preservation, notes, automatic reopen, token isolation, mobile layout, forget.`);
  } finally {await browser.close();}
})().catch(err => {console.error(err); process.exitCode = 1;}).finally(() => server.close());
