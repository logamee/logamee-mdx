import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  buildBenchBinaryCommand,
  buildBenchCommand,
  fixtureDocuments,
  runProductionBenchmark,
} from './run-baselines.mjs';

test('runs the cargo mmd_bench production-core caller', () => {
  const command = buildBenchCommand({ requestPath: '/tmp/request.json', outputPath: '/tmp/result.json' });
  assert.equal(command.command, 'cargo');
  assert.deepEqual(command.args, [
    'run', '--release', '--manifest-path', 'src-tauri/Cargo.toml', '--features', 'bench-cli',
    '--bin', 'mmd_bench', '--',
    '--request', '/tmp/request.json', '--output', '/tmp/result.json',
  ]);
});

test('builds the production benchmark binary once for isolated sample processes', () => {
  assert.deepEqual(buildBenchBinaryCommand(), {
    command: 'cargo',
    args: [
      'build', '--release', '--manifest-path', 'src-tauri/Cargo.toml', '--features', 'bench-cli',
      '--bin', 'mmd_bench',
    ],
  });
});

test('fails when the production benchmark process fails', () => {
  assert.throws(() => runProductionBenchmark({
    requestPath: '/tmp/request.json',
    outputPath: '/tmp/result.json',
    execute: () => ({ status: 2, stderr: 'bench failed', stdout: '' }),
  }), /bench failed/);
});

test('loads large fixture manifests in stable order without unbounded file opens', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mmd-perf-loader-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'documents'));
  const files = Array.from({ length: 130 }, (_, index) => ({
    path: `documents/${String(index).padStart(3, '0')}.md`,
  }));
  await Promise.all(files.map((file, index) => (
    writeFile(path.join(root, file.path), `document-${index}`)
  )));

  const documents = await fixtureDocuments(root, { files });

  assert.equal(documents.length, 130);
  assert.deepEqual(documents[0], { relativePath: 'documents/000.md', content: 'document-0' });
  assert.deepEqual(documents[129], { relativePath: 'documents/129.md', content: 'document-129' });
});
