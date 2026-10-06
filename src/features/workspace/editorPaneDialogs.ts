/* eslint-disable react-hooks/exhaustive-deps -- 纯搬移：长按效果依赖保持提取前原样，由 EditorPane.test.tsx 回归约束 */
import type { EditorView } from '@codemirror/view';
import { useCallback, useEffect } from 'react';
import type { Dispatch, MutableRefObject, RefObject, SetStateAction } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import { applyMarkdownFormatCommand, type MarkdownFormatCommandId, type MediaEmbedCommandId } from '../../lib/markdownFormatCommands';
import type { WorkspaceFileKind } from '../../types';
import {
  FORMAT_PALETTE_HOLD_MS,
  FORMAT_SHORTCUT_INPUT_GUARD_MS,
  isMediaFormatCommand,
  type EditorContextMenuInsertAction,
  type EditorFileKind,
  type MarkdownFormatTarget,
} from './editorPaneTypes';

function isMarkdownFormatShortcut(event: KeyboardEvent): boolean {
  const isSlashKey = event.code === 'Slash'
    || event.code === 'NumpadDivide'
    || event.key === '/'
    || event.key === '／'
    || event.key === '?'
    || event.keyCode === 191
    || event.keyCode === 111;
  return event.ctrlKey
    && !event.altKey
    && !event.metaKey
    && isSlashKey;
}

export interface EditorFormatContext {
  dismissContextMenu: () => void;
  documentEpoch: number;
  documentId: string;
  editableRef: RefObject<boolean>;
  editorViewRef: RefObject<EditorView | null>;
  fileKindRef: RefObject<WorkspaceFileKind>;
  formatTargetRef: MutableRefObject<MarkdownFormatTarget | null>;
  onMediaCommandPick?: (command: MediaEmbedCommandId) => void;
  setFormatDialogOpen: Dispatch<SetStateAction<boolean>>;
}

// 长按左 Ctrl 打开格式面板：按住期间出现任何其他按键、松开、点击或窗口失焦
// 都会取消，避免干扰 Ctrl 组合键。
export function useFormatPaletteHold(deps: {
  editableRef: RefObject<boolean>;
  editorViewRef: RefObject<EditorView | null>;
  fileKindRef: RefObject<WorkspaceFileKind>;
  openMarkdownFormatDialogRef: RefObject<(view: EditorView) => boolean>;
}): void {
  useEffect(() => {
    let holdTimer: number | null = null;
    const cancelHold = () => {
      if (holdTimer === null) return;
      window.clearTimeout(holdTimer);
      holdTimer = null;
    };
    const isLeftControlKeyDown = (event: KeyboardEvent) => (
      event.key === 'Control' && event.code === 'ControlLeft'
      && !event.altKey && !event.metaKey && !event.shiftKey
    );
    const canOpenPalette = (view: EditorView | null): view is EditorView => (
      Boolean(view) && view!.hasFocus
      && deps.editableRef.current && deps.fileKindRef.current === 'markdown'
    );
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!isLeftControlKeyDown(event)) {
        cancelHold();
        return;
      }
      if (event.repeat || holdTimer !== null) return;
      const view = deps.editorViewRef.current;
      if (!canOpenPalette(view)) return;
      holdTimer = window.setTimeout(() => {
        holdTimer = null;
        const currentView = deps.editorViewRef.current;
        if (canOpenPalette(currentView)) deps.openMarkdownFormatDialogRef.current(currentView);
      }, FORMAT_PALETTE_HOLD_MS);
    };
    const handleKeyUp = (event: KeyboardEvent) => {
      if (event.key === 'Control') cancelHold();
    };
    window.addEventListener('keydown', handleKeyDown, true);
    window.addEventListener('keyup', handleKeyUp, true);
    window.addEventListener('pointerdown', cancelHold, true);
    window.addEventListener('blur', cancelHold);
    return () => {
      cancelHold();
      window.removeEventListener('keydown', handleKeyDown, true);
      window.removeEventListener('keyup', handleKeyUp, true);
      window.removeEventListener('pointerdown', cancelHold, true);
      window.removeEventListener('blur', cancelHold); };
  }, []);
}

// Ctrl+斜杠组合被吞掉后短暂开启输入法残留守卫。
export function useFormatShortcutGuard(
  formatShortcutGuardUntilRef: RefObject<number>,
): (event: ReactKeyboardEvent<HTMLDivElement>) => void {
  return useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!isMarkdownFormatShortcut(event.nativeEvent)) return;
    event.preventDefault();
    event.stopPropagation();
    event.nativeEvent.stopImmediatePropagation();
    formatShortcutGuardUntilRef.current = Date.now() + FORMAT_SHORTCUT_INPUT_GUARD_MS;
  }, [formatShortcutGuardUntilRef]);
}

export interface OpenMarkdownFormatDialogContext {
  documentEpoch: number;
  documentId: string;
  editableRef: RefObject<boolean>;
  fileKindRef: RefObject<WorkspaceFileKind>;
  formatTargetRef: MutableRefObject<MarkdownFormatTarget | null>;
  setFormatDialogOpen: Dispatch<SetStateAction<boolean>>;
}

