import DOMPurify from 'dompurify';
import { getRegisteredImages } from './docxImageRegistry';
import { DocxSanitizationError } from './docxSanitizerErrors';
export { DocxSanitizationError } from './docxSanitizerErrors';
import { DOCX_PREVIEW_LIMITS, type DocxImageResource } from './docxResources';

export const DOCX_ALLOWED_TAGS = Object.freeze([
  'a', 'b', 'blockquote', 'br', 'caption', 'code', 'em', 'h1', 'h2', 'h3', 'h4',
  'h5', 'h6', 'hr', 'i', 'img', 'li', 'ol', 'p', 'pre', 's', 'strong', 'sub',
  'sup', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'u', 'ul',
] as const);

export const DOCX_ALLOWED_ATTRIBUTES = Object.freeze([
  'alt', 'colspan', 'height', 'href', 'rowspan', 'scope', 'src', 'start', 'title',
  'width',
] as const);

const DOCX_ALLOWED_ATTRIBUTES_BY_TAG = Object.freeze({
  a: new Set(['href', 'title']),
  img: new Set(['src', 'alt', 'title', 'width', 'height']),
  ol: new Set(['start']),
  td: new Set(['colspan', 'rowspan', 'scope']),
  th: new Set(['colspan', 'rowspan', 'scope']),
} satisfies Partial<Record<typeof DOCX_ALLOWED_TAGS[number], ReadonlySet<string>>>);

export interface SanitizedDocxHtml {
  readonly html: string;
  readonly nodeCount: number;
}

export interface DocxSanitizationOptions {
  readonly maxSanitizedNodes?: number;
}

const HTML_NAMESPACE = 'http://www.w3.org/1999/xhtml';
const DOMPURIFY_ALLOWED_ATTRIBUTE_VALUE_PATTERN = /^\s*(?:https:|mailto:|[+-]?[0-9]+\s*$|(?:col|colgroup|row|rowgroup)\s*$)/i;
const ALLOWED_TAG_SET: ReadonlySet<string> = new Set(DOCX_ALLOWED_TAGS);
const DECIMAL_INTEGER_PATTERN = /^[+-]?[0-9]+$/;
const TABLE_SCOPE_VALUES: ReadonlySet<string> = new Set([
  'col', 'colgroup', 'row', 'rowgroup',
]);

function getUtf8ByteLength(value: string): number {
  if (value.length > DOCX_PREVIEW_LIMITS.maxHtmlBytes) return value.length;
  return new TextEncoder().encode(value).byteLength;
}

function countNodes(root: DocumentFragment, maximum: number): number {
  const nodeFilter = root.ownerDocument.defaultView?.NodeFilter;
  const walker = root.ownerDocument.createTreeWalker(root, nodeFilter?.SHOW_ALL ?? 0xffffffff);
  let count = 0;
  while (walker.nextNode() !== null) {
    count += 1;
    if (count > maximum) {
      throw new DocxSanitizationError('The DOCX preview is too complex to display safely.');
    }
  }
  return count;
}

function getSanitizedNodeLimit(options: DocxSanitizationOptions | undefined): number {
  const maximum = options?.maxSanitizedNodes ?? DOCX_PREVIEW_LIMITS.maxSanitizedNodes;
  if (!Number.isSafeInteger(maximum)
    || maximum < 1
    || maximum > DOCX_PREVIEW_LIMITS.maxSanitizedNodes) {
    throw new DocxSanitizationError('The DOCX preview node limit is invalid.');
  }
  return maximum;
}

function normalizeAnchorHref(anchor: Element): void {
  const rawHref = anchor.getAttribute('href');
  if (rawHref === null) return;

  try {
    const normalized = new URL(rawHref);
    if (normalized.protocol !== 'https:' && normalized.protocol !== 'mailto:') {
      anchor.removeAttribute('href');
      return;
    }
    if (normalized.protocol === 'https:' && normalized.hostname.length === 0) {
      anchor.removeAttribute('href');
      return;
    }
    anchor.setAttribute('href', normalized.href);
  } catch {
    anchor.removeAttribute('href');
  }
}

function enforceTagAttributes(element: Element): void {
  const tagName = element.localName;
  const allowedAttributes = DOCX_ALLOWED_ATTRIBUTES_BY_TAG[
    tagName as keyof typeof DOCX_ALLOWED_ATTRIBUTES_BY_TAG
  ];

  for (const attribute of Array.from(element.attributes)) {
    if (allowedAttributes?.has(attribute.name) !== true || attribute.namespaceURI !== null) {
      element.removeAttributeNode(attribute);
    }
  }
}

