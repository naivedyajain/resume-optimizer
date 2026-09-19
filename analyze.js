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

// ============================================
// HANDLER
// ============================================
exports.handler = async (event, context) => {
    // CORS headers
    const headers = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Content-Type': 'application/json'
    };

    // Handle preflight
    if (event.httpMethod === 'OPTIONS') {
        return { statusCode: 200, headers, body: '' };
    }

    // Only allow POST
    if (event.httpMethod !== 'POST') {
        return {
            statusCode: 405,
            headers,
            body: JSON.stringify({ error: 'Method not allowed' })
        };
    }

    try {
        const { action, resumeText, jdText, chatHistory, currentResume } = JSON.parse(event.body);

        // Get API key from environment
        const apiKey = process.env.ANTHROPIC_API_KEY;
        
        if (!apiKey) {
            console.error('ANTHROPIC_API_KEY not set in environment variables');
            return {
                statusCode: 500,
                headers,
                body: JSON.stringify({ error: 'API key not configured. Set ANTHROPIC_API_KEY in Netlify environment variables.' })
            };
        }

        // An empty or near-empty resume makes the model reply in prose instead
        // of JSON, which previously rendered as a blank resume with no error.
        // Scanned/image PDFs extract to nothing and land here.
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

        let prompt = '';

        // Build prompt based on action
        switch (action) {
            case 'ats_score':
                prompt = buildATSScorePrompt(resumeText);
                break;
            case 'refine':
                prompt = buildRefinePrompt(resumeText);
                break;
            case 'jd_optimize':
                prompt = buildJDOptimizePrompt(resumeText, jdText);
                break;
            case 'chat':
                prompt = buildChatPrompt(currentResume, chatHistory);
                break;
            default:
                return {
                    statusCode: 400,
                    headers,
                    body: JSON.stringify({ error: 'Invalid action. Use: ats_score, refine, jd_optimize, or chat' })
                };
        }

        // Call Claude API
        const response = await fetch(ANTHROPIC_API_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': apiKey,
                'anthropic-version': '2023-06-01'
            },
            body: JSON.stringify({
                model: CONFIG.model,
                max_tokens: CONFIG.maxTokens,
                system: CONFIG.systemPrompt,
                messages: [
                    { role: 'user', content: prompt }
                ]
            })
        });

        if (!response.ok) {
            const errorText = await response.text();
            console.error('Claude API error:', errorText);
            return {
                statusCode: response.status,
                headers,
                body: JSON.stringify({ error: 'AI service error', details: errorText })
            };
        }

        const data = await response.json();

        // The model can be cut off mid-JSON. That produces unparseable output,
        // which used to fall through as a "successful" empty resume.
        if (data.stop_reason === 'max_tokens') {
            console.error('Response truncated at max_tokens');
            return {
                statusCode: 502,
                headers,
                body: JSON.stringify({
                    error: 'TRUNCATED',
                    message: 'The resume was too long to rewrite in one pass. Try a shorter resume or raise maxTokens.'
                })
            };
        }

        const textBlock = (data.content || []).find(b => b.type === 'text');
        const aiResponse = textBlock ? textBlock.text : '';

        const parsedResponse = extractJSON(aiResponse);

        if (!parsedResponse) {
            console.error('Could not parse JSON. Raw model output:', aiResponse.slice(0, 2000));
            return {
                statusCode: 502,
                headers,
                body: JSON.stringify({
                    error: 'BAD_AI_RESPONSE',
                    message: 'The AI did not return usable resume data.',
                    raw: aiResponse.slice(0, 2000)
                })
            };
        }

        // Shape check: a resume-producing action MUST come back with experience.
        // Without this, an empty object renders as a blank resume.
        const validationError = validateShape(action, parsedResponse);
        if (validationError) {
            console.error('Shape validation failed:', validationError, JSON.stringify(parsedResponse).slice(0, 1000));
            return {
                statusCode: 502,
                headers,
                body: JSON.stringify({
                    error: 'INCOMPLETE_RESUME',
                    message: validationError,
                    raw: aiResponse.slice(0, 2000)
                })
            };
        }

        return {
            statusCode: 200,
            headers,
            body: JSON.stringify({
                success: true,
                data: parsedResponse,
                usage: data.usage
            })
        };

    } catch (error) {
        console.error('Function error:', error);
        return {
            statusCode: 500,
            headers,
            body: JSON.stringify({ error: 'Internal server error', message: error.message })
        };
    }
};

// ============================================
// RESPONSE PARSING + VALIDATION
// ============================================

// The old code used /\{[\s\S]*\}/ — first brace to LAST brace in the whole
// reply. Any trailing prose containing a "}" broke it, and truncated output
// always broke it. This scans for a balanced object instead, ignoring braces
// that appear inside strings.
function extractJSON(text) {
    if (!text) return null;

    // Strip markdown code fences if present
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
                try {
                    return JSON.parse(s.slice(start, i + 1));
                } catch (e) {
                    console.error('Balanced object found but JSON.parse failed:', e.message);
                    return null;
                }
            }
        }
    }
    // Never closed => truncated
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
        // A chat turn may legitimately be advice-only with no resume edit.
        if (!upd) return null;
        if (!Array.isArray(upd.experience) || upd.experience.length === 0) {
            return 'Updated resume came back with no work experience.';
        }
        return null;
    }

    // refine + jd_optimize must return a full resume
    if (!Array.isArray(obj.experience) || obj.experience.length === 0) {
        return 'Resume came back with no work experience — nothing to render.';
    }
    if (!obj.name) return 'Resume came back without a name.';
    return null;
}

