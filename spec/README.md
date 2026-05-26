# PromptRouter — Product Spec

> **One API key. Every model. Always the right one.**

---

## Table of Contents

1. [Problem Statement](#1-problem-statement)
2. [Target Audience](#2-target-audience)
3. [Solution Overview](#3-solution-overview)
4. [Core Features](#4-core-features)
5. [Pricing Model](#5-pricing-model)
6. [Competitive Landscape](#6-competitive-landscape)
7. [Open Source Strategy](#7-open-source-strategy)
8. [Technical Architecture](#8-technical-architecture)
9. [Roadmap](#9-roadmap)
10. [Success Metrics](#10-success-metrics)

---

## 1. Problem Statement

Every developer building AI features today faces the same tax:

**Managing model complexity is a second job.**

- GPT-4o for reasoning, but it's expensive — use Haiku for simple questions
- DeepSeek is 50x cheaper but can't do vision
- Claude Opus is brilliant but slow — don't use it for real-time chat
- What happens when OpenAI hits a 429? Your app breaks.
- Production apps need fallbacks, retries, caching, and logging — none of it ships in `openai` pip package

The result: teams spend weeks building plumbing instead of products. Small teams skip it entirely and overpay. Indie hackers blow their budget on GPT-4o for tasks a $0.002/1M token model handles fine.

**The average AI-powered app wastes 60–80% of its LLM budget** routing every request to the same model regardless of complexity.

---

## 2. Target Audience

### Primary: Indie Hackers & Solo Developers
- Building SaaS, tools, or side projects with AI features
- Have $50–$500/month LLM budgets
- Want "it just works" without becoming an ML infrastructure engineer
- **Pain:** Overpaying because they default to one model

### Secondary: Small Engineering Teams (2–20 engineers)
- Shipping AI features inside products
- No dedicated ML infra team
- **Pain:** Building the same retry/fallback/caching logic from scratch every time

### Tertiary: AI Consultants & Agencies
- Building AI products for clients
- Need white-label reliability + cost controls
- **Pain:** Need per-client billing and usage isolation

### Not (yet): Enterprise
- Complex security/compliance requirements
- Prefer dedicated contracts with providers
- Worth targeting in v2 with private deployment + SLAs

---

## 3. Solution Overview

PromptRouter is a **drop-in OpenAI-compatible API proxy** that adds:

1. **Intelligent routing** — classifies your prompt's intent and picks the best model automatically
2. **Automatic failover** — if the primary model fails, retries the next-best option transparently
3. **Response caching** — identical prompts return cached results instantly (no token cost)
4. **Rate limit handling** — queues requests, backs off, retries so your app doesn't crash
5. **Single API key** — you get one key, we manage the provider relationships
6. **Cost dashboard** — see exactly where your money goes, by model, by day, by endpoint

**Migration cost:** Change one line of code.

```python
# Before
client = OpenAI(api_key="sk-...")

# After
client = OpenAI(
    base_url="https://api.promptrouter.dev/v1",
    api_key="pr-your-key-here"
)
```

---

## 4. Core Features

### 4.1 Intelligent Routing

The router classifies incoming prompts into intent categories and maps them to the best model:

| Intent | Best Model | Why |
|--------|-----------|-----|
| `code` | Claude Sonnet 4.5 | Best code reasoning, debugging, architecture |
| `summary` | DeepSeek Chat | Cheap, fast, accurate for text reduction |
| `research` | GPT-4o | Broad knowledge, good citations |
| `chat` | DeepSeek Chat | Fast, cheap, conversational |
| `creative` | Claude Sonnet / GPT-4o | High quality prose, storytelling |
| `math` | DeepSeek R1 | Best open-source math reasoning |
| `vision` | GPT-4o Vision | Multi-modal input |
| `structured` | Claude Haiku 3.5 | JSON output, classification, extraction |

**Classification approach:**
1. **Heuristic (fast):** Keyword matching, system prompt analysis, message structure
2. **AI classification (optional):** Route to a cheap classifier model first for ambiguous prompts
3. **Explicit override:** User passes `"intent": "code"` in request body

**Scoring function per model:**
```
score = (capability_match × 0.5) + (cost_efficiency × 0.3) + (speed × 0.2)
```
Adjusted by real-time availability penalties.

---

### 4.2 Fallback Chain

Every model has a configured fallback sequence. If the primary fails (rate limit, timeout, error), the router tries the next model automatically:

```
code intent:
  1. claude-sonnet-4-5      → primary
  2. gpt-4o                 → fallback-1 (if Claude down)
  3. deepseek-chat          → fallback-2 (if both down, degraded)
```

Failures are tracked per-provider. If a provider accumulates failures, it's marked "degraded" and skipped for N minutes (circuit breaker pattern).

---

### 4.3 Response Caching

**Exact-match caching:** Identical prompt + model + temperature → return cached response.

- Cache key: SHA256 hash of `(system_prompt + user_messages + model + temperature)`
- TTL: Configurable per request (default 1 hour)
- Storage: In-memory for prototype, Redis for production
- Cache bypass: `"cache": false` in request body

**Impact:** In most apps, 20–40% of LLM calls are repeated (FAQ bots, template-based prompts, retry storms). Caching these is pure margin.

---

### 4.4 Rate Limit Handling

- Per-user rate limits enforced at the proxy layer
- Provider rate limits caught and handled transparently:
  - Exponential backoff with jitter
  - Queue depth configurable per plan
  - User gets a `202 Accepted` with polling URL for queued requests (v2)
- Rate limit headers forwarded: `X-RateLimit-Remaining`, `X-RateLimit-Reset`

---

### 4.5 Usage Tracking

Every request logged with:
- Timestamp, user/API key
- Intent classification
- Model selected + fallbacks tried
- Input tokens, output tokens
- Cost (our cost, not charged cost)
- Latency (first token, total)
- Cache hit/miss
- Provider error codes

Aggregated into the dashboard. Exportable as CSV/JSON.

---

### 4.6 Single API Key

Users get one `pr-` prefixed API key. We handle:
- Provider API key rotation
- Per-user spending limits
- Usage-based billing
- Key revocation without changing provider keys

---

## 5. Pricing Model

### Philosophy
We charge a modest markup on token costs. Not a flat subscription — aligned with value delivered.

### Tiers

| Tier | Price | Included | Markup |
|------|-------|----------|--------|
| **Free** | $0/mo | 100K tokens/mo | 50% markup |
| **Starter** | $9/mo | 1M tokens/mo | 20% markup |
| **Pro** | $29/mo | 5M tokens/mo | 10% markup |
| **Team** | $99/mo | 25M tokens/mo | 5% markup |
| **Enterprise** | Custom | Unlimited | Custom |

**Overage:** Pay-as-you-go at tier markup rate.

**Example (Starter tier):**
- DeepSeek Chat costs: $0.27/1M input tokens
- We charge: $0.32/1M input tokens (20% markup)
- User gets routing intelligence, caching, failover "for free" in the markup
- With 30% cache hit rate, effective cost is lower than going direct

### Revenue Levers
- Markup on token costs
- Tiered plan subscriptions
- Enterprise SLAs and private deployments
- White-label licensing for agencies

---

## 6. Competitive Landscape

### vs. OpenRouter

| Feature | OpenRouter | PromptRouter |
|---------|-----------|--------------|
| Model selection | Manual | **Automatic (intent-based)** |
| Fallback logic | Manual | **Automatic** |
| Response caching | ❌ | **✅** |
| Intent classification | ❌ | **✅** |
| Rate limit handling | Basic | **Advanced (queue + backoff)** |
| Cost optimization | None | **Active (routes to cheapest capable model)** |
| Open source | ❌ | **✅ Core router** |
| Dashboard | Basic | **Full analytics** |

**OpenRouter's pitch:** "Access any model through one API."
**Our pitch:** "Access the *right* model automatically. Pay less. Break nothing."

OpenRouter is a model marketplace. We're an intelligent proxy. Different jobs.

### vs. LiteLLM
- LiteLLM is a library you run yourself — great for power users, high setup cost
- We're a hosted service with zero infra
- LiteLLM has no intelligent routing or caching
- Can use LiteLLM as our backend (open opportunity)

### vs. Building In-House
- 2–4 weeks to build basic fallback + retry logic
- Ongoing maintenance burden
- No caching without Redis setup
- No dashboard without another 2 weeks
- We deliver this in 5 minutes of setup

---

## 7. Open Source Strategy

**Core router logic:** Open source (MIT)
- Intent classifier
- Model registry format
- Scoring algorithm
- Fallback chain logic

**Hosted service:** Paid
- Multi-tenant infrastructure
- API key management
- Billing
- Dashboard
- SLAs and support

**Why open source the core?**
- Builds trust (devs can audit the routing logic)
- Community-driven model registry updates
- Creates competitive moat through network effects (hosted users fund development)
- "Open core" is a proven SaaS model (HashiCorp, Grafana, PostHog)

---

## 8. Technical Architecture

```
Client Request
     ↓
[Auth Middleware]        ← Validate pr- API key
     ↓
[Rate Limiter]           ← Enforce per-user limits
     ↓
[Cache Check]            ← Return cached if hit
     ↓
[Intent Classifier]      ← Classify prompt intent
     ↓
[Model Selector]         ← Score + rank models
     ↓
[Provider Client]        ← Call model API
     ↓                       ↓ (on failure)
[Response Cache]         [Fallback Handler]
     ↓
[Usage Logger]
     ↓
Client Response
```

**Stack:**
- Runtime: Node.js (TypeScript) or Python (FastAPI)
- Cache: In-memory Map → Redis in production
- Database: SQLite for prototype → PostgreSQL for production
- Queue: In-memory → BullMQ / Redis for production
- Hosting: Railway (prototype), Fly.io (production)

---

## 9. Roadmap

### v0.1 — Prototype (Now)
- [x] OpenAI-compatible `/v1/chat/completions`
- [x] Route between DeepSeek and Claude
- [x] Basic intent classification (heuristic)
- [x] In-memory caching
- [x] Fallback on provider error
- [x] Usage logging (in-memory)

### v0.2 — Alpha
- [ ] Web dashboard (usage, cost, cache)
- [ ] API key management
- [ ] Redis cache + PostgreSQL logging
- [ ] Rate limiting per API key
- [ ] 5+ models in registry

### v0.3 — Beta
- [ ] Streaming responses
- [ ] Async/queued requests
- [ ] Webhooks for completion events
- [ ] Python + Node.js SDKs

### v1.0 — Launch
- [ ] Billing (Stripe)
- [ ] Team accounts
- [ ] Public model registry
- [ ] SLA monitoring
- [ ] Docs site

---

## 10. Success Metrics

| Metric | 30 days | 90 days | 1 year |
|--------|---------|---------|--------|
| API keys created | 50 | 500 | 5,000 |
| MRR | $0 | $500 | $10,000 |
| Requests/day | 1K | 50K | 1M |
| Cache hit rate | — | 25% | 35% |
| Cost savings delivered | — | 30% avg | 45% avg |

**North Star:** Cost savings delivered to users. If we save users money vs. going direct, everything else follows.

---

*PromptRouter — Route smarter. Spend less. Ship faster.*
