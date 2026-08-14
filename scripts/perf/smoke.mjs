import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { validateBaseline } from './baseline-schema.mjs';
import { generateFixture } from './generate-fixtures.mjs';
import { runFixtureBaseline } from './run-baselines.mjs';

const root = await mkdtemp(path.join(os.tmpdir(), 'mmd-perf-smoke-'));
try {
  const fixtureDirectory = path.join(root, 'fixture');
  const outputPath = path.join(root, 'baseline.json');
  await generateFixture({ outputDirectory: fixtureDirectory, fileCount: 100, seed: 7417 });
  const baseline = await runFixtureBaseline({
    fixtureDirectory,
    requestPath: path.join(root, 'request.json'),
    outputPath,
    warmupCount: 1,
    sampleCount: 2,
  });
  const errors = validateBaseline(baseline);
  if (errors.length) throw new Error(errors.join('; '));
  process.stdout.write(`${JSON.stringify({
    status: baseline.status,
    implementationId: baseline.index.implementationId,
    schemaId: baseline.index.schemaId,
    samples: baseline.measurement.sampleCount,
    errors: baseline.measurement.errorCount,
  })}\n`);
} finally {
  await rm(root, { recursive: true, force: true });
}
