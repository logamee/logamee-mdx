import { describe, expect, it } from 'vitest';
import { applyOutsideCommonFenceBlocks } from './fences';

describe('markdown fence helpers', () => {
  it('applies transforms only outside backtick and tilde fences', () => {
    const source = ['before pipe', '```md', 'inside pipe', '```', '~~~txt', 'tilde pipe', '~~~', 'after pipe'].join('\n');

    expect(applyOutsideCommonFenceBlocks(source, (segment) => segment.replace(/pipe/g, 'PIPE'))).toBe([
      'before PIPE',
      '```md',
      'inside pipe',
      '```',
      '~~~txt',
      'tilde pipe',
      '~~~',
      'after PIPE',
    ].join('\n'));
  });
});
