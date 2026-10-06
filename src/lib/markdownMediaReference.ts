import { isMarkdownWorkspaceReferenceKind, splitWorkspaceRelativePath, type MarkdownExcalidrawAssetReferenceInput, type MarkdownMediaAsset, type MarkdownMediaDocument } from './markdownMediaDecode';

function encodeMarkdownDestinationSegment(segment: string): string {
  return encodeURIComponent(segment).replace(/[!'()*]/g, (character) => (
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`
  ));
}

function encodeMarkdownDestination(segments: string[]): string {
  return segments.map((segment) => (
    segment === '..' ? segment : encodeMarkdownDestinationSegment(segment)
  )).join('/');
}

function normalizeMarkdownDestination(path: string): string | null {
  const normalized = path.replace(/\\/gu, '/');
  if (
    !normalized
    || normalized.startsWith('/')
    || normalized.length > 4096
    || /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(normalized)
  ) return null;
  const segments = normalized.split('/');
  if (segments.some((segment) => !segment || segment === '.')) return null;
  return encodeMarkdownDestination(segments);
}

function escapeMarkdownLabel(label: string): string {
  return label.replace(/[\\[\]]/g, '\\$&');
}

export function createMarkdownImageReference(name: string, documentRelativePath: string): string | null {
  const destination = normalizeMarkdownDestination(documentRelativePath);
  return destination ? `![${escapeMarkdownLabel(name)}](${destination})` : null;
}

export type MarkdownPickedMediaCommand = 'image' | 'video' | 'meme' | 'html-embed';

// 资源选择器（格式面板媒体命令）的引用模板：image/video 走媒体图片语法，
// meme 附带 `mmd:meme` title 走紧凑梗图渲染，html-embed 走 `mmd:embed` 沙箱嵌入。
export function createMarkdownPickedMediaReference(
  command: MarkdownPickedMediaCommand,
  name: string,
  markdownPath: string,
): string | null {
  const destination = normalizeMarkdownDestination(markdownPath);
  if (!destination) return null;
  const label = escapeMarkdownLabel(name);
  if (command === 'image' || command === 'video') return `![${label}](${destination})`;
  if (command === 'meme') return `![${label}](${destination} "mmd:meme")`;
  return `[${label}](${destination} "mmd:embed")`;
}

function relativeAssetPath(
  document: MarkdownMediaDocument,
  asset: MarkdownMediaAsset,
): string | null {
  const documentSegments = splitWorkspaceRelativePath(document.relative_path);
  const assetSegments = splitWorkspaceRelativePath(asset.relative_path);
  if (!documentSegments || !assetSegments) return null;
  const documentDirectory = documentSegments.slice(0, -1);
  let commonLength = 0;
  while (
    commonLength < documentDirectory.length
    && commonLength < assetSegments.length
    && documentDirectory[commonLength] === assetSegments[commonLength]
  ) {
    commonLength += 1;
  }
  return encodeMarkdownDestination([
    ...Array.from({ length: documentDirectory.length - commonLength }, () => '..'),
    ...assetSegments.slice(commonLength),
  ]);
}

export function createMarkdownMediaDestination(
  asset: MarkdownMediaAsset,
  document: MarkdownMediaDocument,
): string | null {
  if (!isMarkdownWorkspaceReferenceKind(asset.kind)) return null;
  return relativeAssetPath(document, asset);
}

function encodeMetadata(value: unknown): string {
  // URI encoding keeps the metadata safe inside an HTML comment, including
  // filenames containing comment terminators or non-ASCII characters.
  return encodeURIComponent(JSON.stringify(value)).replace(/-/gu, '%2D');
}

export function createMarkdownExcalidrawAssetReference(
  input: MarkdownExcalidrawAssetReferenceInput,
): string | null {
  if (!/^[a-f0-9]{64}$/u.test(input.sourceSha256)) return null;
  const sourceDestination = relativeAssetPath(input.document, {
    kind: 'excalidraw',
    name: 'source.excalidraw',
    relative_path: input.sourceRelativePath,
  });
  const svgDestination = normalizeMarkdownDestination(input.svgMarkdownPath);
  const pngDestination = normalizeMarkdownDestination(input.pngMarkdownPath);
  if (!sourceDestination || !svgDestination || !pngDestination) return null;
  const metadata = encodeMetadata({
    png: pngDestination,
    scale: input.scale,
    source: sourceDestination,
    sourceRelativePath: input.sourceRelativePath,
    sourceSha256: input.sourceSha256,
    version: 1,
  });
  const cacheKey = encodeURIComponent(input.sourceSha256);
  return [
    `<!-- mmd:excalidraw ${metadata} -->`,
    `[![${escapeMarkdownLabel(input.name)}](${svgDestination}?mmdSource=${cacheKey})](${sourceDestination} "mmd:source")`,
  ].join('\n');
}

export function createMarkdownMediaReference(
  asset: MarkdownMediaAsset,
  document: MarkdownMediaDocument,
): string | null {
  if (!isMarkdownWorkspaceReferenceKind(asset.kind)) return null;
  const destination = createMarkdownMediaDestination(asset, document);
  if (!destination) return null;
  const label = escapeMarkdownLabel(asset.name);
  if (asset.kind === 'image') return `![${label}](${destination})`;
  if (asset.kind === 'video') return `![${label}](${destination})`;
  if (asset.kind === 'html' || asset.kind === 'excalidraw') {
    return `[${label}](${destination} "mmd:embed")`;
  }
  return `[${label}](${destination})`;
}

// 解码后的目标路径校验：非空、非绝对、非协议、无查询/锚点。
function decodedDestinationInvalid(decoded: string): boolean {
  return !decoded
    || decoded.startsWith('/')
    || /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(decoded)
    || decoded.includes('?')
    || decoded.includes('#');
}

// 按段解析目标路径：'.' 跳过，'..' 弹出（越界即失败）。
function resolveDestinationSegments(
  documentSegments: string[],
  segments: string[],
): string[] | null {
  const resolved = documentSegments.slice(0, -1);
  for (const segment of segments) {
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      if (resolved.length === 0) return null;
      resolved.pop();
    } else {
      resolved.push(segment);
    }
  }
  return resolved.length > 0 ? resolved : null;
}

export function resolveWorkspaceRelativeMediaPath(
  documentRelativePath: string,
  documentDestination: string,
): string | null {
  const documentSegments = splitWorkspaceRelativePath(documentRelativePath);
  if (!documentSegments) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(documentDestination.replace(/\\/gu, '/'));
  } catch {
    return null;
  }
  if (decodedDestinationInvalid(decoded)) return null;
  const resolved = resolveDestinationSegments(documentSegments, decoded.split('/'));
  return resolved === null ? null : resolved.join('/');
}
