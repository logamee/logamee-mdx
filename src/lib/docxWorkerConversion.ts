import mammoth from 'mammoth';
import type { DocxConversionMessage } from './docxMessages';
import {
  DOCX_PREVIEW_LIMITS,
  DocxImageRegistry,
  type DocxImageResource,
} from './docxResources';

export interface MammothImage {
  readonly contentType: string;
  readonly readAsArrayBuffer: () => Promise<unknown>;
}

export interface MammothConversionApi {
  readonly images: {
    imgElement: (
      callback: (image: MammothImage) => Promise<{ src: string }>,
    ) => unknown;
  };
  readonly convertToHtml: (
    input: { arrayBuffer: ArrayBuffer },
    options: {
      convertImage: unknown;
      externalFileAccess: false;
      includeDefaultStyleMap: true;
      includeEmbeddedStyleMap: false;
    },
  ) => Promise<{ value: string; messages: readonly unknown[] }>;
}

export interface DocxWorkerConversionResult {
  readonly rawHtml: string;
  readonly images: readonly DocxImageResource[];
  readonly messages: readonly DocxConversionMessage[];
}

interface ConvertDocxArrayBufferOptions {
  readonly mammothApi?: MammothConversionApi;
  readonly tokenGenerator?: () => string;
}

export class DocxWorkerConversionError extends Error {
  constructor(message = 'DOCX conversion failed') {
    super(message);
    this.name = 'DocxWorkerConversionError';
  }
}

const MAX_DOCX_SOURCE_BYTES = 32 * 1024 * 1024;
const defaultMammothApi = mammoth as unknown as MammothConversionApi;

function getUtf8ByteLengthWithinLimit(value: string): number {
  if (value.length > DOCX_PREVIEW_LIMITS.maxHtmlBytes) return value.length;
  return new TextEncoder().encode(value).byteLength;
}

function getConversionMessages(messages: readonly unknown[]): DocxConversionMessage[] {
  const converted: DocxConversionMessage[] = [];
  for (const value of messages) {
    if (typeof value !== 'object' || value === null) continue;
    const record = value as Record<string, unknown>;
    if ((record.type === 'warning' || record.type === 'error')
      && typeof record.message === 'string') {
      converted.push({ type: record.type, message: record.message });
    }
  }
  return converted;
}

function copyEmbeddedImageBytes(value: unknown): Uint8Array {
  let source: Uint8Array;
  if (value instanceof ArrayBuffer) {
    source = new Uint8Array(value);
  } else if (ArrayBuffer.isView(value)) {
    source = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  } else {
    throw new DocxWorkerConversionError('Invalid embedded DOCX image');
  }

  const copy = new Uint8Array(source.byteLength);
  copy.set(source);
  return copy;
}

export async function convertDocxArrayBuffer(
  arrayBuffer: ArrayBuffer,
  options: ConvertDocxArrayBufferOptions = {},
): Promise<DocxWorkerConversionResult> {
  if (!(arrayBuffer instanceof ArrayBuffer)
    || arrayBuffer.byteLength <= 0
    || arrayBuffer.byteLength > MAX_DOCX_SOURCE_BYTES) {
    throw new DocxWorkerConversionError('Invalid DOCX source bytes');
  }

  const mammothApi = options.mammothApi ?? defaultMammothApi;
  const registry = new DocxImageRegistry(options.tokenGenerator);
  const convertImage = mammothApi.images.imgElement(async (image) => {
    const embeddedBytes = copyEmbeddedImageBytes(await image.readAsArrayBuffer());
    const resource = registry.register(image.contentType, embeddedBytes);
    return { src: resource.placeholder };
  });

  const result = await mammothApi.convertToHtml(
    { arrayBuffer },
    {
      convertImage,
      externalFileAccess: false,
      includeDefaultStyleMap: true,
      includeEmbeddedStyleMap: false,
    },
  );
  if (typeof result?.value !== 'string' || !Array.isArray(result.messages)) {
    throw new DocxWorkerConversionError();
  }
  if (getUtf8ByteLengthWithinLimit(result.value) > DOCX_PREVIEW_LIMITS.maxHtmlBytes) {
    throw new DocxWorkerConversionError('Generated DOCX HTML is too large');
  }

  return {
    rawHtml: result.value,
    images: registry.images,
    messages: getConversionMessages(result.messages),
  };
}
