import { describe, expect, it } from 'vitest';
import {
  DOCX_PREVIEW_LIMITS,
  DocxImageRegistry,
  DocxResourceLimitError,
} from './docxResources';

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;

function pngBytes(width: number, height: number, byteLength = 24): Uint8Array {
  const bytes = new Uint8Array(byteLength);
  bytes.set(PNG_SIGNATURE);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

describe('DOCX embedded image resource policy', () => {
  it('registers a validated image behind a random invalid-domain placeholder', () => {
    const registry = new DocxImageRegistry(() => '0123456789abcdef0123456789abcdef');

    const image = registry.register('image/png', pngBytes(320, 200));

    expect(image).toMatchObject({
      placeholder: 'https://0123456789abcdef0123456789abcdef.invalid/image/1',
      mimeType: 'image/png',
      byteLength: 24,
      width: 320,
      height: 200,
      pixelCount: 64_000,
    });
    expect(image.bytesBase64).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
    expect(registry.images).toEqual([image]);
  });

  it('rejects unsupported MIME types, MIME/signature mismatches, and malformed dimensions', () => {
    const registry = new DocxImageRegistry(() => '11111111111111111111111111111111');

    expect(() => registry.register('image/svg+xml', pngBytes(1, 1)))
      .toThrow(DocxResourceLimitError);
    expect(() => registry.register('image/jpeg', pngBytes(1, 1)))
      .toThrow(DocxResourceLimitError);
    expect(() => registry.register('image/png', pngBytes(0, 1)))
      .toThrow(DocxResourceLimitError);
    expect(registry.images).toHaveLength(0);
  });

  it('enforces the per-image byte and pixel limits before retaining a resource', () => {
    const registry = new DocxImageRegistry(() => '22222222222222222222222222222222');

    expect(() => registry.register(
      'image/png',
      pngBytes(1, 1, DOCX_PREVIEW_LIMITS.maxImageBytes + 1),
    )).toThrow(DocxResourceLimitError);
    expect(() => registry.register('image/png', pngBytes(6_001, 4_000)))
      .toThrow(DocxResourceLimitError);
    expect(registry.images).toHaveLength(0);
  });

  it('enforces aggregate byte and pixel budgets across every retained image', () => {
    const byteRegistry = new DocxImageRegistry(() => '33333333333333333333333333333333');
    for (let index = 0; index < 4; index += 1) {
      byteRegistry.register(
        'image/png',
        pngBytes(1, 1, DOCX_PREVIEW_LIMITS.maxImageBytes),
      );
    }
    expect(() => byteRegistry.register('image/png', pngBytes(1, 1)))
      .toThrow(DocxResourceLimitError);

    const pixelRegistry = new DocxImageRegistry(() => '44444444444444444444444444444444');
    for (let index = 0; index < 8; index += 1) {
      pixelRegistry.register('image/png', pngBytes(4_000, 2_000));
    }
    expect(() => pixelRegistry.register('image/png', pngBytes(1, 1)))
      .toThrow(DocxResourceLimitError);
  });
});
