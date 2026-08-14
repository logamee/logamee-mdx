import { spawnSync } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { summarizeSamples, validateBaseline } from './baseline-schema.mjs';

export const DEFAULT_INDEX_LIMITS = Object.freeze({
  maxFiles: 100_000,
  maxFileBytes: 1_048_576,
  maxAggregateBytes: 268_435_456,
  maxResults: 100,
  maxQueryChars: 256,
  maxSnippetChars: 240,
});

export function buildBenchCommand({ requestPath, outputPath }) {
  return {
    command: 'cargo',
    args: [
      'run', '--release', '--manifest-path', 'src-tauri/Cargo.toml', '--features', 'bench-cli',
      '--bin', 'mmd_bench', '--',
      '--request', requestPath, '--output', outputPath,
    ],
  };
}

export function buildBenchBinaryCommand() {
  return {
    command: 'cargo',
    args: [
      'build', '--release', '--manifest-path', 'src-tauri/Cargo.toml', '--features', 'bench-cli',
      '--bin', 'mmd_bench',
    ],
  };
}

export function prepareBenchmarkBinary({ execute = spawnSync } = {}) {
  const { command, args } = buildBenchBinaryCommand();
  const result = execute(command, args, { encoding: 'utf8', stdio: 'pipe' });
  if (result.status !== 0) {
    throw new Error(result.stderr?.trim() || result.stdout?.trim() || `mmd_bench build exited ${result.status}`);
  }
  return path.resolve(
    'src-tauri',
    'target',
    'release',
    process.platform === 'win32' ? 'mmd_bench.exe' : 'mmd_bench',
  );
}

export function runProductionBenchmark({
  requestPath,
  outputPath,
  benchExecutable = null,
  execute = spawnSync,
}) {
  const { command, args } = benchExecutable
    ? { command: benchExecutable, args: ['--request', requestPath, '--output', outputPath] }
    : buildBenchCommand({ requestPath, outputPath });
  const result = execute(command, args, { encoding: 'utf8', stdio: 'pipe' });
  if (result.status !== 0) {
    throw new Error(result.stderr?.trim() || result.stdout?.trim() || `mmd_bench exited ${result.status}`);
  }
  return result;
}

export async function fixtureDocuments(fixtureDirectory, manifest) {
  const documents = [];
  const batchSize = 64;
  for (let offset = 0; offset < manifest.files.length; offset += batchSize) {
    const batch = manifest.files.slice(offset, offset + batchSize);
    documents.push(...await Promise.all(batch.map(async (file) => ({
      relativePath: file.path,
      content: await readFile(path.join(fixtureDirectory, file.path), 'utf8'),
    }))));
  }
  return documents;
}

function microsDistribution(samples) {
  return summarizeSamples(samples.map((sample) => sample / 1000));
}

function gitBuildMetadata() {
  const revision = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' });
  const status = spawnSync('git', ['status', '--porcelain'], { encoding: 'utf8' });
  return {
    profile: 'release',
    gitCommit: revision.status === 0 ? revision.stdout.trim() : 'unknown',
    dirty: status.status !== 0 || status.stdout.trim() !== '',
    runner: 'cargo mmd_bench',
  };
}

async function readAppMetadata() {
  const packageJson = JSON.parse(await readFile('package.json', 'utf8'));
  return { name: packageJson.name, version: packageJson.version };
}

async function invokeBenchmark(request, requestPath, outputPath, benchExecutable) {
  await writeFile(requestPath, `${JSON.stringify(request)}\n`);
  try {
    runProductionBenchmark({ requestPath, outputPath, benchExecutable });
    return JSON.parse(await readFile(outputPath, 'utf8'));
  } finally {
    await Promise.all([
      rm(requestPath, { force: true }),
      rm(outputPath, { force: true }),
    ]);
  }
}

