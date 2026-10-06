import { sniffImageFormat, type DocxImageMimeType, type ImageMetadata } from './docxImageFormats';
export type TokenGenerator = () => string;
export const PLACEHOLDER_TOKEN_PATTERN = /^[0-9a-f]{32}$/;
const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const BASE64_INPUT_CHUNK_BYTES = 12 * 1024;

import { DOCX_PREVIEW_LIMITS, DocxResourceLimitError } from './docxImageFormats';

export function inspectImage(mimeType: string, bytes: Uint8Array): ImageMetadata {
  const sniffed = sniffImageFormat(bytes);
  const detectedMimeType = sniffed?.mimeType ?? null;
  const dimensions = sniffed?.parse(bytes) ?? null;

  if (detectedMimeType === null || dimensions === null) throw new DocxResourceLimitError();
  return validatedImageMetadata(detectedMimeType, mimeType, dimensions);
}

function validatedImageMetadata(
  detectedMimeType: DocxImageMimeType,
  expectedMimeType: string,
  dimensions: Pick<ImageMetadata, 'width' | 'height'>,
): ImageMetadata {
  if (detectedMimeType !== expectedMimeType) throw new DocxResourceLimitError();
  if (!Number.isSafeInteger(dimensions.width) || !Number.isSafeInteger(dimensions.height)) {
    throw new DocxResourceLimitError();
  }
  if (dimensions.width <= 0 || dimensions.height <= 0) {
    throw new DocxResourceLimitError();
  }
  return { mimeType: detectedMimeType, ...dimensions };
}

export function getPixelCount(width: number, height: number): number {
  if (width > Math.floor(DOCX_PREVIEW_LIMITS.maxImagePixels / height)) {
    throw new DocxResourceLimitError();
  }
  return width * height;
}

export function getBase64Length(byteLength: number): number {
  return Math.ceil(byteLength / 3) * 4;
}

function encodeBase64Remainder(bytes: Uint8Array, completeByteLength: number): string {
  const remainder = bytes.byteLength - completeByteLength;
  if (remainder === 0) return '';
  if (remainder === 1) {
    const value = (bytes[completeByteLength] ?? 0) << 16;
    return BASE64_ALPHABET[(value >> 18) & 0x3f]
      + BASE64_ALPHABET[(value >> 12) & 0x3f]
      + '==';
  }
  const value = ((bytes[completeByteLength] ?? 0) << 16)
    | ((bytes[completeByteLength + 1] ?? 0) << 8);
  return BASE64_ALPHABET[(value >> 18) & 0x3f]
    + BASE64_ALPHABET[(value >> 12) & 0x3f]
    + BASE64_ALPHABET[(value >> 6) & 0x3f]
    + '=';
}

export function encodeBase64(bytes: Uint8Array): string {
  const parts: string[] = [];
  const completeByteLength = bytes.byteLength - (bytes.byteLength % 3);

  for (let chunkStart = 0; chunkStart < completeByteLength; chunkStart += BASE64_INPUT_CHUNK_BYTES) {
    const chunkEnd = Math.min(chunkStart + BASE64_INPUT_CHUNK_BYTES, completeByteLength);
    let part = '';
    for (let index = chunkStart; index < chunkEnd; index += 3) {
      const value = ((bytes[index] ?? 0) << 16)
        | ((bytes[index + 1] ?? 0) << 8)
        | (bytes[index + 2] ?? 0);
      part += BASE64_ALPHABET[(value >> 18) & 0x3f]
        + BASE64_ALPHABET[(value >> 12) & 0x3f]
        + BASE64_ALPHABET[(value >> 6) & 0x3f]
        + BASE64_ALPHABET[value & 0x3f];
    }
    parts.push(part);
  }

  parts.push(encodeBase64Remainder(bytes, completeByteLength));

  return parts.join('');
}

export function createDefaultToken(): string {
  const cryptoApi = globalThis.crypto;
  if (cryptoApi === undefined || typeof cryptoApi.getRandomValues !== 'function') {
    throw new DocxResourceLimitError('Secure image placeholder generation is unavailable.');
  }

  const bytes = new Uint8Array(16);
  cryptoApi.getRandomValues(bytes);
  return Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('');
}
