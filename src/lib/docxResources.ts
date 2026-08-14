export const DOCX_PREVIEW_LIMITS = Object.freeze({
  maxHtmlBytes: 4 * 1024 * 1024,
  maxSanitizedNodes: 50_000,
  maxImages: 50_000,
  maxImageBytes: 8 * 1024 * 1024,
  maxImagePixels: 24_000_000,
  maxTotalImageBytes: 32 * 1024 * 1024,
  maxTotalImagePixels: 64_000_000,
  conversionTimeoutMs: 30_000,
});

export const DOCX_ALLOWED_IMAGE_MIME_TYPES = Object.freeze([
  'image/gif',
  'image/jpeg',
  'image/png',
  'image/webp',
] as const);

export type DocxImageMimeType = typeof DOCX_ALLOWED_IMAGE_MIME_TYPES[number];

export interface DocxImageResource {
  readonly placeholder: string;
  readonly mimeType: DocxImageMimeType;
  readonly bytesBase64: string;
  readonly byteLength: number;
  readonly width: number;
  readonly height: number;
  readonly pixelCount: number;
}

export class DocxResourceLimitError extends Error {
  constructor(message = 'The DOCX contains an unsupported or oversized image.') {
    super(message);
    this.name = 'DocxResourceLimitError';
  }
}

type TokenGenerator = () => string;

interface ImageMetadata {
  mimeType: DocxImageMimeType;
  width: number;
  height: number;
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;
const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const PLACEHOLDER_TOKEN_PATTERN = /^[0-9a-f]{32}$/;
const BASE64_INPUT_CHUNK_BYTES = 12 * 1024;

function hasBytesAt(bytes: Uint8Array, offset: number, expected: readonly number[]): boolean {
  if (offset < 0 || offset + expected.length > bytes.byteLength) return false;
  return expected.every((value, index) => bytes[offset + index] === value);
}

function hasAsciiAt(bytes: Uint8Array, offset: number, expected: string): boolean {
  if (offset < 0 || offset + expected.length > bytes.byteLength) return false;
  for (let index = 0; index < expected.length; index += 1) {
    if (bytes[offset + index] !== expected.charCodeAt(index)) return false;
  }
  return true;
}

function readUint16BigEndian(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset] ?? 0) << 8) | (bytes[offset + 1] ?? 0);
}

function readUint16LittleEndian(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8);
}

function readUint24LittleEndian(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] ?? 0)
    | ((bytes[offset + 1] ?? 0) << 8)
    | ((bytes[offset + 2] ?? 0) << 16);
}

function readUint32BigEndian(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset] ?? 0) * 0x1000000)
    + ((bytes[offset + 1] ?? 0) << 16)
    + ((bytes[offset + 2] ?? 0) << 8)
    + (bytes[offset + 3] ?? 0);
}

function parsePngDimensions(bytes: Uint8Array): Pick<ImageMetadata, 'width' | 'height'> | null {
  if (!hasBytesAt(bytes, 0, PNG_SIGNATURE) || !hasAsciiAt(bytes, 12, 'IHDR')) return null;
  if (bytes.byteLength < 24) return null;
  return {
    width: readUint32BigEndian(bytes, 16),
    height: readUint32BigEndian(bytes, 20),
  };
}

function isJpegStartOfFrame(marker: number): boolean {
  return marker >= 0xc0
    && marker <= 0xcf
    && ![0xc4, 0xc8, 0xcc].includes(marker);
}

function parseJpegDimensions(bytes: Uint8Array): Pick<ImageMetadata, 'width' | 'height'> | null {
  if (!hasBytesAt(bytes, 0, [0xff, 0xd8])) return null;

  let offset = 2;
  while (offset < bytes.byteLength) {
    if (bytes[offset] !== 0xff) return null;
    while (bytes[offset] === 0xff) offset += 1;
    if (offset >= bytes.byteLength) return null;

    const marker = bytes[offset] ?? 0;
    offset += 1;
    if (marker === 0xd9) return null;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) continue;
    if (offset + 2 > bytes.byteLength) return null;

    const segmentLength = readUint16BigEndian(bytes, offset);
    if (segmentLength < 2 || offset + segmentLength > bytes.byteLength) return null;
    if (isJpegStartOfFrame(marker)) {
      if (segmentLength < 8) return null;
      return {
        height: readUint16BigEndian(bytes, offset + 3),
        width: readUint16BigEndian(bytes, offset + 5),
      };
    }
    offset += segmentLength;
  }

  return null;
}

