/**
 * PromptRouter — Soul Profile Loader
 *
 * Loads and validates the user's routing soul profile (soul.yaml).
 * The soul profile defines priorities, budget, provider preferences,
 * privacy rules, ethics preferences, and routing overrides.
 *
 * This is PromptRouter's core differentiator: routing that respects
 * your values, not just cost and speed.
 */

import * as fs from 'fs';
import * as path from 'path';

// ─── Types ────────────────────────────────────────────────────────────────────

export type PriorityLevel = 'critical' | 'high' | 'medium' | 'low' | 'off';
export type ModelTier = 'economy' | 'standard' | 'premium' | 'unrestricted';
export type DataJurisdiction = 'us' | 'eu' | 'any';
export type DataPolicy = 'strict' | 'standard' | 'permissive';

export interface SoulProfile {
  version: string;

  profile?: {
    name?: string;
    owner?: string;
    description?: string;
  };

  priorities: {
    cost: PriorityLevel;
    speed: PriorityLevel;
    quality: PriorityLevel;
    privacy: PriorityLevel;
    ethics: PriorityLevel;
  };

  budget: {
    max_cost_per_request: number;
    max_cost_per_day: number;
    alert_threshold: number;
    downgrade_on_exceed: boolean;
  };

  providers: {
    preferred: string[];
    deprioritized: string[];
    forbidden: string[];
  };

  models: {
    prefer_for: Record<string, string>;
    forbidden: string[];
    max_tier: ModelTier;
  };

  quality: {
    min_context_window: number;
    require_vision_for_vision: boolean;
    require_function_calling_for_structured: boolean;
    high_stakes_intents: string[];
  };

  privacy: {
    required_data_policy: DataPolicy;
    block_if_prompt_contains: string[];
    redact_patterns: string[];
  };

  ethics: {
    prefer_published_ai_policy: boolean;
    prefer_audited_providers: boolean;
    avoid_data_selling_providers: boolean;
    preferred_data_jurisdiction: DataJurisdiction;
  };

  overrides: Array<{
    name: string;
    condition: {
      prompt_max_length?: number;
      prompt_contains?: string[];
      intents?: string[];
    };
    route_to: string;
  }>;

  fallback: {
    max_retries: number;
    retry_delay_seconds: number;
    on_total_failure: 'error' | 'last_resort';
    last_resort_model: string;
  };

  cache: {
    enabled: boolean;
    ttl_seconds: number;
    max_entries: number;
    skip_for_intents: string[];
  };

  audit: {
    log_routing_decisions: boolean;
    log_costs: boolean;
    log_intent_scores: boolean;
    log_file: string;
  };
}

// ─── Provider Metadata ────────────────────────────────────────────────────────
// Static metadata used for ethics/privacy scoring

const PROVIDER_METADATA: Record<string, {
  data_policy: DataPolicy;
  jurisdiction: DataJurisdiction;
  published_ai_policy: boolean;
  audited: boolean;
  data_selling: boolean;
  tier: ModelTier;
}> = {
  anthropic: {
    data_policy: 'strict',
    jurisdiction: 'us',
    published_ai_policy: true,
    audited: true,
    data_selling: false,
    tier: 'premium',
  },
  deepseek: {
    data_policy: 'standard',
    jurisdiction: 'any',
    published_ai_policy: true,
    audited: false,
    data_selling: false,
    tier: 'economy',
  },
  openai: {
    data_policy: 'standard',
    jurisdiction: 'us',
    published_ai_policy: true,
    audited: true,
    data_selling: false,
    tier: 'standard',
  },
};

const TIER_ORDER: ModelTier[] = ['economy', 'standard', 'premium', 'unrestricted'];

// ─── Defaults ────────────────────────────────────────────────────────────────

