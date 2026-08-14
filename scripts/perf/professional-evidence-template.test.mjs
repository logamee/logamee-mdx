import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createProfessionalEvidenceTemplate } from './professional-evidence-template.mjs';
import { evaluateProfessionalGate, requiredMetricNames } from './professional-gate.mjs';

test('template enumerates every required observation without fabricating measurements', () => {
  const template = createProfessionalEvidenceTemplate('darwin-aarch64');
  assert.equal(template.status, 'incomplete');
  assert.deepEqual(Object.keys(template.metrics), requiredMetricNames());
  assert.ok(Object.values(template.metrics).every((value) => value === null));
  assert.equal(evaluateProfessionalGate(template).status, 'fail');
});