// ============================================
// PROMPT BUILDERS
// ============================================

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

Be specific and actionable in your suggestions. Focus on the top 4-6 issues.
Return ONLY the JSON, no additional text.`;
}

function buildRefinePrompt(resumeText) {
    return `Improve this resume to be more impactful and ATS-friendly.

ORIGINAL RESUME:
---
${resumeText}
---

CRITICAL RULES - YOU MUST FOLLOW:
1. **INCLUDE EVERY SINGLE JOB** - List ALL work experience from the original. Do NOT skip, summarize, or omit ANY position.
2. **KEEP ALL BULLET POINTS** - For each job, include ALL achievements. Improve the wording but keep every point.
3. **PRESERVE ALL DETAILS** - Names, dates, companies, titles, numbers must all be preserved exactly.
4. **NO REDACTION** - Do NOT use placeholders like "X%" or "[Company]". Use the ACTUAL values from the resume.
5. **COMPLETE OUTPUT** - Your response must include the ENTIRE resume, not a shortened version.

IMPROVEMENTS TO MAKE:
- Strengthen action verbs (Led, Built, Drove, Achieved, Scaled, Delivered)
- Keep all existing metrics and numbers (do NOT remove them)
- Make summary punchy with the person's actual achievements
- Ensure each bullet starts with action verb
- Organize skills by relevance

Return the COMPLETE improved resume as JSON. Include EVERY job and EVERY bullet point:
{
    "name": "Actual full name from resume",
    "title": "Their actual title | Key Expertise",
    "contact": {
        "email": "actual email",
        "linkedin": "actual linkedin",
        "location": "actual location",
        "phone": "actual phone"
    },
    "summary": "2-3 sentence summary using their REAL achievements and metrics",
    "experience": [
        {
            "title": "Actual Job Title",
            "company": "Actual Company Name",
            "duration": "Actual Date Range",
            "bullets": ["All bullets for this job - improved but complete"]
        }
        // REPEAT FOR EVERY JOB IN THE ORIGINAL - DO NOT SKIP ANY
    ],
    "skills": ["All skills from original"],
    "education": [
        {
            "degree": "Actual Degree",
            "school": "Actual School",
            "year": "Actual Year"
        }
    ]
}

FINAL CHECK: Count the jobs in your output. It MUST match the original resume. Do not truncate.
Return ONLY valid JSON, no other text.`;
}

function buildJDOptimizePrompt(resumeText, jdText) {
    return `Tailor this resume for the specific job description provided.

ORIGINAL RESUME:
---
${resumeText}
---

JOB DESCRIPTION:
---
${jdText}
---

CRITICAL RULES:
1. **KEEP ALL JOBS** - Include EVERY position from the original resume
2. **NO REDACTION** - Use ACTUAL names, numbers, dates - no placeholders
3. **PRESERVE METRICS** - Keep all $, %, numbers exactly as they appear
4. **COMPLETE OUTPUT** - Include the entire resume, not a summary

OPTIMIZATION INSTRUCTIONS:
1. Reorder bullets to prioritize JD-relevant achievements (but keep all bullets)
2. Add keywords from JD naturally into existing content
3. Adjust summary to highlight relevant experience
4. Keep all original achievements - just reorder by relevance

Return the COMPLETE optimized resume as JSON:
{
    "name": "Actual Name",
    "title": "Title aligned with JD",
    "contact": {
        "email": "actual email",
        "linkedin": "actual linkedin",
        "location": "actual location",
        "phone": "actual phone"
    },
    "summary": "Summary highlighting JD-relevant experience with REAL metrics",
    "experience": [
        {
            "title": "Actual Job Title",
            "company": "Actual Company",
            "duration": "Actual Dates",
            "bullets": ["All bullets - reordered by JD relevance"]
        }
        // INCLUDE ALL JOBS
    ],
    "skills": ["Skills reordered by JD relevance"],
    "education": [
        {
            "degree": "Actual Degree",
            "school": "Actual School",
            "year": "Actual Year"
        }
    ],
    "jdMatch": {
        "score": 85,
        "matchedKeywords": ["keywords found"],
        "missingKeywords": ["keywords to add"],
        "recommendations": ["specific suggestions"]
    }
}

Return ONLY valid JSON, no other text.`;
}

function buildChatPrompt(currentResume, chatHistory) {
    const historyText = chatHistory.map(msg => 
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
1. **KEEP ALL DATA** - Never redact or remove any information
2. **PRESERVE ALL JOBS** - Include every position in your response
3. **USE REAL VALUES** - No placeholders like "X%" - use actual numbers
4. **COMPLETE OUTPUT** - Return the FULL resume, not just changed parts

Based on the user's latest request, make the appropriate changes.

Return your response as JSON:
{
    "message": "Brief explanation of what you changed",
    "updatedResume": {
        "name": "Keep actual name",
        "title": "Keep or improve title",
        "contact": {"email": "actual", "linkedin": "actual", "location": "actual", "phone": "actual"},
        "summary": "Updated summary with real metrics",
        "experience": [
            // INCLUDE ALL JOBS - even ones you didn't change
        ],
        "skills": ["all skills"],
        "education": [{"degree": "actual", "school": "actual", "year": "actual"}]
    }
}

Return ONLY valid JSON.`;
}
