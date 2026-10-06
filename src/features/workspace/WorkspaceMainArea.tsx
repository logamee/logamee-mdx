import type { ComponentProps, ReactNode, Ref } from 'react';
import { FileSidebar } from './FileSidebar';
import { PaneResizer } from '../../components/PaneResizer';
import { MarkdownPreviewContent, PreviewPane } from '../preview/markdownPreviewContent';
import { WorkspaceSidebarResizer } from './WorkspaceSidebarResizer';
import { WorkspaceImagePreview } from '../preview/WorkspaceImagePreview';
import { WorkspaceMediaPreview } from '../preview/WorkspaceMediaPreview';
import { ExcalidrawPane } from '../preview/previewWrappers';
import { EditorPane } from './EditorPane';
import type { FileTreeClipboardItem } from '../../lib/fileTreeClipboard';
import type { WorkspaceEntryOperation } from './WorkspaceEntryDialog';
import type { WorkspaceMoveOperation } from './WorkspaceMoveDialog';
import type { WorkspaceFileKind } from '../../types';
import type { WorkspaceFileTreeNode } from '../../lib/fileTree';
import type { AppPaneSurfaceView } from '../preview/appPaneSurface';

export type ResizerHandlers = Pick<
  ComponentProps<typeof PaneResizer>,
  'onKeyDown' | 'onPointerCancel' | 'onPointerDown' | 'onPointerMove' | 'onPointerUp'
>;
type SidebarResizerProps = ComponentProps<typeof WorkspaceSidebarResizer>;
export type PopoutButton = ComponentProps<typeof PreviewPane>['popoutButton'];

export interface WorkspaceMainAreaView extends AppPaneSurfaceView {
  activeFileKind: WorkspaceFileKind;
  busy: boolean;
  collapsedFolders: Set<string>;
  editorPaneRatio: number;
  editorPaneRef: Ref<HTMLElement>;
  editorPopoutButton: PopoutButton;
  externalFileActionActive: boolean;
  fileTree: WorkspaceFileTreeNode[];
  fileTreeClipboard: FileTreeClipboardItem | null;
  handleEditorPopoutOpen: () => void;
  handleFileTreePaste: ComponentProps<typeof FileSidebar>['onPasteEntry'];
  handleFileTreeReveal: ComponentProps<typeof FileSidebar>['onRevealEntry'];
  fileTreeCollapsed: boolean;
  handleOpenDirectory: () => Promise<void>;
  handleOutlineItemSelect: ComponentProps<typeof FileSidebar>['onSelectOutlineItem'];
  openPreviewPopout: () => unknown;
  handleWorkspaceAssetInsert: ComponentProps<typeof FileSidebar>['onInsertWorkspaceAsset'];
  layoutClassName: string;
  layoutStyle: ComponentProps<'main'>['style'];
  moveWorkspaceEntryPath: (path: string, destinationParentPath: string) => Promise<void>;
  paneResizer: ResizerHandlers;
  pendingOpenIntentActive: boolean;
  previewPaneRef: Ref<HTMLElement>;
  previewPopoutButton: PopoutButton;
  refreshWorkspace: () => Promise<void>;
  renameWorkspaceEntryPath: (path: string, newName: string) => Promise<void>;
  requestWorkspaceFileOpen: (path: string) => void;
  setFileTreeCollapsed: (collapsed: boolean) => void;
  setFileTreeClipboard: (clipboard: FileTreeClipboardItem | null) => void;
  setWorkspaceEntryOperation: (operation: WorkspaceEntryOperation | null) => void;
  setWorkspaceMoveOperation: (operation: WorkspaceMoveOperation | null) => void;
  sidebarResizerHandlers: SidebarResizerProps;
  toggleFolder: (path: string) => void;
}

export function WorkspaceMainArea({ view }: { view: WorkspaceMainAreaView }): ReactNode {
  return (
    <main className={view.layoutClassName} style={view.layoutStyle}>
      <FileSidebarSection view={view} />
      <SidebarResizerSection view={view} />
      {DocumentArea(view) ?? EditorPreviewSplit(view)}
    </main>
  );
}

