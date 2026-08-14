import { describe, expect, it } from 'vitest';
import { escapeGfmTableCellPipes, splitGfmTableRow } from './gfmTables';

describe('markdown GFM table helpers', () => {
  it('splits rows without treating inline-code pipes as cell separators', () => {
    expect(splitGfmTableRow('| Tool | `a | b` | ok |')).toEqual(['Tool', '`a | b`', 'ok']);
  });

  it('normalizes extra body pipes into the final declared column', () => {
    const source = ['| A | B |', '| --- | --- |', '| one | two | three |'].join('\n');

    expect(escapeGfmTableCellPipes(source)).toBe(['| A | B |', '| --- | --- |', '| one | two | three |'].join('\n'));
  });
});
