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
        const aiResponse = data.content[0].text;

        // Try to parse JSON from response
        let parsedResponse;
        try {
            // Extract JSON from response (AI might include explanation text)
            const jsonMatch = aiResponse.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
                parsedResponse = JSON.parse(jsonMatch[0]);
            } else {
                parsedResponse = { rawResponse: aiResponse };
            }
        } catch (parseError) {
            console.error('JSON parse error:', parseError);
            parsedResponse = { rawResponse: aiResponse };
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
