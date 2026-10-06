import { emitAppFeedbackError } from '../../lib/appFeedback';
import { loadLazyModuleWithRetry } from '../../lib/lazyModule';
import type { ExcalidrawAssetSyncOptions } from '../../lib/excalidrawAssetSync';
import { readMarkdownExcalidraw } from '../../lib/tauriCommands';
import { resolveWorkspaceRelativeMediaPath } from '../../lib/markdownMedia';
import type { ThemeAppearance } from '../../lib/theme';

export interface MarkdownExcalidrawPreviewProps {
  currentFilePath: string | null;
  documentRelativePath?: string | null;
  enabled: boolean;
  excalidrawSrc: string;
  sync?: ExcalidrawAssetSyncOptions | null;
  title?: string;
  workspaceRoot?: string | null;
}

export type ExcalidrawPreviewState =
  | { key: string; status: 'loading' }
  | { key: string; status: 'failed' }
  | { key: string; status: 'ready'; svg: SVGSVGElement };

async function loadExcalidrawRuntime(): Promise<typeof import('../../lib/excalidrawRuntime')> {
  try {
    return await loadLazyModuleWithRetry(() => import('../../lib/excalidrawRuntime'));
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new Error(`Failed to load Excalidraw preview module: ${detail}`);
  }
}

async function syncExcalidrawAssetSvg(
  params: {
    appearance: ThemeAppearance;
    currentFilePath: string;
    documentRelativePath: string;
    excalidrawSrc: string;
    resourceDirectory: string;
    resourceDirectoryToken?: string;
    sourceContent: string;
    title: string;
    workspaceRoot: string;
    workspaceToken: string;
  },
): Promise<SVGSVGElement> {
  const sourceRelativePath = resolveWorkspaceRelativeMediaPath(
    params.documentRelativePath,
    params.excalidrawSrc,
  );
  if (!sourceRelativePath) throw new Error('Excalidraw source path is outside the authorized workspace.');
  try {
    const syncRuntime = await loadLazyModuleWithRetry(
      () => import('../../lib/excalidrawAssetSync'),
    );
    return (await syncRuntime.renderAndSyncExcalidrawAssetPair({
      appearance: params.appearance,
      document: { relative_path: params.documentRelativePath },
      documentPath: params.currentFilePath,
      name: params.title || 'Excalidraw diagram',
      resourceDirectory: params.resourceDirectory,
      ...(params.resourceDirectoryToken
        ? { resourceDirectoryToken: params.resourceDirectoryToken }
        : {}),
      sourceRelativePath,
      sourceContent: params.sourceContent,
      workspaceRoot: params.workspaceRoot,
      workspaceToken: params.workspaceToken,
    })).assets.svg;
  } catch (syncCause) {
    emitAppFeedbackError(syncCause);
    throw syncCause;
  }
}

async function exportExcalidrawSvg(
  content: string,
  appearance: ThemeAppearance,
  sync: MarkdownExcalidrawPreviewProps['sync'],
  syncContext: {
    documentRelativePath: string | null;
    workspaceRoot: string | null;
    currentFilePath: string;
    excalidrawSrc: string;
    title: string;
  },
  runtime: typeof import('../../lib/excalidrawRuntime'),
): Promise<SVGSVGElement | null> {
  try {
    if (sync && syncContext.documentRelativePath && syncContext.workspaceRoot) {
      return await syncExcalidrawAssetSvg({
        appearance,
        currentFilePath: syncContext.currentFilePath,
        documentRelativePath: syncContext.documentRelativePath,
        excalidrawSrc: syncContext.excalidrawSrc,
        resourceDirectory: sync.resourceDirectory,
        ...(sync.resourceDirectoryToken
          ? { resourceDirectoryToken: sync.resourceDirectoryToken }
          : {}),
        sourceContent: content,
        title: syncContext.title,
        workspaceRoot: syncContext.workspaceRoot,
        workspaceToken: sync.workspaceToken,
      });
    }
    return await runtime.exportExcalidrawSceneSvg(content, appearance);
  } catch (cause) {
    if (cause instanceof Error && cause.message.toLowerCase().includes('excalidraw scene')) {
      throw cause;
    }
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new Error(`Excalidraw preview could not be rendered: ${detail}`);
  }
}

export function renderExcalidrawPreviewScene(deps: {
  active: () => boolean;
  appearance: ThemeAppearance;
  currentFilePath: string;
  documentRelativePath: string | null;
  excalidrawSrc: string;
  requestKey: string;
  sync: MarkdownExcalidrawPreviewProps['sync'];
  title: string;
  workspaceRoot: string | null;
  setPreviewState: (state: ExcalidrawPreviewState) => void;
}): void {
  void readMarkdownExcalidraw(deps.currentFilePath, deps.excalidrawSrc, deps.workspaceRoot)
    .then(async (content) => {
      if (!deps.active()) return null;
      const runtime = await loadExcalidrawRuntime();
      if (!deps.active()) return null;
      return exportExcalidrawSvg(content, deps.appearance, deps.sync, {
        documentRelativePath: deps.documentRelativePath,
        workspaceRoot: deps.workspaceRoot,
        currentFilePath: deps.currentFilePath,
        excalidrawSrc: deps.excalidrawSrc,
        title: deps.title,
      }, runtime);
    })
    .then((svg) => {
      if (!deps.active() || !svg) return;
      svg.setAttribute('aria-hidden', 'true');
      svg.setAttribute('focusable', 'false');
      svg.querySelectorAll('a').forEach((link) => link.setAttribute('tabindex', '-1'));
      deps.setPreviewState({ key: deps.requestKey, status: 'ready', svg });
    })
    .catch((error: unknown) => {
      if (!deps.active()) return;
      deps.setPreviewState({ key: deps.requestKey, status: 'failed' });
      emitAppFeedbackError(error);
    });
}
