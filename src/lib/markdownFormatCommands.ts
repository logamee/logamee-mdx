export type MarkdownFormatCommandId =
  | 'h1'
  | 'h2'
  | 'h3'
  | 'bold'
  | 'italic'
  | 'strikethrough'
  | 'inline-code'
  | 'link'
  | 'blockquote'
  | 'bullet-list'
  | 'ordered-list'
  | 'task-list'
  | 'code-block'
  | 'alert-tip'
  | 'alert-info'
  | 'alert-warning'
  | 'alert-error';

export interface MarkdownFormatCommand {
  category: 'Text' | 'Blocks' | 'Alerts';
  id: MarkdownFormatCommandId;
  keywords: string;
  label: string;
  syntax: string;
}

export interface MarkdownFormatSelection {
  from: number;
  to: number;
}

export interface MarkdownFormatEdit {
  from: number;
  insert: string;
  selection: { anchor: number; head: number };
  to: number;
}

export const MARKDOWN_FORMAT_COMMANDS: readonly MarkdownFormatCommand[] = [
  { category: 'Text', id: 'h1', keywords: 'title heading header', label: 'Heading 1', syntax: '# ' },
  { category: 'Text', id: 'h2', keywords: 'subtitle heading header', label: 'Heading 2', syntax: '## ' },
  { category: 'Text', id: 'h3', keywords: 'heading header', label: 'Heading 3', syntax: '### ' },
  { category: 'Text', id: 'bold', keywords: 'strong', label: 'Bold', syntax: '**text**' },
  { category: 'Text', id: 'italic', keywords: 'emphasis', label: 'Italic', syntax: '*text*' },
  { category: 'Text', id: 'strikethrough', keywords: 'strike delete', label: 'Strikethrough', syntax: '~~text~~' },
  { category: 'Text', id: 'inline-code', keywords: 'code monospace', label: 'Inline code', syntax: '`code`' },
  { category: 'Text', id: 'link', keywords: 'url anchor', label: 'Link', syntax: '[text](url)' },
  { category: 'Blocks', id: 'blockquote', keywords: 'quote citation', label: 'Quote', syntax: '> ' },
  { category: 'Blocks', id: 'bullet-list', keywords: 'unordered list bullets', label: 'Bullet list', syntax: '- ' },
  { category: 'Blocks', id: 'ordered-list', keywords: 'numbered list', label: 'Ordered list', syntax: '1. ' },
  { category: 'Blocks', id: 'task-list', keywords: 'checklist todo', label: 'Task list', syntax: '- [ ] ' },
  { category: 'Blocks', id: 'code-block', keywords: 'fence preformatted', label: 'Code block', syntax: '```' },
  { category: 'Alerts', id: 'alert-tip', keywords: 'tips hint success', label: 'Tip', syntax: '[!TIP]' },
  { category: 'Alerts', id: 'alert-info', keywords: 'note information', label: 'Info', syntax: '[!NOTE]' },
  { category: 'Alerts', id: 'alert-warning', keywords: 'warn attention', label: 'Warning', syntax: '[!WARNING]' },
  { category: 'Alerts', id: 'alert-error', keywords: 'caution danger failure', label: 'Error', syntax: '[!CAUTION]' },
];

const INLINE_WRAPPERS: Partial<Record<MarkdownFormatCommandId, readonly [string, string]>> = {
  bold: ['**', '**'],
  italic: ['*', '*'],
  strikethrough: ['~~', '~~'],
};

