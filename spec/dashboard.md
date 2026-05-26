# PromptRouter Dashboard — Concept & Mockup

## Overview

The dashboard is the "proof of value" for PromptRouter users. It answers one core question:

> **"How much money am I saving by using PromptRouter?"**

Secondary: visibility into what's happening, what's broken, and what's slow.

---

## Dashboard Sections

### 1. Savings Hero (Top of Page)

```
┌─────────────────────────────────────────────────────────┐
│  THIS MONTH                                             │
│  ┌───────────────┐  ┌───────────────┐  ┌─────────────┐ │
│  │ YOU PAID      │  │ DIRECT COST   │  │ YOU SAVED   │ │
│  │ $12.40        │  │ $31.20        │  │ $18.80 🎉   │ │
│  │               │  │ (no routing)  │  │  60% saved  │ │
│  └───────────────┘  └───────────────┘  └─────────────┘ │
└─────────────────────────────────────────────────────────┘
```

**What "direct cost" means:** What it would have cost if every request went to GPT-4o (or whatever the user's default model was before PromptRouter).

This is the hook that keeps users subscribed.

---

### 2. Request Volume Chart

Line chart: requests per day over last 30 days, colored by intent type.

```
Requests/day
300│                              ●
   │                         ●  ● ●
200│              ●      ●  ●
   │         ● ●    ● ●
100│    ● ●
   │●
   └─────────────────────────────────
     May 1              May 25
     
     ■ code  ■ chat  ■ summary  ■ research  ■ creative
```

---

### 3. Cost by Model Breakdown

Donut chart + table.

```
           Cost This Month: $12.40
           
    ┌─────────────────────────────────────────┐
    │                                         │
    │    ████████████ DeepSeek Chat   $3.20   │
    │    ████████     Claude Sonnet   $7.40   │
    │    ████         Claude Haiku    $1.80   │
    │                                         │
    └─────────────────────────────────────────┘
```

---

### 4. Cache Performance

```
┌───────────────────────────────────┐
│ CACHE                             │
│                                   │
│  Hit rate (7d):    31.4%         │
│  Requests saved:   412           │
│  Tokens saved:     184,920       │
│  Cost saved:       $0.23         │
│                                   │
│  [■■■■■■■■■░░░░░░░░░░░] 31%     │
└───────────────────────────────────┘
```

---

### 5. Latency Breakdown

```
P50 Latency by Model (last 24h)
─────────────────────────────────
DeepSeek Chat      ████░░░  800ms
Claude Haiku       ████░░░  650ms
Claude Sonnet      ██████░  1200ms
GPT-4o             ████████ 1600ms

Router overhead:  4ms avg
```

---

### 6. Provider Health

Traffic-light status for each provider.

```
┌─────────────────────────────────────────┐
│ PROVIDER HEALTH                         │
├─────────────────────────────────────────┤
│ ● Anthropic    Operational  720ms avg  │
│ ● DeepSeek     Operational  890ms avg  │
│ ○ OpenAI       Degraded     4200ms avg │
│   ↳ Rate limit issues since 03:15 UTC  │
└─────────────────────────────────────────┘
```

---

### 7. Intent Distribution

```
INTENT BREAKDOWN (30 days)
──────────────────────────
chat        ████████████████  48%  (890 req)
code        ████████████      27%  (512 req)
summary     ██████            14%  (261 req)
research    ████               7%   (130 req)
creative     ██                4%    (54 req)
```

---

### 8. Recent Requests Log

```
RECENT REQUESTS
─────────────────────────────────────────────────────────
Time      Intent    Model          Tokens  Cost    Cache
03:14:22  code      claude-sonnet  1,240   $0.003  MISS
03:14:18  chat      deepseek-chat  340     $0.0001 HIT
03:14:01  summary   deepseek-chat  890     $0.0003 MISS
03:13:45  code      claude-sonnet  2,100   $0.005  MISS
03:13:30  chat      deepseek-chat  210     $0.0001 HIT
                                          [Load more]
```

---

## HTML Mockup

Below is a minimal single-file HTML dashboard mockup that can be served at `/admin`:

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>PromptRouter Dashboard</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: system-ui, sans-serif; background: #0f0f0f; color: #e0e0e0; padding: 24px; }
    h1 { font-size: 1.4rem; margin-bottom: 24px; color: #fff; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 16px; margin-bottom: 24px; }
    .card { background: #1a1a1a; border: 1px solid #2a2a2a; border-radius: 12px; padding: 20px; }
    .card .label { font-size: 0.75rem; color: #666; text-transform: uppercase; letter-spacing: 1px; }
    .card .value { font-size: 2rem; font-weight: 700; margin-top: 8px; color: #fff; }
    .card .sub { font-size: 0.8rem; color: #22c55e; margin-top: 4px; }
    .card .sub.warn { color: #f59e0b; }
    table { width: 100%; border-collapse: collapse; background: #1a1a1a; border-radius: 12px; overflow: hidden; }
    th { background: #222; padding: 12px; text-align: left; font-size: 0.75rem; text-transform: uppercase; color: #666; }
    td { padding: 12px; border-top: 1px solid #222; font-size: 0.875rem; }
    .badge { padding: 2px 8px; border-radius: 999px; font-size: 0.7rem; font-weight: 600; }
    .badge.hit { background: #14532d; color: #4ade80; }
    .badge.miss { background: #1c1c1c; color: #666; }
    .badge.up { background: #14532d; color: #4ade80; }
    .badge.down { background: #7f1d1d; color: #f87171; }
  </style>
</head>
<body>
  <h1>⚡ PromptRouter Dashboard</h1>

  <div class="grid">
    <div class="card">
      <div class="label">Total Requests (30d)</div>
      <div class="value">1,847</div>
      <div class="sub">↑ 12% from last month</div>
    </div>
    <div class="card">
      <div class="label">Cost This Month</div>
      <div class="value">$12.40</div>
      <div class="sub">Saved $18.80 vs direct</div>
    </div>
    <div class="card">
      <div class="label">Cache Hit Rate</div>
      <div class="value">31.4%</div>
      <div class="sub">412 cached responses</div>
    </div>
    <div class="card">
      <div class="label">Avg Latency (P50)</div>
      <div class="value">840ms</div>
      <div class="sub warn">+4ms router overhead</div>
    </div>
  </div>

  <table>
    <thead>
      <tr>
        <th>Time</th><th>Intent</th><th>Model</th><th>Tokens</th><th>Cost</th><th>Cache</th>
      </tr>
    </thead>
    <tbody id="requests">
      <tr>
        <td>03:14:22</td>
        <td>code</td>
        <td>claude-sonnet-4-5</td>
        <td>1,240</td>
        <td>$0.0031</td>
        <td><span class="badge miss">MISS</span></td>
      </tr>
      <tr>
        <td>03:14:18</td>
        <td>chat</td>
        <td>deepseek-chat</td>
        <td>340</td>
        <td>$0.0001</td>
        <td><span class="badge hit">HIT</span></td>
      </tr>
    </tbody>
  </table>
</body>
</html>
```

---

## Future Dashboard Features

- **Cost forecast** — project end-of-month spend based on current rate
- **Anomaly alerts** — spike in requests, unexpected model usage, high error rate
- **Budget controls** — set hard limits, get email when approaching threshold
- **Team view** — see usage by API key / project / user
- **Export** — CSV/JSON download of request logs
- **Webhooks** — POST to your endpoint on budget threshold, provider outage, etc.
