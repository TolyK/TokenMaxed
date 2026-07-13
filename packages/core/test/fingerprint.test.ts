import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fingerprintTask } from '../src/fingerprint.ts';
import { routeDecide } from '../src/route.ts';
import type { RouteContext, Task, Lane, Policy } from '../src/types.ts';

test('fingerprint: language sub-signal scoring and confidence', () => {
  // Test distinct languages
  const pyTask = fingerprintTask('Write a python function to compute prime factors. Write a python script.');
  assert.equal(pyTask.language.lang, 'python');
  // Since score is high, confidence should be strong
  assert.ok(pyTask.language.confidence > 0.3);

  const tsTask = fingerprintTask('Fix a typescript type error in the config file. Write a typescript module.');
  assert.equal(tsTask.language.lang, 'ts');

  // Test fenced code blocks (higher priority)
  const fencedTask = fingerprintTask('Check this:\n```rust\nfn main() {}\n```');
  assert.equal(fencedTask.language.lang, 'rust');

  // Test fallback/unknown
  const unknownTask = fingerprintTask('Hello world task with no language indicators.');
  assert.equal(unknownTask.language.lang, 'unknown');
  assert.equal(unknownTask.language.confidence, 0);
});

test('fingerprint: specialized C++ and C# detection', () => {
  // C++ word detection
  const cppTask1 = fingerprintTask('Write C++ code for high performance computing.');
  assert.equal(cppTask1.language.lang, 'cpp');
  assert.ok(cppTask1.language.confidence > 0);

  const cppTask2 = fingerprintTask('Write some cpp code.');
  assert.equal(cppTask2.language.lang, 'cpp');

  // C# word detection
  const csharpTask1 = fingerprintTask('Write C# code for a unity game.');
  assert.equal(csharpTask1.language.lang, 'csharp');
  assert.ok(csharpTask1.language.confidence > 0);

  const csharpTask2 = fingerprintTask('Write some csharp code.');
  assert.equal(csharpTask2.language.lang, 'csharp');

  // Fenced block detection for C# and C++
  const cppFenced = fingerprintTask('```c++\nint main() {}\n```');
  assert.equal(cppFenced.language.lang, 'cpp');

  const csharpFenced = fingerprintTask('```c#\nclass Program {}\n```');
  assert.equal(csharpFenced.language.lang, 'csharp');
});

test('fingerprint: confidence strength and tie behavior', () => {
  // Weak evidence (single kw hit) stays low confidence or gets dropped to unknown
  const weakTask = fingerprintTask('Write some java.');
  // Top score is 3 (one kw), second score is 0. Separation = 1.0. Strength = 3/15 = 0.2.
  // Confidence = 0.2, which is >= 0.15, so it resolves to java with confidence 0.2 (low!)
  assert.equal(weakTask.language.lang, 'java');
  assert.equal(weakTask.language.confidence, 0.2);

  // Genuinely tied/ambiguous evidence -> unknown/low confidence
  const tiedTask = fingerprintTask('typescript javascript');
  assert.equal(tiedTask.language.lang, 'unknown');
  assert.equal(tiedTask.language.confidence, 0);
});

test('fingerprint: context size bands', () => {
  // Small
  const smallTask = fingerprintTask('a', { referencedFileCount: 0 });
  assert.equal(smallTask.contextSizeBand, 'small');

  // Medium (referencing files or length)
  const medTask1 = fingerprintTask('a'.repeat(3001), { referencedFileCount: 0 });
  const medTask2 = fingerprintTask('a', { referencedFileCount: 2 });
  assert.equal(medTask1.contextSizeBand, 'medium');
  assert.equal(medTask2.contextSizeBand, 'medium');

  // Large
  const largeTask1 = fingerprintTask('a'.repeat(15001), { referencedFileCount: 0 });
  const largeTask2 = fingerprintTask('a', { referencedFileCount: 5 });
  assert.equal(largeTask1.contextSizeBand, 'large');
  assert.equal(largeTask2.contextSizeBand, 'large');

  // XLarge
  const xlTask1 = fingerprintTask('a'.repeat(50001), { referencedFileCount: 0 });
  const xlTask2 = fingerprintTask('a', { referencedFileCount: 11 });
  assert.equal(xlTask1.contextSizeBand, 'xlarge');
  assert.equal(xlTask2.contextSizeBand, 'xlarge');
});