const BLOCK_COMMANDS = new Set<MarkdownFormatCommandId>([
  'h1',
  'h2',
  'h3',
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

const EMPTY_TEMPLATES: Record<MarkdownFormatCommandId, readonly [string, number]> = {
  h1: ['# ', 2],
  h2: ['## ', 3],
  h3: ['### ', 4],
  bold: ['****', 2],
  italic: ['**', 1],
  strikethrough: ['~~~~', 2],
  'inline-code': ['``', 1],
  link: ['[]()', 1],
  blockquote: ['> ', 2],
  'bullet-list': ['- ', 2],
  'ordered-list': ['1. ', 3],
  'task-list': ['- [ ] ', 6],
  'code-block': ['```\n\n```', 4],
  'alert-tip': ['> [!TIP]\n> ', 11],
  'alert-info': ['> [!NOTE]\n> ', 12],
  'alert-warning': ['> [!WARNING]\n> ', 15],
  'alert-error': ['> [!CAUTION]\n> ', 15],
};

function alertMarker(command: MarkdownFormatCommandId): string | null {
  if (command === 'alert-tip') return 'TIP';
  if (command === 'alert-info') return 'NOTE';
  if (command === 'alert-warning') return 'WARNING';
  if (command === 'alert-error') return 'CAUTION';
  return null;
}

function longestBacktickRun(text: string): number {
  let longest = 0;
  for (const match of text.matchAll(/`+/g)) longest = Math.max(longest, match[0].length);
  return longest;
}

function adjacentBacktickRun(source: string, position: number, direction: -1 | 1): number {
  let length = 0;
  for (let index = position; source[index] === '`'; index += direction) length += 1;
  return length;
}

function inlineCodeWrapper(selected: string, leadingRun: number, trailingRun: number): readonly [string, string] {
  const longestRun = longestBacktickRun(selected);
  const delimiterLength = Math.max(longestRun + 1, leadingRun, trailingRun);
  const hasPreservedEdgeSpaces = selected.startsWith(' ') && selected.endsWith(' ') && /\S/.test(selected);
  const padding = selected.startsWith('`') || selected.endsWith('`') || hasPreservedEdgeSpaces ? ' ' : '';
  return [
    `${'`'.repeat(delimiterLength - leadingRun)}${padding}`,
    `${padding}${'`'.repeat(delimiterLength - trailingRun)}`,
  ];
}

function prefixLines(text: string, prefix: (index: number) => string): string {
  const hasTrailingNewline = text.endsWith('\n');
  const lines = text.split('\n');
  if (hasTrailingNewline) lines.pop();
  const prefixed = lines.map((line, index) => `${prefix(index)}${line}`).join('\n');
  return hasTrailingNewline ? `${prefixed}\n` : prefixed;
}

function isolateBlock(source: string, from: number, to: number, block: string) {
  const before = from > 0 && source[from - 1] !== '\n' ? '\n' : '';
  const after = to < source.length && source[to] !== '\n' ? '\n' : '';
  return { after, before, insert: `${before}${block}${after}` };
}

function selectedBlock(command: MarkdownFormatCommandId, selected: string): string {
  if (command === 'h1') return prefixLines(selected, () => '# ');
  if (command === 'h2') return prefixLines(selected, () => '## ');
  if (command === 'h3') return prefixLines(selected, () => '### ');
  if (command === 'blockquote') return prefixLines(selected, () => '> ');
  if (command === 'bullet-list') return prefixLines(selected, () => '- ');
  if (command === 'ordered-list') return prefixLines(selected, (index) => `${index + 1}. `);
  if (command === 'task-list') return prefixLines(selected, () => '- [ ] ');
  if (command === 'code-block') {
    const fence = '`'.repeat(Math.max(3, longestBacktickRun(selected) + 1));
    const closingBreak = selected.endsWith('\n') ? '' : '\n';
    return `${fence}\n${selected}${closingBreak}${fence}`;
  }
  const marker = alertMarker(command);
  if (marker) return `> [!${marker}]\n${prefixLines(selected, () => '> ')}`;
  return selected;
}

export function applyMarkdownFormatCommand(
  source: string,
  selection: MarkdownFormatSelection,
  command: MarkdownFormatCommandId,
): MarkdownFormatEdit {
  const from = Math.max(0, Math.min(selection.from, selection.to, source.length));
  const to = Math.max(from, Math.min(Math.max(selection.from, selection.to), source.length));
  const selected = source.slice(from, to);

  if (!selected) {
    const [template, caretOffset] = EMPTY_TEMPLATES[command];
    const isolated = BLOCK_COMMANDS.has(command)
      ? isolateBlock(source, from, to, template)
      : { before: '', insert: template };
    const insert = isolated.insert;
    const caret = from + isolated.before.length + caretOffset;
    return { from, insert, selection: { anchor: caret, head: caret }, to };
  }

  if (command === 'inline-code') {
    const leadingRun = adjacentBacktickRun(source, from - 1, -1);
    const trailingRun = adjacentBacktickRun(source, to, 1);
    const [before, after] = inlineCodeWrapper(selected, leadingRun, trailingRun);
    return {
      from,
      insert: `${before}${selected}${after}`,
      selection: { anchor: from + before.length, head: from + before.length + selected.length },
      to,
    };
  }

  const wrapper = INLINE_WRAPPERS[command];
  if (wrapper) {
    const [before, after] = wrapper;
    return {
      from,
      insert: `${before}${selected}${after}`,
      selection: { anchor: from + before.length, head: from + before.length + selected.length },
      to,
    };
  }

  if (command === 'link') {
    const insert = `[${selected}]()`;
    const caret = from + selected.length + 3;
    return { from, insert, selection: { anchor: caret, head: caret }, to };
  }

  const block = selectedBlock(command, selected);
  const isolated = isolateBlock(source, from, to, block);
  const insert = isolated.insert;
  const caret = from + isolated.before.length + block.length;
  return { from, insert, selection: { anchor: caret, head: caret }, to };
}
