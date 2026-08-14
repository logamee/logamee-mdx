import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { evaluateFrozenGate } from './evaluate-gates.mjs';

function artifact() {
  return {
    schemaVersion: 1,
    status: 'complete',
    environment: { os: 'darwin', arch: 'arm64' },
    app: { name: 'mmd', version: '0.1.0' },
    build: {
      profile: 'release',
      gitCommit: 'a'.repeat(40),
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
      fileCount: 100_000,
      digest: `sha256-v1:${'b'.repeat(64)}`,
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

function sha256(content) {
  return createHash('sha256').update(content).digest('hex');
}

async function writeJson(directory, name, value) {
  const content = `${JSON.stringify(value, null, 2)}\n`;
  await writeFile(path.join(directory, name), content);
  return { path: name, sha256: sha256(content) };
}

async function writeAttestation(directory, failedMetricsByRun, mutateAfterGate = []) {
  const frozen = artifact();
  const baseline = await writeJson(directory, 'baseline.json', frozen);
  const runs = [];

  for (const [index, failedMetrics] of failedMetricsByRun.entries()) {
    const candidate = artifact();
    for (const metric of failedMetrics) {
      candidate.metrics[metric].p95 += 1;
      candidate.metrics[metric].max += 1;
    }
    const gateReport = evaluateFrozenGate(frozen, candidate);
    mutateAfterGate[index]?.(candidate);
    runs.push({
      sequence: index + 1,
      candidate: await writeJson(directory, `run-${index + 1}.json`, candidate),
      gateReport: await writeJson(directory, `run-${index + 1}-gate.json`, gateReport),
    });
  }

  const manifestPath = path.join(directory, 'attestation.json');
  await writeFile(manifestPath, `${JSON.stringify({
    schemaVersion: 1,
    attestation: 'm3-fts5-three-run-series',
    baseline,
    runs,
  }, null, 2)}\n`);
  return manifestPath;
}

function runCli(manifestPath) {
  return spawnSync(process.execPath, [
    'scripts/perf/evaluate-m3-attestation.mjs', manifestPath,
  ], { cwd: process.cwd(), encoding: 'utf8' });
}

test('CLI audits a complete fail/pass/pass series as defer', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'mmd-m3-attestation-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const manifestPath = await writeAttestation(directory, [['coldBuildMs'], [], []]);

  const result = runCli(manifestPath);

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    schemaVersion: 1,
    decision: 'defer',
    gitCommit: 'a'.repeat(40),
    runStatuses: ['fail', 'pass', 'pass'],
    failureCounts: {
      coldBuildMs: 1,
      warmQueryMs: 0,
      peakIncrementalMemoryBytes: 0,
      cancellationMs: 0,
    },
  });
});

test('CLI audits two failures of the same metric as reopen', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'mmd-m3-attestation-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const manifestPath = await writeAttestation(directory, [
    ['coldBuildMs'],
    ['coldBuildMs'],
    [],
  ]);

  const result = runCli(manifestPath);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).decision, 'reopen');
  assert.equal(JSON.parse(result.stdout).failureCounts.coldBuildMs, 2);
});

test('CLI rejects a three-run series with mismatched environment identity', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'mmd-m3-attestation-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const manifestPath = await writeAttestation(directory, [[], [], []], [
    null,
    (candidate) => { candidate.environment.arch = 'x64'; },
  ]);

  const result = runCli(manifestPath);

  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /^M3 attestation invalid: run 2 environment identity mismatch\n$/);
});

test('CLI rejects an incomplete candidate report', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'mmd-m3-attestation-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const manifestPath = await writeAttestation(directory, [[], [], []], [
    (candidate) => {
      candidate.status = 'incomplete';
      candidate.incompleteReason = 'SIGINT';
    },
  ]);

  const result = runCli(manifestPath);

  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /M3 attestation invalid: Invalid candidate artifact: .*baseline is incomplete: SIGINT/);
});

test('CLI rejects a candidate produced from a dirty commit', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'mmd-m3-attestation-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const manifestPath = await writeAttestation(directory, [[], [], []], [
    null,
    null,
    (candidate) => { candidate.build.dirty = true; },
  ]);

  const result = runCli(manifestPath);

  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /^M3 attestation invalid: run 3 must attest a clean git commit\n$/);
});

test('CLI rejects candidates from different clean commits', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'mmd-m3-attestation-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const manifestPath = await writeAttestation(directory, [[], [], []], [
    null,
    (candidate) => { candidate.build.gitCommit = 'c'.repeat(40); },
  ]);

  const result = runCli(manifestPath);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /^M3 attestation invalid: run 2 build\.gitCommit mismatch\n$/);
});

test('CLI rejects evidence bytes that do not match the manifest digest', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'mmd-m3-attestation-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const manifestPath = await writeAttestation(directory, [[], [], []]);
  await writeFile(path.join(directory, 'run-3-gate.json'), '{}\n');

  const result = runCli(manifestPath);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /^M3 attestation invalid: run 3 gate report sha256 mismatch\n$/);
});

test('package and CI expose the durable verifier without running the 100k benchmark', async () => {
  const [packageJson, platformWorkflow, releaseWorkflow] = await Promise.all([
    readFile('package.json', 'utf8').then(JSON.parse),
    readFile('.github/workflows/platform-ci.yml', 'utf8'),
    readFile('.github/workflows/release.yml', 'utf8'),
  ]);

  assert.equal(
    packageJson.scripts['verify:m3-attestation'],
    'node scripts/perf/evaluate-m3-attestation.mjs docs/evidence/m3/fts5-defer-attestation/attestation.json',
  );
  for (const workflow of [platformWorkflow, releaseWorkflow]) {
    assert.match(workflow, /npm run verify:m3-attestation/);
    assert.doesNotMatch(workflow, /npm run perf:(?:candidate|baseline|gate):100k/);
  }
});
