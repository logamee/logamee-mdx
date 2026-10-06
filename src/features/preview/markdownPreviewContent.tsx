import type { ReactNode } from 'react';
import { PreviewPane } from './PreviewPane';
import { WorkspaceHtmlPreview } from './WorkspaceHtmlPreview';
import JinxiuMarkdown from './JinxiuMarkdown';
import type { AppPaneSurfaceView } from './appPaneSurface';

// 共享的 Markdown/HTML 预览内容：主窗与弹出窗各自以 PreviewPane 容器包裹。
export function MarkdownPreviewContent(view: AppPaneSurfaceView): ReactNode {
  return view.activePresentation.preview === 'html' && view.activePath
    ? <WorkspaceHtmlPreview content={view.content} enabled={view.documentAssetsEnabled} path={view.activePath} />
    : <JinxiuMarkdown
      currentFilePath={view.activePath}
      documentRelativePath={view.activeWorkspaceMarkdownFile?.relative_path ?? null}
      excalidrawAssetSync={view.excalidrawAssetSync}
      localAssetsEnabled={view.documentAssetsEnabled}
      memeImagesEnabled
      workspaceRoot={view.workspaceRoot}
    >{view.content}</JinxiuMarkdown>;
}

export { PreviewPane };
