// Netlify Serverless Function - Claude Sonnet API Integration
// Location: netlify/functions/analyze.js

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';

// ============================================
// CONFIGURATION - CUSTOMIZE PER INSTANCE
// ============================================
const CONFIG = {
    // IMPORTANT: Set ANTHROPIC_API_KEY in Netlify Environment Variables
    // Go to: Netlify Dashboard > Site Settings > Environment Variables
    // Add: ANTHROPIC_API_KEY = your_api_key_here
    
    model: 'claude-sonnet-4-6',
    maxTokens: 16000,
    
    // Instance-specific context (customize for FaujiTech vs Akki.club)
    systemPrompt: `You are an expert resume consultant and career coach. Your goal is to help users create ATS-optimized, impactful resumes that get interviews.

## Core Principles:
1. **Action Verbs**: Use strong verbs - Led, Built, Drove, Achieved, Scaled, Launched, Delivered
2. **Quantify Impact**: Every bullet should have numbers when possible (%, $, users, team size)
3. **ATS Optimization**: Clean formatting, standard section headers, relevant keywords
4. **Concise & Impactful**: Each bullet should be 1-2 lines max, starting with action verb
5. **Relevance**: Prioritize recent and relevant experience

## Resume Sections:
- **Summary**: 2-3 sentences, lead with years of experience and biggest achievement
- **Experience**: Reverse chronological, 3-5 bullets per role, achievement-focused
- **Skills**: Relevant keywords, organized by category if needed
- **Education**: Degree, institution, year (GPA only if recent grad and >3.5)

## Output Format:
When analyzing or improving a resume, return valid JSON with this structure:
{
    "name": "Full Name",
    "title": "Professional Title",
    "contact": {
        "email": "",
        "linkedin": "",
        "location": "",
        "phone": ""
    },
    "summary": "Professional summary text",
    "experience": [
        {
            "title": "Job Title",
            "company": "Company Name",
            "duration": "Date Range",
            "bullets": ["Achievement 1", "Achievement 2", "Achievement 3"]
        }
    ],
    "skills": ["Skill 1", "Skill 2"],
    "education": [
        {
            "degree": "Degree Name",
            "school": "School Name",
            "year": "Year"
        }
    ]
}

## ATS Score Analysis:
When scoring, evaluate these sections (0-100 each):
- Contact Information: Is it complete and professional?
- Professional Summary: Is it impactful with quantified achievements?
- Work Experience: Are there strong action verbs and metrics?
- Skills Section: Are relevant keywords present?
- Education: Is it properly formatted?
- Keywords & ATS: Does it have industry-relevant terms?

Return analysis as:
{
    "overall": 75,
    "sections": [
        {"name": "Section Name", "score": 85}
    ],
    "suggestions": [
        {
            "type": "critical|warning|tip",
            "title": "Issue Title",
            "description": "Detailed suggestion"
        }
    ]
}

[INSTANCE-SPECIFIC INSTRUCTIONS BELOW]
---
ADD YOUR CUSTOM INSTRUCTIONS HERE

For FaujiTech instance, add:
- Military rank to civilian title mapping
- Defense terminology to corporate language translation
- Government/PSU specific keywords
- Indian Armed Forces context

For Akki.club instance, add:
- Fresher-friendly guidance
- Campus placement context
- Startup vs corporate language differences
- Indian job market specific keywords
---
`
};

const VERSION = '2.0.0';

// Netlify's synchronous function limit is 60s and is not configurable, so the
// whole request has to finish inside it. Every stage is timed against one
// shared budget and every failure names the stage it happened in.
const BUDGET_MS = 45000;
const CHUNK_MAX_TOKENS = 2000;
const MAX_JOBS = 15;
const MAX_RESUME_CHARS = 60000;
const MAX_ATTEMPTS = 3;

// ============================================
// LOGGING
// Every line is single-line JSON prefixed with [resume-opt] so it can be
// grepped straight out of the Netlify function log:
//   [resume-opt] {"lvl":"error","code":"CHUNK_FAILED","stage":"job:2",...}
// ============================================
function log(fields) {
    try {
        console.log('[resume-opt] ' + JSON.stringify({ v: VERSION, t: new Date().toISOString(), ...fields }));
    } catch (e) {
        console.log('[resume-opt] {"lvl":"error","msg":"log serialization failed"}');
    }
}

