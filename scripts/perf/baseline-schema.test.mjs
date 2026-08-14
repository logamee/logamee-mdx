import assert from 'node:assert/strict';
import test from 'node:test';

import {
  baselineGateMarkdown,
  compareBaselines,
  percentile,
  summarizeSamples,
  validateBaseline,
} from './baseline-schema.mjs';

function validBaseline(overrides = {}) {
  return {
    schemaVersion: 1,
    status: 'complete',
    environment: { os: 'darwin', arch: 'arm64' },
    app: { name: 'mmd', version: '0.1.0' },
    build: { profile: 'release', gitCommit: 'abc123' },
    index: { implementationId: 'bounded-in-memory-v1', schemaId: 'workspace-index-v1' },
    corpus: {
      fixtureVersion: 1,
      fixtureDigest: 'f'.repeat(64),
      seed: 7417,
      fileCount: 10_000,
      digest: 'a'.repeat(64),
      indexedMarkdownBytes: 5_000_000,
      limits: {
        maxFiles: 100_000,
        maxFileBytes: 1_048_576,
        maxAggregateBytes: 536_870_912,
        maxResults: 100,
        maxQueryChars: 256,
        maxSnippetChars: 240,
      },
    },
    measurement: {
      wallClock: 'process.hrtime.bigint',
      timingUnit: 'milliseconds',
      warmupCount: 2,
      sampleCount: 3,
      processCount: 6,
      errorCount: 0,
    },
    memory: {
      measurementKind: 'independentProcessPeakRssDelta',
      peakIncrementalBytesSamples: [100, 110, 120],
      estimatedIndexBytes: 80,
    },
    metrics: {
      coldBuildMs: { min: 10, median: 11, p95: 12, max: 12, samples: 3 },
      warmQueryMs: { min: 1, median: 2, p95: 3, max: 3, samples: 3 },
      peakIncrementalMemoryBytes: { min: 100, median: 110, p95: 120, max: 120, samples: 3 },
      cancellationMs: { min: 1, median: 1, p95: 2, max: 2, samples: 3 },
    },
    errors: [],
    incompleteReason: null,
    rebaseline: null,
    ...overrides,
  };
}

test('requires every M3 gate, identity, environment, corpus, and sampling field', () => {
  assert.deepEqual(validateBaseline(validBaseline()), []);
  for (const mutate of [
    (value) => { delete value.environment.arch; },
    (value) => { delete value.build.profile; },
    (value) => { delete value.index.implementationId; },
    (value) => { delete value.corpus.digest; },
    (value) => { delete value.corpus.fixtureDigest; },
    (value) => { delete value.corpus.limits.maxAggregateBytes; },
    (value) => { delete value.corpus.limits.maxFiles; },
    (value) => { delete value.corpus.limits.maxQueryChars; },
    (value) => { delete value.corpus.limits.maxSnippetChars; },
    (value) => { delete value.measurement.warmupCount; },
    (value) => { delete value.memory.measurementKind; },
    (value) => { delete value.metrics.coldBuildMs.p95; },
    (value) => { delete value.metrics.warmQueryMs.p95; },
    (value) => { delete value.metrics.peakIncrementalMemoryBytes.p95; },
    (value) => { delete value.metrics.cancellationMs.p95; },
  ]) {
    const value = structuredClone(validBaseline());
    mutate(value);
    assert.notDeepEqual(validateBaseline(value), []);
  }
});

test('excludes warmups and computes nearest-rank percentiles', () => {
  assert.equal(percentile([1, 2, 3, 4, 100], 0.95), 100);
  assert.deepEqual(summarizeSamples([99, 98, 1, 2, 3, 4, 100], 2), {
    min: 1,
    median: 3,
    p95: 100,
    max: 100,
    samples: 5,
  });
});

test('does not validate interrupted output as a complete baseline', () => {
  const interrupted = validBaseline({ status: 'incomplete', incompleteReason: 'SIGINT' });
  assert.match(validateBaseline(interrupted).join('\n'), /incomplete/);
});

test('rejects errors, inconsistent samples, and unordered distributions', () => {
  const errored = validBaseline();
  errored.measurement.errorCount = 1;
  errored.errors.push('query failed');
  const inconsistent = validBaseline();
  inconsistent.metrics.warmQueryMs.samples = 2;
  inconsistent.metrics.coldBuildMs.p95 = 9;

  assert.match(validateBaseline(errored).join('\n'), /error/);
  assert.match(validateBaseline(inconsistent).join('\n'), /samples.*sampleCount|not ordered/);
});

test('requires an explicit rebaseline record for environment or corpus changes', () => {
  const baseline = validBaseline();
  const changedEnvironment = validBaseline({ environment: { os: 'linux', arch: 'x64' } });
  const changedCorpus = validBaseline({ corpus: { ...baseline.corpus, digest: 'b'.repeat(64) } });

  assert.throws(() => compareBaselines(baseline, changedEnvironment), /rebaseline/i);
  assert.throws(() => compareBaselines(baseline, changedCorpus), /rebaseline/i);
  assert.doesNotThrow(() => compareBaselines(baseline, changedCorpus, {
    rebaseline: { reason: 'intentional fixture v2', recordedAt: '2026-07-30T00:00:00.000Z' },
  }));
});

test('renders every frozen gate from the artifact into one stable documentation row', () => {
  assert.equal(
    baselineGateMarkdown(validBaseline()),
    '| 10,000 | 5,000,000 | 1,048,576 | 536,870,912 | 12 | 3 | 120 | 2 |',
  );
});