const DEFAULT_SOUL: SoulProfile = {
  version: '1.0',
  priorities: { cost: 'medium', speed: 'medium', quality: 'medium', privacy: 'medium', ethics: 'medium' },
  budget: { max_cost_per_request: 0.50, max_cost_per_day: 50.00, alert_threshold: 0.80, downgrade_on_exceed: true },
  providers: { preferred: [], deprioritized: [], forbidden: [] },
  models: { prefer_for: {}, forbidden: [], max_tier: 'unrestricted' },
  quality: { min_context_window: 4000, require_vision_for_vision: true, require_function_calling_for_structured: false, high_stakes_intents: ['code', 'math'] },
  privacy: { required_data_policy: 'standard', block_if_prompt_contains: [], redact_patterns: [] },
  ethics: { prefer_published_ai_policy: false, prefer_audited_providers: false, avoid_data_selling_providers: false, preferred_data_jurisdiction: 'any' },
  overrides: [],
  fallback: { max_retries: 3, retry_delay_seconds: 2, on_total_failure: 'error', last_resort_model: 'deepseek/deepseek-chat' },
  cache: { enabled: true, ttl_seconds: 3600, max_entries: 1000, skip_for_intents: ['vision'] },
  audit: { log_routing_decisions: true, log_costs: true, log_intent_scores: false, log_file: 'logs/routing-audit.jsonl' },
};

// ─── Loader ───────────────────────────────────────────────────────────────────

let _cached: SoulProfile | null = null;

export function loadSoul(soulPath?: string): SoulProfile {
  if (_cached) return _cached;

  const targetPath = soulPath ?? path.join(process.cwd(), 'soul.yaml');

  if (!fs.existsSync(targetPath)) {
    console.log('[Soul] No soul.yaml found — using default routing profile');
    _cached = DEFAULT_SOUL;
    return _cached;
  }

  try {
    // Parse YAML manually (avoid adding yaml dep — use simple key: value parser)
    // For production, swap this with js-yaml or @iarna/toml
    const raw = fs.readFileSync(targetPath, 'utf-8');
    const parsed = parseSimpleYaml(raw);
    _cached = deepMerge(DEFAULT_SOUL, parsed) as SoulProfile;
    console.log(`[Soul] Loaded routing profile: ${_cached.profile?.name ?? 'unnamed'}`);
    return _cached;
  } catch (e) {
    console.error('[Soul] Failed to parse soul.yaml — using defaults:', e);
    _cached = DEFAULT_SOUL;
    return _cached;
  }
}

export function reloadSoul(): void {
  _cached = null;
}

// ─── Soul-Aware Scoring ───────────────────────────────────────────────────────

export interface SoulScoreResult {
  allowed: boolean;
  blockReason?: string;
  modelOverride?: string;
  scoreModifiers: Record<string, number>;   // provider → score adjustment (-100 to +100)
  redactedPrompt?: string;
  warnings: string[];
}

/**
 * Apply soul profile to a routing decision.
 * Returns score modifiers, blocks, overrides, and redaction instructions.
 */