function newRequestId() {
    return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}

// Every error leaves by this door. Same shape every time, always logged,
// always carries the stage and a human-readable next step.
function fail(headers, status, code, stage, message, opts = {}) {
    const payload = {
        success: false,
        error: code,
        stage,
        message,
        hint: opts.hint || HINTS[code] || 'Check the Netlify function log for the matching requestId.',
        requestId: opts.requestId,
        elapsedMs: opts.elapsedMs,
        version: VERSION
    };
    if (opts.detail) payload.detail = String(opts.detail).slice(0, 1500);
    log({ lvl: 'error', code, stage, status, msg: message, ...opts.logFields, requestId: opts.requestId, elapsedMs: opts.elapsedMs });
    return { statusCode: status, headers, body: JSON.stringify(payload) };
}

const HINTS = {
    NO_API_KEY: 'Set ANTHROPIC_API_KEY in Netlify > Site settings > Environment variables, then redeploy.',
    BAD_REQUEST_BODY: 'The browser sent malformed JSON. Hard-refresh the page and retry.',
    NO_RESUME_TEXT: 'Nothing readable came out of the file. Scanned/image PDFs have no text layer — export a text PDF or upload a DOCX.',
    RESUME_TOO_LONG: 'Trim the resume and retry.',
    NO_JD: 'Paste the job description before optimizing.',
    AUTH_FAILED: 'The API key was rejected. Check the key value in Netlify environment variables.',
    RATE_LIMITED: 'Anthropic rate-limited the account. Wait a moment and retry.',
    MODEL_NOT_FOUND: 'The configured model id was rejected. Check CONFIG.model in analyze.js against the current Anthropic model list.',
    UPSTREAM_ERROR: 'Anthropic returned an error. The detail field has the raw response.',
    NO_JOBS_FOUND: 'No work experience was detected. Confirm the uploaded file is actually a resume and that text extracted correctly.',
    CHUNK_FAILED: 'One position failed to rewrite after retries. The stage field names which one.',
    UNPARSEABLE: 'The model replied with something other than JSON. The detail field has the first part of what it actually said.',
    TRUNCATED: 'Output hit max_tokens. Raise CHUNK_MAX_TOKENS or shorten the resume.',
    TIMEOUT: 'The run exceeded the internal budget. Check elapsedMs and the per-stage timings in the log.',
    INCOMPLETE_RESUME: 'The assembled resume failed its shape check, so it was not sent to the browser.',
    INTERNAL: 'Unhandled exception. The detail field has the message and the log has the stack.'
};

