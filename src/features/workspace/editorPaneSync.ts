/* eslint-disable react-hooks/exhaustive-deps -- 纯搬移：依赖数组逐项保持提取前原样，由 EditorPane.test.tsx 回归约束 */
import { Transaction } from '@codemirror/state';
import type { Compartment } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import { useEffect } from 'react';
import type { MutableRefObject, RefObject } from 'react';
import type { MarkdownOutlineJump } from '../../lib/markdownOutline';
import type { MarkdownMediaInsertion } from '../../lib/markdownMedia';
import type { WorkspaceFileKind } from '../../types';
import { editorAccessConfiguration, editorConfiguration, externalSyncAnnotation, vimModeConfiguration } from './editorPaneSetup';
import type { EditorFileKind } from './editorPaneTypes';

export interface EditorAccessSyncDeps {
  compartments: { access: RefObject<Compartment | null>; vimMode: RefObject<Compartment | null> };
  configured: { editable: MutableRefObject<boolean>; vimMode: MutableRefObject<boolean> };
  content: string;
  documentEpoch: number;
  documentId: string;
  editable: boolean;
  editorViewRef: RefObject<EditorView | null>;
  vimModeEnabled: boolean;
}

// 访问与内容同步：可编辑性、Vim 模式 reconfigure 与外部内容整篇替换。
export function useEditorAccessSync(deps: EditorAccessSyncDeps): void {
  const { compartments, configured, content, documentEpoch, documentId, editable, editorViewRef, vimModeEnabled } = deps;

  useEffect(() => {
    const view = editorViewRef.current;
    const accessCompartment = compartments.access.current;
    if (!view || !accessCompartment || configured.editable.current === editable) return;
    view.dispatch({ effects: accessCompartment.reconfigure(editorAccessConfiguration(editable)) });
    configured.editable.current = editable;
  }, [documentEpoch, documentId, editable]);

  useEffect(() => {
    const view = editorViewRef.current;
    const vimModeCompartment = compartments.vimMode.current;
    if (!view || !vimModeCompartment || configured.vimMode.current === vimModeEnabled) return;
    view.dispatch({ effects: vimModeCompartment.reconfigure(vimModeConfiguration(vimModeEnabled)) });
    configured.vimMode.current = vimModeEnabled;
    view.focus();
  }, [documentEpoch, documentId, vimModeEnabled]);

  useEffect(() => {
    const view = editorViewRef.current;
    if (!view || view.state.doc.toString() === content) return;
    view.dispatch({
      annotations: [
        externalSyncAnnotation.of(true),
        Transaction.addToHistory.of(false),
      ],
      changes: { from: 0, to: view.state.doc.length, insert: content },
    });
  }, [content, documentEpoch, documentId]);
}

export interface EditorIntentSyncDeps {
  compartments: { configuration: RefObject<Compartment | null> };
  configured: {
    editorLabel: MutableRefObject<string>;
    fileKind: MutableRefObject<EditorFileKind>;
    spellcheckEnabled: MutableRefObject<boolean>;
  };
  documentEpoch: number;
  documentId: string;
  editableRef: RefObject<boolean>;
  editorLabel: string;
  editorViewRef: RefObject<EditorView | null>;
  fileKind: EditorFileKind;
  fileKindRef: RefObject<WorkspaceFileKind>;
  lastHandledMediaInsertionRef: RefObject<string | null>;
  mediaInsertion?: MarkdownMediaInsertion | null;
  outlineJump?: MarkdownOutlineJump | null;
  spellcheckEnabled: boolean;
}

function insertMediaMarkdown(view: EditorView, mediaInsertion: MarkdownMediaInsertion): void {
  const position = mediaInsertion.target.kind === 'coordinates'
    ? view.posAtCoords({ x: mediaInsertion.target.clientX, y: mediaInsertion.target.clientY })
      ?? view.state.selection.main.head
    : view.state.selection.main.head;
  view.dispatch({
    changes: { from: position, insert: mediaInsertion.markdown },
    scrollIntoView: true,
    selection: { anchor: position + mediaInsertion.markdown.length },
  });
  view.focus();
}

// 意图同步：媒体插入、大纲跳转与语言/拼写配置 reconfigure。
export function useEditorIntentSync(deps: EditorIntentSyncDeps): void {
  const { documentEpoch, documentId, editorViewRef, mediaInsertion, outlineJump } = deps;

  useEffect(() => {
    const view = editorViewRef.current;
    if (
      !view
      || !mediaInsertion
      || mediaInsertion.documentId !== documentId
      || mediaInsertion.documentEpoch !== documentEpoch
      || !deps.editableRef.current
      || deps.fileKindRef.current !== 'markdown'
      || !mediaInsertion.markdown
    ) return;
    const insertionKey = `${mediaInsertion.documentId}:${mediaInsertion.documentEpoch}:${mediaInsertion.requestId}`;
    if (deps.lastHandledMediaInsertionRef.current === insertionKey) return;
    deps.lastHandledMediaInsertionRef.current = insertionKey;
    insertMediaMarkdown(view, mediaInsertion);
  }, [documentEpoch, documentId, mediaInsertion]);

  useEffect(() => {
    const view = editorViewRef.current;
    if (
      !view
      || !outlineJump
      || outlineJump.documentId !== documentId
      || outlineJump.documentEpoch !== documentEpoch
    ) return;
    const line = Math.min(Math.max(1, outlineJump.item.line), view.state.doc.lines);
    view.dispatch({
      scrollIntoView: true,
      selection: { anchor: view.state.doc.line(line).from },
    });
  }, [documentEpoch, documentId, outlineJump]);

}

// 语言/标签/拼写配置 reconfigure：仅在配置实际变化时下发并镜像已配置值。
export function useEditorConfigurationSync(deps: EditorIntentSyncDeps): void {
  const { compartments, configured, documentEpoch, documentId, editorLabel } = deps;
  const { editorViewRef, fileKind, spellcheckEnabled } = deps;

  useEffect(() => {
    const view = editorViewRef.current;
    const configurationCompartment = compartments.configuration.current;
    if (
      !view
      || !configurationCompartment
      || (
        configured.fileKind.current === fileKind
        && configured.editorLabel.current === editorLabel
        && configured.spellcheckEnabled.current === spellcheckEnabled
      )
    ) return;
    view.dispatch({
      effects: configurationCompartment.reconfigure(editorConfiguration(
        fileKind,
        editorLabel,
        spellcheckEnabled,
      )),
    });
    configured.fileKind.current = fileKind;
    configured.editorLabel.current = editorLabel;
    configured.spellcheckEnabled.current = spellcheckEnabled;
  }, [documentEpoch, documentId, editorLabel, fileKind, spellcheckEnabled]);
}
