/**
 * PromptRouter — Express Server
 *
 * OpenAI-compatible proxy with intelligent routing, caching,
 * fallback chains, usage tracking, key isolation, and rate limiting.
 *
 * Supports bring-your-own-key (free tier) and hosted (paid) models.
 * User API keys are encrypted at rest.
 */

import express, { Request, Response, NextFunction } from 'express';
import * as fs from 'fs';
import * as path from 'path';
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';

import rateLimit from 'express-rate-limit';

import {
  route,
  classifyIntent,
  loadRegistry,
  estimateCost,
  recordProviderFailure,
  recordProviderSuccess,
  isProviderHealthy,
  getProviderHealthStatus,
  buildCacheKey,
  type Message,
  type RouterOptions,
  type Intent,
} from './router';

import {
  authenticateUser,
  checkRateLimit,
  getProviderKey,
  registerUserWithKeys,
  registerHostedUser,
  type UserProfile,
} from './auth/key-manager';

// ─── Config ───────────────────────────────────────────────────────────────────

const PORT = process.env.PORT ?? 3000;
const ADMIN_SECRET = process.env.ADMIN_SECRET ?? 'dev-admin-secret';
const MODE = (process.env.ROUTER_MODE ?? 'hybrid') as 'bring_your_own' | 'hosted' | 'hybrid';

// ─── In-Memory Cache ─────────────────────────────────────────────────────────

interface CacheEntry {
  response: any;
  expiresAt: number;
  model: string;
  intent: string;
}

const cache = new Map<string, CacheEntry>();

function cacheGet(key: string): CacheEntry | null {
  const entry = cache.get(key);
  if (!entry) return null;
  if (entry.expiresAt < Date.now()) {
    cache.delete(key);
    return null;
  }
  return entry;
}

function cacheSet(key: string, response: any, ttlSeconds: number, model: string, intent: string): void {
  cache.set(key, {
    response,
    expiresAt: Date.now() + ttlSeconds * 1000,
    model,
    intent,
  });
}

// ─── Usage Log ────────────────────────────────────────────────────────────────

interface UsageRecord {
  timestamp: number;
  requestId: string;
  userId: string;
  intent: string;
  modelSelected: string;
  modelRequested: string;
  fallbackUsed: boolean;
  fallbacksTried: string[];
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  cacheHit: boolean;
  routingLatencyMs: number;
  providerLatencyMs: number;
  error?: string;
}

const usageLog: UsageRecord[] = [];

function logUsage(record: UsageRecord): void {
  usageLog.push(record);
  if (usageLog.length > 10000) usageLog.shift();
}

// ─── Provider Adapters ───────────────────────────────────────────────────────

async function callAnthropic(
  apiKey: string,
  modelId: string,
  messages: Message[],
  temperature: number,
  maxTokens: number,
): Promise<{ content: string; inputTokens: number; outputTokens: number }> {
  const client = new Anthropic({ apiKey });
  const providerModelId = modelId.split('/')[1];

  const systemMessages = messages.filter(m => m.role === 'system');
  const chatMessages = messages.filter(m => m.role !== 'system');
  const systemText = systemMessages.map(m => m.content).join('\n') || undefined;

  const response = await client.messages.create({
    model: providerModelId,
    max_tokens: maxTokens,
    temperature,
    system: systemText,
    messages: chatMessages.map(m => ({
      role: m.role as 'user' | 'assistant',
      content: m.content ?? '',
    })),
  });

  const content = response.content
    .filter(b => b.type === 'text')
    .map(b => (b as any).text)
    .join('');

  return {
    content,
    inputTokens: response.usage.input_tokens,
    outputTokens: response.usage.output_tokens,
  };
}

async function callDeepSeek(
  apiKey: string,
  messages: Message[],
  temperature: number,
  maxTokens: number,
): Promise<{ content: string; inputTokens: number; outputTokens: number }> {
  const client = new OpenAI({
    apiKey,
    baseURL: 'https://api.deepseek.com/v1',
  });

  const response = await client.chat.completions.create({
    model: 'deepseek-chat',
    messages: messages as any,
    temperature,
    max_tokens: maxTokens,
  });

  return {
    content: response.choices[0].message.content ?? '',
    inputTokens: response.usage?.prompt_tokens ?? 0,
    outputTokens: response.usage?.completion_tokens ?? 0,
  };
}