// ============================================
// HANDLER
// ============================================
exports.handler = async (event, context) => {
    const headers = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Content-Type': 'application/json'
    };

    if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };

    const requestId = newRequestId();
    const started = Date.now();
    const ms = () => Date.now() - started;

    // Nothing below this line is allowed to throw past this catch. A function
    // that crashes returns a platform 502 with a non-JSON body, which is
    // exactly the un-diagnosable failure this file is built to avoid.
    try {
        if (event.httpMethod !== 'POST') {
            return fail(headers, 405, 'METHOD_NOT_ALLOWED', 'entry', 'Only POST is accepted.', { requestId, elapsedMs: ms() });
        }

        let body;
        try {
            body = JSON.parse(event.body || '{}');
        } catch (e) {
            return fail(headers, 400, 'BAD_REQUEST_BODY', 'parse-body', 'Request body was not valid JSON.', { requestId, elapsedMs: ms(), detail: e.message });
        }

        const action = body.action;
        const resumeText = typeof body.resumeText === 'string' ? body.resumeText : '';
        const jdText = typeof body.jdText === 'string' ? body.jdText : '';

        log({ lvl: 'info', msg: 'start', requestId, action, resumeChars: resumeText.length, jdChars: jdText.length });

        const apiKey = process.env.ANTHROPIC_API_KEY;
        if (!apiKey) {
            return fail(headers, 500, 'NO_API_KEY', 'config', 'ANTHROPIC_API_KEY is not set in this environment.', { requestId, elapsedMs: ms() });
        }

        // Cheap config check: hit the API with a 10-token request and report
        // exactly what comes back. Call it before debugging anything else.
        if (action === 'health') {
            return await runHealthCheck(apiKey, headers, requestId, started);
        }

        const VALID = ['ats_score', 'refine', 'jd_optimize', 'chat', 'health'];
        if (!VALID.includes(action)) {
            return fail(headers, 400, 'BAD_ACTION', 'entry', `Unknown action "${action}".`, {
                requestId, elapsedMs: ms(), hint: `Use one of: ${VALID.join(', ')}.`
            });
        }

        if (action !== 'chat') {
            if (resumeText.trim().length < 50) {
                return fail(headers, 400, 'NO_RESUME_TEXT', 'validate-input',
                    `Only ${resumeText.trim().length} characters of resume text were received (need at least 50).`,
                    { requestId, elapsedMs: ms() });
            }
            if (resumeText.length > MAX_RESUME_CHARS) {
                return fail(headers, 413, 'RESUME_TOO_LONG', 'validate-input',
                    `Resume is ${resumeText.length} characters; the limit is ${MAX_RESUME_CHARS}.`,
                    { requestId, elapsedMs: ms() });
            }
        }
        if (action === 'jd_optimize' && jdText.trim().length < 20) {
            return fail(headers, 400, 'NO_JD', 'validate-input', 'Job description is empty or too short.', { requestId, elapsedMs: ms() });
        }
        if (action === 'chat' && (!body.currentResume || !Array.isArray(body.chatHistory) || body.chatHistory.length === 0)) {
            return fail(headers, 400, 'BAD_CHAT_STATE', 'validate-input', 'Chat needs both currentResume and a non-empty chatHistory.', { requestId, elapsedMs: ms() });
        }

        const ctx = { requestId, started, warnings: [] };
        let result;

        if (action === 'ats_score') {
            result = await callClaude(apiKey, buildATSScorePrompt(resumeText), 4000, { ...ctx, stage: 'ats' });
        } else if (action === 'chat') {
            result = await callClaude(apiKey, buildChatPrompt(body.currentResume, body.chatHistory), 8000, { ...ctx, stage: 'chat' });
        } else {
            result = await buildResumeInParallel(apiKey, resumeText, action === 'jd_optimize' ? jdText : null, ctx);
        }

        const shapeError = validateShape(action, result);
        if (shapeError) {
            return fail(headers, 502, 'INCOMPLETE_RESUME', 'validate-output', shapeError, {
                requestId, elapsedMs: ms(), detail: JSON.stringify(result).slice(0, 1000)
            });
        }

        log({ lvl: 'info', msg: 'done', requestId, action, elapsedMs: ms(), warnings: ctx.warnings.length, jobs: result.experience ? result.experience.length : undefined });

        return {
            statusCode: 200,
            headers,
            body: JSON.stringify({
                success: true,
                data: result,
                warnings: ctx.warnings,
                requestId,
                elapsedMs: ms(),
                version: VERSION
            })
        };

    } catch (error) {
        const known = error && error.code && HINTS[error.code];
        if (known) {
            return fail(headers, error.status || 502, error.code, error.stage || 'unknown', error.message, {
                requestId, elapsedMs: ms(), detail: error.detail
            });
        }
        log({ lvl: 'error', msg: 'unhandled', requestId, elapsedMs: ms(), err: error && error.message, stack: error && error.stack ? String(error.stack).slice(0, 1200) : undefined });
        return fail(headers, 500, 'INTERNAL', (error && error.stage) || 'unknown',
            (error && error.message) || 'Unknown error', { requestId, elapsedMs: ms() });
    }
};

// Errors that already know their own code/stage travel with them.
function appError(code, stage, message, extra = {}) {
    const e = new Error(message);
    e.code = code;
    e.stage = stage;
    Object.assign(e, extra);
    return e;
}

