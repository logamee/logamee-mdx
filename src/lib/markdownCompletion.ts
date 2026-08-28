import { EditorState, Prec, type Extension } from '@codemirror/state';
import { syntaxTree } from '@codemirror/language';
import { EditorView, keymap } from '@codemirror/view';

export interface MarkdownCompletionSelection {
  from: number;
  to: number;
}

export interface MarkdownCompletionInput {
  from: number;
  to: number;
  text: string;
}

export interface MarkdownCompletionEdit {
  from: number;
  to: number;
  insert: string;
  selection: { anchor: number; head: number };
}

interface MarkdownCompletionLine {
  from: number;
  text: string;
  to: number;
}

interface MarkdownCompletionDocument {
  length: number;
  lineAt(position: number): MarkdownCompletionLine;
  sliceString(from?: number, to?: number): string;
}

function isCompletionTrigger(text: string): boolean {
  return text === '\n';
}

function stringDocument(source: string): MarkdownCompletionDocument {
  return {
    length: source.length,
    lineAt(position) {
      const safePosition = Math.max(0, Math.min(position, source.length));
      const from = source.lastIndexOf('\n', Math.max(0, safePosition - 1)) + 1;
      const lineBreak = source.indexOf('\n', safePosition);
      const to = lineBreak === -1 ? source.length : lineBreak;
      return { from, text: source.slice(from, to), to };
    },
    sliceString(from = 0, to = source.length) {
      return source.slice(from, to);
    },
  };
}

function isInsideFencedCode(source: string, position: number): boolean {
  const prefix = source.slice(0, position);
  let activeFence: { character: '`' | '~'; length: number } | null = null;

  for (const line of prefix.split('\n')) {
    const match = /^\s*(`{3,}|~{3,})(.*)$/.exec(line);
    if (!match) continue;
    const marker = match[1];
    const character = marker[0] as '`' | '~';
    const suffix = match[2];
    if (!activeFence) {
      activeFence = { character, length: marker.length };
    } else if (
      activeFence.character === character
      && marker.length >= activeFence.length
      && /^[ \t]*$/.test(suffix)
    ) {
      activeFence = null;
    }
  }

  return activeFence !== null;
}

function isViewInsideFencedCode(view: EditorView, position: number): boolean {
  const probe = position > 0 ? position - 1 : position;
  let node = syntaxTree(view.state).resolve(probe, 1);
  while (true) {
    if (node.name === 'FencedCode') return true;
    if (!node.parent) return false;
    node = node.parent;
  }
}

function getListContinuationEdit(document: MarkdownCompletionDocument, position: number): MarkdownCompletionEdit | null {
  const line = document.lineAt(position);
  if (position !== line.to) return null;

  const task = /^(\s*)([-+*])\s+\[([ xX])\]\s*(.*)$/.exec(line.text);
  if (task) {
    const [, indent, marker, , content] = task;
    if (!content.trim()) {
      return {
        from: line.from,
        to: position,
        insert: '\n',
        selection: { anchor: line.from + 1, head: line.from + 1 },
      };
    }
    const continuation = `\n${indent}${marker} [ ] `;
    return {
      from: position,
      to: position,
      insert: continuation,
      selection: { anchor: position + continuation.length, head: position + continuation.length },
    };
  }

  const bullet = /^(\s*)([-+*])\s+(.*)$/.exec(line.text);
  if (bullet) {
    const [, indent, marker, content] = bullet;
    if (!content.trim()) {
      return {
        from: line.from,
        to: position,
        insert: '\n',
        selection: { anchor: line.from + 1, head: line.from + 1 },
      };
    }
    const continuation = `\n${indent}${marker} `;
    return {
      from: position,
      to: position,
      insert: continuation,
      selection: { anchor: position + continuation.length, head: position + continuation.length },
    };
  }

  const ordered = /^(\s*)(\d+)([.)])\s+(.*)$/.exec(line.text);
  if (ordered) {
    const [, indent, sequence, delimiter, content] = ordered;
    if (!content.trim()) {
      return {
        from: line.from,
        to: position,
        insert: '\n',
        selection: { anchor: line.from + 1, head: line.from + 1 },
      };
    }
    const number = Number(sequence);
    if (!Number.isSafeInteger(number)) return null;
    const continuation = `\n${indent}${number + 1}${delimiter} `;
    return {
      from: position,
      to: position,
      insert: continuation,
      selection: { anchor: position + continuation.length, head: position + continuation.length },
    };
  }

  const quote = /^(\s*)>\s?(.*)$/.exec(line.text);
  if (!quote) return null;
  const [, indent, content] = quote;
  if (!content.trim()) {
    return {
      from: line.from,
      to: position,
      insert: '\n',
      selection: { anchor: line.from + 1, head: line.from + 1 },
    };
  }
  const continuation = `\n${indent}> `;
  return {
    from: position,
    to: position,
    insert: continuation,
    selection: { anchor: position + continuation.length, head: position + continuation.length },
  };
}

