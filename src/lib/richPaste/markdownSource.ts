import { RichPasteConversionError } from './sanitize';
import type { Limits } from './sanitize';
import {
  MARKDOWN_SOURCE_BLOCK_TAGS,
  MARKDOWN_SOURCE_WRAPPER_TAGS,
  NULL_CHARACTER,
  assertWithinBytes,
} from './sanitize';


export function normalizeMarkdownBlock(value: string): string {
  return value
    .replace(/\t+\n/gu, '\n')
    .replace(/\n[ \t]+/gu, '\n')
    .replace(/\n{3,}/gu, '\n\n')
    .trim();
}

function isMarkdownSourceWrapperTree(node: Node): boolean {
  for (const child of Array.from(node.childNodes)) {
    if (child.nodeType === Node.TEXT_NODE || child.nodeType === Node.COMMENT_NODE) continue;
    if (child.nodeType !== Node.ELEMENT_NODE) return false;
    const element = child as Element;
    if (!MARKDOWN_SOURCE_WRAPPER_TAGS.has(element.localName) || !isMarkdownSourceWrapperTree(element)) return false;
  }
  return true;
}

// 文本节点规范化：换行统一并折叠空白。
function normalizedSourceText(text: string | null): string {
  return (text ?? '')
    .replace(/\r\n?/gu, '\n')
    .replace(/[ \t\f\u00a0]+/gu, ' ');
}

// 块级元素正文：与前后内容以换行分隔。
function appendBlockBody(output: string, body: string): string {
  let next = output;
  if (body.length > 0 && next.length > 0 && !next.endsWith('\n')) next += '\n';
  next += body;
  if (body.length > 0 && !next.endsWith('\n')) next += '\n';
  return next;
}

function extractMarkdownSourceText(node: Node): string {
  let output = '';
  for (const child of Array.from(node.childNodes)) {
    if (child.nodeType === Node.TEXT_NODE) {
      output += normalizedSourceText(child.textContent);
      continue;
    }
    if (child.nodeType !== Node.ELEMENT_NODE) continue;

    const element = child as Element;
    if (element.localName === 'br') {
      output += '\n';
      continue;
    }

    const body = extractMarkdownSourceText(element);
    output = MARKDOWN_SOURCE_BLOCK_TAGS.has(element.localName)
      ? appendBlockBody(output, body)
      : output + body;
  }
  return output;
}

function normalizeClipboardComparisonText(value: string): string {
  return value
    .replace(/\r\n?/gu, '\n')
    .replace(/[ \t\u00a0]+/gu, ' ')
    .replace(/\n[ \t]+/gu, '\n')
    .replace(/\n{2,}/gu, '\n')
    .trim();
}

export function getMarkdownSourceText(
  fragment: DocumentFragment,
  text: string,
  limits: Limits,
  kind: 'general' | 'pdf',
): string | null {
  if (!isMarkdownSourceWrapperTree(fragment)) return null;
  const extracted = normalizeClipboardComparisonText(extractMarkdownSourceText(fragment));
  if (extracted.length === 0) return null;

  let normalizedText: string;
  try {
    normalizedText = normalizePlainText(text, limits, kind);
  } catch {
    return null;
  }
  return extracted === normalizeClipboardComparisonText(normalizedText) ? normalizedText : null;
}

export function assertUsableMarkdown(markdown: string, limits: Limits): void {
  if (!/\S/u.test(markdown)) {
    throw new RichPasteConversionError('Clipboard content did not contain pasteable text.');
  }
  assertWithinBytes(markdown, limits.maxOutputBytes, 'output');
}

export function normalizePlainText(value: string, limits: Limits, kind: 'general' | 'pdf'): string {
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