async function callOpenAI(
  apiKey: string,
  modelId: string,
  messages: Message[],
  temperature: number,
  maxTokens: number,
): Promise<{ content: string; inputTokens: number; outputTokens: number }> {
  const client = new OpenAI({ apiKey });
  const providerModelId = modelId.split('/')[1];

  const response = await client.chat.completions.create({
    model: providerModelId,
    messages: messages as any,
    temperature,
    max_tokens: maxTokens,
  });

  return {
    content: response.choices[0].message.content ?? '',
    inputTokens: response.usage?.prompt_tokens ?? 0,
    outputTokens: response.usage?.completion_tokens ?? 0,
  };
}

async function callModel(
  user: UserProfile,
  modelId: string,
  messages: Message[],
  temperature: number,
  maxTokens: number,
  timeoutMs = 30000,
): Promise<{ content: string; inputTokens: number; outputTokens: number }> {
  const [provider] = modelId.split('/');

  // Get the provider-specific API key
  // For BYOK: user's own key. For hosted: shared pool key.
  let apiKey: string | null;
  if (user.keyMode === 'bring_your_own') {
    apiKey = getProviderKey(user, provider);
  } else {
    // Hosted tier: use the global client (keys set at startup)
    apiKey = null; // will use global clients below
  }

  const callPromise = (async () => {
    switch (provider) {
      case 'anthropic': {
        const key = apiKey || process.env.ANTHROPIC_API_KEY || '';
        return callAnthropic(key, modelId, messages, temperature, maxTokens);
      }

      case 'deepseek': {
        const key = apiKey || process.env.DEEPSEEK_API_KEY || '';
        return callDeepSeek(key, messages, temperature, maxTokens);
      }

      case 'openai': {
        const key = apiKey || process.env.OPENAI_API_KEY || '';
        return callOpenAI(key, modelId, messages, temperature, maxTokens);
      }

      default:
        throw new Error(`Unknown provider: ${provider}`);
    }
  })();

  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error('Provider timeout')), timeoutMs)
  );

  return Promise.race([callPromise, timeout]);
}

// ─── Request ID ───────────────────────────────────────────────────────────────

let _reqCounter = 0;
function generateRequestId(): string {
  return `pr-req-${Date.now()}-${(++_reqCounter).toString(36)}`;
}

function generateCompletionId(): string {
  return `pr-chatcmpl-${Date.now().toString(36)}`;
}

// ─── Express App ─────────────────────────────────────────────────────────────

const app = express();
app.use(express.json({ limit: '2mb' }));

// ─── Global rate limiter (per-IP, per-user applied later) ─────────────────────

const globalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: { message: 'Too many requests', type: 'rate_limit', code: 'rate_limit' } },
});

app.use('/v1/', globalLimiter);

// ─── Authentication middleware ─────────────────────────────────────────────---

function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;

  if (!authHeader?.startsWith('Bearer ')) {
    res.status(401).json({
      error: {
        message: 'Missing API key. Use: Authorization: Bearer pr-...',
        type: 'invalid_api_key',
        code: 'invalid_api_key',
      },
    });
    return;
  }

  const apiKey = authHeader.slice('Bearer '.length).trim();
  const user = authenticateUser(apiKey);

  if (!user) {
    res.status(401).json({
      error: {
        message: 'Invalid API key. Register at /v1/register',
        type: 'invalid_api_key',
        code: 'invalid_api_key',
      },
    });
    return;
  }

  // Check rate limit
  if (!checkRateLimit(user)) {
    res.status(429).json({
      error: {
        message: 'Rate limit exceeded',
        type: 'rate_limit',
        code: 'rate_limit',
        retry_after_seconds: 60,
      },
    });
    return;
  }

  (req as any).user = user;
  next();
}

// ─── POST /v1/register ────────────────────────────────────────────────────────

