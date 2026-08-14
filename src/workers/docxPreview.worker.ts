import type {
  DocxWorkerRequest,
  DocxWorkerResponse,
} from '../lib/docxPreviewRuntime';
import { convertDocxArrayBuffer } from '../lib/docxWorkerConversion';

interface DocxWorkerScope {
  onmessage: ((event: MessageEvent<unknown>) => void) | null;
  postMessage: (message: DocxWorkerResponse) => void;
}

const workerScope = globalThis as unknown as DocxWorkerScope;
let conversionStarted = false;

function isConversionRequest(value: unknown): value is DocxWorkerRequest {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  return keys.length === 3
    && keys.every((key) => ['type', 'requestId', 'arrayBuffer'].includes(key))
    && record.type === 'convert-docx'
    && typeof record.requestId === 'string'
    && record.requestId.length > 0
    && record.arrayBuffer instanceof ArrayBuffer;
}

workerScope.onmessage = (event) => {
  if (conversionStarted || !isConversionRequest(event.data)) return;
  conversionStarted = true;
  const request = event.data;

  void convertDocxArrayBuffer(request.arrayBuffer).then((result) => {
    workerScope.postMessage({
      type: 'docx-converted',
      requestId: request.requestId,
      rawHtml: result.rawHtml,
      images: result.images,
      messages: result.messages,
    });
  }).catch(() => {
    workerScope.postMessage({
      type: 'docx-failed',
      requestId: request.requestId,
    });
  });
};
