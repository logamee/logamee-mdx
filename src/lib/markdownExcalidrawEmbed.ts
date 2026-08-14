import {
  isLocalMarkdownEmbedSource,
  type MarkdownEmbedContext,
} from './markdownEmbedSource';

export function isLocalMarkdownExcalidrawEmbedSource(
  src: string,
  context?: MarkdownEmbedContext,
): boolean {
  return isLocalMarkdownEmbedSource(src, ['excalidraw'], context);
}