app.post('/v1/register', (req: Request, res: Response) => {
  try {
    const { tier = 'free', keys } = req.body as {
      tier?: 'free' | 'pro' | 'enterprise';
      keys?: { anthropic?: string; deepseek?: string; openai?: string };
    };

    // Validate mode
    if (MODE === 'hosted' && tier === 'free') {
      res.status(400).json({
        error: { message: 'Free tier not available in hosted mode', type: 'invalid_request', code: 'invalid_request' },
      });
      return;
    }

    if (tier === 'free' && !keys) {
      res.status(400).json({
        error: { message: 'Free tier requires provider API keys (bring-your-own-key)', type: 'invalid_request', code: 'invalid_request' },
      });
      return;
    }

    const userId = `usr_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

    let apiKey: string;

    if (tier === 'free' || MODE === 'bring_your_own') {
      apiKey = registerUserWithKeys(userId, tier ?? 'free', keys ?? {});
    } else {
      apiKey = registerHostedUser(userId, tier as 'pro' | 'enterprise');
    }

    res.status(201).json({
      api_key: apiKey,
      user_id: userId,
      tier: tier ?? 'free',
      key_mode: keys ? 'bring_your_own' : 'hosted',
      instructions: {
        api_endpoint: `/v1/chat/completions`,
        auth: `Authorization: Bearer ${apiKey}`,
        docs: 'See README.md or spec/api.md for full API reference',
      },
    });

  } catch (err: any) {
    res.status(500).json({
      error: { message: err.message, type: 'internal_error', code: 'internal_error' },
    });
  }
});

// ─── POST /v1/chat/completions ────────────────────────────────────────────────

app.post('/v1/chat/completions', requireAuth, async (req: Request, res: Response) => {
  const user: UserProfile = (req as any).user;
  const requestId = generateRequestId();
  const routingStart = Date.now();

  try {
    const {
      model = 'auto',
      messages,
      temperature = 1.0,
      max_tokens = 1024,
      _router: routerOpts = {},
    } = req.body as {
      model?: string;
      messages: Message[];
      temperature?: number;
      max_tokens?: number;
      _router?: RouterOptions & { intent?: Intent; cache?: boolean; cache_ttl?: number; fallback?: boolean };
    };

    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      res.status(400).json({
        error: { message: 'messages is required and must be a non-empty array', type: 'invalid_request', code: 'invalid_request' },
      });
      return;
    }

    // Enforce model allowlist
    if (user.allowedModels.length > 0 && model !== 'auto') {
      if (!user.allowedModels.includes(model)) {
        res.status(403).json({
          error: { message: `Model '${model}' not allowed on your plan`, type: 'model_not_allowed', code: 'model_not_allowed' },
        });
        return;
      }
    }

    const opts: RouterOptions = {
      intent: routerOpts.intent,
      cache: routerOpts.cache !== false,
      cacheTtl: routerOpts.cache_ttl ?? 3600,
      fallback: routerOpts.fallback !== false,
      budgetLimit: routerOpts.budgetLimit,
      preferSpeed: routerOpts.preferSpeed ?? false,
      modelsAllowed: routerOpts.modelsAllowed,
      modelsBlocked: routerOpts.modelsBlocked,
    };

    // Route
    const decision = route(messages, model === 'auto' ? undefined : model, opts);
    const routingLatencyMs = Date.now() - routingStart;

    // Check cache
    if (opts.cache && decision.cacheKey) {
      const cached = cacheGet(decision.cacheKey);
      if (cached) {
        logUsage({
          timestamp: Date.now(),
          requestId,
          userId: user.userId,
          intent: decision.intent,
          modelSelected: cached.model,
          modelRequested: model,
          fallbackUsed: false,
          fallbacksTried: [],
          inputTokens: 0,
          outputTokens: 0,
          costUsd: 0,
          cacheHit: true,
          routingLatencyMs,
          providerLatencyMs: 0,
        });

        return res.json({
          ...cached.response,
          _router: {
            ...cached.response._router,
            cache_hit: true,
            request_id: requestId,
          },
        });
      }
    }

    // Try model + fallback chain
    const modelsToTry = [decision.selected.id, ...decision.fallbackChain];
    let lastError: Error | null = null;
    const fallbacksTried: string[] = [];

    for (let i = 0; i < modelsToTry.length; i++) {
      const modelId = modelsToTry[i];
      const [provider] = modelId.split('/');

      if (!isProviderHealthy(provider)) {
        fallbacksTried.push(modelId);
        continue;
      }

      const providerStart = Date.now();

      try {
        const result = await callModel(user, modelId, messages, temperature, max_tokens);
        const providerLatencyMs = Date.now() - providerStart;
        const costUsd = estimateCost(modelId, result.inputTokens, result.outputTokens);

        recordProviderSuccess(provider);

        const completionId = generateCompletionId();
        const response = {
          id: completionId,
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model: modelId,
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: result.content },
              finish_reason: 'stop',
            },
          ],
          usage: {
            prompt_tokens: result.inputTokens,
            completion_tokens: result.outputTokens,
            total_tokens: result.inputTokens + result.outputTokens,
          },
          _router: {
            intent_detected: decision.intent,
            model_selected: modelId,
            model_requested: model,
            fallback_used: i > 0,
            fallbacks_tried: fallbacksTried,
            cache_hit: false,
            routing_latency_ms: routingLatencyMs,
            provider_latency_ms: providerLatencyMs,
            cost_usd: costUsd,
            request_id: requestId,
          },
        };

        // Cache it
        if (opts.cache && decision.cacheKey) {
          cacheSet(decision.cacheKey, response, opts.cacheTtl ?? 3600, modelId, decision.intent);
        }

        logUsage({
          timestamp: Date.now(),
          requestId,
          userId: user.userId,
          intent: decision.intent,
          modelSelected: modelId,
          modelRequested: model,
          fallbackUsed: i > 0,
          fallbacksTried,
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens,
          costUsd,
          cacheHit: false,
          routingLatencyMs,
          providerLatencyMs,
        });

        return res.json(response);

      } catch (err: any) {
        console.error(`[Router] ${modelId} failed: ${err.message}`);
        recordProviderFailure(provider);
        fallbacksTried.push(modelId);
        lastError = err;

        if (!opts.fallback) break;
      }
    }

    // All models failed
    logUsage({
      timestamp: Date.now(),
      requestId,
      userId: user.userId,
      intent: decision.intent,
      modelSelected: 'none',
      modelRequested: model,
      fallbackUsed: false,
      fallbacksTried,
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
      cacheHit: false,
      routingLatencyMs,
      providerLatencyMs: 0,
      error: lastError?.message,
    });

    res.status(503).json({
      error: {
        message: 'All models in fallback chain failed',
        type: 'router_exhausted',
        code: 'no_available_models',
        _router: { request_id: requestId, models_tried: fallbacksTried, last_error: lastError?.message },
      },
    });

  } catch (err: any) {
    console.error('[Router] Unhandled error:', err);
    res.status(500).json({
      error: { message: err.message, type: 'internal_error', code: 'internal_error' },
    });
  }
});

// ─── POST /v1/route ───────────────────────────────────────────────────────────

app.post('/v1/route', requireAuth, async (req: Request, res: Response) => {
  const { intent, cache, cache_ttl, fallback, prefer_speed, ...rest } = req.body;
  req.body = {
    ...rest,
    model: rest.model ?? 'auto',
    _router: { intent, cache, cache_ttl, fallback, preferSpeed: prefer_speed },
  };

  return app._router.handle(
    Object.assign(req, { url: '/v1/chat/completions', path: '/v1/chat/completions' }),
    res,
    () => {}
  );
});

// ─── GET /v1/models ───────────────────────────────────────────────────────────

app.get('/v1/models', requireAuth, (req: Request, res: Response) => {
  const registry = loadRegistry();
  const now = Math.floor(Date.now() / 1000);

  const data = registry.models.map(m => ({
    id: m.id,
    object: 'model',
    created: now,
    owned_by: m.provider,
    display_name: m.display_name,
    pricing: { ...m.pricing },
    context_window: m.context_window,
    capabilities: m.capabilities,
    intents: m.ideal_intents,
    availability: isProviderHealthy(m.provider) ? 'available' : 'degraded',
    latency_p50_ms: m.latency_profile.p50_ms,
    latency_p95_ms: m.latency_profile.p95_ms,
  }));

  res.json({ object: 'list', data });
});

// ─── GET /v1/usage ────────────────────────────────────────────────────────────

app.get('/v1/usage', requireAuth, (req: Request, res: Response) => {
  const user: UserProfile = (req as any).user;
  const daysBack = parseInt((req.query.days as string) ?? '7', 10);
  const from = Date.now() - daysBack * 24 * 60 * 60 * 1000;

  const filtered = usageLog.filter(r => r.timestamp >= from && r.userId === user.userId);

  const totalRequests = filtered.length;
  const totalCost = filtered.reduce((s, r) => s + r.costUsd, 0);
  const totalTokensIn = filtered.reduce((s, r) => s + r.inputTokens, 0);
  const totalTokensOut = filtered.reduce((s, r) => s + r.outputTokens, 0);
  const cacheHits = filtered.filter(r => r.cacheHit).length;
  const fallbacks = filtered.filter(r => r.fallbackUsed).length;

  // By model
  const byModel: Record<string, any> = {};
  for (const r of filtered) {
    if (!byModel[r.modelSelected]) {
      byModel[r.modelSelected] = { model: r.modelSelected, requests: 0, tokens_in: 0, tokens_out: 0, cost_usd: 0 };
    }
    byModel[r.modelSelected].requests++;
    byModel[r.modelSelected].tokens_in += r.inputTokens;
    byModel[r.modelSelected].tokens_out += r.outputTokens;
    byModel[r.modelSelected].cost_usd += r.costUsd;
  }

  res.json({
    period: { from: new Date(from).toISOString(), to: new Date().toISOString() },
    summary: {
      total_requests: totalRequests,
      total_tokens_in: totalTokensIn,
      total_tokens_out: totalTokensOut,
      total_cost_usd: Math.round(totalCost * 1e6) / 1e6,
      cache_hits: cacheHits,
      cache_hit_rate: totalRequests > 0 ? Math.round(cacheHits / totalRequests * 1000) / 1000 : 0,
      fallbacks_triggered: fallbacks,
    },
    by_model: Object.values(byModel),
  });
});

// ─── GET /v1/health ───────────────────────────────────────────────────────────

app.get('/v1/health', (req: Request, res: Response) => {
  const healthStatus = getProviderHealthStatus();
  const allHealthy = ['anthropic', 'deepseek', 'openai'].every(
    p => !healthStatus[p] || healthStatus[p].status === 'operational'
  );

  res.json({
    status: allHealthy ? 'operational' : 'degraded',
    mode: MODE,
    providers: {
      anthropic: { status: healthStatus.anthropic?.status ?? 'operational', ...healthStatus.anthropic },
      deepseek: { status: healthStatus.deepseek?.status ?? 'operational', ...healthStatus.deepseek },
      openai: { status: healthStatus.openai?.status ?? 'operational', ...healthStatus.openai },
    },
    cache: { status: 'operational', size: cache.size },
  });
});

// ─── Admin ────────────────────────────────────────────────────────────────────

app.get('/admin/stats', (req: Request, res: Response) => {
  const adminKey = req.headers['x-admin-secret'];
  if (adminKey !== ADMIN_SECRET) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const last24h = Date.now() - 24 * 60 * 60 * 1000;
  const recent = usageLog.filter(r => r.timestamp >= last24h);

  res.json({
    uptime_seconds: Math.floor(process.uptime()),
    total_requests_all_time: usageLog.length,
    requests_last_24h: recent.length,
    active_users: new Set(usageLog.slice(-1000).map(r => r.userId)).size,
    cache_entries: cache.size,
    cost_last_24h_usd: recent.reduce((s, r) => s + r.costUsd, 0),
    provider_health: getProviderHealthStatus(),
  });
});

// ─── Start ────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`
╔═══════════════════════════════════════════════════╗
║            PromptRouter v0.2.0                    ║
║  Intelligent LLM Routing Proxy                   ║
║  Mode: ${MODE.padEnd(38)}║
╚═══════════════════════════════════════════════════╝

Listening on http://localhost:${PORT}

Endpoints:
  POST /v1/register           Create API key (free = BYOK, pro = hosted)
  POST /v1/chat/completions   OpenAI-compatible chat
  POST /v1/route              Explicit intent routing
  GET  /v1/models             Available models
  GET  /v1/usage              Your usage stats
  GET  /v1/health             Service health

Providers configured:
  ${process.env.ANTHROPIC_API_KEY ? '✓' : '✗'} Anthropic (Claude)
  ${process.env.DEEPSEEK_API_KEY ? '✓' : '✗'} DeepSeek
  ${process.env.OPENAI_API_KEY ? '✓' : '✗'} OpenAI

Ready to route! 🚀
  `);
});

export default app;
