import type { Element, Properties, Root } from 'hast';
import {
  isLocalMarkdownEmbedSource,
  type MarkdownEmbedContext,
} from './markdownEmbedSource';

interface RawHtmlNode {
  type: 'raw';
  value: string;
}

interface ParentNode {
  children: Array<ChildNode>;
}

type ChildNode = (Root['children'][number] | RawHtmlNode) & Partial<ParentNode>;

export function isLocalMarkdownHtmlEmbedSource(
  src: string,
  context?: MarkdownEmbedContext,
): boolean {
  return isLocalMarkdownEmbedSource(src, ['html', 'htm', 'xhtml'], context);
}

function iframeProperties(rawHtml: string): Properties | null {
  if (typeof DOMParser === 'undefined') return null;
  const document = new DOMParser().parseFromString(rawHtml.trim(), 'text/html');
  const meaningfulNodes = [...document.body.childNodes].filter((node) => (
    node.nodeType !== Node.TEXT_NODE || node.textContent?.trim()
  ));
  if (meaningfulNodes.length !== 1) return null;
  const frame = meaningfulNodes[0];
  if (!(frame instanceof HTMLElement) || frame.tagName !== 'IFRAME') return null;

  const src = frame.getAttribute('src')?.trim() ?? '';
  if (!isLocalMarkdownHtmlEmbedSource(src)) return null;

  const properties: Properties = { src };
  for (const attribute of ['title'] as const) {
    const value = frame.getAttribute(attribute)?.trim();
    if (value) properties[attribute] = value;
  }
  return properties;
}

function transformHtmlEmbeds(parent: ParentNode): void {
  parent.children = parent.children.map((child) => {
    if (child.type === 'raw') {
      const properties = iframeProperties(child.value);
      if (!properties) return child;
      return {
        type: 'element',
        tagName: 'iframe',
        properties,
        children: [],
      } satisfies Element;
    }
    if (Array.isArray(child.children)) transformHtmlEmbeds(child as ParentNode);
    return child;
  });
}

export function rehypeMarkdownHtmlEmbeds() {
  return (tree: Root) => transformHtmlEmbeds(tree as ParentNode);
}
