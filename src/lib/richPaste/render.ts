import type { RenderContext } from './sanitize';
import { BLOCK_TAGS, compactInlineWhitespace, escapeMarkdownText, escapeTableCell } from './sanitize';
import { normalizeMarkdownBlock } from './markdownSource';


function renderInlineChildren(parent: Node, ctx: RenderContext = {}): string {
  return Array.from(parent.childNodes).map((node) => renderNode(node, ctx)).join('');
}

export function renderBlockChildren(parent: Node, ctx: RenderContext = {}): string {
  const blocks: string[] = [];
  let inlineBuffer = '';
  const flushInline = () => {
    const normalized = normalizeMarkdownBlock(inlineBuffer);
    if (normalized.length > 0) blocks.push(normalized);
    inlineBuffer = '';
  };

  for (const child of Array.from(parent.childNodes)) {
    if (child.nodeType === Node.ELEMENT_NODE && BLOCK_TAGS.has((child as Element).localName)) {
      flushInline();
      const block = normalizeMarkdownBlock(renderNode(child, ctx));
      if (block.length > 0) blocks.push(block);
    } else {
      inlineBuffer += renderNode(child, ctx);
    }
  }
  flushInline();
  return blocks.join('\n\n');
}


const HEADING_TAGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6']);
const INLINE_CONTAINER_TAGS = new Set(['p', 'div', 'span', 'u']);
const STRIKE_TAGS = new Set(['s', 'strike', 'del']);
const TABLE_STRUCTURE_TAGS = new Set(['thead', 'tbody', 'tfoot', 'tr', 'th', 'td']);

function renderHeading(element: Element, ctx: RenderContext): string {
  const level = Number(element.localName.slice(1));
  const text = normalizeMarkdownBlock(renderInlineChildren(element, ctx));
  return text.length > 0 ? `${'#'.repeat(level)} ${text}` : '';
}

function renderStrong(element: Element, ctx: RenderContext): string {
  const text = trimInline(renderInlineChildren(element, ctx));
  return text.length > 0 ? `**${text}**` : '';
}

function renderEmphasis(element: Element, ctx: RenderContext): string {
  const text = trimInline(renderInlineChildren(element, ctx));
  return text.length > 0 ? `*${text}*` : '';
}

function renderStrikethrough(element: Element, ctx: RenderContext): string {
  const text = trimInline(renderInlineChildren(element, ctx));
  return text.length > 0 ? `~~${text}~~` : '';
}

function renderAnchor(element: Element, ctx: RenderContext): string {
  const label = trimInline(renderInlineChildren(element, ctx));
  const href = element.getAttribute('href');
  return href !== null && label.length > 0 ? `[${label}](${href.replace(/\)/gu, '%29')})` : label;
}

function renderCodeElement(element: Element, ctx: RenderContext): string {
  if (ctx.inPre) return element.textContent ?? '';
  return renderInlineCode(element.textContent ?? '');
}

// 结构性块级标签到渲染器的分派表；行内标签走默认路径。
const BLOCK_RENDERERS: ReadonlyArray<{
  matches: (tagName: string) => boolean;
  render: (element: Element, ctx: RenderContext) => string;
}> = [
  { matches: (t) => HEADING_TAGS.has(t), render: (el, ctx) => renderHeading(el, ctx) },
  { matches: (t) => INLINE_CONTAINER_TAGS.has(t), render: (el, ctx) => renderInlineChildren(el, ctx) },
  { matches: (t) => t === 'strong' || t === 'b', render: (el, ctx) => renderStrong(el, ctx) },
  { matches: (t) => t === 'em' || t === 'i', render: (el, ctx) => renderEmphasis(el, ctx) },
  { matches: (t) => STRIKE_TAGS.has(t), render: (el, ctx) => renderStrikethrough(el, ctx) },
  { matches: (t) => t === 'a', render: (el, ctx) => renderAnchor(el, ctx) },
  { matches: (t) => t === 'code', render: (el, ctx) => renderCodeElement(el, ctx) },
  { matches: (t) => t === 'blockquote', render: (el) => renderBlockquote(el) },
  { matches: (t) => t === 'ul', render: (el) => renderList(el, false) },
  { matches: (t) => t === 'ol', render: (el) => renderList(el, true) },
  { matches: (t) => t === 'table', render: (el) => renderTable(el) },
  {
    matches: (t) => TABLE_STRUCTURE_TAGS.has(t),
    render: (el, ctx) => renderInlineChildren(el, { ...ctx, inTable: true }),
  },
];

