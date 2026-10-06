/* eslint-disable react-hooks/exhaustive-deps -- 纯搬移：回调依赖数组保持提取前原样，由 EditorPane.test.tsx 回归约束 */
import type { Compartment } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import { useCallback, useRef, useState } from 'react';
import type { Dispatch, RefObject, SetStateAction } from 'react';
import { getEditorDocumentStats } from '../../lib/editorStatus';
import { useI18n } from '../../lib/i18n';
import type { WorkspaceFileKind } from '../../types';
import type { ClipboardPasteHandlerDeps } from './editorPaneClipboard';
import { useEditorPaneFormatActions } from './editorPaneActions';
import { useEditorPaneContextMenu } from './editorPaneContextMenu';
import {
  openMarkdownFormatDialogBody,
  useEditorFormatReset,
  useFormatPaletteHold,
  useFormatShortcutGuard,
} from './editorPaneDialogs';
import { useEditorViewSetup } from './editorPaneSetup';
import { useEditorAccessSync, useEditorConfigurationSync, useEditorIntentSync } from './editorPaneSync';
import type {
  EditorFileKind,
  EditorPanePropRefs,
  EditorPaneProps,
  EditorPaneViewRefs,
  EditorStatus,
  MarkdownFormatTarget,
  PendingClipboardPaste,
} from './editorPaneTypes';

// 编辑器宿主与配置镜像引用：视图、compartment 与已下发配置。
function useEditorPaneViewRefs(vimModeEnabled: boolean): EditorPaneViewRefs {
  const editorHostRef = useRef<HTMLDivElement>(null);
  const editorViewRef = useRef<EditorView | null>(null);
  const configurationCompartmentRef = useRef<Compartment | null>(null);
  const accessCompartmentRef = useRef<Compartment | null>(null);
  const vimModeCompartmentRef = useRef<Compartment | null>(null);
  const configuredFileKindRef = useRef<EditorFileKind>('markdown');
  const configuredEditorLabelRef = useRef('');
  const configuredSpellcheckEnabledRef = useRef(true);
  const configuredEditableRef = useRef(true);
  const configuredVimModeRef = useRef(vimModeEnabled);
  return {
    compartments: {
      access: accessCompartmentRef,
      configuration: configurationCompartmentRef,
      vimMode: vimModeCompartmentRef,
    },
    configured: {
      editable: configuredEditableRef,
      editorLabel: configuredEditorLabelRef,
      fileKind: configuredFileKindRef,
      spellcheckEnabled: configuredSpellcheckEnabledRef,
      vimMode: configuredVimModeRef,
    },
    editorHostRef,
    editorViewRef,
  };
}

// 属性镜像引用：让扩展与效果读取最新 props 而不重建编辑器。
function useEditorPanePropRefs(
  props: EditorPaneProps,
  resolved: { editable: boolean; fileKind: EditorFileKind; spellcheckEnabled: boolean; vimModeEnabled: boolean },
): EditorPanePropRefs {
  const { editable, fileKind, vimModeEnabled } = resolved;
  const contentRef = useRef(props.content);
  const editableRef = useRef(editable);
  const fileKindRef = useRef<WorkspaceFileKind>(fileKind);
  const vimModeEnabledRef = useRef(vimModeEnabled);
  const onContentChangeRef = useRef(props.onContentChange);
  const onPasteErrorRef = useRef(props.onPasteError);
  const onPasteImageRef = useRef(props.onPasteImage);
  const documentEpochRef = useRef(props.documentEpoch);
  const documentIdRef = useRef(props.documentId);
  const lastHandledMediaInsertionRef = useRef<string | null>(null);
  const pendingClipboardPasteRef = useRef<PendingClipboardPaste | null>(null);
  const clipboardPasteIdRef = useRef(0);
  const formatTargetRef = useRef<MarkdownFormatTarget | null>(null);
  const formatShortcutGuardUntilRef = useRef(0);
  contentRef.current = props.content;
  editableRef.current = editable;
  fileKindRef.current = fileKind;
  vimModeEnabledRef.current = vimModeEnabled;
  onContentChangeRef.current = props.onContentChange;
  onPasteErrorRef.current = props.onPasteError;
  onPasteImageRef.current = props.onPasteImage;
  documentEpochRef.current = props.documentEpoch;
  documentIdRef.current = props.documentId;
  return {
    clipboardPasteIdRef,
    contentRef,
    documentEpochRef,
    documentIdRef,
    editableRef,
    fileKindRef,
    formatShortcutGuardUntilRef,
    formatTargetRef,
    lastHandledMediaInsertionRef,
    onContentChangeRef,
    onPasteErrorRef,
    onPasteImageRef,
    pendingClipboardPasteRef,
    vimModeEnabledRef,
  };
}

