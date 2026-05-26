# PromptRouter Client SDKs

## Philosophy

The SDKs exist for one reason: **remove friction from adoption.**

- Drop-in replacement for existing OpenAI SDK usage
- Zero configuration required for basic usage
- Retry, timeout, and streaming built in
- TypeScript-first, Python second

---

## Python SDK

### Installation

```bash
pip install promptrouter
```

### Basic Usage

```python
from promptrouter import PromptRouter

client = PromptRouter(api_key="pr-your-key-here")

# Drop-in OpenAI replacement
response = client.chat.completions.create(
    model="auto",
    messages=[{"role": "user", "content": "Explain async/await in Python"}]
)
print(response.choices[0].message.content)
```

### Explicit Intent

```python
response = client.chat.completions.create(
    model="auto",
    messages=[{"role": "user", "content": "Summarize this article: ..."}],
    extra_body={"_router": {"intent": "summary"}}
)
# → Routes to DeepSeek Chat (cheap + fast for summaries)
```

### Streaming

```python
with client.chat.completions.stream(
    model="auto",
    messages=[{"role": "user", "content": "Write a short story"}]
) as stream:
    for chunk in stream:
        print(chunk.choices[0].delta.content, end="", flush=True)
```

### Check Routing Metadata

```python
response = client.chat.completions.create(
    model="auto",
    messages=[{"role": "user", "content": "Debug this code: ..."}]
)

router_meta = response._router
print(f"Intent: {router_meta.intent_detected}")
print(f"Model used: {router_meta.model_selected}")
print(f"Cache hit: {router_meta.cache_hit}")
print(f"Cost: ${router_meta.cost_usd:.6f}")
```

### Usage Stats

```python
usage = client.usage.get(days=7)
print(f"Total requests: {usage.summary.total_requests}")
print(f"Total cost: ${usage.summary.total_cost_usd:.4f}")
print(f"Cache hit rate: {usage.summary.cache_hit_rate:.1%}")
print(f"Savings vs direct: ${usage.summary.cost_saved_usd:.4f}")
```

### Configuration

```python
from promptrouter import PromptRouter, RouterConfig

client = PromptRouter(
    api_key="pr-your-key-here",
    config=RouterConfig(
        base_url="https://api.promptrouter.dev/v1",
        timeout=30.0,           # seconds
        max_retries=3,
        cache=True,
        fallback=True,
        prefer_speed=False,     # prefer cost by default
    )
)
```

### Environment Variable Support

```python
# Set PROMPTROUTER_API_KEY in environment
client = PromptRouter()  # reads from env automatically
```

### Use with LangChain

```python
from langchain_openai import ChatOpenAI

llm = ChatOpenAI(
    model="auto",
    openai_api_base="https://api.promptrouter.dev/v1",
    openai_api_key="pr-your-key-here"
)
```

---

## Node.js / TypeScript SDK

### Installation

```bash
npm install promptrouter
# or
yarn add promptrouter
```

### Basic Usage

```typescript
import { PromptRouter } from 'promptrouter';

const client = new PromptRouter({ apiKey: 'pr-your-key-here' });

const response = await client.chat.completions.create({
  model: 'auto',
  messages: [{ role: 'user', content: 'Write a TypeScript interface for a User object' }]
});

console.log(response.choices[0].message.content);
```

### Explicit Intent

```typescript
const response = await client.chat.completions.create({
  model: 'auto',
  messages: [{ role: 'user', content: '2 + 2 * 3 = ?' }],
  // @ts-ignore - extended field
  _router: { intent: 'math' }
});
// → Routes to DeepSeek R1 (best math reasoning)
```

### Streaming

```typescript
const stream = await client.chat.completions.stream({
  model: 'auto',
  messages: [{ role: 'user', content: 'Tell me a joke' }]
});

for await (const chunk of stream) {
  process.stdout.write(chunk.choices[0]?.delta?.content ?? '');
}
```

### Usage Stats

```typescript
const usage = await client.usage.get({ days: 7 });
console.log(`Requests: ${usage.summary.totalRequests}`);
console.log(`Cost: $${usage.summary.totalCostUsd.toFixed(4)}`);
console.log(`Cache hit rate: ${(usage.summary.cacheHitRate * 100).toFixed(1)}%`);
```

### Drop-in OpenAI Replacement

The SDK is a thin wrapper around `openai` npm package — just swap the `baseURL`:

```typescript
import OpenAI from 'openai';

const client = new OpenAI({
  baseURL: 'https://api.promptrouter.dev/v1',
  apiKey: 'pr-your-key-here',
});

// All existing openai code works unchanged
const response = await client.chat.completions.create({
  model: 'gpt-4o',  // translated to best capable model automatically
  messages: [...]
});
```

---

## SDK Implementation Notes

The Python and Node.js SDKs are thin wrappers:

```
PromptRouter SDK
     ↓
OpenAI SDK (openai / openai-node)
     ↓
https://api.promptrouter.dev/v1
```

This means:
- Full streaming support inherited
- Function calling / tool use inherited
- Vision support inherited
- All OpenAI SDK features work out of the box

SDK adds on top:
- Automatic retry with backoff (beyond OpenAI SDK's built-in)
- `_router` metadata access on response objects
- Usage stats endpoints
- Config helpers

---

## Migration Guide

### From raw OpenAI calls:

```python
# Before
from openai import OpenAI
client = OpenAI(api_key="sk-...")

# After
from openai import OpenAI
client = OpenAI(
    base_url="https://api.promptrouter.dev/v1",
    api_key="pr-..."
)
# No other changes needed
```

### From LangChain:

```python
# Before
from langchain_openai import ChatOpenAI
llm = ChatOpenAI(model="gpt-4o")

# After
from langchain_openai import ChatOpenAI
llm = ChatOpenAI(
    model="auto",
    openai_api_base="https://api.promptrouter.dev/v1",
    openai_api_key="pr-..."
)
```

### From Anthropic SDK:

```python
# Before
from anthropic import Anthropic
client = Anthropic(api_key="sk-ant-...")
response = client.messages.create(
    model="claude-3-5-sonnet-20241022",
    messages=[...]
)

# After — use OpenAI-compatible format
from openai import OpenAI
client = OpenAI(
    base_url="https://api.promptrouter.dev/v1",
    api_key="pr-..."
)
response = client.chat.completions.create(
    model="auto",  # or "anthropic/claude-sonnet-4-5"
    messages=[...]
)
```

---

## Error Handling

```python
from promptrouter import PromptRouter
from promptrouter.errors import (
    RouterExhaustedError,  # All fallbacks failed
    BudgetExceededError,   # Request cost > budget_limit
    RateLimitError,        # User rate limit hit
    AuthError,             # Invalid API key
)

try:
    response = client.chat.completions.create(...)
except RouterExhaustedError as e:
    print(f"All models failed: {e.models_tried}")
except BudgetExceededError as e:
    print(f"Would cost ${e.estimated_cost:.4f}, limit is ${e.limit:.4f}")
except RateLimitError as e:
    print(f"Rate limited, retry after {e.retry_after}s")
```
