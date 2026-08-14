import { markdownLanguage } from '@codemirror/lang-markdown';

export const OUTLINE_JUMP_EVENT = 'mmd-outline-jump';

export interface MarkdownOutlineItem {
  depth: number;
  id: string;
  level: number;
  line: number;
  offset: number;
  ordinal: number;
  text: string;
}

export interface MarkdownOutlineJump {
  documentId: string;
  documentEpoch: number;
  item: MarkdownOutlineItem;
  requestId: number;
}

const HEADING_NODE_RE = /^(?:ATX|Setext)Heading([1-6])$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => key in value);
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return isNonNegativeSafeInteger(value) && value > 0;
}

function isHeadingLevel(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 && value <= 6;
}

function isProtocolId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(value);
}

function lineStartsFor(source: string): number[] {
  const starts = [0];
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] === '\n') starts.push(index + 1);
  }
  return starts;
}

function lineForOffset(lineStarts: number[], offset: number): number {
  let low = 0;
  let high = lineStarts.length;
  while (low + 1 < high) {
    const middle = Math.floor((low + high) / 2);
    if (lineStarts[middle] <= offset) low = middle;
    else high = middle;
  }
  return low + 1;
}

function headingSource(nodeName: string, source: string): string {
  if (nodeName.startsWith('ATX')) {
    return source
      .replace(/^ {0,3}#{1,6}(?:[ \t]+|$)/, '')
      .replace(/[ \t]+#+[ \t]*$/, '');
  }
  return source.replace(/\r?\n[ \t]*[=-]+[ \t]*$/, '');
}

function plainHeadingText(source: string): string {
  return source
    .replace(/\s+/g, ' ')
    .trim();
}

export function decodeMarkdownOutlineJump(value: unknown): MarkdownOutlineJump | null {
  if (
    !isRecord(value)
    || !hasExactKeys(value, ['documentEpoch', 'documentId', 'item', 'requestId'])
  ) return null;

  const { documentEpoch, documentId, item, requestId } = value;
  if (
    !isNonNegativeSafeInteger(documentEpoch)
    || !isProtocolId(documentId)
    || !isPositiveSafeInteger(requestId)
    || !isRecord(item)
    || !hasExactKeys(item, ['depth', 'id', 'level', 'line', 'offset', 'ordinal', 'text'])
  ) return null;

  const { depth, id, level, line, offset, ordinal, text } = item;
  if (
    !isNonNegativeSafeInteger(depth)
    || depth > 5
    || !isProtocolId(id)
    || !isHeadingLevel(level)
    || !isPositiveSafeInteger(line)
    || !isNonNegativeSafeInteger(offset)
    || !isNonNegativeSafeInteger(ordinal)
    || typeof text !== 'string'
    || text.length === 0
    || text.length > 4096
  ) return null;

  return {
    documentEpoch,
    documentId,
    item: {
      depth,
      id,
      level,
      line,
      offset,
      ordinal,
      text,
    },
    requestId,
  };
}

export function extractMarkdownOutline(source: string): MarkdownOutlineItem[] {
  const items: MarkdownOutlineItem[] = [];
  const lineStarts = lineStartsFor(source);
  const ancestorLevels: number[] = [];

  markdownLanguage.parser.parse(source).iterate({
    enter: (node) => {
      const match = HEADING_NODE_RE.exec(node.name);
      if (!match) return;

      const text = plainHeadingText(headingSource(node.name, source.slice(node.from, node.to)));
      if (!text) return;

      const level = Number(match[1]);
      while (ancestorLevels.length > 0 && ancestorLevels[ancestorLevels.length - 1] >= level) {
        ancestorLevels.pop();
      }

      const ordinal = items.length;
      items.push({
        depth: ancestorLevels.length,
        id: `heading-${node.from}`,
        level,
        line: lineForOffset(lineStarts, node.from),
        offset: node.from,
        ordinal,
        text,
      });
      ancestorLevels.push(level);
    },
  });

  return items;
}