export async function runFixtureBaseline({
  fixtureDirectory,
  requestPath,
  outputPath,
  warmupCount = 2,
  sampleCount = 5,
}) {
  await Promise.all([
    mkdir(path.dirname(requestPath), { recursive: true }),
    mkdir(path.dirname(outputPath), { recursive: true }),
  ]);
  const manifest = JSON.parse(await readFile(path.join(fixtureDirectory, 'manifest.json'), 'utf8'));
  const documents = await fixtureDocuments(fixtureDirectory, manifest);
  const benchExecutable = prepareBenchmarkBinary();
  const request = {
    documents,
    limits: DEFAULT_INDEX_LIMITS,
    queries: [
      { kind: 'filename', text: 'document 000042' },
      { kind: 'fullText', text: 'deterministic markdown' },
    ],
    cancelBeforeBuild: false,
    cancelBeforeQuery: false,
    warmupCount,
    sampleCount: 1,
  };
  const cancellationRequest = {
    ...request,
    queries: [{ kind: 'fullText', text: 'deterministic markdown' }],
    cancelQueryAfterChecks: Math.max(1, Math.floor(manifest.fileCount / 2)),
  };
  const responses = [];
  const cancellations = [];
  for (let sample = 0; sample < sampleCount; sample += 1) {
    responses.push(await invokeBenchmark(
      request,
      `${requestPath}.${sample}.json`,
      `${requestPath}.${sample}.raw.json`,
      benchExecutable,
    ));
    cancellations.push(await invokeBenchmark(
      cancellationRequest,
      `${requestPath}.${sample}.cancel.json`,
      `${requestPath}.${sample}.cancel.raw.json`,
      benchExecutable,
    ));
  }
  const response = responses.at(-1);
  const report = response.buildReport;
  const buildMicros = responses.flatMap((entry) => entry.timing.buildMicros);
  const queryMicros = responses.flatMap((entry) => entry.timing.queryMicros.at(-1));
  const cancellationMicros = cancellations.flatMap((entry) => entry.timing.cancellationMicros);
  const peakIncrementalBytesSamples = responses.map((entry) => (
    entry.memory.peakIncrementalBytes ?? entry.memory.estimatedIndexBytes
  ));
  const rssAvailable = responses.every((entry) => (
    entry.memory.measurementKind === 'processPeakRssDelta'
      && entry.memory.peakIncrementalBytes !== null
  ));
  const errors = [];
  if (responses.some((entry) => entry.status !== 'completed')) {
    errors.push('one or more benchmark samples did not complete');
  }
  if (cancellationMicros.length !== sampleCount) {
    errors.push('cancellation did not produce one measured sample per iteration');
  }
  const baseline = {
    schemaVersion: 1,
    status: errors.length === 0 ? 'complete' : 'incomplete',
    environment: { os: os.platform(), arch: os.arch() },
    app: await readAppMetadata(),
    build: gitBuildMetadata(),
    index: {
      implementationId: response.implementationId,
      schemaId: response.schemaId,
    },
    corpus: {
      fixtureVersion: manifest.fixtureVersion,
      fixtureDigest: manifest.corpusDigest,
      seed: manifest.seed,
      fileCount: manifest.fileCount,
      digest: response.corpusDigest,
      indexedMarkdownBytes: report.indexedBytes,
      limits: response.limits,
    },
    measurement: {
      wallClock: response.timing.clock,
      timingUnit: 'milliseconds',
      warmupCount,
      sampleCount,
      processCount: sampleCount * 2,
      errorCount: responses.reduce((sum, entry) => sum + entry.timing.errorCount, 0)
        + cancellations.reduce((sum, entry) => sum + entry.timing.errorCount, 0),
    },
    memory: {
      measurementKind: rssAvailable
        ? 'independentProcessPeakRssDelta'
        : 'estimatedIndexBytesFallback',
      peakIncrementalBytesSamples,
      estimatedIndexBytes: response.memory.estimatedIndexBytes,
    },
    metrics: {
      coldBuildMs: microsDistribution(buildMicros),
      warmQueryMs: microsDistribution(queryMicros),
      peakIncrementalMemoryBytes: summarizeSamples(peakIncrementalBytesSamples),
      cancellationMs: microsDistribution(cancellationMicros),
    },
    errors,
    incompleteReason: errors.length === 0 ? null : errors.join('; '),
    rebaseline: null,
  };
  const validationErrors = validateBaseline(baseline);
  if (validationErrors.length) {
    throw new Error(`Invalid benchmark output: ${validationErrors.join('; ')}`);
  }
  await writeFile(outputPath, `${JSON.stringify(baseline, null, 2)}\n`);
  return baseline;
}

async function main() {
  const fixtureDirectory = process.argv[2];
  const outputPath = process.argv[3];
  if (!fixtureDirectory || !outputPath) {
    throw new Error('Usage: run-baselines.mjs <fixture-directory> <output.json>');
  }
  const requestPath = path.join(
    os.tmpdir(),
    `mmd-bench-${process.pid}-${path.basename(outputPath)}.request.json`,
  );
  await runFixtureBaseline({ fixtureDirectory, requestPath, outputPath });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
