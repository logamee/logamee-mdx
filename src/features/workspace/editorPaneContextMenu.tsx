import type { EditorView } from '@codemirror/view';
import { Bold, Code, Command, Image as ImageIcon, Italic, Link, MessageSquareWarning, Sigma, Strikethrough, Table } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Dispatch, MutableRefObject, RefObject, SetStateAction } from 'react';
import type { MouseEvent as ReactMouseEvent } from 'react';
import { useI18n, type Translate } from '../../lib/i18n';
import type { MarkdownFormatCommandId } from '../../lib/markdownFormatCommands';
import type { WorkspaceFileKind } from '../../types';
import type { EditorContextMenuInsertAction, EditorContextMenuState, EditorContextMenuItem, MarkdownFormatTarget } from './editorPaneTypes';

const EDITOR_CONTEXT_MENU_WIDTH = 224;
const EDITOR_CONTEXT_MENU_ESTIMATED_HEIGHT = 360;
const EDITOR_CONTEXT_MENU_MARGIN = 8;
const EDITOR_CONTEXT_MENU_ITEMS: readonly EditorContextMenuItem[] = [
  { command: 'bold', icon: Bold, kind: 'command', labelKey: 'contextBold' },
  { command: 'italic', icon: Italic, kind: 'command', labelKey: 'contextItalic' },
  { command: 'strikethrough', icon: Strikethrough, kind: 'command', labelKey: 'contextStrikethrough' },
  { command: 'inline-code', icon: Code, kind: 'command', labelKey: 'contextInlineCode' },
  { kind: 'separator' },
  { command: 'link', icon: Link, kind: 'command', labelKey: 'contextLink' },
  { action: 'insert-image', icon: ImageIcon, kind: 'action', labelKey: 'contextImagePlaceholder' },
  { action: 'insert-table', icon: Table, kind: 'action', labelKey: 'contextTable' },
  { command: 'code-block', icon: Code, kind: 'command', labelKey: 'contextCodeBlock' },
  { action: 'insert-formula', icon: Sigma, kind: 'action', labelKey: 'contextFormula' },
  { command: 'alert-tip', icon: MessageSquareWarning, kind: 'command', labelKey: 'contextAlertBlock' },
  { kind: 'separator' },
  { action: 'open-format-palette', icon: Command, kind: 'action', labelKey: 'contextMoreFormats' },
];

function clampContextMenuPosition(clientX: number, clientY: number): EditorContextMenuState {
  const viewportWidth = typeof window === 'undefined' ? clientX + EDITOR_CONTEXT_MENU_WIDTH : window.innerWidth;
  const viewportHeight = typeof window === 'undefined'
    ? clientY + EDITOR_CONTEXT_MENU_ESTIMATED_HEIGHT
    : window.innerHeight;
  return {
    x: Math.max(EDITOR_CONTEXT_MENU_MARGIN, Math.min(clientX, viewportWidth - EDITOR_CONTEXT_MENU_WIDTH - EDITOR_CONTEXT_MENU_MARGIN)),
    y: Math.max(EDITOR_CONTEXT_MENU_MARGIN, Math.min(clientY, viewportHeight - EDITOR_CONTEXT_MENU_ESTIMATED_HEIGHT - EDITOR_CONTEXT_MENU_MARGIN)),
  };
}

interface EditorContextMenuDeps {
  documentEpochRef: RefObject<number>;
  documentIdRef: RefObject<string>;
  editableRef: RefObject<boolean>;
  editorViewRef: RefObject<EditorView | null>;
  fileKindRef: RefObject<WorkspaceFileKind>;
  formatTargetRef: MutableRefObject<MarkdownFormatTarget | null>;
  setFormatDialogOpen: Dispatch<SetStateAction<boolean>>;
}

