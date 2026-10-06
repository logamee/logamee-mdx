import type { Dispatch, SetStateAction } from 'react';
import type { MarkdownFormatCommandId } from '../../lib/markdownFormatCommands';
import {
  applyContextMenuInsertBody,
  applyFormatCommandBody,
  type EditorFormatContext,
} from './editorPaneDialogs';
import type {
  EditorContextMenuInsertAction,
  EditorPanePropRefs,
  EditorPaneProps,
  EditorPaneViewRefs,
} from './editorPaneTypes';

// 格式命令动作：右键菜单与格式面板共用的目标校验与分发。
export function useEditorPaneFormatActions(
  props: EditorPaneProps,
  view: EditorPaneViewRefs,
  prop: EditorPanePropRefs,
  ui: {
    dismissContextMenu: () => void;
    documentEpoch: number;
    documentId: string;
    setFormatDialogOpen: Dispatch<SetStateAction<boolean>>;
  },
) {
  const { dismissContextMenu, documentEpoch, documentId, setFormatDialogOpen } = ui;
  const formatCtx: EditorFormatContext = {
    dismissContextMenu,
    documentEpoch,
    documentId,
    editableRef: prop.editableRef,
    editorViewRef: view.editorViewRef,
    fileKindRef: prop.fileKindRef,
    formatTargetRef: prop.formatTargetRef,
    onMediaCommandPick: props.onMediaCommandPick,
    setFormatDialogOpen,
  };
  const applyFormatCommand = (command: MarkdownFormatCommandId) => applyFormatCommandBody(command, formatCtx);
  const applyContextMenuInsert = (action: EditorContextMenuInsertAction) => applyContextMenuInsertBody(action, formatCtx);
  const applyContextMenuCommand = (command: MarkdownFormatCommandId) => {
    dismissContextMenu();
    if (!prop.formatTargetRef.current) return;
    applyFormatCommand(command);
  };
  const dismissFormatDialog = () => {
    prop.formatTargetRef.current = null;
    setFormatDialogOpen(false);
  };
  const closeFormatDialog = () => {
    dismissFormatDialog();
    view.editorViewRef.current?.focus();
  };
  return { applyContextMenuCommand, applyContextMenuInsert, applyFormatCommand, closeFormatDialog, dismissFormatDialog };
}
