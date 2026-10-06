import type { DocxImageResource, ImageMetadata } from './docxImageFormats';
import {
  createDefaultToken,
  encodeBase64,
  getBase64Length,
  getPixelCount,
  PLACEHOLDER_TOKEN_PATTERN,
  type TokenGenerator,
} from './docxImageEncoding';
import { DOCX_PREVIEW_LIMITS, DocxResourceLimitError } from './docxImageFormats';
import { inspectImage } from './docxImageEncoding';

export { DOCX_PREVIEW_LIMITS, DOCX_ALLOWED_IMAGE_MIME_TYPES, DocxResourceLimitError } from './docxImageFormats';
export type { DocxImageResource } from './docxImageFormats';

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
