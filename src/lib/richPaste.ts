import DOMPurify from 'dompurify';

export const RICH_PASTE_LIMITS = Object.freeze({
  maxInputBytes: 2 * 1024 * 1024,
  maxSanitizedNodes: 20_000,
  maxOutputBytes: 1 * 1024 * 1024,
  maxImageBytes: 16 * 1024 * 1024,
} as const);

export interface RichClipboardPayload {
  readonly html?: string | null;
  readonly text?: string | null;
  readonly rtf?: string | null;
  readonly plainTextKind?: 'general' | 'pdf';
}

export interface RichPasteConversionOptions {
  readonly maxInputBytes?: number;
  readonly maxSanitizedNodes?: number;
  readonly maxOutputBytes?: number;
}

export interface RichPasteMarkdownResult {
  readonly markdown: string;
  readonly source: 'html' | 'rtf' | 'text';
  readonly formattingLoss: boolean;
  readonly nodeCount: number;
}

export class RichPasteConversionError extends Error {
  constructor(message = 'Clipboard content could not be converted safely.') {
    super(message);
    this.name = 'RichPasteConversionError';
  }
}

const HTML_NAMESPACE = 'http://www.w3.org/1999/xhtml';
const ALLOWED_TAGS = Object.freeze([
  'a', 'b', 'blockquote', 'br', 'caption', 'code', 'del', 'div', 'em', 'h1', 'h2',
  'h3', 'h4', 'h5', 'h6', 'hr', 'i', 'input', 'li', 'ol', 'p', 'pre', 's', 'span',
  'strike', 'strong', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'u', 'ul',
] as const);
const ALLOWED_ATTR = Object.freeze(['checked', 'href', 'start', 'title', 'type'] as const);
const BLOCK_TAGS = new Set(['blockquote', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'li', 'ol', 'p', 'pre', 'table', 'ul']);
const UNSAFE_RELATIVE_PREFIX = /^(?:[a-z][a-z0-9+.-]*:|\/\/|\\|#)/iu;
const WINDOWS_ABSOLUTE_OR_TEMP = /^(?:[a-z]:[\\/]|(?:\.\.?(?:[\\/]|$))|~[\\/])/iu;
const NULL_CHARACTER = String.fromCharCode(0);
const RTF_DESTINATION_WORDS = new Set([
  'fonttbl', 'colortbl', 'stylesheet', 'info', 'pict', 'object', 'objectctl', 'nonshppict',
  'header', 'footer', 'headerl', 'headerr', 'headerf', 'footerl', 'footerr', 'footerf',
  'aftncn', 'aftnsep', 'aftnsepc', 'annotation', 'comment', 'generictype', 'listtable',
  'revtbl', 'themedata', 'colorschememapping', 'xmlattrname', 'xmlattrvalue', 'xmlclose',
  'xmlopen', 'shp', 'shpgrp', 'shpinst', 'do', 'datastore', 'userprops', 'latentstyles',
]);

interface RenderContext {
  readonly inPre?: boolean;
  readonly inTable?: boolean;
}

interface Limits {
  readonly maxInputBytes: number;
  readonly maxSanitizedNodes: number;
  readonly maxOutputBytes: number;
}

interface RtfFrame {
  skip: boolean;
  ucSkip: number;
}

function getLimits(options: RichPasteConversionOptions | undefined): Limits {
  return {
    maxInputBytes: getLimit(options?.maxInputBytes, RICH_PASTE_LIMITS.maxInputBytes, 'input'),
    maxSanitizedNodes: getLimit(options?.maxSanitizedNodes, RICH_PASTE_LIMITS.maxSanitizedNodes, 'node'),
    maxOutputBytes: getLimit(options?.maxOutputBytes, RICH_PASTE_LIMITS.maxOutputBytes, 'output'),
  };
}

function getLimit(value: number | undefined, fallback: number, label: string): number {
  const limit = value ?? fallback;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > fallback) {
    throw new RichPasteConversionError(`The rich paste ${label} limit is invalid.`);
  }
  return limit;
}

