
export const MARKDOWN_MEDIA_INSERTION_EVENT = 'mmd-markdown-media-insertion';
export const MARKDOWN_MEDIA_INSERTION_READY_EVENT = 'mmd-markdown-media-insertion-ready';
export const MARKDOWN_MEDIA_INSERTION_REQUEST_READY_EVENT = 'mmd-markdown-media-insertion-request-ready';
export const MARKDOWN_MEDIA_INSERTION_HANDSHAKE_EVENT = 'mmd-markdown-media-insertion-handshake';
export const MARKDOWN_MEDIA_INSERTION_HANDSHAKE_ACK_EVENT = 'mmd-markdown-media-insertion-handshake-ack';

export { isMarkdownWorkspaceReferenceKind, decodeMarkdownMediaCursorInsertion, decodeMarkdownMediaInsertionReady, decodeMarkdownMediaInsertionReadyRequest, decodeMarkdownMediaInsertionHandshake } from './markdownMediaDecode';
export type { MarkdownMediaDocument, MarkdownMediaInsertionTarget, MarkdownMediaInsertion, MarkdownMediaCursorInsertion, MarkdownMediaInsertionReady, MarkdownMediaInsertionHandshake } from './markdownMediaDecode';
export { createMarkdownImageReference, createMarkdownPickedMediaReference, createMarkdownMediaDestination, createMarkdownExcalidrawAssetReference, createMarkdownMediaReference, resolveWorkspaceRelativeMediaPath } from './markdownMediaReference';