// 右键菜单打开：以指针坐标（空选区时换算文档位置）登记格式目标并定位菜单。
function openEditorContextMenu(event: ReactMouseEvent<HTMLDivElement>, deps: EditorContextMenuDeps, setContextMenuState: Dispatch<SetStateAction<EditorContextMenuState | null>>): void {
  const view = deps.editorViewRef.current;
  if (!view || !deps.editableRef.current || deps.fileKindRef.current !== 'markdown') return;
  event.preventDefault();
  event.stopPropagation();
  const currentSelection = view.state.selection.main;
  let selection = { from: currentSelection.from, to: currentSelection.to };
  if (currentSelection.empty) {
    const position = view.posAtCoords({ x: event.clientX, y: event.clientY });
    if (typeof position === 'number') selection = { from: position, to: position };
  }
  deps.formatTargetRef.current = {
    documentEpoch: deps.documentEpochRef.current,
    documentId: deps.documentIdRef.current,
    selection,
    source: view.state.doc.toString(),
  };
  deps.setFormatDialogOpen(false);
  setContextMenuState(clampContextMenuPosition(event.clientX, event.clientY));
}

// 编辑器右键菜单：打开/关闭状态与菜单外指针、Esc 关闭监听。
export function useEditorPaneContextMenu(deps: EditorContextMenuDeps): {
  contextMenuRef: RefObject<HTMLDivElement | null>;
  contextMenuState: EditorContextMenuState | null;
  dismissContextMenu: () => void;
  handleEditorContextMenuCapture: (event: ReactMouseEvent<HTMLDivElement>) => void;
} {
  const [contextMenuState, setContextMenuState] = useState<EditorContextMenuState | null>(null);
  const contextMenuRef = useRef<HTMLDivElement>(null);
  const dismissContextMenu = useCallback(() => {
    setContextMenuState(null);
  }, []);

  useEffect(() => {
    if (!contextMenuState) return undefined;
    const handlePointerDown = (event: PointerEvent) => {
      const menu = contextMenuRef.current;
      if (menu && event.target instanceof Node && menu.contains(event.target)) return;
      dismissContextMenu();
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      dismissContextMenu();
      deps.editorViewRef.current?.focus();
    };
    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [contextMenuState, deps.editorViewRef, dismissContextMenu]);

  const handleEditorContextMenuCapture = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
    openEditorContextMenu(event, deps, setContextMenuState);
  }, [deps]);

  return { contextMenuRef, contextMenuState, dismissContextMenu, handleEditorContextMenuCapture };
}

export function EditorContextMenuList(props: {
  contextMenuRef: RefObject<HTMLDivElement | null>;
  contextMenuState: EditorContextMenuState;
  onApplyCommand: (command: MarkdownFormatCommandId) => void;
  onApplyInsert: (action: EditorContextMenuInsertAction) => void;
  onOpenFormatPalette: () => void;
}): React.ReactNode {
  const { t } = useI18n();
  return (
    <div
      aria-label={t('editorContextMenu')}
      className="editor-context-menu"
      data-editor-context-menu="true"
      ref={props.contextMenuRef}
      role="menu"
      style={{ left: `${props.contextMenuState.x}px`, top: `${props.contextMenuState.y}px` }}
    >
      {EDITOR_CONTEXT_MENU_ITEMS.map((item, index) => contextMenuItemElement(item, index, props, t))}
    </div>
  );
}

function contextMenuItemElement(
  item: EditorContextMenuItem,
  index: number,
  handlers: {
    onApplyCommand: (command: MarkdownFormatCommandId) => void;
    onApplyInsert: (action: EditorContextMenuInsertAction) => void;
    onOpenFormatPalette: () => void;
  },
  t: Translate,
): React.ReactNode {
  if (item.kind === 'separator') {
    return <hr key={`separator-${index}`} className="editor-context-menu-separator" aria-hidden="true" />;
  }
  const Icon = item.icon;
  if (item.kind === 'command') {
    return (
      <button
        key={item.command}
        className="editor-context-menu-item"
        data-context-command-id={item.command}
        onClick={() => handlers.onApplyCommand(item.command)}
        role="menuitem"
        type="button"
      >
        <Icon aria-hidden="true" className="editor-context-menu-icon" size={14} />
        <span>{t(item.labelKey)}</span>
      </button>
    );
  }
  return (
    <button
      key={item.action}
      className="editor-context-menu-item"
      data-context-action-id={item.action}
      onClick={() => (item.action === 'open-format-palette'
        ? handlers.onOpenFormatPalette()
        : handlers.onApplyInsert(item.action))}
      role="menuitem"
      type="button"
    >
      <Icon aria-hidden="true" className="editor-context-menu-icon" size={14} />
      <span>{t(item.labelKey)}</span>
    </button>
  );
}