// ============================================
// HEALTH CHECK
// ============================================
async function runHealthCheck(apiKey, headers, requestId, started) {
    const t0 = Date.now();
    try {
        const res = await fetch(ANTHROPIC_API_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
            body: JSON.stringify({ model: CONFIG.model, max_tokens: 10, messages: [{ role: 'user', content: 'Reply with the single word: ok' }] })
        });
        const text = await res.text();
        const ok = res.ok;
        log({ lvl: ok ? 'info' : 'error', msg: 'health', requestId, status: res.status, model: CONFIG.model, latencyMs: Date.now() - t0 });
        return {
            statusCode: ok ? 200 : 502,
            headers,
            body: JSON.stringify({
                success: ok,
                checks: {
                    apiKeyPresent: true,
                    model: CONFIG.model,
                    upstreamStatus: res.status,
                    upstreamLatencyMs: Date.now() - t0,
                    budgetMs: BUDGET_MS
                },
                detail: ok ? undefined : text.slice(0, 800),
                requestId,
                version: VERSION
            })
        };
    } catch (e) {
        return fail(headers, 502, 'UPSTREAM_ERROR', 'health', e.message, { requestId, elapsedMs: Date.now() - started });
    }
}

// ============================================
// PARALLEL RESUME BUILD
// ============================================
async function buildResumeInParallel(apiKey, resumeText, jdText, ctx) {
    const outline = await callClaude(apiKey, buildOutlinePrompt(resumeText), 1500, { ...ctx, stage: 'outline' });

    if (!outline || !Array.isArray(outline.jobs) || outline.jobs.length === 0) {
        throw appError('NO_JOBS_FOUND', 'outline', 'The outline pass found no work experience in this document.',
            { status: 422, detail: JSON.stringify(outline).slice(0, 600) });
    }

    let jobs = outline.jobs.filter(j => j && (j.title || j.company));
    if (jobs.length === 0) {
        throw appError('NO_JOBS_FOUND', 'outline', 'Outline returned job entries with no title or company.', { status: 422 });
    }
    if (jobs.length > MAX_JOBS) {
        ctx.warnings.push(`Resume listed ${jobs.length} positions; only the first ${MAX_JOBS} were rewritten.`);
        log({ lvl: 'warn', msg: 'job-cap', requestId: ctx.requestId, found: jobs.length, cap: MAX_JOBS });
        jobs = jobs.slice(0, MAX_JOBS);
    }

    log({ lvl: 'info', msg: 'outline-ok', requestId: ctx.requestId, jobs: jobs.length, elapsedMs: Date.now() - ctx.started });

    // allSettled so one bad chunk cannot reject the whole batch before the
    // others finish — we want to report which one failed, not just that
    // something did.
    const settled = await Promise.allSettled([
        callClaude(apiKey, buildHeaderPrompt(resumeText, jdText), CHUNK_MAX_TOKENS, { ...ctx, stage: 'header' }),
        ...jobs.map((j, i) => callClaude(apiKey, buildJobPrompt(resumeText, j, jdText), CHUNK_MAX_TOKENS,
            { ...ctx, stage: `job:${i}:${(j.company || j.title || '').slice(0, 30)}` }))
    ]);

    const headerResult = settled[0];
    if (headerResult.status === 'rejected') {
        const e = headerResult.reason;
        throw appError(e.code || 'CHUNK_FAILED', 'header', `Header section failed: ${e.message}`, { status: 502, detail: e.detail });
    }
    const header = headerResult.value;

    const experience = [];
    for (let i = 0; i < jobs.length; i++) {
        const r = settled[i + 1];
        const j = jobs[i];
        const label = `${j.title || '?'} at ${j.company || '?'}`;

        if (r.status === 'rejected') {
            // Fail loudly and name the role. Silently dropping it is what
            // produced a "blank" resume in the first place.
            throw appError('CHUNK_FAILED', `job:${i}`, `Could not rewrite "${label}": ${r.reason.message}`,
                { status: 502, detail: r.reason.detail });
        }
        const bullets = (r.value && Array.isArray(r.value.bullets)) ? r.value.bullets.filter(b => typeof b === 'string' && b.trim()) : [];
        if (bullets.length === 0) {
            throw appError('CHUNK_FAILED', `job:${i}`, `"${label}" came back with zero bullet points.`,
                { status: 502, detail: JSON.stringify(r.value).slice(0, 400) });
        }
        experience.push({ title: j.title || '', company: j.company || '', duration: j.duration || '', bullets });
    }

    const resume = {
        name: header.name || '',
        title: header.title || '',
        contact: (header.contact && typeof header.contact === 'object') ? header.contact : {},
        summary: header.summary || '',
        experience,
        skills: Array.isArray(header.skills) ? header.skills : [],
        education: Array.isArray(header.education) ? header.education : []
    };
    if (jdText && header.jdMatch) resume.jdMatch = header.jdMatch;

    if (!resume.name) ctx.warnings.push('No name was found in the resume header.');
    if (resume.skills.length === 0) ctx.warnings.push('No skills section was detected.');
    if (resume.education.length === 0) ctx.warnings.push('No education section was detected.');

    return resume;
}