// 无独立渲染器的简单标签：换行/水平线/复选框/列表项。
function renderSimpleTag(element: Element, tagName: string, ctx: RenderContext): string | null {
  if (tagName === 'br') return ctx.inTable ? '<br>' : '  \n';
  if (tagName === 'pre') return renderCodeBlock(element.textContent ?? '');
  if (tagName === 'hr') return '---';
  if (tagName === 'input') return '';
  if (tagName === 'li') {
    return normalizeMarkdownBlock(renderBlockChildren(element, ctx) || renderInlineChildren(element, ctx));
  }
  return null;
}

function renderNode(node: Node, ctx: RenderContext = {}): string {
  if (node.nodeType === Node.TEXT_NODE) {
    const text = node.textContent ?? '';
    return ctx.inPre ? text.replace(/\r\n?/gu, '\n') : escapeMarkdownText(compactInlineWhitespace(text));
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return '';

  const element = node as Element;
  const tagName = element.localName;
  const simple = renderSimpleTag(element, tagName, ctx);
  if (simple !== null) return simple;
  const blockRenderer = BLOCK_RENDERERS.find(({ matches }) => matches(tagName));
  return blockRenderer ? blockRenderer.render(element, ctx) : renderInlineChildren(element, ctx);
}
function trimInline(value: string): string {
  return value.replace(/^\s+/u, '').replace(/\s+$/u, '');
}

function renderInlineCode(value: string): string {
  const normalized = value.replace(/\r\n?/gu, '\n');
  const longestTicks = Math.max(0, ...Array.from(normalized.matchAll(/`+/gu), (match) => match[0].length));
  const fence = '`'.repeat(longestTicks + 1);
  const needsPadding = normalized.startsWith('`') || normalized.endsWith('`') || /\s/u.test(normalized.slice(0, 1)) || /\s/u.test(normalized.slice(-1));
  const content = needsPadding ? ` ${normalized} ` : normalized;
  return `${fence}${content}${fence}`;
}

function renderCodeBlock(value: string): string {
  const normalized = value.replace(/\r\n?/gu, '\n').replace(/\n+$/u, '');
  const longestFence = Math.max(2, ...Array.from(normalized.matchAll(/`{3,}/gu), (match) => match[0].length));
  const fence = '`'.repeat(longestFence + 1);
  return `${fence}\n${normalized}\n${fence}`;
}

function renderBlockquote(element: Element): string {
  const body = normalizeMarkdownBlock(renderBlockChildren(element));
  if (body.length === 0) return '';
  return body.split('\n').map((line) => (line.length === 0 ? '>' : `> ${line}`)).join('\n');
}

function renderList(element: Element, ordered: boolean): string {
  const items = Array.from(element.children).filter((child) => child.localName === 'li');
  const start = ordered ? Number(element.getAttribute('start') ?? '1') : 1;
  return items.map((item, index) => {
    const checkbox = item.querySelector(':scope > input[type="checkbox"]');
    const marker = ordered ? `${start + index}. ` : '- ';
    const task = !ordered && checkbox !== null ? `[${checkbox.hasAttribute('checked') ? 'x' : ' '}] ` : '';
    const clone = item.cloneNode(true) as Element;
    clone.querySelector(':scope > input[type="checkbox"]')?.remove();
    const body = normalizeMarkdownBlock(renderBlockChildren(clone) || renderInlineChildren(clone));
    const lines = body.split('\n');
    return `${marker}${task}${lines[0] ?? ''}${lines.slice(1).map((line) => `\n${' '.repeat(marker.length)}${line}`).join('')}`.trimEnd();
  }).filter((value) => value.length > 0).join('\n');
}

function renderTable(table: Element): string {
  const rows = Array.from(table.querySelectorAll('tr')).map((row) => Array.from(row.children)
    .filter((cell) => cell.localName === 'th' || cell.localName === 'td')
    .map((cell) => escapeTableCell(renderInlineChildren(cell, { inTable: true }))));
  const nonEmptyRows = rows.filter((row) => row.some((cell) => cell.length > 0));
  if (nonEmptyRows.length === 0) return '';
  const columnCount = Math.max(...nonEmptyRows.map((row) => row.length));
  const normalizedRows = nonEmptyRows.map((row) => Array.from({ length: columnCount }, (_, index) => row[index] ?? ''));
  const header = normalizedRows[0];
  const separator = Array.from({ length: columnCount }, () => '---');
  const body = normalizedRows.slice(1);
  return [header, separator, ...body]
    .map((row) => `| ${row.join(' | ')} |`)
    .join('\n');
}