function getUtf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function assertWithinBytes(value: string, maximum: number, label: string): void {
  if (getUtf8ByteLength(value) > maximum) {
    throw new RichPasteConversionError(`Clipboard ${label} content is too large to paste safely.`);
  }
}

function countNodes(root: DocumentFragment, maximum: number): number {
  const nodeFilter = root.ownerDocument.defaultView?.NodeFilter;
  const walker = root.ownerDocument.createTreeWalker(root, nodeFilter?.SHOW_ALL ?? 0xffffffff);
  let count = 0;
  while (walker.nextNode() !== null) {
    count += 1;
    if (count > maximum) {
      throw new RichPasteConversionError('Clipboard content is too complex to paste safely.');
    }
  }
  return count;
}

function sanitizeHtml(html: string, limits: Limits): { fragment: DocumentFragment; nodeCount: number } {
  assertWithinBytes(html, limits.maxInputBytes, 'input');
  if (DOMPurify.isSupported !== true) throw new RichPasteConversionError();
  let fragment: DocumentFragment;
  try {
    fragment = DOMPurify.sanitize(html, {
      ALLOWED_TAGS: Array.from(ALLOWED_TAGS),
      ALLOWED_ATTR: Array.from(ALLOWED_ATTR),
      ALLOWED_NAMESPACES: [HTML_NAMESPACE],
      NAMESPACE: HTML_NAMESPACE,
      ALLOW_ARIA_ATTR: false,
      ALLOW_DATA_ATTR: false,
      ALLOW_UNKNOWN_PROTOCOLS: false,
      CUSTOM_ELEMENT_HANDLING: {
        tagNameCheck: null,
        attributeNameCheck: null,
        allowCustomizedBuiltInElements: false,
      },
      PARSER_MEDIA_TYPE: 'text/html',
      RETURN_DOM_FRAGMENT: true,
      RETURN_TRUSTED_TYPE: false,
    });
  } catch {
    throw new RichPasteConversionError();
  }

  const nodeCount = countNodes(fragment, limits.maxSanitizedNodes);
  applyHtmlPolicy(fragment, limits);
  return { fragment, nodeCount: countNodes(fragment, limits.maxSanitizedNodes) || nodeCount };
}

function applyHtmlPolicy(fragment: DocumentFragment, limits: Limits): void {
  for (const element of Array.from(fragment.querySelectorAll('*'))) {
    if (element.namespaceURI !== HTML_NAMESPACE || !ALLOWED_TAGS.includes(element.localName as typeof ALLOWED_TAGS[number])) {
      element.remove();
      continue;
    }

    for (const attribute of Array.from(element.attributes)) {
      if (!ALLOWED_ATTR.includes(attribute.name as typeof ALLOWED_ATTR[number]) || attribute.namespaceURI !== null) {
        element.removeAttributeNode(attribute);
      }
    }

    if (element.localName === 'a') normalizeAnchor(element);
    if (element.localName === 'ol') normalizeOrderedListStart(element, limits);
    if (element.localName === 'input') normalizeTaskCheckbox(element);
  }
}

function normalizeAnchor(anchor: Element): void {
  const rawHref = anchor.getAttribute('href');
  if (rawHref === null) return;
  const href = rawHref.trim();
  if (href.length === 0) {
    anchor.removeAttribute('href');
    return;
  }
  try {
    const parsed = new URL(href);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'mailto:') {
      anchor.removeAttribute('href');
      return;
    }
    if (parsed.protocol === 'https:' && parsed.hostname.length === 0) {
      anchor.removeAttribute('href');
      return;
    }
    anchor.setAttribute('href', parsed.href);
    return;
  } catch {
    // Relative links are allowed when they do not escape the workspace/document context.
  }
  if (UNSAFE_RELATIVE_PREFIX.test(href) || WINDOWS_ABSOLUTE_OR_TEMP.test(href) || href.includes(NULL_CHARACTER)) {
    anchor.removeAttribute('href');
    return;
  }
  anchor.setAttribute('href', encodeRelativeHref(href));
}

