import { describe, expect, it } from 'vitest';
import {
  applyMarkdownFormatCommand,
  MARKDOWN_FORMAT_COMMANDS,
} from './markdownFormatCommands';

describe('Markdown format commands', () => {
  it('offers the expected headings, common blocks, and alert variants', () => {
    expect(MARKDOWN_FORMAT_COMMANDS.map((command) => command.id)).toEqual([
      'h1',
      'h2',
      'h3',
      'bold',
      'italic',
      'strikethrough',
      'inline-code',
      'link',
      'blockquote',
      'bullet-list',
      'ordered-list',
      'task-list',
      'code-block',
      'alert-tip',
      'alert-info',
      'alert-warning',
      'alert-error',
    ]);
  });

  it('inserts an empty inline template and places the caret inside it', () => {
    expect(applyMarkdownFormatCommand('before after', { from: 7, to: 7 }, 'bold')).toEqual({
      from: 7,
      insert: '****',
      selection: { anchor: 9, head: 9 },
      to: 7,
    });
  });

  it('wraps selected inline text and keeps the wrapped text selected', () => {
    expect(applyMarkdownFormatCommand('before alpha after', { from: 7, to: 12 }, 'bold')).toEqual({
      from: 7,
      insert: '**alpha**',
      selection: { anchor: 9, head: 14 },
      to: 12,
    });
  });

  it('uses an inline-code delimiter longer than any selected backtick run', () => {
    expect(applyMarkdownFormatCommand('alpha``beta', { from: 0, to: 11 }, 'inline-code')).toEqual({
      from: 0,
      insert: '```alpha``beta```',
      selection: { anchor: 3, head: 14 },
      to: 11,
    });
  });

  it('pads inline code that starts or ends with backticks', () => {
    expect(applyMarkdownFormatCommand('`alpha`', { from: 0, to: 7 }, 'inline-code')).toEqual({
      from: 0,
      insert: '`` `alpha` ``',
      selection: { anchor: 3, head: 10 },
      to: 7,
    });
  });

  it('pads nonblank inline code with spaces at both edges to preserve them', () => {
    expect(applyMarkdownFormatCommand(' alpha ', { from: 0, to: 7 }, 'inline-code')).toEqual({
      from: 0,
      insert: '`  alpha  `',
      selection: { anchor: 2, head: 9 },
      to: 7,
    });
  });

  it.each([
    { selection: { from: 1, to: 6 }, source: '`alpha' },
    { selection: { from: 0, to: 5 }, source: 'alpha`' },
  ])('absorbs a one-sided adjacent backtick into the inline-code delimiter', ({ selection, source }) => {
    const edit = applyMarkdownFormatCommand(source, selection, 'inline-code');
    const result = `${source.slice(0, edit.from)}${edit.insert}${source.slice(edit.to)}`;

    expect(result).toBe('`alpha`');
    expect(result.slice(edit.selection.anchor, edit.selection.head)).toBe('alpha');
  });

  it('handles many separate backtick runs without overflowing the call stack', () => {
    const selected = '`a'.repeat(140_000);

    expect(() => applyMarkdownFormatCommand(
      selected,
      { from: 0, to: selected.length },
      'inline-code',
    )).not.toThrow();
  });

  it('places the caret in the link destination after wrapping selected text', () => {
    expect(applyMarkdownFormatCommand('alpha', { from: 0, to: 5 }, 'link')).toEqual({
      from: 0,
      insert: '[alpha]()',
      selection: { anchor: 8, head: 8 },
      to: 5,
    });
  });

  it('prefixes every selected line for unordered and ordered lists', () => {
    expect(applyMarkdownFormatCommand('alpha\nbeta', { from: 0, to: 10 }, 'bullet-list').insert)
      .toBe('- alpha\n- beta');
    expect(applyMarkdownFormatCommand('alpha\nbeta', { from: 0, to: 10 }, 'ordered-list').insert)
      .toBe('1. alpha\n2. beta');
  });

  it('does not prefix a phantom line when a bullet-list selection ends with a newline', () => {
    expect(applyMarkdownFormatCommand('alpha\n', { from: 0, to: 6 }, 'bullet-list').insert)
      .toBe('- alpha\n');
  });

  it.each([
    ['h1', '# alpha\n'],
    ['h2', '## alpha\n'],
    ['h3', '### alpha\n'],
    ['blockquote', '> alpha\n'],
    ['ordered-list', '1. alpha\n'],
    ['task-list', '- [ ] alpha\n'],
    ['alert-tip', '> [!TIP]\n> alpha\n'],
    ['alert-info', '> [!NOTE]\n> alpha\n'],
    ['alert-warning', '> [!WARNING]\n> alpha\n'],
    ['alert-error', '> [!CAUTION]\n> alpha\n'],
  ] as const)('preserves a terminal newline without adding a phantom %s line', (command, expected) => {
    expect(applyMarkdownFormatCommand('alpha\n', { from: 0, to: 6 }, command).insert)
      .toBe(expected);
  });

  it.each([
    ['alert-tip', '> [!TIP]\n> selected'],
    ['alert-info', '> [!NOTE]\n> selected'],
    ['alert-warning', '> [!WARNING]\n> selected'],
    ['alert-error', '> [!CAUTION]\n> selected'],
  ] as const)('wraps selected text with the %s alert syntax', (command, expected) => {
    expect(applyMarkdownFormatCommand('selected', { from: 0, to: 8 }, command).insert)
      .toBe(expected);
  });

  it('inserts empty block templates with useful caret positions', () => {
    expect(applyMarkdownFormatCommand('', { from: 0, to: 0 }, 'h2')).toMatchObject({
      insert: '## ',
      selection: { anchor: 3, head: 3 },
    });
    expect(applyMarkdownFormatCommand('', { from: 0, to: 0 }, 'code-block')).toMatchObject({
      insert: '```\n\n```',
      selection: { anchor: 4, head: 4 },
    });
    expect(applyMarkdownFormatCommand('', { from: 0, to: 0 }, 'alert-tip')).toMatchObject({
      insert: '> [!TIP]\n> ',
      selection: { anchor: 11, head: 11 },
    });
  });

  it('uses a code-block fence longer than any selected backtick run', () => {
    expect(applyMarkdownFormatCommand(
      'alpha\n```\nbeta',
      { from: 0, to: 14 },
      'code-block',
    ).insert).toBe('````\nalpha\n```\nbeta\n````');
  });

  it('preserves a code-block selection terminal newline without adding a blank line', () => {
    expect(applyMarkdownFormatCommand('alpha\n', { from: 0, to: 6 }, 'code-block').insert)
      .toBe('```\nalpha\n```');
  });

  it('isolates an empty block template when the caret is inside a paragraph', () => {
    expect(applyMarkdownFormatCommand('beforeafter', { from: 6, to: 6 }, 'alert-tip')).toEqual({
      from: 6,
      insert: '\n> [!TIP]\n> \n',
      selection: { anchor: 18, head: 18 },
      to: 6,
    });
  });
});
