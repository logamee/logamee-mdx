// Tests for the hotspot report parser and ranking.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
  computeHotspots,
  formatHotspotTable,
  normalizeRenamedPath,
  parseGitLogNumstat,
} from './hotspots.mjs';

test('normalizeRenamedPath expands git rename braces', () => {
  assert.equal(normalizeRenamedPath('src/{old => new}/a.ts'), 'src/new/a.ts');
  assert.equal(normalizeRenamedPath('src/{a.ts => b.ts}'), 'src/b.ts');
});

test('parseGitLogNumstat counts commits, churn, renames and binaries', () => {
  const log = [
    'aaa',
    '10\t2\tsrc/a.ts',
    '-\t-\tsrc/logo.png',
    'bbb',
    '3\t1\tsrc/{a.ts => moved.ts}',
    'ccc',
    '1\t1\tsrc/a.ts',
    'not a numstat line',
    '',
  ].join('\n');
  const stats = parseGitLogNumstat(log);
  assert.equal(stats.get('src/a.ts').commits, 2);
  assert.equal(stats.get('src/a.ts').churn, 14);
  assert.equal(stats.get('src/moved.ts').commits, 1);
  assert.equal(stats.get('src/moved.ts').churn, 4);
  assert.equal(stats.get('src/logo.png').commits, 1);
  assert.equal(stats.get('src/logo.png').churn, 0);
});

test('computeHotspots ranks by commits weighted by current size', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hotspots-'));
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'big.ts'), 'a\n'.repeat(200));
  fs.writeFileSync(path.join(root, 'src', 'small.ts'), 'a\n'.repeat(10));
  const rows = computeHotspots({
    root,
    topN: 5,
    stats: new Map([
      ['src/big.ts', { commits: 5, churn: 400 }],
      ['src/small.ts', { commits: 50, churn: 100 }],
      ['src/gone.ts', { commits: 30, churn: 900 }],
      ['src/notes.md', { commits: 99, churn: 999 }],
    ]),
  });
  assert.deepEqual(
    rows.map((row) => row.file),
    ['src/big.ts', 'src/small.ts'],
  );
  // 'a\n'.repeat(200) splits into 201 segments; line counts follow that
  // split-based convention everywhere in these scripts.
  assert.equal(rows[0].score, 5 * 201);
  const table = formatHotspotTable(rows);
  assert.match(table, /commits\s+lines\s+score\s+file/);
  assert.match(table, /src\/big\.ts/);
});
