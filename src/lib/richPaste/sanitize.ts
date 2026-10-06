
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

import DOMPurify from 'dompurify';


export interface RenderContext {
  readonly inPre?: boolean;
  readonly inTable?: boolean;
}

export interface Limits {
  readonly maxInputBytes: number;
  readonly maxSanitizedNodes: number;
  readonly maxOutputBytes: number;
}


const HTML_NAMESPACE = 'http://www.w3.org/1999/xhtml';
const ALLOWED_TAGS = Object.freeze([
  'a', 'b', 'blockquote', 'br', 'caption', 'code', 'del', 'div', 'em', 'h1', 'h2',
  'h3', 'h4', 'h5', 'h6', 'hr', 'i', 'input', 'li', 'ol', 'p', 'pre', 's', 'span',
  'strike', 'strong', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'u', 'ul',
] as const);
const ALLOWED_ATTR = Object.freeze(['checked', 'href', 'start', 'title', 'type'] as const);
export const BLOCK_TAGS = new Set(['blockquote', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'li', 'ol', 'p', 'pre', 'table', 'ul']);
export const MARKDOWN_SOURCE_WRAPPER_TAGS = new Set(['br', 'div', 'p', 'span']);
export const MARKDOWN_SOURCE_BLOCK_TAGS = new Set(['div', 'p']);
const UNSAFE_RELATIVE_PREFIX = /^(?:[a-z][a-z0-9+.-]*:|\/\/|\\|#)/iu;
const WINDOWS_ABSOLUTE_OR_TEMP = /^(?:[a-z]:[\\/]|(?:\.\.?(?:[\\/]|$))|~[\\/])/iu;
export const NULL_CHARACTER = String.fromCharCode(0);
export const RTF_DESTINATION_WORDS = new Set([
  'fonttbl', 'colortbl', 'stylesheet', 'info', 'pict', 'object', 'objectctl', 'nonshppict',
  'header', 'footer', 'headerl', 'headerr', 'headerf', 'footerl', 'footerr', 'footerf',
  'aftncn', 'aftnsep', 'aftnsepc', 'annotation', 'comment', 'generictype', 'listtable',
  'revtbl', 'themedata', 'colorschememapping', 'xmlattrname', 'xmlattrvalue', 'xmlclose',
  'xmlopen', 'shp', 'shpgrp', 'shpinst', 'do', 'datastore', 'userprops', 'latentstyles',
]);



export function getLimits(options: RichPasteConversionOptions | undefined): Limits {
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

export function assertWithinBytes(value: string, maximum: number, label: string): void {
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

export function sanitizeHtml(html: string, limits: Limits): { fragment: DocumentFragment; nodeCount: number } {
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

// 绝对链接仅允许 https（须有主机）与 mailto；其余移除 href。
function anchorHrefAllowed(parsed: URL): boolean {
  if (parsed.protocol === 'mailto:') return true;
  return parsed.protocol === 'https:' && parsed.hostname.length > 0;
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
    if (!anchorHrefAllowed(parsed)) {
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

export function compactInlineWhitespace(value: string): string {
  return value.replace(/[\t\n\f\r \u00a0]+/gu, ' ');
}

export function escapeMarkdownText(value: string): string {
  return value.replace(/([\\`*_{}[\]()#+!>~])/gu, '\\$1');
}

export function escapeTableCell(value: string): string {
  return value.replace(/\n+/gu, '<br>').replace(/\|/gu, '\\|').trim();
}
