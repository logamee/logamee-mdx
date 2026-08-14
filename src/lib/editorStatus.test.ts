import { describe, expect, it } from 'vitest';
import { getEditorDocumentStats } from './editorStatus';

describe('editor document status', () => {
  it('keeps an empty document on its first source line', () => {
    expect(getEditorDocumentStats('')).toEqual({
      characters: 0,
      lines: 1,
      words: 0,
    });
  });

  it('counts CJK characters, word-like tokens, source characters, and lines', () => {
    expect(getEditorDocumentStats('你好 world\n🌟')).toEqual({
      characters: 10,
      lines: 2,
      words: 3,
    });
  });

  it('normalizes line endings and preserves grapheme clusters', () => {
    expect(getEditorDocumentStats('\r\nA👩‍💻\r\n')).toEqual({
      characters: 4,
      lines: 3,
      words: 1,
    });
  });
});
