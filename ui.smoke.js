// Browser smoke test. Syntax checks pass on code with undefined functions;
// this actually loads the page and drives it, so a ReferenceError fails here
// instead of in production.
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
let pass = 0, failn = 0;
const ok = (n, c, x = '') => { c ? (pass++, console.log('  PASS ' + n)) : (failn++, console.log('  FAIL ' + n + ' ' + x)); };

const RESUME = {
  name: 'Naivedya Jain', title: 'Product Leader | AI Platforms',
  contact: { email: 'n@example.com', phone: '+91', location: 'Bangalore', linkedin: 'in/nj' },
  summary: '11+ years building enterprise AI platforms.',
  experience: [
    { title: 'Group PM', company: 'Flipkart', duration: 'Jun 2026 - Oct 2026', bullets: ['Led AI platform charter', 'Built marketplace tooling'] },
    { title: 'Staff PM', company: 'Walmart', duration: 'Mar 2022 - Jun 2026', bullets: ['Scaled decision intelligence', 'Drove 40% efficiency gain'] }
  ],
  skills: ['AI Platforms', 'Marketplace', 'Strategy'],
  education: [{ degree: 'BTech CSE', school: 'IIIT Gwalior', year: '2015' }]
};
const ATS = { overall: 72, sections: [{ name: 'Contact Information', score: 80 }, { name: 'Work Experience', score: 65 }], suggestions: [{ type: 'tip', title: 'Add metrics', description: 'Quantify more bullets.' }] };

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.PW_CHROMIUM || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const errors = [];

  let responder = null;   // swapped per scenario; the route itself is registered once

  async function newPage(initial) {
    responder = initial;
    const page = await browser.newPage();
    page.on('pageerror', e => errors.push(String(e)));
    page.on('console', m => { if (m.type() === 'error' && /ReferenceError|TypeError|is not defined|is not a function/.test(m.text())) errors.push(m.text()); });
    await page.route('**/.netlify/functions/analyze', function(route){ return responder(route); });
    await page.goto('file://' + path.join(ROOT, 'index.html'));
    return page;
  }

  const okRoute = async route => {
    const body = JSON.parse(route.request().postData());
    const data = body.action === 'ats_score' ? ATS : RESUME;
    await route.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ success: true, data, warnings: [], requestId: 'testreq01', elapsedMs: 1200, version: '2.0.0' }) });
  };

  console.log('\n[page loads clean]');
  let page = await newPage(okRoute);
  ok('no error on initial load', errors.length === 0, errors.join(' | '));

  console.log('\n[helpers are actually defined]');
  const helpers = await page.evaluate(() =>
    ['showError', 'apiCall', 'isUsableResume', 'escapeHTML', 'diagRow', 'renderResume', 'renderATS',
     'analyzeResume', 'refineResume', 'optimizeJD', 'mockResume'].map(n => [n, typeof window[n]]));
  helpers.forEach(([n, t]) => { if (n !== 'mockResume') ok(n + ' is a function', t === 'function', 'got ' + t); });

  console.log('\n[ats_score end to end]');
  errors.length = 0;
  await page.evaluate(() => { state.text = 'x'.repeat(400); });
  await page.evaluate(() => analyzeResume());
  await page.waitForTimeout(400);
  ok('no runtime error during ATS', errors.length === 0, errors.join(' | '));
  ok('score screen visible', !(await page.locator('#score-screen').getAttribute('class')).includes('hidden'));
  ok('breakdown rendered', (await page.locator('#breakdown-items .breakdown-item').count()) === 2);

  console.log('\n[refine end to end]');
  errors.length = 0;
  await page.evaluate(() => refineResume());
  await page.waitForTimeout(400);
  ok('no runtime error during refine', errors.length === 0, errors.join(' | '));
  const html = await page.locator('#resume-preview').innerHTML().catch(() => '');
  ok('real name rendered, not placeholder', html.includes('Naivedya Jain'), html.slice(0, 120));
  ok('both jobs rendered', html.includes('Flipkart') && html.includes('Walmart'));
  ok('no "Your Name" placeholder leaked', !html.includes('Your Name'));

  console.log('\n[server error surfaces a diagnostic panel]');
  errors.length = 0;
  responder = route => route.fulfill({
    status: 502, contentType: 'application/json',
    body: JSON.stringify({ success: false, error: 'CHUNK_FAILED', stage: 'job:1', message: 'Could not rewrite "Staff PM at Walmart".', hint: 'Check the log.', requestId: 'abc123' })
  });
  await page.evaluate(() => refineResume());
  await page.waitForTimeout(400);
  ok('no runtime error in the error path', errors.length === 0, errors.join(' | '));
  ok('diagnostic overlay shown', await page.locator('#diag-overlay').isVisible());
  const panel = await page.locator('#diag-overlay').innerText();
  ok('panel names the code', panel.includes('CHUNK_FAILED'), panel.slice(0, 200));
  ok('panel names the stage', panel.includes('job:1'));
  ok('panel shows requestId', panel.includes('abc123'));
  ok('resume left untouched', (await page.evaluate(() => state.resume.name)) === 'Naivedya Jain');

  console.log('\n[Netlify-shaped JSON 502 — the one that read as SERVER_ERROR]');
  await page.evaluate(() => { const o=document.getElementById('diag-overlay'); if(o) o.remove(); });
  responder = route => route.fulfill({ status: 502, contentType: 'application/json',
    body: JSON.stringify({ errorMessage: '2026-09-19T06:11:02.123Z Task timed out after 30.00 seconds', errorType: 'Sandbox.Timedout' }) });
  await page.evaluate(() => refineResume());
  await page.waitForTimeout(400);
  let pt = await page.locator('#diag-overlay').innerText();
  ok('labels it PLATFORM_TIMEOUT, not SERVER_ERROR', pt.includes('PLATFORM_TIMEOUT'), pt.slice(0,160));
  ok('surfaces the platform message', pt.includes('Task timed out'), pt.slice(0,160));

  console.log('\n[timings surface in the panel]');
  await page.evaluate(() => { const o=document.getElementById('diag-overlay'); if(o) o.remove(); });
  responder = route => route.fulfill({ status: 504, contentType: 'application/json',
    body: JSON.stringify({ success:false, error:'TIMEOUT', stage:'job:3', message:'Budget exhausted.', requestId:'tmg001',
      timings:[{stage:'outline',ms:4200,outTok:120},{stage:'header',ms:9100,outTok:310},{stage:'job:0',ms:15400,outTok:260}] }) });
  await page.evaluate(() => refineResume());
  await page.waitForTimeout(400);
  let tt = await page.locator('#diag-overlay').innerText();
  ok('timing breakdown shown', tt.includes('Where the time went'), tt.slice(0,160));
  ok('slowest stage listed first', tt.indexOf('15400') < tt.indexOf('4200'));
  ok('stage names present', tt.includes('outline') && tt.includes('header'));

  console.log('\n[platform 502 with non-JSON body]');
  await page.evaluate(() => document.getElementById('diag-overlay').remove());
  responder = route => route.fulfill({ status: 502, contentType: 'text/html', body: '<html>Bad gateway</html>' });
  await page.evaluate(() => refineResume());
  await page.waitForTimeout(400);
  ok('reports FUNCTION_DIED', (await page.locator('#diag-overlay').innerText()).includes('FUNCTION_DIED'));

  await browser.close();
  console.log(`\n${pass} passed, ${failn} failed`);
  process.exit(failn ? 1 : 0);
})();
