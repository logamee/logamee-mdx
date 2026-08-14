import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { evaluateGateFiles } from './evaluate-gates.mjs';

export const DEFAULT_M3_GATES = Object.freeze([
  {
    name: '10k',
    frozenPath: 'scripts/perf/baselines/10k.json',
    candidatePath: '.perf/results/m3-10k.json',
    reportPath: '.perf/results/m3-10k-gate.json',
  },
  {
    name: '100k',
    frozenPath: 'scripts/perf/baselines/100k.json',
    candidatePath: '.perf/results/m3-100k.json',
    reportPath: '.perf/results/m3-100k-gate.json',
  },
]);

export async function evaluateGateSuite({
  gates = DEFAULT_M3_GATES,
  evaluate = evaluateGateFiles,
} = {}) {
  const results = [];
  for (const gate of gates) {
    const result = await evaluate(gate);
    results.push({ name: gate.name, ...result });
  }
  return {
    schemaVersion: 1,
    status: results.every((result) => result.status === 'pass') ? 'pass' : 'fail',
    fts5AdrRequired: results.some((result) => result.fts5AdrRequired),
    gates: results,
  };
}

async function main() {
  const reportPath = process.argv[2] ?? '.perf/results/m3-gate-summary.json';
  const result = await evaluateGateSuite();
  await mkdir(path.dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(result, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({
    status: result.status,
    fts5AdrRequired: result.fts5AdrRequired,
    gates: result.gates.map(({ name, status, failedThresholds, comparabilityFailures }) => ({
      name,
      status,
      failedThresholds,
      comparabilityFailures,
    })),
    reportPath,
  })}\n`);
  if (result.status !== 'pass') process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