export function applySoul(
  prompt: string,
  intent: string,
  soul: SoulProfile,
  estimatedCost: number,
): SoulScoreResult {
  const result: SoulScoreResult = {
    allowed: true,
    scoreModifiers: {},
    warnings: [],
  };

  // ── 1. Privacy: block if sensitive content detected ──────
  for (const pattern of soul.privacy.block_if_prompt_contains) {
    try {
      const re = new RegExp(pattern, 'i');
      if (re.test(prompt)) {
        result.allowed = false;
        result.blockReason = `Prompt contains sensitive content matching policy: ${pattern}`;
        return result;
      }
    } catch { /* invalid regex — skip */ }
  }

  // ── 2. Privacy: redact patterns ──────────────────────────
  let redacted = prompt;
  for (const pattern of soul.privacy.redact_patterns) {
    try {
      redacted = redacted.replace(new RegExp(pattern, 'gi'), '[REDACTED]');
    } catch { /* invalid regex — skip */ }
  }
  if (redacted !== prompt) {
    result.redactedPrompt = redacted;
    result.warnings.push('Prompt contained sensitive patterns — redacted before sending');
  }

  // ── 3. Budget: check per-request limit ───────────────────
  if (estimatedCost > soul.budget.max_cost_per_request) {
    if (soul.budget.downgrade_on_exceed) {
      result.warnings.push(`Estimated cost $${estimatedCost.toFixed(4)} exceeds budget $${soul.budget.max_cost_per_request} — downgrading model`);
      result.modelOverride = soul.fallback.last_resort_model;
    } else {
      result.allowed = false;
      result.blockReason = `Estimated cost $${estimatedCost.toFixed(4)} exceeds per-request budget $${soul.budget.max_cost_per_request}`;
      return result;
    }
  }

  // ── 4. Override: check routing overrides ─────────────────
  for (const override of soul.overrides) {
    const cond = override.condition;
    let matches = true;

    if (cond.prompt_max_length && prompt.length > cond.prompt_max_length) matches = false;
    if (cond.intents && !cond.intents.includes(intent)) matches = false;
    if (cond.prompt_contains) {
      const allFound = cond.prompt_contains.every(kw => prompt.toLowerCase().includes(kw.toLowerCase()));
      if (!allFound) matches = false;
    }

    if (matches) {
      result.modelOverride = override.route_to;
      result.warnings.push(`Routing override applied: ${override.name}`);
      break; // First match wins
    }
  }

  // ── 5. Intent: check for soul-defined model preference ───
  if (!result.modelOverride && soul.models.prefer_for[intent]) {
    result.modelOverride = soul.models.prefer_for[intent];
  }

  // ── 6. Provider: build score modifiers ───────────────────
  const priorityWeight = (p: PriorityLevel): number => {
    const map: Record<PriorityLevel, number> = { critical: 40, high: 25, medium: 10, low: 5, off: 0 };
    return map[p] ?? 0;
  };

  for (const [providerId, meta] of Object.entries(PROVIDER_METADATA)) {
    let modifier = 0;

    // Forbidden providers → hard block
    if (soul.providers.forbidden.includes(providerId)) {
      result.scoreModifiers[providerId] = -Infinity;
      continue;
    }

    // Preferred providers → boost
    if (soul.providers.preferred.includes(providerId)) {
      modifier += 20;
    }

    // Deprioritized providers → penalty
    if (soul.providers.deprioritized.includes(providerId)) {
      modifier -= 20;
    }

    // Cost priority → boost cheap providers
    if (soul.priorities.cost === 'critical' || soul.priorities.cost === 'high') {
      if (meta.tier === 'economy') modifier += priorityWeight(soul.priorities.cost);
      if (meta.tier === 'premium') modifier -= priorityWeight(soul.priorities.cost) * 0.5;
    }

    // Privacy priority → boost strict providers
    if (soul.priorities.privacy !== 'off') {
      const policyScore = { strict: 2, standard: 1, permissive: 0 };
      modifier += policyScore[meta.data_policy] * priorityWeight(soul.priorities.privacy) * 0.1;
    }

    // Ethics priority
    if (soul.priorities.ethics !== 'off') {
      const weight = priorityWeight(soul.priorities.ethics);
      if (soul.ethics.prefer_published_ai_policy && meta.published_ai_policy) modifier += weight * 0.3;
      if (soul.ethics.prefer_audited_providers && meta.audited) modifier += weight * 0.3;
      if (soul.ethics.avoid_data_selling_providers && meta.data_selling) modifier -= weight;
      if (soul.ethics.preferred_data_jurisdiction !== 'any') {
        if (meta.jurisdiction === soul.ethics.preferred_data_jurisdiction) modifier += weight * 0.2;
        else modifier -= weight * 0.1;
      }
    }

    result.scoreModifiers[providerId] = modifier;
  }

  // ── 7. Model tier cap ────────────────────────────────────
  const maxTierIdx = TIER_ORDER.indexOf(soul.models.max_tier);
  for (const [providerId, meta] of Object.entries(PROVIDER_METADATA)) {
    const tierIdx = TIER_ORDER.indexOf(meta.tier);
    if (tierIdx > maxTierIdx && !result.scoreModifiers[providerId]) {
      result.scoreModifiers[providerId] = -Infinity;
    }
  }

  return result;
}

