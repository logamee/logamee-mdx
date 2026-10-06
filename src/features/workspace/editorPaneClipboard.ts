import type { EditorView } from '@codemirror/view';
import type { ChangeDesc } from '@codemirror/state';
import type { MutableRefObject, RefObject } from 'react';
import { RICH_PASTE_LIMITS, RichPasteConversionError, convertRichClipboardPayload } from '../../lib/richPaste';
import type { WorkspaceFileKind } from '../../types';
import {
  CLIPBOARD_IMAGE_REJECTION_MESSAGE,
  CLIPBOARD_IMAGE_UNAVAILABLE_MESSAGE,
  RICH_PASTE_FORMATTING_LOSS_MESSAGE,
  type ClipboardImageCollection,
  type ClipboardImagePasteRequest,
  type ClipboardPasteImageFile,
  type PendingClipboardPaste,
} from './editorPaneTypes';

export interface ClipboardPasteHandlerDeps {
  clipboardPasteIdRef: RefObject<number>;
  documentEpochRef: RefObject<number>;
  documentIdRef: RefObject<string>;
  editableRef: RefObject<boolean>;
  fileKindRef: RefObject<WorkspaceFileKind>;
  onPasteErrorRef: RefObject<((error: unknown) => void) | undefined>;
  onPasteImageRef: RefObject<((request: ClipboardImagePasteRequest) => Promise<string | null>) | undefined>;
  pendingClipboardPasteRef: MutableRefObject<PendingClipboardPaste | null>;
  editorViewRef: RefObject<EditorView | null>;
}

function isPasteableImageFile(item: DataTransferItem): boolean {
  return item.kind === 'file' && item.type.toLowerCase().startsWith('image/');
}

function toClipboardImageFile(item: DataTransferItem, blob: File): ClipboardPasteImageFile | null {
  const mimeType = blob.type || item.type || 'application/octet-stream';
  if (mimeType.toLowerCase().startsWith('image/svg+xml') || blob.size > RICH_PASTE_LIMITS.maxImageBytes) {
    return null;
  }
  return {
    blob,
    mimeType,
    suggestedName: blob.name || null,
  };
}

// 剪贴板图片收集：过滤不可粘贴类型（SVG、超限体积），任一被拒即产生拒绝错误。
function collectClipboardImages(clipboardData: DataTransfer): ClipboardImageCollection {
  const images: ClipboardPasteImageFile[] = [];
  let rejected = false;
  for (const item of Array.from(clipboardData.items)) {
    if (!isPasteableImageFile(item)) continue;
    const blob = item.getAsFile();
    if (!blob) continue;
    const image = toClipboardImageFile(item, blob);
    if (!image) {
      rejected = true;
      continue;
    }
    images.push(image);
  }
  return {
    images,
    rejection: rejected ? new RichPasteConversionError(CLIPBOARD_IMAGE_REJECTION_MESSAGE) : null,
  };
}

function combinePastedMarkdown(parts: readonly (string | null | undefined)[]): string {
  return parts.map((part) => part?.trim() ?? '').filter((part) => part.length > 0).join('\n\n');
}