export function openMarkdownFormatDialogBody(view: EditorView, ctx: OpenMarkdownFormatDialogContext): boolean {
  if (!ctx.editableRef.current || ctx.fileKindRef.current !== 'markdown') return false;
  ctx.formatTargetRef.current = {
    documentEpoch: ctx.documentEpoch,
    documentId: ctx.documentId,
    selection: {
      from: view.state.selection.main.from,
      to: view.state.selection.main.to,
    },
    source: view.state.doc.toString(),
  };
  ctx.setFormatDialogOpen(true);
  return true;
}

// 格式目标仍有效：视图存在、目标属于当前文档且源文本未变。
function currentFormatTarget(ctx: EditorFormatContext): MarkdownFormatTarget | null {
  const view = ctx.editorViewRef.current;
  const target = ctx.formatTargetRef.current;
  if (
    !view
    || !target
    || !ctx.editableRef.current
    || ctx.fileKindRef.current !== 'markdown'
    || target.documentEpoch !== ctx.documentEpoch
    || target.documentId !== ctx.documentId
    || target.source !== view.state.doc.toString()
  ) return null;
  return target;
}

export function applyFormatCommandBody(command: MarkdownFormatCommandId, ctx: EditorFormatContext): void {
  if (isMediaFormatCommand(command) && ctx.onMediaCommandPick) {
    // 媒体命令交给资源选择流程：先关面板并交还焦点，插入点取选择完成后的当前光标。
    ctx.formatTargetRef.current = null;
    ctx.setFormatDialogOpen(false);
    ctx.dismissContextMenu();
    ctx.editorViewRef.current?.focus();
    ctx.onMediaCommandPick(command);
    return;
  }
  const view = ctx.editorViewRef.current;
  const target = currentFormatTarget(ctx);
  if (!view || !target) {
    ctx.formatTargetRef.current = null;
    ctx.setFormatDialogOpen(false);
    return;
  }
  const edit = applyMarkdownFormatCommand(target.source, target.selection, command);
  view.dispatch({
    changes: { from: edit.from, insert: edit.insert, to: edit.to },
    scrollIntoView: true,
    selection: edit.selection,
  });
  ctx.formatTargetRef.current = null;
  ctx.setFormatDialogOpen(false);
  ctx.dismissContextMenu();
  view.focus();
}

function createContextInsertEdit(
  source: string,
  selection: { from: number; to: number },
  action: EditorContextMenuInsertAction,
) {
  const from = Math.max(0, Math.min(selection.from, selection.to, source.length));
  const to = Math.max(from, Math.min(Math.max(selection.from, selection.to), source.length));
  if (action === 'insert-table') {
    const insert = '| Header | Header |\n| --- | --- |\n| Cell | Cell |';
    return { from, insert, selection: { anchor: from + 2, head: from + 2 }, to };
  }
  if (action === 'insert-image') {
    const insert = '![alt text](path/to/image.png)';
    return { from, insert, selection: { anchor: from + 2, head: from + 2 }, to };
  }
  const insert = '$$\n\n$$';
  return { from, insert, selection: { anchor: from + 3, head: from + 3 }, to };
}

export function applyContextMenuInsertBody(action: EditorContextMenuInsertAction, ctx: EditorFormatContext): void {
  const view = ctx.editorViewRef.current;
  const target = currentFormatTarget(ctx);
  if (!view || !target) {
    ctx.formatTargetRef.current = null;
    ctx.dismissContextMenu();
    return;
  }
  const edit = createContextInsertEdit(target.source, target.selection, action);
  view.dispatch({
    changes: { from: edit.from, insert: edit.insert, to: edit.to },
    scrollIntoView: true,
    selection: edit.selection,
  });
  ctx.formatTargetRef.current = null;
  ctx.dismissContextMenu();
  view.focus();
}

// 面板复位：失去可编辑/Markdown 身份或外部内容变化时关闭面板与菜单。
export function useEditorFormatReset(deps: {
  content: string;
  dismissContextMenu: () => void;
  documentEpoch: number;
  documentId: string;
  editable: boolean;
  fileKind: EditorFileKind;
  formatTargetRef: MutableRefObject<MarkdownFormatTarget | null>;
  setFormatDialogOpen: Dispatch<SetStateAction<boolean>>;
}): void {
  const { content, dismissContextMenu, documentEpoch, documentId, editable, fileKind, formatTargetRef, setFormatDialogOpen } = deps;
  useEffect(() => {
    if (editable && fileKind === 'markdown') return;
    formatTargetRef.current = null;
    setFormatDialogOpen(false);
    dismissContextMenu();
  }, [dismissContextMenu, documentEpoch, documentId, editable, fileKind, formatTargetRef, setFormatDialogOpen]);

  useEffect(() => {
    formatTargetRef.current = null;
    setFormatDialogOpen(false);
    dismissContextMenu();
  }, [content, dismissContextMenu, documentEpoch, documentId, formatTargetRef, setFormatDialogOpen]);
}
