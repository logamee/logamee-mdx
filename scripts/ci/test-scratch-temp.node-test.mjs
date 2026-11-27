import assert from 'node:assert/strict';
import { existsSync, rmSync } from 'node:fs';
import os from 'node:os';
import test from 'node:test';

import { TEMP_ENVIRONMENT_VARIABLES, removeScratchTemp, usePrivateScratchTemp } from './test-scratch-temp.mjs';

test('usePrivateScratchTemp points every temp lookup at a private directory', (t) => {
  const previous = TEMP_ENVIRONMENT_VARIABLES.map((name) => [name, process.env[name]]);
  const scratchTemp = usePrivateScratchTemp('mmd-scratch-contract-');
  t.after(() => {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmSync(scratchTemp, { recursive: true, force: true });
  });

  assert.equal(os.tmpdir(), scratchTemp);
  assert.ok(existsSync(scratchTemp));
});

test('removeScratchTemp retries the way Windows short-lived file locks need', () => {
  let attempted = null;

  removeScratchTemp('/private/scratch', (target, options) => { attempted = { target, options }; });

  assert.deepEqual(attempted, {
    target: '/private/scratch',
    options: { recursive: true, force: true, maxRetries: 10, retryDelay: 100 },
  });
});

test('removeScratchTemp warns instead of failing the test run when the directory is locked', async () => {
  const warnings = [];
  const onWarning = (warning) => warnings.push(warning.message);
  process.on('warning', onWarning);
  try {
    removeScratchTemp('/private/scratch', () => {
      throw Object.assign(new Error('resource busy'), { code: 'EBUSY' });
    });
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    process.off('warning', onWarning);
  }

  assert.deepEqual(warnings, ['private scratch directory was left behind: /private/scratch']);
});
