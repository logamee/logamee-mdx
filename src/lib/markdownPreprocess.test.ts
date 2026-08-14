import { describe, expect, it } from 'vitest';
import { preprocessMarkdown } from './markdownPreprocess';

describe('markdown preprocessing', () => {
  it('preserves standalone pipe-delimited prose that is not a GFM table', () => {
    const source = 'Keep this prose | with a trailing separator |';

    expect(preprocessMarkdown(source)).toBe(source);
  });

  it('escapes inline-code pipes inside confirmed GFM tables', () => {
    const source = ['| Name | Example |', '| --- | --- |', '| CLI | `cat a | grep b` |'].join('\n');

    expect(preprocessMarkdown(source)).toBe(['| Name | Example |', '| --- | --- |', '| CLI | `cat a \\| grep b` |'].join('\n'));
  });

  it('does not preprocess table-like content inside fenced code blocks', () => {
    const source = ['```md', '| not | a table |', '| --- | --- |', '$12', '```'].join('\n');

    expect(preprocessMarkdown(source)).toBe(source);
  });

  it('escapes currency dollars while preserving digit-started inline math', () => {
    expect(preprocessMarkdown('Price is $12.50, formula is $2x+1$.')).toBe('Price is \\$12.50, formula is $2x+1$.');
  });

  it('adds hard line breaks between adjacent blockquote prose lines', () => {
    const source = ['> first line', '> second line'].join('\n');

    expect(preprocessMarkdown(source)).toBe(['> first line  ', '> second line'].join('\n'));
  });
});
