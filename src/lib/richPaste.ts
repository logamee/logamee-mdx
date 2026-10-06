import { RichPasteConversionError } from './richPaste/sanitize';
export { RichPasteConversionError, RICH_PASTE_LIMITS } from './richPaste/sanitize';
import type { RichClipboardPayload, RichPasteConversionOptions, RichPasteMarkdownResult } from './richPaste/sanitize';
export type { RichClipboardPayload, RichPasteConversionOptions, RichPasteMarkdownResult } from './richPaste/sanitize';

import type { Limits } from './richPaste/sanitize';
import {
  assertWithinBytes,
  getLimits,
  RTF_DESTINATION_WORDS,
  sanitizeHtml,
} from './richPaste/sanitize';
import { renderBlockChildren } from './richPaste/render';
import {
  assertUsableMarkdown,
  getMarkdownSourceText,
  normalizeMarkdownBlock,
  normalizePlainText,
} from './richPaste/markdownSource';


interface RtfFrame {
  skip: boolean;
  ucSkip: number;
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

function readRtfControlWord(
  rtf: string,
  startIndex: number,
): { word: string; sign: number; digits: string; nextIndex: number } {
  let index = startIndex;
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
  return { word, sign, digits, nextIndex: index };
}

function applyRtfControlWord(
  word: string,
  sign: number,
  digits: string,
  current: RtfFrame,
  output: string,
): string | null {
  if (RTF_DESTINATION_WORDS.has(word)) {
    current.skip = true;
    return output;
  }
  if (word === 'par' || word === 'row' || word === 'line') {
    return trimRtfOutput(output) + '\n';
  }
  if (word === 'tab') return output + '\t';
  if (word === 'uc' && digits.length > 0) {
    current.ucSkip = Math.max(0, Number.parseInt(digits, 10));
    return output;
  }
  return null;
}

function decodeRtfUnicodeEscape(codePoint: number): string {
  const normalized = codePoint < 0 ? 0x10000 + codePoint : codePoint;
  return String.fromCodePoint(normalized);
}

function handleRtfEscape(
  rtf: string,
  index: number,
  current: RtfFrame,
  output: string,
): { output: string; index: number } | null {
  if (index >= rtf.length) return null;
  const next = rtf[index]!;
  if (next === '\\' || next === '{' || next === '}') {
    return { output: output + next, index: index + 1 };
  }
  if (next === '\'') {
    const hex = rtf.slice(index + 1, index + 3);
    if (/^[0-9a-fA-F]{2}$/u.test(hex)) {
      return { output: output + decodeRtfHexByte(hex), index: index + 3 };
    }
    return { output, index: index + 1 };
  }
  if (next === '*') {
    current.skip = true;
    return { output, index: index + 1 };
  }
  if (/[a-zA-Z]/u.test(next)) {
    return applyRtfControlWordEscape(rtf, index, current, output);
  }
  return { output, index: index + 1 };
}

function applyRtfControlWordEscape(
  rtf: string,
  index: number,
  current: RtfFrame,
  output: string,
): { output: string; index: number } {
  const control = readRtfControlWord(rtf, index);
  const handled = applyRtfControlWord(control.word, control.sign, control.digits, current, output);
  if (handled !== null) return { output: handled, index: control.nextIndex };
  if (control.word === 'u' && control.digits.length > 0) {
    let skipIndex = control.nextIndex;
    const fallbackSkip = current.ucSkip;
    for (let skipped = 0; skipped < fallbackSkip && skipIndex < rtf.length; skipped += 1) {
      if (rtf[skipIndex] === '{' || rtf[skipIndex] === '}') break;
      skipIndex += 1;
    }
    return {
      output: output + decodeRtfUnicodeEscape(Number.parseInt(control.digits, 10) * control.sign),
      index: skipIndex,
    };
  }
  return { output, index: control.nextIndex };
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
    const escaped = handleRtfEscape(rtf, index, current, output);
    if (escaped === null) break;
    output = escaped.output;
    index = escaped.index;
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
  const text = typeof payload.text === 'string' ? payload.text : '';

  const plainTextKind = payload.plainTextKind ?? 'general';
  const htmlResult = tryConvertHtml(html, text, plainTextKind, limits);
  if (htmlResult.outcome === 'result') return htmlResult.result;
  if (htmlResult.outcome === 'error') firstRichError = htmlResult.error;

  const rtfResult = tryConvertRtf(payload.rtf, limits);
  if (rtfResult.outcome === 'result') return rtfResult.result;
  if (rtfResult.outcome === 'error') firstRichError ??= rtfResult.error;

  const rtf = typeof payload.rtf === 'string' ? payload.rtf : '';
  return finishWithPlainText(text, html, rtf, plainTextKind, limits, firstRichError);
}

function tryConvertRtf(
  rtf: string | null | undefined,
  limits: Limits,
):
  | { outcome: 'result'; result: RichPasteMarkdownResult }
  | { outcome: 'error'; error: RichPasteConversionError }
  | { outcome: 'skip' } {
  const source = typeof rtf === 'string' ? rtf : '';
  if (source.trim().length === 0) return { outcome: 'skip' };
  try {
    const markdown = parseRtfToPlainText(source, limits);
    return { outcome: 'result', result: { markdown, source: 'rtf', formattingLoss: false, nodeCount: 0 } };
  } catch (error) {
    return {
      outcome: 'error',
      error: error instanceof RichPasteConversionError ? error : new RichPasteConversionError(),
    };
  }
}

function tryConvertHtml(
  html: string,
  text: string,
  plainTextKind: 'general' | 'pdf',
  limits: Limits,
):
  | { outcome: 'result'; result: RichPasteMarkdownResult }
  | { outcome: 'error'; error: RichPasteConversionError }
  | { outcome: 'skip' } {
  if (html.trim().length === 0) return { outcome: 'skip' };
  try {
    const { fragment, nodeCount } = sanitizeHtml(html, limits);
    const markdownSource = text.trim().length > 0
      ? getMarkdownSourceText(fragment, text, limits, plainTextKind)
      : null;
    if (markdownSource !== null) {
      return { outcome: 'result', result: { markdown: markdownSource, source: 'text', formattingLoss: false, nodeCount } };
    }
    const markdown = normalizeMarkdownBlock(renderBlockChildren(fragment));
    if (markdown.length > 0) {
      assertUsableMarkdown(markdown, limits);
      return { outcome: 'result', result: { markdown, source: 'html', formattingLoss: false, nodeCount } };
    }
    return { outcome: 'skip' };
  } catch (error) {
    return {
      outcome: 'error',
      error: error instanceof RichPasteConversionError ? error : new RichPasteConversionError(),
    };
  }
}

function finishWithPlainText(
  text: string,
  html: string,
  rtf: string,
  plainTextKind: 'general' | 'pdf',
  limits: Limits,
  firstRichError: RichPasteConversionError | null,
): RichPasteMarkdownResult {
  if (text.trim().length > 0) {
    const markdown = normalizePlainText(text, limits, plainTextKind);
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
