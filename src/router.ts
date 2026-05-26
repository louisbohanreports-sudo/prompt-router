/**
 * PromptRouter — Core Routing Logic
 *
 * Classifies request intent, scores models, selects best fit,
 * handles fallback chains, and manages provider circuit breakers.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

// ─── Types ────────────────────────────────────────────────────────────────────

export type Intent =
  | 'chat'
  | 'code'
  | 'summary'
  | 'research'
  | 'creative'
  | 'math'
  | 'vision'
  | 'structured'
  | 'unknown';

export interface Message {
  role: 'system' | 'user' | 'assistant';
  content: string | null;
}

export interface RouterOptions {
  intent?: Intent;
  cache?: boolean;
  cacheTtl?: number;
  fallback?: boolean;
  budgetLimit?: number;
  preferSpeed?: boolean;
  modelsAllowed?: string[];
  modelsBlocked?: string[];
}

export interface ModelEntry {
  id: string;
  display_name: string;
  provider: string;
  provider_model_id: string;
  pricing: { input_per_1m: number; output_per_1m: number };
  context_window: number;
  capabilities: Record<string, boolean>;
  strengths: string[];
  weaknesses: string[];
  ideal_intents: string[];
  fallback_order: number;
  latency_profile: { p50_ms: number; p95_ms: number };
}

export interface ModelRegistry {
  models: ModelEntry[];
  intent_routing: Record<string, { primary: string; fallback_chain: string[] }>;
}

export interface RoutingDecision {
  selected: ModelEntry;
  intent: Intent;
  fallbackChain: string[];
  cacheKey?: string;
}

// ─── Intent Classifier ────────────────────────────────────────────────────────

const CODE_PATTERNS = [
  /\b(function|def |class |import |require|async |await|const |let |var |return|if\s*\(|for\s*\(|while\s*\()\b/,
  /\b(debug|refactor|implement|write a (function|class|script|program)|fix (this|the|my) (code|bug|error)|code review|unit test)\b/i,
  /```[\w]*\n/,
  /\b(typescript|javascript|python|rust|golang|java|c\+\+|ruby|php|bash|shell)\b/i,
  /\b(api|endpoint|database|schema|sql|query|regex|algorithm|data structure)\b/i,
];

const MATH_PATTERNS = [
  /\b(calculate|compute|solve|integral|derivative|equation|proof|theorem|probability|statistics)\b/i,
  /[\d]+\s*[\+\-\*\/\^]\s*[\d]+/,
  /\b(matrix|vector|linear algebra|calculus|geometry|trigonometry)\b/i,
  /\b(what is|how much|how many)\b.{0,50}(=|\d+)/i,
];

const SUMMARY_PATTERNS = [
  /\b(summarize|summary|tldr|tl;dr|brief|shorten|condense|key points|main points|overview)\b/i,
  /\b(what (are|is) the (main|key|important|core)|give me the gist)\b/i,
];

const RESEARCH_PATTERNS = [
  /\b(what is|who is|when did|where is|how does|why does|explain|tell me about|history of|overview of)\b/i,
  /\b(research|analyze|compare|pros and cons|advantages|disadvantages|difference between)\b/i,
];

const CREATIVE_PATTERNS = [
  /\b(write a\b.{0,20}\b(story|poem|song|joke|essay|blog|email|letter|caption|tagline|slogan|screenplay))\b/i,
  /\b(creative|fiction|narrative|imagine|pretend|roleplay|character|dialogue)\b/i,
  /\b(make it (funny|witty|poetic|dramatic|romantic|scary|whimsical))\b/i,
];

const STRUCTURED_PATTERNS = [
  /\b(extract|parse|classify|categorize|tag|label|format as json|output json|json schema|fill in|complete the)\b/i,
  /\b(yes or no|true or false|is this|does this|which of these|list of)\b/i,
];

const VISION_PATTERNS = [
  /\b(image|photo|picture|screenshot|diagram|chart|graph|figure)\b/i,
  /\b(what (do you see|is in|is this)|describe (this|the) (image|photo|picture))\b/i,
];

export function classifyIntent(messages: Message[]): Intent {
  // Extract text content
  const allText = messages
    .map(m => m.content ?? '')
    .join('\n')
    .toLowerCase();

  const userMessages = messages
    .filter(m => m.role === 'user')
    .map(m => m.content ?? '')
    .join('\n');

  const systemPrompt = messages
    .filter(m => m.role === 'system')
    .map(m => m.content ?? '')
    .join('\n');

  // System prompt hints take priority
  if (/\b(code|programming|developer|software|engineering)\b/i.test(systemPrompt)) {
    return 'code';
  }
  if (/\b(json|structured|extract|classify|parse)\b/i.test(systemPrompt)) {
    return 'structured';
  }
  if (/\b(creative|writer|story|narrative)\b/i.test(systemPrompt)) {
    return 'creative';
  }

  // Score each intent
  const scores: Record<Intent, number> = {
    code: 0, math: 0, summary: 0, research: 0,
    creative: 0, structured: 0, vision: 0,
    chat: 1, // baseline
    unknown: 0,
  };

  for (const pattern of CODE_PATTERNS) {
    if (pattern.test(userMessages)) scores.code += 2;
    if (pattern.test(allText)) scores.code += 1;
  }
  for (const pattern of MATH_PATTERNS) {
    if (pattern.test(userMessages)) scores.math += 2;
  }
  for (const pattern of SUMMARY_PATTERNS) {
    if (pattern.test(userMessages)) scores.summary += 3;
  }
  for (const pattern of RESEARCH_PATTERNS) {
    if (pattern.test(userMessages)) scores.research += 2;
  }
  for (const pattern of CREATIVE_PATTERNS) {
    if (pattern.test(userMessages)) scores.creative += 2;
  }
  for (const pattern of STRUCTURED_PATTERNS) {
    if (pattern.test(userMessages)) scores.structured += 2;
  }
  for (const pattern of VISION_PATTERNS) {
    if (pattern.test(userMessages)) scores.vision += 3;
  }

  // Very short, simple factual/conversational messages → chat
  // ("what is X" alone, < 60 chars, no domain signals → chat not research)
  if (userMessages.length < 60 && scores.code <= 1 && scores.math <= 1 &&
      scores.creative <= 1 && scores.summary <= 1 && scores.structured <= 1) {
    return 'chat';
  }

  // Find highest score
  const sorted = (Object.entries(scores) as [Intent, number][])
    .filter(([k]) => k !== 'unknown' && k !== 'chat')
    .sort(([, a], [, b]) => b - a);

  if (sorted[0][1] >= 2) {
    return sorted[0][0];
  }

  return 'chat';
}

// ─── Circuit Breaker ──────────────────────────────────────────────────────────

interface ProviderHealth {
  failures: number;
  lastFailure: number;
  degradedUntil: number;
}

const providerHealth = new Map<string, ProviderHealth>();

const CIRCUIT_BREAK_THRESHOLD = 3;       // failures before degraded
const CIRCUIT_BREAK_DURATION_MS = 5 * 60 * 1000; // 5 min cooldown

export function recordProviderFailure(provider: string): void {
  const health = providerHealth.get(provider) ?? { failures: 0, lastFailure: 0, degradedUntil: 0 };
  health.failures += 1;
  health.lastFailure = Date.now();

  if (health.failures >= CIRCUIT_BREAK_THRESHOLD) {
    health.degradedUntil = Date.now() + CIRCUIT_BREAK_DURATION_MS;
    console.warn(`[Router] Provider ${provider} circuit breaker tripped until ${new Date(health.degradedUntil).toISOString()}`);
  }

  providerHealth.set(provider, health);
}

export function recordProviderSuccess(provider: string): void {
  const health = providerHealth.get(provider);
  if (health) {
    health.failures = 0;
    health.degradedUntil = 0;
    providerHealth.set(provider, health);
  }
}

export function isProviderHealthy(provider: string): boolean {
  const health = providerHealth.get(provider);
  if (!health) return true;
  if (health.degradedUntil > Date.now()) return false;
  return true;
}

export function getProviderHealthStatus(): Record<string, any> {
  const status: Record<string, any> = {};
  for (const [provider, health] of providerHealth.entries()) {
    status[provider] = {
      status: health.degradedUntil > Date.now() ? 'degraded' : 'operational',
      failures: health.failures,
      degradedUntil: health.degradedUntil > 0 ? new Date(health.degradedUntil).toISOString() : null,
    };
  }
  return status;
}

// ─── Model Registry ───────────────────────────────────────────────────────────

let _registry: ModelRegistry | null = null;

export function loadRegistry(): ModelRegistry {
  if (_registry) return _registry;

  const registryPath = path.join(__dirname, '..', 'data', 'models.json');
  const raw = fs.readFileSync(registryPath, 'utf-8');
  _registry = JSON.parse(raw) as ModelRegistry;
  return _registry;
}

export function getModelById(id: string): ModelEntry | undefined {
  const registry = loadRegistry();
  return registry.models.find(m => m.id === id);
}

// ─── Model Scoring ────────────────────────────────────────────────────────────

function scoreModel(
  model: ModelEntry,
  intent: Intent,
  opts: RouterOptions,
): number {
  // Skip unavailable providers
  if (!isProviderHealthy(model.provider)) return -Infinity;

  // Apply allow/block lists
  if (opts.modelsAllowed && !opts.modelsAllowed.includes(model.id)) return -Infinity;
  if (opts.modelsBlocked && opts.modelsBlocked.includes(model.id)) return -Infinity;

  let score = 0;

  // Capability match (0–50 points)
  const intentMatch = model.ideal_intents.includes(intent);
  score += intentMatch ? 50 : 10;

  // Cost efficiency (0–30 points, inverted: cheaper = higher score)
  const costScore = 30 - Math.min(30, model.pricing.input_per_1m * 3);
  score += opts.preferSpeed ? costScore * 0.5 : costScore;

  // Speed (0–20 points)
  const speedScore = 20 - Math.min(20, model.latency_profile.p50_ms / 100);
  score += opts.preferSpeed ? speedScore * 2 : speedScore;

  // Fallback order preference (lower order = preferred primary)
  // Strong penalty — registry order is the curated human decision
  score -= model.fallback_order * 8;

  return score;
}

// ─── Router ───────────────────────────────────────────────────────────────────

export function buildCacheKey(messages: Message[], model: string, temperature: number): string {
  const payload = JSON.stringify({ messages, model, temperature });
  return crypto.createHash('sha256').update(payload).digest('hex');
}

export function selectModel(
  intent: Intent,
  opts: RouterOptions = {},
): { model: ModelEntry; fallbackChain: string[] } {
  const registry = loadRegistry();
  const routing = registry.intent_routing[intent] ?? registry.intent_routing['chat'];

  // Build candidate list: primary first, then fallback chain
  const candidateIds = [routing.primary, ...routing.fallback_chain];
  const candidates = candidateIds
    .map(id => registry.models.find(m => m.id === id))
    .filter(Boolean) as ModelEntry[];

  // Score and sort
  const scored = candidates
    .map(m => ({ model: m, score: scoreModel(m, intent, opts) }))
    .filter(({ score }) => score > -Infinity)
    .sort((a, b) => b.score - a.score);

  if (scored.length === 0) {
    throw new Error(`No available models for intent: ${intent}`);
  }

  const selected = scored[0].model;
  const fallbackChain = scored.slice(1).map(s => s.model.id);

  return { model: selected, fallbackChain };
}

export function route(
  messages: Message[],
  modelOverride: string | undefined,
  opts: RouterOptions = {},
): RoutingDecision {
  const registry = loadRegistry();

  // If explicit model requested (not "auto"), use it directly
  if (modelOverride && modelOverride !== 'auto') {
    const model = registry.models.find(m => m.id === modelOverride);
    if (!model) {
      throw new Error(`Unknown model: ${modelOverride}. Use model "auto" for intelligent routing.`);
    }
    const intent = opts.intent ?? classifyIntent(messages);
    const cacheKey = opts.cache !== false
      ? buildCacheKey(messages, modelOverride, 1.0)
      : undefined;
    return { selected: model, intent, fallbackChain: [], cacheKey };
  }

  // Classify intent
  const intent: Intent = opts.intent ?? classifyIntent(messages);

  // Select best model
  const { model, fallbackChain } = selectModel(intent, opts);

  // Build cache key
  const cacheKey = opts.cache !== false
    ? buildCacheKey(messages, model.id, 1.0)
    : undefined;

  return { selected: model, intent, fallbackChain, cacheKey };
}

// ─── Cost Estimation ─────────────────────────────────────────────────────────

export function estimateCost(
  modelId: string,
  inputTokens: number,
  outputTokens: number,
): number {
  const model = getModelById(modelId);
  if (!model) return 0;

  const inputCost = (inputTokens / 1_000_000) * model.pricing.input_per_1m;
  const outputCost = (outputTokens / 1_000_000) * model.pricing.output_per_1m;
  return inputCost + outputCost;
}
