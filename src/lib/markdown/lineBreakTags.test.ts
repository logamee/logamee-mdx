import { describe, expect, it } from 'vitest';
import { convertCompleteBrTagsToHardBreaks } from './lineBreakTags';

describe('complete br tags to hard breaks (spec case 19)', () => {
  it('converts the three complete forms into hard line breaks', () => {
    expect(convertCompleteBrTagsToHardBreaks('甲<br>乙')).toBe('甲  \n乙');
    expect(convertCompleteBrTagsToHardBreaks('甲<br/>乙')).toBe('甲  \n乙');
    expect(convertCompleteBrTagsToHardBreaks('甲<br />乙')).toBe('甲  \n乙');
  });
  it('leaves attributed or unclosed br-like tags as literal text', () => {
    expect(convertCompleteBrTagsToHardBreaks('<br class="x">')).toBe('<br class="x">');
    expect(convertCompleteBrTagsToHardBreaks('<brx>')).toBe('<brx>');
  });
  it('leaves br tags inside inline code untouched', () => {
    expect(convertCompleteBrTagsToHardBreaks('`a<br>b`')).toBe('`a<br>b`');
  });
});
