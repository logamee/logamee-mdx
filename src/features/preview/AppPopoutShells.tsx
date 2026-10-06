import type { ReactNode } from 'react';
import { FeedbackDialog } from '../feedback/FeedbackDialog';
import { PopoutPaneShell } from '../../components/PopoutPaneShell';
import { MarkdownPreviewContent, PreviewPane } from './markdownPreviewContent';
import { SettingsDialog } from '../settings/SettingsDialog';
import { WorkspaceImagePreview } from './WorkspaceImagePreview';
import { WorkspaceMediaPreview } from './WorkspaceMediaPreview';
import { ExcalidrawPane } from './previewWrappers';
import { EditorPane } from '../workspace/EditorPane';
import type { AppPaneSurfaceView } from './appPaneSurface';

function PopoutDialogs(view: AppPaneSurfaceView): ReactNode {
  const { settingsState } = view;
  return (
    <>
      {settingsState.recovery && <SettingsDialog busy={settingsState.busy} locale={view.locale} recovery={settingsState.recovery as never} onReset={settingsState.reset} onRetry={settingsState.retry} />}
      {!settingsState.recovery && view.feedbackDialog && <FeedbackDialog dialog={view.feedbackDialog} onDismiss={view.dismissFeedbackDialog} />}
    </>
  );
}

function PopoutExcalidraw(view: AppPaneSurfaceView, editable: boolean): ReactNode {
  return (
    <ExcalidrawPane
      activePath={view.activePath}
      content={view.content}
      documentEpoch={view.documentEpoch}
      documentId={view.documentId}
      editable={editable}
      loadingLabel={view.translate('loadingExcalidraw')}
      locale={view.locale}
      onContentChange={view.updateContent}
      onInvalidScene={view.handleExcalidrawError}
      popout
    />
  );
}

function PopoutMediaPreview(view: AppPaneSurfaceView): ReactNode {
  if (!view.activePath) return null;
  return view.isImageFile
    ? <WorkspaceImagePreview key={view.activePath} enabled={view.documentAssetsEnabled} path={view.activePath} popout previewRevision={view.previewRevision} />
    : <WorkspaceMediaPreview key={view.activePath} enabled={view.documentAssetsEnabled} kind={view.mediaKind} mimeType={view.mediaMimeType} path={view.activePath} popout previewRevision={view.previewRevision} />;
}

function PopoutEditorPane(view: AppPaneSurfaceView): ReactNode {
  const { editorFontSize } = view;
  return (
    <EditorPane
      activePath={view.activePath}
      content={view.content}
      documentEpoch={view.documentEpoch}
      documentId={view.documentId}
      editable={view.authorityStatus === 'committed'}
      fileKind={view.editorFileKind}
      fontSize={editorFontSize.fontSize}
      mediaInsertion={view.currentMediaInsertion}
      outlineJump={view.currentOutlineJump}
      onContentChange={view.updateContent}
      onFontSizeDecrease={editorFontSize.decrease}
      onFontSizeIncrease={editorFontSize.increase}
      onFontSizeReset={editorFontSize.reset}
      onMediaCommandPick={view.handleEditorMediaCommandPick}
      onPasteError={view.handleEditorPasteError}
      onPasteImage={view.handleClipboardImagePaste}
      popout
      spellcheckEnabled={view.settingsState.settings?.spellcheckEnabled ?? true}
    />
  );
}

function PopoutMarkdownPreview(view: AppPaneSurfaceView): ReactNode {
  return (
    <PreviewPane dirty={view.dirty} outlineJump={view.currentOutlineJump} popout>
      {MarkdownPreviewContent(view)}
    </PreviewPane>
  );
}

// 编辑器弹出窗：可编辑的 Excalidraw/编辑器或只读文档/媒体预览。
export function AppEditorPopoutShell(view: AppPaneSurfaceView): ReactNode {
  return (
    <PopoutPaneShell>
      {PopoutDialogs(view)}
      {view.isExcalidrawFile
        ? PopoutExcalidraw(view, view.authorityStatus === 'committed')
        : view.isDocumentFile
        ? <PreviewPane dirty={view.dirty} popout>{view.documentPreview}</PreviewPane>
        : (view.isImageFile || view.isMediaFile) && view.activePath
          ? PopoutMediaPreview(view)
          : PopoutEditorPane(view)}
    </PopoutPaneShell>
  );
}

// 预览弹出窗：只读呈现，Excalidraw 不可编辑。
export function AppPreviewPopoutShell(view: AppPaneSurfaceView): ReactNode {
  return (
    <PopoutPaneShell>
      {PopoutDialogs(view)}
      {view.isExcalidrawFile
        ? PopoutExcalidraw(view, false)
        : view.isDocumentFile
        ? <PreviewPane dirty={view.dirty} popout>{view.documentPreview}</PreviewPane>
        : (view.isImageFile || view.isMediaFile) && view.activePath
          ? PopoutMediaPreview(view)
          : PopoutMarkdownPreview(view)}
    </PopoutPaneShell>
  );
}
