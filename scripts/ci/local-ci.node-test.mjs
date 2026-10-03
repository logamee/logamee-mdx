import assert from 'node:assert/strict';
import test from 'node:test';

import { buildDefaultSteps, runLocalCi } from './local-ci.mjs';

test('default steps follow the validation matrix order with the platform audit early', () => {
  const steps = buildDefaultSteps();
  const names = steps.map((step) => step.name);

  assert.deepEqual(names, [
    'git diff --check',
    'platform API audit',
    'frontend typecheck',
    'frontend lint',
    'frontend unit tests',
    'frontend production build',
    'rust check',
    'rust unit tests',
  ]);

  const audit = steps[1];
  assert.equal(audit.command, 'node');
  assert.deepEqual(audit.args, ['scripts/ci/check-platform-apis.mjs']);

  for (const step of steps.slice(6)) {
    assert.equal(step.command, 'cargo');
    assert.ok(step.args.includes('--manifest-path'), step.name);
  }
});

test('runLocalCi stops at the first failing step and reports the summary', async () => {
  const executed = [];
  const results = await runLocalCi({
    steps: [
      { name: 'first', exec: async () => { executed.push('first'); return { ok: true }; } },
      { name: 'second', exec: async () => { executed.push('second'); return { ok: false, output: 'boom' }; } },
      { name: 'third', exec: async () => { executed.push('third'); return { ok: true }; } },
    ],
  });

  assert.deepEqual(executed, ['first', 'second'], 'must be fail-fast');
  assert.equal(results.ok, false);
  assert.equal(results.failedStep, 'second');
  assert.deepEqual(
    results.steps.map((step) => [step.name, step.ok]),
    [['first', true], ['second', false], ['third', null]],
  );
});

test('runLocalCi reports success when every step passes', async () => {
  const results = await runLocalCi({
    steps: [
      { name: 'only', exec: async () => ({ ok: true }) },
    ],
  });

  assert.equal(results.ok, true);
  assert.equal(results.failedStep, null);
  assert.equal(results.steps[0].ok, true);
});