function toClipboardPasteDeps(
  refs: EditorPanePropRefs,
  editorViewRef: RefObject<EditorView | null>,
): ClipboardPasteHandlerDeps {
  return {
    clipboardPasteIdRef: refs.clipboardPasteIdRef,
    documentEpochRef: refs.documentEpochRef,
    documentIdRef: refs.documentIdRef,
    editableRef: refs.editableRef,
    editorViewRef,
    fileKindRef: refs.fileKindRef,
    onPasteErrorRef: refs.onPasteErrorRef,
    onPasteImageRef: refs.onPasteImageRef,
    pendingClipboardPasteRef: refs.pendingClipboardPasteRef,
  };
}

interface EditorPaneSessionDeps {
  props: EditorPaneProps;
  resolved: { editable: boolean; editorLabel: string; fileKind: EditorFileKind; spellcheckEnabled: boolean };
  setEditorStatus: Dispatch<SetStateAction<EditorStatus>>;
  setFormatDialogOpen: Dispatch<SetStateAction<boolean>>;
  vimModeEnabled: boolean;
  view: EditorPaneViewRefs;
  prop: EditorPanePropRefs;
  dismissContextMenu: () => void;
}

// 挂载会话：格式面板入口、长按左 Ctrl 守卫与编辑器视图重建。
function useEditorPaneMountSession(deps: EditorPaneSessionDeps): void {
  const { prop, props, setEditorStatus, setFormatDialogOpen, view } = deps;
  const { documentEpoch, documentId } = props;
  const clipboardPaste = toClipboardPasteDeps(prop, view.editorViewRef);

  const openMarkdownFormatDialog = useCallback((editorView: EditorView) => openMarkdownFormatDialogBody(editorView, {
    documentEpoch,
    documentId,
    editableRef: prop.editableRef,
    fileKindRef: prop.fileKindRef,
    formatTargetRef: prop.formatTargetRef,
    setFormatDialogOpen,
  }), [documentEpoch, documentId]);
  const openMarkdownFormatDialogRef = useRef(openMarkdownFormatDialog);
  openMarkdownFormatDialogRef.current = openMarkdownFormatDialog;

  useFormatPaletteHold({
    editableRef: prop.editableRef,
    editorViewRef: view.editorViewRef,
    fileKindRef: prop.fileKindRef,
    openMarkdownFormatDialogRef,
  });

  useEditorViewSetup({
    clipboardPaste,
    compartments: view.compartments,
    configured: view.configured,
    contentRef: prop.contentRef,
    documentEpoch,
    documentId,
    editorHostRef: view.editorHostRef,
    editorViewRef: view.editorViewRef,
    formatShortcutGuardUntilRef: prop.formatShortcutGuardUntilRef,
    onContentChangeRef: prop.onContentChangeRef,
    openMarkdownFormatDialog,
    setEditorStatus,
  });
}