function parseGifDimensions(bytes: Uint8Array): Pick<ImageMetadata, 'width' | 'height'> | null {
  if (!hasAsciiAt(bytes, 0, 'GIF87a') && !hasAsciiAt(bytes, 0, 'GIF89a')) return null;
  if (bytes.byteLength < 10) return null;
  return {
    width: readUint16LittleEndian(bytes, 6),
    height: readUint16LittleEndian(bytes, 8),
  };
}

function parseWebpDimensions(bytes: Uint8Array): Pick<ImageMetadata, 'width' | 'height'> | null {
  if (!hasAsciiAt(bytes, 0, 'RIFF') || !hasAsciiAt(bytes, 8, 'WEBP') || bytes.byteLength < 21) {
    return null;
  }

  if (hasAsciiAt(bytes, 12, 'VP8X')) {
    if (bytes.byteLength < 30) return null;
    return {
      width: readUint24LittleEndian(bytes, 24) + 1,
      height: readUint24LittleEndian(bytes, 27) + 1,
    };
  }

  if (hasAsciiAt(bytes, 12, 'VP8L')) {
    if (bytes.byteLength < 25 || bytes[20] !== 0x2f) return null;
    const byte1 = bytes[21] ?? 0;
    const byte2 = bytes[22] ?? 0;
    const byte3 = bytes[23] ?? 0;
    const byte4 = bytes[24] ?? 0;
    return {
      width: 1 + byte1 + ((byte2 & 0x3f) << 8),
      height: 1 + (byte2 >> 6) + (byte3 << 2) + ((byte4 & 0x0f) << 10),
    };
  }

  if (hasAsciiAt(bytes, 12, 'VP8 ')) {
    if (bytes.byteLength < 30 || !hasBytesAt(bytes, 23, [0x9d, 0x01, 0x2a])) return null;
    return {
      width: readUint16LittleEndian(bytes, 26) & 0x3fff,
      height: readUint16LittleEndian(bytes, 28) & 0x3fff,
    };
  }

  return null;
}

function inspectImage(mimeType: string, bytes: Uint8Array): ImageMetadata {
  let detectedMimeType: DocxImageMimeType | null = null;
  let dimensions: Pick<ImageMetadata, 'width' | 'height'> | null = null;

  if (hasBytesAt(bytes, 0, PNG_SIGNATURE)) {
    detectedMimeType = 'image/png';
    dimensions = parsePngDimensions(bytes);
  } else if (hasBytesAt(bytes, 0, [0xff, 0xd8])) {
    detectedMimeType = 'image/jpeg';
    dimensions = parseJpegDimensions(bytes);
  } else if (hasAsciiAt(bytes, 0, 'GIF87a') || hasAsciiAt(bytes, 0, 'GIF89a')) {
    detectedMimeType = 'image/gif';
    dimensions = parseGifDimensions(bytes);
  } else if (hasAsciiAt(bytes, 0, 'RIFF') && hasAsciiAt(bytes, 8, 'WEBP')) {
    detectedMimeType = 'image/webp';
    dimensions = parseWebpDimensions(bytes);
  }

  if (detectedMimeType === null || detectedMimeType !== mimeType || dimensions === null) {
    throw new DocxResourceLimitError();
  }
  if (!Number.isSafeInteger(dimensions.width) || !Number.isSafeInteger(dimensions.height)) {
    throw new DocxResourceLimitError();
  }
  if (dimensions.width <= 0 || dimensions.height <= 0) {
    throw new DocxResourceLimitError();
  }

  return { mimeType: detectedMimeType, ...dimensions };
}

function getPixelCount(width: number, height: number): number {
  if (width > Math.floor(DOCX_PREVIEW_LIMITS.maxImagePixels / height)) {
    throw new DocxResourceLimitError();
  }
  return width * height;
}

function getBase64Length(byteLength: number): number {
  return Math.ceil(byteLength / 3) * 4;
}

