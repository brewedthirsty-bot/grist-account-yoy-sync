/* Test the real official API bundle under the widget's actual CSP.
 * SYNC_GRIST_API_PATH must point to a fresh download of
 * https://docs.getgrist.com/grist-plugin-api.js (not a mock).
 */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {chromium} = require('playwright');
const root = path.resolve(__dirname, '..');
(async () => {
  assert(process.env.SYNC_GRIST_API_PATH, 'Set SYNC_GRIST_API_PATH to the official downloaded Grist API bundle.');
  const bundle = fs.readFileSync(process.env.SYNC_GRIST_API_PATH, 'utf8');
  assert(bundle.length > 100000, 'Expected the complete official API bundle.');
  const browser = await chromium.launch({headless: true, ...(process.env.SYNC_CHROMIUM_PATH ? {executablePath: process.env.SYNC_CHROMIUM_PATH} : {})});
  try {
    const page = await browser.newPage(), errors = [], policyErrors = [];
    page.on('pageerror', e => errors.push(e.message));
    page.on('console', m => {if (m.type() === 'error' && /Content Security Policy|unsafe-eval/.test(m.text())) policyErrors.push(m.text());});
    await page.route('https://event-sync.test/**', route => {
      const pathname = new URL(route.request().url()).pathname;
      const file = path.resolve(root, '.' + pathname + (pathname.endsWith('/') ? 'index.html' : ''));
      if (!file.startsWith(root + path.sep) || !fs.existsSync(file)) return route.fulfill({status: 404, body: ''});
      return route.fulfill({contentType: {'.html':'text/html','.css':'text/css','.js':'application/javascript'}[path.extname(file)], body: fs.readFileSync(file)});
    });
    await page.route('https://docs.getgrist.com/grist-plugin-api.js', route => route.fulfill({contentType: 'application/javascript', body: bundle}));
    await page.goto('https://event-sync.test/events/', {waitUntil: 'load'});
    const state = await page.evaluate(() => ({
      ready: typeof window.grist?.ready,
      onOptions: typeof window.grist?.onOptions,
      fetchTable: typeof window.grist?.docApi?.fetchTable,
      applyUserActions: typeof window.grist?.docApi?.applyUserActions,
      status: document.getElementById('status').textContent
    }));
    assert.deepEqual(policyErrors, [], 'The official API is blocked by the widget policy.');
    assert.deepEqual(errors, [], 'The real Grist API must execute without page errors.');
    for (const key of ['ready','onOptions','fetchTable','applyUserActions']) assert.equal(state[key], 'function', `${key} must be provided by the real Grist API.`);
    assert(!state.status.includes('API could not load'));
    console.log('Real Grist plugin API browser check passed under the widget CSP.');
  } finally {await browser.close();}
})().catch(e => {console.error(e); process.exitCode = 1;});