function encodeRelativeHref(href: string): string {
  return href
    .split('/')
    .map((part, index) => (index === 0 && part === '' ? '' : encodeURI(part).replace(/[()]/gu, (value) => `%${value.charCodeAt(0).toString(16).toUpperCase()}`)))
    .join('/');
}

function normalizeOrderedListStart(element: Element, limits: Limits): void {
  const rawStart = element.getAttribute('start');
  if (rawStart === null) return;
  const start = Number(rawStart.trim());
  if (!Number.isSafeInteger(start) || start < 1 || start > limits.maxSanitizedNodes) {
    element.removeAttribute('start');
  } else {
    element.setAttribute('start', String(start));
  }
}

function normalizeTaskCheckbox(element: Element): void {
  if (element.getAttribute('type')?.toLowerCase() !== 'checkbox') {
    element.remove();
    return;
  }
  for (const attribute of Array.from(element.attributes)) {
    if (attribute.name !== 'type' && attribute.name !== 'checked') element.removeAttributeNode(attribute);
  }
}

function compactInlineWhitespace(value: string): string {
  return value.replace(/[\t\n\f\r \u00a0]+/gu, ' ');
}

function escapeMarkdownText(value: string): string {
  return value.replace(/([\\`*_{}[\]()#+!>~])/gu, '\\$1');
}

function escapeTableCell(value: string): string {
  return value.replace(/\n+/gu, '<br>').replace(/\|/gu, '\\|').trim();
}

function renderInlineChildren(parent: Node, ctx: RenderContext = {}): string {
  return Array.from(parent.childNodes).map((node) => renderNode(node, ctx)).join('');
}

function renderBlockChildren(parent: Node, ctx: RenderContext = {}): string {
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

function normalizeMarkdownBlock(value: string): string {
  return value
    .replace(/\t+\n/gu, '\n')
    .replace(/\n[ \t]+/gu, '\n')
    .replace(/\n{3,}/gu, '\n\n')
    .trim();
}

function renderNode(node: Node, ctx: RenderContext = {}): string {
  if (node.nodeType === Node.TEXT_NODE) {
    const text = node.textContent ?? '';
    return ctx.inPre ? text.replace(/\r\n?/gu, '\n') : escapeMarkdownText(compactInlineWhitespace(text));
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return '';

  const element = node as Element;
  const tagName = element.localName;
  switch (tagName) {
    case 'h1': case 'h2': case 'h3': case 'h4': case 'h5': case 'h6': {
      const level = Number(tagName.slice(1));
      const text = normalizeMarkdownBlock(renderInlineChildren(element, ctx));
      return text.length > 0 ? `${'#'.repeat(level)} ${text}` : '';
    }
    case 'p':
    case 'div':
    case 'span':
      return renderInlineChildren(element, ctx);
    case 'br':
      return ctx.inTable ? '<br>' : '  \n';
    case 'strong':
    case 'b': {
      const text = trimInline(renderInlineChildren(element, ctx));
      return text.length > 0 ? `**${text}**` : '';
    }
    case 'em':
    case 'i': {
      const text = trimInline(renderInlineChildren(element, ctx));
      return text.length > 0 ? `*${text}*` : '';
    }
    case 's':
    case 'strike':
    case 'del': {
      const text = trimInline(renderInlineChildren(element, ctx));
      return text.length > 0 ? `~~${text}~~` : '';
    }
    case 'u':
      return renderInlineChildren(element, ctx);
    case 'a': {
      const label = trimInline(renderInlineChildren(element, ctx));
      const href = element.getAttribute('href');
      return href !== null && label.length > 0 ? `[${label}](${href.replace(/\)/gu, '%29')})` : label;
    }
    case 'code': {
      if (ctx.inPre) return element.textContent ?? '';
      return renderInlineCode(element.textContent ?? '');
    }
    case 'pre':
      return renderCodeBlock(element.textContent ?? '');
    case 'blockquote':
      return renderBlockquote(element);
    case 'ul':
      return renderList(element, false);
    case 'ol':
      return renderList(element, true);
    case 'li':
      return normalizeMarkdownBlock(renderBlockChildren(element, ctx) || renderInlineChildren(element, ctx));
    case 'table':
      return renderTable(element);
    case 'thead':
    case 'tbody':
    case 'tfoot':
    case 'tr':
    case 'th':
    case 'td':
      return renderInlineChildren(element, { ...ctx, inTable: true });
    case 'hr':
      return '---';
    case 'input':
      return '';
    default:
      return renderInlineChildren(element, ctx);
  }
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

function normalizePlainText(value: string, limits: Limits, kind: 'general' | 'pdf'): string {
  assertWithinBytes(value, limits.maxInputBytes, 'input');
  let markdown = value.replace(/\r\n?/gu, '\n').split(NULL_CHARACTER).join('');
  if (kind === 'pdf') {
    markdown = markdown.replace(/([\p{L}\p{N}])-(?:\n)(?=[\p{L}\p{N}])/gu, '$1');
  }
  markdown = markdown
    .replace(/[ \t]+$/gmu, '')
    .replace(/\n{3,}/gu, '\n\n')
    .trim();
  assertUsableMarkdown(markdown, limits);
  return markdown;
}

function assertUsableMarkdown(markdown: string, limits: Limits): void {
  if (!/\S/u.test(markdown)) {
    throw new RichPasteConversionError('Clipboard content did not contain pasteable text.');
  }
  assertWithinBytes(markdown, limits.maxOutputBytes, 'output');
}

const RTF_CP1252: Readonly<Record<number, string>> = Object.freeze({
  0x80: '€', 0x82: '‚', 0x83: 'ƒ', 0x84: '„', 0x85: '…', 0x86: '†', 0x87: '‡', 0x88: 'ˆ', 0x89: '‰', 0x8a: 'Š', 0x8b: '‹',
  0x8c: 'Œ', 0x8e: 'Ž', 0x91: '‘', 0x92: '’', 0x93: '“', 0x94: '”', 0x95: '•', 0x96: '–', 0x97: '—', 0x98: '˜', 0x99: '™',
  0x9a: 'š', 0x9b: '›', 0x9c: 'œ', 0x9e: 'ž', 0x9f: 'Ÿ',
});

function decodeRtfHexByte(hex: string): string {
  const value = Number.parseInt(hex, 16);
  if (!Number.isFinite(value) || value < 0 || value > 0xff) return '';
  const special = RTF_CP1252[value];
  if (special !== undefined) return special;
  return String.fromCharCode(value);
}

function parseRtfToPlainText(rtf: string, limits: Limits): string {
  assertWithinBytes(rtf, limits.maxInputBytes, 'input');
  let output = '';
  let index = 0;
  const stack: RtfFrame[] = [{ skip: false, ucSkip: 1 }];
  while (index < rtf.length) {
    const current = stack[stack.length - 1]!;
    const char = rtf[index]!;
    if (char === '{') {
      stack.push({ ...current });
      index += 1;
      continue;
    }
    if (char === '}') {
      if (stack.length > 1) stack.pop();
      index += 1;
      continue;
    }
    if (current.skip) {
      index += 1;
      continue;
    }
    if (char !== '\\') {
      output += char;
      index += 1;
      continue;
    }

    index += 1;
    if (index >= rtf.length) break;
    const next = rtf[index]!;
    if (next === '\\' || next === '{' || next === '}') {
      output += next;
      index += 1;
      continue;
    }
    if (next === "'") {
      const hex = rtf.slice(index + 1, index + 3);
      if (/^[0-9a-fA-F]{2}$/u.test(hex)) {
        output += decodeRtfHexByte(hex);
        index += 3;
      } else {
        index += 1;
      }
      continue;
    }
    if (next === '*') {
      current.skip = true;
      index += 1;
      continue;
    }
    if (/[a-zA-Z]/u.test(next)) {
      const start = index;
      while (index < rtf.length && /[a-zA-Z]/u.test(rtf[index]!)) index += 1;
      const word = rtf.slice(start, index).toLowerCase();
      let sign = 1;
      if (rtf[index] === '-' || rtf[index] === '+') {
        sign = rtf[index] === '-' ? -1 : 1;
        index += 1;
      }
      let digits = '';
      while (index < rtf.length && /[0-9]/u.test(rtf[index]!)) {
        digits += rtf[index]!;
        index += 1;
      }
      if (rtf[index] === ' ') index += 1;
      if (RTF_DESTINATION_WORDS.has(word)) {
        current.skip = true;
        continue;
      }
      if (word === 'par' || word === 'row') {
        output = trimRtfOutput(output) + '\n';
        continue;
      }
      if (word === 'line') {
        output = trimRtfOutput(output) + '\n';
        continue;
      }
      if (word === 'tab') {
        output += '\t';
        continue;
      }
      if (word === 'uc' && digits.length > 0) {
        current.ucSkip = Math.max(0, Number.parseInt(digits, 10));
        continue;
      }
      if (word === 'u' && digits.length > 0) {
        const codePoint = Number.parseInt(digits, 10) * sign;
        const normalized = codePoint < 0 ? 0x10000 + codePoint : codePoint;
        output += String.fromCodePoint(normalized);
        const fallbackSkip = current.ucSkip;
        for (let skipped = 0; skipped < fallbackSkip && index < rtf.length; skipped += 1) {
          if (rtf[index] === '{' || rtf[index] === '}') break;
          index += 1;
        }
        continue;
      }
      continue;
    }
    index += 1;
  }
  const cleaned = trimRtfOutput(output)
    .replace(/[ \t]+$/gmu, '')
    .replace(/\n{3,}/gu, '\n\n')
    .trim();
  assertUsableMarkdown(cleaned, limits);
  return cleaned;
}

function trimRtfOutput(value: string): string {
  return value.replace(/[ \t]+$/gmu, '');
}

export function convertRichClipboardPayload(
  payload: RichClipboardPayload,
  options?: RichPasteConversionOptions,
): RichPasteMarkdownResult {
  const limits = getLimits(options);
  let firstRichError: RichPasteConversionError | null = null;
  const html = typeof payload.html === 'string' ? payload.html : '';
  if (html.trim().length > 0) {
    try {
      const { fragment, nodeCount } = sanitizeHtml(html, limits);
      const markdown = normalizeMarkdownBlock(renderBlockChildren(fragment));
      if (markdown.length > 0) {
        assertUsableMarkdown(markdown, limits);
        return { markdown, source: 'html', formattingLoss: false, nodeCount };
      }
    } catch (error) {
      firstRichError = error instanceof RichPasteConversionError ? error : new RichPasteConversionError();
      // Try RTF and then plain text.
    }
  }

  const rtf = typeof payload.rtf === 'string' ? payload.rtf : '';
  if (rtf.trim().length > 0) {
    try {
      const markdown = parseRtfToPlainText(rtf, limits);
      return { markdown, source: 'rtf', formattingLoss: false, nodeCount: 0 };
    } catch (error) {
      firstRichError ??= error instanceof RichPasteConversionError ? error : new RichPasteConversionError();
      // Fall through to plain text.
    }
  }

  const text = typeof payload.text === 'string' ? payload.text : '';
  if (text.trim().length > 0) {
    const markdown = normalizePlainText(text, limits, payload.plainTextKind ?? 'general');
    return {
      markdown,
      source: 'text',
      formattingLoss: html.trim().length > 0 || rtf.trim().length > 0,
      nodeCount: 0,
    };
  }

  if (firstRichError) throw firstRichError;
  throw new RichPasteConversionError('Clipboard content did not contain pasteable text.');
}

export function convertRichClipboardToMarkdown(
  payload: RichClipboardPayload,
  options?: RichPasteConversionOptions,
): string {
  return convertRichClipboardPayload(payload, options).markdown;
}
