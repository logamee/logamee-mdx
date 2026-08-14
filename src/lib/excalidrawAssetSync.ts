import {
  createMarkdownExcalidrawAssetReference,
  type MarkdownMediaDocument,
} from './markdownMedia';
import {
  readMarkdownExcalidraw,
  writeExcalidrawAssetPair,
  type WriteExcalidrawAssetPairResponse,
} from './tauriCommands';
import {
  exportExcalidrawSceneAssets,
  type ExcalidrawPngScale,
  type ExcalidrawSceneAssets,
} from './excalidrawRuntime';

export interface ExcalidrawAssetSyncInput {
  appearance: 'light' | 'dark';
  document: MarkdownMediaDocument;
  documentPath: string;
  name: string;
  resourceDirectory: string;
  resourceDirectoryToken?: string | null;
  scale?: ExcalidrawPngScale;
  sourceContent?: string;
  sourceRelativePath: string;
  workspaceRoot: string;
  workspaceToken: string;
}

export interface ExcalidrawAssetSyncOptions {
  resourceDirectory: string;
  resourceDirectoryToken?: string | null;
  workspaceRoot: string;
  workspaceToken: string;
}

export interface ExcalidrawAssetSyncResult {
  assets: ExcalidrawSceneAssets;
  markdown: string;
  response: WriteExcalidrawAssetPairResponse;
  sourceContent: string;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

async function blobToBase64(blob: Blob): Promise<string> {
  return bytesToBase64(new Uint8Array(await blob.arrayBuffer()));
}

export async function renderAndSyncExcalidrawAssetPair(
  input: ExcalidrawAssetSyncInput,
): Promise<ExcalidrawAssetSyncResult> {
  const sourceContent = input.sourceContent ?? await readMarkdownExcalidraw(
    input.documentPath,
    relativeSourcePath(input.document, input.sourceRelativePath),
    input.workspaceRoot,
  );
  const assets = await exportExcalidrawSceneAssets(
    sourceContent,
    input.appearance,
    input.scale ?? 2,
  );
  const response = await writeExcalidrawAssetPair({
    workspaceToken: input.workspaceToken,
    workspaceRoot: input.workspaceRoot,
    documentPath: input.documentPath,
    sourceRelativePath: input.sourceRelativePath,
    sourceContent,
    resourceDirectory: input.resourceDirectory,
    ...(input.resourceDirectoryToken ? { resourceDirectoryToken: input.resourceDirectoryToken } : {}),
    svgBase64: await blobToBase64(new Blob([assets.svgText], { type: 'image/svg+xml' })),
    pngBase64: await blobToBase64(assets.pngBlob),
  });
  const markdown = createMarkdownExcalidrawAssetReference({
    document: input.document,
    name: input.name,
    pngMarkdownPath: response.pngMarkdownPath,
    scale: input.scale ?? 2,
    sourceRelativePath: input.sourceRelativePath,
    sourceSha256: response.sourceSha256,
    svgMarkdownPath: response.svgMarkdownPath,
  });
  if (!markdown) throw new Error('Generated Excalidraw asset paths could not be inserted.');
  return { assets, markdown, response, sourceContent };
}

function relativeSourcePath(document: MarkdownMediaDocument, sourceRelativePath: string): string {
  const documentSegments = document.relative_path.replace(/\\/gu, '/').split('/');
  const sourceSegments = sourceRelativePath.replace(/\\/gu, '/').split('/');
  const documentDirectory = documentSegments.slice(0, -1);
  let commonLength = 0;
  while (
    commonLength < documentDirectory.length
    && commonLength < sourceSegments.length
    && documentDirectory[commonLength] === sourceSegments[commonLength]
  ) commonLength += 1;
  return [
    ...Array.from({ length: documentDirectory.length - commonLength }, () => '..'),
    ...sourceSegments.slice(commonLength),
  ].join('/');
}