// ============================================
// CLAUDE CALL — retries, budget, per-attempt logging
// ============================================
async function callClaude(apiKey, prompt, maxTokens, ctx) {
    const stage = ctx.stage || 'unknown';
    let lastError;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        const remaining = BUDGET_MS - (Date.now() - ctx.started);
        if (remaining <= 2000) {
            throw appError('TIMEOUT', stage, `Ran out of time budget before attempt ${attempt} (${remaining}ms left of ${BUDGET_MS}ms).`, { status: 504 });
        }

        const t0 = Date.now();
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), remaining);

        try {
            const response = await fetch(ANTHROPIC_API_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
                body: JSON.stringify({
                    model: CONFIG.model,
                    max_tokens: maxTokens,
                    system: CONFIG.systemPrompt,
                    messages: [{ role: 'user', content: prompt }]
                }),
                signal: controller.signal
            });

            if (!response.ok) {
                const errorText = await response.text();
                const s = response.status;
                log({ lvl: 'warn', msg: 'upstream-not-ok', requestId: ctx.requestId, stage, attempt, status: s, ms: Date.now() - t0, detail: errorText.slice(0, 300) });

                // Permanent failures: stop immediately, retrying cannot help.
                if (s === 401 || s === 403) throw appError('AUTH_FAILED', stage, `Anthropic rejected the API key (HTTP ${s}).`, { status: 502, detail: errorText.slice(0, 400) });
                if (s === 404) throw appError('MODEL_NOT_FOUND', stage, `Model "${CONFIG.model}" was not found (HTTP 404).`, { status: 502, detail: errorText.slice(0, 400) });
                if (s === 400) throw appError('UPSTREAM_ERROR', stage, `Anthropic rejected the request (HTTP 400).`, { status: 502, detail: errorText.slice(0, 400) });

                // Transient: 429 / 5xx / 529 overloaded
                lastError = appError(s === 429 ? 'RATE_LIMITED' : 'UPSTREAM_ERROR', stage, `Anthropic returned HTTP ${s}.`, { status: 502, detail: errorText.slice(0, 400) });
            } else {
                const data = await response.json();

                if (data.stop_reason === 'max_tokens') {
                    throw appError('TRUNCATED', stage, `Output hit the ${maxTokens}-token cap and was cut off.`, { status: 502 });
                }

                const textBlock = (data.content || []).find(b => b && b.type === 'text');
                const raw = textBlock ? textBlock.text : '';
                const parsed = extractJSON(raw);

                if (parsed) {
                    log({
                        lvl: 'info', msg: 'chunk-ok', requestId: ctx.requestId, stage, attempt,
                        ms: Date.now() - t0,
                        inTok: data.usage && data.usage.input_tokens,
                        outTok: data.usage && data.usage.output_tokens
                    });
                    return parsed;
                }

                // Non-JSON reply: worth one more roll, but log what it said.
                log({ lvl: 'warn', msg: 'unparseable', requestId: ctx.requestId, stage, attempt, ms: Date.now() - t0, said: raw.slice(0, 300) });
                lastError = appError('UNPARSEABLE', stage, 'Model replied with something other than JSON.', { status: 502, detail: raw.slice(0, 800) });
            }
        } catch (e) {
            if (e.code && HINTS[e.code] && e.code !== 'UNPARSEABLE' && e.code !== 'RATE_LIMITED' && e.code !== 'UPSTREAM_ERROR') throw e;
            if (e.name === 'AbortError') {
                throw appError('TIMEOUT', stage, `Request aborted after ${Date.now() - t0}ms — the ${BUDGET_MS}ms budget ran out.`, { status: 504 });
            }
            lastError = e.code ? e : appError('UPSTREAM_ERROR', stage, e.message || 'Network error calling Anthropic.', { status: 502 });
            log({ lvl: 'warn', msg: 'attempt-failed', requestId: ctx.requestId, stage, attempt, ms: Date.now() - t0, err: e.message });
        } finally {
            clearTimeout(timer);
        }

        if (attempt < MAX_ATTEMPTS) {
            await new Promise(r => setTimeout(r, 400 * attempt));
        }
    }

    log({ lvl: 'error', msg: 'chunk-exhausted', requestId: ctx.requestId, stage, attempts: MAX_ATTEMPTS });
    throw lastError || appError('UPSTREAM_ERROR', stage, `Failed after ${MAX_ATTEMPTS} attempts.`, { status: 502 });
}

