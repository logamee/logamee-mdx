// Tests for the staged-diff size evaluator.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  evaluateCommitSize,
  parseStagedNumstat,
} from './check-commit-size.mjs';

test('parseStagedNumstat sums staged lines and excludes generated paths', () => {
  const numstat = [
    '120\t10\tsrc/App.tsx',
    '50\t5\tsrc-tauri/src/commands.rs',
    '9000\t12\tpackage-lock.json',
    '500\t0\tdist/index.js',
    '-\t-\tassets/logo.png',
  ].join('\n');
  const { files, excluded, totalLines } = parseStagedNumstat(numstat);
  assert.equal(totalLines, 185);
  assert.deepEqual(
    files.map((entry) => entry.file),
    ['src/App.tsx', 'src-tauri/src/commands.rs'],
  );
  assert.equal(files[0].lines, 130);
  assert.deepEqual(excluded, ['package-lock.json', 'dist/index.js']);
});

test('parseStagedNumstat skips empty input and non-numstat lines', () => {
  const { files, totalLines } = parseStagedNumstat('');
  assert.deepEqual(files, []);
  assert.equal(totalLines, 0);
});

test('evaluateCommitSize maps line totals to ok/warn/fail', () => {
  assert.equal(evaluateCommitSize(0).status, 'ok');
  assert.equal(evaluateCommitSize(400).status, 'ok');
  assert.equal(evaluateCommitSize(401).status, 'warn');
  assert.equal(evaluateCommitSize(800).status, 'warn');
  assert.equal(evaluateCommitSize(801).status, 'fail');
});
