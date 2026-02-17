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
    
    model: 'claude-sonnet-4-20250514',
    maxTokens: 4096,
    
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

INSTRUCTIONS:
1. Strengthen action verbs (Led, Built, Drove, Achieved, Scaled)
2. Add metrics and numbers wherever possible
3. Make summary punchy and achievement-focused
4. Ensure each bullet starts with action verb
5. Keep bullets concise (1-2 lines max)
6. Organize skills by relevance

Return the improved resume as JSON:
{
    "name": "Full Name",
    "title": "Professional Title | Key Expertise",
    "contact": {
        "email": "extracted or placeholder",
        "linkedin": "extracted or placeholder",
        "location": "extracted or placeholder",
        "phone": "extracted or placeholder"
    },
    "summary": "Improved 2-3 sentence summary",
    "experience": [
        {
            "title": "Job Title",
            "company": "Company Name",
            "duration": "Date Range",
            "bullets": ["Improved bullet 1", "Improved bullet 2", "Improved bullet 3"]
        }
    ],
    "skills": ["Skill 1", "Skill 2"],
    "education": [
        {
            "degree": "Degree",
            "school": "School",
            "year": "Year"
        }
    ]
}

Return ONLY the JSON, no additional text.`;
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

INSTRUCTIONS:
1. Identify key requirements from the JD
2. Reorder and emphasize relevant experience
3. Add keywords from JD naturally into resume
4. Adjust summary to match role requirements
5. Highlight transferable skills that match JD
6. Note any skill gaps

Return the optimized resume as JSON:
{
    "name": "Full Name",
    "title": "Title matching JD focus",
    "contact": {
        "email": "",
        "linkedin": "",
        "location": "",
        "phone": ""
    },
    "summary": "Summary tailored to this specific role",
    "experience": [
        {
            "title": "Job Title",
            "company": "Company Name",
            "duration": "Date Range",
            "bullets": ["Bullet emphasizing JD-relevant achievement"]
        }
    ],
    "skills": ["Skills prioritized by JD relevance"],
    "education": [
        {
            "degree": "Degree",
            "school": "School",
            "year": "Year"
        }
    ],
    "jdMatch": {
        "score": <number 0-100>,
        "matchedKeywords": ["keyword1", "keyword2"],
        "missingKeywords": ["keyword user should add/learn"],
        "recommendations": ["Specific recommendation for this application"]
    }
}

Return ONLY the JSON, no additional text.`;
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

Based on the user's latest request, make the appropriate changes to the resume.

Return your response as JSON:
{
    "message": "Your conversational response explaining what you changed",
    "updatedResume": {
        // Full updated resume object with same structure as input
        "name": "...",
        "title": "...",
        "contact": {...},
        "summary": "...",
        "experience": [...],
        "skills": [...],
        "education": [...]
    },
    "changesApplied": ["Brief description of change 1", "Brief description of change 2"]
}

Return ONLY the JSON, no additional text.`;
}
