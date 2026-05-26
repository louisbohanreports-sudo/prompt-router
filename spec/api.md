# PromptRouter API Design

**Base URL:** `https://api.promptrouter.dev/v1`

**Auth:** Bearer token — `Authorization: Bearer pr-your-key-here`

---

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/v1/chat/completions` | OpenAI-compatible chat (drop-in replacement) |
| `POST` | `/v1/route` | Explicit routing with intent field |
| `GET` | `/v1/models` | Available models + pricing |
| `GET` | `/v1/usage` | Usage stats for current API key |
| `GET` | `/v1/health` | Provider health status |
| `GET` | `/v1/admin/stats` | Admin dashboard stats |

---

## POST /v1/chat/completions

**Drop-in OpenAI replacement.** All standard OpenAI chat completion fields are supported. Additional PromptRouter fields are optional.

### Request

```json
{
  "model": "auto",
  "messages": [
    {
      "role": "system",
      "content": "You are a helpful assistant."
    },
    {
      "role": "user",
      "content": "Write a Python function to parse JSON with error handling."
    }
  ],
  "temperature": 0.7,
  "max_tokens": 1024,
  "stream": false,

  "_router": {
    "intent": "code",
    "cache": true,
    "cache_ttl": 3600,
    "fallback": true,
    "budget_limit": 0.01
  }
}
```

**Standard fields** (OpenAI-compatible):
| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `model` | string | `"auto"` | Model ID or `"auto"` for intelligent routing |
| `messages` | array | required | Chat messages |
| `temperature` | float | 1.0 | Sampling temperature |
| `max_tokens` | int | null | Max output tokens |
| `stream` | bool | false | Stream response chunks |
| `stop` | string/array | null | Stop sequences |
| `top_p` | float | 1.0 | Nucleus sampling |

**PromptRouter extensions** (under `_router` key — ignored by OpenAI if accidentally forwarded):
| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `intent` | string | null | Explicit intent override (`code`, `chat`, `summary`, `research`, `creative`, `math`, `vision`, `structured`) |
| `cache` | bool | true | Enable response caching |
| `cache_ttl` | int | 3600 | Cache TTL in seconds |
| `fallback` | bool | true | Enable automatic failover |
| `budget_limit` | float | null | Max cost per request in USD |
| `prefer_speed` | bool | false | Prioritize latency over cost |
| `models_allowed` | array | null | Restrict to specific model IDs |
| `models_blocked` | array | null | Exclude specific model IDs |

### Response

```json
{
  "id": "pr-chatcmpl-abc123",
  "object": "chat.completion",
  "created": 1716700000,
  "model": "deepseek/deepseek-chat",
  "choices": [
    {
      "index": 0,
      "message": {
        "role": "assistant",
        "content": "Here's a Python function with error handling:\n\n```python\nimport json\n\ndef parse_json_safe(json_str: str) -> dict | None:\n    try:\n        return json.loads(json_str)\n    except json.JSONDecodeError as e:\n        print(f\"JSON parse error: {e}\")\n        return None\n```"
      },
      "finish_reason": "stop"
    }
  ],
  "usage": {
    "prompt_tokens": 47,
    "completion_tokens": 89,
    "total_tokens": 136
  },
  "_router": {
    "intent_detected": "code",
    "model_selected": "deepseek/deepseek-chat",
    "model_requested": "auto",
    "fallback_used": false,
    "cache_hit": false,
    "routing_latency_ms": 4,
    "provider_latency_ms": 892,
    "cost_usd": 0.0000367,
    "request_id": "pr-req-abc123"
  }
}
```

**Response extensions** (in `_router` key):
| Field | Type | Description |
|-------|------|-------------|
| `intent_detected` | string | Classified intent |
| `model_selected` | string | Actual model used |
| `model_requested` | string | Model in request (`auto` or explicit) |
| `fallback_used` | bool | Whether fallback was triggered |
| `fallbacks_tried` | array | Models tried before success |
| `cache_hit` | bool | Whether response was from cache |
| `routing_latency_ms` | int | Time spent in router (not provider) |
| `provider_latency_ms` | int | Time spent waiting for provider |
| `cost_usd` | float | Estimated cost at provider rates |
| `request_id` | string | For support/debugging |

---

## POST /v1/route

Explicit routing endpoint with full control. Same as `/v1/chat/completions` but with intent and routing as top-level fields (not nested).

### Request

```json
{
  "messages": [
    { "role": "user", "content": "Summarize this article: ..." }
  ],
  "intent": "summary",
  "temperature": 0.3,
  "max_tokens": 500,
  "cache": true,
  "fallback": true,
  "prefer_speed": false
}
```

### Response

Same as `/v1/chat/completions` response schema.

---

## GET /v1/models

Returns available models with pricing and capabilities.

### Response

```json
{
  "object": "list",
  "data": [
    {
      "id": "deepseek/deepseek-chat",
      "object": "model",
      "created": 1716700000,
      "owned_by": "deepseek",
      "display_name": "DeepSeek Chat",
      "pricing": {
        "input_per_1m": 0.27,
        "output_per_1m": 1.10,
        "currency": "USD"
      },
      "context_window": 64000,
      "capabilities": ["chat", "code", "summary", "structured"],
      "intents": ["chat", "summary", "structured", "research"],
      "availability": "available",
      "latency_p50_ms": 800,
      "latency_p95_ms": 2400
    },
    {
      "id": "anthropic/claude-haiku-3-5",
      "object": "model",
      "created": 1716700000,
      "owned_by": "anthropic",
      "display_name": "Claude Haiku 3.5",
      "pricing": {
        "input_per_1m": 0.80,
        "output_per_1m": 4.00,
        "currency": "USD"
      },
      "context_window": 200000,
      "capabilities": ["chat", "code", "summary", "structured", "creative"],
      "intents": ["chat", "structured", "summary"],
      "availability": "available",
      "latency_p50_ms": 600,
      "latency_p95_ms": 1800
    }
  ]
}
```

---

## GET /v1/usage

Returns usage statistics for the authenticated API key.

### Query Parameters

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `from` | ISO8601 | -7 days | Start date |
| `to` | ISO8601 | now | End date |
| `group_by` | string | `day` | `hour`, `day`, `model`, `intent` |

### Response

```json
{
  "period": {
    "from": "2026-05-18T00:00:00Z",
    "to": "2026-05-25T00:00:00Z"
  },
  "summary": {
    "total_requests": 1847,
    "total_tokens_in": 284920,
    "total_tokens_out": 193847,
    "total_cost_usd": 0.4821,
    "cache_hits": 412,
    "cache_hit_rate": 0.223,
    "fallbacks_triggered": 14
  },
  "by_model": [
    {
      "model": "deepseek/deepseek-chat",
      "requests": 1203,
      "tokens_in": 198440,
      "tokens_out": 134920,
      "cost_usd": 0.2018
    },
    {
      "model": "anthropic/claude-sonnet-4-5",
      "requests": 644,
      "tokens_in": 86480,
      "tokens_out": 58927,
      "cost_usd": 0.2803
    }
  ],
  "by_intent": [
    { "intent": "chat", "requests": 890, "cost_usd": 0.0924 },
    { "intent": "code", "requests": 512, "cost_usd": 0.2341 },
    { "intent": "summary", "requests": 445, "cost_usd": 0.0556 }
  ]
}
```

---

## GET /v1/health

Provider health status. No auth required (public endpoint).

### Response

```json
{
  "status": "operational",
  "providers": {
    "anthropic": {
      "status": "operational",
      "latency_ms": 720,
      "last_error": null,
      "degraded_since": null
    },
    "deepseek": {
      "status": "operational",
      "latency_ms": 890,
      "last_error": null,
      "degraded_since": null
    },
    "openai": {
      "status": "degraded",
      "latency_ms": 4200,
      "last_error": "rate_limit_exceeded",
      "degraded_since": "2026-05-25T03:15:00Z"
    }
  },
  "cache": {
    "status": "operational",
    "hit_rate_1h": 0.31
  }
}
```

---

## Error Handling

All errors follow OpenAI error format for compatibility:

```json
{
  "error": {
    "message": "All models failed for this request",
    "type": "router_exhausted",
    "code": "no_available_models",
    "param": null,
    "_router": {
      "request_id": "pr-req-abc123",
      "models_tried": ["deepseek/deepseek-chat", "anthropic/claude-haiku-3-5"],
      "last_error": "rate_limit_exceeded"
    }
  }
}
```

### Error Codes

| HTTP | Code | Description |
|------|------|-------------|
| 400 | `invalid_request` | Malformed request body |
| 401 | `invalid_api_key` | Missing or invalid `pr-` key |
| 402 | `budget_exceeded` | Request would exceed budget_limit |
| 429 | `rate_limit_exceeded` | Per-user rate limit hit |
| 503 | `no_available_models` | All models in fallback chain failed |
| 504 | `provider_timeout` | All providers timed out |

---

## Streaming

PromptRouter passes through SSE streams from providers. Set `"stream": true` in the request body.

```
data: {"id":"pr-chatcmpl-abc","object":"chat.completion.chunk","choices":[{"delta":{"content":"Here"},"index":0}]}

data: {"id":"pr-chatcmpl-abc","object":"chat.completion.chunk","choices":[{"delta":{"content":" is"},"index":0}]}

data: [DONE]
```

The final `data: [DONE]` includes `_router` metadata:

```
data: {"_router":{"intent_detected":"code","model_selected":"anthropic/claude-sonnet-4-5","cache_hit":false,"cost_usd":0.0021},"object":"chat.completion.done"}

data: [DONE]
```

---

## Versioning

API is versioned at path level (`/v1/`). Breaking changes increment to `/v2/`. Minor additions are backward-compatible in place.
