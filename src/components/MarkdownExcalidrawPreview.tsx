import { useEffect, useRef, useState } from 'react';
import { emitAppFeedbackError } from '../lib/appFeedback';
import { useI18n } from '../lib/i18n';
import { loadLazyModuleWithRetry } from '../lib/lazyModule';
import type { ExcalidrawAssetSyncOptions } from '../lib/excalidrawAssetSync';
import { readMarkdownExcalidraw } from '../lib/tauriCommands';
import { resolveWorkspaceRelativeMediaPath } from '../lib/markdownMedia';
import { useObservedEffectiveTheme } from '../lib/themeObservation';

interface MarkdownExcalidrawPreviewProps {
  currentFilePath: string | null;
  documentRelativePath?: string | null;
  enabled: boolean;
  excalidrawSrc: string;
  sync?: ExcalidrawAssetSyncOptions | null;
  title?: string;
  workspaceRoot?: string | null;
}

type ExcalidrawPreviewState =
  | { key: string; status: 'loading' }
  | { key: string; status: 'failed' }
  | { key: string; status: 'ready'; svg: SVGSVGElement };

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
  const requestKey = currentFilePath && enabled
    ? JSON.stringify([currentFilePath, excalidrawSrc, workspaceRoot, appearance])
    : null;

  useEffect(() => {
    let active = true;
    if (!currentFilePath || !requestKey) return () => {
      active = false;
    };
    setPreviewState({ key: requestKey, status: 'loading' });

    void readMarkdownExcalidraw(currentFilePath, excalidrawSrc, workspaceRoot)
      .then(async (content) => {
        if (!active) return null;
        let runtime: typeof import('../lib/excalidrawRuntime');
        try {
          runtime = await loadLazyModuleWithRetry(() => import('../lib/excalidrawRuntime'));
        } catch (cause) {
          const detail = cause instanceof Error ? cause.message : String(cause);
          throw new Error(`Failed to load Excalidraw preview module: ${detail}`);
        }
        if (!active) return null;
        try {
          if (sync && documentRelativePath && workspaceRoot) {
            const sourceRelativePath = resolveWorkspaceRelativeMediaPath(documentRelativePath, excalidrawSrc);
            if (!sourceRelativePath) throw new Error('Excalidraw source path is outside the authorized workspace.');
            try {
              const syncRuntime = await loadLazyModuleWithRetry(
                () => import('../lib/excalidrawAssetSync'),
              );
              return (await syncRuntime.renderAndSyncExcalidrawAssetPair({
                appearance,
                document: { relative_path: documentRelativePath },
                documentPath: currentFilePath,
                name: title || 'Excalidraw diagram',
                resourceDirectory: sync.resourceDirectory,
                ...(sync.resourceDirectoryToken
                  ? { resourceDirectoryToken: sync.resourceDirectoryToken }
                  : {}),
                sourceRelativePath,
                sourceContent: content,
                workspaceRoot,
                workspaceToken: sync.workspaceToken,
              })).assets.svg;
            } catch (syncCause) {
              emitAppFeedbackError(syncCause);
              throw syncCause;
            }
          }
          return await runtime.exportExcalidrawSceneSvg(content, appearance);
        } catch (cause) {
          if (cause instanceof Error && cause.message.toLowerCase().includes('excalidraw scene')) {
            throw cause;
          }
          const detail = cause instanceof Error ? cause.message : String(cause);
          throw new Error(`Excalidraw preview could not be rendered: ${detail}`);
        }
      })
      .then((svg) => {
        if (!active || !svg) return;
        svg.setAttribute('aria-hidden', 'true');
        svg.setAttribute('focusable', 'false');
        svg.querySelectorAll('a').forEach((link) => link.setAttribute('tabindex', '-1'));
        setPreviewState({ key: requestKey, status: 'ready', svg });
      })
      .catch((error: unknown) => {
        if (!active) return;
        setPreviewState({ key: requestKey, status: 'failed' });
        emitAppFeedbackError(error);
      });

    return () => {
      active = false;
    };
  }, [appearance, currentFilePath, documentRelativePath, excalidrawSrc, requestKey, sync, title, workspaceRoot]);

  const currentState = previewState?.key === requestKey ? previewState : null;
  const readySvg = currentState?.status === 'ready' ? currentState.svg : null;
  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport || !readySvg) return;
    viewport.replaceChildren(readySvg);
    return () => {
      if (readySvg.parentNode === viewport) viewport.replaceChildren();
    };
  }, [readySvg]);

  if (readySvg) {
    return (
      <>
        {/* oxlint-disable jsx-a11y/prefer-tag-over-role -- A figure is invalid inside a Markdown paragraph. */}
        <span
          ref={viewportRef}
          className="mmd-excalidraw-embed-viewport"
          role="img"
          aria-label={title || t('excalidrawPreview')}
        />
        {/* oxlint-enable jsx-a11y/prefer-tag-over-role */}
      </>
    );
  }

  const busy = requestKey !== null && currentState?.status !== 'failed';
  return (
    <output className="mmd-excalidraw-embed-status" aria-busy={busy} aria-live="polite">
      {busy ? t('loadingExcalidraw') : t('excalidrawPreviewUnavailable')}
    </output>
  );
}
