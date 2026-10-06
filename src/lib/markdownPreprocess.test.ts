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

  it('converts leading bullet characters into list items outside fences', () => {
    expect(preprocessMarkdown('• 圆点列表项')).toBe('- 圆点列表项');
  });

  it('splits prefixed inline bullet points into a list', () => {
    expect(preprocessMarkdown('要点：- 甲 - 乙 - 丙')).toBe('要点：\n- 甲\n- 乙\n- 丙');
  });

  it('rewrites bare autolinks followed by fullwidth punctuation into explicit links', () => {
    expect(preprocessMarkdown('https://x.cn/a。')).toBe('[https://x.cn/a](https://x.cn/a)。');
  });

  it('converts complete br tags into hard breaks outside fences', () => {
    expect(preprocessMarkdown('段落中间文字<br>第二行。')).toBe('段落中间文字  \n第二行。');
  });

  it('does not apply the writing-tolerance rules inside fenced code blocks', () => {
    const source = ['```md', '• 围栏内圆点', '要点：- 甲 - 乙', 'https://x.cn/a。', 'a<br>b', '```'].join('\n');

    expect(preprocessMarkdown(source)).toBe(source);
  });
});
