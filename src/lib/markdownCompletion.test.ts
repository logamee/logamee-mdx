import { describe, expect, it } from 'vitest';
import { getMarkdownCompletionEdit } from './markdownCompletion';

function completion(source: string, cursor: number, text: string) {
  return getMarkdownCompletionEdit(
    source,
    { from: cursor, to: cursor },
    { from: cursor, to: cursor, text },
  );
}

describe('getMarkdownCompletionEdit', () => {
  it('creates paired Markdown links and image links without duplicating their closers', () => {
    expect(completion('', 0, '[')).toEqual({
      from: 0,
      to: 0,
      insert: '[]()',
      selection: { anchor: 1, head: 1 },
    });
    expect(completion('!', 1, '[')).toEqual({
      from: 1,
      to: 1,
      insert: '[]()',
      selection: { anchor: 2, head: 2 },
    });
    expect(completion('[]()', 1, ']')).toEqual({
      from: 1,
      to: 1,
      insert: '',
      selection: { anchor: 2, head: 2 },
    });
    expect(completion('[]()', 3, ')')).toEqual({
      from: 3,
      to: 3,
      insert: '',
      selection: { anchor: 4, head: 4 },
    });
    expect(completion(']()', 0, '[')).toBeNull();
  });

  it('pairs ordinary delimiters and upgrades an empty emphasis pair to a strong pair', () => {
    expect(completion('', 0, '(')).toEqual({
      from: 0,
      to: 0,
      insert: '()',
      selection: { anchor: 1, head: 1 },
    });
    expect(completion('', 0, '"')).toEqual({
      from: 0,
      to: 0,
      insert: '""',
      selection: { anchor: 1, head: 1 },
    });
    expect(completion('""', 1, '"')).toEqual({
      from: 1,
      to: 1,
      insert: '',
      selection: { anchor: 2, head: 2 },
    });
    expect(completion('word', 4, '*')).toEqual({
      from: 4,
      to: 4,
      insert: '**',
      selection: { anchor: 5, head: 5 },
    });
    expect(completion('**', 1, '*')).toEqual({
      from: 0,
      to: 2,
      insert: '****',
      selection: { anchor: 2, head: 2 },
    });
  });

  it('creates Markdown headings, block quotes, and list markers only at an otherwise blank line', () => {
    expect(completion('', 0, '#')).toEqual({
      from: 0,
      to: 0,
      insert: '# ',
      selection: { anchor: 2, head: 2 },
    });
    expect(completion('  ', 2, '>')).toEqual({
      from: 2,
      to: 2,
      insert: '> ',
      selection: { anchor: 4, head: 4 },
    });
    expect(completion('', 0, '-')).toEqual({
      from: 0,
      to: 0,
      insert: '- ',
      selection: { anchor: 2, head: 2 },
    });
    expect(completion('1', 1, '.')).toEqual({
      from: 1,
      to: 1,
      insert: '. ',
      selection: { anchor: 3, head: 3 },
    });
    expect(completion('text', 4, '#')).toBeNull();
  });

  it('expands a blank-line fence and keeps fenced code free of Markdown completions', () => {
    expect(completion('``', 2, '`')).toEqual({
      from: 0,
      to: 2,
      insert: '```\n\n```',
      selection: { anchor: 4, head: 4 },
    });
    expect(completion('```\n', 4, '[')).toBeNull();
    expect(completion('```\ncode\n``', 11, '`')).toBeNull();
    expect(completion('```\ncode\n``` not a close\nbody', 29, '[')).toBeNull();
  });

  it('continues Markdown lists, increments ordered markers, and terminates empty items', () => {
    expect(completion('- item', 6, '\n')).toEqual({
      from: 6,
      to: 6,
      insert: '\n- ',
      selection: { anchor: 9, head: 9 },
    });
    expect(completion('3. item', 7, '\n')).toEqual({
      from: 7,
      to: 7,
      insert: '\n4. ',
      selection: { anchor: 11, head: 11 },
    });
    expect(completion('- [x] done', 10, '\n')).toEqual({
      from: 10,
      to: 10,
      insert: '\n- [ ] ',
      selection: { anchor: 17, head: 17 },
    });
    expect(completion('- ', 2, '\n')).toEqual({
      from: 0,
      to: 2,
      insert: '\n',
      selection: { anchor: 1, head: 1 },
    });
  });

  it('turns the supported alert prefix into an editable alert template', () => {
    expect(completion('> [', 3, '!')).toEqual({
      from: 0,
      to: 3,
      insert: '> [!TIP]\n> ',
      selection: { anchor: 4, head: 7 },
    });
  });

  it('leaves selected, pasted, multi-character, and fenced-code input untouched', () => {
    expect(getMarkdownCompletionEdit(
      'selected',
      { from: 0, to: 8 },
      { from: 0, to: 8, text: '[' },
    )).toBeNull();
    expect(completion('', 0, '[]')).toBeNull();
    expect(completion('```\ncode', 8, '*')).toBeNull();
  });
});
