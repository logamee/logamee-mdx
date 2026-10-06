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


export interface ImageMetadata {
  mimeType: DocxImageMimeType;
  width: number;
  height: number;
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;

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
    const segment = nextJpegSegment(bytes, offset);
    if (segment === null) return null;
    if (segment.kind === 'end') return null;
    if (segment.kind === 'skip') {
      offset = segment.nextOffset;
      continue;
    }
    return jpegFrameDimensions(bytes, segment.nextOffset);
  }

  return null;
}

function nextJpegSegment(
  bytes: Uint8Array,
  startOffset: number,
):
  | { kind: 'frame'; nextOffset: number }
  | { kind: 'skip'; nextOffset: number }
  | { kind: 'end' }
  | null {
  let offset = startOffset;
  if (bytes[offset] !== 0xff) return null;
  while (bytes[offset] === 0xff) offset += 1;
  if (offset >= bytes.byteLength) return null;

  const marker = bytes[offset] ?? 0;
  offset += 1;
  const classification = classifyJpegMarker(bytes, marker, offset);
  return classification;
}

function classifyJpegMarker(
  bytes: Uint8Array,
  marker: number,
  offset: number,
):
  | { kind: 'frame'; nextOffset: number }
  | { kind: 'skip'; nextOffset: number }
  | { kind: 'end' }
  | null {
  if (marker === 0xd9) return { kind: 'end' };
  if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
    return { kind: 'skip', nextOffset: offset };
  }
  if (offset + 2 > bytes.byteLength) return null;

  const segmentLength = readUint16BigEndian(bytes, offset);
  if (segmentLength < 2 || offset + segmentLength > bytes.byteLength) return null;
  if (isJpegStartOfFrame(marker)) return { kind: 'frame', nextOffset: offset };
  return { kind: 'skip', nextOffset: offset + segmentLength };
}

function jpegFrameDimensions(
  bytes: Uint8Array,
  offset: number,
): Pick<ImageMetadata, 'width' | 'height'> | null {
  const segmentLength = readUint16BigEndian(bytes, offset);
  if (segmentLength < 8) return null;
  return {
    height: readUint16BigEndian(bytes, offset + 3),
    width: readUint16BigEndian(bytes, offset + 5),
  };
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

  if (hasAsciiAt(bytes, 12, 'VP8L')) return webpLosslessDimensions(bytes);
  if (hasAsciiAt(bytes, 12, 'VP8 ')) return webpLossyDimensions(bytes);

  return null;
}

function webpLosslessDimensions(bytes: Uint8Array): Pick<ImageMetadata, 'width' | 'height'> | null {
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

function webpLossyDimensions(bytes: Uint8Array): Pick<ImageMetadata, 'width' | 'height'> | null {
  if (bytes.byteLength < 30 || !hasBytesAt(bytes, 23, [0x9d, 0x01, 0x2a])) return null;
  return {
    width: readUint16LittleEndian(bytes, 26) & 0x3fff,
    height: readUint16LittleEndian(bytes, 28) & 0x3fff,
  };
}

const IMAGE_SNIFFERS: ReadonlyArray<{
  mimeType: DocxImageMimeType;
  matches: (bytes: Uint8Array) => boolean;
  parse: (bytes: Uint8Array) => Pick<ImageMetadata, 'width' | 'height'> | null;
}> = [
  { mimeType: 'image/png', matches: (b) => hasBytesAt(b, 0, PNG_SIGNATURE), parse: parsePngDimensions },
  { mimeType: 'image/jpeg', matches: (b) => hasBytesAt(b, 0, [0xff, 0xd8]), parse: parseJpegDimensions },
  {
    mimeType: 'image/gif',
    matches: (b) => hasAsciiAt(b, 0, 'GIF87a') || hasAsciiAt(b, 0, 'GIF89a'),
    parse: parseGifDimensions,
  },
  {
    mimeType: 'image/webp',
    matches: (b) => hasAsciiAt(b, 0, 'RIFF') && hasAsciiAt(b, 8, 'WEBP'),
    parse: parseWebpDimensions,
  },
];

export function sniffImageFormat(bytes: Uint8Array) {
  return IMAGE_SNIFFERS.find((sniffer) => sniffer.matches(bytes)) ?? null;
}