// 视图同步会话：可编辑/Vim/外部内容、媒体插入/大纲跳转/配置与面板复位。
function useEditorPaneViewSession(deps: EditorPaneSessionDeps): void {
  const { dismissContextMenu, prop, props, resolved, setFormatDialogOpen, view } = deps;
  const { documentEpoch, documentId } = props;
  useEditorAccessSync({
    compartments: view.compartments,
    configured: { editable: view.configured.editable, vimMode: view.configured.vimMode },
    content: props.content,
    documentEpoch,
    documentId,
    editable: resolved.editable,
    editorViewRef: view.editorViewRef,
    vimModeEnabled: deps.vimModeEnabled,
  });

  const intentSyncDeps = {
    compartments: view.compartments,
    configured: {
      editorLabel: view.configured.editorLabel,
      fileKind: view.configured.fileKind,
      spellcheckEnabled: view.configured.spellcheckEnabled,
    },
    documentEpoch,
    documentId,
    editableRef: prop.editableRef,
    editorLabel: resolved.editorLabel,
    editorViewRef: view.editorViewRef,
    fileKind: resolved.fileKind,
    fileKindRef: prop.fileKindRef,
    lastHandledMediaInsertionRef: prop.lastHandledMediaInsertionRef,
    mediaInsertion: props.mediaInsertion,
    outlineJump: props.outlineJump,
    spellcheckEnabled: resolved.spellcheckEnabled,
  };
  useEditorIntentSync(intentSyncDeps);
  useEditorConfigurationSync(intentSyncDeps);

  useEditorFormatReset({
    content: props.content,
    dismissContextMenu,
    documentEpoch,
    documentId,
    editable: resolved.editable,
    fileKind: resolved.fileKind,
    formatTargetRef: prop.formatTargetRef,
    setFormatDialogOpen,
  });
}

// EditorPane 控制器：状态、引用与效果按域组合，视图从返回对象取值。
export function useEditorPaneController(props: EditorPaneProps) {
  const { t } = useI18n();
  const { content, documentEpoch, documentId } = props;
  const editable = props.editable ?? true;
  const fileKind = props.fileKind ?? 'markdown';
  const spellcheckEnabled = props.spellcheckEnabled ?? true;
  const editorLabel = fileKind === 'html' ? t('htmlSourceEditor') : t('markdownSourceEditor');
  const [vimModeEnabled, setVimModeEnabled] = useState(false);
  const [formatDialogOpen, setFormatDialogOpen] = useState(false);
  const [editorStatus, setEditorStatus] = useState<EditorStatus>(() => ({
    ...getEditorDocumentStats(content), column: 1, line: 1,
  }));
  const view = useEditorPaneViewRefs(vimModeEnabled);
  const prop = useEditorPanePropRefs(props, { editable, fileKind, spellcheckEnabled, vimModeEnabled });
  const contextMenu = useEditorPaneContextMenu({
    documentEpochRef: prop.documentEpochRef, documentIdRef: prop.documentIdRef,
    editableRef: prop.editableRef, editorViewRef: view.editorViewRef,
    fileKindRef: prop.fileKindRef, formatTargetRef: prop.formatTargetRef, setFormatDialogOpen,
  });
  const sessionDeps: EditorPaneSessionDeps = {
    dismissContextMenu: contextMenu.dismissContextMenu,
    prop, props,
    resolved: { editable, editorLabel, fileKind, spellcheckEnabled },
    setEditorStatus, setFormatDialogOpen, view, vimModeEnabled,
  };
  useEditorPaneMountSession(sessionDeps);
  useEditorPaneViewSession(sessionDeps);
  const handleEditorKeyDownCapture = useFormatShortcutGuard(prop.formatShortcutGuardUntilRef);
  const formatActions = useEditorPaneFormatActions(props, view, prop, {
    dismissContextMenu: contextMenu.dismissContextMenu, documentEpoch, documentId, setFormatDialogOpen,
  });
  return {
    contextMenu, editorHostRef: view.editorHostRef, editorLabel, editorStatus, formatDialogOpen,
    handleEditorKeyDownCapture, setFormatDialogOpen, setVimModeEnabled, vimModeEnabled,
    ...formatActions,
  };
}