export function mapPendingClipboardPaste(pending: PendingClipboardPaste | null, changes: ChangeDesc): void {
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

function clipboardPayloadText(clipboardData: DataTransfer): { html: string; rtf: string; text: string } {
  return {
    html: clipboardData.getData('text/html'),
    rtf: clipboardData.getData('text/rtf'),
    text: clipboardData.getData('text/plain'),
  };
}

// 富文本→Markdown 转换：无图片兜底时转换失败必须拦截粘贴；格式损失走提示。
function convertClipboardMarkdown(
  payload: { html: string; rtf: string; text: string },
  images: ClipboardPasteImageFile[],
  onPasteErrorRef: ClipboardPasteHandlerDeps['onPasteErrorRef'],
  event: ClipboardEvent,
): { intercepted: boolean; markdown: string | null } {
  try {
    const conversion = convertRichClipboardPayload(payload);
    if (conversion.formattingLoss && conversion.source === 'text') {
      onPasteErrorRef.current?.(new RichPasteConversionError(RICH_PASTE_FORMATTING_LOSS_MESSAGE));
    }
    return { intercepted: false, markdown: conversion.markdown };
  } catch (error) {
    if (images.length === 0) {
      event.preventDefault();
      onPasteErrorRef.current?.(error);
      return { intercepted: true, markdown: null };
    }
    onPasteErrorRef.current?.(error);
    return { intercepted: false, markdown: null };
  }
}

// 待插入会话是否仍然有效：文档世代/ID、视图实例与可编辑状态任一变化即作废。
function pendingPasteCurrent(
  deps: ClipboardPasteHandlerDeps,
  pasteView: EditorView,
  pasteId: number,
  pasteDocumentEpoch: number,
  pasteDocumentId: string,
): boolean {
  const pendingPaste = deps.pendingClipboardPasteRef.current;
  return Boolean(pendingPaste)
    && pendingPaste!.id === pasteId
    && pendingPaste!.documentEpoch === pasteDocumentEpoch
    && pendingPaste!.documentId === pasteDocumentId
    && deps.editorViewRef.current === pasteView
    && deps.editableRef.current
    && deps.fileKindRef.current === 'markdown'
    && deps.documentEpochRef.current === pasteDocumentEpoch
    && deps.documentIdRef.current === pasteDocumentId;
}

// 图片粘贴异步流：登记会话后逐张请求资源，全部完成后若会话仍有效则合并插入。
function scheduleImagePaste(
  deps: ClipboardPasteHandlerDeps,
  pasteView: EditorView,
  request: {
    from: number;
    images: ClipboardPasteImageFile[];
    markdown: string | null;
    pasteImage: (request: ClipboardImagePasteRequest) => Promise<string | null>;
    to: number;
  },
): true {
  const { documentEpochRef, documentIdRef, onPasteErrorRef, pendingClipboardPasteRef } = deps;
  const pasteDocumentEpoch = documentEpochRef.current;
  const pasteDocumentId = documentIdRef.current;
  const pasteId = deps.clipboardPasteIdRef.current + 1;
  deps.clipboardPasteIdRef.current = pasteId;
  pendingClipboardPasteRef.current = {
    documentEpoch: pasteDocumentEpoch, documentId: pasteDocumentId,
    from: request.from, id: pasteId, to: request.to,
  };

  void Promise.all(request.images.map(async (image) => {
    try {
      return await request.pasteImage({
        blob: image.blob, documentEpoch: pasteDocumentEpoch, documentId: pasteDocumentId,
        mimeType: image.mimeType, suggestedName: image.suggestedName,
      });
    } catch (error) {
      onPasteErrorRef.current?.(error);
      return null;
    }
  })).then((imageMarkdowns) => {
    const pendingPaste = pendingClipboardPasteRef.current;
    if (!pendingPasteCurrent(deps, pasteView, pasteId, pasteDocumentEpoch, pasteDocumentId)) return;

    const combinedMarkdown = combinePastedMarkdown([request.markdown, ...imageMarkdowns]);
    pendingClipboardPasteRef.current = null;
    if (!combinedMarkdown) return;
    dispatchClipboardMarkdown(pasteView, pendingPaste!.from, pendingPaste!.to, combinedMarkdown);
  }).catch((error: unknown) => {
    pendingClipboardPasteRef.current = null;
    onPasteErrorRef.current?.(error);
  });
  return true;
}

interface PasteTriage {
  images: ClipboardPasteImageFile[];
  intercepted: boolean;
  markdown: string | null;
  rejection: RichPasteConversionError | null;
}

// 粘贴分诊：读取剪贴板负载，完成文本转换与图片收集。
function collectPasteTriage(
  event: ClipboardEvent,
  onPasteErrorRef: ClipboardPasteHandlerDeps['onPasteErrorRef'],
): PasteTriage | null {
  const clipboardData = event.clipboardData;
  if (!clipboardData) return null;
  const payload = clipboardPayloadText(clipboardData);
  const hasClipboardText = payload.html.trim().length > 0
    || payload.rtf.trim().length > 0
    || payload.text.trim().length > 0;
  const { images, rejection } = collectClipboardImages(clipboardData);
  const conversion = hasClipboardText
    ? convertClipboardMarkdown(payload, images, onPasteErrorRef, event)
    : { intercepted: false, markdown: null };
  return { images, intercepted: conversion.intercepted, markdown: conversion.markdown, rejection };
}

// 分诊收尾：上报拒绝、转换拦截与空负载短路，返回粘贴是否已终结。
function resolvePasteTriage(
  event: ClipboardEvent,
  triage: PasteTriage,
  onPasteErrorRef: ClipboardPasteHandlerDeps['onPasteErrorRef'],
): 'continue' | 'handled' | 'rejected' {
  if (triage.rejection) onPasteErrorRef.current?.(triage.rejection);
  if (triage.intercepted) return 'handled';
  if (!triage.markdown && triage.images.length === 0) {
    if (triage.rejection) event.preventDefault();
    return triage.rejection ? 'handled' : 'rejected';
  }
  return 'continue';
}

// 无异步图片的同步粘贴路径：纯 Markdown 插入，或图片不可用提示后插入文本。
function pasteWithoutImages(
  deps: ClipboardPasteHandlerDeps,
  pasteView: EditorView,
  images: ClipboardPasteImageFile[],
  markdown: string | null,
  from: number,
  to: number,
): true {
  if (images.length > 0) {
    deps.onPasteErrorRef.current?.(new RichPasteConversionError(CLIPBOARD_IMAGE_UNAVAILABLE_MESSAGE));
  }
  if (markdown) dispatchClipboardMarkdown(pasteView, from, to, markdown);
  return true;
}

// 编辑器粘贴入口：富文本转换与图片收集分流，图片走异步资源请求后合并插入。
export function createClipboardPasteHandler(deps: ClipboardPasteHandlerDeps) {
  const { clipboardPasteIdRef, documentEpochRef, documentIdRef, editableRef, fileKindRef, onPasteErrorRef, onPasteImageRef, pendingClipboardPasteRef } = deps;
  return (event: ClipboardEvent, pasteView: EditorView): boolean => {
    if (!editableRef.current || fileKindRef.current !== 'markdown') return false;
    const triage = collectPasteTriage(event, onPasteErrorRef);
    if (!triage) return false;
    const resolved = resolvePasteTriage(event, triage, onPasteErrorRef);
    if (resolved !== 'continue') return resolved === 'handled';

    event.preventDefault();
    const { from, to } = pasteView.state.selection.main;
    const pasteImage = onPasteImageRef.current;
    if (triage.images.length === 0 || !pasteImage) {
      return pasteWithoutImages(deps, pasteView, triage.images, triage.markdown, from, to);
    }
    return scheduleImagePaste({ clipboardPasteIdRef, documentEpochRef, documentIdRef, editorViewRef: deps.editorViewRef, editableRef, fileKindRef, onPasteErrorRef, onPasteImageRef, pendingClipboardPasteRef }, pasteView, {
      from, images: triage.images, markdown: triage.markdown, pasteImage, to,
    });
  };
}
