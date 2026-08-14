// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest';
import { assertPngDimensions, renderElementToLongPng } from './longPngExport';

describe('assertPngDimensions', () => {
  it('scales dimensions and rejects oversized canvases', () => {
    expect(assertPngDimensions(100, 200, 3)).toEqual({ width: 300, height: 600 });
    expect(() => assertPngDimensions(100, 100, 3, 1000)).toThrow('PNG dimensions');
  });

  it('preserves the selected skin in the serialized rendering root', async () => {
    const decode = vi.fn<() => Promise<void>>(async () => undefined);
    vi.stubGlobal('Image', class {
      decoding = '';
      src = '';
      decode = decode;
    });
    const context = {
      drawImage: vi.fn<(...args: unknown[]) => void>(),
      fillRect: vi.fn<(x: number, y: number, width: number, height: number) => void>(),
      fillStyle: '',
    };
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((callback) => callback(new Blob(['png'])));
    const element = document.createElement('main');
    Object.defineProperty(element, 'scrollHeight', { value: 20 });
    vi.spyOn(element, 'getBoundingClientRect').mockReturnValue({ width: 10, height: 20 } as DOMRect);

    await renderElementToLongPng(element, { scale: 1, appearance: 'dark', skin: 'shanshui-yemo' });

    const image = (context.drawImage.mock.calls[0]?.[0]) as { src: string };
    const svg = decodeURIComponent(image.src.split(',')[1]);
    expect(svg).toContain('data-appearance="dark"');
    expect(svg).toContain('data-skin="shanshui-yemo"');
  });
});
