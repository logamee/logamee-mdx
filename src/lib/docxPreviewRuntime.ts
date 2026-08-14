import { classifyDocxMessages, type DocxConversionMessage } from './docxMessages';
import type { DocxImageResource } from './docxResources';
import { sanitizeDocxHtml } from './docxSanitizer';

export const DOCX_RUNTIME_LIMITS = Object.freeze({
  maxSourceBytes: 32 * 1024 * 1024,
  conversionTimeoutMs: 30_000,
});

export interface DocxWorkerRequest {
  readonly type: 'convert-docx';
  readonly requestId: string;
  readonly arrayBuffer: ArrayBuffer;
}

export type DocxWorkerResponse =
  | {
    readonly type: 'docx-converted';
    readonly requestId: string;
    readonly rawHtml: string;
    readonly images: readonly DocxImageResource[];
    readonly messages: readonly DocxConversionMessage[];
  }
  | {
    readonly type: 'docx-failed';
    readonly requestId: string;
  };

export interface DocxPreviewResult {
  readonly detectedLoss: boolean;
  readonly html: string;
  readonly nodeCount: number;
}

export interface DocxPreviewRun {
  readonly cancel: () => void;
  readonly done: Promise<DocxPreviewResult>;
}

export interface StartDocxPreviewOptions {
  readonly bytesBase64: string;
  readonly documentEpoch: number;
  readonly documentId: string;
}

export class DocxResourceLimitError extends Error {
  constructor(message = 'DOCX source resource limit exceeded') {
    super(message);
    this.name = 'DocxResourceLimitError';
  }
}

export class DocxDeadlineError extends Error {
  constructor() {
    super('DOCX conversion deadline exceeded');
    this.name = 'DocxDeadlineError';
  }
}

export class DocxCancelledError extends Error {
  constructor() {
    super('DOCX conversion cancelled');
    this.name = 'DocxCancelledError';
  }
}

export class DocxFatalConversionError extends Error {
  constructor() {
    super('DOCX conversion failed');
    this.name = 'DocxFatalConversionError';
  }
}

export class DocxWorkerProtocolError extends Error {
  constructor() {
    super('Invalid DOCX worker response');
    this.name = 'DocxWorkerProtocolError';
  }
}

const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function getCanonicalBase64ByteLength(value: string): number {
  if (value.length === 0 || value.length % 4 !== 0 || !BASE64_PATTERN.test(value)) {
    throw new DocxResourceLimitError('Invalid DOCX source encoding');
  }

  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  if (padding === 2) {
    const finalSextet = BASE64_ALPHABET.indexOf(value[value.length - 3]!);
    if (finalSextet < 0 || (finalSextet & 0x0f) !== 0) {
      throw new DocxResourceLimitError('Invalid DOCX source encoding');
    }
  } else if (padding === 1) {
    const finalSextet = BASE64_ALPHABET.indexOf(value[value.length - 2]!);
    if (finalSextet < 0 || (finalSextet & 0x03) !== 0) {
      throw new DocxResourceLimitError('Invalid DOCX source encoding');
    }
  }

  return (value.length / 4) * 3 - padding;
}

export function assertDocxSourceByteLength(byteLength: number): void {
  if (!Number.isSafeInteger(byteLength)
    || byteLength <= 0
    || byteLength > DOCX_RUNTIME_LIMITS.maxSourceBytes) {
    throw new DocxResourceLimitError();
  }
}

export function decodeDocxBase64(value: string): Uint8Array<ArrayBuffer> {
  const byteLength = getCanonicalBase64ByteLength(value);
  assertDocxSourceByteLength(byteLength);

  let binary: string;
  try {
    binary = atob(value);
  } catch {
    throw new DocxResourceLimitError('Invalid DOCX source encoding');
  }
  if (binary.length !== byteLength) {
    throw new DocxResourceLimitError('Invalid DOCX source encoding');
  }

  const bytes = new Uint8Array(new ArrayBuffer(byteLength));
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length
    && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

function isWorkerResponse(value: unknown): value is DocxWorkerResponse {
  if (!isRecord(value) || typeof value.requestId !== 'string') return false;
  if (value.type === 'docx-failed') {
    return hasExactKeys(value, ['type', 'requestId']);
  }
  return value.type === 'docx-converted'
    && typeof value.rawHtml === 'string'
    && Array.isArray(value.images)
    && Array.isArray(value.messages)
    && hasExactKeys(value, [
      'type', 'requestId', 'rawHtml', 'images', 'messages',
    ]);
}

function getRequestId(documentId: string, documentEpoch: number): string {
  if (documentId.trim().length === 0
    || !Number.isSafeInteger(documentEpoch)
    || documentEpoch < 0) {
    throw new DocxWorkerProtocolError();
  }
  return `${documentId}:${documentEpoch}`;
}

export function startDocxPreview({
  bytesBase64,
  documentEpoch,
  documentId,
}: StartDocxPreviewOptions): DocxPreviewRun {
  const requestId = getRequestId(documentId, documentEpoch);
  const previewBytes = decodeDocxBase64(bytesBase64);
  const worker = new Worker(
    new URL('../workers/docxPreview.worker.ts', import.meta.url),
    { name: 'mmd-docx-preview', type: 'module' },
  );
  let settled = false;
  let deadlineId: ReturnType<typeof setTimeout> | undefined;
  let resolveDone!: (result: DocxPreviewResult) => void;
  let rejectDone!: (reason: unknown) => void;

  const cleanup = () => {
    if (deadlineId !== undefined) clearTimeout(deadlineId);
    worker.onmessage = null;
    worker.onerror = null;
    worker.onmessageerror = null;
    worker.terminate();
  };
  const resolveOnce = (result: DocxPreviewResult) => {
    if (settled) return;
    settled = true;
    cleanup();
    resolveDone(result);
  };
  const rejectOnce = (reason: unknown) => {
    if (settled) return;
    settled = true;
    cleanup();
    rejectDone(reason);
  };

  const done = new Promise<DocxPreviewResult>((resolve, reject) => {
    resolveDone = resolve;
    rejectDone = reject;
  });

  worker.onmessage = (event: MessageEvent<unknown>) => {
    const response = event.data;
    if (!isWorkerResponse(response) || response.requestId !== requestId) {
      rejectOnce(new DocxWorkerProtocolError());
      return;
    }
    if (response.type === 'docx-failed') {
      rejectOnce(new DocxFatalConversionError());
      return;
    }

    try {
      const classification = classifyDocxMessages(response.messages);
      if (classification.fatal) throw new DocxFatalConversionError();
      const sanitized = sanitizeDocxHtml(response.rawHtml, response.images);
      resolveOnce({
        detectedLoss: classification.detectedLoss,
        html: sanitized.html,
        nodeCount: sanitized.nodeCount,
      });
    } catch (error) {
      rejectOnce(error);
    }
  };
  worker.onerror = (event) => {
    event.preventDefault();
    rejectOnce(new DocxFatalConversionError());
  };
  worker.onmessageerror = () => rejectOnce(new DocxWorkerProtocolError());
  deadlineId = setTimeout(() => {
    rejectOnce(new DocxDeadlineError());
  }, DOCX_RUNTIME_LIMITS.conversionTimeoutMs);

  const request: DocxWorkerRequest = {
    type: 'convert-docx',
    requestId,
    arrayBuffer: previewBytes.buffer,
  };
  try {
    worker.postMessage(request, [request.arrayBuffer]);
  } catch {
    rejectOnce(new DocxWorkerProtocolError());
  }

  return {
    cancel: () => rejectOnce(new DocxCancelledError()),
    done,
  };
}
