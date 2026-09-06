import { describe, expect, it } from 'vitest';
import {
  MARKDOWN_MEME_IMAGE_MARKER,
  isMemeMarkdownImageTitle,
  memeImageAlt,
} from './markdownMemeImage';

describe('Markdown meme image marker', () => {
  it('recognizes the mmd:meme title without depending on case or surrounding whitespace', () => {
    expect(MARKDOWN_MEME_IMAGE_MARKER).toBe('mmd:meme');
    expect(isMemeMarkdownImageTitle('mmd:meme')).toBe(true);
    expect(isMemeMarkdownImageTitle('  MMD:MEME  ')).toBe(true);
    expect(isMemeMarkdownImageTitle('mmd:embed')).toBe(false);
    expect(isMemeMarkdownImageTitle(undefined)).toBe(false);
  });

  it('uses a readable fallback when the image description is empty', () => {
    expect(memeImageAlt('猫猫震惊')).toBe('猫猫震惊');
    expect(memeImageAlt('   ')).toBe('梗图');
    expect(memeImageAlt(undefined)).toBe('梗图');
  });
});