// ─── Minimal YAML parser ──────────────────────────────────────────────────────
// Handles simple key: value, lists (- item), and nested objects via indentation
// Not a full YAML parser — sufficient for soul.yaml structure
// For production, replace with js-yaml

function parseSimpleYaml(raw: string): Record<string, any> {
  // Strip comments
  const lines = raw.split('\n').map(l => l.replace(/#.*$/, '').trimEnd());
  return parseBlock(lines, 0).result;
}

function parseBlock(lines: string[], baseIndent: number): { result: Record<string, any>; consumed: number } {
  const result: Record<string, any> = {};
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === '') { i++; continue; }

    const indent = line.search(/\S/);
    if (indent < baseIndent) break;
    if (indent > baseIndent) { i++; continue; }

    // List item
    if (line.trim().startsWith('- ')) {
      i++;
      continue;
    }

    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) { i++; continue; }

    const key = line.substring(indent, colonIdx).trim();
    const rawVal = line.substring(colonIdx + 1).trim();

    if (rawVal !== '') {
      // Inline value
      result[key] = parseScalar(rawVal);
      i++;
    } else {
      // Look ahead for nested content
      i++;
      if (i >= lines.length) break;

      const nextLine = lines[i];
      const nextIndent = nextLine.search(/\S/);

      if (nextIndent > indent) {
        // Check if it's a list
        if (nextLine.trim().startsWith('- ')) {
          const items: any[] = [];
          while (i < lines.length) {
            const l = lines[i];
            if (l.trim() === '') { i++; continue; }
            const ind = l.search(/\S/);
            if (ind < nextIndent) break;
            if (l.trim().startsWith('- ')) {
              items.push(parseScalar(l.trim().substring(2)));
              i++;
            } else {
              i++;
            }
          }
          result[key] = items;
        } else {
          // Nested object
          const sub = parseBlock(lines.slice(i), nextIndent);
          result[key] = sub.result;
          i += sub.consumed;
        }
      } else {
        result[key] = null;
      }
    }
  }

  return { result, consumed: i };
}

function parseScalar(val: string): any {
  if (val === 'true') return true;
  if (val === 'false') return false;
  if (val === 'null' || val === '~') return null;
  if (/^\d+$/.test(val)) return parseInt(val, 10);
  if (/^\d+\.\d+$/.test(val)) return parseFloat(val);
  // Strip quotes
  if ((val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))) {
    return val.slice(1, -1);
  }
  return val;
}

function deepMerge(base: any, override: any): any {
  if (!override || typeof override !== 'object') return base;
  const result = { ...base };
  for (const key of Object.keys(override)) {
    if (override[key] !== null && typeof override[key] === 'object' && !Array.isArray(override[key])) {
      result[key] = deepMerge(base[key] ?? {}, override[key]);
    } else if (override[key] !== null) {
      result[key] = override[key];
    }
  }
  return result;
}

// ─── Audit Logger ─────────────────────────────────────────────────────────────

export interface AuditEntry {
  ts: string;
  intent: string;
  model_selected: string;
  intent_scores?: Record<string, number>;
  soul_modifiers?: Record<string, number>;
  estimated_cost: number;
  overrides_applied: string[];
  warnings: string[];
  cached: boolean;
}

export function writeAuditLog(entry: AuditEntry, soul: SoulProfile): void {
  if (!soul.audit.log_routing_decisions) return;

  try {
    const logPath = path.join(process.cwd(), soul.audit.log_file);
    const dir = path.dirname(logPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    const line = JSON.stringify({
      ...entry,
      ts: new Date().toISOString(),
    }) + '\n';

    fs.appendFileSync(logPath, line);
  } catch {
    // Non-critical — audit log failure shouldn't break routing
  }
}
