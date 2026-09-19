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

// Netlify's synchronous function limit is 60s and is not configurable.
// A single "rewrite the whole resume" call emits 2000+ tokens and regularly
// runs past that, which the platform turns into a 502 with a non-JSON body.
// So refine/jd_optimize are split into small parallel calls and reassembled
// here: wall time becomes the slowest single chunk, not the sum.
const BUDGET_MS = 45000;          // stay clear of the 60s ceiling
const CHUNK_MAX_TOKENS = 2000;

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

    if (event.httpMethod === 'OPTIONS') {
        return { statusCode: 200, headers, body: '' };
    }

    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
    }

    const started = Date.now();

    try {
        const { action, resumeText, jdText, chatHistory, currentResume } = JSON.parse(event.body);

        const apiKey = process.env.ANTHROPIC_API_KEY;
        if (!apiKey) {
            console.error('ANTHROPIC_API_KEY not set in environment variables');
            return {
                statusCode: 500,
                headers,
                body: JSON.stringify({ error: 'API key not configured. Set ANTHROPIC_API_KEY in Netlify environment variables.' })
            };
        }

        // Scanned/image PDFs extract to nothing; without this the model replies
        // in prose instead of JSON and the UI renders an empty resume.
        if (action !== 'chat' && (!resumeText || resumeText.trim().length < 50)) {
            return {
                statusCode: 400,
                headers,
                body: JSON.stringify({
                    error: 'NO_RESUME_TEXT',
                    message: 'No readable text was extracted from the resume. If it is a scanned PDF, upload a text-based PDF or DOCX.'
                })
            };
        }

        let result;
        switch (action) {
            case 'ats_score':
                // Small output, finishes well inside the limit: single call.
                result = await callClaude(apiKey, buildATSScorePrompt(resumeText), 4000, started);
                break;
            case 'refine':
                result = await buildResumeInParallel(apiKey, resumeText, null, started);
                break;
            case 'jd_optimize':
                if (!jdText || !jdText.trim()) {
                    return { statusCode: 400, headers, body: JSON.stringify({ error: 'NO_JD', message: 'Job description is empty.' }) };
                }
                result = await buildResumeInParallel(apiKey, resumeText, jdText, started);
                break;
            case 'chat':
                result = await callClaude(apiKey, buildChatPrompt(currentResume, chatHistory), 8000, started);
                break;
            default:
                return {
                    statusCode: 400,
                    headers,
                    body: JSON.stringify({ error: 'Invalid action. Use: ats_score, refine, jd_optimize, or chat' })
                };
        }

        const validationError = validateShape(action, result);
        if (validationError) {
            console.error('Shape validation failed:', validationError, JSON.stringify(result).slice(0, 1000));
            return {
                statusCode: 502,
                headers,
                body: JSON.stringify({ error: 'INCOMPLETE_RESUME', message: validationError })
            };
        }

        console.log(`action=${action} ok in ${Date.now() - started}ms`);
        return {
            statusCode: 200,
            headers,
            body: JSON.stringify({ success: true, data: result })
        };

    } catch (error) {
        const ms = Date.now() - started;
        console.error(`Function error after ${ms}ms:`, error.message);

        // Report our own budget overrun as JSON rather than letting the
        // platform kill us and return an unparseable 502.
        const isTimeout = error.name === 'AbortError' || /budget|timed out/i.test(error.message);
        return {
            statusCode: isTimeout ? 504 : 500,
            headers,
            body: JSON.stringify({
                error: isTimeout ? 'TIMEOUT' : 'INTERNAL',
                message: isTimeout
                    ? `The rewrite took longer than ${Math.round(BUDGET_MS / 1000)}s. Try again, or shorten the resume.`
                    : error.message
            })
        };
    }
};

// ============================================
// PARALLEL RESUME BUILD
// ============================================

