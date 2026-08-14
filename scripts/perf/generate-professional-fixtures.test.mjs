import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { generateProfessionalFixtures } from './generate-professional-fixtures.mjs';

test('generates deterministic document and canvas benchmark scenarios', async () => {
  const first = await mkdtemp(path.join(os.tmpdir(), 'mmd-professional-fixtures-'));
  const second = await mkdtemp(path.join(os.tmpdir(), 'mmd-professional-fixtures-'));
  const firstManifest = await generateProfessionalFixtures(first);
  const secondManifest = await generateProfessionalFixtures(second);
  assert.deepEqual(firstManifest.files, secondManifest.files);
  assert.ok((await stat(path.join(first, 'markdown-1mb.md'))).size >= 1024 * 1024);
  assert.ok((await stat(path.join(first, 'markdown-5mb.md'))).size >= 5 * 1024 * 1024);
  assert.match(await readFile(path.join(first, 'markdown-1mb.md'), 'utf8'), /^# mdx deterministic benchmark/m);
  const heavy = await readFile(path.join(first, 'markdown-content-heavy.md'), 'utf8');
  assert.match(heavy, /```typescript/);
  assert.match(heavy, /```mermaid/);
  assert.match(heavy, /\\sum/);
  for (const count of [100, 500, 1000]) {
    const scene = JSON.parse(await readFile(path.join(first, `excalidraw-${count}.excalidraw`), 'utf8'));
    assert.equal(scene.elements.length, count);
    assert.equal(new Set(scene.elements.map((element) => element.id)).size, count);
  }
});
