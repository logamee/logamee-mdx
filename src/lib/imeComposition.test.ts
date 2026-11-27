import { describe, expect, it } from 'vitest';
import { isImeCompositionEscape, isImeCompositionKey } from './imeComposition';

describe('isImeCompositionKey', () => {
  it('treats any key reported during an IME composition as composing', () => {
    expect(isImeCompositionKey({ isComposing: true, keyCode: 13 })).toBe(true);
  });

  it('treats the legacy composition keyCode 229 as composing without isComposing', () => {
    expect(isImeCompositionKey({ isComposing: false, keyCode: 229 })).toBe(true);
  });

  it('lets a plain key through', () => {
    expect(isImeCompositionKey({ isComposing: false, keyCode: 13 })).toBe(false);
    expect(isImeCompositionKey({ isComposing: false, keyCode: 0 })).toBe(false);
  });
});

describe('isImeCompositionEscape', () => {
  it('treats an Escape reported during an IME composition as composing', () => {
    expect(isImeCompositionEscape({ isComposing: true, key: 'Escape', keyCode: 27 })).toBe(true);
  });

  it('treats the legacy composition keyCode 229 as composing without isComposing', () => {
    expect(isImeCompositionEscape({ isComposing: false, key: 'Escape', keyCode: 229 })).toBe(true);
  });

  it('lets a plain Escape through', () => {
    expect(isImeCompositionEscape({ isComposing: false, key: 'Escape', keyCode: 27 })).toBe(false);
    expect(isImeCompositionEscape({ isComposing: false, key: 'Escape', keyCode: 0 })).toBe(false);
  });

  it('ignores other keys even while composing', () => {
    expect(isImeCompositionEscape({ isComposing: true, key: 'Enter', keyCode: 229 })).toBe(false);
  });
});
