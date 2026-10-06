import { describe, expect, it } from 'vitest';
import { cutAutolinksBeforeFullwidthPunctuation } from './autolinks';

describe('autolink fullwidth punctuation cut (spec 2.3)', () => {
  it('links the URL and keeps fullwidth punctuation as literal text', () => {
    expect(cutAutolinksBeforeFullwidthPunctuation('见 https://x.cn/a。收尾')).toBe('见 [https://x.cn/a](https://x.cn/a)。收尾');
    for (const mark of ['，', '、', '；', '：', '！', '？', '）', '」', '』', '】']) {
      expect(cutAutolinksBeforeFullwidthPunctuation(`https://x.cn/a${mark}`)).toBe(`[https://x.cn/a](https://x.cn/a)${mark}`);
    }
  });
  it('covers www. autolinks', () => {
    expect(cutAutolinksBeforeFullwidthPunctuation('www.example.com）后续')).toBe('[www.example.com](www.example.com)）后续');
  });
  it('leaves URLs not followed by fullwidth punctuation untouched', () => {
    expect(cutAutolinksBeforeFullwidthPunctuation('https://x.cn/a 收尾')).toBe('https://x.cn/a 收尾');
  });
  it('leaves URLs inside inline code untouched', () => {
    expect(cutAutolinksBeforeFullwidthPunctuation('`https://x.cn/a。`')).toBe('`https://x.cn/a。`');
  });
});