test('fingerprint: tool need detection', () => {
  const lowNeed = fingerprintTask('explain how the routing works');
  assert.equal(lowNeed.toolNeed, 'low');

  const medNeed = fingerprintTask('run typecheck on the codebase');
  assert.equal(medNeed.toolNeed, 'medium');

  const highNeed = fingerprintTask('npm install and npm run test and run tests to compile the project');
  assert.equal(highNeed.toolNeed, 'high');
});

test('fingerprint: plan vs implementation', () => {
  const planTask = fingerprintTask('design the new architecture and draft the spec proposal blueprint');
  assert.equal(planTask.planVsImpl, 'plan');

  const implTask = fingerprintTask('implement the fix and write the patch');
  assert.equal(implTask.planVsImpl, 'impl');

  const mixedTask = fingerprintTask('design the workflow and write the implementation code');
  assert.equal(mixedTask.planVsImpl, 'mixed');
});

test('fingerprint: security sensitivity', () => {
  const safe = fingerprintTask('simple helper function');
  assert.equal(safe.securitySensitive, false);

  const sensitive = fingerprintTask('rotate the jwt token session private key');
  assert.equal(sensitive.securitySensitive, true);
});

test('fingerprint: blast radius', () => {
  const narrow = fingerprintTask('isolated helper function local tweak');
  assert.equal(narrow.blastRadius, 'narrow');

  const moderate = fingerprintTask('rename directory and packages across multiple files');
  assert.equal(moderate.blastRadius, 'moderate');

  const wide = fingerprintTask('migration schema change breaking change global refactor');
  assert.equal(wide.blastRadius, 'wide');
});

test('fingerprint: whitespace handling and empty inputs', () => {
  const empty = fingerprintTask('   \n\t  ');
  assert.equal(empty.language.lang, 'unknown');
  assert.equal(empty.contextSizeBand, 'small');
  assert.equal(empty.toolNeed, 'low');
  assert.equal(empty.planVsImpl, 'impl');
  assert.equal(empty.securitySensitive, false);
  assert.equal(empty.blastRadius, 'narrow');

  const padded = fingerprintTask('  \n\t Write a python function  \t\n ');
  assert.equal(padded.language.lang, 'python');
});

test('fingerprint: finite-safety and recursive assertions on huge inputs', () => {
  const hugeText = 'Write a python script. '.repeat(10000); // ~230KB
  const start = Date.now();
  const res = fingerprintTask(hugeText);
  const duration = Date.now() - start;
  assert.ok(duration < 200, `Fingerprinting huge text took too long: ${duration}ms`);
  assert.equal(res.language.lang, 'python');

  // Recursive check for numeric fields & confidence
  assertNumericLimits(res);

  // Also check for empty/whitespace input
  const emptyRes = fingerprintTask('   \n   ');
  assertNumericLimits(emptyRes);
});

test('fingerprint: content-free enforcement via deep-walk recursive assertions', () => {
  const text = 'SuperSecretToken 1234567890 python compile rename everywhere';
  const fileCount = 42;
  const res = fingerprintTask(text, { referencedFileCount: fileCount });

  // Deep-walk and assert no content/raw size leakage
  assertContentFree(res, text, fileCount, text.length);

  // The output must contain only structural keys
  const expectedKeys = ['language', 'contextSizeBand', 'toolNeed', 'planVsImpl', 'securitySensitive', 'blastRadius'];
  assert.deepEqual(Object.keys(res).sort(), expectedKeys.sort());
});

