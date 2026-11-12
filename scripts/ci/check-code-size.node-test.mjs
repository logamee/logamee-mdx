// Tests for the code-size ratchet gate. Fixtures live in a temp root so the
// real repository baseline is never touched.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
  defaultQualityConfigPath,
  findRustFileViolations,
  loadBaseline,
  parseOxlintJson,
  runCheck,
} from './check-code-size.mjs';

function makeFixtureRoot() {
  const tempDir = os.tmpdir();
  const repoRoot = path.dirname(defaultQualityConfigPath());
  const relativeTemp = path.relative(repoRoot, tempDir);
  const insideRepo = !relativeTemp.startsWith('..') && !path.isAbsolute(relativeTemp);
  const fixtureTemp = process.platform === 'win32' && insideRepo && process.env.LOCALAPPDATA
    ? path.join(process.env.LOCALAPPDATA, 'Temp')
    : tempDir;
  const root = fs.mkdtempSync(path.join(fixtureTemp, 'code-size-'));
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.mkdirSync(path.join(root, 'src-tauri', 'src'), { recursive: true });
  return root;
}

function checkFixture(root, options = {}) {
  return runCheck({ root, ...options });
}

function longFunctionSource(lines = 90) {
  const body = Array.from({ length: lines }, (_, i) => `  x += ${i};`).join('\n');
  return `export function longFn(x: number): number {\n${body}\n  return x;\n}\n`;
}

function complexFunctionSource(branches = 12) {
  const body = Array.from(
    { length: branches },
    (_, i) => `  if (x === ${i}) { x += 1; }`,
  ).join('\n');
  return `export function complexFn(x: number): number {\n${body}\n  return x;\n}\n`;
}

function manyLinesSource(lines = 501) {
  return `${Array.from({ length: lines }, (_, i) => `export const v${i} = ${i};`).join('\n')}\n`;
}

function rustSource(lines) {
  return `${Array.from({ length: lines }, (_, i) => `// line ${i}`).join('\n')}\n`;
}

test('parseOxlintJson keeps only quality rules and builds stable keys', () => {
  const stdout = JSON.stringify({
    diagnostics: [
      {
        code: 'eslint(no-console)',
        message: 'unexpected console',
        filename: '/tmp/repo/src/a.ts',
        labels: [{ span: { line: 3 } }],
      },
      {
        code: 'eslint(max-lines-per-function)',
        message: 'The function `f` has too many lines (64).',
        filename: '/tmp/repo/src/a.ts',
        labels: [{ span: { line: 7 } }],
      },
    ],
  });
  const violations = parseOxlintJson(stdout, '/tmp/repo');
  assert.equal(violations.size, 1);
  const [key, display] = [...violations.entries()][0];
  assert.match(key, /^eslint\(max-lines-per-function\)\|src\/a\.ts\|/);
  assert.ok(key.includes('`f`'), 'keys keep the function name');
  assert.ok(!key.includes('64'), 'keys strip numbers');
  assert.match(display, /src\/a\.ts:7 max-lines-per-function/);
});

test('findRustFileViolations flags only Rust files above the limit', () => {
  const root = makeFixtureRoot();
  fs.writeFileSync(path.join(root, 'src-tauri', 'src', 'big.rs'), rustSource(501));
  fs.writeFileSync(path.join(root, 'src-tauri', 'src', 'ok.rs'), rustSource(499));
  const violations = findRustFileViolations(root);
  assert.deepEqual([...violations.keys()], ['rs-max-lines|src-tauri/src/big.rs']);
});

test('runCheck ratchets: unknown violations fail, pinned ones pass', async () => {
  const root = makeFixtureRoot();
  fs.writeFileSync(path.join(root, 'src', 'long.ts'), longFunctionSource());
  fs.writeFileSync(path.join(root, 'src', 'complex.ts'), complexFunctionSource());
  fs.writeFileSync(path.join(root, 'src', 'too-big.ts'), manyLinesSource());
  fs.writeFileSync(
    path.join(root, 'src', 'ignored.test.ts'),
    longFunctionSource(),
  );
  fs.writeFileSync(path.join(root, 'src-tauri', 'src', 'big.rs'), rustSource(501));

  const first = await checkFixture(root);
  assert.equal(first.ok, false);
  assert.equal(first.newKeys.length, 4);
  assert.ok(first.newKeys.every((key) => !key.includes('ignored.test.ts')));

  await checkFixture(root, { updateBaseline: true });
  assert.equal(loadBaseline(root).keys.length, 4);
  const second = await checkFixture(root);
  assert.equal(second.ok, true);
  assert.deepEqual(second.removedKeys, []);

  fs.writeFileSync(path.join(root, 'src', 'extra.ts'), longFunctionSource(85));
  const third = await checkFixture(root);
  assert.equal(third.ok, false);
  assert.equal(third.newKeys.length, 1);
  assert.ok(third.newKeys[0].includes('src/extra.ts'));

  await checkFixture(root, { updateBaseline: true });
  fs.unlinkSync(path.join(root, 'src', 'long.ts'));
  const fourth = await checkFixture(root);
  assert.equal(fourth.ok, true);
  assert.equal(fourth.removedKeys.length, 1);
  assert.ok(fourth.removedKeys[0].includes('src/long.ts'));
});

test('ratchet works when Windows TEMP is inside the ignored workspace', {
  skip: process.platform !== 'win32' || !process.env.LOCALAPPDATA,
}, async (t) => {
  const previousTemp = process.env.TEMP;
  const previousTmp = process.env.TMP;
  const tempDir = path.join(path.dirname(defaultQualityConfigPath()), '.perf');
  fs.mkdirSync(tempDir, { recursive: true });
  let root;
  try {
    process.env.TEMP = tempDir;
    process.env.TMP = tempDir;
    root = makeFixtureRoot();
  } finally {
    if (previousTemp === undefined) delete process.env.TEMP;
    else process.env.TEMP = previousTemp;
    if (previousTmp === undefined) delete process.env.TMP;
    else process.env.TMP = previousTmp;
  }
  t.after(() => {
    assert.equal(path.dirname(root), path.join(process.env.LOCALAPPDATA, 'Temp'));
    fs.rmSync(root, { recursive: true, force: true });
  });
  fs.writeFileSync(path.join(root, 'src', 'long.ts'), longFunctionSource());
  const result = await checkFixture(root);
  assert.equal(result.ok, false);
  assert.equal(result.newKeys.length, 1);
  assert.ok(result.newKeys[0].includes('src/long.ts'));
});

test('pinned violations survive line shifts in the same function', async () => {
  const root = makeFixtureRoot();
  fs.writeFileSync(path.join(root, 'src', 'long.ts'), longFunctionSource());
  await checkFixture(root, { updateBaseline: true });
  assert.equal((await checkFixture(root)).ok, true);

  // Inserting lines above the pinned function moves its span but keeps the
  // same normalized key; that must not register as a new violation.
  const shifted = `export const banner = 'shifted';\n\n${longFunctionSource(95)}`;
  fs.writeFileSync(path.join(root, 'src', 'long.ts'), shifted);
  const after = await checkFixture(root);
  assert.equal(after.ok, true);
  assert.deepEqual(after.newKeys, []);
});
