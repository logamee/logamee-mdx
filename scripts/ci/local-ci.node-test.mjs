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
    'code-size ratchet',
    'code-quality unit tests',
    'duplication ratchet',
    'dead-code',
    'circular deps',
    'frontend unit tests',
    'frontend production build',
    'rust check',
    'rust quality clippy',
    'rust unit tests',
  ]);

  const audit = steps[1];
  assert.equal(audit.command, 'node');
  assert.deepEqual(audit.args, ['scripts/ci/check-platform-apis.mjs']);

  const cargoSteps = steps.filter((step) => step.command === 'cargo');
  assert.equal(cargoSteps.length, 2);
  for (const step of cargoSteps) {
    assert.ok(step.args.includes('--manifest-path'), step.name);
  }

  const rustQuality = steps.find((step) => step.name === 'rust quality clippy');
  assert.equal(rustQuality.command, 'npm');
  assert.deepEqual(rustQuality.args, ['run', 'lint:rust-quality']);
  const rustCheckIndex = names.indexOf('rust check');
  const rustTestsIndex = names.indexOf('rust unit tests');
  assert.ok(rustCheckIndex < rustTestsIndex, 'rust gates keep their order');
  assert.ok(
    rustCheckIndex < names.indexOf('rust quality clippy')
      && names.indexOf('rust quality clippy') < rustTestsIndex,
    'rust quality clippy runs between rust check and rust unit tests',
  );
});

test('runLocalCi stops at the first failing step and reports the summary', async (t) => {
  const logMock = t.mock.method(console, 'log', () => {});
  const errorMock = t.mock.method(console, 'error', () => {});
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
  assert.ok(
    errorMock.mock.calls.some((call) => call.arguments.join(' ').includes('second failed')),
    'must report the failing step',
  );
  assert.equal(logMock.mock.callCount(), 3, 'must log progress without skipped steps');
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