function encodeBase64(bytes: Uint8Array): string {
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

  const remainder = bytes.byteLength - completeByteLength;
  if (remainder === 1) {
    const value = (bytes[completeByteLength] ?? 0) << 16;
    parts.push(
      BASE64_ALPHABET[(value >> 18) & 0x3f]
      + BASE64_ALPHABET[(value >> 12) & 0x3f]
      + '==',
    );
  } else if (remainder === 2) {
    const value = ((bytes[completeByteLength] ?? 0) << 16)
      | ((bytes[completeByteLength + 1] ?? 0) << 8);
    parts.push(
      BASE64_ALPHABET[(value >> 18) & 0x3f]
      + BASE64_ALPHABET[(value >> 12) & 0x3f]
      + BASE64_ALPHABET[(value >> 6) & 0x3f]
      + '=',
    );
  }

  return parts.join('');
}

function createDefaultToken(): string {
  const cryptoApi = globalThis.crypto;
  if (cryptoApi === undefined || typeof cryptoApi.getRandomValues !== 'function') {
    throw new DocxResourceLimitError('Secure image placeholder generation is unavailable.');
  }

  const bytes = new Uint8Array(16);
  cryptoApi.getRandomValues(bytes);
  return Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('');
}

function createResource(
  placeholder: string,
  metadata: ImageMetadata,
  bytes: Uint8Array,
  pixelCount: number,
): DocxImageResource {
  let retainedBytes: Uint8Array | null = bytes.slice();
  let encodedBytes: string | null = null;

  const resource = {
    placeholder,
    mimeType: metadata.mimeType,
    byteLength: bytes.byteLength,
    width: metadata.width,
    height: metadata.height,
    pixelCount,
    get bytesBase64() {
      if (encodedBytes === null) {
        encodedBytes = encodeBase64(retainedBytes ?? new Uint8Array());
        retainedBytes = null;
      }
      return encodedBytes;
    },
  } satisfies DocxImageResource;

  return Object.freeze(resource);
}

export class DocxImageRegistry {
  readonly #placeholderOrigin: string;
  readonly #images: DocxImageResource[] = [];
  #totalBytes = 0;
  #totalPixels = 0;
  #totalBase64Length = 0;

  constructor(tokenGenerator: TokenGenerator = createDefaultToken) {
    const token = tokenGenerator();
    if (!PLACEHOLDER_TOKEN_PATTERN.test(token)) {
      throw new DocxResourceLimitError('Secure image placeholder generation failed.');
    }
    this.#placeholderOrigin = `https://${token}.invalid`;
  }

  get images(): readonly DocxImageResource[] {
    return this.#images.slice();
  }

  register(mimeType: string, bytes: Uint8Array): DocxImageResource {
    if (!(bytes instanceof Uint8Array) || bytes.byteLength > DOCX_PREVIEW_LIMITS.maxImageBytes) {
      throw new DocxResourceLimitError();
    }
    if (this.#images.length >= DOCX_PREVIEW_LIMITS.maxImages) {
      throw new DocxResourceLimitError();
    }

    const metadata = inspectImage(mimeType, bytes);
    const pixelCount = getPixelCount(metadata.width, metadata.height);
    const nextTotalBytes = this.#totalBytes + bytes.byteLength;
    const nextTotalPixels = this.#totalPixels + pixelCount;
    const nextTotalBase64Length = this.#totalBase64Length + getBase64Length(bytes.byteLength);
    const maxTotalBase64Length = getBase64Length(DOCX_PREVIEW_LIMITS.maxTotalImageBytes)
      + (DOCX_PREVIEW_LIMITS.maxImages * 2);

    if (nextTotalBytes > DOCX_PREVIEW_LIMITS.maxTotalImageBytes
      || nextTotalPixels > DOCX_PREVIEW_LIMITS.maxTotalImagePixels
      || nextTotalBase64Length > maxTotalBase64Length) {
      throw new DocxResourceLimitError();
    }

    const resource = createResource(
      `${this.#placeholderOrigin}/image/${this.#images.length + 1}`,
      metadata,
      bytes,
      pixelCount,
    );
    this.#images.push(resource);
    this.#totalBytes = nextTotalBytes;
    this.#totalPixels = nextTotalPixels;
    this.#totalBase64Length = nextTotalBase64Length;
    return resource;
  }
}
