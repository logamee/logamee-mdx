// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { redo, undo, undoDepth } from '@codemirror/commands';
import { htmlLanguage } from '@codemirror/lang-html';
import { markdownLanguage } from '@codemirror/lang-markdown';
import { highlightingFor } from '@codemirror/language';
import {
  findNext,
  findPrevious,
  replaceAll,
  replaceNext,
  SearchQuery,
  setSearchQuery,
} from '@codemirror/search';
import { EditorSelection, EditorState } from '@codemirror/state';
import { EditorView, runScopeHandlers } from '@codemirror/view';
import { tags } from '@lezer/highlight';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getPanePopoutButtonState } from '../lib/paneLayout';
import { applyEffectiveTheme, SKIN_IDS } from '../lib/theme';
import { markdownCompletionExtension } from '../lib/markdownCompletion';
import { EditorPane } from './EditorPane';

if (typeof Range.prototype.getClientRects !== 'function') {
  Object.defineProperty(Range.prototype, 'getClientRects', {
    configurable: true,
    value: () => [],
  });
}

if (typeof Range.prototype.getBoundingClientRect !== 'function') {
  Object.defineProperty(Range.prototype, 'getBoundingClientRect', {
    configurable: true,
    value: () => new DOMRect(),
  });
}

if (typeof document.elementFromPoint !== 'function') {
  Object.defineProperty(document, 'elementFromPoint', {
    configurable: true,
    value: () => null,
  });
}

