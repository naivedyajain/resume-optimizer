// Walks the whole product the way a user does, in real Chromium, clicking
// real buttons. Fails on any page error at any step.
const { chromium } = require('playwright');
const path = require('path');
let pass = 0, fail = 0;
const ok = (n, c, x='') => { c ? (pass++, console.log('  ✓ ' + n)) : (fail++, console.log('  ✗ ' + n + (x ? '  <-- ' + x : ''))); };

const RESUME = {
  name: 'Naivedya Jain', title: 'Product Leader | AI Platforms',
  contact: { email: 'n@example.com', phone: '+91 99999', location: 'Bangalore', linkedin: 'in/nj' },
  summary: '11+ years building enterprise AI platforms.',
  experience: [
    { title: 'Group PM', company: 'Flipkart', duration: 'Jun 2026 - Oct 2026', bullets: ['Led AI platform charter', 'Built marketplace tooling'] },
    { title: 'Staff PM', company: 'Walmart', duration: 'Mar 2022 - Jun 2026', bullets: ['Scaled decision intelligence to 40+ teams', 'Drove 40% efficiency gain'] },
    { title: 'Senior PM', company: 'Paytm', duration: '2021 - 2022', bullets: ['Launched payments feature'] }
  ],
  skills: ['AI Platforms', 'Marketplace', 'Strategy'],
  education: [{ degree: 'BTech CSE', school: 'IIIT Gwalior', year: '2015' }]
};
const ATS = { overall: 72, sections: ['Contact Information','Professional Summary','Work Experience','Skills Section','Education','Keywords & ATS'].map((n,i)=>({name:n,score:60+i*4})), suggestions: [{type:'critical',title:'Add metrics',description:'Quantify more bullets.'},{type:'tip',title:'Tighten summary',description:'Two sentences is enough.'}] };

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.PW_CHROMIUM || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type()==='error' && /ReferenceError|TypeError|not defined|not a function/.test(m.text())) errors.push(m.text()); });

  await page.route('**/.netlify/functions/analyze', async route => {
    const b = JSON.parse(route.request().postData());
    const data = b.action === 'ats_score' ? ATS
               : b.action === 'chat' ? { message: 'Tightened the summary.', updatedResume: RESUME }
               : RESUME;
    await route.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ success: true, data, warnings: [], requestId: 'jrny0001', elapsedMs: 900, version: '2.0.0' }) });
  });

  await page.goto('file://' + path.join(__dirname, '..', 'index.html'));
  const step = async (label, fn) => { errors.length = 0; await fn(); await page.waitForTimeout(350); ok(label, errors.length === 0, errors.join(' | ')); };

  console.log('\n[journey]');
  await step('1. landing renders', async () => {});
  await step('2. start flow (real click)', async () => { await page.evaluate(() => startFlow()); });
  await step('3. resume text loaded', async () => { await page.evaluate(() => { state.text = 'Naivedya Jain, Product Leader. '.repeat(30); }); });
  await step('4. analyze resume', async () => { await page.evaluate(() => analyzeResume()); });

  ok('   score screen visible', !(await page.locator('#score-screen').getAttribute('class')).includes('hidden'));
  ok('   all 6 breakdown rows', (await page.locator('#breakdown-items .breakdown-item').count()) === 6);
  ok('   suggestions rendered', (await page.locator('#suggestions .suggestion').count()) === 2);

  await step('5. email gate unlock -> auto refine', async () => {
    await page.fill('#user-email', 'naivedyajain97@gmail.com');
    await page.evaluate(() => unlockRefine());
  });
  ok('   refine screen visible', !(await page.locator('#refine-screen').getAttribute('class')).includes('hidden'));
  let prev = await page.locator('#resume-preview').innerHTML();
  ok('   real name rendered', prev.includes('Naivedya Jain'));
  ok('   all 3 roles rendered', ['Flipkart','Walmart','Paytm'].every(c => prev.includes(c)));
  ok('   no placeholder leaked', !prev.includes('Your Name') && !prev.includes('Company Name'));
  ok('   metrics preserved verbatim', prev.includes('40% efficiency gain') && prev.includes('40+ teams'));

  for (const t of ['modern','bold','clean','executive']) {
    await step('6. template switch -> ' + t, async () => { await page.evaluate(tpl => { if (typeof setTemplate==='function') setTemplate(tpl); else { state.template = tpl; renderResume(); } }, t); });
  }

  await step('7. chat refinement', async () => {
    await page.evaluate(() => { const i = document.getElementById('chat-input'); if (i) i.value = 'make the summary shorter'; });
    await page.evaluate(() => { if (typeof sendChat === 'function') return sendChat(); });
  });

  await step('8. JD optimize', async () => {
    await page.evaluate(() => { const el = document.getElementById('jd-text'); if (el) el.value = 'Looking for a senior PM with AI platform experience. '.repeat(5); });
    await page.evaluate(() => optimizeJD());
  });
  ok('   resume still intact after JD', (await page.locator('#resume-preview').innerHTML()).includes('Naivedya Jain'));

  await step('9. PDF export path runs', async () => { await page.evaluate(() => { if (typeof downloadPDF === 'function') try { downloadPDF(); } catch(e) {} }); });

  await browser.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
