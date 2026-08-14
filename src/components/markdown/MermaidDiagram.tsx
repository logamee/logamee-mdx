import DOMPurify from 'dompurify';
import { useEffect, useRef, useState } from 'react';
import type { Mermaid, MermaidConfig } from 'mermaid';
import { getMermaidThemeConfig } from '../../lib/mermaidTheme';
import { useObservedEffectiveTheme } from '../../lib/themeObservation';
import { CodeBlock } from './CodeBlock';

const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';
const MAX_MERMAID_SOURCE_LENGTH = 50_000;
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

export const MERMAID_CONFIG = {
  flowchart: { htmlLabels: false },
  htmlLabels: false,
  logLevel: 'fatal',
  maxEdges: 500,
  maxTextSize: MAX_MERMAID_SOURCE_LENGTH,
  securityLevel: 'strict',
  secure: [
    'secure',
    'securityLevel',
    'startOnLoad',
    'maxTextSize',
    'maxEdges',
    'htmlLabels',
    'flowchart',
    'theme',
    'themeCSS',
    'themeVariables',
  ],
  startOnLoad: false,
} satisfies MermaidConfig;

let nextDiagramId = 0;

interface MermaidRenderJob {
  readonly run: () => Promise<string>;
  readonly resolve: (svg: string) => void;
  readonly reject: (error: unknown) => void;
}

const mermaidRenderJobs: MermaidRenderJob[] = [];
let mermaidRenderActive = false;

function nextMermaidDiagramId(): string {
  nextDiagramId += 1;
  return `mmd-mermaid-${nextDiagramId}`;
}

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

export function sanitizeMermaidSvg(svg: string): DocumentFragment | null {
  if (typeof document === 'undefined'
    || typeof svg !== 'string'
    || svg.length === 0
    || DOMPurify.isSupported !== true) {
    return null;
  }

  let fragment: DocumentFragment;
  try {
    fragment = DOMPurify.sanitize(svg, {
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

  const roots = Array.from(fragment.children);
  if (roots.length !== 1
    || roots[0].localName.toLowerCase() !== 'svg'
    || roots[0].namespaceURI !== SVG_NAMESPACE) {
    return null;
  }

  for (const node of Array.from(fragment.childNodes)) {
    if (node.nodeType === Node.TEXT_NODE && /\S/u.test(node.textContent ?? '')) return null;
    if (node.nodeType === Node.ELEMENT_NODE && node !== roots[0]) return null;
  }

  for (const element of [roots[0], ...Array.from(roots[0].querySelectorAll('*'))]) {
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

  return fragment;
}

function getMermaidApi(module: typeof import('mermaid')): Pick<Mermaid, 'initialize' | 'render'> {
  return module.default;
}

let mermaidApiPromise: Promise<Pick<Mermaid, 'initialize' | 'render'>> | null = null;

function loadMermaidApi(): Promise<Pick<Mermaid, 'initialize' | 'render'>> {
  mermaidApiPromise ??= import('mermaid').then(getMermaidApi);
  return mermaidApiPromise;
}

function renderMermaid(
  mermaid: Pick<Mermaid, 'initialize' | 'render'>,
  config: MermaidConfig,
  renderId: string,
  code: string,
): Promise<string> {
  const result = new Promise<string>((resolve, reject) => {
    mermaidRenderJobs.push({
      reject,
      resolve,
      run: async () => {
        mermaid.initialize(config);
        const rendered = await mermaid.render(renderId, code);
        return rendered.svg;
      },
    });
  });
  if (!mermaidRenderActive) {
    mermaidRenderActive = true;
    void (async () => {
      while (mermaidRenderJobs.length > 0) {
        const job = mermaidRenderJobs.shift();
        if (!job) continue;
        try {
          job.resolve(await job.run());
        } catch (error) {
          job.reject(error);
        }
      }
      mermaidRenderActive = false;
    })();
  }
  return result;
}

interface MermaidDiagramProps {
  code: string;
}

export function MermaidDiagram({ code }: MermaidDiagramProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const effectiveTheme = useObservedEffectiveTheme();
  const renderKey = `${code}\u0000${effectiveTheme.skin}\u0000${effectiveTheme.appearance}\u0000${effectiveTheme.revision}`;
  const [failedRenderKey, setFailedRenderKey] = useState<string | null>(null);
  const [renderedKey, setRenderedKey] = useState<string | null>(null);
  const failed = failedRenderKey === renderKey;

  useEffect(() => {
    if (failed || code.length > MAX_MERMAID_SOURCE_LENGTH) {
      if (code.length > MAX_MERMAID_SOURCE_LENGTH) setFailedRenderKey(renderKey);
      return undefined;
    }

    const container = containerRef.current;
    if (!container) return undefined;
    const renderId = nextMermaidDiagramId();
    let cancelled = false;
    container.replaceChildren();

    void (async () => {
      try {
        const mermaid = await loadMermaidApi();
        if (cancelled) return;

        const svg = await renderMermaid(mermaid, {
          ...MERMAID_CONFIG,
          ...getMermaidThemeConfig(effectiveTheme.skin, effectiveTheme.appearance),
        }, renderId, code);
        if (cancelled) return;

        const fragment = sanitizeMermaidSvg(svg);
        if (fragment === null) throw new Error('Mermaid returned an unsafe SVG.');

        container.replaceChildren(fragment);
        setRenderedKey(renderKey);
      } catch {
        if (!cancelled) setFailedRenderKey(renderKey);
      }
    })();

    return () => {
      cancelled = true;
      container.replaceChildren();
    };
  }, [code, effectiveTheme.appearance, effectiveTheme.skin, failed, renderKey]);

  if (failed) return <CodeBlock code={code} language="mermaid" />;

  return (
    <div
      aria-busy={renderedKey !== renderKey}
      className="mmd-mermaid-diagram"
      key={code}
      ref={containerRef}
    />
  );
}
