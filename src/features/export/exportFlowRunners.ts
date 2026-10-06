import type { ExportDialogValue } from './ExportDialog';
import type { ExportPreflightIssue } from '../../lib/exportPreflight';
import { collectExportPreflightIssues } from '../../lib/exportPreflight';
import type { EffectiveLocale } from '../../lib/locale';
import { loadLazyModuleWithRetry } from '../../lib/lazyModule';
import { resolveThemeForAppearance, type SkinId, type ThemeAppearance } from '../../lib/theme';
import { saveExcalidrawBundle, saveExport } from '../../lib/tauriCommands';

export interface ExportFlowThemeSelection {
  appearance: ThemeAppearance;
  selectedTheme: 'current' | ThemeAppearance;
  skin: SkinId;
}

// 导出用外观与皮肤：跟随当前或按选择切换外观后解析皮肤。
export function resolveExportTheme(selection: ExportFlowThemeSelection): {
  appearance: ThemeAppearance; skin: SkinId;
} {
  if (selection.selectedTheme === 'current') {
    return { appearance: selection.appearance, skin: selection.skin };
  }
  return {
    appearance: selection.selectedTheme,
    skin: resolveThemeForAppearance({ appearance: selection.appearance, skin: selection.skin }, selection.selectedTheme).skin,
  };
}

// 分块转 Base64，避免大文件展开参数超限。
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

async function blobToBase64(blob: Blob): Promise<string> {
  return bytesToBase64(new Uint8Array(await blob.arrayBuffer()));
}

export function exportBaseName(activePath: string | null): string {
  return (activePath?.split(/[\\/]/u).pop() ?? 'document')
    .replace(/\.(?:md|markdown|mdx|excalidraw)$/iu, '') || 'document';
}

// Excalidraw 资产束导出：1x/2x/3x PNG 与 SVG 一起保存。
export async function runExcalidrawBundleExport(request: {
  appearance: ThemeAppearance;
  baseName: string;
  content: string;
}): Promise<boolean> {
  const runtime = await loadLazyModuleWithRetry(() => import('../../lib/excalidrawRuntime'));
  const [one, two, three] = await Promise.all([
    runtime.exportExcalidrawSceneAssets(request.content, request.appearance, 1),
    runtime.exportExcalidrawSceneAssets(request.content, request.appearance, 2),
    runtime.exportExcalidrawSceneAssets(request.content, request.appearance, 3),
  ]);
  const saved = await saveExcalidrawBundle({
    baseName: request.baseName,
    source: request.content,
    svgBase64: await blobToBase64(new Blob([two.svgText], { type: 'image/svg+xml' })),
    png1xBase64: await blobToBase64(one.pngBlob),
    png2xBase64: await blobToBase64(two.pngBlob),
    png3xBase64: await blobToBase64(three.pngBlob),
  });
  return saved !== null;
}

function videoFallbackMessage(locale: EffectiveLocale): string {
  return locale === 'zh-CN' ? '视频预览不会内嵌到离线导出。' : 'Video preview is not embedded in offline export.';
}

// 离线 HTML 导出：克隆预览、内嵌资产后打包为单文件 HTML。
export async function runHtmlExport(request: {
  appearance: ThemeAppearance;
  baseName: string;
  locale: EffectiveLocale;
  preview: HTMLElement;
  skin: SkinId;
}): Promise<boolean> {
  const [module, assetModule] = await Promise.all([
    import('../../lib/offlineHtmlExport'),
    import('../../lib/exportAssetInlining'),
  ]);
  const exportPreview = request.preview.cloneNode(true) as HTMLElement;
  assetModule.replaceVideoElementsWithExportFallback(exportPreview, videoFallbackMessage(request.locale));
  const assets = await assetModule.collectOfflineExportAssets(exportPreview);
  const html = module.buildOfflineHtml({
    title: request.baseName,
    bodyHtml: exportPreview.innerHTML,
    themeCss: assets.css,
    theme: request.appearance,
    skin: request.skin,
    assetDataUrls: assets.assetDataUrls,
  });
  const saved = await saveExport({
    kind: 'html',
    defaultName: request.baseName,
    bytesBase64: bytesToBase64(new TextEncoder().encode(html)),
  });
  return saved !== null;
}

// 长图 PNG 导出：克隆预览、替换图片为数据地址后按缩放渲染。
export async function runPngExport(request: {
  appearance: ThemeAppearance;
  baseName: string;
  locale: EffectiveLocale;
  preview: HTMLElement;
  scale: import('../../lib/longPngExport').PngScale;
  skin: SkinId;
}): Promise<boolean> {
  const [module, assetModule] = await Promise.all([
    import('../../lib/longPngExport'),
    import('../../lib/exportAssetInlining'),
  ]);
  const sourceRect = request.preview.getBoundingClientRect();
  const clone = request.preview.cloneNode(true) as HTMLElement;
  assetModule.replaceVideoElementsWithExportFallback(clone, videoFallbackMessage(request.locale));
  const assets = await assetModule.collectOfflineExportAssets(clone);
  for (const image of Array.from(clone.querySelectorAll<HTMLImageElement>('img'))) {
    const source = image.getAttribute('src') ?? '';
    if (assets.assetDataUrls[source]) image.setAttribute('src', assets.assetDataUrls[source]);
  }
  const blob = await module.renderElementToLongPng(clone, {
    scale: request.scale,
    appearance: request.appearance,
    skin: request.skin,
    background: request.appearance === 'dark' ? '#171717' : '#ffffff',
    cssText: assets.css,
    sourceWidth: sourceRect.width,
    sourceHeight: request.preview.scrollHeight || sourceRect.height,
  });
  const saved = await saveExport({
    kind: 'png',
    defaultName: request.baseName,
    bytesBase64: await blobToBase64(blob),
  });
  return saved !== null;
}

// 扫描预览面板的图表错误与图片可用性，汇总导出预检问题。
export function collectPreviewExportIssues(
  getPreviewPaneEl: () => HTMLElement | null,
  document: string,
): ExportPreflightIssue[] {
  const preview = getPreviewPaneEl()?.querySelector<HTMLElement>('.mmd-preview-content');
  const diagramErrors = preview
    ? Array.from(preview.querySelectorAll<HTMLElement>('.image-error, .mmd-excalidraw-embed-status:not([aria-busy="true"])')).map((node) => node.textContent?.trim() || 'diagram error')
    : [];
  const imageSources = preview ? Array.from(preview.querySelectorAll<HTMLImageElement>('img')).map((image) => ({
    src: image.currentSrc || image.src,
    available: image.complete && image.naturalWidth > 0,
  })) : [];
  return collectExportPreflightIssues({ document, diagramErrors, imageSources });
}

// 按当前文档类型调整导出格式默认值（画板文档强制 excalidraw）。
export function nextExportFormat(
  activeFileKind: import('../../types').WorkspaceFileKind,
  current: ExportDialogValue['format'],
): ExportDialogValue['format'] {
  return activeFileKind === 'excalidraw' ? 'excalidraw' : current === 'excalidraw' ? 'html' : current;
}
