export const COMMON_MARKDOWN_FENCE_SPLIT_RE = /(```[\s\S]*?```|~~~[\s\S]*?~~~)/g;

export function applyOutsideCommonFenceBlocks(markdown: string, fn: (segment: string) => string): string {
  const parts = markdown.split(COMMON_MARKDOWN_FENCE_SPLIT_RE);
  return parts.map((seg, idx) => (idx % 2 === 1 ? seg : fn(seg))).join('');
}
