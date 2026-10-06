/* eslint-disable react-hooks/exhaustive-deps -- 纯搬移：效果依赖保持提取前原样（仅 skin/appearance/renderKey 触发重渲染），由 MermaidDiagram.test.tsx 回归约束 */
import { useEffect, useRef, useState } from 'react';
import { useObservedEffectiveTheme } from '../../../lib/themeObservation';
import { CodeBlock } from './CodeBlock';
import { MAX_MERMAID_SOURCE_LENGTH, nextMermaidDiagramId, renderMermaidDiagram } from './mermaidRender';

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

    void renderMermaidDiagram({
      code,
      container,
      isCancelled: () => cancelled,
      onFailed: () => setFailedRenderKey(renderKey),
      onRendered: () => setRenderedKey(renderKey),
      renderId,
      theme: effectiveTheme,
    });

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