// ============================================
// PARSING + VALIDATION
// ============================================

// The original /\{[\s\S]*\}/ spanned the first brace to the LAST brace in the
// whole reply, so any trailing prose containing a brace broke it. Scan for one
// balanced object instead, ignoring braces inside strings.
function extractJSON(text) {
    if (!text || typeof text !== 'string') return null;

    let s = text.trim();
    const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fence) s = fence[1].trim();

    const start = s.indexOf('{');
    if (start === -1) return null;

    let depth = 0, inString = false, escaped = false;
    for (let i = start; i < s.length; i++) {
        const c = s[i];
        if (escaped) { escaped = false; continue; }
        if (c === '\\') { escaped = true; continue; }
        if (c === '"') { inString = !inString; continue; }
        if (inString) continue;
        if (c === '{') depth++;
        else if (c === '}') {
            depth--;
            if (depth === 0) {
                try { return JSON.parse(s.slice(start, i + 1)); }
                catch (e) { return null; }
            }
        }
    }
    return null;   // never closed => truncated
}

function validateShape(action, obj) {
    if (!obj || typeof obj !== 'object') return 'Response was not an object.';

    if (action === 'ats_score') {
        if (typeof obj.overall !== 'number') return 'Missing overall score.';
        if (!Array.isArray(obj.sections) || obj.sections.length === 0) return 'Missing section scores.';
        if (!Array.isArray(obj.suggestions)) obj.suggestions = [];
        return null;
    }

    if (action === 'chat') {
        const upd = obj.updatedResume || obj.updated_resume || obj.resume;
        if (!upd) return null;   // advice-only replies are legitimate
        if (!Array.isArray(upd.experience) || upd.experience.length === 0) {
            return 'Updated resume came back with no work experience.';
        }
        return null;
    }

    if (!Array.isArray(obj.experience) || obj.experience.length === 0) return 'Assembled resume has no work experience.';
    if (obj.experience.some(j => !Array.isArray(j.bullets) || j.bullets.length === 0)) return 'At least one position has no bullet points.';
    return null;
}
function buildATSScorePrompt(resumeText) {
    return `Analyze this resume for ATS compatibility and provide a detailed score.

RESUME:
---
${resumeText}
---

Provide your analysis as JSON with this exact structure:
{
    "overall": <number 0-100>,
    "sections": [
        {"name": "Contact Information", "score": <number>},
        {"name": "Professional Summary", "score": <number>},
        {"name": "Work Experience", "score": <number>},
        {"name": "Skills Section", "score": <number>},
        {"name": "Education", "score": <number>},
        {"name": "Keywords & ATS", "score": <number>}
    ],
    "suggestions": [
        {
            "type": "critical|warning|tip",
            "title": "<short title>",
            "description": "<actionable suggestion>"
        }
    ]
}

Be specific and actionable. Focus on the top 4-6 issues.
Return ONLY the JSON, no additional text.`;
}

