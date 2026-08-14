import assert from 'node:assert/strict';
import test from 'node:test';

import { evaluateGateSuite } from './evaluate-gate-suite.mjs';

test('evaluates every corpus even when an earlier gate fails', async () => {
  const calls = [];
  const result = await evaluateGateSuite({
    gates: [
      { name: '10k', frozenPath: '10k-frozen.json', candidatePath: '10k.json' },
      { name: '100k', frozenPath: '100k-frozen.json', candidatePath: '100k.json' },
    ],
    evaluate: async ({ candidatePath }) => {
      calls.push(candidatePath);
      return candidatePath === '10k.json'
        ? { status: 'fail', fts5AdrRequired: false }
        : { status: 'pass', fts5AdrRequired: false };
    },
  });

  assert.deepEqual(calls, ['10k.json', '100k.json']);
  assert.equal(result.status, 'fail');
  assert.deepEqual(result.gates.map((gate) => gate.status), ['fail', 'pass']);
});

test('propagates the 100k FTS5 ADR requirement into the suite summary', async () => {
  const result = await evaluateGateSuite({
    gates: [{ name: '100k', frozenPath: 'frozen.json', candidatePath: 'candidate.json' }],
    evaluate: async () => ({ status: 'fail', fts5AdrRequired: true }),
  });

  assert.equal(result.status, 'fail');
  assert.equal(result.fts5AdrRequired, true);
});