function FileSidebarSection({ view }: { view: WorkspaceMainAreaView }): ReactNode {
  const insertAllowed = view.activeFileKind === 'markdown'
    && view.authorityStatus === 'committed'
    && view.activeWorkspaceMarkdownFile;
  return (
    <FileSidebar
      activePath={view.activePath}
      collapsed={view.fileTreeCollapsed}
      collapsedFolders={view.collapsedFolders}
      disabled={view.busy || view.externalFileActionActive || view.pendingOpenIntentActive}
      fileTree={view.fileTree}
      clipboard={view.fileTreeClipboard}
      onCollapseChange={view.setFileTreeCollapsed}
      onCopyEntry={(target) => view.setFileTreeClipboard({ mode: 'copy', isFile: target.kind === 'file', path: target.path })}
      onCutEntry={(target) => view.setFileTreeClipboard({ mode: 'cut', isFile: target.kind === 'file', path: target.path })}
      onCreateFile={(parentPath, parentName, fileKind) => view.setWorkspaceEntryOperation({
        fileKind,
        kind: 'create-file',
        parentName,
        parentPath })}
      onCreateFolder={(parentPath, parentName) => view.setWorkspaceEntryOperation({ kind: 'create-folder', parentName, parentPath })}
      onDeleteEntry={(path, currentName, entryKind) => view.setWorkspaceEntryOperation({ currentName, entryKind, kind: 'delete', path })}
      onInsertWorkspaceAsset={insertAllowed ? view.handleWorkspaceAssetInsert : undefined}
      onMoveEntry={(path, destinationParentPath) => void view.moveWorkspaceEntryPath(path, destinationParentPath)}
      onOpenDirectory={() => void view.handleOpenDirectory()}
      onOpenFile={view.requestWorkspaceFileOpen}
      onPasteEntry={view.handleFileTreePaste}
      onRenameEntry={(path, newName) => void view.renameWorkspaceEntryPath(path, newName)}
      onRequestMove={(target) => view.setWorkspaceMoveOperation({
        currentName: target.name,
        entryKind: target.kind,
        path: target.path })}
      onRevealEntry={view.handleFileTreeReveal}
      onSelectOutlineItem={view.handleOutlineItemSelect}
      onRefreshWorkspace={() => void view.refreshWorkspace()}
      onToggleFolder={view.toggleFolder}
      outlineItems={view.outlineItems}
      workspaceRoot={view.workspaceRoot}
    />
  );
}

function SidebarResizerSection({ view }: { view: WorkspaceMainAreaView }): ReactNode {
  if (view.fileTreeCollapsed) return null;
  const { sidebarWidth, ...handlers } = view.sidebarResizerHandlers;
  return <WorkspaceSidebarResizer sidebarWidth={sidebarWidth} {...handlers} />;
}

function DocumentArea(view: WorkspaceMainAreaView): ReactNode {
  if (view.isExcalidrawFile) {
    return (
      <ExcalidrawPane
        activePath={view.activePath}
        content={view.content}
        documentEpoch={view.documentEpoch}
        documentId={view.documentId}
        editable={view.authorityStatus === 'committed'}
        loadingLabel={view.translate('loadingExcalidraw')}
        locale={view.locale}
        paneRef={view.editorPaneRef}
        popoutButton={view.editorPopoutButton}
        onContentChange={view.updateContent}
        onInvalidScene={view.handleExcalidrawError}
        onPopout={view.handleEditorPopoutOpen}
      />
    );
  }
  if (view.isDocumentFile) {
    return (
      <PreviewPane
        dirty={view.dirty}
        paneRef={view.previewPaneRef}
        popoutButton={view.previewPopoutButton}
        onPopout={() => void view.openPreviewPopout?.()}>
        {view.documentPreview}
      </PreviewPane>
    );
  }
  if (view.isImageFile && view.activePath) {
    return (
      <WorkspaceImagePreview
        key={view.activePath}
        enabled={view.documentAssetsEnabled}
        path={view.activePath}
        paneRef={view.previewPaneRef}
        popoutButton={view.previewPopoutButton}
        previewRevision={view.previewRevision}
        onPopout={() => void view.openPreviewPopout?.()}
      />
    );
  }
  return MediaDocumentArea(view);
}

function MediaDocumentArea(view: WorkspaceMainAreaView): ReactNode {
  if (!(view.isMediaFile && view.activePath)) return null;
  return (
    <WorkspaceMediaPreview
      key={view.activePath}
      enabled={view.documentAssetsEnabled}
      kind={view.mediaKind}
      mimeType={view.mediaMimeType}
      path={view.activePath}
      paneRef={view.previewPaneRef}
      popoutButton={view.previewPopoutButton}
      previewRevision={view.previewRevision}
      onPopout={() => void view.openPreviewPopout?.()}
    />
  );
}

function EditorPreviewSplit(view: WorkspaceMainAreaView): ReactNode {
  return (
    <>
      <EditorPaneSection view={view} />
      <PaneResizer editorPaneRatio={view.editorPaneRatio} {...view.paneResizer} />
      <MarkdownPreviewPane view={view} />
    </>
  );
}

function EditorPaneSection({ view }: { view: WorkspaceMainAreaView }): ReactNode {
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
      paneRef={view.editorPaneRef}
      popoutButton={view.editorPopoutButton}
      onContentChange={view.updateContent}
      onFontSizeDecrease={editorFontSize.decrease}
      onFontSizeIncrease={editorFontSize.increase}
      onFontSizeReset={editorFontSize.reset}
      onMediaCommandPick={view.handleEditorMediaCommandPick}
      onPasteError={view.handleEditorPasteError}
      onPasteImage={view.handleClipboardImagePaste}
      onPopout={view.handleEditorPopoutOpen}
      spellcheckEnabled={view.settingsState.settings?.spellcheckEnabled ?? true}
    />
  );
}

function MarkdownPreviewPane({ view }: { view: WorkspaceMainAreaView }): ReactNode {
  return (
    <PreviewPane
      dirty={view.dirty}
      outlineJump={view.currentOutlineJump}
      paneRef={view.previewPaneRef}
      popoutButton={view.previewPopoutButton}
      onPopout={() => void view.openPreviewPopout?.()}
    >
      {MarkdownPreviewContent(view)}
    </PreviewPane>
  );
}
