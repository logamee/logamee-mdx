import assert from 'node:assert/strict';
import { test } from 'node:test';
import { evaluateProfessionalGate, requiredMetricNames } from './professional-gate.mjs';

function completeEvidence() {
  return {
    schemaVersion: 1,
    status: 'complete',
    target: 'linux-x86_64',
    measuredAt: '2026-08-12T12:00:00.000Z',
    metrics: Object.fromEntries(requiredMetricNames().map((name) => [name, name.endsWith('Bytes') ? 1_000_000 : 10])),
  };
}

test('requires startup, document, canvas, memory and package measurements', () => {
  const result = evaluateProfessionalGate(completeEvidence());
  assert.equal(result.status, 'pass');
  assert.equal(result.checks.length, requiredMetricNames().length);
  for (const prefix of ['startup.', 'markdown.', 'excalidraw.', 'memory.', 'size.']) {
    assert.ok(requiredMetricNames().some((name) => name.startsWith(prefix)), `missing ${prefix}`);
  }
});

test('fails closed on missing, unexpected, non-finite, and over-budget metrics', () => {
  const evidence = completeEvidence();
  delete evidence.metrics['markdown.5mb.previewMs'];
  evidence.metrics['startup.warmMs'] = Number.NaN;
  evidence.metrics['size.installerBytes'] = Number.MAX_SAFE_INTEGER;
  evidence.metrics['unknown.metric'] = 1;
  const result = evaluateProfessionalGate(evidence);
  assert.equal(result.status, 'fail');
  assert.ok(result.errors.some((error) => error.includes('missing')));
  assert.ok(result.errors.some((error) => error.includes('unexpected')));
  assert.ok(result.errors.some((error) => error.includes('finite')));
  assert.ok(result.failedBudgets.includes('size.installerBytes'));
});

test('rejects incomplete and unknown target evidence', () => {
  assert.equal(evaluateProfessionalGate({ ...completeEvidence(), status: 'partial' }).status, 'fail');
  assert.equal(evaluateProfessionalGate({ ...completeEvidence(), target: 'browser' }).status, 'fail');
});
