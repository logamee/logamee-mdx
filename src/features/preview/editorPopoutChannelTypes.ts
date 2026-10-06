import type { DocumentAuthorityStatus } from '../../lib/documentSession';
import type { EffectiveLocale } from '../../lib/locale';
import type {
  MarkdownMediaCursorInsertion,
  MarkdownMediaInsertion,
  MarkdownMediaInsertionReady } from '../../lib/markdownMedia';
import type { WorkspaceFileKind } from '../../types';
import { createMarkdownMediaRetryController } from './mediaRetry';
import type {
  PendingMarkdownMediaCursorInsertion,
  PendingMarkdownMediaInsertionHandshake } from './editorPopoutHandshakeProtocol';


type Mutable<T> = { current: T };

type MediaRetryController = ReturnType<typeof createMarkdownMediaRetryController>;

// 主窗口与编辑器弹出窗共享的通道上下文：refs 与当前文档会话快照。
// documentId/documentEpoch 为 null 时（无活动文档）处理器一律拒绝事件。
export interface EditorPopoutChannelContext {
  activeFileKind: WorkspaceFileKind;
  activePath: string | null;
  authorityStatus: DocumentAuthorityStatus;
  documentEpoch: number | null;
  documentId: string | null;
  locale: EffectiveLocale;
  popoutInstanceId: string | null;
  workspaceRoot: string | null;
  editorPopoutHandshakeRef: React.MutableRefObject<PendingMarkdownMediaInsertionHandshake | null>;
  editorPopoutOpenRef: React.RefObject<boolean>;
  editorPopoutReadyRef: React.MutableRefObject<MarkdownMediaInsertionReady | null>;
  expectedEditorPopoutInstanceIdRef: React.MutableRefObject<string | null>;
  markdownMediaRetryControllerRef: React.MutableRefObject<MediaRetryController>;
  mediaInsertionHighWaterRef: React.MutableRefObject<Map<string, number>>;
  pendingEditorPopoutReadyRequestIdRef: React.MutableRefObject<string | null>;
  pendingPopoutMediaInsertionsRef: React.MutableRefObject<PendingMarkdownMediaCursorInsertion[]>;
  popoutMediaInsertionGenerationRef: React.MutableRefObject<number>;
  setError: (message: string | null) => void;
  setNotice: (message: string | null) => void;
}

export interface EditorPopoutChannelRefs {
  editorPopoutHandshakeRef: Mutable<PendingMarkdownMediaInsertionHandshake | null>;
  editorPopoutOpenRef: Mutable<boolean>;
  editorPopoutOpenRequestRef: Mutable<Promise<void> | null>;
  editorPopoutReadyRef: Mutable<MarkdownMediaInsertionReady | null>;
  expectedEditorPopoutInstanceIdRef: Mutable<string | null>;
  markdownMediaRetryControllerRef: Mutable<ReturnType<typeof createMarkdownMediaRetryController>>;
  mediaInsertionHighWaterRef: Mutable<Map<string, number>>;
  pendingEditorPopoutReadyRequestIdRef: Mutable<string | null>;
  pendingPopoutMediaInsertionsRef: Mutable<PendingMarkdownMediaCursorInsertion[]>;
  popoutMediaInsertionTailRef: Mutable<Promise<void>>;
  popoutMediaInsertionGenerationRef: Mutable<number>;
  startEditorPopoutHandshakeRef: Mutable<((ready: MarkdownMediaInsertionReady) => void) | null>;
}

export interface EditorPopoutMediaChannelDeps {
  activeFileKind: EditorPopoutChannelContext['activeFileKind'];
  activePath: string | null;
  authorityStatus: EditorPopoutChannelContext['authorityStatus'];
  documentEpoch: number | null;
  documentId: string | null;
  editorPopoutInstanceId: string | null;
  editorPopoutOpen: boolean;
  isPopout: boolean;
  locale: EditorPopoutChannelContext['locale'];
  mountedRef: Mutable<boolean>;
  openPanePopout: (pane: 'editor', instanceId?: string) => Promise<{ status: string }>;
  popoutPane: string;
  setError: (message: string | null) => void;
  setNotice: (message: string | null) => void;
  translate: (key: 'popoutInsertionUnavailable') => string;
  workspaceRoot: string | null;
}

export interface EditorPopoutMediaChannel {
  allocateMediaInsertionRequestId: () => number;
  ctx: EditorPopoutChannelContext;
  enqueueMediaInsertion: (next: MarkdownMediaInsertion) => void;
  handleEditorPopoutOpen: () => void;
  mediaInsertion: MarkdownMediaInsertion | null;
  refs: EditorPopoutChannelRefs;
  requestEditorPopoutReady: () => void;
  sendCursorInsertionToEditorPopout: (insertion: MarkdownMediaCursorInsertion) => void;
  setMediaInsertion: (next: MarkdownMediaInsertion | null) => void;
}
