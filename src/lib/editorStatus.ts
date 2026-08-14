import { findClusterBreak } from '@codemirror/state';

export interface EditorDocumentStats {
  characters: number;
  lines: number;
  words: number;
}

const WORD_TOKEN_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]|[\p{L}\p{N}]+(?:['’_-][\p{L}\p{N}]+)*/gu;

function normalizeLineEndings(content: string): string {
  return content.replace(/\r\n?/g, '\n');
}

function countCharactersAndLines(content: string): Pick<EditorDocumentStats, 'characters' | 'lines'> {
  let characters = 0;
  let lines = 1;
  let position = 0;
  while (position < content.length) {
    const next = findClusterBreak(content, position);
    if (next <= position) break;
    if (content.charCodeAt(position) === 10) lines += 1;
    characters += 1;
    position = next;
  }
  return { characters, lines };
}

function countWordTokens(content: string): number {
  let words = 0;
  for (const _token of content.matchAll(WORD_TOKEN_RE)) words += 1;
  return words;
}

export function getEditorDocumentStats(content: string): EditorDocumentStats {
  const normalized = normalizeLineEndings(content);
  const { characters, lines } = countCharactersAndLines(normalized);
  return {
    characters,
    lines,
    words: countWordTokens(normalized),
  };
}
