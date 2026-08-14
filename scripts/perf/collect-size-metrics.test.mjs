import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { collectSizeMetrics } from './collect-size-metrics.mjs';

test('collects exact app, installer, frontend and largest direct dependency sizes', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mmd-size-metrics-'));
  await mkdir(path.join(root, 'app'));
  await mkdir(path.join(root, 'frontend'));
  await mkdir(path.join(root, 'node_modules', 'alpha'), { recursive: true });
  await mkdir(path.join(root, 'node_modules', 'beta'), { recursive: true });
  await writeFile(path.join(root, 'app', 'mmd'), Buffer.alloc(20));
  await writeFile(path.join(root, 'installer.bin'), Buffer.alloc(30));
  await writeFile(path.join(root, 'frontend', 'index.js'), Buffer.alloc(40));
  await writeFile(path.join(root, 'node_modules', 'alpha', 'index.js'), Buffer.alloc(50));
  await writeFile(path.join(root, 'node_modules', 'beta', 'index.js'), Buffer.alloc(10));
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ dependencies: { alpha: '1', beta: '1' } }));

  assert.deepEqual(await collectSizeMetrics({
    appPath: path.join(root, 'app'), frontendPath: path.join(root, 'frontend'),
    installerPath: path.join(root, 'installer.bin'), projectRoot: root,
  }), {
    'size.appBytes': 20,
    'size.frontendBytes': 40,
    'size.installerBytes': 30,
    'size.largestDependencyBytes': 50,
  });
});
