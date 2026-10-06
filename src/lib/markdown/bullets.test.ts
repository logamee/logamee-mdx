import { describe, expect, it } from 'vitest';
import { convertLeadingBulletsToListItems, splitInlineBulletPoints } from './bullets';

describe('leading bullet conversion (spec 2.1)', () => {
  it('converts the nine bullet characters followed by a space into list items', () => {
    for (const bullet of ['•', '●', '○', '◆', '◇', '■', '□', '▪', '▫']) {
      expect(convertLeadingBulletsToListItems(`${bullet} 项目`)).toBe('- 项目');
    }
  });
  it('allows up to three leading spaces and keeps deeper indentation aligned', () => {
    expect(convertLeadingBulletsToListItems('   • 缩进项')).toBe('   - 缩进项');
  });
  it('leaves bullets without a trailing space untouched', () => {
    expect(convertLeadingBulletsToListItems('•无空格')).toBe('•无空格');
  });
});

describe('inline bullet split (spec 2.2)', () => {
  it('splits a prefixed multi-point line into prefix plus list items', () => {
    expect(splitInlineBulletPoints('要点：- 甲 - 乙 - 丙')).toBe('要点：\n- 甲\n- 乙\n- 丙');
  });
  it('keeps the colon in the prefix line and supports english colons and asterisks', () => {
    expect(splitInlineBulletPoints('Note: * a * b')).toBe('Note:\n- a\n- b');
  });
  it('splits single-item lines whose content contains whitespace', () => {
    expect(splitInlineBulletPoints('注意：- 这是 一句话')).toBe('注意：\n- 这是 一句话');
  });
  it('leaves ordinary dashed prose untouched', () => {
    expect(splitInlineBulletPoints('a - b')).toBe('a - b');
    expect(splitInlineBulletPoints('范围 10-20 之间')).toBe('范围 10-20 之间');
  });
});
