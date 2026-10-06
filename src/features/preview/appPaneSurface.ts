import type { ReactNode } from 'react';
import type { DocumentAuthorityStatus } from '../../lib/documentSession';
import type { EffectiveLocale } from '../../lib/locale';
import type { FeedbackDialog } from '../../lib/appFeedback';
import type { ClipboardImagePasteRequest } from '../workspace/EditorPane';
import type { MediaEmbedCommandId } from '../../lib/markdownFormatCommands';
import type { MarkdownMediaInsertion } from '../../lib/markdownMedia';
import type { MarkdownOutlineJump } from '../../lib/markdownOutline';
import type { MarkdownOutlineItem } from '../../lib/markdownOutline';
import type { WorkspacePresentation } from '../../lib/workspaceFileKind';
import type { WorkspaceFileEntry } from '../../types';
import type { AppDialogSettingsView } from '../feedback/appDialogStackTypes';

// 主窗与弹出窗共享的文档呈现面：当前文档身份、内容、呈现标志与预览元素。
// 弹出壳组件按 pane 分支消费；documentPreview 由呈现层钩子预构建。
export interface AppPaneSurfaceView {
  activePath: string | null;
  activePresentation: WorkspacePresentation;
  activeWorkspaceMarkdownFile: WorkspaceFileEntry | null;
  authorityStatus: DocumentAuthorityStatus;
  content: string;
  currentMediaInsertion: MarkdownMediaInsertion | null;
  currentOutlineJump: MarkdownOutlineJump | null;
  dirty: boolean;
  documentAssetsEnabled: boolean;
  documentEpoch: number;
  documentId: string;
  documentPreview: ReactNode;
  editorFileKind: 'markdown' | 'html';
  editorFontSize: {
    fontSize: number;
    increase: () => void;
    decrease: () => void;
    reset: () => void;
  };
  excalidrawAssetSync: {
    resourceDirectory: string;
    resourceDirectoryToken?: string;
    workspaceRoot: string;
    workspaceToken: string;
  } | null;
  feedbackDialog: FeedbackDialog | null;
  handleClipboardImagePaste: (request: ClipboardImagePasteRequest) => Promise<string | null>;
  handleEditorMediaCommandPick: (command: MediaEmbedCommandId) => Promise<void>;
  handleEditorPasteError: (error: unknown) => void;
  handleExcalidrawError: (message: string) => void;
  isDocumentFile: boolean;
  isExcalidrawFile: boolean;
  isImageFile: boolean;
  isMediaFile: boolean;
  locale: EffectiveLocale;
  mediaKind: 'audio' | 'video';
  mediaMimeType: string;
  outlineItems: MarkdownOutlineItem[];
  previewRevision: number;
  settingsState: AppDialogSettingsView;
  translate: (key: 'loadingExcalidraw' | 'loadingPdf' | 'loadingDocx') => string;
  updateContent: (content: string) => void;
  workspaceRoot: string | null;
  dismissFeedbackDialog: () => void;
}


export interface PaneSurfaceBuildContext {
  chrome: {
    dismissFeedbackDialog: () => void;
    editorFontSize: AppPaneSurfaceView['editorFontSize'];
    excalidrawAssetSync: AppPaneSurfaceView['excalidrawAssetSync'];
    feedbackDialog: FeedbackDialog | null;
    locale: EffectiveLocale;
    settingsState: AppPaneSurfaceView['settingsState'];
    translate: AppPaneSurfaceView['translate'];
  };
  insertion: {
    currentMediaInsertion: AppPaneSurfaceView['currentMediaInsertion'];
    handleEditorMediaCommandPick: AppPaneSurfaceView['handleEditorMediaCommandPick'];
  };
  session: Parameters<typeof buildPaneSurfaceViewSessionFields>[0];
  surface: ReturnType<typeof import('./useAppDocumentSurface')['useAppDocumentSurface']>;
  outline: {
    currentOutlineJump: AppPaneSurfaceView['currentOutlineJump'];
  };
  paste: {
    handleClipboardImagePaste: AppPaneSurfaceView['handleClipboardImagePaste'];
    handleEditorPasteError: AppPaneSurfaceView['handleEditorPasteError'];
  };
}

export function buildPaneSurfaceView(ctx: PaneSurfaceBuildContext): AppPaneSurfaceView {
  const { chrome, session, surface } = ctx;
  return {
    activePath: session.activePath,
    activePresentation: surface.activePresentation,
    activeWorkspaceMarkdownFile: surface.activeWorkspaceMarkdownFile,
    authorityStatus: session.authorityStatus,
    content: session.content,
    currentMediaInsertion: ctx.insertion.currentMediaInsertion,
    currentOutlineJump: ctx.outline.currentOutlineJump,
    dirty: session.dirty,
    documentAssetsEnabled: session.authorityStatus === 'committed',
    documentEpoch: session.documentEpoch,
    documentId: session.documentId,
    documentPreview: surface.documentPreview,
    editorFileKind: surface.editorFileKind,
    editorFontSize: chrome.editorFontSize,
    excalidrawAssetSync: chrome.excalidrawAssetSync,
    feedbackDialog: chrome.feedbackDialog,
    handleClipboardImagePaste: ctx.paste.handleClipboardImagePaste,
    handleEditorMediaCommandPick: ctx.insertion.handleEditorMediaCommandPick,
    handleEditorPasteError: ctx.paste.handleEditorPasteError,
    handleExcalidrawError: surface.handleExcalidrawError,
    isDocumentFile: surface.isDocumentFile,
    isExcalidrawFile: surface.isExcalidrawFile,
    isImageFile: surface.isImageFile,
    isMediaFile: surface.isMediaFile,
    locale: chrome.locale,
    mediaKind: surface.mediaKind,
    mediaMimeType: surface.mediaMimeType,
    outlineItems: surface.outlineItems,
    previewRevision: session.previewRevision,
    settingsState: chrome.settingsState,
    translate: chrome.translate,
    updateContent: session.updateContent,
    workspaceRoot: session.workspaceRoot,
    dismissFeedbackDialog: chrome.dismissFeedbackDialog };
}

type SessionSurfaceFields = {
  activePath: string | null;
  authorityStatus: import('../../lib/documentSession').DocumentAuthorityStatus;
  content: string;
  dirty: boolean;
  documentEpoch: number;
  documentId: string;
  previewRevision: number;
  updateContent: (content: string) => void;
  workspaceRoot: string | null;
};

function buildPaneSurfaceViewSessionFields(session: SessionSurfaceFields) {
  return session;
}
