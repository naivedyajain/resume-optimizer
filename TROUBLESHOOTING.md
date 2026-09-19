# Troubleshooting

Every failure now reports a **code**, the **stage** it failed in, and a
**requestId** that matches the server log. Read those three before changing code.

## 1. Read the error on screen

Failures show a panel with the code, stage, requestId and a suggested fix.
**Copy diagnostics** puts the whole object on the clipboard.
The same object is at `window.__lastError` in the browser console.

## 2. Match it in the server log

Netlify → Logs → Functions → `analyze`. Every line is single-line JSON
prefixed `[resume-opt]`. Filter by the requestId from the panel.

```
[resume-opt] {"lvl":"info","msg":"start","requestId":"k3f9x2a1b8","action":"refine","resumeChars":4210}
[resume-opt] {"lvl":"info","msg":"outline-ok","requestId":"k3f9x2a1b8","jobs":6,"elapsedMs":3800}
[resume-opt] {"lvl":"info","msg":"chunk-ok","requestId":"k3f9x2a1b8","stage":"job:2:Walmart","ms":9100,"inTok":1400,"outTok":260}
[resume-opt] {"lvl":"info","msg":"done","requestId":"k3f9x2a1b8","action":"refine","elapsedMs":14200,"jobs":6}
```

`elapsedMs` on the `done` line is the headroom check. Netlify's synchronous
limit is 60s and is **not configurable**.

## 3. Check config in one call

```bash
curl -s -X POST https://<your-site>/.netlify/functions/analyze \
  -H 'Content-Type: application/json' -d '{"action":"health"}' | jq
```

Confirms the API key is present, the model id is accepted, and shows upstream
latency. Run this first whenever something is broken.

## Error codes

| Code | Meaning | Fix |
|---|---|---|
| `NO_API_KEY` | `ANTHROPIC_API_KEY` missing | Set it in Netlify env vars, redeploy |
| `AUTH_FAILED` | Key rejected (401/403) | Check the key value |
| `MODEL_NOT_FOUND` | Model id rejected (404) | Update `CONFIG.model` in `analyze.js` |
| `RATE_LIMITED` | 429 after 3 retries | Wait and retry |
| `NO_RESUME_TEXT` | <50 chars extracted | Scanned PDF — use a text PDF or DOCX |
| `RESUME_TOO_LONG` | Over 60,000 chars | Trim the resume |
| `NO_JOBS_FOUND` | Outline found no positions | Confirm the file is a resume and extracted correctly |
| `CHUNK_FAILED` | One position failed after retries | `stage` names which role |
| `UNPARSEABLE` | Model replied with prose | `detail` shows what it said |
| `TRUNCATED` | Hit `max_tokens` | Raise `CHUNK_MAX_TOKENS` |
| `TIMEOUT` | Passed the 45s internal budget | Check per-stage timings in the log |
| `FUNCTION_DIED` | **Client-side code.** Non-JSON 502/504 — the platform killed the function before it could report | Read the function log directly; our code never produces this |
| `INCOMPLETE_RESUME` | Assembled resume failed its shape check | Should not happen; report it |

`FUNCTION_DIED` is the only one with no server-side log entry of its own,
because the function never got to write one. That was the original bug.

## Why refine is split into parallel calls

One "rewrite the whole resume" call emits 2000+ tokens and takes 50–70s,
past the 60s limit. It now runs as an outline pass (job headers only) plus one
small concurrent call per position. Wall time is the slowest chunk, not the sum.
Do not merge it back into a single call.

## Tests

```bash
npm test
```

22 cases: happy paths, input guards, upstream failures, retry behaviour, and a
static check that every referenced function is actually defined. Run before
every deploy.
