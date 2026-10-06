/* eslint-disable react-hooks/exhaustive-deps -- 纯搬移：挂载效果依赖保持原样，由 EditorPane.test.tsx 回归约束 */
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { html } from '@codemirror/lang-html';
import { markdown } from '@codemirror/lang-markdown';
import { defaultHighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { search, searchKeymap } from '@codemirror/search';
import {
  Annotation,
  Compartment,
  EditorState,
  Transaction,
  type Extension,
} from '@codemirror/state';
import { drawSelection, EditorView, keymap, lineNumbers } from '@codemirror/view';
import { tagHighlighter, tags } from '@lezer/highlight';
import { vim } from '@replit/codemirror-vim';
import { useEffect } from 'react';
import type { Dispatch, MutableRefObject, RefObject, SetStateAction } from 'react';
import { markdownCompletionExtension } from '../../lib/markdownCompletion';
import { createClipboardPasteHandler, mapPendingClipboardPaste, type ClipboardPasteHandlerDeps } from './editorPaneClipboard';
import { createDeferredStatsScheduler, getEditorStatus, syncEditorCursorStatus, type DeferredStatsScheduler } from './editorPaneStatus';
import { FORMAT_SHORTCUT_COMMIT_SLASH_PATTERN, type EditorFileKind, type EditorStatus } from './editorPaneTypes';

export const externalSyncAnnotation = Annotation.define<boolean>();

function isFormatShortcutSlashCommit(transaction: Transaction): boolean {
  let changedRanges = 0;
  let slashCommit = false;
  transaction.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
    changedRanges += 1;
    if (
      changedRanges === 1
      && fromA === toA
      && FORMAT_SHORTCUT_COMMIT_SLASH_PATTERN.test(inserted.toString())
    ) {
      slashCommit = true;
    }
  });
  return changedRanges === 1 && slashCommit;
}

const sourceSyntaxHighlighter = tagHighlighter([
  { tag: tags.heading, class: 'tok-heading' },
  { tag: tags.strong, class: 'tok-strong' },
  { tag: tags.emphasis, class: 'tok-emphasis' },
  { tag: tags.link, class: 'tok-link' },
  { tag: tags.url, class: 'tok-url' },
  { tag: tags.monospace, class: 'tok-monospace' },
  { tag: tags.quote, class: 'tok-quote' },
  { tag: tags.list, class: 'tok-list' },
  { tag: tags.processingInstruction, class: 'tok-meta' },
  { tag: tags.comment, class: 'tok-comment' },
]);

export function editorConfiguration(
  fileKind: EditorFileKind,
  label: string,
  spellcheckEnabled: boolean,
): Extension {
  return [
    fileKind === 'html' ? html() : markdown(),
    EditorView.contentAttributes.of({
      'aria-label': label,
      spellcheck: String(spellcheckEnabled),
    }),
  ];
}

export function editorAccessConfiguration(editable: boolean): Extension {
  return [
    EditorState.readOnly.of(!editable),
    EditorView.editable.of(editable),
    EditorView.contentAttributes.of({ 'aria-readonly': String(!editable) }),
  ];
}

export function vimModeConfiguration(enabled: boolean): Extension {
  return enabled ? vim({ status: true }) : [];
}

// 只读拦截：非外部同步的文档变更在只读状态下直接丢弃。
function readOnlyTransactionFilter(): Extension {
  return EditorState.transactionFilter.of((transaction) => (
    transaction.docChanged
      && transaction.startState.facet(EditorState.readOnly)
      && !transaction.annotation(externalSyncAnnotation)
      ? []
      : transaction
  ));
}

// 输入法残留拦截：吞掉快捷键后的短时间内仅插入斜杠的事务视为残留并丢弃。
function formatShortcutTransactionFilter(guardUntilRef: RefObject<number>): Extension {
  return EditorState.transactionFilter.of((transaction) => {
    const formatShortcutGuardUntil = guardUntilRef.current;
    if (
      formatShortcutGuardUntil === 0
      || Date.now() > formatShortcutGuardUntil
      || !transaction.docChanged
      || transaction.annotation(externalSyncAnnotation)
      || !isFormatShortcutSlashCommit(transaction)
    ) return transaction;
    guardUntilRef.current = 0;
    return [];
  });
}

function editorUpdateListener(deps: {
  onContentChangeRef: RefObject<(content: string) => void>;
  pendingClipboardPasteRef: MutableRefObject<ClipboardPasteHandlerDeps['pendingClipboardPasteRef']['current']>;
  scheduler: DeferredStatsScheduler;
  setEditorStatus: Dispatch<SetStateAction<EditorStatus>>;
}): Extension {
  return EditorView.updateListener.of((update) => {
    if (update.docChanged || update.selectionSet) {
      syncEditorCursorStatus(update.state, deps.setEditorStatus);
    }
    if (update.docChanged) {
      mapPendingClipboardPaste(deps.pendingClipboardPasteRef.current, update.changes);
      deps.scheduler.schedule(update.state);
    }
    const hasUserDocumentChange = update.transactions.some((transaction) => (
      transaction.docChanged && !transaction.annotation(externalSyncAnnotation)
    ));
    if (hasUserDocumentChange) {
      deps.onContentChangeRef.current(update.state.doc.toString());
    }
  });
}

