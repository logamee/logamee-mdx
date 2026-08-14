import { useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type Ref } from 'react';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { html } from '@codemirror/lang-html';
import { markdown } from '@codemirror/lang-markdown';
import { defaultHighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { search, searchKeymap } from '@codemirror/search';
import { Annotation, Compartment, countColumn, EditorState, Prec, Transaction, type ChangeDesc, type Extension } from '@codemirror/state';
import { drawSelection, EditorView, keymap, lineNumbers } from '@codemirror/view';
import { tagHighlighter, tags } from '@lezer/highlight';
import { vim } from '@replit/codemirror-vim';
import { Bold, Code, Command, Image as ImageIcon, Italic, Link, MessageSquareWarning, Sigma, Strikethrough, Table } from 'lucide-react';
import { applyMarkdownFormatCommand, type MarkdownFormatCommandId } from '../lib/markdownFormatCommands';
import { markdownCompletionExtension } from '../lib/markdownCompletion';
import type { MarkdownOutlineJump } from '../lib/markdownOutline';
import type { MarkdownMediaInsertion } from '../lib/markdownMedia';
import type { PanePopoutButtonState } from '../lib/paneLayout';
import { displayName } from '../lib/documentNames';
import { getEditorDocumentStats, type EditorDocumentStats } from '../lib/editorStatus';
import { RICH_PASTE_LIMITS, RichPasteConversionError, convertRichClipboardPayload } from '../lib/richPaste';
import { MarkdownFormatDialog } from './MarkdownFormatDialog';
import { PaneHeader } from './PaneHeader';
import { VimLogo } from './VimLogo';
import type { WorkspaceFileKind } from '../types';
import { useI18n } from '../lib/i18n';

interface EditorPaneProps {
  activePath: string | null;
  content: string;
  documentEpoch: number;
  documentId: string;
  editable?: boolean;
  fileKind?: Extract<WorkspaceFileKind, 'markdown' | 'html'>;
  mediaInsertion?: MarkdownMediaInsertion | null;
  onContentChange: (content: string) => void;
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

const externalSyncAnnotation = Annotation.define<boolean>();

interface EditorStatus extends EditorDocumentStats {
  column: number;
  line: number;
}

interface MarkdownFormatTarget {
  documentEpoch: number;
  documentId: string;
  selection: { from: number; to: number };
  source: string;
}


interface PendingClipboardPaste {
  documentEpoch: number;
  documentId: string;
  from: number;
  id: number;
  to: number;
}

interface ClipboardPasteImageFile {
  blob: File;
  mimeType: string;
  suggestedName: string | null;
}

type ClipboardImageCollection = {
  images: ClipboardPasteImageFile[];
  rejection: RichPasteConversionError | null;
};


interface EditorContextMenuState {
  x: number;
  y: number;
}

type EditorContextMenuInsertAction = 'insert-table' | 'insert-image' | 'insert-formula';

type EditorContextMenuItem =
  | {
    command: MarkdownFormatCommandId;
    icon: typeof Bold;
    kind: 'command';
    label: string;
  }
  | {
    action: EditorContextMenuInsertAction | 'open-format-palette';
    icon: typeof Bold;
    kind: 'action';
    label: string;
  }
  | { kind: 'separator' };

type DeferredDocumentStatsTask = {
  id: number;
  kind: 'debounce' | 'idle';
} | null;

const DOCUMENT_STATS_DEBOUNCE_MS = 120;
const DOCUMENT_STATS_IDLE_TIMEOUT_MS = 250;
const RICH_PASTE_FORMATTING_LOSS_MESSAGE = 'Clipboard content was pasted as cleaned plain text because rich formatting could not be converted safely.';
const CLIPBOARD_IMAGE_REJECTION_MESSAGE = 'One or more clipboard images could not be pasted safely. SVG clipboard images and images over 16 MiB are not accepted.';
const EDITOR_CONTEXT_MENU_WIDTH = 236;
const EDITOR_CONTEXT_MENU_MARGIN = 8;
const EDITOR_CONTEXT_MENU_ITEMS: readonly EditorContextMenuItem[] = [
  { command: 'bold', icon: Bold, kind: 'command', label: 'Bold' },
  { command: 'italic', icon: Italic, kind: 'command', label: 'Italic' },
  { command: 'strikethrough', icon: Strikethrough, kind: 'command', label: 'Strikethrough' },
  { command: 'inline-code', icon: Code, kind: 'command', label: 'Inline code' },
  { kind: 'separator' },
  { command: 'link', icon: Link, kind: 'command', label: 'Link' },
  { action: 'insert-image', icon: ImageIcon, kind: 'action', label: 'Image placeholder' },
  { action: 'insert-table', icon: Table, kind: 'action', label: 'Table' },
  { command: 'code-block', icon: Code, kind: 'command', label: 'Code block' },
  { action: 'insert-formula', icon: Sigma, kind: 'action', label: 'Formula' },
  { command: 'alert-tip', icon: MessageSquareWarning, kind: 'command', label: 'Alert block' },
  { kind: 'separator' },
  { action: 'open-format-palette', icon: Command, kind: 'action', label: 'More formats…' },
];


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


function collectClipboardImages(clipboardData: DataTransfer): ClipboardImageCollection {
  const images: ClipboardPasteImageFile[] = [];
  let rejected = false;
  for (const item of Array.from(clipboardData.items)) {
    if (item.kind !== 'file' || !item.type.toLowerCase().startsWith('image/')) continue;
    const blob = item.getAsFile();
    if (!blob) continue;
    const mimeType = blob.type || item.type || 'application/octet-stream';
    const normalizedMimeType = mimeType.toLowerCase();
    if (normalizedMimeType.startsWith('image/svg+xml') || blob.size > RICH_PASTE_LIMITS.maxImageBytes) {
      rejected = true;
      continue;
    }
    images.push({
      blob,
      mimeType,
      suggestedName: blob.name || null,
    });
  }
  return {
    images,
    rejection: rejected ? new RichPasteConversionError(CLIPBOARD_IMAGE_REJECTION_MESSAGE) : null,
  };
}

function combinePastedMarkdown(parts: readonly (string | null | undefined)[]): string {
  return parts.map((part) => part?.trim() ?? '').filter((part) => part.length > 0).join('\n\n');
}

function mapPendingClipboardPaste(pending: PendingClipboardPaste | null, changes: ChangeDesc): void {
  if (!pending) return;
  pending.from = changes.mapPos(pending.from, -1);
  pending.to = changes.mapPos(pending.to, 1);
}

function dispatchClipboardMarkdown(view: EditorView, from: number, to: number, markdown: string): void {
  view.dispatch({
    changes: { from, to, insert: markdown },
    scrollIntoView: true,
    selection: { anchor: from + markdown.length },
  });
  view.focus();
}


function clampContextMenuPosition(clientX: number, clientY: number): EditorContextMenuState {
  const viewportWidth = typeof window === 'undefined' ? clientX + EDITOR_CONTEXT_MENU_WIDTH : window.innerWidth;
  const viewportHeight = typeof window === 'undefined' ? clientY + 320 : window.innerHeight;
  return {
    x: Math.max(EDITOR_CONTEXT_MENU_MARGIN, Math.min(clientX, viewportWidth - EDITOR_CONTEXT_MENU_WIDTH - EDITOR_CONTEXT_MENU_MARGIN)),
    y: Math.max(EDITOR_CONTEXT_MENU_MARGIN, Math.min(clientY, viewportHeight - EDITOR_CONTEXT_MENU_MARGIN)),
  };
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

function editorConfiguration(
  fileKind: Extract<WorkspaceFileKind, 'markdown' | 'html'>,
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

function editorAccessConfiguration(editable: boolean): Extension {
  return [
    EditorState.readOnly.of(!editable),
    EditorView.editable.of(editable),
    EditorView.contentAttributes.of({ 'aria-readonly': String(!editable) }),
  ];
}

function vimModeConfiguration(enabled: boolean): Extension {
  return enabled ? vim({ status: true }) : [];
}

function getEditorCursorStatus(state: EditorState): Pick<EditorStatus, 'column' | 'line'> {
  const head = state.selection.main.head;
  const line = state.doc.lineAt(head);
  return {
    column: countColumn(line.text, 2, head - line.from) + 1,
    line: line.number,
  };
}

function getEditorStatus(state: EditorState): EditorStatus {
  return {
    ...getEditorDocumentStats(state.doc.toString()),
    ...getEditorCursorStatus(state),
  };
}

function isSameEditorStatus(current: EditorStatus, next: EditorStatus): boolean {
  return current.characters === next.characters
    && current.column === next.column
    && current.line === next.line
    && current.lines === next.lines
    && current.words === next.words;
}

function isMarkdownFormatShortcut(event: KeyboardEvent): boolean {
  return event.ctrlKey
    && !event.altKey
    && !event.metaKey
    && (event.code === 'Slash' || event.key === '/' || (event.key === '?' && event.shiftKey));
}

export function EditorPane({ activePath, content, documentEpoch, documentId, editable = true, fileKind = 'markdown', mediaInsertion, onContentChange, onPasteError, onPasteImage, outlineJump, onPopout, paneRef, popoutButton, popout = false, spellcheckEnabled = true }: EditorPaneProps) {
  const { t } = useI18n();
  const editorLabel = fileKind === 'html' ? t('htmlSourceEditor') : t('markdownSourceEditor');
  const [vimModeEnabled, setVimModeEnabled] = useState(false);
  const [formatDialogOpen, setFormatDialogOpen] = useState(false);
  const [contextMenuState, setContextMenuState] = useState<EditorContextMenuState | null>(null);
  const [editorStatus, setEditorStatus] = useState<EditorStatus>(() => ({
    ...getEditorDocumentStats(content),
    column: 1,
    line: 1,
  }));
  const editorHostRef = useRef<HTMLDivElement>(null);
  const contextMenuRef = useRef<HTMLDivElement>(null);
  const editorViewRef = useRef<EditorView | null>(null);
  const configurationCompartmentRef = useRef<Compartment | null>(null);
  const accessCompartmentRef = useRef<Compartment | null>(null);
  const vimModeCompartmentRef = useRef<Compartment | null>(null);
  const configuredFileKindRef = useRef(fileKind);
  const configuredEditorLabelRef = useRef(editorLabel);
  const configuredSpellcheckEnabledRef = useRef(spellcheckEnabled);
  const configuredEditableRef = useRef(editable);
  const configuredVimModeRef = useRef(vimModeEnabled);
  const contentRef = useRef(content);
  const editableRef = useRef(editable);
  const fileKindRef = useRef(fileKind);
  const vimModeEnabledRef = useRef(vimModeEnabled);
  const onContentChangeRef = useRef(onContentChange);
  const onPasteErrorRef = useRef(onPasteError);
  const onPasteImageRef = useRef(onPasteImage);
  const documentEpochRef = useRef(documentEpoch);
  const documentIdRef = useRef(documentId);
  const lastHandledMediaInsertionRef = useRef<string | null>(null);
  const pendingClipboardPasteRef = useRef<PendingClipboardPaste | null>(null);
  const clipboardPasteIdRef = useRef(0);
  const formatTargetRef = useRef<MarkdownFormatTarget | null>(null);
  contentRef.current = content;
  editableRef.current = editable;
  fileKindRef.current = fileKind;
  vimModeEnabledRef.current = vimModeEnabled;
  onContentChangeRef.current = onContentChange;
  onPasteErrorRef.current = onPasteError;
  onPasteImageRef.current = onPasteImage;
  documentEpochRef.current = documentEpoch;
  documentIdRef.current = documentId;

  const openMarkdownFormatDialog = useCallback((view: EditorView) => {
    if (!editableRef.current || fileKindRef.current !== 'markdown') return false;
    formatTargetRef.current = {
      documentEpoch,
      documentId,
      selection: {
        from: view.state.selection.main.from,
        to: view.state.selection.main.to,
      },
      source: view.state.doc.toString(),
    };
    setFormatDialogOpen(true);
    return true;
  }, [documentEpoch, documentId]);

  const handleEditorKeyDownCapture = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!isMarkdownFormatShortcut(event.nativeEvent)) return;
    const view = editorViewRef.current;
    if (!view || !openMarkdownFormatDialog(view)) return;
    event.preventDefault();
    event.stopPropagation();
  };

  const handleEditorContextMenuCapture = (event: ReactMouseEvent<HTMLDivElement>) => {
    const view = editorViewRef.current;
    if (!view || !editableRef.current || fileKindRef.current !== 'markdown') return;
    event.preventDefault();
    event.stopPropagation();
    const currentSelection = view.state.selection.main;
    let selection = { from: currentSelection.from, to: currentSelection.to };
    if (currentSelection.empty) {
      const position = view.posAtCoords({ x: event.clientX, y: event.clientY });
      if (typeof position === 'number') selection = { from: position, to: position };
    }
    formatTargetRef.current = {
      documentEpoch: documentEpochRef.current,
      documentId: documentIdRef.current,
      selection,
      source: view.state.doc.toString(),
    };
    setFormatDialogOpen(false);
    setContextMenuState(clampContextMenuPosition(event.clientX, event.clientY));
  };

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
      editorViewRef.current?.focus();
    };
    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [contextMenuState, dismissContextMenu]);

  useEffect(() => {
    const host = editorHostRef.current;
    if (!host) return undefined;

    const configurationCompartment = new Compartment();
    const accessCompartment = new Compartment();
    const vimModeCompartment = new Compartment();
    const initialFileKind = fileKindRef.current;
    const initialEditorLabel = configuredEditorLabelRef.current;
    const initialSpellcheckEnabled = configuredSpellcheckEnabledRef.current;
    const initialEditable = editableRef.current;
    const initialVimMode = vimModeEnabledRef.current;
    let deferredDocumentStatsTask: DeferredDocumentStatsTask = null;
    let documentStatsVersion = 0;
    let pendingDocumentState: EditorState | null = null;
    let disposed = false;
    const cancelDeferredDocumentStats = () => {
      const task = deferredDocumentStatsTask;
      if (!task) return;
      if (task.kind === 'idle') {
        if (typeof cancelIdleCallback === 'function') cancelIdleCallback(task.id);
      } else {
        window.clearTimeout(task.id);
      }
      deferredDocumentStatsTask = null;
    };
    const syncEditorCursorStatus = (state: EditorState) => {
      const cursor = getEditorCursorStatus(state);
      setEditorStatus((current) => {
        const next = { ...current, ...cursor };
        return isSameEditorStatus(current, next) ? current : next;
      });
    };
    const commitDocumentStats = (version: number) => {
      if (disposed || version !== documentStatsVersion) return;
      deferredDocumentStatsTask = null;
      const state = pendingDocumentState;
      pendingDocumentState = null;
      if (!state) return;
      const documentStats = getEditorDocumentStats(state.doc.toString());
      setEditorStatus((current) => {
        const next = { ...current, ...documentStats };
        return isSameEditorStatus(current, next) ? current : next;
      });
    };
    const scheduleDocumentStats = (state: EditorState) => {
      pendingDocumentState = state;
      cancelDeferredDocumentStats();
      documentStatsVersion += 1;
      const version = documentStatsVersion;
      const requestIdleWork = () => {
        if (disposed || version !== documentStatsVersion) return;
        deferredDocumentStatsTask = null;
        if (typeof requestIdleCallback === 'function') {
          const id = requestIdleCallback(
            () => commitDocumentStats(version),
            { timeout: DOCUMENT_STATS_IDLE_TIMEOUT_MS },
          );
          deferredDocumentStatsTask = { id, kind: 'idle' };
          return;
        }
        commitDocumentStats(version);
      };
      const id = window.setTimeout(requestIdleWork, DOCUMENT_STATS_DEBOUNCE_MS);
      deferredDocumentStatsTask = { id, kind: 'debounce' };
    };
    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: contentRef.current,
        extensions: [
          vimModeCompartment.of(vimModeConfiguration(initialVimMode)),
          lineNumbers(),
          history(),
          search(),
          syntaxHighlighting(defaultHighlightStyle),
          syntaxHighlighting(sourceSyntaxHighlighter),
          drawSelection(),
          EditorView.lineWrapping,
          EditorView.domEventHandlers({
            paste: (event, pasteView) => {
              if (!editableRef.current || fileKindRef.current !== 'markdown') return false;
              const clipboardData = event.clipboardData;
              if (!clipboardData) return false;

              const payload = {
                html: clipboardData.getData('text/html'),
                rtf: clipboardData.getData('text/rtf'),
                text: clipboardData.getData('text/plain'),
              };
              const hasClipboardText = payload.html.trim().length > 0
                || payload.rtf.trim().length > 0
                || payload.text.trim().length > 0;
              const pasteImage = onPasteImageRef.current;
              const { images, rejection } = collectClipboardImages(clipboardData);
              let markdown: string | null = null;

              if (hasClipboardText) {
                try {
                  const conversion = convertRichClipboardPayload(payload);
                  markdown = conversion.markdown;
                  if (conversion.formattingLoss && conversion.source === 'text') {
                    onPasteErrorRef.current?.(new RichPasteConversionError(RICH_PASTE_FORMATTING_LOSS_MESSAGE));
                  }
                } catch (error) {
                  if (images.length === 0) {
                    event.preventDefault();
                    onPasteErrorRef.current?.(error);
                    if (rejection) onPasteErrorRef.current?.(rejection);
                    return true;
                  }
                  onPasteErrorRef.current?.(error);
                }
              }

              if (rejection) onPasteErrorRef.current?.(rejection);
              if (!markdown && images.length === 0) {
                if (rejection) event.preventDefault();
                return Boolean(rejection);
              }

              event.preventDefault();
              const { from, to } = pasteView.state.selection.main;
              if (images.length === 0 || !pasteImage) {
                if (images.length > 0 && !pasteImage) {
                  onPasteErrorRef.current?.(new RichPasteConversionError('Clipboard images could not be pasted into this document.'));
                }
                if (markdown) dispatchClipboardMarkdown(pasteView, from, to, markdown);
                return true;
              }

              const pasteDocumentEpoch = documentEpochRef.current;
              const pasteDocumentId = documentIdRef.current;
              const pasteId = clipboardPasteIdRef.current + 1;
              clipboardPasteIdRef.current = pasteId;
              pendingClipboardPasteRef.current = {
                documentEpoch: pasteDocumentEpoch,
                documentId: pasteDocumentId,
                from,
                id: pasteId,
                to,
              };

              void Promise.all(images.map(async (image) => {
                try {
                  return await pasteImage({
                    blob: image.blob,
                    documentEpoch: pasteDocumentEpoch,
                    documentId: pasteDocumentId,
                    mimeType: image.mimeType,
                    suggestedName: image.suggestedName,
                  });
                } catch (error) {
                  onPasteErrorRef.current?.(error);
                  return null;
                }
              })).then((imageMarkdowns) => {
                const pendingPaste = pendingClipboardPasteRef.current;
                if (
                  !pendingPaste
                  || pendingPaste.id !== pasteId
                  || pendingPaste.documentEpoch !== pasteDocumentEpoch
                  || pendingPaste.documentId !== pasteDocumentId
                  || editorViewRef.current !== pasteView
                  || !editableRef.current
                  || fileKindRef.current !== 'markdown'
                  || documentEpochRef.current !== pasteDocumentEpoch
                  || documentIdRef.current !== pasteDocumentId
                ) return;

                const combinedMarkdown = combinePastedMarkdown([markdown, ...imageMarkdowns]);
                pendingClipboardPasteRef.current = null;
                if (!combinedMarkdown) return;
                dispatchClipboardMarkdown(pasteView, pendingPaste.from, pendingPaste.to, combinedMarkdown);
              }).catch((error: unknown) => {
                pendingClipboardPasteRef.current = null;
                onPasteErrorRef.current?.(error);
              });
              return true;
            },
          }),
          Prec.highest(keymap.of([{
            key: 'Ctrl-/',
            run: openMarkdownFormatDialog,
            shift: openMarkdownFormatDialog,
            stopPropagation: true,
          }])),
          keymap.of([
            ...defaultKeymap,
            ...historyKeymap,
            ...searchKeymap,
          ]),
          markdownCompletionExtension(() => (
            editableRef.current && fileKindRef.current === 'markdown'
          )),
          configurationCompartment.of(editorConfiguration(
            initialFileKind,
            initialEditorLabel,
            initialSpellcheckEnabled,
          )),
          accessCompartment.of(editorAccessConfiguration(initialEditable)),
          EditorState.transactionFilter.of((transaction) => (
            transaction.docChanged
              && transaction.startState.facet(EditorState.readOnly)
              && !transaction.annotation(externalSyncAnnotation)
              ? []
              : transaction
          )),
          EditorView.updateListener.of((update) => {
            if (update.docChanged || update.selectionSet) {
              syncEditorCursorStatus(update.state);
            }
            if (update.docChanged) {
              mapPendingClipboardPaste(pendingClipboardPasteRef.current, update.changes);
              scheduleDocumentStats(update.state);
            }
            const hasUserDocumentChange = update.transactions.some((transaction) => (
              transaction.docChanged && !transaction.annotation(externalSyncAnnotation)
            ));
            if (hasUserDocumentChange) {
              onContentChangeRef.current(update.state.doc.toString());
            }
          }),
        ],
      }),
    });
    editorViewRef.current = view;
    configurationCompartmentRef.current = configurationCompartment;
    accessCompartmentRef.current = accessCompartment;
    vimModeCompartmentRef.current = vimModeCompartment;
    configuredFileKindRef.current = initialFileKind;
    configuredEditorLabelRef.current = initialEditorLabel;
    configuredSpellcheckEnabledRef.current = initialSpellcheckEnabled;
    configuredEditableRef.current = initialEditable;
    configuredVimModeRef.current = initialVimMode;
    setEditorStatus(getEditorStatus(view.state));

    return () => {
      disposed = true;
      documentStatsVersion += 1;
      pendingDocumentState = null;
      cancelDeferredDocumentStats();
      if (editorViewRef.current === view) editorViewRef.current = null;
      if (configurationCompartmentRef.current === configurationCompartment) {
        configurationCompartmentRef.current = null;
      }
      if (accessCompartmentRef.current === accessCompartment) {
        accessCompartmentRef.current = null;
      }
      if (vimModeCompartmentRef.current === vimModeCompartment) {
        vimModeCompartmentRef.current = null;
      }
      view.destroy();
    };
  }, [documentEpoch, documentId, openMarkdownFormatDialog]);

  useEffect(() => {
    const view = editorViewRef.current;
    const accessCompartment = accessCompartmentRef.current;
    if (!view || !accessCompartment || configuredEditableRef.current === editable) return;
    view.dispatch({ effects: accessCompartment.reconfigure(editorAccessConfiguration(editable)) });
    configuredEditableRef.current = editable;
  }, [documentEpoch, documentId, editable]);

  useEffect(() => {
    const view = editorViewRef.current;
    const vimModeCompartment = vimModeCompartmentRef.current;
    if (!view || !vimModeCompartment || configuredVimModeRef.current === vimModeEnabled) return;
    view.dispatch({ effects: vimModeCompartment.reconfigure(vimModeConfiguration(vimModeEnabled)) });
    configuredVimModeRef.current = vimModeEnabled;
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

  useEffect(() => {
    const view = editorViewRef.current;
    if (
      !view
      || !mediaInsertion
      || mediaInsertion.documentId !== documentId
      || mediaInsertion.documentEpoch !== documentEpoch
      || !editableRef.current
      || fileKindRef.current !== 'markdown'
      || !mediaInsertion.markdown
    ) return;
    const insertionKey = `${mediaInsertion.documentId}:${mediaInsertion.documentEpoch}:${mediaInsertion.requestId}`;
    if (lastHandledMediaInsertionRef.current === insertionKey) return;
    const position = mediaInsertion.target.kind === 'coordinates'
      ? view.posAtCoords({ x: mediaInsertion.target.clientX, y: mediaInsertion.target.clientY })
        ?? view.state.selection.main.head
      : view.state.selection.main.head;
    lastHandledMediaInsertionRef.current = insertionKey;
    view.dispatch({
      changes: { from: position, insert: mediaInsertion.markdown },
      scrollIntoView: true,
      selection: { anchor: position + mediaInsertion.markdown.length },
    });
    view.focus();
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

  useEffect(() => {
    const view = editorViewRef.current;
    const configurationCompartment = configurationCompartmentRef.current;
    if (
      !view
      || !configurationCompartment
      || (
        configuredFileKindRef.current === fileKind
        && configuredEditorLabelRef.current === editorLabel
        && configuredSpellcheckEnabledRef.current === spellcheckEnabled
      )
    ) return;
    view.dispatch({
      effects: configurationCompartment.reconfigure(editorConfiguration(
        fileKind,
        editorLabel,
        spellcheckEnabled,
      )),
    });
    configuredFileKindRef.current = fileKind;
    configuredEditorLabelRef.current = editorLabel;
    configuredSpellcheckEnabledRef.current = spellcheckEnabled;
  }, [documentEpoch, documentId, editorLabel, fileKind, spellcheckEnabled]);

  useEffect(() => {
    if (editable && fileKind === 'markdown') return;
    formatTargetRef.current = null;
    setFormatDialogOpen(false);
    dismissContextMenu();
  }, [documentEpoch, documentId, dismissContextMenu, editable, fileKind]);

  useEffect(() => {
    formatTargetRef.current = null;
    setFormatDialogOpen(false);
    dismissContextMenu();
  }, [content, documentEpoch, documentId, dismissContextMenu]);

  const dismissFormatDialog = () => {
    formatTargetRef.current = null;
    setFormatDialogOpen(false);
  };

  const closeFormatDialog = () => {
    dismissFormatDialog();
    editorViewRef.current?.focus();
  };

  const applyFormatCommand = (command: MarkdownFormatCommandId) => {
    const view = editorViewRef.current;
    const target = formatTargetRef.current;
    if (
      !view
      || !target
      || !editableRef.current
      || fileKindRef.current !== 'markdown'
      || target.documentEpoch !== documentEpoch
      || target.documentId !== documentId
      || target.source !== view.state.doc.toString()
    ) {
      formatTargetRef.current = null;
      setFormatDialogOpen(false);
      return;
    }
    const edit = applyMarkdownFormatCommand(
      target.source,
      target.selection,
      command,
    );
    view.dispatch({
      changes: { from: edit.from, insert: edit.insert, to: edit.to },
      scrollIntoView: true,
      selection: edit.selection,
    });
    formatTargetRef.current = null;
    setFormatDialogOpen(false);
    dismissContextMenu();
    view.focus();
  };

  const applyContextMenuCommand = (command: MarkdownFormatCommandId) => {
    dismissContextMenu();
    if (!formatTargetRef.current) return;
    applyFormatCommand(command);
  };

  const applyContextMenuInsert = (action: EditorContextMenuInsertAction) => {
    const view = editorViewRef.current;
    const target = formatTargetRef.current;
    if (
      !view
      || !target
      || !editableRef.current
      || fileKindRef.current !== 'markdown'
      || target.documentEpoch !== documentEpoch
      || target.documentId !== documentId
      || target.source !== view.state.doc.toString()
    ) {
      formatTargetRef.current = null;
      dismissContextMenu();
      return;
    }
    const edit = createContextInsertEdit(target.source, target.selection, action);
    view.dispatch({
      changes: { from: edit.from, insert: edit.insert, to: edit.to },
      scrollIntoView: true,
      selection: edit.selection,
    });
    formatTargetRef.current = null;
    dismissContextMenu();
    view.focus();
  };

  return (
    <section className={popout ? 'editor-pane popout-pane' : 'editor-pane'} ref={paneRef}>
      <PaneHeader
        title={t('editor')}
        subtitle={displayName(activePath)}
        beforePopout={(
          <button
            type="button"
            className={vimModeEnabled ? 'pane-vim-button is-active' : 'pane-vim-button'}
            title={vimModeEnabled ? t('disableVim') : t('enableVim')}
            aria-label={vimModeEnabled ? t('disableVim') : t('enableVim')}
            aria-pressed={vimModeEnabled}
            onClick={() => setVimModeEnabled((enabled) => !enabled)}
          >
            <VimLogo className="vim-logo" />
          </button>
        )}
        popoutButton={popoutButton}
        onPopout={onPopout}
      />
      <div
        aria-label={editorLabel}
        className="editor-host"
        data-markdown-media-drop-target={editable && fileKind === 'markdown' ? 'true' : undefined}
        onContextMenuCapture={handleEditorContextMenuCapture}
        onKeyDownCapture={handleEditorKeyDownCapture}
        ref={editorHostRef}
      />
      <footer className="editor-status" aria-label={t('editorStatus')}>
        <span className="editor-status-stat editor-status-words">{t('words', { count: editorStatus.words })}</span>
        <span className="editor-status-stat editor-status-characters">{t('characters', { count: editorStatus.characters })}</span>
        <span className="editor-status-stat editor-status-lines">{t('lines', { count: editorStatus.lines })}</span>
        <span className="editor-status-cursor">{t('lineColumn', { line: editorStatus.line, column: editorStatus.column })}</span>
      </footer>
      {contextMenuState && (
        <div
          aria-label="Markdown editor context menu"
          className="editor-context-menu"
          data-editor-context-menu="true"
          ref={contextMenuRef}
          role="menu"
          style={{ left: `${contextMenuState.x}px`, top: `${contextMenuState.y}px` }}
        >
          {EDITOR_CONTEXT_MENU_ITEMS.map((item, index) => {
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
                  onClick={() => applyContextMenuCommand(item.command)}
                  role="menuitem"
                  type="button"
                >
                  <Icon aria-hidden="true" className="editor-context-menu-icon" size={16} />
                  <span>{item.label}</span>
                </button>
              );
            }
            return (
              <button
                key={item.action}
                className="editor-context-menu-item"
                data-context-action-id={item.action}
                onClick={() => (item.action === 'open-format-palette'
                  ? (dismissContextMenu(), setFormatDialogOpen(true))
                  : applyContextMenuInsert(item.action))}
                role="menuitem"
                type="button"
              >
                <Icon aria-hidden="true" className="editor-context-menu-icon" size={16} />
                <span>{item.label}</span>
              </button>
            );
          })}
        </div>
      )}
      {formatDialogOpen && (
        <MarkdownFormatDialog
          onCancel={closeFormatDialog}
          onFocusLeave={dismissFormatDialog}
          onSelect={applyFormatCommand}
        />
      )}
    </section>
  );
}