function getMarkdownCompletionEditForDocument(
  document: MarkdownCompletionDocument,
  selection: MarkdownCompletionSelection,
  input: MarkdownCompletionInput,
  insideFencedCode: boolean,
): MarkdownCompletionEdit | null {
  if (
    selection.from !== selection.to
    || input.from !== input.to
    || input.from !== selection.from
    || input.to !== selection.to
    || input.from < 0
    || input.to > document.length
    || !isCompletionTrigger(input.text)
    || insideFencedCode
  ) return null;

  return getListContinuationEdit(document, input.from);
}

export function getMarkdownCompletionEdit(
  source: string,
  selection: MarkdownCompletionSelection,
  input: MarkdownCompletionInput,
): MarkdownCompletionEdit | null {
  return getMarkdownCompletionEditForDocument(
    stringDocument(source),
    selection,
    input,
    isInsideFencedCode(source, input.from),
  );
}

function dispatchCompletion(view: EditorView, edit: MarkdownCompletionEdit): void {
  const changeRequired = edit.from !== edit.to || edit.insert.length > 0;
  view.dispatch({
    ...(changeRequired ? { changes: { from: edit.from, to: edit.to, insert: edit.insert } } : {}),
    selection: edit.selection,
    scrollIntoView: true,
    userEvent: 'input.type',
  });
}

export function markdownCompletionExtension(isEnabled: () => boolean): Extension {
  let awaitingPasteOrDrop = false;
  let composing = false;
  let compositionJustEnded = false;
  let resetTimer: ReturnType<typeof setTimeout> | null = null;
  const resetTransientInputState = () => {
    if (resetTimer !== null) clearTimeout(resetTimer);
    resetTimer = setTimeout(() => {
      awaitingPasteOrDrop = false;
      compositionJustEnded = false;
      resetTimer = null;
    }, 0);
  };
  const apply = (view: EditorView, input: MarkdownCompletionInput): boolean => {
    if (
      !isCompletionTrigger(input.text)
      || !isEnabled()
      || view.composing
      || composing
      || compositionJustEnded
      || awaitingPasteOrDrop
      || view.state.facet(EditorState.readOnly)
      || view.state.selection.ranges.length !== 1
    ) return false;
    const selection = view.state.selection.main;
    const edit = getMarkdownCompletionEditForDocument(
      view.state.doc,
      selection,
      input,
      isViewInsideFencedCode(view, input.from),
    );
    if (!edit) return false;
    dispatchCompletion(view, edit);
    return true;
  };

  return [
    EditorView.domEventHandlers({
      paste: () => {
        awaitingPasteOrDrop = true;
        resetTransientInputState();
        return false;
      },
      drop: () => {
        awaitingPasteOrDrop = true;
        resetTransientInputState();
        return false;
      },
      compositionstart: () => {
        composing = true;
        return false;
      },
      compositionend: () => {
        composing = false;
        compositionJustEnded = true;
        resetTransientInputState();
        return false;
      },
    }),
    EditorView.inputHandler.of((view, from, to, text) => apply(view, { from, to, text })),
    Prec.highest(keymap.of([{
      key: 'Enter',
      run: (view) => {
        const selection = view.state.selection.main;
        return apply(view, { from: selection.from, to: selection.to, text: '\n' });
      },
    }])),
  ];
}