function normalizeIntegerAttribute(
  element: Element,
  name: string,
  minimum: number,
  maximum: number,
): void {
  const rawValue = element.getAttribute(name);
  if (rawValue === null) return;

  const trimmedValue = rawValue.trim();
  if (!DECIMAL_INTEGER_PATTERN.test(trimmedValue)) {
    element.removeAttribute(name);
    return;
  }

  const value = Number(trimmedValue);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    element.removeAttribute(name);
    return;
  }
  element.setAttribute(name, String(value));
}

function normalizeLayoutAttributes(element: Element): void {
  if (element.localName === 'img') {
    normalizeIntegerAttribute(element, 'width', 1, DOCX_PREVIEW_LIMITS.maxImagePixels);
    normalizeIntegerAttribute(element, 'height', 1, DOCX_PREVIEW_LIMITS.maxImagePixels);
  } else if (element.localName === 'ol') {
    normalizeIntegerAttribute(
      element,
      'start',
      -DOCX_PREVIEW_LIMITS.maxSanitizedNodes,
      DOCX_PREVIEW_LIMITS.maxSanitizedNodes,
    );
  } else if (element.localName === 'th' || element.localName === 'td') {
    normalizeIntegerAttribute(element, 'colspan', 1, 1_000);
    normalizeIntegerAttribute(
      element,
      'rowspan',
      1,
      DOCX_PREVIEW_LIMITS.maxSanitizedNodes,
    );

    const scope = element.getAttribute('scope');
    if (scope !== null) {
      const normalizedScope = scope.trim().toLowerCase();
      if (TABLE_SCOPE_VALUES.has(normalizedScope)) {
        element.setAttribute('scope', normalizedScope);
      } else {
        element.removeAttribute('scope');
      }
    }
  }
}

function applyOutputPolicy(
  fragment: DocumentFragment,
  registeredImages: ReadonlyMap<string, DocxImageResource>,
): void {
  for (const element of Array.from(fragment.querySelectorAll('*'))) {
    if (element.namespaceURI !== HTML_NAMESPACE || !ALLOWED_TAG_SET.has(element.localName)) {
      element.remove();
      continue;
    }

    enforceTagAttributes(element);
    normalizeLayoutAttributes(element);
    if (element.localName === 'a') {
      normalizeAnchorHref(element);
    } else if (element.localName === 'img') {
      const source = element.getAttribute('src');
      const image = source === null ? undefined : registeredImages.get(source);
      if (image === undefined) {
        element.remove();
      } else {
        element.setAttribute('src', `data:${image.mimeType};base64,${image.bytesBase64}`);
      }
    }
  }
}

function hasUsableOutput(fragment: DocumentFragment): boolean {
  return /\S/u.test(fragment.textContent ?? '')
    || fragment.querySelector('img, table') !== null;
}

function serializeFragment(fragment: DocumentFragment): string {
  const template = fragment.ownerDocument.createElement('template');
  template.content.append(fragment);
  return template.innerHTML;
}

export function sanitizeDocxHtml(
  rawHtml: string,
  images: readonly DocxImageResource[],
  options?: DocxSanitizationOptions,
): SanitizedDocxHtml {
  if (typeof rawHtml !== 'string'
    || getUtf8ByteLength(rawHtml) > DOCX_PREVIEW_LIMITS.maxHtmlBytes) {
    throw new DocxSanitizationError('The DOCX preview is too large to display safely.');
  }
  if (DOMPurify.isSupported !== true) throw new DocxSanitizationError();

  const maximumNodes = getSanitizedNodeLimit(options);
  const registeredImages = getRegisteredImages(images);
  let fragment: DocumentFragment;
  try {
    fragment = DOMPurify.sanitize(rawHtml, {
      ALLOWED_TAGS: Array.from(DOCX_ALLOWED_TAGS),
      ALLOWED_ATTR: Array.from(DOCX_ALLOWED_ATTRIBUTES),
      ALLOWED_NAMESPACES: [HTML_NAMESPACE],
      NAMESPACE: HTML_NAMESPACE,
      ALLOWED_URI_REGEXP: DOMPURIFY_ALLOWED_ATTRIBUTE_VALUE_PATTERN,
      ALLOW_ARIA_ATTR: false,
      ALLOW_DATA_ATTR: false,
      ALLOW_UNKNOWN_PROTOCOLS: false,
      CUSTOM_ELEMENT_HANDLING: {
        tagNameCheck: null,
        attributeNameCheck: null,
        allowCustomizedBuiltInElements: false,
      },
      PARSER_MEDIA_TYPE: 'text/html',
      RETURN_DOM_FRAGMENT: true,
      RETURN_TRUSTED_TYPE: false,
    });
  } catch {
    throw new DocxSanitizationError();
  }

  countNodes(fragment, maximumNodes);
  applyOutputPolicy(fragment, registeredImages);
  if (!hasUsableOutput(fragment)) throw new DocxSanitizationError();

  const nodeCount = countNodes(fragment, maximumNodes);
  return {
    html: serializeFragment(fragment),
    nodeCount,
  };
}
