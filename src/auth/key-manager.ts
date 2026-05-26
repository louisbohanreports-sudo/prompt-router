/**
 * Key Manager — API key authentication and user isolation
 *
 * Supports three modes:
 *   bring_your_own  — user provides their own API keys (free tier)
 *   hosted           — user gets a PromptRouter-managed key (paid tier)
 *   hybrid           — free tier brings keys, paid uses managed pool
 *
 * User keys are encrypted at rest using AES-256-GCM.
 * Provider keys are never exposed to users.
 */

import * as crypto from 'crypto';

// ─── Types ────────────────────────────────────────────────────────────────────

export type KeyMode = 'bring_your_own' | 'hosted' | 'hybrid';

export interface UserKeySet {
  anthropic?: string;
  deepseek?: string;
  openai?: string;
  xai?: string;
  google?: string;
}

export interface UserProfile {
  userId: string;
  tier: 'free' | 'pro' | 'enterprise';
  keyMode: KeyMode;
  keys?: UserKeySet;          // populated for bring_your_own
  apiKeyHash: string;         // hash of our API key for routing
  createdAt: number;
  rateLimit: number;          // requests per minute
  allowedModels: string[];    // empty = all models
  maxDailyCost?: number;      // cost cap for hosted tier
}

// ─── Encryption ───────────────────────────────────────────────────────────────

const ENCRYPTION_KEY = process.env.KEY_ENCRYPTION_KEY
  ? Buffer.from(process.env.KEY_ENCRYPTION_KEY, 'hex')
  : crypto.randomBytes(32);   // In dev, generate on startup

const KEY_SALT = process.env.KEY_SALT
  ? Buffer.from(process.env.KEY_SALT, 'hex')
  : crypto.randomBytes(16);

function encrypt(text: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', ENCRYPTION_KEY, iv);
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const tag = cipher.getAuthTag().toString('hex');
  return `${iv.toString('hex')}:${tag}:${encrypted}`;
}

function decrypt(encrypted: string): string {
  const [ivHex, tagHex, data] = encrypted.split(':');
  const iv = Buffer.from(ivHex, 'hex');
  const tag = Buffer.from(tagHex, 'hex');
  const decipher = crypto.createDecipheriv('aes-256-gcm', ENCRYPTION_KEY, iv);
  decipher.setAuthTag(tag);
  let decrypted = decipher.update(data, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

function hashApiKey(apiKey: string): string {
  return crypto.createHash('sha256').update(apiKey).digest('hex');
}

// ─── Key Store (In-Memory, swap for DB in production) ─────────────────────────

const users = new Map<string, UserProfile>();
const apiKeyToUser = new Map<string, string>(); // apiKeyHash → userId

// For hosted tier: shared provider key pool
const providerKeys: Record<string, string[]> = {
  anthropic: process.env.ANTHROPIC_API_KEY ? [process.env.ANTHROPIC_API_KEY] : [],
  deepseek: process.env.DEEPSEEK_API_KEY ? [process.env.DEEPSEEK_API_KEY] : [],
  openai: process.env.OPENAI_API_KEY ? [process.env.OPENAI_API_KEY] : [],
};

let keyPoolIndex = 0;

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Register a new user with the bring-your-own-key model.
 * Keys are encrypted at rest.
 */
export function registerUserWithKeys(
  userId: string,
  tier: 'free' | 'pro' | 'enterprise',
  keys: UserKeySet,
): string {
  const apiKey = `pr-${crypto.randomBytes(24).toString('hex')}`;
  const apiKeyHash = hashApiKey(apiKey);

  const encryptedKeys: UserKeySet = {};
  if (keys.anthropic) encryptedKeys.anthropic = encrypt(keys.anthropic);
  if (keys.deepseek) encryptedKeys.deepseek = encrypt(keys.deepseek);
  if (keys.openai) encryptedKeys.openai = encrypt(keys.openai);
  if (keys.xai) encryptedKeys.xai = encrypt(keys.xai);
  if (keys.google) encryptedKeys.google = encrypt(keys.google);

  const profile: UserProfile = {
    userId,
    tier,
    keyMode: 'bring_your_own',
    keys: encryptedKeys,
    apiKeyHash,
    createdAt: Date.now(),
    rateLimit: tier === 'enterprise' ? 1000 : tier === 'pro' ? 200 : 60,
    allowedModels: [],
    maxDailyCost: undefined,
  };

  users.set(userId, profile);
  apiKeyToUser.set(apiKeyHash, userId);

  return apiKey;
}

/**
 * Register a user on the hosted tier (PromptRouter-managed keys).
 */
export function registerHostedUser(
  userId: string,
  tier: 'pro' | 'enterprise',
): string {
  const apiKey = `pr-${crypto.randomBytes(24).toString('hex')}`;
  const apiKeyHash = hashApiKey(apiKey);

  const profile: UserProfile = {
    userId,
    tier,
    keyMode: 'hosted',
    apiKeyHash,
    createdAt: Date.now(),
    rateLimit: tier === 'enterprise' ? 1000 : 200,
    allowedModels: [],
    maxDailyCost: tier === 'enterprise' ? 100 : 10,
  };

  users.set(userId, profile);
  apiKeyToUser.set(apiKeyHash, userId);

  return apiKey;
}

/**
 * Authenticate a user by their PromptRouter API key.
 * Returns the user profile or null if invalid.
 */
export function authenticateUser(apiKey: string): UserProfile | null {
  const hash = hashApiKey(apiKey);
  const userId = apiKeyToUser.get(hash);
  if (!userId) return null;
  return users.get(userId) ?? null;
}

/**
 * Get the provider API key(s) for a model request.
 * For BYOK users: decrypt and return their keys.
 * For hosted users: return a round-robin key from the shared pool.
 */
export function getProviderKey(
  user: UserProfile,
  provider: string,
): string | null {
  if (user.keyMode === 'bring_your_own' && user.keys) {
    const encrypted = user.keys[provider as keyof UserKeySet];
    if (!encrypted) return null;
    try {
      return decrypt(encrypted);
    } catch {
      console.error(`[KeyManager] Failed to decrypt key for user ${user.userId}, provider ${provider}`);
      return null;
    }
  }

  // Hosted tier: use shared pool
  const pool = providerKeys[provider];
  if (!pool || pool.length === 0) return null;
  keyPoolIndex = (keyPoolIndex + 1) % pool.length;
  return pool[keyPoolIndex];
}

/**
 * Check if a user has exceeded their rate limit.
 */
export function checkRateLimit(user: UserProfile): boolean {
  // Simple in-memory rate limit. In production, use Redis + sliding window.
  const now = Date.now();
  const windowMs = 60_000; // 1 minute

  const rateKey = `rate:${user.userId}`;
  const timestamps = rateLimitStore.get(rateKey) ?? [];
  const recent = timestamps.filter(t => now - t < windowMs);

  if (recent.length >= user.rateLimit) {
    return false; // rate limited
  }

  recent.push(now);
  rateLimitStore.set(rateKey, recent);
  return true;
}

const rateLimitStore = new Map<string, number[]>();

// Clean up rate limit store periodically
setInterval(() => {
  const now = Date.now();
  const windowMs = 60_000;
  for (const [key, timestamps] of rateLimitStore.entries()) {
    const recent = timestamps.filter(t => now - t < windowMs);
    if (recent.length === 0) {
      rateLimitStore.delete(key);
    } else {
      rateLimitStore.set(key, recent);
    }
  }
}, 30_000);

/**
 * Get user by ID
 */
export function getUser(userId: string): UserProfile | undefined {
  return users.get(userId);
}
