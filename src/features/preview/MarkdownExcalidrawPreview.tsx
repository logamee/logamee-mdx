import { useEffect, useRef, useState } from 'react';
import { renderExcalidrawPreviewScene, type ExcalidrawPreviewState, type MarkdownExcalidrawPreviewProps } from './excalidrawPreviewPipeline';
import { useI18n } from '../../lib/i18n';
import type { ThemeAppearance } from '../../lib/theme';
import { useObservedEffectiveTheme } from '../../lib/themeObservation';


export type { ExcalidrawPreviewState, MarkdownExcalidrawPreviewProps } from './excalidrawPreviewPipeline';
function useExcalidrawPreviewScene(deps: {
  appearance: ThemeAppearance;
  currentFilePath: string | null;
  documentRelativePath: string | null;
  enabled: boolean;
  excalidrawSrc: string;
  requestKey: string | null;
  sync: MarkdownExcalidrawPreviewProps['sync'];
  title: string | undefined;
  workspaceRoot: string | null;
  setPreviewState: (state: ExcalidrawPreviewState) => void;
}): void {
  const { appearance, currentFilePath, documentRelativePath, excalidrawSrc, requestKey, sync, title, workspaceRoot, setPreviewState } = deps;
  useEffect(() => {
    let active = true;
    if (!currentFilePath || !requestKey) return () => {
      active = false;
    };
    setPreviewState({ key: requestKey, status: 'loading' });

    void renderExcalidrawPreviewScene({
      active: () => active,
      appearance,
      currentFilePath,
      documentRelativePath,
      excalidrawSrc,
      requestKey,
      sync,
      title: title ?? '',
      workspaceRoot,
      setPreviewState,
    });

    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 纯搬移：依赖数组保持提取前原样，由组件回归约束
  }, [appearance, currentFilePath, documentRelativePath, excalidrawSrc, requestKey, sync, title, workspaceRoot]);
}

function buildExcalidrawRequestKey(deps: {
  currentFilePath: string | null;
  enabled: boolean;
  excalidrawSrc: string;
  workspaceRoot: string | null;
  appearance: ThemeAppearance;
}): string | null {
  if (!deps.currentFilePath || !deps.enabled) return null;
  return JSON.stringify([deps.currentFilePath, deps.excalidrawSrc, deps.workspaceRoot, deps.appearance]);
}

function ExcalidrawPreviewStatus({
  requestKey,
  state,
  t,
}: {
  requestKey: string | null;
  state: ExcalidrawPreviewState | null;
  t: (key: 'loadingExcalidraw' | 'excalidrawPreviewUnavailable') => string;
}) {
  const busy = requestKey !== null && state?.status !== 'failed';
  return (
    <output className="mmd-excalidraw-embed-status" aria-busy={busy} aria-live="polite">
      {busy ? t('loadingExcalidraw') : t('excalidrawPreviewUnavailable')}
    </output>
  );
}

export function MarkdownExcalidrawPreview({
  currentFilePath,
  documentRelativePath = null,
  enabled,
  excalidrawSrc,
  sync = null,
  title,
  workspaceRoot = null,
}: MarkdownExcalidrawPreviewProps) {
  const { t } = useI18n();
  const { appearance } = useObservedEffectiveTheme();
  const viewportRef = useRef<HTMLSpanElement | null>(null);
  const [previewState, setPreviewState] = useState<ExcalidrawPreviewState | null>(null);
  const requestKey = buildExcalidrawRequestKey({ currentFilePath, enabled, excalidrawSrc, workspaceRoot, appearance });

  useExcalidrawPreviewScene({
    appearance,
    currentFilePath,
    documentRelativePath,
    enabled,
    excalidrawSrc,
    requestKey,
    sync,
    title,
    workspaceRoot,
    setPreviewState,
  });

  const currentState = previewState?.key === requestKey ? previewState : null;
  const readySvg = currentState?.status === 'ready' ? currentState.svg : null;
  useExcalidrawSvgViewport(viewportRef, readySvg);
  return (
    <>
      {readySvg ? (
        <ExcalidrawSvgViewportSpan viewportRef={viewportRef} title={title} label={t('excalidrawPreview')} />
      ) : (
        <ExcalidrawPreviewStatus requestKey={requestKey} state={currentState} t={t} />
      )}
    </>
  );
}

function useExcalidrawSvgViewport(
  viewportRef: React.RefObject<HTMLSpanElement | null>,
  readySvg: SVGSVGElement | null,
): void {
  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport || !readySvg) return;
    viewport.replaceChildren(readySvg);
    return () => {
      if (readySvg.parentNode === viewport) viewport.replaceChildren();
    };
  }, [readySvg, viewportRef]);
}

function ExcalidrawSvgViewportSpan({
  viewportRef,
  title,
  label,
}: {
  viewportRef: React.RefObject<HTMLSpanElement | null>;
  title: string | undefined;
  label: string;
}) {
  return (
    <>
      {/* oxlint-disable jsx-a11y/prefer-tag-over-role -- A figure is invalid inside a Markdown paragraph. */}
      <span
        ref={viewportRef}
        className="mmd-excalidraw-embed-viewport"
        role="img"
        aria-label={title || label}
      />
      {/* oxlint-enable jsx-a11y/prefer-tag-over-role */}
    </>
  );
}
