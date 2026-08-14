import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { evaluateFrozenGate } from './evaluate-gates.mjs';

const METRICS = [
  'coldBuildMs',
  'warmQueryMs',
  'peakIncrementalMemoryBytes',
  'cancellationMs',
];

function stableValue(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
}

function equal(left, right) {
  return JSON.stringify(stableValue(left)) === JSON.stringify(stableValue(right));
}

function requireCondition(condition, message) {
  if (!condition) throw new Error(message);
}

async function readVerifiedJson(manifestDirectory, descriptor, label) {
  requireCondition(descriptor && typeof descriptor === 'object', `missing ${label} descriptor`);
  requireCondition(typeof descriptor.path === 'string' && descriptor.path.length > 0, `missing ${label} path`);
  requireCondition(/^[0-9a-f]{64}$/.test(descriptor.sha256), `invalid ${label} sha256`);
  const artifactPath = path.resolve(manifestDirectory, descriptor.path);
  const content = await readFile(artifactPath);
  const actualDigest = createHash('sha256').update(content).digest('hex');
  requireCondition(actualDigest === descriptor.sha256, `${label} sha256 mismatch`);
  try {
    return JSON.parse(content.toString('utf8'));
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error.message}`);
  }
}

function assertSameSeriesIdentity(first, candidate, runNumber) {
  for (const field of ['environment', 'corpus', 'index']) {
    requireCondition(equal(first[field], candidate[field]), `run ${runNumber} ${field} identity mismatch`);
  }
  requireCondition(first.build.profile === candidate.build.profile, `run ${runNumber} build.profile mismatch`);
  requireCondition(first.build.runner === candidate.build.runner, `run ${runNumber} build.runner mismatch`);
  requireCondition(first.build.gitCommit === candidate.build.gitCommit, `run ${runNumber} build.gitCommit mismatch`);
}

function assertGateReportMatches(actual, expected, runNumber) {
  const fields = [
    'schemaVersion',
    'status',
    'corpusFileCount',
    'comparable',
    'fts5AdrRequired',
    'failedThresholds',
    'comparabilityFailures',
    'checks',
  ];
  for (const field of fields) {
    requireCondition(equal(actual?.[field], expected[field]), `run ${runNumber} gate report ${field} mismatch`);
  }
}

export async function evaluateM3Attestation(manifestPath) {
  const manifestContent = await readFile(manifestPath, 'utf8');
  const manifest = JSON.parse(manifestContent);
  requireCondition(manifest.schemaVersion === 1, 'unsupported attestation schemaVersion');
  requireCondition(manifest.attestation === 'm3-fts5-three-run-series', 'unexpected attestation identity');
  requireCondition(Array.isArray(manifest.runs) && manifest.runs.length === 3, 'attestation requires exactly three runs');

  const manifestDirectory = path.dirname(path.resolve(manifestPath));
  const frozen = await readVerifiedJson(manifestDirectory, manifest.baseline, 'baseline');
  const candidates = [];
  const reports = [];

  for (const [index, run] of manifest.runs.entries()) {
    const runNumber = index + 1;
    requireCondition(run.sequence === runNumber, `run ${runNumber} sequence mismatch`);
    candidates.push(await readVerifiedJson(manifestDirectory, run.candidate, `run ${runNumber} candidate`));
    reports.push(await readVerifiedJson(manifestDirectory, run.gateReport, `run ${runNumber} gate report`));
  }

  const first = candidates[0];
  requireCondition(/^[0-9a-f]{40}$/.test(first.build?.gitCommit ?? ''), 'run 1 build.gitCommit must be a full lowercase SHA-1');
  for (const [index, candidate] of candidates.entries()) {
    const runNumber = index + 1;
    requireCondition(candidate.build?.dirty === false, `run ${runNumber} must attest a clean git commit`);
    assertSameSeriesIdentity(first, candidate, runNumber);
    const expectedReport = evaluateFrozenGate(frozen, candidate);
    requireCondition(expectedReport.comparable, `run ${runNumber} is not comparable to the frozen baseline`);
    assertGateReportMatches(reports[index], expectedReport, runNumber);
  }

  const failureCounts = Object.fromEntries(METRICS.map((metric) => [
    metric,
    reports.filter((report) => report.failedThresholds.includes(metric)).length,
  ]));
  return {
    schemaVersion: 1,
    decision: Object.values(failureCounts).some((count) => count >= 2) ? 'reopen' : 'defer',
    gitCommit: first.build.gitCommit,
    runStatuses: reports.map((report) => report.status),
    failureCounts,
  };
}

async function main() {
  const [manifestPath] = process.argv.slice(2);
  if (!manifestPath) throw new Error('Usage: evaluate-m3-attestation.mjs <attestation.json>');
  const result = await evaluateM3Attestation(manifestPath);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(`M3 attestation invalid: ${error.message}\n`);
    process.exitCode = 1;
  }
}