// Pass 1 lists the job headers only (a few hundred tokens, a few seconds).
// Pass 2 fires one small call per job plus one for the header block, all at
// once. Each chunk is short enough that truncation is no longer possible.
async function buildResumeInParallel(apiKey, resumeText, jdText, started) {
    const outline = await callClaude(apiKey, buildOutlinePrompt(resumeText), 1500, started);

    if (!outline || !Array.isArray(outline.jobs) || outline.jobs.length === 0) {
        throw new Error('Could not identify any work experience in the resume.');
    }

    // Guard against a pathological outline blowing up the fan-out.
    const jobs = outline.jobs.slice(0, 12);

    const [header, ...jobResults] = await Promise.all([
        callClaude(apiKey, buildHeaderPrompt(resumeText, jdText), CHUNK_MAX_TOKENS, started),
        ...jobs.map(j => callClaude(apiKey, buildJobPrompt(resumeText, j, jdText), CHUNK_MAX_TOKENS, started))
    ]);

    const experience = jobs.map((j, i) => ({
        title: j.title || '',
        company: j.company || '',
        duration: j.duration || '',
        bullets: (jobResults[i] && Array.isArray(jobResults[i].bullets)) ? jobResults[i].bullets : []
    })).filter(j => j.bullets.length > 0);

    const resume = {
        name: header.name || '',
        title: header.title || '',
        contact: header.contact || {},
        summary: header.summary || '',
        experience,
        skills: Array.isArray(header.skills) ? header.skills : [],
        education: Array.isArray(header.education) ? header.education : []
    };

    if (jdText && header.jdMatch) resume.jdMatch = header.jdMatch;
    return resume;
}

// ============================================
// CLAUDE CALL
// ============================================
async function callClaude(apiKey, prompt, maxTokens, started) {
    const remaining = BUDGET_MS - (Date.now() - started);
    if (remaining <= 1000) throw new Error('Time budget exhausted before request');

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), remaining);

    let response;
    try {
        response = await fetch(ANTHROPIC_API_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': apiKey,
                'anthropic-version': '2023-06-01'
            },
            body: JSON.stringify({
                model: CONFIG.model,
                max_tokens: maxTokens,
                system: CONFIG.systemPrompt,
                messages: [{ role: 'user', content: prompt }]
            }),
            signal: controller.signal
        });
    } finally {
        clearTimeout(timer);
    }

    if (!response.ok) {
        const errorText = await response.text();
        console.error('Claude API error:', response.status, errorText.slice(0, 500));
        throw new Error(`AI service error (${response.status})`);
    }

    const data = await response.json();

    if (data.stop_reason === 'max_tokens') {
        throw new Error('Response was cut off before completing.');
    }

    const textBlock = (data.content || []).find(b => b.type === 'text');
    const parsed = extractJSON(textBlock ? textBlock.text : '');

    if (!parsed) {
        console.error('Unparseable model output:', (textBlock ? textBlock.text : '').slice(0, 1000));
        throw new Error('The AI did not return usable JSON.');
    }
    return parsed;
}

// ============================================
// RESPONSE PARSING + VALIDATION
// ============================================

// The original /\{[\s\S]*\}/ ran from the first brace to the LAST brace in the
// whole reply, so any trailing prose containing a brace broke the parse. This
// scans for one balanced object instead, ignoring braces inside strings.
function extractJSON(text) {
    if (!text) return null;

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
                catch (e) { console.error('Balanced object failed to parse:', e.message); return null; }
            }
        }
    }
    return null;
}

function validateShape(action, obj) {
    if (!obj || typeof obj !== 'object') return 'Response was not an object.';

    if (action === 'ats_score') {
        if (typeof obj.overall !== 'number') return 'Missing overall score.';
        if (!Array.isArray(obj.sections) || obj.sections.length === 0) return 'Missing section scores.';
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

    if (!Array.isArray(obj.experience) || obj.experience.length === 0) {
        return 'Resume came back with no work experience — nothing to render.';
    }
    if (!obj.name) return 'Resume came back without a name.';
    return null;
}

// ============================================
// PROMPT BUILDERS
// ============================================

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
