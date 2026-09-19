const fs = require('fs');
let pass = 0, failn = 0;
const ok = (n, c, extra='') => { c ? (pass++, console.log('  PASS ' + n)) : (failn++, console.log('  FAIL ' + n + ' ' + extra)); };

// ---- static check: every build*Prompt called is actually defined ----
const src = fs.readFileSync(require('path').join(__dirname,'../netlify/functions/analyze.js'), 'utf8');
const defined = new Set([...src.matchAll(/^(?:async )?function (\w+)/gm)].map(m => m[1]));
const called = new Set([...src.matchAll(/\b(build\w*Prompt|runHealthCheck|appError|extractJSON|validateShape|callClaude|log|fail|newRequestId|buildResumeInParallel)\s*\(/g)].map(m => m[1]));
const missing = [...called].filter(f => !defined.has(f));
console.log('\n[static] undefined-but-called functions:');
ok('all referenced functions defined', missing.length === 0, JSON.stringify(missing));

process.env.ANTHROPIC_API_KEY = 'test-key';
let mode = 'happy', calls = 0, attemptsByStage = {};

global.fetch = async (url, opts) => {
  const body = JSON.parse(opts.body);
  const prompt = body.messages[0].content;
  calls++;
  const stage = prompt.includes('List every work position') ? 'outline'
              : prompt.includes('ONLY the header sections') ? 'header'
              : prompt.includes('ATS compatibility') ? 'ats' : 'job';
  attemptsByStage[stage] = (attemptsByStage[stage] || 0) + 1;

  if (mode === 'auth')    return { ok:false, status:401, text: async () => '{"error":"invalid key"}' };
  if (mode === 'model')   return { ok:false, status:404, text: async () => '{"error":"model not found"}' };
  if (mode === 'flaky' && stage === 'job' && attemptsByStage.job <= 2)
                          return { ok:false, status:529, text: async () => 'overloaded' };
  if (mode === 'prose')   return { ok:true, status:200, json: async () => ({ content:[{type:'text',text:'I cannot do that.'}], stop_reason:'end_turn' }) };
  if (mode === 'trunc')   return { ok:true, status:200, json: async () => ({ content:[{type:'text',text:'{"bullets":["a'}], stop_reason:'max_tokens' }) };

  let text;
  if (stage === 'outline') text = JSON.stringify({ jobs:[{title:'Group PM',company:'Flipkart',duration:'2026'},{title:'Staff PM',company:'Walmart',duration:'2022-2026'}] });
  else if (stage === 'header') text = '```json\n' + JSON.stringify({ name:'Naivedya Jain', title:'Product Leader', contact:{email:'n@x.com'}, summary:'s', skills:['AI'], education:[{degree:'BTech',school:'IIIT',year:'2015'}] }) + '\n```\ndone {x}';
  else if (stage === 'ats') text = JSON.stringify({ overall:72, sections:[{name:'Contact',score:80}], suggestions:[] });
  else text = JSON.stringify({ bullets:['Led a team','Scaled a platform'] });
  return { ok:true, status:200, json: async () => ({ content:[{type:'text',text}], stop_reason:'end_turn', usage:{input_tokens:100,output_tokens:50} }) };
};

const { handler } = require('../netlify/functions/analyze.js');
const call = (b, m='POST') => handler({ httpMethod:m, body: JSON.stringify(b) });
const reset = m => { mode=m; calls=0; attemptsByStage={}; };

(async () => {
  console.log('\n[happy paths]');
  reset('happy');
  let r = await call({ action:'refine', resumeText:'x'.repeat(200) });
  let b = JSON.parse(r.body);
  ok('refine 200', r.statusCode===200, r.statusCode);
  ok('refine has 2 jobs with bullets', b.data.experience.length===2 && b.data.experience.every(j=>j.bullets.length===2));
  ok('refine carries requestId + elapsedMs', !!b.requestId && typeof b.elapsedMs==='number');

  reset('happy');
  r = await call({ action:'ats_score', resumeText:'x'.repeat(200) });
  ok('ats_score 200 (would have crashed on missing builder)', r.statusCode===200, r.statusCode + ' ' + r.body.slice(0,120));

  console.log('\n[input guards]');
  ok('empty text -> NO_RESUME_TEXT 400', JSON.parse((await call({action:'refine',resumeText:'  '})).body).error==='NO_RESUME_TEXT');
  ok('bad action -> BAD_ACTION 400', JSON.parse((await call({action:'nope',resumeText:'x'.repeat(200)})).body).error==='BAD_ACTION');
  ok('oversize -> RESUME_TOO_LONG 413', JSON.parse((await call({action:'refine',resumeText:'x'.repeat(70000)})).body).error==='RESUME_TOO_LONG');
  ok('jd_optimize without jd -> NO_JD', JSON.parse((await call({action:'jd_optimize',resumeText:'x'.repeat(200)})).body).error==='NO_JD');
  ok('GET -> METHOD_NOT_ALLOWED 405', (await handler({httpMethod:'GET',body:'{}'})).statusCode===405);
  const malformed = await handler({ httpMethod:'POST', body:'{not json' });
  ok('malformed body -> BAD_REQUEST_BODY 400', JSON.parse(malformed.body).error==='BAD_REQUEST_BODY');
  ok('chat without state -> BAD_CHAT_STATE', JSON.parse((await call({action:'chat'})).body).error==='BAD_CHAT_STATE');

  console.log('\n[upstream failures]');
  reset('auth');
  b = JSON.parse((await call({action:'refine',resumeText:'x'.repeat(200)})).body);
  ok('401 -> AUTH_FAILED, no retry', b.error==='AUTH_FAILED' && calls===1, b.error+' calls='+calls);
  ok('AUTH_FAILED carries a hint', !!b.hint && b.hint.includes('key'));

  reset('model');
  b = JSON.parse((await call({action:'refine',resumeText:'x'.repeat(200)})).body);
  ok('404 -> MODEL_NOT_FOUND, no retry', b.error==='MODEL_NOT_FOUND' && calls===1, b.error+' calls='+calls);

  reset('prose');
  b = JSON.parse((await call({action:'refine',resumeText:'x'.repeat(200)})).body);
  ok('non-JSON -> UNPARSEABLE after 3 tries', b.error==='UNPARSEABLE' && calls===3, b.error+' calls='+calls);
  ok('UNPARSEABLE includes what model said', (b.detail||'').includes('I cannot do that'));

  reset('trunc');
  b = JSON.parse((await call({action:'refine',resumeText:'x'.repeat(200)})).body);
  ok('max_tokens -> TRUNCATED', b.error==='TRUNCATED', b.error);

  console.log('\n[resilience]');
  reset('flaky');
  r = await call({ action:'refine', resumeText:'x'.repeat(200) });
  b = JSON.parse(r.body);
  ok('transient 529 retried then succeeded', r.statusCode===200 && b.data.experience.length===2, r.statusCode+' '+(b.error||''));

  console.log('\n[every error names its stage]');
  reset('prose');
  b = JSON.parse((await call({action:'refine',resumeText:'x'.repeat(200)})).body);
  ok('error has stage', !!b.stage, JSON.stringify(b.stage));
  ok('error has requestId', !!b.requestId);
  ok('error has version', b.version==='2.0.0');

  console.log('\n[timings + concurrency]');
  reset('happy');
  let started = 0, peak = 0;
  const realFetch = global.fetch;
  global.fetch = async (u, o) => { started++; peak = Math.max(peak, started); try { return await realFetch(u, o); } finally { started--; } };
  r = await call({ action:'refine', resumeText:'x'.repeat(200) });
  b = JSON.parse(r.body);
  global.fetch = realFetch;
  ok('success carries timings', Array.isArray(b.timings) && b.timings.length >= 3, JSON.stringify(b.timings||[]).slice(0,120));
  ok('timings name their stage', (b.timings||[]).every(t => typeof t.stage === 'string'));
  ok('concurrency stays within cap', peak <= 4, 'peak=' + peak);

  reset('prose');
  b = JSON.parse((await call({ action:'refine', resumeText:'x'.repeat(200) })).body);
  ok('failure also carries timings', Array.isArray(b.timings) && b.timings.length > 0, JSON.stringify(b.timings||[]).slice(0,120));

  console.log(`\n${pass} passed, ${failn} failed`);
  process.exit(failn ? 1 : 0);
})();