test('fingerprint: routing invariance with extreme values (P1 display-only constraint)', () => {
  const task: Task = { category: 'codegen', difficulty: 'easy' };
  const lanes: Lane[] = [
    {
      id: 'lane-1',
      kind: 'cli',
      model: 'claude-3-5-sonnet',
      trust_mode: 'full',
      costBasis: 'subscription',
      provenance: 'vendor',
      jurisdiction: 'global',
      capability: { codegen: 0.9, explain: 0.9, refactor: 0.9, bugfix: 0.9, boilerplate: 0.9, docs: 0.9, feature: 0.9 }
    },
    {
      id: 'lane-2',
      kind: 'cli',
      model: 'claude-3-haiku',
      trust_mode: 'full',
      costBasis: 'subscription',
      provenance: 'vendor',
      jurisdiction: 'global',
      capability: { codegen: 0.5, explain: 0.5, refactor: 0.5, bugfix: 0.5, boilerplate: 0.5, docs: 0.5, feature: 0.5 }
    }
  ];

  const policy: Policy = {
    disabledLaneIds: [],
  };

  const ctxWithoutFingerprint: RouteContext = {
    lanes,
    gateReady: true,
    routingPolicy: 'balanced',
  };

  // Extreme fingerprint values most likely to be mistakenly consumed by routing
  const extremeFingerprint = {
    language: { lang: 'ts', confidence: 0.99 },
    contextSizeBand: 'xlarge' as const,
    toolNeed: 'high' as const,
    planVsImpl: 'plan' as const,
    securitySensitive: true,
    blastRadius: 'wide' as const,
  };

  const ctxWithFingerprint: RouteContext = {
    ...ctxWithoutFingerprint,
    fingerprint: extremeFingerprint,
  };

  const dec1 = routeDecide(task, ctxWithoutFingerprint, policy);
  const dec2 = routeDecide(task, ctxWithFingerprint, policy);

  // Decisions must be absolutely byte-identical
  assert.deepEqual(dec1, dec2);
});

// --- Test Helpers -------------------------------------------------------------

function assertContentFree(obj: any, inputText: string, fileCount: number, originalLen: number) {
  const ignoredWords = new Set([
    'ts', 'js', 'python', 'go', 'rust', 'java', 'c', 'cpp', 'csharp', 'ruby', 'php', 'shell', 'sql', 'unknown',
    'small', 'medium', 'large', 'xlarge', 'low', 'high', 'plan', 'mixed', 'impl', 'narrow', 'moderate', 'wide',
    'true', 'false', 'yes', 'no'
  ]);
  const words = inputText.toLowerCase().split(/[^a-z0-9]+/i).filter(w => w.length >= 3 && !ignoredWords.has(w));
  const forbiddenNumbers = new Set([fileCount, originalLen]);

  function walk(value: any) {
    if (typeof value === 'string') {
      const valLower = value.toLowerCase();
      for (const word of words) {
        assert.ok(!valLower.includes(word), `Fingerprint string value "${value}" contains input substring "${word}"`);
      }
    } else if (typeof value === 'number') {
      assert.ok(!forbiddenNumbers.has(value), `Fingerprint contains forbidden number ${value}`);
    } else if (value && typeof value === 'object') {
      for (const k of Object.keys(value)) {
        // Assert key does not contain input substring
        const keyLower = k.toLowerCase();
        for (const word of words) {
          assert.ok(!keyLower.includes(word), `Fingerprint key "${k}" contains input substring "${word}"`);
        }
        // Assert key is not a forbidden number
        const keyNum = Number(k);
        if (Number.isFinite(keyNum)) {
          assert.ok(!forbiddenNumbers.has(keyNum), `Fingerprint key "${k}" represents forbidden number ${keyNum}`);
        }
        walk(value[k]);
      }
    }
  }
  walk(obj);
}

function assertNumericLimits(obj: any) {
  function walk(value: any) {
    if (typeof value === 'number') {
      assert.ok(Number.isFinite(value), `Numeric value ${value} must be finite`);
    } else if (value && typeof value === 'object') {
      if ('confidence' in value && typeof value.confidence === 'number') {
        assert.ok(value.confidence >= 0 && value.confidence <= 1, `Confidence ${value.confidence} must be in [0, 1]`);
      }
      for (const k of Object.keys(value)) {
        walk(value[k]);
      }
    }
  }
  walk(obj);
}