function buildOutlinePrompt(resumeText) {
    return `List every work position in this resume, in the order they appear.
Do NOT rewrite anything. Do NOT include bullet points. Headers only.

RESUME:
---
${resumeText}
---

Return ONLY this JSON:
{
    "jobs": [
        {"title": "exact job title", "company": "exact company name", "duration": "exact date range"}
    ]
}

Include EVERY position, including internships and short stints. Copy the titles,
companies and dates exactly as written. Return ONLY the JSON.`;
}

function buildHeaderPrompt(resumeText, jdText) {
    const jdBlock = jdText ? `

JOB DESCRIPTION TO TARGET:
---
${jdText}
---
Tailor the summary and skill ordering to this JD. Do not invent experience.` : '';

    return `From this resume, produce ONLY the header sections. Do NOT include work experience bullets.

RESUME:
---
${resumeText}
---${jdBlock}

Rules:
- Use the person's ACTUAL name, email, phone, location, LinkedIn as written
- No placeholders like "X%" or "[Company]" — real values only
- Summary: 2-3 sentences using their real achievements and metrics
- Skills: every skill from the original${jdText ? ', ordered by relevance to the JD' : ''}

Return ONLY this JSON:
{
    "name": "actual full name",
    "title": "their actual title | key expertise",
    "contact": {"email": "", "linkedin": "", "location": "", "phone": ""},
    "summary": "",
    "skills": [],
    "education": [{"degree": "", "school": "", "year": ""}]${jdText ? `,
    "jdMatch": {"score": 0, "matchedKeywords": [], "missingKeywords": [], "recommendations": []}` : ''}
}`;
}

function buildJobPrompt(resumeText, job, jdText) {
    const jdBlock = jdText ? `

JOB DESCRIPTION TO TARGET:
---
${jdText}
---
Order the bullets so the most JD-relevant achievements come first, and work in
JD keywords where they honestly fit. Keep every bullet.` : '';

    return `Below is a full resume. Rewrite the bullet points for ONE position only.

RESUME:
---
${resumeText}
---

THE POSITION TO WORK ON:
${job.title} at ${job.company} (${job.duration})${jdBlock}

Rules:
- Return EVERY bullet that belongs to this position. Do not drop or merge any.
- Start each bullet with a strong action verb (Led, Built, Drove, Scaled, Delivered)
- Keep all existing numbers, percentages and currency figures exactly as written
- Never substitute a placeholder for a real value
- 1-2 lines per bullet
- Ignore all other positions in the resume

Return ONLY this JSON:
{"bullets": ["improved bullet 1", "improved bullet 2"]}`;
}

function buildChatPrompt(currentResume, chatHistory) {
    const historyText = (chatHistory || []).map(msg =>
        `${msg.role.toUpperCase()}: ${msg.content}`
    ).join('\n');

    return `You are helping refine a resume through conversation.

CURRENT RESUME STATE:
---
${JSON.stringify(currentResume, null, 2)}
---

CONVERSATION HISTORY:
---
${historyText}
---

CRITICAL RULES:
1. KEEP ALL DATA — never redact or remove any information
2. PRESERVE ALL JOBS — include every position in your response
3. USE REAL VALUES — no placeholders like "X%"
4. COMPLETE OUTPUT — return the FULL resume, not just changed parts

Based on the user's latest request, make the appropriate changes.

Return ONLY this JSON:
{
    "message": "brief explanation of what you changed",
    "updatedResume": {
        "name": "", "title": "",
        "contact": {"email": "", "linkedin": "", "location": "", "phone": ""},
        "summary": "",
        "experience": [{"title": "", "company": "", "duration": "", "bullets": []}],
        "skills": [],
        "education": [{"degree": "", "school": "", "year": ""}]
    }
}`;
}
