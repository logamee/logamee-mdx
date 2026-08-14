import { EXPORT_LIMITS } from './exportPreflight';
import type { SkinId, ThemeAppearance } from './theme';

export type PngScale = 1 | 2 | 3;

export interface LongPngExportOptions {
  scale: PngScale;
  appearance: ThemeAppearance;
  skin: SkinId;
  maxPixels?: number;
  background?: string;
  cssText?: string;
  sourceHeight?: number;
  sourceWidth?: number;
  onProgress?: (progress: number) => void;
}

export function assertPngDimensions(width: number, height: number, scale: PngScale, maxPixels = EXPORT_LIMITS.maxPngPixels): { width: number; height: number } {
  const scaled = { width: Math.ceil(width * scale), height: Math.ceil(height * scale) };
  if (!Number.isFinite(width) || !Number.isFinite(height) || scaled.width <= 0 || scaled.height <= 0 || scaled.width * scaled.height > maxPixels) {
    throw new Error('PNG dimensions exceed the export limit');
  }
  return scaled;
}

export async function renderElementToLongPng(element: HTMLElement, options: LongPngExportOptions): Promise<Blob> {
  const rect = element.getBoundingClientRect();
  const sourceWidth = options.sourceWidth ?? rect.width;
  const sourceHeight = options.sourceHeight ?? element.scrollHeight ?? rect.height;
  const dimensions = assertPngDimensions(sourceWidth, sourceHeight, options.scale, options.maxPixels);
  options.onProgress?.(0.1);
  const serialized = new XMLSerializer().serializeToString(element);
  const css = (options.cssText ?? '').replace(/<\/style/giu, '<\\/style');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${dimensions.width}" height="${dimensions.height}" viewBox="0 0 ${sourceWidth} ${sourceHeight}" data-appearance="${options.appearance}" data-skin="${options.skin}"><foreignObject width="100%" height="100%"><div xmlns="http://www.w3.org/1999/xhtml"><style>${css}</style>${serialized}</div></foreignObject></svg>`;
  const image = new Image();
  image.decoding = 'async';
  image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  await image.decode();
  options.onProgress?.(0.65);
  const canvas = document.createElement('canvas');
  canvas.width = dimensions.width;
  canvas.height = dimensions.height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('PNG export canvas is unavailable');
  if (options.background) {
    context.fillStyle = options.background;
    context.fillRect(0, 0, dimensions.width, dimensions.height);
  }
  context.drawImage(image, 0, 0, dimensions.width, dimensions.height);
  options.onProgress?.(0.9);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
  if (!blob || blob.size === 0) throw new Error('PNG export produced an empty image');
  options.onProgress?.(1);
  return blob;
}
