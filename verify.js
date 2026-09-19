// Pre-flight: everything that must hold before these files go anywhere.
const fs = require('fs'), path = require('path'), vm = require('vm');
const ROOT = path.join(__dirname, '..');
let pass = 0, fail = 0;
const ok = (n, c, x='') => { c ? (pass++, console.log('  ✓ ' + n)) : (fail++, console.log('  ✗ ' + n + (x ? '  <-- ' + x : ''))); };

const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const inline = (html.match(/<script>([\s\S]*?)<\/script>/g) || []).map(s => s.replace(/<\/?script>/g, '')).join('\n');

// Strip comments and string/template literals so a CSS rule or a sentence
// inside a string is never mistaken for a call site.
function stripLiterals(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
    .replace(/`(?:\\.|[^`\\])*`/g, '``')
    .replace(/'(?:\\.|[^'\\\n])*'/g, "''")
    .replace(/"(?:\\.|[^"\\\n])*"/g, '""');
}
const KEYWORDS = new Set(['if','for','while','switch','catch','return','function','typeof','new','delete','void','in','of','do','else','try','finally','throw','await','async','yield','case','break','continue','var','let','const','class','extends','super','this','instanceof']);
const code = stripLiterals(inline);

console.log('\n=== 1. every function the HTML calls via on* attributes exists ===');
const handlers = new Set();
for (const m of html.matchAll(/\son(?:click|change|input|submit|keypress|keydown)\s*=\s*"([^"]+)"/g)) {
  for (const c of m[1].matchAll(/([A-Za-z_$][\w$]*)\s*\(/g)) handlers.add(c[1]);
}
const declared = new Set();
for (const m of inline.matchAll(/(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g)) declared.add(m[1]);
for (const m of inline.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/g)) declared.add(m[1]);
const DOM = new Set(['getElementById','querySelector','querySelectorAll','createElement','appendChild','removeChild','remove','click','preventDefault','stopPropagation','focus','blur','scrollIntoView','addEventListener','removeEventListener','getAttribute','setAttribute','classList','setInterval','clearInterval','setTimeout','clearTimeout','requestAnimationFrame','jsPDF','Blob','URL','FileReader','Image','AbortController','Promise','Set','Map','RegExp','Error','navigator','localStorage','performance','mammoth','pdfjsLib','html2canvas']);
const BROWSER = new Set(['alert','confirm','parseInt','parseFloat','String','Number','Boolean','Array','Object','JSON','Math','Date','setTimeout','clearTimeout','requestAnimationFrame','fetch','encodeURIComponent','decodeURIComponent','console','isNaN','event','this']);
const missingHandlers = [...handlers].filter(h => !declared.has(h) && !BROWSER.has(h) && !KEYWORDS.has(h) && !(h in global) && !DOM.has(h));
ok(`${handlers.size} inline handlers all defined`, missingHandlers.length === 0, missingHandlers.join(', '));

console.log('\n=== 2. every app function called in the script exists ===');
const called = new Set();
for (const m of code.matchAll(/(?:^|[^\w$.])([a-zA-Z_$][A-Za-z0-9_$]{2,})\s*\(/g)) called.add(m[1]);
const KNOWN = new Set([...BROWSER,'map','join','filter','forEach','split','slice','replace','push','trim','then','catch','indexOf','includes','toFixed','charAt','match','every','some','find','reduce','sort','concat','substring','toLowerCase','toUpperCase','stringify','parse','max','min','round','abs','pow','now','from','keys','values','entries','isArray','querySelector','querySelectorAll','getElementById','createElement','appendChild','remove','add','contains','toggle','focus','scrollIntoView','addEventListener','removeEventListener','preventDefault','getAttribute','setAttribute','setItem','getItem','removeItem','writeText','arrayBuffer','text','json','getDocument','getPage','getTextContent','extractRawText','warn','error','log','group','groupEnd','innerHTML','isVisible','cssText','startsWith','endsWith','repeat','padStart','padEnd','test','exec','apply','call','bind','fromCharCode','toString','valueOf','hasOwnProperty','freeze','assign','resolve','reject','all','race','allSettled','random','floor','ceil','sqrt','deleteRow','insertRow','save','addImage','setFontSize','setFont','setTextColor','setDrawColor','setFillColor','rect','line','splitTextToSize','addPage','getTextWidth','text2','fill','stroke']);
const missingCalls = [...called].filter(f => !declared.has(f) && !KNOWN.has(f) && !KEYWORDS.has(f) && !DOM.has(f));
ok(`no undefined app functions (${called.size} call sites scanned)`, missingCalls.length === 0, missingCalls.join(', '));

console.log('\n=== 3. dead references to removed code ===');
ok('no silent mockResume fallback', !/=\s*mockResume\(\)/.test(inline));
ok('no silent mockATS fallback', !/=\s*mockATS\(\)/.test(inline));
ok('no stale "I\'ve made the changes" on failure', !/catch[^}]*I've made the changes/.test(inline));
ok('no leftover bare res.ok handling', !/if\(res\.ok\)\{const r=await res\.json/.test(inline));

console.log('\n=== 4. server function: parse, exports, referenced names ===');
const fnSrc = fs.readFileSync(path.join(ROOT, 'netlify/functions/analyze.js'), 'utf8');
let fnDeclared = new Set();
for (const m of fnSrc.matchAll(/^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gm)) fnDeclared.add(m[1]);
for (const m of fnSrc.matchAll(/^(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/gm)) fnDeclared.add(m[1]);
const fnCalled = new Set();
for (const m of fnSrc.matchAll(/(?:^|[^\w$.])((?:build|validate|extract|run|call|new|app|log|fail)[A-Za-z0-9_$]*)\s*\(/g)) fnCalled.add(m[1]);
const fnMissing = [...fnCalled].filter(f => !fnDeclared.has(f) && !['newRequestId','new'].includes(f) || (f==='newRequestId' && !fnDeclared.has(f)));
ok('every referenced helper defined', fnMissing.length === 0, fnMissing.join(', '));
const mod = require(path.join(ROOT, 'netlify/functions/analyze.js'));
ok('exports.handler is a function', typeof mod.handler === 'function');

console.log('\n=== 5. other functions in the repo still parse ===');
for (const f of fs.readdirSync(path.join(ROOT, 'netlify/functions'))) {
  if (!f.endsWith('.js')) continue;
  try { new vm.Script(fs.readFileSync(path.join(ROOT, 'netlify/functions', f), 'utf8')); ok(f + ' parses', true); }
  catch (e) { ok(f + ' parses', false, e.message); }
}
ok('no test files inside netlify/functions', !fs.readdirSync(path.join(ROOT,'netlify/functions')).some(f=>/test/i.test(f)));

console.log('\n=== 6. config sanity ===');
const toml = fs.readFileSync(path.join(ROOT, 'netlify.toml'), 'utf8');
ok('no stale timeout override', !/timeout\s*=/.test(toml));
ok('functions dir declared', /functions\s*=\s*"netlify\/functions"/.test(toml));
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
ok('npm test runs both suites', pkg.scripts.test.includes('analyze.test.js') && pkg.scripts.test.includes('ui.smoke.js'));
ok('package.json is valid JSON', true);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
