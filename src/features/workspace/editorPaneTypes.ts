import type { Compartment } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import type { LucideIcon } from 'lucide-react';
import type { Ref, RefObject } from 'react';
import type { MarkdownFormatCommandId, MediaEmbedCommandId } from '../../lib/markdownFormatCommands';
import type { MarkdownOutlineJump } from '../../lib/markdownOutline';
import type { MarkdownMediaInsertion } from '../../lib/markdownMedia';
import type { PanePopoutButtonState } from '../../lib/paneLayout';
import type { EditorDocumentStats } from '../../lib/editorStatus';
import type { WorkspaceFileKind } from '../../types';
import type { RichPasteConversionError } from '../../lib/richPaste';

export interface EditorPaneProps {
  activePath: string | null;
  content: string;
  documentEpoch: number;
  documentId: string;
  editable?: boolean;
  fileKind?: Extract<WorkspaceFileKind, 'markdown' | 'html'>;
  fontSize?: number;
  mediaInsertion?: MarkdownMediaInsertion | null;
  onContentChange: (content: string) => void;
  onFontSizeDecrease?: () => void;
  onFontSizeIncrease?: () => void;
  onFontSizeReset?: () => void;
  // 媒体命令（图片/视频/梗图/HTML 嵌入）改走系统资源选择器；未提供时退回占位文本。
  onMediaCommandPick?: (command: MediaEmbedCommandId) => void;
  onPasteError?: (error: unknown) => void;
  onPasteImage?: (request: ClipboardImagePasteRequest) => Promise<string | null>;
  outlineJump?: MarkdownOutlineJump | null;
  onPopout?: () => void;
  paneRef?: Ref<HTMLElement>;
  popoutButton?: PanePopoutButtonState;
  popout?: boolean;
  spellcheckEnabled?: boolean;
}

export interface ClipboardImagePasteRequest {
  blob: Blob;
  documentEpoch: number;
  documentId: string;
  mimeType: string;
  suggestedName: string | null;
}

export interface EditorStatus extends EditorDocumentStats {
  column: number;
  line: number;
}

export interface MarkdownFormatTarget {
  documentEpoch: number;
  documentId: string;
  selection: { from: number; to: number };
  source: string;
}

export interface PendingClipboardPaste {
  documentEpoch: number;
  documentId: string;
  from: number;
  id: number;
  to: number;
}

export interface ClipboardPasteImageFile {
  blob: File;
  mimeType: string;
  suggestedName: string | null;
}

export type ClipboardImageCollection = {
  images: ClipboardPasteImageFile[];
  rejection: RichPasteConversionError | null;
};

export interface EditorContextMenuState {
  x: number;
  y: number;
}

export type EditorContextMenuInsertAction = 'insert-table' | 'insert-image' | 'insert-formula';

export type EditorFileKind = Extract<WorkspaceFileKind, 'markdown' | 'html'>;

export interface EditorPaneViewRefs {
  compartments: {
    access: RefObject<Compartment | null>;
    configuration: RefObject<Compartment | null>;
    vimMode: RefObject<Compartment | null>;
  };
  configured: {
    editable: { current: boolean };
    editorLabel: { current: string };
    fileKind: { current: EditorFileKind };
    spellcheckEnabled: { current: boolean };
    vimMode: { current: boolean };
  };
  editorHostRef: RefObject<HTMLDivElement | null>;
  editorViewRef: RefObject<EditorView | null>;
}

export interface EditorPanePropRefs {
  clipboardPasteIdRef: { current: number };
  contentRef: { current: string };
  documentEpochRef: { current: number };
  documentIdRef: { current: string };
  editableRef: { current: boolean };
  fileKindRef: { current: WorkspaceFileKind };
  formatShortcutGuardUntilRef: { current: number };
  formatTargetRef: { current: MarkdownFormatTarget | null };
  lastHandledMediaInsertionRef: { current: string | null };
  onContentChangeRef: { current: (content: string) => void };
  onPasteErrorRef: { current: ((error: unknown) => void) | undefined };
  onPasteImageRef: { current: ((request: ClipboardImagePasteRequest) => Promise<string | null>) | undefined };
  pendingClipboardPasteRef: { current: PendingClipboardPaste | null };
  vimModeEnabledRef: { current: boolean };
}

export type EditorContextMenuItem =
  | {
    command: MarkdownFormatCommandId;
    icon: LucideIcon;
    kind: 'command';
    label: string;
  }
  | {
    action: EditorContextMenuInsertAction | 'open-format-palette';
    icon: LucideIcon;
    kind: 'action';
    label: string;
  }
  | { kind: 'separator' };

export type DeferredDocumentStatsTask = {
  id: number;
  kind: 'debounce' | 'idle';
} | null;

// 格式面板快捷键是长按左 Ctrl：避免斜杠组合在 macOS WKWebView 下被中文输入法
// 绕过 preventDefault 把 '/' 或全角 '／' 提交进编辑器。Ctrl 加斜杠组合不再打开
// 面板，仅被吞掉；吞掉后的短时间内仅插入斜杠（含全角）的事务视为输入法残留并
// 直接丢弃。
export const FORMAT_PALETTE_HOLD_MS = 600;
export const FORMAT_SHORTCUT_INPUT_GUARD_MS = 400;
export const FORMAT_SHORTCUT_COMMIT_SLASH_PATTERN = /^[/／?？]{1,2}$/;

export const DOCUMENT_STATS_DEBOUNCE_MS = 120;
export const DOCUMENT_STATS_IDLE_TIMEOUT_MS = 250;

export const RICH_PASTE_FORMATTING_LOSS_MESSAGE = 'Clipboard content was pasted as cleaned plain text because rich formatting could not be converted safely.';
export const CLIPBOARD_IMAGE_REJECTION_MESSAGE = 'One or more clipboard images could not be pasted safely. SVG clipboard images and images over 16 MiB are not accepted.';
export const CLIPBOARD_IMAGE_UNAVAILABLE_MESSAGE = 'Clipboard images could not be pasted into this document.';

export function isMediaFormatCommand(command: MarkdownFormatCommandId): command is MediaEmbedCommandId {
  return command === 'image'
    || command === 'video'
    || command === 'meme'
    || command === 'html-embed';
}
