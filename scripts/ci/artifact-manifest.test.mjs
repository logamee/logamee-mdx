import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('./artifact-manifest.mjs', import.meta.url));

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'mmd-artifact-manifest-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(path.join(directory, 'mdx.test'), 'verified-payload');
  return directory;
}

function run(...args) {
  return spawnSync(process.execPath, [script, ...args], {
    encoding: 'utf8',
    env: { ...process.env, GITHUB_JOB: 'test', GITHUB_RUN_ID: '123' },
  });
}

test('creates and verifies a strict manifest', async (t) => {
  const directory = await fixture(t);

  assert.equal(run('create', directory, 'mdx.test').status, 0);
  assert.equal(run('verify', directory).status, 0);

  const manifest = JSON.parse(
    await readFile(path.join(directory, 'artifact-manifest.json'), 'utf8'),
  );
  assert.equal(manifest.runId, '123');
  assert.equal(manifest.job, 'test');
  assert.deepEqual(manifest.files.map((file) => file.name), ['mdx.test']);
});

test('rejects a payload changed after manifest creation', async (t) => {
  const directory = await fixture(t);
  assert.equal(run('create', directory, 'mdx.test').status, 0);
  await writeFile(path.join(directory, 'mdx.test'), 'changed-payload');

  const result = run('verify', directory);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /artifact integrity mismatch/);
});

test('rejects an unexpected artifact file', async (t) => {
  const directory = await fixture(t);
  assert.equal(run('create', directory, 'mdx.test').status, 0);
  await writeFile(path.join(directory, 'unexpected.txt'), 'unexpected');

  const result = run('verify', directory);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /artifact file set mismatch/);
});

test('rejects duplicate and non-basename payload declarations', async (t) => {
  const directory = await fixture(t);

  const duplicate = run('create', directory, 'mdx.test', 'mdx.test');
  const traversal = run('create', directory, '../mdx.test');

  assert.notEqual(duplicate.status, 0);
  assert.match(duplicate.stderr, /payload names must be unique/);
  assert.notEqual(traversal.status, 0);
  assert.match(traversal.stderr, /payload must be a basename/);
});
