import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { evaluateFrozenGate } from './evaluate-gates.mjs';

function artifact({ fileCount = 100_000 } = {}) {
  return {
    schemaVersion: 1,
    status: 'complete',
    environment: { os: 'darwin', arch: 'arm64' },
    app: { name: 'mmd', version: '0.1.0' },
    build: {
      profile: 'release',
      gitCommit: 'abc123',
      dirty: false,
      runner: 'cargo mmd_bench',
    },
    index: {
      implementationId: 'mmd-memory-substring-v1',
      schemaId: 'mmd-workspace-index-v1',
    },
    corpus: {
      fixtureVersion: 1,
      fixtureDigest: 'f'.repeat(64),
      seed: 7417,
      fileCount,
      digest: `sha256-v1:${'a'.repeat(64)}`,
      indexedMarkdownBytes: 35_000_000,
      limits: {
        maxFiles: 100_000,
        maxFileBytes: 1_048_576,
        maxAggregateBytes: 268_435_456,
        maxResults: 100,
        maxQueryChars: 256,
        maxSnippetChars: 240,
      },
    },
    measurement: {
      wallClock: 'std::time::Instant',
      timingUnit: 'milliseconds',
      warmupCount: 2,
      sampleCount: 5,
      processCount: 10,
      errorCount: 0,
    },
    memory: {
      measurementKind: 'independentProcessPeakRssDelta',
      peakIncrementalBytesSamples: [100, 100, 100, 100, 100],
      estimatedIndexBytes: 80,
    },
    metrics: {
      coldBuildMs: { min: 8, median: 9, p95: 10, max: 10, samples: 5 },
      warmQueryMs: { min: 1, median: 1, p95: 2, max: 2, samples: 5 },
      peakIncrementalMemoryBytes: { min: 100, median: 100, p95: 100, max: 100, samples: 5 },
      cancellationMs: { min: 1, median: 1, p95: 2, max: 2, samples: 5 },
    },
    errors: [],
    incompleteReason: null,
    rebaseline: null,
  };
}

test('passes when every candidate p95 is at or below its frozen threshold', () => {
  const frozen = artifact();
  const candidate = structuredClone(frozen);
  candidate.metrics.coldBuildMs.p95 = 9;
  candidate.metrics.coldBuildMs.max = 9;

  const result = evaluateFrozenGate(frozen, candidate);

  assert.equal(result.status, 'pass');
  assert.equal(result.fts5AdrRequired, false);
  assert.equal(result.checks.every((check) => check.passed), true);
});

test('fails and triggers the FTS5 ADR when a comparable 100k metric exceeds its gate', () => {
  const frozen = artifact();
  const candidate = structuredClone(frozen);
  candidate.metrics.warmQueryMs.p95 = 3;
  candidate.metrics.warmQueryMs.max = 3;

  const result = evaluateFrozenGate(frozen, candidate);

  assert.equal(result.status, 'fail');
  assert.equal(result.fts5AdrRequired, true);
  assert.deepEqual(result.failedThresholds, ['warmQueryMs']);
});

test('does not trigger the FTS5 ADR for a comparable 10k threshold failure', () => {
  const frozen = artifact({ fileCount: 10_000 });
  const candidate = structuredClone(frozen);
  candidate.metrics.cancellationMs.p95 = 3;
  candidate.metrics.cancellationMs.max = 3;

  const result = evaluateFrozenGate(frozen, candidate);

  assert.equal(result.status, 'fail');
  assert.equal(result.fts5AdrRequired, false);
  assert.deepEqual(result.failedThresholds, ['cancellationMs']);
});

test('refuses comparison when production index identity changes', () => {
  const frozen = artifact();
  const candidate = structuredClone(frozen);
  candidate.index.implementationId = 'alternate-index-v1';

  const result = evaluateFrozenGate(frozen, candidate);

  assert.equal(result.status, 'not-comparable');
  assert.equal(result.fts5AdrRequired, false);
  assert.match(result.comparabilityFailures.join('\n'), /implementationId/);
});

test('refuses comparison when corpus identity or configured limits change', () => {
  const frozen = artifact();
  const candidate = structuredClone(frozen);
  candidate.corpus.digest = `sha256-v1:${'b'.repeat(64)}`;
  candidate.corpus.limits.maxResults = 50;

  const result = evaluateFrozenGate(frozen, candidate);

  assert.equal(result.status, 'not-comparable');
  assert.match(result.comparabilityFailures.join('\n'), /corpus.digest/);
  assert.match(result.comparabilityFailures.join('\n'), /corpus.limits/);
});

test('refuses a memory gate based on the estimated-index fallback', () => {
  const frozen = artifact();
  const candidate = structuredClone(frozen);
  candidate.memory.measurementKind = 'estimatedIndexBytesFallback';

  const result = evaluateFrozenGate(frozen, candidate);

  assert.equal(result.status, 'not-comparable');
  assert.match(result.comparabilityFailures.join('\n'), /memory.measurementKind/);
});

test('rejects incomplete or invalid artifacts before evaluating thresholds', () => {
  const candidate = artifact();
  candidate.status = 'incomplete';
  candidate.incompleteReason = 'SIGINT';

  assert.throws(() => evaluateFrozenGate(artifact(), candidate), /invalid candidate/i);
});

test('CLI writes a failing gate report and exits nonzero', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'mmd-perf-gate-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const frozenPath = path.join(directory, 'frozen.json');
  const candidatePath = path.join(directory, 'candidate.json');
  const reportPath = path.join(directory, 'reports', 'gate.json');
  const candidate = artifact();
  candidate.metrics.coldBuildMs.p95 = 11;
  candidate.metrics.coldBuildMs.max = 11;
  await Promise.all([
    writeFile(frozenPath, JSON.stringify(artifact())),
    writeFile(candidatePath, JSON.stringify(candidate)),
  ]);

  const result = spawnSync(process.execPath, [
    'scripts/perf/evaluate-gates.mjs', frozenPath, candidatePath, reportPath,
  ], { cwd: process.cwd(), encoding: 'utf8' });
  const report = JSON.parse(await readFile(reportPath, 'utf8'));

  assert.equal(result.status, 1);
  assert.equal(report.status, 'fail');
  assert.deepEqual(report.failedThresholds, ['coldBuildMs']);
});