describe('EditorPane', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function dispatchPaste(view: EditorView, input: {
    html?: string;
    image?: File;
    images?: File[];
    rtf?: string;
    text?: string;
  }): ClipboardEvent {
    const event = new Event('paste', { bubbles: true, cancelable: true }) as ClipboardEvent;
    Object.defineProperty(event, 'clipboardData', {
      configurable: true,
      value: {
        getData: (type: string) => ({
          'text/html': input.html ?? '',
          'text/plain': input.text ?? '',
          'text/rtf': input.rtf ?? '',
        })[type] ?? '',
        items: (input.images ?? (input.image ? [input.image] : [])).map((image) => ({
          getAsFile: () => image,
          kind: 'file',
          type: image.type,
        })),
      },
    });
    view.contentDOM.dispatchEvent(event);
    return event;
  }

  function dispatchEditorContextMenu(view: EditorView, clientX = 120, clientY = 90): MouseEvent {
    const event = new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      clientX,
      clientY,
    });
    view.dom.dispatchEvent(event);
    return event;
  }

  it.each([
    {
      expected: '**Rich**',
      input: { html: '<p><strong>Rich</strong></p>', text: 'Rich' },
      label: 'HTML',
    },
    {
      expected: 'plain text',
      input: { text: 'plain text' },
      label: 'plain text',
    },
    {
      expected: 'Rich text',
      input: { rtf: String.raw`{\rtf1 Rich text}` },
      label: 'RTF',
    },
  ])('inserts $label clipboard content with one undoable transaction', ({ expected, input }) => {
    const onContentChange = vi.fn<(content: string) => void>();
    act(() => {
      root.render(
        <EditorPane
          activePath="/workspace/notes.md"
          content="replace me"
          documentEpoch={1}
          documentId="document-notes"
          onContentChange={onContentChange}
        />,
      );
    });
    const editor = container.querySelector<HTMLElement>('.cm-editor');
    const view = editor ? EditorView.findFromDOM(editor) : null;
    if (!view) throw new Error('Expected CodeMirror editor');
    act(() => view.dispatch({ selection: { anchor: 0, head: view.state.doc.length } }));

    let event: ClipboardEvent | undefined;
    act(() => {
      event = dispatchPaste(view, input);
    });

    expect(event?.defaultPrevented).toBe(true);
    expect(view.state.doc.toString()).toBe(expected);
    expect(undoDepth(view.state)).toBe(1);
    expect(onContentChange).toHaveBeenCalledOnce();
    act(() => expect(undo(view)).toBe(true));
    expect(view.state.doc.toString()).toBe('replace me');
  });

  it('persists a clipboard image and inserts the returned Markdown only while the editor is current', async () => {
    let resolveImage: ((markdown: string | null) => void) | undefined;
    const onPasteImage = vi.fn<() => Promise<string | null>>(() => new Promise<string | null>((resolve) => {
      resolveImage = resolve;
    }));
    const onContentChange = vi.fn<(content: string) => void>();
    const render = (documentEpoch: number, editable = true) => root.render(
      <EditorPane
        activePath="/workspace/notes.md"
        content="draft"
        documentEpoch={documentEpoch}
        documentId={documentEpoch === 1 ? 'document-notes' : 'document-next'}
        editable={editable}
        onContentChange={onContentChange}
        onPasteImage={onPasteImage}
      />,
    );
    act(() => render(1));
    const editor = container.querySelector<HTMLElement>('.cm-editor');
    const view = editor ? EditorView.findFromDOM(editor) : null;
    if (!view) throw new Error('Expected CodeMirror editor');
    const image = new File([new Uint8Array([1, 2, 3])], 'clipboard.png', { type: 'image/png' });

    let event: ClipboardEvent | undefined;
    act(() => {
      event = dispatchPaste(view, { image });
    });
    expect(event?.defaultPrevented).toBe(true);
    expect(onPasteImage).toHaveBeenCalledWith(expect.objectContaining({
      blob: image,
      documentEpoch: 1,
      documentId: 'document-notes',
      mimeType: 'image/png',
      suggestedName: 'clipboard.png',
    }));

    act(() => render(2));
    await act(async () => {
      resolveImage?.('![clipboard.png](assets/clipboard.png)');
      await Promise.resolve();
    });

    expect(onContentChange).not.toHaveBeenCalled();
    expect(container.querySelector('.cm-content')?.textContent).toBe('draft');
  });

  it('inserts a persisted clipboard image reference as one undoable editor change', async () => {
    const markdown = '![clipboard.png](../assets/clipboard.png)';
    const onContentChange = vi.fn<(content: string) => void>();
    act(() => {
      root.render(
        <EditorPane
          activePath="/workspace/notes.md"
          content="draft"
          documentEpoch={1}
          documentId="document-notes"
          onContentChange={onContentChange}
          onPasteImage={vi.fn<() => Promise<string | null>>(async () => markdown)}
        />,
      );
    });
    const editor = container.querySelector<HTMLElement>('.cm-editor');
    const view = editor ? EditorView.findFromDOM(editor) : null;
    if (!view) throw new Error('Expected CodeMirror editor');
    act(() => view.dispatch({ selection: { anchor: view.state.doc.length } }));

    await act(async () => {
      dispatchPaste(view, {
        image: new File([new Uint8Array([1])], 'clipboard.png', { type: 'image/png' }),
      });
      await Promise.resolve();
    });

    expect(view.state.doc.toString()).toBe(`draft${markdown}`);
    expect(undoDepth(view.state)).toBe(1);
    expect(onContentChange).toHaveBeenCalledOnce();
    act(() => expect(undo(view)).toBe(true));
    expect(view.state.doc.toString()).toBe('draft');
  });



  it('falls back to cleaned plain text when rich conversion fails and reports formatting loss', () => {
    const onContentChange = vi.fn<(content: string) => void>();
    const onPasteError = vi.fn<(error: unknown) => void>();
    act(() => {
      root.render(
        <EditorPane
          activePath="/workspace/notes.md"
          content="draft"
          documentEpoch={1}
          documentId="document-notes"
          onContentChange={onContentChange}
          onPasteError={onPasteError}
        />,
      );
    });
    const editor = container.querySelector<HTMLElement>('.cm-editor');
    const view = editor ? EditorView.findFromDOM(editor) : null;
    if (!view) throw new Error('Expected CodeMirror editor');
    act(() => view.dispatch({ selection: { anchor: 0, head: view.state.doc.length } }));

    let event: ClipboardEvent | undefined;
    act(() => {
      event = dispatchPaste(view, {
        html: '<script>alert(1)</script>',
        text: '  safe plain  ',
      });
    });

    expect(event?.defaultPrevented).toBe(true);
    expect(view.state.doc.toString()).toBe('safe plain');
    expect(undoDepth(view.state)).toBe(1);
    expect(onPasteError).toHaveBeenCalledWith(expect.objectContaining({
      message: expect.stringContaining('cleaned plain text'),
    }));
    expect(onContentChange).toHaveBeenCalledOnce();
  });

  it('inserts mixed rich text and all clipboard images as one mapped undoable transaction', async () => {
    const imageOne = new File([new Uint8Array([1])], 'one.png', { type: 'image/png' });
    const imageTwo = new File([new Uint8Array([2])], 'two.png', { type: 'image/png' });
    const imageResults = new Map<string, string>([
      ['one.png', '![one.png](assets/one.png)'],
      ['two.png', '![two.png](assets/two.png)'],
    ]);
    const onPasteImage = vi.fn<(request: { suggestedName: string | null }) => Promise<string | null>>(async (request) => (
      imageResults.get(request.suggestedName ?? '') ?? null
    ));
    const onContentChange = vi.fn<(content: string) => void>();
    act(() => {
      root.render(
        <EditorPane
          activePath="/workspace/notes.md"
          content="abcdef"
          documentEpoch={1}
          documentId="document-notes"
          onContentChange={onContentChange}
          onPasteImage={onPasteImage}
        />,
      );
    });
    const editor = container.querySelector<HTMLElement>('.cm-editor');
    const view = editor ? EditorView.findFromDOM(editor) : null;
    if (!view) throw new Error('Expected CodeMirror editor');
    act(() => view.dispatch({ selection: { anchor: 3 } }));

    await act(async () => {
      dispatchPaste(view, {
        html: '<p><strong>Rich</strong> text</p>',
        images: [imageOne, imageTwo],
        text: 'Rich text',
      });
      view.dispatch({
        changes: { from: 0, insert: '>>' },
        selection: { anchor: view.state.doc.length + 2 },
      });
      await Promise.resolve();
    });

    expect(onPasteImage).toHaveBeenCalledTimes(2);
    expect(view.state.doc.toString()).toBe([
      '>>abc**Rich** text',
      '',
      '![one.png](assets/one.png)',
      '',
      '![two.png](assets/two.png)def',
    ].join('\n'));
    expect(undoDepth(view.state)).toBe(2);
    act(() => expect(undo(view)).toBe(true));
    expect(view.state.doc.toString()).toBe('>>abcdef');
  });

  it('rejects SVG and oversized clipboard images before invoking the image paste callback', () => {
    const onPasteImage = vi.fn<() => Promise<string | null>>();
    const onPasteError = vi.fn<(error: unknown) => void>();
    act(() => {
      root.render(
        <EditorPane
          activePath="/workspace/notes.md"
          content="draft"
          documentEpoch={1}
          documentId="document-notes"
          onContentChange={vi.fn<(content: string) => void>()}
          onPasteError={onPasteError}
          onPasteImage={onPasteImage}
        />,
      );
    });
    const editor = container.querySelector<HTMLElement>('.cm-editor');
    const view = editor ? EditorView.findFromDOM(editor) : null;
    if (!view) throw new Error('Expected CodeMirror editor');
    const oversized = new File([new Uint8Array([1])], 'large.png', { type: 'image/png' });
    Object.defineProperty(oversized, 'size', { configurable: true, value: 16 * 1024 * 1024 + 1 });

    let event: ClipboardEvent | undefined;
    act(() => {
      event = dispatchPaste(view, {
        images: [
          new File(['<svg></svg>'], 'unsafe.svg', { type: 'image/svg+xml' }),
          oversized,
        ],
      });
    });

    expect(event?.defaultPrevented).toBe(true);
    expect(onPasteImage).not.toHaveBeenCalled();
    expect(onPasteError).toHaveBeenCalledWith(expect.objectContaining({
      message: expect.stringContaining('SVG clipboard images'),
    }));
    expect(view.state.doc.toString()).toBe('draft');
  });

  it.each([
    { editable: false, expected: 'draft', fileKind: 'markdown' as const },
    { editable: true, expected: 'Richdraft', fileKind: 'html' as const },
  ])('does not handle rich paste for $fileKind when editable=$editable', ({ editable, expected, fileKind }) => {
    const onPasteImage = vi.fn<() => Promise<string | null>>();
    act(() => {
      root.render(
        <EditorPane
          activePath="/workspace/notes.md"
          content="draft"
          documentEpoch={1}
          documentId="document-notes"
          editable={editable}
          fileKind={fileKind}
          onContentChange={vi.fn<(content: string) => void>()}
          onPasteImage={onPasteImage}
        />,
      );
    });
    const editor = container.querySelector<HTMLElement>('.cm-editor');
    const view = editor ? EditorView.findFromDOM(editor) : null;
    if (!view) throw new Error('Expected CodeMirror editor');

    act(() => {
      dispatchPaste(view, { html: '<strong>Rich</strong>', text: 'Rich' });
    });

    expect(view.state.doc.toString()).toBe(expected);
    expect(onPasteImage).not.toHaveBeenCalled();
  });

  it('renders a native CodeMirror editor with line numbers', () => {
    act(() => {
      root.render(
        <EditorPane
          activePath="/workspace/notes.md"
          content="# Notes"
          documentEpoch={1}
          documentId="document-notes"
          onContentChange={vi.fn<(content: string) => void>()}
        />,
      );
    });

    expect(container.querySelector('textarea')).toBeNull();
    expect(container.querySelector('.cm-editor')).not.toBeNull();
    expect(container.querySelector('.cm-gutters')).not.toBeNull();
    expect(container.querySelector('.cm-content')?.classList.contains('cm-lineWrapping'))
      .toBe(true);
    expect(container.querySelector('[role="textbox"]')?.getAttribute('aria-label'))
      .toBe('Markdown source editor');
  });

  it('reconfigures spellcheck without replacing the active editor session', () => {
    const onContentChange = vi.fn<(content: string) => void>();
    const render = (spellcheckEnabled: boolean) => {
      root.render(
        <EditorPane
          activePath="/workspace/notes.md"
          content="draft"
          documentEpoch={1}
          documentId="document-notes"
          onContentChange={onContentChange}
          spellcheckEnabled={spellcheckEnabled}
        />,
      );
    };

    act(() => render(false));
    const editor = container.querySelector<HTMLElement>('.cm-editor');
    const view = editor ? EditorView.findFromDOM(editor) : null;
    if (!view) throw new Error('Expected CodeMirror editor');
    expect(view.contentDOM.getAttribute('spellcheck')).toBe('false');

    act(() => {
      view.dispatch({ selection: { anchor: 3 } });
      render(true);
    });

    expect(EditorView.findFromDOM(container.querySelector<HTMLElement>('.cm-editor')!)).toBe(view);
    expect(view.contentDOM.getAttribute('spellcheck')).toBe('true');
    expect(view.state.doc.toString()).toBe('draft');
    expect(view.state.selection.main.head).toBe(3);
    expect(onContentChange).not.toHaveBeenCalled();
  });

  it('applies Markdown completion as one undoable editor transaction', () => {
    const onContentChange = vi.fn<(content: string) => void>();
    const fetch = vi.fn<typeof globalThis.fetch>();
    const xmlHttpRequest = vi.fn<() => XMLHttpRequest>();
    vi.stubGlobal('fetch', fetch);
    vi.stubGlobal('XMLHttpRequest', xmlHttpRequest);
    act(() => {
      root.render(
        <EditorPane
          activePath="/workspace/notes.md"
          content=""
          documentEpoch={1}
          documentId="document-notes"
          onContentChange={onContentChange}
        />,
      );
    });
    const editor = container.querySelector<HTMLElement>('.cm-editor');
    const view = editor ? EditorView.findFromDOM(editor) : null;
    if (!view) throw new Error('Expected CodeMirror editor');
    const runInputHandlers = (from: number, to: number, text: string) => (
      view.state.facet(EditorView.inputHandler).some((handler) => handler(view, from, to, text, () => view.state.update({
        changes: { from, to, insert: text },
        selection: { anchor: from + text.length },
        userEvent: 'input.type',
      })))
    );

    let handled = false;
    act(() => {
      handled = runInputHandlers(0, 0, '[');
    });

    expect(handled).toBe(true);
    expect(view.state.doc.toString()).toBe('[]()');
    expect(view.state.selection.main).toMatchObject({ from: 1, to: 1 });
    expect(onContentChange).toHaveBeenCalledOnce();
    expect(onContentChange).toHaveBeenCalledWith('[]()');
    expect(fetch).not.toHaveBeenCalled();
    expect(xmlHttpRequest).not.toHaveBeenCalled();

    act(() => expect(undo(view)).toBe(true));
    expect(view.state.doc.toString()).toBe('');
    expect(view.state.selection.main).toMatchObject({ from: 0, to: 0 });
  });

  it('applies alert completion as one undoable transaction with its marker selected', () => {
    const onContentChange = vi.fn<(content: string) => void>();
    act(() => {
      root.render(
        <EditorPane
          activePath="/workspace/notes.md"
          content="> ["
          documentEpoch={1}
          documentId="document-notes"
          onContentChange={onContentChange}
        />,
      );
    });
    const editor = container.querySelector<HTMLElement>('.cm-editor');
    const view = editor ? EditorView.findFromDOM(editor) : null;
    if (!view) throw new Error('Expected CodeMirror editor');
    act(() => view.dispatch({ selection: { anchor: view.state.doc.length } }));
    const handler = view.state.facet(EditorView.inputHandler).find((inputHandler) => (
      inputHandler(view, 3, 3, '!', () => view.state.update({
        changes: { from: 3, insert: '!' },
        selection: { anchor: 4 },
        userEvent: 'input.type',
      }))
    ));

    expect(handler).toBeDefined();
    expect(view.state.doc.toString()).toBe('> [!TIP]\n> ');
    expect(view.state.selection.main).toMatchObject({ from: 4, to: 7 });
    expect(onContentChange).toHaveBeenCalledOnce();
    act(() => expect(undo(view)).toBe(true));
    expect(view.state.doc.toString()).toBe('> [');
    expect(view.state.selection.main).toMatchObject({ from: 3, to: 3 });
  });

  it('keeps the cursor after generated markers so normal content and alerts can follow', () => {
    act(() => {
      root.render(
        <EditorPane
          activePath="/workspace/notes.md"
          content=""
          documentEpoch={1}
          documentId="document-notes"
          onContentChange={vi.fn<(content: string) => void>()}
        />,
      );
    });
    const editor = container.querySelector<HTMLElement>('.cm-editor');
    const view = editor ? EditorView.findFromDOM(editor) : null;
    if (!view) throw new Error('Expected CodeMirror editor');
    const type = (text: string) => {
      const { from, to } = view.state.selection.main;
      const insert = () => view.state.update({
        changes: { from, to, insert: text },
        selection: { anchor: from + text.length },
        userEvent: 'input.type',
      });
      const handled = view.state.facet(EditorView.inputHandler).some((handler) => (
        handler(view, from, to, text, insert)
      ));
      if (!handled) view.dispatch(insert());
    };

    act(() => type('>'));
    expect(view.state.doc.toString()).toBe('> ');
    expect(view.state.selection.main).toMatchObject({ from: 2, to: 2 });
    act(() => type('['));
    expect(view.state.doc.toString()).toBe('> [');
    act(() => type('!'));
    expect(view.state.doc.toString()).toBe('> [!TIP]\n> ');
    expect(view.state.selection.main).toMatchObject({ from: 4, to: 7 });
  });

  it('continues lists through the Markdown completion Enter binding and restores them with undo', () => {
    const onContentChange = vi.fn<(content: string) => void>();
    act(() => {
      root.render(
        <EditorPane
          activePath="/workspace/notes.md"
          content="- item"
          documentEpoch={1}
          documentId="document-notes"
          onContentChange={onContentChange}
        />,
      );
    });
    const editor = container.querySelector<HTMLElement>('.cm-editor');
    const view = editor ? EditorView.findFromDOM(editor) : null;
    if (!view) throw new Error('Expected CodeMirror editor');
    act(() => view.dispatch({ selection: { anchor: view.state.doc.length } }));
    const enter = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Enter' });

    let handled = false;
    act(() => {
      handled = runScopeHandlers(view, enter, 'editor');
    });

    expect(handled).toBe(true);
    expect(view.state.doc.toString()).toBe('- item\n- ');
    expect(view.state.selection.main).toMatchObject({ from: 9, to: 9 });
    expect(onContentChange).toHaveBeenCalledOnce();
    act(() => expect(undo(view)).toBe(true));
    expect(view.state.doc.toString()).toBe('- item');
    expect(view.state.selection.main).toMatchObject({ from: 6, to: 6 });
  });

  it('leaves pasted, composing, selected, and multi-cursor input to CodeMirror defaults', () => {
    act(() => {
      root.render(
        <EditorPane
          activePath="/workspace/notes.md"
          content="selected"
          documentEpoch={1}
          documentId="document-notes"
          onContentChange={vi.fn<(content: string) => void>()}
        />,
      );
    });
    const editor = container.querySelector<HTMLElement>('.cm-editor');
    const view = editor ? EditorView.findFromDOM(editor) : null;
    if (!view) throw new Error('Expected CodeMirror editor');
    const applyInputWithDefault = (from: number, to: number, text: string) => {
      const insert = () => view.state.update({
        changes: { from, to, insert: text },
        selection: { anchor: from + text.length },
        userEvent: 'input.type',
      });
      const handled = view.state.facet(EditorView.inputHandler).some((handler) => (
        handler(view, from, to, text, insert)
      ));
      if (!handled) view.dispatch(insert());
      return handled;
    };
    act(() => view.dispatch({ selection: { anchor: 0, head: view.state.doc.length } }));
    let selectedHandled = false;
    act(() => {
      selectedHandled = applyInputWithDefault(0, view.state.doc.length, '[');
    });
    expect(selectedHandled).toBe(false);
    expect(view.state.doc.toString()).toBe('[');

    vi.useFakeTimers();
    act(() => view.dispatch({ selection: { anchor: view.state.doc.length } }));
    act(() => view.contentDOM.dispatchEvent(new Event('paste', { bubbles: true })));
    let pastedHandled = false;
    act(() => {
      pastedHandled = applyInputWithDefault(view.state.doc.length, view.state.doc.length, '[');
    });
    expect(pastedHandled).toBe(false);
    expect(view.state.doc.toString()).toBe('[[');

    act(() => view.contentDOM.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })));
    let composingHandled = false;
    act(() => {
      composingHandled = applyInputWithDefault(view.state.doc.length, view.state.doc.length, '[');
    });
    expect(composingHandled).toBe(false);
    expect(view.state.doc.toString()).toBe('[[[');
    act(() => view.contentDOM.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true })));
    act(() => vi.runAllTimers());
    let typedHandled = false;
    act(() => {
      typedHandled = applyInputWithDefault(view.state.doc.length, view.state.doc.length, '[');
    });
    expect(typedHandled).toBe(true);
    expect(view.state.doc.toString()).toBe('[[[[]()');

    const completionHost = document.createElement('div');
    document.body.append(completionHost);
    const completionView = new EditorView({
      parent: completionHost,
      state: EditorState.create({
        doc: 'xy',
        extensions: [
          EditorState.allowMultipleSelections.of(true),
          markdownCompletionExtension(() => true),
        ],
      }),
    });
    completionView.dispatch({ selection: EditorSelection.create([
      EditorSelection.cursor(0),
      EditorSelection.cursor(completionView.state.doc.length),
    ]) });
    const completionHandler = completionView.state.facet(EditorView.inputHandler)[0];
    if (!completionHandler) throw new Error('Expected Markdown completion input handler');
    const multiCursorHandled = completionHandler(completionView, 0, 0, '[', () => completionView.state.update({
        changes: { from: 0, insert: '[' },
        selection: { anchor: 1 },
        userEvent: 'input.type',
      }));
    expect(multiCursorHandled).toBe(false);
    completionView.destroy();
    completionHost.remove();
  });

  it('preserves the active editor session while every application skin is applied', () => {
    const onContentChange = vi.fn<(content: string) => void>();
    const documentId = 'document-unsaved-theme-check';
    act(() => {
      root.render(
        <section data-dirty="true" data-document-id={documentId}>
          <EditorPane
            activePath="/workspace/unsaved.md"
            content={'# Unsaved\n\nKeep this draft.'}
            documentEpoch={9}
            documentId={documentId}
            onContentChange={onContentChange}
          />
        </section>,
      );
    });
    const sessionElement = container.querySelector<HTMLElement>('[data-document-id]');
    const editor = container.querySelector<HTMLElement>('.cm-editor');
    const initialView = editor ? EditorView.findFromDOM(editor) : null;
    if (!initialView || !sessionElement) throw new Error('Expected active editor session');

    act(() => {
      initialView.dispatch({ selection: { anchor: 12 } });
      initialView.scrollDOM.scrollTop = 37;
    });

    for (const skin of SKIN_IDS) {
      applyEffectiveTheme(document.documentElement, {
        appearance: skin === 'shanshui-yemo' ? 'dark' : 'light',
        skin,
      });
    }

    const currentEditor = container.querySelector<HTMLElement>('.cm-editor');
    const currentView = currentEditor ? EditorView.findFromDOM(currentEditor) : null;
    expect(currentView).toBe(initialView);
    expect(currentView?.state.doc.toString()).toBe('# Unsaved\n\nKeep this draft.');
    expect(currentView?.state.selection.main.head).toBe(12);
    expect(currentView?.scrollDOM.scrollTop).toBe(37);
    expect(sessionElement.dataset.documentId).toBe(documentId);
    expect(sessionElement.dataset.dirty).toBe('true');
    expect(onContentChange).not.toHaveBeenCalled();
  });

  it('shows live document statistics and the current cursor location', () => {
    const content = 'Hello 世界\nnext';
    act(() => {
      root.render(
        <EditorPane
          activePath="/workspace/notes.md"
          content={content}
          documentEpoch={1}
          documentId="document-notes"
          onContentChange={vi.fn<(value: string) => void>()}
        />,
      );
    });
    const editor = container.querySelector<HTMLElement>('.cm-editor');
    const view = editor ? EditorView.findFromDOM(editor) : null;
    if (!view) throw new Error('Expected CodeMirror editor');
    const status = container.querySelector<HTMLElement>('[aria-label="Editor status"]');

    expect(status?.textContent).toContain('Words 4');
    expect(status?.textContent).toContain('Characters 13');
    expect(status?.textContent).toContain('Lines 2');
    expect(status?.textContent).toContain('Line 1, Column 1');

    act(() => view.dispatch({ selection: { anchor: 11 } }));
    expect(status?.textContent).toContain('Line 2, Column 3');

    const idleCallbacks = new Map<number, IdleRequestCallback>();
    const cancelIdleCallback = vi.fn<(id: number) => void>((id) => {
      idleCallbacks.delete(id);
    });
    let nextIdleCallbackId = 1;
    vi.useFakeTimers();
    vi.stubGlobal('requestIdleCallback', (callback: IdleRequestCallback) => {
      const id = nextIdleCallbackId;
      nextIdleCallbackId += 1;
      idleCallbacks.set(id, callback);
      return id;
    });
    vi.stubGlobal('cancelIdleCallback', cancelIdleCallback);

    act(() => view.dispatch({ changes: { from: view.state.doc.length, insert: '!' } }));
    act(() => view.dispatch({ changes: { from: view.state.doc.length, insert: '?' } }));

    expect(status?.textContent).toContain('Characters 13');
    expect(cancelIdleCallback).not.toHaveBeenCalled();
    expect(idleCallbacks.size).toBe(0);

    act(() => vi.advanceTimersByTime(120));
    expect([...idleCallbacks.keys()]).toEqual([1]);

    const callback = idleCallbacks.get(1);
    if (!callback) throw new Error('Expected document statistics idle callback');
    act(() => callback({ didTimeout: false, timeRemaining: () => 50 }));

    expect(status?.textContent).toContain('Characters 15');
  });

  it('reports the visual cursor column when a line contains a tab', () => {
    act(() => {
      root.render(
        <EditorPane
          activePath="/workspace/notes.md"
          content={'\titem'}
          documentEpoch={1}
          documentId="document-notes"
          onContentChange={vi.fn<(value: string) => void>()}
        />,
      );
    });
    const editor = container.querySelector<HTMLElement>('.cm-editor');
    const view = editor ? EditorView.findFromDOM(editor) : null;
    if (!view) throw new Error('Expected CodeMirror editor');
    const status = container.querySelector<HTMLElement>('[aria-label="Editor status"]');

    act(() => view.dispatch({ selection: { anchor: 1 } }));
    expect(status?.textContent).toContain('Line 1, Column 3');
  });

  it('refreshes document statistics after an external content update', () => {
    const idleCallbacks = new Map<number, IdleRequestCallback>();
    let nextIdleCallbackId = 1;
    vi.useFakeTimers();
    vi.stubGlobal('requestIdleCallback', (callback: IdleRequestCallback) => {
      const id = nextIdleCallbackId;
      nextIdleCallbackId += 1;
      idleCallbacks.set(id, callback);
      return id;
    });
    vi.stubGlobal('cancelIdleCallback', (id: number) => idleCallbacks.delete(id));
    const renderEditor = (content: string) => (
      <EditorPane
        activePath="/workspace/notes.md"
        content={content}
        documentEpoch={1}
        documentId="document-notes"
        onContentChange={vi.fn<(value: string) => void>()}
      />
    );
    act(() => root.render(renderEditor('one')));
    const status = container.querySelector<HTMLElement>('[aria-label="Editor status"]');
    expect(status?.textContent).toContain('Words 1');
    expect(status?.textContent).toContain('Characters 3');

    act(() => root.render(renderEditor('one\ntwo')));
    expect(status?.textContent).toContain('Words 1');
    act(() => vi.advanceTimersByTime(120));
    const callback = idleCallbacks.get(1);
    if (!callback) throw new Error('Expected external document statistics idle callback');
    act(() => callback({ didTimeout: false, timeRemaining: () => 50 }));

    expect(status?.textContent).toContain('Words 2');
    expect(status?.textContent).toContain('Characters 7');
    expect(status?.textContent).toContain('Lines 2');
  });

  it('does not apply deferred statistics from a replaced document', () => {
    const idleCallbacks = new Map<number, IdleRequestCallback>();
    let nextIdleCallbackId = 1;
    vi.useFakeTimers();
    vi.stubGlobal('requestIdleCallback', (callback: IdleRequestCallback) => {
      const id = nextIdleCallbackId;
      nextIdleCallbackId += 1;
      idleCallbacks.set(id, callback);
      return id;
    });
    vi.stubGlobal('cancelIdleCallback', vi.fn<(id: number) => void>());

    act(() => {
      root.render(
        <EditorPane
          activePath="/workspace/old.md"
          content="old"
          documentEpoch={1}
          documentId="document-old"
          onContentChange={vi.fn<(value: string) => void>()}
        />,
      );
    });
    const editor = container.querySelector<HTMLElement>('.cm-editor');
    const view = editor ? EditorView.findFromDOM(editor) : null;
    if (!view) throw new Error('Expected CodeMirror editor');

    act(() => view.dispatch({ changes: { from: view.state.doc.length, insert: '!' } }));
    act(() => vi.advanceTimersByTime(120));
    const staleCallback = idleCallbacks.get(1);
    if (!staleCallback) throw new Error('Expected old document statistics idle callback');

    act(() => {
      root.render(
        <EditorPane
          activePath="/workspace/new.md"
          content="新"
          documentEpoch={2}
          documentId="document-new"
          onContentChange={vi.fn<(value: string) => void>()}
        />,
      );
    });
    const status = container.querySelector<HTMLElement>('[aria-label="Editor status"]');
    expect(status?.textContent).toContain('Characters 1');

    act(() => staleCallback({ didTimeout: false, timeRemaining: () => 50 }));

    expect(status?.textContent).toContain('Words 1');
    expect(status?.textContent).toContain('Characters 1');
    expect(status?.textContent).toContain('Lines 1');
  });

  it('moves to an outline heading and requests CodeMirror scrolling', () => {
    const content = '# Project\n\n## Install';
    act(() => {
      root.render(
        <EditorPane
          activePath="/workspace/guide.md"
          content={content}
          documentEpoch={1}
          documentId="document-guide"
          onContentChange={vi.fn<(value: string) => void>()}
        />,
      );
    });
    const editor = container.querySelector<HTMLElement>('.cm-editor');
    const view = editor ? EditorView.findFromDOM(editor) : null;
    if (!view) throw new Error('Expected CodeMirror editor');
    const dispatch = vi.spyOn(view, 'dispatch');

    act(() => {
      root.render(
        <EditorPane
          activePath="/workspace/guide.md"
          content={content}
          documentEpoch={1}
          documentId="document-guide"
          outlineJump={{
            documentId: 'document-guide',
            documentEpoch: 1,
            item: {
              depth: 1,
              id: 'heading-11',
              level: 2,
              line: 3,
              offset: 11,
              ordinal: 1,
              text: 'Install',
            },
            requestId: 1,
          }}
          onContentChange={vi.fn<(value: string) => void>()}
        />,
      );
    });

    expect(view.state.selection.main.head).toBe(11);
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({
      scrollIntoView: true,
      selection: { anchor: 11 },
    }));
  });

  it('uses the heading line instead of a CRLF source offset', () => {
    const content = '# Project\r\n\r\n## Install';
    act(() => {
      root.render(
        <EditorPane
          activePath="/workspace/guide.md"
          content={content}
          documentEpoch={1}
          documentId="document-guide"
          outlineJump={{
            documentId: 'document-guide',
            documentEpoch: 1,
            item: {
              depth: 1,
              id: 'heading-13',
              level: 2,
              line: 3,
              offset: 13,
              ordinal: 1,
              text: 'Install',
            },
            requestId: 2,
          }}
          onContentChange={vi.fn<(value: string) => void>()}
        />,
      );
    });
    const editor = container.querySelector<HTMLElement>('.cm-editor');
    const view = editor ? EditorView.findFromDOM(editor) : null;

    expect(view?.state.doc.toString()).toBe('# Project\n\n## Install');
    expect(view?.state.selection.main.head).toBe(11);
  });

  it('inserts a dropped media reference at the release position as one undoable edit', () => {
    const onContentChange = vi.fn<(content: string) => void>();
    const content = 'before after';
    act(() => {
      root.render(
        <EditorPane
          activePath="/workspace/guide.md"
          content={content}
          documentEpoch={1}
          documentId="document-guide"
          onContentChange={onContentChange}
        />,
      );
    });
    const editor = container.querySelector<HTMLElement>('.cm-editor');
    const view = editor ? EditorView.findFromDOM(editor) : null;
    if (!view) throw new Error('Expected CodeMirror editor');
    const posAtCoords = vi.spyOn(view, 'posAtCoords').mockReturnValue(7);

    act(() => {
      root.render(
        <EditorPane
          activePath="/workspace/guide.md"
          content={content}
          documentEpoch={1}
          documentId="document-guide"
          mediaInsertion={{
            documentEpoch: 1,
            documentId: 'document-guide',
            markdown: '![cover.png](assets/cover.png)',
            requestId: 1,
            target: { kind: 'coordinates', clientX: 120, clientY: 80 },
          }}
          onContentChange={onContentChange}
        />,
      );
    });

    expect(posAtCoords).toHaveBeenCalledWith({ x: 120, y: 80 });
    expect(view.state.doc.toString()).toBe('before ![cover.png](assets/cover.png)after');
    expect(view.state.selection.main.head).toBe(37);
    expect(onContentChange).toHaveBeenCalledWith('before ![cover.png](assets/cover.png)after');

    act(() => undo(view));
    expect(view.state.doc.toString()).toBe(content);
  });

  it('inserts a context-menu media reference at the current cursor', () => {
    const content = 'before after';
    const onContentChange = vi.fn<(nextContent: string) => void>();
    act(() => root.render(
      <EditorPane
        activePath="/workspace/guide.md"
        content={content}
        documentEpoch={1}
        documentId="document-guide"
        onContentChange={onContentChange}
      />,
    ));
    const editor = container.querySelector<HTMLElement>('.cm-editor');
    const view = editor ? EditorView.findFromDOM(editor) : null;
    if (!view) throw new Error('Expected CodeMirror editor');
    act(() => view.dispatch({ selection: { anchor: 7 } }));
    const posAtCoords = vi.spyOn(view, 'posAtCoords');

    act(() => root.render(
      <EditorPane
        activePath="/workspace/guide.md"
        content={content}
        documentEpoch={1}
        documentId="document-guide"
        mediaInsertion={{
          documentEpoch: 1,
          documentId: 'document-guide',
          markdown: '[intro.mp3](audio/intro.mp3)',
          requestId: 1,
          target: { kind: 'cursor' },
        }}
        onContentChange={onContentChange}
      />,
    ));

    expect(posAtCoords).not.toHaveBeenCalled();
    expect(view.state.doc.toString()).toBe('before [intro.mp3](audio/intro.mp3)after');
    expect(onContentChange).toHaveBeenCalledWith('before [intro.mp3](audio/intro.mp3)after');

    act(() => undo(view));
    expect(view.state.doc.toString()).toBe(content);
  });

  it('does not insert dropped media into a read-only editor', () => {
    const onContentChange = vi.fn<(content: string) => void>();
    act(() => {
      root.render(
        <EditorPane
          activePath="/workspace/guide.md"
          content="protected"
          documentEpoch={1}
          documentId="document-guide"
          editable={false}
          mediaInsertion={{
            documentEpoch: 1,
            documentId: 'document-guide',
            markdown: '![cover.png](assets/cover.png)',
            requestId: 1,
            target: { kind: 'coordinates', clientX: 120, clientY: 80 },
          }}
          onContentChange={onContentChange}
        />,
      );
    });
    const editor = container.querySelector<HTMLElement>('.cm-editor');
    const view = editor ? EditorView.findFromDOM(editor) : null;

    expect(view?.state.doc.toString()).toBe('protected');
    expect(onContentChange).not.toHaveBeenCalled();
  });

  it('ignores an outline jump from a previous document epoch', () => {
    act(() => {
      root.render(
        <EditorPane
          activePath="/workspace/guide.md"
          content="# Replacement\n\n## Install"
          documentEpoch={2}
          documentId="document-guide"
          onContentChange={vi.fn<(value: string) => void>()}
        />,
      );
    });
    act(() => {
      root.render(
        <EditorPane
          activePath="/workspace/guide.md"
          content="# Replacement\n\n## Install"
          documentEpoch={2}
          documentId="document-guide"
          outlineJump={{
            documentId: 'document-guide',
            documentEpoch: 1,
            item: {
              depth: 1,
              id: 'heading-11',
              level: 2,
              line: 3,
              offset: 11,
              ordinal: 1,
              text: 'Install',
            },
            requestId: 3,
          }}
          onContentChange={vi.fn<(value: string) => void>()}
        />,
      );
    });
    const editor = container.querySelector<HTMLElement>('.cm-editor');
    const view = editor ? EditorView.findFromDOM(editor) : null;

    expect(view?.state.selection.main.head).toBe(0);
  });

  it('toggles Vim editing mode from the button immediately before pop out', () => {
    act(() => {
      root.render(
        <EditorPane
          activePath="/workspace/notes.md"
          content="# Notes"
          documentEpoch={1}
          documentId="document-notes"
          onContentChange={vi.fn<(content: string) => void>()}
          onPopout={vi.fn<() => void>()}
          popoutButton={getPanePopoutButtonState('editor', false)}
        />,
      );
    });

    const vimButton = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Enable Vim editing mode"]',
    );
    const popoutButton = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Pop out editor"]',
    );

    expect(vimButton).not.toBeNull();
    expect(vimButton?.getAttribute('aria-pressed')).toBe('false');
    expect(vimButton?.querySelector('svg.vim-logo')).not.toBeNull();
    expect(vimButton?.nextElementSibling).toBe(popoutButton);

    act(() => {
      vimButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    const activeVimButton = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Disable Vim editing mode"]',
    );
    expect(activeVimButton?.getAttribute('aria-pressed')).toBe('true');
  });

  it('handles Vim normal-mode commands after Vim editing mode is enabled', () => {
    const onContentChange = vi.fn<(content: string) => void>();
    act(() => {
      root.render(
        <EditorPane
          activePath="/workspace/notes.md"
          content="alpha"
          documentEpoch={1}
          documentId="document-notes"
          onContentChange={onContentChange}
        />,
      );
    });
    const editor = container.querySelector<HTMLElement>('.cm-editor');
    const view = editor ? EditorView.findFromDOM(editor) : null;
    const vimButton = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Enable Vim editing mode"]',
    );
    if (!view || !vimButton) throw new Error('Expected editor and Vim mode button');

    act(() => {
      vimButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    act(() => {
      view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', {
        bubbles: true,
        key: 'x',
      }));
    });

    expect(view.state.doc.toString()).toBe('lpha');
    expect(onContentChange).toHaveBeenCalledOnce();
    expect(onContentChange).toHaveBeenCalledWith('lpha');
  });

  it('opens an accessible Markdown editor context menu and applies existing format commands', () => {
    const onContentChange = vi.fn<(content: string) => void>();
    act(() => {
      root.render(
        <EditorPane
          activePath="/workspace/notes.md"
          content="alpha beta"
          documentEpoch={1}
          documentId="document-notes"
          onContentChange={onContentChange}
        />,
      );
    });
    const editor = container.querySelector<HTMLElement>('.cm-editor');
    const view = editor ? EditorView.findFromDOM(editor) : null;
    if (!view) throw new Error('Expected CodeMirror editor');
    act(() => view.dispatch({ selection: { anchor: 0, head: 5 } }));

    let event: MouseEvent | undefined;
    act(() => {
      event = dispatchEditorContextMenu(view, 42, 72);
    });

    const menu = container.querySelector<HTMLElement>('[role="menu"][data-editor-context-menu="true"]');
    expect(event?.defaultPrevented).toBe(true);
    expect(menu).not.toBeNull();
    expect(menu?.style.left).toBe('42px');
    expect(menu?.style.top).toBe('72px');
    expect(container.querySelector('[role="menuitem"][data-context-command-id="bold"]')?.textContent)
      .toContain('Bold');
    expect(container.querySelector('[role="menuitem"][data-context-action-id="insert-table"]')?.textContent)
      .toContain('Table');

    act(() => {
      container.querySelector<HTMLButtonElement>('[data-context-command-id="bold"]')?.click();
    });

    expect(container.querySelector('[data-editor-context-menu="true"]')).toBeNull();
    expect(view.state.doc.toString()).toBe('**alpha** beta');
    expect(view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to))
      .toBe('alpha');
    expect(undoDepth(view.state)).toBe(1);
    expect(onContentChange).toHaveBeenCalledWith('**alpha** beta');
  });

  it.each([
    ['insert-table', '| Header | Header |\n| --- | --- |\n| Cell | Cell |', 2],
    ['insert-image', '![alt text](path/to/image.png)', 2],
    ['insert-formula', '$$\n\n$$', 3],
    ['code-block', '```\n\n```', 4],
    ['alert-tip', '> [!TIP]\n> ', 11],
    ['link', '[]()', 1],
  ] as const)('inserts %s from the context menu as one undoable transaction', (id, expected, caret) => {
    const onContentChange = vi.fn<(content: string) => void>();
    act(() => {
      root.render(
        <EditorPane
          activePath="/workspace/notes.md"
          content=""
          documentEpoch={1}
          documentId={`document-${id}`}
          onContentChange={onContentChange}
        />,
      );
    });
    const editor = container.querySelector<HTMLElement>('.cm-editor');
    const view = editor ? EditorView.findFromDOM(editor) : null;
    if (!view) throw new Error('Expected CodeMirror editor');

    act(() => {
      dispatchEditorContextMenu(view);
    });
    act(() => {
      container.querySelector<HTMLButtonElement>(`[data-context-command-id="${id}"], [data-context-action-id="${id}"]`)?.click();
    });

    expect(view.state.doc.toString()).toBe(expected);
    expect(view.state.selection.main.head).toBe(caret);
    expect(undoDepth(view.state)).toBe(1);
    expect(onContentChange).toHaveBeenCalledWith(expected);
  });

  it('dismisses the editor context menu on Escape, outside click, and format palette handoff', () => {
    act(() => {
      root.render(
        <EditorPane
          activePath="/workspace/notes.md"
          content="alpha"
          documentEpoch={1}
          documentId="document-notes"
          onContentChange={vi.fn<(content: string) => void>()}
        />,
      );
    });
    const editor = container.querySelector<HTMLElement>('.cm-editor');
    const view = editor ? EditorView.findFromDOM(editor) : null;
    if (!view) throw new Error('Expected CodeMirror editor');

    act(() => {
      dispatchEditorContextMenu(view);
    });
    expect(container.querySelector('[data-editor-context-menu="true"]')).not.toBeNull();
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Escape' }));
    });
    expect(container.querySelector('[data-editor-context-menu="true"]')).toBeNull();

    act(() => {
      dispatchEditorContextMenu(view);
    });
    expect(container.querySelector('[data-editor-context-menu="true"]')).not.toBeNull();
    act(() => {
      document.body.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    });
    expect(container.querySelector('[data-editor-context-menu="true"]')).toBeNull();

    act(() => {
      dispatchEditorContextMenu(view);
    });
    act(() => {
      container.querySelector<HTMLButtonElement>('[data-context-action-id="open-format-palette"]')?.click();
    });
    expect(container.querySelector('[data-editor-context-menu="true"]')).toBeNull();
    expect(container.querySelector('.markdown-format-dialog')).not.toBeNull();
  });

  it.each([
    { editable: false, fileKind: 'markdown' as const },
    { editable: true, fileKind: 'html' as const },
  ])('leaves the native context menu alone for $fileKind when editable=$editable', ({ editable, fileKind }) => {
    act(() => {
      root.render(
        <EditorPane
          activePath="/workspace/notes.md"
          content="alpha"
          documentEpoch={1}
          documentId="document-notes"
          editable={editable}
          fileKind={fileKind}
          onContentChange={vi.fn<(content: string) => void>()}
        />,
      );
    });
    const editor = container.querySelector<HTMLElement>('.cm-editor');
    const view = editor ? EditorView.findFromDOM(editor) : null;
    if (!view) throw new Error('Expected CodeMirror editor');

    const event = dispatchEditorContextMenu(view);

    expect(event.defaultPrevented).toBe(false);
    expect(container.querySelector('[data-editor-context-menu="true"]')).toBeNull();
  });

  it('opens the Markdown format command dialog with Control slash', () => {
    const onContentChange = vi.fn<(content: string) => void>();
    act(() => {
      root.render(
        <EditorPane
          activePath="/workspace/notes.md"
          content="alpha"
          documentEpoch={1}
          documentId="document-notes"
          onContentChange={onContentChange}
        />,
      );
    });
    const editor = container.querySelector<HTMLElement>('.cm-editor');
    const view = editor ? EditorView.findFromDOM(editor) : null;
    if (!view) throw new Error('Expected CodeMirror editor');

    act(() => view.dispatch({ selection: { anchor: 0, head: 5 } }));
    const shortcut = new KeyboardEvent('keydown', {
      bubbles: true,
      cancelable: true,
      code: 'Slash',
      ctrlKey: true,
      key: '/',
      keyCode: 191,
    });
    act(() => {
      view.contentDOM.dispatchEvent(shortcut);
    });

    expect(shortcut.defaultPrevented).toBe(true);
    expect(view.state.doc.toString()).toBe('alpha');
    expect(view.state.selection.main).toMatchObject({ from: 0, to: 5 });
    expect(onContentChange).not.toHaveBeenCalled();
    const palette = container.querySelector<HTMLElement>('.markdown-format-dialog');
    expect(palette?.tagName).toBe('DIALOG');
    expect(palette?.hasAttribute('aria-modal')).toBe(false);
    expect(container.querySelector('.markdown-format-dialog-backdrop')).toBeNull();
    expect(container.querySelector('[role="listbox"]')).not.toBeNull();
    expect(container.querySelector('[role="option"][data-command-id="h1"]')?.textContent)
      .toContain('Heading 1');
    expect(container.querySelector('[role="option"][data-command-id="alert-error"]')?.textContent)
      .toContain('Error');
  });

  it('handles Control slash in the CodeMirror keymap before its default binding', () => {
    const onContentChange = vi.fn<(content: string) => void>();
    act(() => {
      root.render(
        <EditorPane
          activePath="/workspace/notes.md"
          content="alpha beta"
          documentEpoch={1}
          documentId="document-notes"
          onContentChange={onContentChange}
        />,
      );
    });
    const editor = container.querySelector<HTMLElement>('.cm-editor');
    const view = editor ? EditorView.findFromDOM(editor) : null;
    if (!view) throw new Error('Expected CodeMirror editor');

    act(() => view.dispatch({ selection: { anchor: 0, head: 5 } }));
    const shortcut = new KeyboardEvent('keydown', {
      bubbles: true,
      cancelable: true,
      code: 'Slash',
      ctrlKey: true,
      key: '/',
      keyCode: 191,
    });

    let handled = false;
    act(() => {
      handled = runScopeHandlers(view, shortcut, 'editor');
    });

    expect(handled).toBe(true);
    expect(view.state.doc.toString()).toBe('alpha beta');
    expect(view.state.selection.main).toMatchObject({ from: 0, to: 5 });
    expect(onContentChange).not.toHaveBeenCalled();
    expect(container.querySelector('.markdown-format-dialog')).not.toBeNull();
  });

  it('consumes Control slash during composition without inserting a slash', () => {
    const onContentChange = vi.fn<(content: string) => void>();
    act(() => {
      root.render(
        <EditorPane
          activePath="/workspace/notes.md"
          content="alpha"
          documentEpoch={1}
          documentId="document-notes"
          onContentChange={onContentChange}
        />,
      );
    });
    const editor = container.querySelector<HTMLElement>('.cm-editor');
    const view = editor ? EditorView.findFromDOM(editor) : null;
    if (!view) throw new Error('Expected CodeMirror editor');
    const shortcut = new KeyboardEvent('keydown', {
      bubbles: true,
      cancelable: true,
      code: 'Slash',
      ctrlKey: true,
      key: '/',
    });
    const leakedKeydown = vi.fn<(event: KeyboardEvent) => void>();
    container.addEventListener('keydown', leakedKeydown);

    act(() => {
      view.contentDOM.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
      view.contentDOM.dispatchEvent(shortcut);
    });

    expect(shortcut.defaultPrevented).toBe(true);
    expect(leakedKeydown).not.toHaveBeenCalled();
    expect(container.querySelector('.markdown-format-dialog')).not.toBeNull();
    expect(view.state.doc.toString()).toBe('alpha');
    expect(onContentChange).not.toHaveBeenCalled();
  });

  it('wraps the selection active when the physical Slash key opens Markdown formats', () => {
    const onContentChange = vi.fn<(content: string) => void>();
    act(() => {
      root.render(
        <EditorPane
          activePath="/workspace/notes.md"
          content="alpha beta"
          documentEpoch={1}
          documentId="document-notes"
          onContentChange={onContentChange}
        />,
      );
    });
    const editor = container.querySelector<HTMLElement>('.cm-editor');
    const view = editor ? EditorView.findFromDOM(editor) : null;
    if (!view) throw new Error('Expected CodeMirror editor');

    act(() => view.dispatch({ selection: { anchor: 0, head: 5 } }));
    const shortcut = new KeyboardEvent('keydown', {
      bubbles: true,
      cancelable: true,
      code: 'Slash',
      ctrlKey: true,
      key: '?',
      keyCode: 191,
      shiftKey: true,
    });
    act(() => {
      view.contentDOM.dispatchEvent(shortcut);
    });

    expect(shortcut.defaultPrevented).toBe(true);
    expect(view.state.doc.toString()).toBe('alpha beta');
    expect(view.state.selection.main).toMatchObject({ from: 0, to: 5 });
    expect(onContentChange).not.toHaveBeenCalled();

    act(() => {
      container.querySelector<HTMLButtonElement>('[data-command-id="bold"]')?.click();
    });

    expect(view.state.doc.toString()).toBe('**alpha** beta');
    expect(view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to))
      .toBe('alpha');
    expect(onContentChange).toHaveBeenCalledOnce();
    expect(onContentChange).toHaveBeenCalledWith('**alpha** beta');
  });

  it('chooses format commands with arrow keys and Enter', () => {
    const onContentChange = vi.fn<(content: string) => void>();
    act(() => {
      root.render(
        <EditorPane
          activePath="/workspace/notes.md"
          content=""
          documentEpoch={1}
          documentId="document-notes"
          onContentChange={onContentChange}
        />,
      );
    });
    const editor = container.querySelector<HTMLElement>('.cm-editor');
    const view = editor ? EditorView.findFromDOM(editor) : null;
    if (!view) throw new Error('Expected CodeMirror editor');

    act(() => {
      view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', {
        bubbles: true,
        ctrlKey: true,
        key: '/',
      }));
    });
    const search = container.querySelector<HTMLInputElement>('[role="combobox"]');
    act(() => {
      search?.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'ArrowDown' }));
    });
    act(() => {
      search?.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Enter' }));
    });

    expect(view.state.doc.toString()).toBe('## ');
    expect(view.state.selection.main.head).toBe(3);
    expect(onContentChange).toHaveBeenCalledWith('## ');
  });

  it('scrolls the active format command into view during keyboard navigation', () => {
    act(() => {
      root.render(
        <EditorPane
          activePath="/workspace/notes.md"
          content=""
          documentEpoch={1}
          documentId="document-notes"
          onContentChange={vi.fn<(content: string) => void>()}
        />,
      );
    });
    const editor = container.querySelector<HTMLElement>('.cm-editor');
    const view = editor ? EditorView.findFromDOM(editor) : null;
    if (!view) throw new Error('Expected CodeMirror editor');

    act(() => {
      view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', {
        bubbles: true,
        cancelable: true,
        code: 'Slash',
        ctrlKey: true,
        key: '/',
      }));
    });
    const search = container.querySelector<HTMLInputElement>('[role="combobox"]');
    const lastCommand = container.querySelector<HTMLElement>('[data-command-id="alert-error"]');
    const scrollIntoView = vi.fn<(options?: boolean | ScrollIntoViewOptions) => void>();
    if (!lastCommand) throw new Error('Expected last format command');
    lastCommand.scrollIntoView = scrollIntoView;

    act(() => {
      for (let index = 0; index < 16; index += 1) {
        search?.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'ArrowDown' }));
      }
    });

    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' });
    expect(search?.getAttribute('aria-activedescendant')).toBe('markdown-format-alert-error');
  });

  it('wraps the current selection with the chosen format command', () => {
    const onContentChange = vi.fn<(content: string) => void>();
    act(() => {
      root.render(
        <EditorPane
          activePath="/workspace/notes.md"
          content="alpha beta"
          documentEpoch={1}
          documentId="document-notes"
          onContentChange={onContentChange}
        />,
      );
    });
    const editor = container.querySelector<HTMLElement>('.cm-editor');
    const view = editor ? EditorView.findFromDOM(editor) : null;
    if (!view) throw new Error('Expected CodeMirror editor');

    act(() => view.dispatch({ selection: { anchor: 0, head: 5 } }));
    act(() => {
      view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', {
        bubbles: true,
        ctrlKey: true,
        key: '/',
      }));
    });
    act(() => {
      container.querySelector<HTMLButtonElement>('[data-command-id="bold"]')?.click();
    });

    expect(view.state.doc.toString()).toBe('**alpha** beta');
    expect(view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to))
      .toBe('alpha');
    expect(onContentChange).toHaveBeenCalledOnce();
    expect(onContentChange).toHaveBeenCalledWith('**alpha** beta');
    expect(container.querySelector('.markdown-format-dialog')).toBeNull();
  });

  it('applies a format command to the selection that opened the dialog', () => {
    const onContentChange = vi.fn<(content: string) => void>();
    act(() => {
      root.render(
        <EditorPane
          activePath="/workspace/notes.md"
          content="alpha beta"
          documentEpoch={1}
          documentId="document-notes"
          onContentChange={onContentChange}
        />,
      );
    });
    const editor = container.querySelector<HTMLElement>('.cm-editor');
    const view = editor ? EditorView.findFromDOM(editor) : null;
    if (!view) throw new Error('Expected CodeMirror editor');

    act(() => view.dispatch({ selection: { anchor: 0, head: 5 } }));
    act(() => {
      view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', {
        bubbles: true,
        cancelable: true,
        code: 'Slash',
        ctrlKey: true,
        key: '/',
      }));
    });
    act(() => view.dispatch({ selection: { anchor: 6, head: 10 } }));
    act(() => {
      container.querySelector<HTMLButtonElement>('[data-command-id="bold"]')?.click();
    });

    expect(view.state.doc.toString()).toBe('**alpha** beta');
    expect(view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to))
      .toBe('alpha');
    expect(onContentChange).toHaveBeenCalledOnce();
    expect(onContentChange).toHaveBeenCalledWith('**alpha** beta');
  });

  it('keeps the editor selection drawn while the format dialog has focus', () => {
    act(() => {
      root.render(
        <EditorPane
          activePath="/workspace/notes.md"
          content="alpha beta"
          documentEpoch={1}
          documentId="document-notes"
          onContentChange={vi.fn<(content: string) => void>()}
        />,
      );
    });
    const editor = container.querySelector<HTMLElement>('.cm-editor');
    const view = editor ? EditorView.findFromDOM(editor) : null;
    if (!view) throw new Error('Expected CodeMirror editor');

    act(() => view.dispatch({ selection: { anchor: 0, head: 5 } }));
    act(() => {
      view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', {
        bubbles: true,
        cancelable: true,
        code: 'Slash',
        ctrlKey: true,
        key: '/',
      }));
    });

    expect(document.activeElement).toBe(container.querySelector('[role="combobox"]'));
    expect(view.state.selection.main).toMatchObject({ from: 0, to: 5 });
    expect(editor?.querySelector('.cm-selectionLayer')).not.toBeNull();
  });

  it('inserts an empty alert template at the caret', () => {
    const onContentChange = vi.fn<(content: string) => void>();
    act(() => {
      root.render(
        <EditorPane
          activePath="/workspace/notes.md"
          content="before after"
          documentEpoch={1}
          documentId="document-notes"
          onContentChange={onContentChange}
        />,
      );
    });
    const editor = container.querySelector<HTMLElement>('.cm-editor');
    const view = editor ? EditorView.findFromDOM(editor) : null;
    if (!view) throw new Error('Expected CodeMirror editor');

    act(() => view.dispatch({ selection: { anchor: 7 } }));
    act(() => {
      view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', {
        bubbles: true,
        ctrlKey: true,
        key: '/',
      }));
    });
    act(() => {
      container.querySelector<HTMLButtonElement>('[data-command-id="alert-tip"]')?.click();
    });

    expect(view.state.doc.toString()).toBe('before \n> [!TIP]\n> \nafter');
    expect(view.state.selection.main.head).toBe(19);
    expect(onContentChange).toHaveBeenCalledWith('before \n> [!TIP]\n> \nafter');
  });

  it('closes the format command dialog with Escape without changing content', () => {
    const onContentChange = vi.fn<(content: string) => void>();
    act(() => {
      root.render(
        <EditorPane
          activePath="/workspace/notes.md"
          content="alpha"
          documentEpoch={1}
          documentId="document-notes"
          onContentChange={onContentChange}
        />,
      );
    });
    const editor = container.querySelector<HTMLElement>('.cm-editor');
    const view = editor ? EditorView.findFromDOM(editor) : null;
    if (!view) throw new Error('Expected CodeMirror editor');

    act(() => {
      view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', {
        bubbles: true,
        ctrlKey: true,
        key: '/',
      }));
    });
    const search = container.querySelector<HTMLInputElement>('[role="combobox"]');
    act(() => {
      search?.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Escape' }));
    });

    expect(container.querySelector('.markdown-format-dialog')).toBeNull();
    expect(view.state.doc.toString()).toBe('alpha');
    expect(onContentChange).not.toHaveBeenCalled();
  });

  it('closes the format command dialog from its close button', () => {
    act(() => {
      root.render(
        <EditorPane
          activePath="/workspace/notes.md"
          content="alpha"
          documentEpoch={1}
          documentId="document-notes"
          onContentChange={vi.fn<(content: string) => void>()}
        />,
      );
    });
    const editor = container.querySelector<HTMLElement>('.cm-editor');
    const view = editor ? EditorView.findFromDOM(editor) : null;
    if (!view) throw new Error('Expected CodeMirror editor');

    act(() => {
      view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', {
        bubbles: true,
        cancelable: true,
        code: 'Slash',
        ctrlKey: true,
        key: '/',
      }));
    });
    const closeButton = container.querySelector<HTMLButtonElement>(
      '.markdown-format-dialog button[aria-label="Cancel"]',
    );
    expect(closeButton).not.toBeNull();

    act(() => closeButton?.click());

    expect(container.querySelector('.markdown-format-dialog')).toBeNull();
    expect(document.activeElement).toBe(view.contentDOM);
  });

  it('closes the format command dialog when focus returns to the editor', () => {
    act(() => {
      root.render(
        <EditorPane
          activePath="/workspace/notes.md"
          content="alpha"
          documentEpoch={1}
          documentId="document-notes"
          onContentChange={vi.fn<(content: string) => void>()}
        />,
      );
    });
    const editor = container.querySelector<HTMLElement>('.cm-editor');
    const view = editor ? EditorView.findFromDOM(editor) : null;
    if (!view) throw new Error('Expected CodeMirror editor');

    act(() => {
      view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', {
        bubbles: true,
        cancelable: true,
        code: 'Slash',
        ctrlKey: true,
        key: '/',
      }));
    });
    expect(container.querySelector('.markdown-format-dialog')).not.toBeNull();
    expect(document.activeElement).toBe(container.querySelector('[role="combobox"]'));

    act(() => view.contentDOM.focus());

    expect(container.querySelector('.markdown-format-dialog')).toBeNull();
    expect(document.activeElement).toBe(view.contentDOM);
  });

  it('dismisses the format command dialog without stealing focus from another control', () => {
    act(() => {
      root.render(
        <EditorPane
          activePath="/workspace/notes.md"
          content="alpha"
          documentEpoch={1}
          documentId="document-notes"
          onContentChange={vi.fn<(content: string) => void>()}
        />,
      );
    });
    const editor = container.querySelector<HTMLElement>('.cm-editor');
    const view = editor ? EditorView.findFromDOM(editor) : null;
    const vimButton = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Enable Vim editing mode"]',
    );
    if (!view || !vimButton) throw new Error('Expected editor and Vim button');

    act(() => {
      view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', {
        bubbles: true,
        cancelable: true,
        code: 'Slash',
        ctrlKey: true,
        key: '/',
      }));
    });
    expect(container.querySelector('.markdown-format-dialog')).not.toBeNull();

    act(() => vimButton.focus());

    expect(container.querySelector('.markdown-format-dialog')).toBeNull();
    expect(document.activeElement).toBe(vimButton);
  });

  it('closes the format command dialog when the active document changes', () => {
    const onContentChange = vi.fn<(content: string) => void>();
    act(() => {
      root.render(
        <EditorPane
          activePath="/workspace/first.md"
          content="first"
          documentEpoch={1}
          documentId="document-first"
          onContentChange={onContentChange}
        />,
      );
    });
    const firstEditor = container.querySelector<HTMLElement>('.cm-editor');
    const firstView = firstEditor ? EditorView.findFromDOM(firstEditor) : null;
    if (!firstView) throw new Error('Expected first CodeMirror editor');

    act(() => {
      firstView.contentDOM.dispatchEvent(new KeyboardEvent('keydown', {
        bubbles: true,
        cancelable: true,
        code: 'Slash',
        ctrlKey: true,
        key: '/',
      }));
    });
    expect(container.querySelector('.markdown-format-dialog')).not.toBeNull();

    act(() => {
      root.render(
        <EditorPane
          activePath="/workspace/second.md"
          content="second"
          documentEpoch={2}
          documentId="document-second"
          onContentChange={onContentChange}
        />,
      );
    });

    const secondEditor = container.querySelector<HTMLElement>('.cm-editor');
    const secondView = secondEditor ? EditorView.findFromDOM(secondEditor) : null;
    expect(container.querySelector('.markdown-format-dialog')).toBeNull();
    expect(secondView?.state.doc.toString()).toBe('second');
    expect(onContentChange).not.toHaveBeenCalled();
  });

  it('closes the format command dialog when its source content changes externally', () => {
    const onContentChange = vi.fn<(content: string) => void>();
    const renderEditor = (content: string) => (
      <EditorPane
        activePath="/workspace/notes.md"
        content={content}
        documentEpoch={1}
        documentId="document-notes"
        onContentChange={onContentChange}
      />
    );
    act(() => root.render(renderEditor('alpha')));
    const editor = container.querySelector<HTMLElement>('.cm-editor');
    const view = editor ? EditorView.findFromDOM(editor) : null;
    if (!view) throw new Error('Expected CodeMirror editor');

    act(() => {
      view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', {
        bubbles: true,
        cancelable: true,
        code: 'Slash',
        ctrlKey: true,
        key: '/',
      }));
    });
    expect(container.querySelector('.markdown-format-dialog')).not.toBeNull();

    act(() => root.render(renderEditor('external update')));

    expect(container.querySelector('.markdown-format-dialog')).toBeNull();
    expect(view.state.doc.toString()).toBe('external update');
    expect(onContentChange).not.toHaveBeenCalled();
  });

  it.each([
    { editable: false, fileKind: 'markdown' as const },
    { editable: true, fileKind: 'html' as const },
  ])('does not open Markdown formats for $fileKind with editable=$editable', ({ editable, fileKind }) => {
    act(() => {
      root.render(
        <EditorPane
          activePath={fileKind === 'html' ? '/workspace/index.html' : '/workspace/notes.md'}
          content="alpha"
          documentEpoch={1}
          documentId="document-notes"
          editable={editable}
          fileKind={fileKind}
          onContentChange={vi.fn<(content: string) => void>()}
        />,
      );
    });
    const editor = container.querySelector<HTMLElement>('.cm-editor');
    const view = editor ? EditorView.findFromDOM(editor) : null;
    if (!view) throw new Error('Expected CodeMirror editor');

    act(() => {
      view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', {
        bubbles: true,
        ctrlKey: true,
        key: '/',
      }));
    });

    expect(container.querySelector('.markdown-format-dialog')).toBeNull();
  });

  it('renders distinct syntax highlighting for common Markdown constructs', () => {
    act(() => {
      root.render(
        <EditorPane
          activePath="/workspace/notes.md"
          content={'# Heading\n\n**Strong** and *emphasis* with [link](https://example.com) and `code`.'}
          documentEpoch={1}
          documentId="document-notes"
          onContentChange={vi.fn<(content: string) => void>()}
        />,
      );
    });

    const highlightedText = (selector: string) => Array.from(
      container.querySelectorAll<HTMLElement>(selector),
      (element) => element.textContent ?? '',
    ).join('');

    expect(highlightedText('.tok-heading')).toContain('Heading');
    expect(highlightedText('.tok-strong')).toContain('Strong');
    expect(highlightedText('.tok-emphasis')).toContain('emphasis');
    expect(highlightedText('.tok-link')).toContain('link');
    expect(highlightedText('.tok-url')).toContain('https://example.com');
    expect(highlightedText('.tok-monospace')).toContain('code');
  });

  it('renders syntax-highlighted HTML with the HTML language active', () => {
    act(() => {
      root.render(
        <EditorPane
          activePath="/workspace/index.html"
          content="<h1>Home</h1>"
          documentEpoch={1}
          documentId="document-html"
          fileKind="html"
          onContentChange={vi.fn<(content: string) => void>()}
        />,
      );
    });
    const editor = container.querySelector<HTMLElement>('.cm-editor');
    const view = editor ? EditorView.findFromDOM(editor) : null;

    expect(view ? htmlLanguage.isActiveAt(view.state, 0) : false).toBe(true);
    expect(view ? highlightingFor(view.state, [tags.tagName]) : null).not.toBeNull();
  });

  it('emits the complete editor content exactly once for one user change', () => {
    const onContentChange = vi.fn<(content: string) => void>();
    act(() => {
      root.render(
        <EditorPane
          activePath="/workspace/notes.md"
          content="# Before"
          documentEpoch={1}
          documentId="document-notes"
          onContentChange={onContentChange}
        />,
      );
    });
    const editor = container.querySelector<HTMLElement>('.cm-editor');
    const view = editor ? EditorView.findFromDOM(editor) : null;

    expect(view?.state.doc.toString()).toBe('# Before');

    act(() => {
      if (!view) throw new Error('Expected CodeMirror editor');
      view.dispatch({
        changes: { from: view.state.doc.length, insert: ' edited' },
      });
    });

    expect(onContentChange).toHaveBeenCalledOnce();
    expect(onContentChange).toHaveBeenCalledWith('# Before edited');
  });

  it('rejects document changes while the editor is read-only', () => {
    const onContentChange = vi.fn<(content: string) => void>();
    act(() => {
      root.render(
        <EditorPane
          activePath="/workspace/notes.md"
          content="# Protected"
          documentEpoch={1}
          documentId="document-protected"
          editable={false}
          onContentChange={onContentChange}
        />,
      );
    });
    const editor = container.querySelector<HTMLElement>('.cm-editor');
    const view = editor ? EditorView.findFromDOM(editor) : null;
    if (!view) throw new Error('Expected CodeMirror editor');

    expect(view.state.facet(EditorView.editable)).toBe(false);
    expect(view.state.facet(EditorState.readOnly)).toBe(true);
    expect(view.contentDOM.getAttribute('aria-readonly')).toBe('true');

    act(() => {
      view.dispatch({ changes: { from: view.state.doc.length, insert: ' changed' } });
    });

    expect(view.state.doc.toString()).toBe('# Protected');
    expect(onContentChange).not.toHaveBeenCalled();
  });

  it('reconfigures editability without recreating the editor', () => {
    const onContentChange = vi.fn<(content: string) => void>();
    act(() => {
      root.render(
        <EditorPane
          activePath="/workspace/notes.md"
          content="# Protected"
          documentEpoch={1}
          documentId="document-protected"
          editable={false}
          onContentChange={onContentChange}
        />,
      );
    });
    const editor = container.querySelector<HTMLElement>('.cm-editor');
    const initialView = editor ? EditorView.findFromDOM(editor) : null;
    if (!initialView) throw new Error('Expected CodeMirror editor');

    act(() => {
      root.render(
        <EditorPane
          activePath="/workspace/notes.md"
          content="# Protected"
          documentEpoch={1}
          documentId="document-protected"
          editable
          onContentChange={onContentChange}
        />,
      );
    });
    const currentEditor = container.querySelector<HTMLElement>('.cm-editor');
    const currentView = currentEditor ? EditorView.findFromDOM(currentEditor) : null;

    expect(currentView).toBe(initialView);
    expect(currentView?.state.facet(EditorView.editable)).toBe(true);
    expect(currentView?.state.facet(EditorState.readOnly)).toBe(false);
    expect(currentView?.contentDOM.getAttribute('aria-readonly')).toBe('false');

    act(() => {
      currentView?.dispatch({
        changes: { from: currentView.state.doc.length, insert: ' changed' },
      });
    });

    expect(onContentChange).toHaveBeenCalledOnce();
    expect(onContentChange).toHaveBeenCalledWith('# Protected changed');
  });

  it('applies external content to the same document without echoing or recreating the editor', () => {
    const onContentChange = vi.fn<(content: string) => void>();
    act(() => {
      root.render(
        <EditorPane
          activePath="/workspace/notes.md"
          content="# Before"
          documentEpoch={3}
          documentId="document-current"
          onContentChange={onContentChange}
        />,
      );
    });
    const editor = container.querySelector<HTMLElement>('.cm-editor');
    const initialView = editor ? EditorView.findFromDOM(editor) : null;

    act(() => {
      root.render(
        <EditorPane
          activePath="/workspace/notes.md"
          content="# Synced"
          documentEpoch={3}
          documentId="document-current"
          onContentChange={onContentChange}
        />,
      );
    });
    const currentEditor = container.querySelector<HTMLElement>('.cm-editor');
    const currentView = currentEditor ? EditorView.findFromDOM(currentEditor) : null;

    expect(currentView).toBe(initialView);
    expect(currentView?.state.doc.toString()).toBe('# Synced');
    expect(currentView ? undoDepth(currentView.state) : -1).toBe(0);
    expect(onContentChange).not.toHaveBeenCalled();
  });

  it('does not dispatch an identical external content value', () => {
    const onContentChange = vi.fn<(content: string) => void>();
    act(() => {
      root.render(
        <EditorPane
          activePath="/workspace/notes.md"
          content="# Stable"
          documentEpoch={2}
          documentId="document-stable"
          onContentChange={onContentChange}
        />,
      );
    });
    const editor = container.querySelector<HTMLElement>('.cm-editor');
    const view = editor ? EditorView.findFromDOM(editor) : null;
    if (!view) throw new Error('Expected CodeMirror editor');
    act(() => view.dispatch({ selection: { anchor: 3 } }));
    const previousState = view.state;

    act(() => {
      root.render(
        <EditorPane
          activePath="/workspace/notes.md"
          content="# Stable"
          documentEpoch={2}
          documentId="document-stable"
          onContentChange={onContentChange}
        />,
      );
    });

    expect(view.state).toBe(previousState);
    expect(view.state.selection.main.head).toBe(3);
    expect(onContentChange).not.toHaveBeenCalled();
  });

  it('reconfigures language for the same identity without recreating the editor', () => {
    const onContentChange = vi.fn<(content: string) => void>();
    act(() => {
      root.render(
        <EditorPane
          activePath="/workspace/source"
          content="# Markdown"
          documentEpoch={7}
          documentId="document-source"
          onContentChange={onContentChange}
        />,
      );
    });
    const editor = container.querySelector<HTMLElement>('.cm-editor');
    const initialView = editor ? EditorView.findFromDOM(editor) : null;

    act(() => {
      root.render(
        <EditorPane
          activePath="/workspace/source"
          content="<h1>HTML</h1>"
          documentEpoch={7}
          documentId="document-source"
          fileKind="html"
          onContentChange={onContentChange}
        />,
      );
    });
    const currentEditor = container.querySelector<HTMLElement>('.cm-editor');
    const currentView = currentEditor ? EditorView.findFromDOM(currentEditor) : null;

    expect(currentView).toBe(initialView);
    expect(currentView ? htmlLanguage.isActiveAt(currentView.state, 0) : false).toBe(true);
    expect(currentView?.contentDOM.getAttribute('aria-label')).toBe('HTML source editor');
    expect(onContentChange).not.toHaveBeenCalled();
  });

  it('resets local history and language when document identity changes', () => {
    const onContentChange = vi.fn<(content: string) => void>();
    act(() => {
      root.render(
        <EditorPane
          activePath="/workspace/shared-path"
          content="# First"
          documentEpoch={1}
          documentId="document-first"
          onContentChange={onContentChange}
        />,
      );
    });
    const firstEditor = container.querySelector<HTMLElement>('.cm-editor');
    const firstView = firstEditor ? EditorView.findFromDOM(firstEditor) : null;
    if (!firstView) throw new Error('Expected first CodeMirror editor');
    act(() => {
      firstView.dispatch({ changes: { from: firstView.state.doc.length, insert: ' edited' } });
    });
    expect(undoDepth(firstView.state)).toBe(1);
    expect(markdownLanguage.isActiveAt(firstView.state, 0)).toBe(true);

    act(() => {
      root.render(
        <EditorPane
          activePath="/workspace/shared-path"
          content="<h1>Second</h1>"
          documentEpoch={2}
          documentId="document-second"
          fileKind="html"
          onContentChange={onContentChange}
        />,
      );
    });
    const secondEditor = container.querySelector<HTMLElement>('.cm-editor');
    const secondView = secondEditor ? EditorView.findFromDOM(secondEditor) : null;

    expect(secondView).not.toBe(firstView);
    expect(secondView?.state.doc.toString()).toBe('<h1>Second</h1>');
    expect(secondView ? undoDepth(secondView.state) : -1).toBe(0);
    expect(secondView ? htmlLanguage.isActiveAt(secondView.state, 0) : false).toBe(true);
    expect(firstView.dom.isConnected).toBe(false);
  });

  it('destroys each EditorView on identity replacement and unmount', () => {
    const destroy = vi.spyOn(EditorView.prototype, 'destroy');
    const onContentChange = vi.fn<(content: string) => void>();
    act(() => {
      root.render(
        <EditorPane
          activePath="/workspace/first.md"
          content="# First"
          documentEpoch={1}
          documentId="document-first"
          onContentChange={onContentChange}
        />,
      );
    });

    act(() => {
      root.render(
        <EditorPane
          activePath="/workspace/second.md"
          content="# Second"
          documentEpoch={2}
          documentId="document-second"
          onContentChange={onContentChange}
        />,
      );
    });
    expect(destroy).toHaveBeenCalledTimes(1);

    act(() => root.unmount());
    expect(destroy).toHaveBeenCalledTimes(2);
    root = createRoot(container);
  });

  it('ignores late document changes dispatched by a replaced editor view', () => {
    const onContentChange = vi.fn<(content: string) => void>();
    act(() => {
      root.render(
        <EditorPane
          activePath="/workspace/first.md"
          content="# First"
          documentEpoch={1}
          documentId="document-first"
          onContentChange={onContentChange}
        />,
      );
    });
    const firstEditor = container.querySelector<HTMLElement>('.cm-editor');
    const firstView = firstEditor ? EditorView.findFromDOM(firstEditor) : null;
    if (!firstView) throw new Error('Expected first CodeMirror editor');

    act(() => {
      root.render(
        <EditorPane
          activePath="/workspace/second.md"
          content="# Second"
          documentEpoch={2}
          documentId="document-second"
          onContentChange={onContentChange}
        />,
      );
    });
    const secondEditor = container.querySelector<HTMLElement>('.cm-editor');
    const secondView = secondEditor ? EditorView.findFromDOM(secondEditor) : null;
    if (!secondView) throw new Error('Expected second CodeMirror editor');

    act(() => {
      firstView.dispatch({
        changes: { from: firstView.state.doc.length, insert: ' late' },
      });
    });

    expect(onContentChange).not.toHaveBeenCalled();
    expect(secondView.state.doc.toString()).toBe('# Second');
  });

  it('keeps native undo and redo synchronized through the content callback', () => {
    const onContentChange = vi.fn<(content: string) => void>();
    act(() => {
      root.render(
        <EditorPane
          activePath="/workspace/notes.md"
          content="# Before"
          documentEpoch={1}
          documentId="document-notes"
          onContentChange={onContentChange}
        />,
      );
    });
    const editor = container.querySelector<HTMLElement>('.cm-editor');
    const view = editor ? EditorView.findFromDOM(editor) : null;
    if (!view) throw new Error('Expected CodeMirror editor');

    act(() => {
      view.dispatch({ changes: { from: view.state.doc.length, insert: ' edited' } });
    });
    expect(onContentChange).toHaveBeenLastCalledWith('# Before edited');

    let didUndo = false;
    act(() => {
      didUndo = undo(view);
    });
    expect(didUndo).toBe(true);
    expect(onContentChange).toHaveBeenLastCalledWith('# Before');

    let didRedo = false;
    act(() => {
      didRedo = redo(view);
    });
    expect(didRedo).toBe(true);
    expect(onContentChange).toHaveBeenLastCalledWith('# Before edited');
    expect(onContentChange).toHaveBeenCalledTimes(3);
  });

  it('opens native search and applies replace commands through the content callback', () => {
    const onContentChange = vi.fn<(content: string) => void>();
    act(() => {
      root.render(
        <EditorPane
          activePath="/workspace/notes.md"
          content="alpha beta alpha"
          documentEpoch={1}
          documentId="document-notes"
          onContentChange={onContentChange}
        />,
      );
    });
    const editor = container.querySelector<HTMLElement>('.cm-editor');
    const view = editor ? EditorView.findFromDOM(editor) : null;
    if (!view) throw new Error('Expected CodeMirror editor');

    act(() => {
      view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', {
        bubbles: true,
        ctrlKey: true,
        key: 'f',
      }));
    });
    expect(container.querySelector('.cm-search')).not.toBeNull();

    act(() => {
      view.dispatch({
        effects: setSearchQuery.of(new SearchQuery({ search: 'alpha', replace: 'omega' })),
      });
    });

    expect(findNext(view)).toBe(true);
    expect(view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to))
      .toBe('alpha');
    expect(findPrevious(view)).toBe(true);
    expect(view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to))
      .toBe('alpha');

    act(() => {
      expect(replaceNext(view)).toBe(true);
    });
    expect(onContentChange).toHaveBeenLastCalledWith('alpha beta omega');

    act(() => {
      expect(replaceAll(view)).toBe(true);
    });
    expect(onContentChange).toHaveBeenLastCalledWith('omega beta omega');
    expect(onContentChange).toHaveBeenCalledTimes(2);
  });
});
