import { describe, expect, it } from 'vitest';
import { decodeMarkdownOutlineJump, extractMarkdownOutline } from './markdownOutline';

describe('extractMarkdownOutline', () => {
  it('builds a nested outline with source positions from document headings', () => {
    const source = '# Project\n\n## Install\n\n### macOS\n';

    expect(extractMarkdownOutline(source)).toEqual([
      {
        depth: 0,
        id: 'heading-0',
        level: 1,
        line: 1,
        offset: 0,
        ordinal: 0,
        text: 'Project',
      },
      {
        depth: 1,
        id: 'heading-11',
        level: 2,
        line: 3,
        offset: 11,
        ordinal: 1,
        text: 'Install',
      },
      {
        depth: 2,
        id: 'heading-23',
        level: 3,
        line: 5,
        offset: 23,
        ordinal: 2,
        text: 'macOS',
      },
    ]);
  });

  it('ignores fenced-code headings and keeps visible heading line numbers', () => {
    const source = [
      '# 中文标题',
      '',
      '```markdown',
      '## not an outline heading',
      '```',
      '',
      'Install guide',
      '---',
    ].join('\r\n');

    expect(extractMarkdownOutline(source)).toMatchObject([
      {
        depth: 0,
        level: 1,
        line: 1,
        ordinal: 0,
        text: '中文标题',
      },
      {
        depth: 1,
        level: 2,
        line: 7,
        ordinal: 1,
        text: 'Install guide',
      },
    ]);
  });

  it('accepts only complete, bounded cross-window outline jumps', () => {
    const jump = {
      documentEpoch: 4,
      documentId: 'pane-document:4',
      item: {
        depth: 1,
        id: 'heading-11',
        level: 2,
        line: 3,
        offset: 11,
        ordinal: 1,
        text: 'Install',
      },
      requestId: 2,
    };

    expect(decodeMarkdownOutlineJump(jump)).toEqual(jump);
    expect(decodeMarkdownOutlineJump({ ...jump, requestId: -1 })).toBeNull();
    expect(decodeMarkdownOutlineJump({ ...jump, item: { ...jump.item, level: 7 } })).toBeNull();
  });
});
