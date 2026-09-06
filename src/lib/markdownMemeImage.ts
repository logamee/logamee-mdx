/**
 * Markdown meme image marker. Authors place it in the image title:
 * `![description](url "mmd:meme")`.
 */
export const MARKDOWN_MEME_IMAGE_MARKER = 'mmd:meme';

export function isMemeMarkdownImageTitle(value: unknown): boolean {
  return typeof value === 'string'
    && value.trim().toLowerCase() === MARKDOWN_MEME_IMAGE_MARKER;
}

export const MEME_IMAGE_FALLBACK_ALT = '梗图';

export function memeImageAlt(alt: unknown): string {
  if (typeof alt !== 'string') return MEME_IMAGE_FALLBACK_ALT;
  return alt.trim() || MEME_IMAGE_FALLBACK_ALT;
}
