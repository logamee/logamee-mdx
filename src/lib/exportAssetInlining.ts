export type ExportFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

async function responseToDataUrl(response: Response): Promise<string> {
  if (!response.ok) throw new Error('Export resource could not be loaded');
  const blob = await response.blob();
  if (blob.size === 0) throw new Error('Export resource is empty');
  return `data:${blob.type || 'application/octet-stream'};base64,${bytesToBase64(new Uint8Array(await blob.arrayBuffer()))}`;
}

function isEmbeddableUrl(value: string): boolean {
  const normalized = value.trim();
  return !!normalized && !normalized.startsWith('data:') && !normalized.startsWith('#');
}

export async function inlineCssResourceUrls(css: string, baseUrl: string, fetcher: ExportFetch = fetch): Promise<string> {
  const matches = Array.from(css.matchAll(/url\(\s*(['"]?)(.*?)\1\s*\)/giu));
  const replacements = new Map<string, string>();
  for (const match of matches) {
    const source = match[2].trim();
    if (!isEmbeddableUrl(source) || replacements.has(source)) continue;
    const resolved = new URL(source, baseUrl).href;
    replacements.set(source, await responseToDataUrl(await fetcher(resolved)));
  }
  return css.replace(/url\(\s*(['"]?)(.*?)\1\s*\)/giu, (full, _quote: string, source: string) => {
    const replacement = replacements.get(source.trim());
    return replacement ? `url("${replacement}")` : full;
  });
}

export async function collectOfflineExportAssets(root: HTMLElement, fetcher: ExportFetch = fetch): Promise<{
  assetDataUrls: Record<string, string>;
  css: string;
}> {
  const assetDataUrls: Record<string, string> = {};
  for (const image of Array.from(root.querySelectorAll<HTMLImageElement>('img'))) {
    const source = image.getAttribute('src') ?? '';
    if (!isEmbeddableUrl(source) || assetDataUrls[source]) continue;
    assetDataUrls[source] = await responseToDataUrl(await fetcher(image.currentSrc || image.src || source));
  }
  const blocks: string[] = [];
  for (const sheet of Array.from(document.styleSheets)) {
    let css: string;
    try {
      css = Array.from(sheet.cssRules).map((rule) => rule.cssText).join('\n');
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause);
      throw new Error(`Export stylesheet could not be read: ${detail}`);
    }
    if (!css) continue;
    blocks.push(await inlineCssResourceUrls(css, sheet.href || document.baseURI, fetcher));
  }
  return { assetDataUrls, css: blocks.join('\n') };
}
