import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { validateBaseline } from './baseline-schema.mjs';

const THRESHOLD_METRICS = [
  'coldBuildMs',
  'warmQueryMs',
  'peakIncrementalMemoryBytes',
  'cancellationMs',
];

const COMPARABILITY_FIELDS = [
  'environment.os',
  'environment.arch',
  'app.name',
  'build.profile',
  'build.runner',
  'index.implementationId',
  'index.schemaId',
  'corpus.fixtureVersion',
  'corpus.fixtureDigest',
  'corpus.seed',
  'corpus.fileCount',
  'corpus.digest',
  'corpus.indexedMarkdownBytes',
  'corpus.limits',
  'measurement.wallClock',
  'measurement.timingUnit',
  'measurement.warmupCount',
  'measurement.sampleCount',
  'measurement.processCount',
].map((field) => field.split('.'));

function valueAt(object, pathSegments) {
  return pathSegments.reduce((value, segment) => value?.[segment], object);
}

function stableValue(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
}

function equal(left, right) {
  return JSON.stringify(stableValue(left)) === JSON.stringify(stableValue(right));
}

function assertValid(label, artifact) {
  const errors = validateBaseline(artifact);
  if (errors.length > 0) {
    throw new Error(`Invalid ${label} artifact: ${errors.join('; ')}`);
  }
}

export function evaluateFrozenGate(frozen, candidate) {
  assertValid('frozen gate', frozen);
  assertValid('candidate', candidate);

  const checks = COMPARABILITY_FIELDS.map((pathSegments) => {
    const name = pathSegments.join('.');
    const expected = valueAt(frozen, pathSegments);
    const actual = valueAt(candidate, pathSegments);
    return {
      kind: 'identity',
      name,
      expected,
      actual,
      passed: equal(expected, actual),
    };
  });
  checks.push({
    kind: 'identity',
    name: 'memory.measurementKind',
    expected: 'independentProcessPeakRssDelta',
    actual: candidate.memory.measurementKind,
    passed: frozen.memory.measurementKind === 'independentProcessPeakRssDelta'
      && candidate.memory.measurementKind === 'independentProcessPeakRssDelta',
  });

  const comparabilityFailures = checks
    .filter((check) => !check.passed)
    .map((check) => `${check.name}: expected ${JSON.stringify(check.expected)}, got ${JSON.stringify(check.actual)}`);
  const comparable = comparabilityFailures.length === 0;

  const thresholdChecks = THRESHOLD_METRICS.map((metric) => ({
    kind: 'threshold',
    name: metric,
    expected: frozen.metrics[metric].p95,
    actual: candidate.metrics[metric].p95,
    operator: '<=',
    passed: comparable && candidate.metrics[metric].p95 <= frozen.metrics[metric].p95,
    skipped: !comparable,
  }));
  checks.push(...thresholdChecks);

  const failedThresholds = comparable
    ? thresholdChecks.filter((check) => !check.passed).map((check) => check.name)
    : [];
  const status = !comparable ? 'not-comparable' : failedThresholds.length > 0 ? 'fail' : 'pass';

  return {
    schemaVersion: 1,
    status,
    corpusFileCount: frozen.corpus.fileCount,
    comparable,
    fts5AdrRequired: comparable
      && frozen.corpus.fileCount === 100_000
      && failedThresholds.length > 0,
    failedThresholds,
    comparabilityFailures,
    checks,
  };
}

export async function evaluateGateFiles({ frozenPath, candidatePath, reportPath = null }) {
  const [frozen, candidate] = await Promise.all([
    readFile(frozenPath, 'utf8').then(JSON.parse),
    readFile(candidatePath, 'utf8').then(JSON.parse),
  ]);
  const result = evaluateFrozenGate(frozen, candidate);
  const report = {
    ...result,
    frozenArtifact: path.normalize(frozenPath),
    candidateArtifact: path.normalize(candidatePath),
  };
  if (reportPath) {
    await mkdir(path.dirname(reportPath), { recursive: true });
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  }
  return report;
}

async function main() {
  const [frozenPath, candidatePath, reportPath] = process.argv.slice(2);
  if (!frozenPath || !candidatePath) {
    throw new Error('Usage: evaluate-gates.mjs <frozen.json> <candidate.json> [report.json]');
  }
  const report = await evaluateGateFiles({ frozenPath, candidatePath, reportPath });
  process.stdout.write(`${JSON.stringify({
    status: report.status,
    corpusFileCount: report.corpusFileCount,
    failedThresholds: report.failedThresholds,
    comparabilityFailures: report.comparabilityFailures,
    fts5AdrRequired: report.fts5AdrRequired,
    reportPath: reportPath ?? null,
  })}\n`);
  if (report.status !== 'pass') process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
