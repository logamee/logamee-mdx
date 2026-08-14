import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mergeProfessionalEvidence } from './merge-professional-evidence.mjs';

test('merges disjoint observations and marks evidence complete only when exhaustive', () => {
  const names = ['startup.coldMs', 'size.appBytes'];
  const partial = mergeProfessionalEvidence({ target: 'linux-x86_64', requiredNames: names, observations: [{ 'startup.coldMs': 10 }] });
  assert.equal(partial.status, 'incomplete');
  const complete = mergeProfessionalEvidence({ target: 'linux-x86_64', requiredNames: names, observations: [{ 'startup.coldMs': 10 }, { 'size.appBytes': 20 }] });
  assert.equal(complete.status, 'complete');
});

test('rejects duplicate, unknown and invalid observations', () => {
  const options = { target: 'linux-x86_64', requiredNames: ['startup.coldMs'] };
  assert.throws(() => mergeProfessionalEvidence({ ...options, observations: [{ 'startup.coldMs': 1 }, { 'startup.coldMs': 2 }] }), /duplicate/);
  assert.throws(() => mergeProfessionalEvidence({ ...options, observations: [{ unknown: 1 }] }), /unknown/);
  assert.throws(() => mergeProfessionalEvidence({ ...options, observations: [{ 'startup.coldMs': -1 }] }), /finite/);
});
