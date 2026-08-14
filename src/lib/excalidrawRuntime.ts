import {
  FONT_FAMILY,
  exportToBlob,
  exportToSvg,
  getNonDeletedElements,
  restore,
} from '@excalidraw/excalidraw';
import { parseExcalidrawScene } from './excalidrawScene';

export type ExcalidrawPngScale = 1 | 2 | 3;

export interface ExcalidrawSceneAssets {
  height: number;
  pngBlob: Blob;
  svg: SVGSVGElement;
  svgText: string;
  width: number;
}

export function restoreExcalidrawScene(content: string): ReturnType<typeof restore> {
  const scene = parseExcalidrawScene(content);
  return restore({
    ...scene,
    appState: {
      ...scene.appState,
      currentItemFontFamily: typeof scene.appState.currentItemFontFamily === 'number'
        ? scene.appState.currentItemFontFamily
        : FONT_FAMILY.Excalifont,
      viewBackgroundColor: typeof scene.appState.viewBackgroundColor === 'string'
        ? scene.appState.viewBackgroundColor
        : 'transparent',
    },
  } as unknown as Parameters<typeof restore>[0], null, null, { repairBindings: true });
}

function exportOptions(
  restored: ReturnType<typeof restore>,
  appearance: 'light' | 'dark',
) {
  return {
    elements: getNonDeletedElements(restored.elements),
    appState: {
      ...restored.appState,
      exportBackground: false,
      exportEmbedScene: false,
      exportWithDarkMode: appearance === 'dark',
      viewBackgroundColor: 'transparent',
    },
    files: restored.files,
  };
}

function svgDimension(svg: SVGSVGElement, name: 'height' | 'width'): number {
  const parsed = Number.parseFloat(svg.getAttribute(name) ?? '');
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Excalidraw ${name} is empty after export`);
  }
  return parsed;
}

export async function exportExcalidrawSceneSvg(
  content: string,
  appearance: 'light' | 'dark',
): Promise<SVGSVGElement> {
  const restored = restoreExcalidrawScene(content);
  return exportToSvg({
    ...exportOptions(restored, appearance),
    renderEmbeddables: false,
    reuseImages: true,
  });
}

export async function exportExcalidrawSceneAssets(
  content: string,
  appearance: 'light' | 'dark',
  scale: number,
): Promise<ExcalidrawSceneAssets> {
  if (scale !== 1 && scale !== 2 && scale !== 3) {
    throw new Error('Excalidraw PNG scale must be 1, 2, or 3');
  }
  const restored = restoreExcalidrawScene(content);
  const options = exportOptions(restored, appearance);
  const svg = await exportToSvg({
    ...options,
    renderEmbeddables: false,
    reuseImages: true,
  });
  const width = svgDimension(svg, 'width');
  const height = svgDimension(svg, 'height');
  const pngBlob = await exportToBlob({
    ...options,
    getDimensions: (sourceWidth: number, sourceHeight: number) => ({
      height: sourceHeight * scale,
      scale,
      width: sourceWidth * scale,
    }),
    mimeType: 'image/png',
    quality: 1,
  });
  if (pngBlob.type !== 'image/png' || pngBlob.size === 0) {
    throw new Error('Excalidraw PNG export is empty or invalid');
  }
  return {
    height,
    pngBlob,
    svg,
    svgText: new XMLSerializer().serializeToString(svg),
    width,
  };
}
