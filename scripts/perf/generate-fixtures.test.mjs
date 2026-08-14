import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { generateFixture } from './generate-fixtures.mjs';

test('the same fixture seed produces byte-equivalent manifests and files', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mmd-perf-fixtures-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  const first = await generateFixture({ outputDirectory: path.join(root, 'first'), fileCount: 12, seed: 7417 });
  const second = await generateFixture({ outputDirectory: path.join(root, 'second'), fileCount: 12, seed: 7417 });

  assert.equal(JSON.stringify(first), JSON.stringify(second));
  assert.equal(first.corpusDigest, second.corpusDigest);
  for (const file of first.files) {
    assert.equal(
      await readFile(path.join(root, 'first', file.path), 'utf8'),
      await readFile(path.join(root, 'second', file.path), 'utf8'),
    );
  }
});

test('a changed seed changes corpus identity', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mmd-perf-seed-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  const first = await generateFixture({ outputDirectory: path.join(root, 'first'), fileCount: 4, seed: 1 });
  const second = await generateFixture({ outputDirectory: path.join(root, 'second'), fileCount: 4, seed: 2 });

  assert.notEqual(first.corpusDigest, second.corpusDigest);
});
