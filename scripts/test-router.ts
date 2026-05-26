/**
 * PromptRouter — Integration Test Script
 * Run with: npm test (or: npx tsx scripts/test-router.ts)
 *
 * Tests routing logic, intent classification, and live API calls
 * (set ANTHROPIC_API_KEY and DEEPSEEK_API_KEY to test live calls)
 */

import { classifyIntent, route, loadRegistry, estimateCost } from '../src/router';

// ─── Intent Classification Tests ─────────────────────────────────────────────

function testIntentClassification() {
  console.log('\n=== Intent Classification Tests ===\n');

  const cases: Array<{ messages: Array<{ role: 'user'; content: string }>; expected: string }> = [
    {
      messages: [{ role: 'user', content: 'Write a Python function to reverse a linked list' }],
      expected: 'code',
    },
    {
      messages: [{ role: 'user', content: 'Summarize this article in 3 bullet points: ...' }],
      expected: 'summary',
    },
    {
      messages: [{ role: 'user', content: 'What is the capital of France?' }],
      expected: 'chat',
    },
    {
      messages: [{ role: 'user', content: 'Write a short story about a robot who learns to paint' }],
      expected: 'creative',
    },
    {
      messages: [{ role: 'user', content: 'Calculate the derivative of x^3 + 2x + 1' }],
      expected: 'math',
    },
    {
      messages: [{ role: 'user', content: 'Extract the name, email, and phone from this text: ...' }],
      expected: 'structured',
    },
    {
      messages: [{ role: 'user', content: 'Explain how transformers work in machine learning' }],
      expected: 'research',
    },
    {
      messages: [{ role: 'user', content: 'Hey, how are you?' }],
      expected: 'chat',
    },
  ];

  let passed = 0;
  for (const { messages, expected } of cases) {
    const detected = classifyIntent(messages as any);
    const ok = detected === expected;
    if (ok) passed++;
    console.log(`${ok ? '✅' : '❌'} "${messages[0].content.substring(0, 50)}..."`);
    if (!ok) console.log(`   Expected: ${expected}, Got: ${detected}`);
  }

  console.log(`\nPassed: ${passed}/${cases.length}`);
}

// ─── Routing Decision Tests ───────────────────────────────────────────────────

function testRoutingDecisions() {
  console.log('\n=== Routing Decision Tests ===\n');

  const cases = [
    {
      desc: 'Code request → Claude Sonnet',
      messages: [{ role: 'user', content: 'Refactor this TypeScript class to use composition over inheritance' }],
      opts: {},
      expectedProvider: 'anthropic',
    },
    {
      desc: 'Chat request → DeepSeek',
      messages: [{ role: 'user', content: 'Hi, how is the weather?' }],
      opts: {},
      expectedProvider: 'deepseek',
    },
    {
      desc: 'Summary request → DeepSeek',
      messages: [{ role: 'user', content: 'Summarize this document...' }],
      opts: {},
      expectedProvider: 'deepseek',
    },
    {
      desc: 'Explicit intent override',
      messages: [{ role: 'user', content: 'Hello world' }],
      opts: { intent: 'code' as any },
      expectedProvider: 'anthropic',
    },
    {
      desc: 'Models blocked — no DeepSeek',
      messages: [{ role: 'user', content: 'Summarize this' }],
      opts: { modelsBlocked: ['deepseek/deepseek-chat'] },
      expectedProvider: 'openai',
    },
  ];

  let passed = 0;
  for (const { desc, messages, opts, expectedProvider } of cases) {
    try {
      const decision = route(messages as any, undefined, opts);
      const [provider] = decision.selected.id.split('/');
      const ok = provider === expectedProvider;
      if (ok) passed++;
      console.log(`${ok ? '✅' : '❌'} ${desc}`);
      console.log(`   → ${decision.selected.id} (intent: ${decision.intent})`);
      if (!ok) console.log(`   Expected provider: ${expectedProvider}`);
    } catch (err: any) {
      console.log(`❌ ${desc} — ERROR: ${err.message}`);
    }
  }

  console.log(`\nPassed: ${passed}/${cases.length}`);
}

// ─── Cost Estimation Tests ────────────────────────────────────────────────────

function testCostEstimation() {
  console.log('\n=== Cost Estimation Tests ===\n');

  const cases = [
    { model: 'deepseek/deepseek-chat', inputTokens: 1000, outputTokens: 500 },
    { model: 'anthropic/claude-sonnet-4-5', inputTokens: 1000, outputTokens: 500 },
    { model: 'openai/gpt-4o', inputTokens: 1000, outputTokens: 500 },
  ];

  for (const { model, inputTokens, outputTokens } of cases) {
    const cost = estimateCost(model, inputTokens, outputTokens);
    console.log(`${model}:`);
    console.log(`  ${inputTokens} in + ${outputTokens} out = $${cost.toFixed(6)}`);
  }
}

// ─── Live API Test (optional) ────────────────────────────────────────────────

async function testLiveAPICalls() {
  console.log('\n=== Live API Test ===\n');

  if (!process.env.ANTHROPIC_API_KEY && !process.env.DEEPSEEK_API_KEY) {
    console.log('⚠️  No API keys found. Skipping live tests.');
    console.log('   Set ANTHROPIC_API_KEY or DEEPSEEK_API_KEY to run live tests.');
    return;
  }

  const baseUrl = process.env.ROUTER_URL ?? 'http://localhost:3000';
  const apiKey = `pr-test-${Date.now()}`;

  const testCases = [
    {
      desc: 'Auto-route: chat',
      body: {
        model: 'auto',
        messages: [{ role: 'user', content: 'Say exactly: "PromptRouter works!"' }],
        max_tokens: 20,
      },
    },
    {
      desc: 'Explicit intent: summary',
      body: {
        model: 'auto',
        messages: [{ role: 'user', content: 'Summarize: AI is useful.' }],
        max_tokens: 30,
        _router: { intent: 'summary' },
      },
    },
  ];

  for (const { desc, body } of testCases) {
    try {
      const response = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
      });

      const data = await response.json() as any;

      if (data.choices) {
        console.log(`✅ ${desc}`);
        console.log(`   Model: ${data._router?.model_selected}`);
        console.log(`   Intent: ${data._router?.intent_detected}`);
        console.log(`   Response: "${data.choices[0].message.content}"`);
        console.log(`   Cost: $${data._router?.cost_usd?.toFixed(6)}`);
      } else {
        console.log(`❌ ${desc}: ${JSON.stringify(data.error)}`);
      }
    } catch (err: any) {
      console.log(`❌ ${desc}: ${err.message}`);
    }
  }
}

// ─── Run All ──────────────────────────────────────────────────────────────────

async function main() {
  console.log('PromptRouter Test Suite');
  console.log('══════════════════════');

  testIntentClassification();
  testRoutingDecisions();
  testCostEstimation();
  await testLiveAPICalls();

  console.log('\n✅ Test suite complete\n');
}

main().catch(console.error);