function buildEditorExtensions(deps: {
  accessCompartment: Compartment;
  clipboardPaste: ClipboardPasteHandlerDeps;
  configurationCompartment: Compartment;
  editable: boolean;
  editorLabel: string;
  fileKind: EditorFileKind;
  formatShortcutGuardUntilRef: RefObject<number>;
  onContentChangeRef: RefObject<(content: string) => void>;
  scheduler: DeferredStatsScheduler;
  setEditorStatus: Dispatch<SetStateAction<EditorStatus>>;
  spellcheckEnabled: boolean;
  vimMode: boolean;
  vimModeCompartment: Compartment;
}): Extension[] {
  const { accessCompartment, clipboardPaste, configurationCompartment } = deps;
  return [
    deps.vimModeCompartment.of(vimModeConfiguration(deps.vimMode)),
    lineNumbers(),
    history(),
    search(),
    syntaxHighlighting(defaultHighlightStyle),
    syntaxHighlighting(sourceSyntaxHighlighter),
    drawSelection(),
    EditorView.lineWrapping,
    EditorView.domEventHandlers({ paste: createClipboardPasteHandler(clipboardPaste) }),
    keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap]),
    markdownCompletionExtension(() => (
      clipboardPaste.editableRef.current && clipboardPaste.fileKindRef.current === 'markdown'
    )),
    configurationCompartment.of(editorConfiguration(
      deps.fileKind,
      deps.editorLabel,
      deps.spellcheckEnabled,
    )),
    accessCompartment.of(editorAccessConfiguration(deps.editable)),
    readOnlyTransactionFilter(),
    formatShortcutTransactionFilter(deps.formatShortcutGuardUntilRef),
    editorUpdateListener({
      onContentChangeRef: deps.onContentChangeRef,
      pendingClipboardPasteRef: clipboardPaste.pendingClipboardPasteRef,
      scheduler: deps.scheduler,
      setEditorStatus: deps.setEditorStatus,
    }),
  ];
}

export interface EditorPaneSetupDeps {
  clipboardPaste: ClipboardPasteHandlerDeps;
  compartments: {
    access: RefObject<Compartment | null>;
    configuration: RefObject<Compartment | null>;
    vimMode: RefObject<Compartment | null>;
  };
  configured: {
    editorLabel: MutableRefObject<string>;
    editable: MutableRefObject<boolean>;
    fileKind: MutableRefObject<EditorFileKind>;
    spellcheckEnabled: MutableRefObject<boolean>;
    vimMode: MutableRefObject<boolean>;
  };
  contentRef: RefObject<string>;
  documentEpoch: number;
  documentId: string;
  editorHostRef: RefObject<HTMLDivElement | null>;
  editorViewRef: RefObject<EditorView | null>;
  formatShortcutGuardUntilRef: RefObject<number>;
  onContentChangeRef: RefObject<(content: string) => void>;
  openMarkdownFormatDialog: (view: EditorView) => boolean;
  setEditorStatus: Dispatch<SetStateAction<EditorStatus>>;
}

// 卸载清理：仅当引用仍指向本视图/compartment 时置空，避免误清新实例。
function releaseEditorView(
  deps: EditorPaneSetupDeps,
  view: EditorView,
  mounted: { accessCompartment: Compartment; configurationCompartment: Compartment; vimModeCompartment: Compartment },
): void {
  const { compartments, editorViewRef } = deps;
  if (editorViewRef.current === view) editorViewRef.current = null;
  if (compartments.configuration.current === mounted.configurationCompartment) {
    compartments.configuration.current = null;
  }
  if (compartments.access.current === mounted.accessCompartment) {
    compartments.access.current = null;
  }
  if (compartments.vimMode.current === mounted.vimModeCompartment) {
    compartments.vimMode.current = null;
  }
  view.destroy();
}

// 编辑器挂载：按文档世代重建视图并登记 compartment 引用供后续 reconfigure。
export function useEditorViewSetup(deps: EditorPaneSetupDeps): void {
  const { clipboardPaste, compartments, configured, contentRef, documentEpoch, documentId } = deps;
  const { editorHostRef, editorViewRef, formatShortcutGuardUntilRef } = deps;
  const { onContentChangeRef, openMarkdownFormatDialog, setEditorStatus } = deps;
  useEffect(() => {
    const host = editorHostRef.current;
    if (!host) return undefined;

    const configurationCompartment = new Compartment();
    const accessCompartment = new Compartment();
    const vimModeCompartment = new Compartment();
    const scheduler = createDeferredStatsScheduler(setEditorStatus);
    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: contentRef.current,
        extensions: buildEditorExtensions({
          accessCompartment,
          clipboardPaste,
          configurationCompartment,
          editable: clipboardPaste.editableRef.current,
          editorLabel: configured.editorLabel.current,
          fileKind: configured.fileKind.current,
          formatShortcutGuardUntilRef,
          onContentChangeRef,
          scheduler,
          setEditorStatus,
          spellcheckEnabled: configured.spellcheckEnabled.current,
          vimMode: configured.vimMode.current,
          vimModeCompartment,
        }),
      }),
    });
    editorViewRef.current = view;
    compartments.configuration.current = configurationCompartment;
    compartments.access.current = accessCompartment;
    compartments.vimMode.current = vimModeCompartment;
    setEditorStatus(getEditorStatus(view.state));

    return () => {
      scheduler.dispose();
      releaseEditorView(deps, view, { accessCompartment, configurationCompartment, vimModeCompartment });
    };
  }, [documentEpoch, documentId, openMarkdownFormatDialog]);
}
