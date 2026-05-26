# PromptRouter

> **One API key. Every model. Always the right one.**

A universal LLM routing proxy that intelligently routes requests to the cheapest/best model based on task type. Drop-in OpenAI replacement. Handles failover, caching, retries, and usage tracking automatically.

---

## Why PromptRouter?

| Without PromptRouter | With PromptRouter |
|---------------------|-------------------|
| Pick one model, use it for everything | Automatically uses the right model per task |
| Pay GPT-4o prices for simple chat | Pay DeepSeek prices for chat, Claude only for code |
| App breaks when provider has outage | Automatic failover to next-best model |
| Repeated prompts hit the API every time | 30%+ of requests served from cache |
| Build retry/backoff logic yourself | Built-in, battle-tested |
| Multiple API keys to manage | One `pr-` key |

**Typical cost savings: 40–65% vs defaulting to one premium model.**

---

## Quick Start

### 1. Clone & Install

```bash
git clone https://github.com/your-org/promptrouter
cd promptrouter
npm install
```

### 2. Configure Environment

```bash
cp .env.example .env
# Edit .env with your API keys:
# ANTHROPIC_API_KEY=sk-ant-...
# DEEPSEEK_API_KEY=sk-...
```

### 3. Run

```bash
npm run dev
# Server starts on http://localhost:3000
```

### 4. Test

```bash
# Verify the router works
npm test

# Or test with curl
curl -X POST http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer pr-test-key" \
  -d '{
    "model": "auto",
    "messages": [{"role": "user", "content": "Write a Python hello world function"}]
  }'
```

---

## Migration (30 seconds)

### Python

```python
# Before
from openai import OpenAI
client = OpenAI(api_key="sk-...")

# After — change 2 lines
from openai import OpenAI
client = OpenAI(
    base_url="http://localhost:3000/v1",  # or https://api.promptrouter.dev/v1
    api_key="pr-your-key"
)
# All your existing code works unchanged
```

### JavaScript/TypeScript

```typescript
// Before
import OpenAI from 'openai';
const client = new OpenAI({ apiKey: 'sk-...' });

// After
import OpenAI from 'openai';
const client = new OpenAI({
  baseURL: 'http://localhost:3000/v1',
  apiKey: 'pr-your-key',
});
```

---

## How Routing Works

```
Your prompt →  Intent Classifier  →  Model Selector  →  Provider API
               (heuristic rules)     (score: cost +      (with fallback)
                                      capability +
                                      availability)
```

| Intent Detected | Primary Model | Why |
|----------------|--------------|-----|
| `code` | Claude Sonnet 4.5 | Best code quality |
| `chat` | DeepSeek Chat | Cheapest capable |
| `summary` | DeepSeek Chat | Fast + cheap |
| `math` | DeepSeek R1 | Chain-of-thought reasoning |
| `creative` | Claude Sonnet | Best writing |
| `vision` | GPT-4o | Multi-modal |
| `structured` | Claude Haiku | Reliable JSON |
| `research` | DeepSeek Chat | Good knowledge |

Override the intent explicitly:

```json
{
  "model": "auto",
  "messages": [...],
  "_router": { "intent": "code" }
}
```

---

## API Reference

See [`spec/api.md`](spec/api.md) for full API documentation.

### Key Endpoints

```
POST /v1/chat/completions   OpenAI-compatible
POST /v1/route              Explicit routing
GET  /v1/models             Available models + pricing
GET  /v1/usage              Your usage stats
GET  /v1/health             Provider health
GET  /admin/stats           Admin dashboard (requires X-Admin-Secret header)
```

---

## Response Metadata

Every response includes `_router` metadata:

```json
{
  "choices": [...],
  "_router": {
    "intent_detected": "code",
    "model_selected": "anthropic/claude-sonnet-4-5",
    "model_requested": "auto",
    "fallback_used": false,
    "cache_hit": false,
    "routing_latency_ms": 4,
    "provider_latency_ms": 1247,
    "cost_usd": 0.00312,
    "request_id": "pr-req-abc123"
  }
}
```

---

## Deployment

### Railway (Recommended)

[![Deploy on Railway](https://railway.app/button.svg)](https://railway.app/new/template)

1. Fork this repo
2. Create new Railway project from GitHub
3. Set environment variables:
   - `ANTHROPIC_API_KEY`
   - `DEEPSEEK_API_KEY`
   - `ADMIN_SECRET` (choose a secure secret)
4. Deploy — Railway auto-detects Node.js

### Render

1. Create new Web Service
2. Connect GitHub repo
3. Build command: `npm install && npm run build`
4. Start command: `npm start`
5. Set environment variables

### Fly.io

```bash
fly launch --name promptrouter
fly secrets set ANTHROPIC_API_KEY=sk-ant-...
fly secrets set DEEPSEEK_API_KEY=sk-...
fly deploy
```

### Docker

```bash
docker build -t promptrouter .
docker run -p 3000:3000 \
  -e ANTHROPIC_API_KEY=sk-ant-... \
  -e DEEPSEEK_API_KEY=sk-... \
  promptrouter
```

---

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `ANTHROPIC_API_KEY` | For Claude models | Anthropic API key |
| `DEEPSEEK_API_KEY` | For DeepSeek models | DeepSeek API key |
| `OPENAI_API_KEY` | For OpenAI models | OpenAI API key |
| `PORT` | No (default: 3000) | Server port |
| `ADMIN_SECRET` | Recommended | Admin dashboard auth header |
| `REDIS_URL` | No (uses memory) | Redis for production caching |
| `DATABASE_URL` | No (uses memory) | PostgreSQL for usage logging |

---

## Project Structure

```
promptrouter/
├── src/
│   ├── server.ts          # Express server, API endpoints
│   └── router.ts          # Intent classification, model selection, circuit breaker
├── data/
│   └── models.json        # Model registry (pricing, capabilities, fallback order)
├── spec/
│   ├── README.md          # Full product spec
│   ├── api.md             # API design doc
│   ├── dashboard.md       # Dashboard concept + HTML mockup
│   └── client-sdk.md      # Python + Node SDK design
├── scripts/
│   └── test-router.ts     # Integration test suite
├── .env.example
├── package.json
├── tsconfig.json
└── README.md
```

---

## Roadmap

- [x] OpenAI-compatible `/v1/chat/completions`
- [x] Intent classification (heuristic)
- [x] Model registry (data-driven)
- [x] Automatic routing + fallback chain
- [x] In-memory response caching
- [x] Circuit breaker (provider health tracking)
- [x] Usage logging
- [ ] Web dashboard (HTML)
- [ ] Streaming support
- [ ] Redis cache backend
- [ ] PostgreSQL usage storage
- [ ] API key management (multi-user)
- [ ] Billing integration (Stripe)
- [ ] Python + Node.js SDK packages

---

## Contributing

This is early-stage. Open an issue or PR if you want to:
- Add models to the registry (`data/models.json`)
- Improve intent classification patterns
- Add provider integrations (Mistral, Gemini, etc.)

---

## License

MIT — Core routing logic is open source.
Hosted service at promptrouter.dev is commercial.

---

*Ship faster. Pay less. Break nothing.*
