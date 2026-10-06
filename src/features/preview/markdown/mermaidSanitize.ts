import DOMPurify from 'dompurify';

const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';

const FORBIDDEN_SVG_TAGS = [
  'a',
  'animate',
  'animateMotion',
  'animateTransform',
  'embed',
  'foreignObject',
  'iframe',
  'image',
  'object',
  'script',
  'set',
];

function hasUnsafeSvgReference(value: string): boolean {
  const lower = value.toLowerCase();
  if (/(?:@import|expression\s*\(|-moz-binding|behavior\s*:|(?:java|vb)script\s*:)/u.test(lower)) {
    return true;
  }

  for (const match of value.matchAll(/url\(\s*(['"]?)(.*?)\1\s*\)/giu)) {
    if (!match[2].trim().startsWith('#')) return true;
  }
  return false;
}

function removeUnsafeSvgAttributes(element: Element): void {
  for (const attribute of Array.from(element.attributes)) {
    const name = attribute.name.toLowerCase();
    if (name.startsWith('on')
      || name === 'href'
      || name === 'xlink:href'
      || hasUnsafeSvgReference(attribute.value)) {
      element.removeAttributeNode(attribute);
    }
  }
}

// DOMPurify 净化为 SVG 命名空间的文档片段；环境不支持或抛错时返回 null。
function sanitizeMermaidFragment(svg: string): DocumentFragment | null {
  if (typeof document === 'undefined' || DOMPurify.isSupported !== true) return null;
  try {
    return DOMPurify.sanitize(svg, {
      ALLOW_ARIA_ATTR: false,
      ALLOW_DATA_ATTR: false,
      ALLOWED_NAMESPACES: [SVG_NAMESPACE],
      FORBID_ATTR: ['href', 'xlink:href'],
      FORBID_TAGS: FORBIDDEN_SVG_TAGS,
      NAMESPACE: SVG_NAMESPACE,
      RETURN_DOM_FRAGMENT: true,
      RETURN_TRUSTED_TYPE: false,
      USE_PROFILES: { svg: true, svgFilters: false },
    });
  } catch {
    return null;
  }
}

// 根校验：恰好一个 svg 根且处于 SVG 命名空间。
function mermaidRootValid(roots: Element[]): roots is [Element] {
  return roots.length === 1
    && roots[0].localName.toLowerCase() === 'svg'
    && roots[0].namespaceURI === SVG_NAMESPACE;
}

// 根之外仅允许空白文本节点，任何多余元素都视为不可信。
function mermaidSiblingsClean(fragment: DocumentFragment, root: Element): boolean {
  for (const node of Array.from(fragment.childNodes)) {
    if (node.nodeType === Node.TEXT_NODE && /\S/u.test(node.textContent ?? '')) return false;
    if (node.nodeType === Node.ELEMENT_NODE && node !== root) return false;
  }
  return true;
}

// 逐元素剥离：非 SVG 命名空间或携带危险引用的 style 直接移除，其余去掉事件/链接属性。
function stripUnsafeSvgNodes(root: Element): void {
  for (const element of [root, ...Array.from(root.querySelectorAll('*'))]) {
    if (element.namespaceURI !== SVG_NAMESPACE) {
      element.remove();
      continue;
    }
    if (element.localName.toLowerCase() === 'style'
      && hasUnsafeSvgReference(element.textContent ?? '')) {
      element.remove();
      continue;
    }
    removeUnsafeSvgAttributes(element);
  }
}

// Mermaid SVG 净化：输入或环境不可用、结构异常都返回 null，由上层回退源码展示。
export function sanitizeMermaidSvg(svg: string): DocumentFragment | null {
  if (typeof svg !== 'string' || svg.length === 0) return null;
  const fragment = sanitizeMermaidFragment(svg);
  if (fragment === null) return null;

  const roots = Array.from(fragment.children);
  if (!mermaidRootValid(roots) || !mermaidSiblingsClean(fragment, roots[0])) {
    return null;
  }
  stripUnsafeSvgNodes(roots[0]);
  return fragment;
}
