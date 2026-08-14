import { describe, expect, it, vi } from 'vitest';
import { DOCX_PREVIEW_LIMITS } from './docxResources';
import {
  DocxWorkerConversionError,
  convertDocxArrayBuffer,
  type MammothConversionApi,
  type MammothImage,
} from './docxWorkerConversion';

function pngBytes(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(24);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

describe('DOCX Mammoth worker conversion', () => {
  it('copies a Uint8Array-backed Mammoth image view into the bounded registry', async () => {
    const png = pngBytes(3, 2);
    const backing = new Uint8Array(png.byteLength + 4);
    backing.set([0xde, 0xad], 0);
    backing.set(png, 2);
    backing.set([0xbe, 0xef], png.byteLength + 2);
    const imageView = backing.subarray(2, png.byteLength + 2);
    let convertImage!: (image: MammothImage) => Promise<{ src: string }>;
    const imageConverter = { __converter: 'bounded-registry' };
    const api: MammothConversionApi = {
      images: {
        imgElement: vi.fn<MammothConversionApi['images']['imgElement']>((callback) => {
          convertImage = callback;
          return imageConverter;
        }),
      },
      convertToHtml: vi.fn<MammothConversionApi['convertToHtml']>(async () => {
        const convertedImage = await convertImage({
          contentType: 'image/png',
          readAsArrayBuffer: async () => imageView,
        });
        return {
          value: `<img src="${convertedImage.src}">`,
          messages: [],
        };
      }),
    };

    const result = await convertDocxArrayBuffer(new ArrayBuffer(1), {
      mammothApi: api,
      tokenGenerator: () => 'abcdefabcdefabcdefabcdefabcdefab',
    });

    expect(result.images).toHaveLength(1);
    expect(result.images[0]).toMatchObject({
      mimeType: 'image/png',
      bytesBase64: 'iVBORw0KGgoAAAAASUhEUgAAAAMAAAAC',
      byteLength: png.byteLength,
      width: 3,
      height: 2,
      pixelCount: 6,
    });
  });

  it('rejects embedded image values that are neither ArrayBuffer nor ArrayBufferView', async () => {
    let convertImage!: (image: MammothImage) => Promise<{ src: string }>;
    const api: MammothConversionApi = {
      images: {
        imgElement: vi.fn<MammothConversionApi['images']['imgElement']>((callback) => {
          convertImage = callback;
          return { __converter: 'bounded-registry' };
        }),
      },
      convertToHtml: vi.fn<MammothConversionApi['convertToHtml']>(async () => {
        await convertImage({
          contentType: 'image/png',
          readAsArrayBuffer: async () => 'not image bytes',
        });
        return { value: '', messages: [] };
      }),
    };

    await expect(convertDocxArrayBuffer(new ArrayBuffer(1), { mammothApi: api }))
      .rejects.toThrow('Invalid embedded DOCX image');
  });

  it('uses bytes-only conversion, locked options, and only the bounded image registry converter', async () => {
    const source = new Uint8Array([1, 2, 3, 4]).buffer;
    const imageBytes = pngBytes(3, 2);
    const readAsArrayBuffer = vi.fn<() => Promise<ArrayBuffer>>(async () => {
      const copied = new ArrayBuffer(imageBytes.byteLength);
      new Uint8Array(copied).set(imageBytes);
      return copied;
    });
    let convertImage!: (image: MammothImage) => Promise<{ src: string }>;
    const imageConverter = { __converter: 'bounded-registry' };
    const api: MammothConversionApi = {
      images: {
        imgElement: vi.fn<MammothConversionApi['images']['imgElement']>((callback) => {
          convertImage = callback;
          return imageConverter;
        }),
      },
      convertToHtml: vi.fn<MammothConversionApi['convertToHtml']>(async (_input, _options) => {
        const convertedImage = await convertImage({
          contentType: 'image/png',
          readAsArrayBuffer,
        });
        return {
          value: `<h1>Guide</h1><img src="${convertedImage.src}" alt="cover">`,
          messages: [
            { type: 'warning', message: 'Unsupported break type: column' },
            { type: 'notice', message: 'ignored malformed message' },
          ],
        };
      }),
    };

    const result = await convertDocxArrayBuffer(source, {
      mammothApi: api,
      tokenGenerator: () => 'abcdefabcdefabcdefabcdefabcdefab',
    });

    expect(api.convertToHtml).toHaveBeenCalledOnce();
    expect(api.convertToHtml).toHaveBeenCalledWith(
      { arrayBuffer: source },
      {
        convertImage: imageConverter,
        externalFileAccess: false,
        includeDefaultStyleMap: true,
        includeEmbeddedStyleMap: false,
      },
    );
    expect(readAsArrayBuffer).toHaveBeenCalledOnce();
    expect(result.rawHtml).toContain(
      'https://abcdefabcdefabcdefabcdefabcdefab.invalid/image/1',
    );
    expect(result.images).toHaveLength(1);
    expect(result.images[0]).toMatchObject({
      mimeType: 'image/png',
      width: 3,
      height: 2,
      pixelCount: 6,
    });
    expect(result.messages).toEqual([
      { type: 'warning', message: 'Unsupported break type: column' },
    ]);
  });

  it('rejects generated HTML beyond the worker-side bound', async () => {
    const api: MammothConversionApi = {
      images: {
        imgElement: vi.fn<MammothConversionApi['images']['imgElement']>(
          () => ({ __converter: 'unused' }),
        ),
      },
      convertToHtml: vi.fn<MammothConversionApi['convertToHtml']>(async () => ({
        value: 'x'.repeat(DOCX_PREVIEW_LIMITS.maxHtmlBytes + 1),
        messages: [],
      })),
    };

    await expect(convertDocxArrayBuffer(new ArrayBuffer(1), { mammothApi: api }))
      .rejects.toBeInstanceOf(DocxWorkerConversionError);
  });
});
