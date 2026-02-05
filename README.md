# Resume Optimizer Platform

AI-powered resume optimization tool that helps users create ATS-friendly, impactful resumes.

## Features

- **ATS Score Check** (Free) - Analyze resume against ATS systems
- **Refine Resume** (Premium) - AI-powered resume improvement
- **JD Optimize** (Premium) - Tailor resume for specific job descriptions
- **Chat Refinement** - Iteratively improve resume through conversation
- **Multiple Templates** - Clean, Modern, and Executive styles

## Quick Start

### 1. Clone and Setup

```bash
git clone <your-repo-url>
cd resume-optimizer
npm install
```

### 2. Set Environment Variables

Create a `.env` file (for local development):

```
ANTHROPIC_API_KEY=your_api_key_here
```

### 3. Local Development

```bash
npm run dev
# or
netlify dev
```

Visit `http://localhost:8888`

## Deployment to Netlify

### Option A: Netlify CLI

```bash
# Login to Netlify
netlify login

# Initialize site
netlify init

# Deploy
netlify deploy --prod
```

### Option B: GitHub Integration

1. Push code to GitHub
2. Go to [Netlify](https://app.netlify.com)
3. Click "Add new site" > "Import an existing project"
4. Connect your GitHub repo
5. Deploy settings are auto-detected from `netlify.toml`
6. Click "Deploy site"

### Configure Environment Variables

After deployment:

1. Go to Netlify Dashboard > Your Site > Site Settings
2. Navigate to "Environment variables"
3. Add: `ANTHROPIC_API_KEY` = `your_api_key_here`
4. Redeploy the site

## Customization for Different Instances

### FaujiTech Instance

Edit `netlify/functions/analyze.js` and update the `systemPrompt` in CONFIG:

```javascript
systemPrompt: `You are an expert resume consultant specializing in helping
Indian Armed Forces veterans transition to civilian careers.

## Military to Civilian Mapping:
- Colonel/Captain (Navy) → Director/VP level
- Lt. Colonel/Commander → Senior Manager/Director
- Major/Lt. Commander → Manager/Senior Individual Contributor
- Captain/Lieutenant → Team Lead/Individual Contributor

## Terminology Translation:
- "Commanded a battalion" → "Led operations for 800+ personnel"
- "Combat operations" → "High-stakes project delivery"
- "Military exercises" → "Large-scale coordination initiatives"
...
`
```

### Akki.club Instance

```javascript
systemPrompt: `You are an expert resume consultant for Indian job seekers.

## Context:
- Fresher-friendly guidance
- Campus placement optimization
- Startup vs MNC language differences
- Indian market specific keywords (CTC, notice period, etc.)
...
`
```

## File Structure

```
resume-optimizer/
├── index.html          # Main application (single file)
├── netlify.toml        # Netlify configuration
├── package.json        # Dependencies
├── README.md           # This file
└── netlify/
    └── functions/
        └── analyze.js  # Claude API serverless function
```

## API Endpoints

### POST /.netlify/functions/analyze

Request body:
```json
{
  "action": "ats_score | refine | jd_optimize | chat",
  "resumeText": "Resume content...",
  "jdText": "Job description (for jd_optimize)",
  "chatHistory": [{"role": "user", "content": "..."}],
  "currentResume": {}
}
```

## Cost Estimation

Using Claude Sonnet 4:
- Input: $3 / 1M tokens
- Output: $15 / 1M tokens

Per operation (approximate):
- ATS Score: ~$0.08
- Refine: ~$0.10
- JD Optimize: ~$0.12
- Chat message: ~$0.03

## Customizing Templates

Templates are defined in `index.html` within these functions:
- `renderCleanTemplate(resume)`
- `renderModernTemplate(resume)`
- `renderExecutiveTemplate(resume)`

Each template receives a resume object and returns HTML.

## Adding Payment Gateway

To add payment before premium features:

1. Add Razorpay/Stripe integration
2. Gate the `refine` and `jd_optimize` actions
3. Verify payment before calling AI API

## Support

For issues or customization help, contact [your contact info].
